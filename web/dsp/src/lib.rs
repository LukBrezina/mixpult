//! Mixpult's whole mix as WebAssembly, run by the two AudioWorklet processors in mix.worklet.js:
//! every instrument, the drum and voice samples, their effects, the mixer, the delay and the
//! master chain. Only the reverb stays a Web Audio node.
//!
//! The sound follows what the Web Audio / Tone.js graph did before: Tone's Synth, MonoSynth,
//! FMSynth, MembraneSynth and PolySynth (envelope curves, fat oscillators, portamento), Web Audio's
//! filter formulas, Chrome's DynamicsCompressor (ported line by line), Tone's Chorus, Vibrato,
//! Distortion and FeedbackDelay, and Tone.Channel, which sums every track to mono.
//!
//! Nothing allocates while audio runs (voices, delay lines and queues are made up front), so there
//! are no garbage collector pauses on the audio thread, and the hot loops are plain machine code.
//! The JavaScript glue builds the mix with the setup functions below, forwards the engine's
//! messages as calls, and copies the output out of linear memory after `mix_process`.
//!
//! Times are frames (sample-accurate); a frame is an f64 holding an integer.

use std::f64::consts::{FRAC_1_SQRT_2, PI, SQRT_2};

const TAU: f64 = PI * 2.0;
const BLOCK: usize = 128;
const CTRL: i32 = 8; // samples between filter coefficient updates in the synths
const TABLE: usize = 4096;
// Web Audio builds saw and square waves from partials and scales them to a peak of 1, which the
// Gibbs overshoot (about 9 %) reaches: their flat parts sit that much under the PolyBLEP's ±1.
const GIBBS: f64 = 1.0 / 1.09;
// Tone.Channel pans its mono sum to the middle with equal power: -3 dB on each side.
const CENTER: f64 = FRAC_1_SQRT_2;
// A source whose effects have rung out below QUIET, for longer than TAIL seconds, sleeps.
const QUIET: f64 = 1e-6;
const TAIL: f64 = 0.05;

fn db_to_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

fn gain_to_db(g: f64) -> f64 {
    20.0 * g.log10()
}

fn sine_table() -> Vec<f32> {
    (0..=TABLE).map(|i| (TAU * i as f64 / TABLE as f64).sin() as f32).collect()
}

#[inline(always)]
fn lookup(table: &[f32], phase: f64) -> f64 {
    let x = phase * TABLE as f64;
    let i = x as usize;
    let a = table[i] as f64;
    a + (table[i + 1] as f64 - a) * (x - i as f64)
}

// A periodic wave from sine partials, normalized to a peak of 1 like Web Audio's PeriodicWave.
fn partials_table(partials: &[f64]) -> Vec<f32> {
    let mut t = vec![0f64; TABLE + 1];
    let mut peak = 0f64;
    for (i, v) in t.iter_mut().enumerate() {
        let mut s = 0.0;
        for (n, &p) in partials.iter().enumerate() {
            if p != 0.0 {
                s += p * (TAU * (n + 1) as f64 * i as f64 / TABLE as f64).sin();
            }
        }
        *v = s;
        peak = peak.max(s.abs());
    }
    let peak = if peak > 0.0 { peak } else { 1.0 };
    t.iter().map(|v| (v / peak) as f32).collect()
}

// Band-limited step correction (PolyBLEP), for alias-free saw and square waves.
#[inline(always)]
fn blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let t = t / dt;
        t + t - t * t - 1.0
    } else if t > 1.0 - dt {
        let t = (t - 1.0) / dt;
        t * t + t + t + 1.0
    } else {
        0.0
    }
}

fn peak(buf: &[f32]) -> f64 {
    buf.iter().fold(0f32, |m, &x| m.max(x.abs())) as f64
}

// ---------- automation: an AudioParam with the few curves the engine uses ----------

const SET: u32 = 0; // 1: linear
const EXP: u32 = 2;
const TARGET: u32 = 3;

#[derive(Clone, Copy)]
struct Ev {
    frame: f64,
    curve: u32,
    value: f64,
    ramp: f64,
}

#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Hold,
    Target,
    Linear,
    Expo,
}

struct Param {
    v: f64,
    mode: Mode,
    events: std::collections::VecDeque<Ev>,
    target: f64,
    k: f64,
    d: f64,
    r: f64,
    left: f64,
    buf: [f32; BLOCK],
}

impl Param {
    fn new(v: f64) -> Self {
        Param { v, mode: Mode::Hold, events: std::collections::VecDeque::with_capacity(64), target: v, k: 0.0, d: 0.0, r: 1.0, left: 0.0, buf: [0.0; BLOCK] }
    }

    // Like Tone's rampTo and setTargetAtTime: whatever was planned from this frame on gives way.
    fn add(&mut self, ev: Ev) {
        while self.events.back().is_some_and(|e| e.frame >= ev.frame) {
            self.events.pop_back();
        }
        self.events.push_back(ev);
    }

    fn begin(&mut self, ev: Ev, sr: f64) {
        let n = (ev.ramp * sr).round().max(1.0);
        if ev.curve == SET || !(ev.ramp > 0.0) {
            self.v = ev.value;
            self.mode = Mode::Hold;
        } else if ev.curve == TARGET {
            self.target = ev.value;
            self.k = (-1.0 / (ev.ramp * sr)).exp();
            self.mode = Mode::Target;
        } else if ev.curve == EXP && self.v > 0.0 && ev.value > 0.0 {
            self.target = ev.value;
            self.r = (ev.value / self.v).powf(1.0 / n);
            self.left = n;
            self.mode = Mode::Expo;
        } else {
            self.target = ev.value;
            self.d = (ev.value - self.v) / n;
            self.left = n;
            self.mode = Mode::Linear;
        }
    }

    // Fills buf for the block from `start`. False when the value holds still all block (read .v).
    fn run(&mut self, start: f64, n: usize, sr: f64) -> bool {
        if self.mode == Mode::Hold && self.events.front().map_or(true, |e| e.frame >= start + n as f64) {
            return false;
        }
        for i in 0..n {
            while let Some(&e) = self.events.front() {
                if e.frame > start + i as f64 {
                    break;
                }
                self.events.pop_front();
                self.begin(e, sr);
            }
            match self.mode {
                Mode::Target => {
                    self.v = self.target + (self.v - self.target) * self.k;
                    if (self.v - self.target).abs() < 1e-6 {
                        self.v = self.target;
                        self.mode = Mode::Hold;
                    }
                }
                Mode::Linear => {
                    self.v += self.d;
                    self.left -= 1.0;
                    if self.left <= 0.0 {
                        self.v = self.target;
                        self.mode = Mode::Hold;
                    }
                }
                Mode::Expo => {
                    self.v *= self.r;
                    self.left -= 1.0;
                    if self.left <= 0.0 {
                        self.v = self.target;
                        self.mode = Mode::Hold;
                    }
                }
                Mode::Hold => {}
            }
            self.buf[i] = self.v as f32;
        }
        true
    }

    #[inline(always)]
    fn at(&self, moving: bool, i: usize) -> f64 {
        if moving {
            self.buf[i] as f64
        } else {
            self.v
        }
    }
}

// ---------- filters: Web Audio's BiquadFilter (lowpass/highpass Q in dB), cascaded stages ----------

#[derive(Clone, Copy, PartialEq)]
enum FilterType {
    Lowpass,
    Highpass,
    Bandpass,
    Peaking,
    Highshelf,
}

impl FilterType {
    fn from(code: u32) -> Self {
        match code {
            1 => FilterType::Highpass,
            2 => FilterType::Bandpass,
            3 => FilterType::Peaking,
            4 => FilterType::Highshelf,
            _ => FilterType::Lowpass,
        }
    }
}

#[derive(Clone, Copy)]
struct Biquad {
    kind: FilterType,
    stages: usize,
    z: [f64; 8 * 2], // up to 4 stages x 2 channels x 2 states
    gain: f64,
    f: f64,
    q: f64,
    qg: f64,
    sr: f64,
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    fn new(kind: FilterType, frequency: f64, q: f64, gain: f64, stages: usize, sr: f64) -> Self {
        let mut b = Biquad { kind, stages, z: [0.0; 16], gain, f: f64::NAN, q: f64::NAN, qg: 1.0, sr, b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };
        b.set(frequency, q);
        b
    }

    fn set(&mut self, frequency: f64, q: f64) {
        if frequency == self.f && q == self.q {
            return;
        }
        self.f = frequency;
        if q != self.q {
            self.q = q;
            self.qg = 10f64.powf(q / 20.0); // lowpass/highpass: Q is a resonance in dB
        }
        let w0 = TAU * frequency.max(1.0).min(self.sr * 0.49) / self.sr;
        let (sin, cos) = w0.sin_cos();
        let (b0, b1, b2, a0, a1, a2);
        match self.kind {
            FilterType::Lowpass | FilterType::Highpass => {
                let alpha = sin / (2.0 * self.qg);
                let lp = self.kind == FilterType::Lowpass;
                b0 = if lp { (1.0 - cos) / 2.0 } else { (1.0 + cos) / 2.0 };
                b1 = if lp { 1.0 - cos } else { -(1.0 + cos) };
                b2 = b0;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cos;
                a2 = 1.0 - alpha;
            }
            FilterType::Bandpass => {
                let alpha = sin / (2.0 * q);
                b0 = alpha;
                b1 = 0.0;
                b2 = -alpha;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cos;
                a2 = 1.0 - alpha;
            }
            FilterType::Peaking => {
                let a = 10f64.powf(self.gain / 40.0);
                let alpha = sin / (2.0 * q);
                b0 = 1.0 + alpha * a;
                b1 = -2.0 * cos;
                b2 = 1.0 - alpha * a;
                a0 = 1.0 + alpha / a;
                a1 = -2.0 * cos;
                a2 = 1.0 - alpha / a;
            }
            FilterType::Highshelf => {
                let a = 10f64.powf(self.gain / 40.0);
                let s = 2.0 * a.sqrt() * ((sin / 2.0) * SQRT_2);
                b0 = a * (a + 1.0 + (a - 1.0) * cos + s);
                b1 = -2.0 * a * (a - 1.0 + (a + 1.0) * cos);
                b2 = a * (a + 1.0 + (a - 1.0) * cos - s);
                a0 = a + 1.0 - (a - 1.0) * cos + s;
                a1 = 2.0 * (a - 1.0 - (a + 1.0) * cos);
                a2 = a + 1.0 - (a - 1.0) * cos - s;
            }
        }
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    // One sample through every stage (channel 0), for the synth voices.
    #[inline(always)]
    fn next(&mut self, mut x: f64) -> f64 {
        for s in 0..self.stages {
            let y = self.b0 * x + self.z[2 * s];
            self.z[2 * s] = self.b1 * x - self.a1 * y + self.z[2 * s + 1];
            self.z[2 * s + 1] = self.b2 * x - self.a2 * y;
            x = y;
        }
        x
    }

    // A block in place, samples [from, to) of one channel.
    fn process(&mut self, buf: &mut [f32], from: usize, to: usize, ch: usize) {
        let (b0, b1, b2, a1, a2) = (self.b0, self.b1, self.b2, self.a1, self.a2);
        for s in 0..self.stages {
            let o = (ch * self.stages + s) * 2;
            let mut z1 = self.z[o];
            let mut z2 = self.z[o + 1];
            for v in &mut buf[from..to] {
                let x = *v as f64;
                let y = b0 * x + z1;
                z1 = b1 * x - a1 * y + z2;
                z2 = b2 * x - a2 * y;
                *v = y as f32;
            }
            // Denormals: a filter ringing out into silence would slow everything down.
            self.z[o] = if z1.abs() < 1e-25 { 0.0 } else { z1 };
            self.z[o + 1] = if z2.abs() < 1e-25 { 0.0 } else { z2 };
        }
    }

    fn reset(&mut self) {
        self.z = [0.0; 16];
    }
}

// ---------- modulated delays: Tone's Vibrato and Chorus ----------

struct DelayLine {
    buf: Vec<f32>,
    mask: usize,
    w: usize,
}

impl DelayLine {
    fn new(seconds: f64, sr: f64) -> Self {
        let mut size = 1;
        while (size as f64) < seconds * sr + 4.0 {
            size <<= 1;
        }
        DelayLine { buf: vec![0.0; size], mask: size - 1, w: 0 }
    }

    #[inline(always)]
    fn write(&mut self, x: f64) {
        self.buf[self.w] = x as f32;
        self.w = (self.w + 1) & self.mask;
    }

    // `frames` behind the sample written last, linearly interpolated like Web Audio's DelayNode.
    #[inline(always)]
    fn read(&self, frames: f64) -> f64 {
        let p = self.w as f64 - 1.0 - frames;
        let i = p.floor();
        let f = p - i;
        let i = i as i64 as usize; // wraps for negative positions, masked below
        let a = self.buf[i & self.mask] as f64;
        a + (self.buf[i.wrapping_add(1) & self.mask] as f64 - a) * f
    }

    fn reset(&mut self) {
        self.buf.fill(0.0);
    }
}

// Tone.Vibrato: a delay of up to maxDelay swung by a sine LFO, depth around the middle, all wet.
struct Vibrato {
    line: DelayLine,
    mid: f64,
    dev: f64,
    dt: f64,
    phase: f64,
}

impl Vibrato {
    fn new(frequency: f64, depth: f64, max_delay: f64, sr: f64) -> Self {
        let mid = max_delay * sr / 2.0;
        // Tone starts it at -90°, resting in the middle.
        Vibrato { line: DelayLine::new(max_delay, sr), mid, dev: mid * depth, dt: frequency / sr, phase: 0.75 }
    }

    fn process(&mut self, buf: &mut [f32], sine: &[f32]) {
        for v in buf.iter_mut() {
            self.line.write(*v as f64);
            *v = self.line.read(self.mid + self.dev * lookup(sine, self.phase)) as f32;
            self.phase += self.dt;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
        }
    }
}

// Tone.Chorus: two delays swung by LFOs `spread` degrees apart, the left and right of a stereo
// effect, wet/dry by equal power. The channel after it sums them to mono, so here it is one delay
// line with two taps averaged.
struct Chorus {
    line: DelayLine,
    mid: f64,
    amp: f64,
    dt: f64,
    pl: f64,
    pr: f64,
    dry: f64,
    wet: f64,
}

impl Chorus {
    fn new(frequency: f64, delay_ms: f64, depth: f64, spread: f64, wet: f64, sr: f64) -> Self {
        let d = delay_ms / 1000.0;
        let dev = d * depth;
        let min = (d - dev).max(0.0);
        let max = d + dev;
        Chorus {
            line: DelayLine::new(max + 0.001, sr),
            mid: (min + max) / 2.0 * sr,
            amp: (max - min) / 2.0 * sr,
            dt: frequency / sr,
            pl: (90.0 - spread / 2.0) / 360.0,
            pr: (90.0 + spread / 2.0) / 360.0,
            dry: (wet * PI / 2.0).cos(),
            wet: (wet * PI / 2.0).sin() / 2.0,
        }
    }

    fn process(&mut self, buf: &mut [f32], sine: &[f32]) {
        for v in buf.iter_mut() {
            let x = *v as f64;
            self.line.write(x);
            let l = self.line.read(self.mid + self.amp * lookup(sine, self.pl));
            let r = self.line.read(self.mid + self.amp * lookup(sine, self.pr));
            *v = (self.dry * x + self.wet * (l + r)) as f32;
            self.pl += self.dt;
            if self.pl >= 1.0 {
                self.pl -= 1.0;
            }
            self.pr += self.dt;
            if self.pr >= 1.0 {
                self.pr -= 1.0;
            }
        }
    }
}

// ---------- Tone.Distortion: its curve, 2x oversampled as the WaveShaper does ----------

// Half-band lowpass for the 2x oversampling: a Blackman-windowed sinc, symmetric; only the odd taps
// (HB[m] for distance 2m+1 at the doubled rate) are non-zero, besides the centre of 0.5.
const HB_HALF: usize = 16;
const H: usize = 2 * HB_HALF;
// Chrome's oversampling filters are longer: its 2x WaveShaper is 128 frames late. Matched, because
// the bass layers' distortion sits against the clean sub, and the delay sets how their phases meet.
const OVERSAMPLE_LATENCY: usize = 128;

fn half_band() -> [f64; HB_HALF] {
    let k = (HB_HALF * 2) as f64;
    let mut t = [0f64; HB_HALF];
    let mut sum = 0.0;
    for (m, v) in t.iter_mut().enumerate() {
        let j = (2 * m + 1) as f64;
        let w = 0.42 + 0.5 * (PI * j / k).cos() + 0.08 * (2.0 * PI * j / k).cos();
        *v = ((PI * j) / 2.0).sin() / (PI * j) * w;
        sum += 2.0 * *v;
    }
    for v in t.iter_mut() {
        *v *= 0.5 / sum; // unity gain at DC
    }
    t
}

struct Distortion {
    k: f64,
    c: f64,
    over: bool,
    dry: f64,
    wet: f64,
    hb: [f64; HB_HALF],
    xs: [f64; H + BLOCK],     // input, with the last H samples of the block before
    zs: [f64; 2 * H + 2 * BLOCK], // shaped at the doubled rate, likewise
    late: [f64; 128],         // the rest of Chrome's latency (ours is H)
    w: usize,
}

impl Distortion {
    fn new(amount: f64, oversample: bool, wet: f64) -> Self {
        let k = amount * 100.0;
        Distortion {
            k,
            c: (3.0 + k) * 20.0 * PI / 180.0,
            over: oversample,
            dry: if wet >= 1.0 { 0.0 } else { (wet * PI / 2.0).cos() },
            wet: if wet >= 1.0 { 1.0 } else { (wet * PI / 2.0).sin() },
            hb: half_band(),
            xs: [0.0; H + BLOCK],
            zs: [0.0; 2 * H + 2 * BLOCK],
            late: [0.0; 128],
            w: 0,
        }
    }

    // The curve Tone draws into the WaveShaper (which holds its ends beyond ±1).
    #[inline(always)]
    fn shape(&self, x: f64) -> f64 {
        let x = x.clamp(-1.0, 1.0);
        self.c * x / (PI + self.k * x.abs())
    }

    fn process(&mut self, buf: &mut [f32]) {
        let n = buf.len();
        if !self.over {
            for v in buf.iter_mut() {
                let x = *v as f64;
                *v = (self.dry * x + self.wet * self.shape(x)) as f32;
            }
            return;
        }
        for i in 0..n {
            self.xs[H + i] = buf[i] as f64;
        }
        for p in 0..n {
            // Up: the original sample, and one halfway to the next from the half-band filter.
            let a = p + HB_HALF;
            let mut half = 0.0;
            for m in 0..HB_HALF {
                half += self.hb[m] * (self.xs[a - m] + self.xs[a + 1 + m]);
            }
            self.zs[2 * H + 2 * p] = self.shape(self.xs[a]);
            self.zs[2 * H + 2 * p + 1] = self.shape(2.0 * half);
            // Down: the same filter on the shaped signal, every other sample.
            let c = H + 2 * p;
            let mut y = 0.5 * self.zs[c];
            for m in 0..HB_HALF {
                y += self.hb[m] * (self.zs[c - 2 * m - 1] + self.zs[c + 2 * m + 1]);
            }
            self.late[self.w] = y;
            let y = self.late[(self.w + 128 - (OVERSAMPLE_LATENCY - H)) & 127];
            self.w = (self.w + 1) & 127;
            buf[p] = (self.dry * buf[p] as f64 + self.wet * y) as f32;
        }
        self.xs.copy_within(n..n + H, 0);
        self.zs.copy_within(2 * n..2 * n + 2 * H, 0);
    }

    fn reset(&mut self) {
        self.xs.fill(0.0);
        self.zs.fill(0.0);
        self.late.fill(0.0);
    }
}

// ---------- Chrome's DynamicsCompressor, ported from Blink (dynamics_compressor.cc) ----------

const RELEASE_ZONES: [f64; 4] = [0.09, 0.16, 0.42, 0.98];

fn release_base(c: [f64; 4]) -> f64 {
    c.iter().zip(RELEASE_ZONES.iter()).map(|(k, z)| k * z).sum()
}

const PRE_DELAY: f64 = 0.006;
const DIVISION: usize = 32;

struct Compressor {
    linear_threshold: f64,
    db_threshold: f64,
    db_knee: f64,
    slope: f64,
    k: f64,
    db_knee_threshold: f64,
    knee_threshold: f64,
    db_yknee_threshold: f64,
    post_gain: f64,
    attack_frames: f64,
    ra: f64,
    rb: f64,
    rc: f64,
    rd: f64,
    re: f64,
    sat_release_frames: f64,
    quiet_release: f64,
    delay: [[f32; 1024]; 2],
    pre_frames: usize,
    r: usize,
    w: usize,
    detector: f64,
    gain: f64,
    max_attack_diff: f64,
}

impl Compressor {
    fn new(threshold: f64, knee: f64, ratio: f64, attack: f64, release: f64, sr: f64) -> Self {
        let mut c = Compressor {
            linear_threshold: db_to_gain(threshold),
            db_threshold: threshold,
            db_knee: knee,
            slope: 1.0 / ratio,
            k: 0.0,
            db_knee_threshold: threshold + knee,
            knee_threshold: db_to_gain(threshold + knee),
            db_yknee_threshold: 0.0,
            post_gain: 1.0,
            attack_frames: attack.max(0.001) * sr,
            ra: 0.0,
            rb: 0.0,
            rc: 0.0,
            rd: 0.0,
            re: 0.0,
            sat_release_frames: 0.0025 * sr,
            quiet_release: 0.0,
            delay: [[0.0; 1024]; 2],
            pre_frames: ((PRE_DELAY * sr).floor() as usize).min(1023),
            r: 0,
            w: 0,
            detector: 1.0,
            gain: 1.0,
            max_attack_diff: -1.0,
        };
        c.k = c.k_at_slope(1.0 / ratio);
        c.db_yknee_threshold = gain_to_db(c.knee_curve(c.knee_threshold, c.k));
        c.post_gain = (1.0 / c.saturate(1.0, c.k)).powf(0.6);
        let rf = release * sr;
        c.ra = release_base([0.9999999999999998, 1.8432219684323923e-16, -1.9373394351676423e-16, 8.824516011816245e-18]) * rf;
        c.rb = release_base([-1.5788320352845888, 2.3305837032074286, -0.9141194204840429, 0.1623677525612032]) * rf;
        c.rc = release_base([0.5334142869106424, -1.272736789213631, 0.9258856042207512, -0.18656310191776226]) * rf;
        c.rd = release_base([0.08783463138207234, -0.1694162967925622, 0.08588057951595272, -0.00429891410546283]) * rf;
        c.re = release_base([-0.042416883008123074, 0.1115693827987602, -0.09764676325265872, 0.028494263462021576]) * rf;
        // Below the threshold the detector releases at its slowest (2 dB over 2.5 ms).
        c.quiet_release = db_to_gain(2.0 / c.sat_release_frames) - 1.0;
        c.reset();
        c
    }

    fn reset(&mut self) {
        self.delay = [[0.0; 1024]; 2];
        self.r = 0;
        self.w = self.pre_frames;
        // Settled after silence (Blink starts its detector at 0, which only dips the first few frames).
        self.detector = 1.0;
        self.gain = 1.0;
        self.max_attack_diff = -1.0;
    }

    fn knee_curve(&self, x: f64, k: f64) -> f64 {
        if x < self.linear_threshold {
            return x;
        }
        self.linear_threshold + (1.0 - (-k * (x - self.linear_threshold)).exp()) / k
    }

    #[inline(always)]
    fn saturate(&self, x: f64, k: f64) -> f64 {
        if x < self.knee_threshold {
            return self.knee_curve(x, k);
        }
        db_to_gain(self.db_yknee_threshold + self.slope * (gain_to_db(x) - self.db_knee_threshold))
    }

    fn k_at_slope(&self, desired: f64) -> f64 {
        let db_x = self.db_threshold + self.db_knee;
        let x = db_to_gain(db_x);
        let mut x2 = 1.0;
        let mut db_x2 = 0.0;
        if !(x < self.linear_threshold) {
            x2 = x * 1.001;
            db_x2 = gain_to_db(x2);
        }
        let (mut min_k, mut max_k, mut k, mut slope) = (0.1f64, 10000f64, 5f64, 1f64);
        for _ in 0..15 {
            if !(x < self.linear_threshold) {
                slope = (gain_to_db(self.knee_curve(x2, k)) - gain_to_db(self.knee_curve(x, k))) / (db_x2 - db_x);
            }
            if slope < desired {
                max_k = k;
            } else {
                min_k = k;
            }
            k = (min_k * max_k).sqrt();
        }
        k
    }

    // In place, on one or two channels (the detector follows the louder one).
    fn process(&mut self, left: &mut [f32], mut right: Option<&mut [f32]>) {
        let n = left.len();
        let k = self.k;
        let mut frame = 0;
        while frame < n {
            if !self.detector.is_finite() {
                self.detector = 1.0;
            }
            let scaled_desired = self.detector.asin() / (PI / 2.0);
            let releasing = scaled_desired > self.gain;
            let mut diff = if scaled_desired == 0.0 {
                if releasing { -1.0 } else { 1.0 }
            } else {
                gain_to_db(self.gain / scaled_desired)
            };
            let rate;
            if releasing {
                self.max_attack_diff = -1.0;
                if !diff.is_finite() {
                    diff = -1.0;
                }
                let x = 0.25 * (diff.clamp(-12.0, 0.0) + 12.0);
                let x2 = x * x;
                let frames = self.ra + self.rb * x + self.rc * x2 + self.rd * x2 * x + self.re * x2 * x2;
                rate = db_to_gain(5.0 / frames);
            } else {
                if !diff.is_finite() {
                    diff = 1.0;
                }
                if self.max_attack_diff == -1.0 || self.max_attack_diff < diff {
                    self.max_attack_diff = diff;
                }
                let eff = self.max_attack_diff.max(0.5);
                rate = 1.0 - (0.25 / eff).powf(1.0 / self.attack_frames);
            }
            let (mut r, mut w, mut detector, mut gain) = (self.r, self.w, self.detector, self.gain);
            let end = n.min(frame + DIVISION);
            while frame < end {
                let xl = left[frame];
                self.delay[0][w] = xl;
                let mut input = xl.abs() as f64;
                if let Some(right) = right.as_deref() {
                    let xr = right[frame];
                    self.delay[1][w] = xr;
                    input = input.max(xr.abs() as f64);
                }
                let mut attenuation = 1.0;
                let mut sat_release = self.quiet_release;
                if input > 0.0001 {
                    attenuation = self.saturate(input, k) / input;
                    let db_atten = (-gain_to_db(attenuation)).max(2.0);
                    if db_atten > 2.0 {
                        sat_release = db_to_gain(db_atten / self.sat_release_frames) - 1.0;
                    }
                }
                detector += (attenuation - detector) * if attenuation > detector { sat_release } else { 1.0 };
                if detector > 1.0 {
                    detector = 1.0;
                }
                if rate < 1.0 {
                    gain += (scaled_desired - gain) * rate;
                } else {
                    gain *= rate;
                    if gain > 1.0 {
                        gain = 1.0;
                    }
                }
                let total = if gain == 1.0 { self.post_gain } else { self.post_gain * (PI / 2.0 * gain).sin() };
                left[frame] = (self.delay[0][r] as f64 * total) as f32;
                if let Some(right) = right.as_deref_mut() {
                    right[frame] = (self.delay[1][r] as f64 * total) as f32;
                }
                r = (r + 1) & 1023;
                w = (w + 1) & 1023;
                frame += 1;
            }
            self.r = r;
            self.w = w;
            self.detector = if detector.abs() < 1e-25 { 0.0 } else { detector };
            self.gain = if gain.abs() < 1e-25 { 0.0 } else { gain };
        }
    }
}

// ---------- the effects a source can have ----------

enum Fx {
    Filter(Biquad),
    Vibrato(Vibrato),
    Chorus(Chorus),
    Distortion(Box<Distortion>),
    Compressor(Box<Compressor>),
    Gain(f64),
}

impl Fx {
    fn process(&mut self, buf: &mut [f32], sine: &[f32]) {
        match self {
            Fx::Filter(f) => {
                let n = buf.len();
                f.process(buf, 0, n, 0)
            }
            Fx::Vibrato(v) => v.process(buf, sine),
            Fx::Chorus(c) => c.process(buf, sine),
            Fx::Distortion(d) => d.process(buf),
            Fx::Compressor(c) => c.process(buf, None),
            Fx::Gain(g) => {
                for v in buf.iter_mut() {
                    *v = (*v as f64 * *g) as f32;
                }
            }
        }
    }

    fn reset(&mut self) {
        match self {
            Fx::Filter(f) => f.reset(),
            Fx::Vibrato(v) => v.line.reset(),
            Fx::Chorus(c) => c.line.reset(),
            Fx::Distortion(d) => d.reset(),
            Fx::Compressor(c) => c.reset(),
            Fx::Gain(_) => {}
        }
    }
}

// ---------- envelope: Tone.Envelope with its default curves ----------
// Attack is a linear ramp (shortened when starting from above zero, as in Tone); decay and release
// are setTargetAtTime with Tone's time constant for 90 % of their time, then a linear ramp home.

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Off,
    Attack,
    Decay,
    DecayEnd,
    Sustain,
    Release,
    ReleaseEnd,
}

#[derive(Clone, Copy)]
struct Env {
    a: f64,
    d: f64,
    s: f64,
    r: f64,
    kd: f64,
    kr: f64,
    v: f64,
    stage: Stage,
    vel: f64,
    from: f64,
    target: f64,
    n: f64,
    len: f64,
}

impl Env {
    fn new(attack: f64, decay: f64, sustain: f64, release: f64, sr: f64) -> Self {
        let tc = |t: f64| (-1.0 / ((t + 1.0).ln() / 200f64.ln() * sr)).exp();
        Env {
            a: attack * sr,
            d: decay * sr,
            s: sustain,
            r: release * sr,
            kd: if decay > 0.0 { tc(decay) } else { 0.0 },
            kr: if release > 0.0 { tc(release) } else { 0.0 },
            v: 0.0,
            stage: Stage::Off,
            vel: 0.0,
            from: 0.0,
            target: 0.0,
            n: 0.0,
            len: 0.0,
        }
    }

    fn attack(&mut self, vel: f64) {
        self.vel = vel;
        let len = if self.v > 0.0 { (1.0 - self.v) * self.a } else { self.a };
        if len < 1.0 {
            self.v = vel;
            self.decay();
            return;
        }
        self.stage = Stage::Attack;
        self.from = self.v;
        self.n = 0.0;
        self.len = len;
    }

    fn decay(&mut self) {
        if self.d > 0.0 && self.s < 1.0 {
            self.stage = Stage::Decay;
            self.target = self.vel * self.s;
            self.n = 0.0;
            self.len = 0.9 * self.d;
        } else {
            self.stage = Stage::Sustain;
        }
    }

    fn release(&mut self) {
        if self.v <= 0.0 {
            self.stage = Stage::Off;
            return;
        }
        if self.r < 1.0 {
            self.v = 0.0;
            self.stage = Stage::Off;
            return;
        }
        self.stage = Stage::Release;
        self.target = 0.0;
        self.n = 0.0;
        self.len = 0.9 * self.r;
    }

    #[inline(always)]
    fn next(&mut self) -> f64 {
        match self.stage {
            Stage::Attack => {
                self.n += 1.0;
                self.v = self.from + (self.vel - self.from) * (self.n / self.len);
                if self.n >= self.len {
                    self.v = self.vel;
                    self.decay();
                }
            }
            Stage::Decay | Stage::Release => {
                let decay = self.stage == Stage::Decay;
                self.v = self.target + (self.v - self.target) * if decay { self.kd } else { self.kr };
                self.n += 1.0;
                if self.n >= self.len {
                    self.from = self.v;
                    self.n = 0.0;
                    self.len = if decay { 0.1 * self.d } else { 0.1 * self.r };
                    self.stage = if decay { Stage::DecayEnd } else { Stage::ReleaseEnd };
                }
            }
            Stage::DecayEnd | Stage::ReleaseEnd => {
                self.n += 1.0;
                self.v = self.from + (self.target - self.from) * (self.n / self.len);
                if self.n >= self.len {
                    self.v = self.target;
                    self.stage = if self.stage == Stage::DecayEnd { Stage::Sustain } else { Stage::Off };
                }
            }
            Stage::Off | Stage::Sustain => {}
        }
        self.v
    }

    #[inline(always)]
    fn silent(&self) -> bool {
        self.stage == Stage::Off || (self.stage == Stage::Sustain && self.v == 0.0)
    }
}

// ---------- oscillator: Tone's Oscillator / FatOscillator ----------

#[derive(Clone, Copy, PartialEq)]
enum Wave {
    Saw,
    Square,
    Table, // sine or custom partials
}

#[derive(Clone)]
struct Osc {
    wave: Wave,
    count: usize,
    ratio: [f64; 8],
    phase: [f64; 8],
    gain: f64,
    table: usize, // which table (0: sine, 1: this instrument's partials)
}

impl Osc {
    fn new(wave: Wave, count: usize, spread: f64, table: usize) -> Self {
        let mut o = Osc { wave, count, ratio: [1.0; 8], phase: [0.0; 8], gain: 1.0, table };
        // FatOscillator: detunes spread evenly across `spread` cents, each a bit quieter, phases fanned out.
        for i in 0..count {
            let cents = if count > 1 { -spread / 2.0 + spread / (count - 1) as f64 * i as f64 } else { 0.0 };
            o.ratio[i] = 2f64.powf(cents / 1200.0);
        }
        o.gain = if count > 1 { db_to_gain(-6.0 - count as f64 * 1.1) } else { 1.0 } * if wave == Wave::Table { 1.0 } else { GIBBS };
        o.reset();
        o
    }

    fn reset(&mut self) {
        for i in 0..self.count {
            self.phase[i] = i as f64 / self.count as f64;
        }
    }

    #[inline(always)]
    fn next(&mut self, freq: f64, inv_sr: f64, table: &[f32]) -> f64 {
        let mut out = 0.0;
        for i in 0..self.count {
            let dt = freq * self.ratio[i] * inv_sr;
            let t = self.phase[i];
            out += match self.wave {
                Wave::Saw => 2.0 * t - 1.0 - blep(t, dt),
                Wave::Square => {
                    let t2 = t + 0.5;
                    let t2 = if t2 >= 1.0 { t2 - 1.0 } else { t2 };
                    (if t < 0.5 { 1.0 } else { -1.0 }) + blep(t, dt) - blep(t2, dt)
                }
                Wave::Table => lookup(table, t),
            };
            let t = t + dt;
            self.phase[i] = t - t.floor();
        }
        out * self.gain
    }
}

// ---------- voices ----------

// Tone.Synth (osc -> amplitude envelope) and Tone.MonoSynth (osc -> lowpass swept by a frequency
// envelope -> amplitude envelope), with Monophonic's portamento. With pitchDecay it is a
// MembraneSynth: every note starts `octaves` times higher and sweeps down to its pitch.
#[derive(Clone)]
struct FilterEnv {
    filter: Biquad,
    env: Env,
    base: f64,
    range: f64,
    exp: f64,
}

#[derive(Clone)]
struct SynthVoice {
    osc: Osc,
    env: Env,
    porta: f64,
    pitch_decay: f64,
    octaves: f64,
    filter: Option<FilterEnv>,
    freq: f64,
    glide: f64,
    g: f64,
    from: f64,
    to: f64,
    ctrl: i32,
}

impl SynthVoice {
    fn attack(&mut self, freq: f64, vel: f64) {
        self.glide = 0.0;
        if self.pitch_decay > 0.0 {
            self.from = freq * self.octaves;
            self.to = freq;
            self.freq = self.from;
            self.glide = self.pitch_decay;
            self.g = 0.0;
        } else if self.porta > 0.0 && self.env.v > 0.05 {
            // Tone glides only when the previous note is still clearly sounding.
            self.from = self.freq;
            self.to = freq;
            self.glide = self.porta;
            self.g = 0.0;
        } else {
            self.freq = freq;
        }
        if self.env.silent() {
            self.osc.reset();
            if let Some(f) = &mut self.filter {
                f.filter.reset();
            }
        }
        self.env.attack(vel);
        if let Some(f) = &mut self.filter {
            f.env.attack(1.0);
        }
        self.ctrl = 0;
    }

    fn release(&mut self) {
        self.env.release();
        if let Some(f) = &mut self.filter {
            f.env.release();
        }
    }

    fn render(&mut self, out: &mut [f32], gain: f64, inv_sr: f64, table: &[f32]) {
        for o in out.iter_mut() {
            if self.ctrl <= 0 {
                self.ctrl = CTRL;
                if self.glide > 0.0 {
                    self.g = (self.g + CTRL as f64 / self.glide).min(1.0);
                    self.freq = self.from * (self.to / self.from).powf(self.g);
                    if self.g >= 1.0 {
                        self.glide = 0.0;
                    }
                }
                if let Some(f) = &mut self.filter {
                    let fr = f.base + f.env.v.powf(f.exp) * f.range;
                    let q = f.filter.q;
                    f.filter.set(fr, q);
                }
            }
            self.ctrl -= 1;
            let mut x = self.osc.next(self.freq, inv_sr, table);
            if let Some(f) = &mut self.filter {
                f.env.next();
                x = f.filter.next(x);
            }
            *o = (*o as f64 + x * self.env.next() * gain) as f32;
            if self.env.stage == Stage::Off {
                break;
            }
        }
    }
}

// Tone.FMSynth: a sine carrier whose frequency is pushed by a sine modulator at `harmonicity`
// times the note, by up to `modulationIndex` times the note; both have their own envelope and
// sit at -10 dB inside the synth, as in Tone.
#[derive(Clone)]
struct FmVoice {
    env: Env,
    menv: Env,
    harm: f64,
    index: f64,
    cp: f64,
    mp: f64,
    freq: f64,
}

impl FmVoice {
    fn attack(&mut self, freq: f64, vel: f64) {
        self.freq = freq;
        if self.env.silent() {
            self.cp = 0.0;
            self.mp = 0.0;
        }
        self.env.attack(vel);
        self.menv.attack(vel);
    }

    fn release(&mut self) {
        self.env.release();
        self.menv.release();
    }

    fn render(&mut self, out: &mut [f32], gain: f64, inv_sr: f64, sine: &[f32]) {
        let inner = db_to_gain(-10.0);
        let f = self.freq;
        let mdt = f * self.harm * inv_sr;
        for o in out.iter_mut() {
            let m = lookup(sine, self.mp) * self.menv.next() * inner;
            self.mp += mdt;
            self.mp -= self.mp.floor();
            *o = (*o as f64 + lookup(sine, self.cp) * self.env.next() * inner * gain) as f32;
            self.cp += (f + f * self.index * m) * inv_sr;
            self.cp -= self.cp.floor();
            if self.env.stage == Stage::Off {
                break;
            }
        }
    }
}

#[derive(Clone)]
enum VoiceKind {
    Synth(SynthVoice),
    Fm(FmVoice),
}

#[derive(Clone)]
struct Voice {
    kind: VoiceKind,
    gen: u32,
    released: bool,
}

impl Voice {
    #[inline(always)]
    fn env(&self) -> &Env {
        match &self.kind {
            VoiceKind::Synth(s) => &s.env,
            VoiceKind::Fm(f) => &f.env,
        }
    }

    fn silent(&self) -> bool {
        self.env().silent()
    }

    fn attack(&mut self, freq: f64, vel: f64) {
        match &mut self.kind {
            VoiceKind::Synth(s) => s.attack(freq, vel),
            VoiceKind::Fm(f) => f.attack(freq, vel),
        }
    }

    fn release(&mut self) {
        match &mut self.kind {
            VoiceKind::Synth(s) => s.release(),
            VoiceKind::Fm(f) => f.release(),
        }
        self.released = true;
    }
}

// ---------- sources: what feeds a track, each with its own buffer, effects and fader ----------

struct Instrument {
    poly: bool,
    max: usize,
    level: f64,
    template: Voice,
    voices: Vec<Voice>, // all maxPolyphony made up front; `made` of them are in use (as Tone grows them)
    made: usize,
    partials: Vec<f32>,
}

impl Instrument {
    // PolySynth: a free voice, a new one up to maxPolyphony, else the quietest released one.
    fn voice(&mut self) -> Option<usize> {
        if !self.poly {
            return Some(0);
        }
        if let Some(i) = self.voices[..self.made].iter().position(|v| v.silent()) {
            return Some(i);
        }
        if self.made < self.max {
            self.made += 1;
            return Some(self.made - 1);
        }
        let mut best: Option<usize> = None;
        for (i, v) in self.voices[..self.made].iter().enumerate() {
            if v.released && best.map_or(true, |b| v.env().v < self.voices[b].env().v) {
                best = Some(i);
            }
        }
        best
    }
}

struct SampleVoice {
    sample: usize,
    token: u32,
    pos: f64,
    step: f64,
    end: f64,
    level: f64,
    g: f64,
    inc: f64,
}

struct Sample {
    data: Vec<f32>,
    rate: f64,
}

// Plays sample buffers, any number at once: Tone.ToneBufferSource with its linear fades.
struct Sampler {
    playing: Vec<SampleVoice>,
}

enum Kind {
    Inst(Instrument),
    Sampler(Sampler),
}

struct Source {
    kind: Kind,
    track: usize,
    fx: Vec<Fx>,
    gain: Param,
    buf: [f32; BLOCK],
    busy: bool,    // made sound this block
    quiet: f64,    // frames its effects have been silent; past TAIL it sleeps
}

impl Source {
    fn new(kind: Kind, track: usize, gain: f64) -> Self {
        Source { kind, track, fx: Vec::new(), gain: Param::new(gain), buf: [0.0; BLOCK], busy: false, quiet: f64::INFINITY }
    }

    fn render(&mut self, from: usize, to: usize, sr: f64, sine: &[f32], samples: &[Option<Sample>]) {
        let inv_sr = 1.0 / sr;
        let buf = &mut self.buf[from..to];
        match &mut self.kind {
            Kind::Inst(inst) => {
                let level = inst.level;
                for v in inst.voices[..inst.made].iter_mut() {
                    if v.silent() {
                        continue;
                    }
                    match &mut v.kind {
                        VoiceKind::Synth(s) => {
                            let table = if s.osc.table == 1 { &inst.partials[..] } else { sine };
                            s.render(buf, level, inv_sr, table)
                        }
                        VoiceKind::Fm(f) => f.render(buf, level, inv_sr, sine),
                    }
                    self.busy = true;
                }
            }
            Kind::Sampler(sm) => {
                let mut k = sm.playing.len();
                while k > 0 {
                    k -= 1;
                    let v = &mut sm.playing[k];
                    let mut done = true;
                    if let Some(Some(s)) = samples.get(v.sample) {
                        let d = &s.data;
                        let end = v.end.min(d.len() as f64 - 1.0);
                        done = false;
                        let (mut pos, mut g) = (v.pos, v.g);
                        for o in buf.iter_mut() {
                            if pos >= end {
                                done = true;
                                break;
                            }
                            let i = pos as usize;
                            let x = if v.step == 1.0 { d[i] as f64 } else { d[i] as f64 + (d[i + 1] as f64 - d[i] as f64) * (pos - i as f64) };
                            *o = (*o as f64 + x * g * v.level) as f32;
                            pos += v.step;
                            if v.inc != 0.0 {
                                g += v.inc;
                                if g >= 1.0 {
                                    g = 1.0;
                                    v.inc = 0.0;
                                } else if g <= 0.0 {
                                    done = true;
                                    break;
                                }
                            }
                        }
                        v.pos = pos;
                        v.g = g;
                    }
                    self.busy = true;
                    if done {
                        sm.playing.swap_remove(k);
                    }
                }
            }
        }
    }

    // Effects, then the fader, then into the track. Asleep once silent with every tail rung out.
    fn mix(&mut self, into: &mut [f32], start: f64, sr: f64, sine: &[f32]) {
        let n = into.len();
        if !self.busy && self.quiet > TAIL * sr {
            return;
        }
        let moving = self.gain.run(start, n, sr);
        if !moving && self.gain.v == 0.0 {
            // Faded out: as if unplugged, the effects start from silence when it comes back.
            if self.quiet != f64::INFINITY {
                self.fx.iter_mut().for_each(Fx::reset);
            }
            self.quiet = f64::INFINITY;
            return;
        }
        let buf = &mut self.buf[..n];
        for f in self.fx.iter_mut() {
            f.process(buf, sine);
        }
        if self.busy {
            self.quiet = 0.0;
        } else if peak(buf) < QUIET {
            self.quiet += n as f64;
            if self.quiet > TAIL * sr {
                self.fx.iter_mut().for_each(Fx::reset);
                self.quiet = f64::INFINITY;
                return;
            }
        } else {
            self.quiet = 0.0;
        }
        for i in 0..n {
            into[i] = (into[i] as f64 + buf[i] as f64 * self.gain.at(moving, i)) as f32;
        }
    }
}

// Tone.FeedbackDelay, all wet: what comes out is fed back in at `feedback`.
struct FeedbackDelay {
    line: DelayLine,
    time: Param,
    feedback: f64,
    quiet: f64,
}

impl FeedbackDelay {
    // From `inp` into `out` (added). Asleep once nothing goes in and what is left has died away.
    fn process(&mut self, inp: &[f32], out: &mut [f32], start: f64, sr: f64, input_quiet: bool) {
        let n = inp.len();
        let moving = self.time.run(start, n, sr);
        if input_quiet && self.quiet > self.time.v * sr + 128.0 {
            return;
        }
        let mut level = 0f64;
        for i in 0..n {
            let y = self.line.read(self.time.at(moving, i) * sr - 1.0);
            self.line.write(inp[i] as f64 + self.feedback * y);
            out[i] = (out[i] as f64 + y) as f32;
            level = level.max(y.abs());
        }
        self.quiet = if !input_quiet || level >= QUIET { 0.0 } else { self.quiet + n as f64 };
    }
}

// ---------- the mix ----------

const ATTACK: u8 = 0;
const RELEASE: u8 = 1;
const SILENCE: u8 = 2;
const DRUM: u8 = 3;
const CHOKE: u8 = 4;
const CLIP: u8 = 5;
const CLIP_END: u8 = 6;
const CLIP_STOP: u8 = 7;

#[derive(Clone, Copy)]
struct Event {
    frame: f64,
    kind: u8,
    src: usize,
    a: f64, // frequency, gain, fade or offset
    b: f64, // velocity
    token: u32,
}

const TOKENS: usize = 4096;

struct Track {
    master_bus: bool,
    rev: f64,
    del: f64,
    buf: [f32; BLOCK],
    vol: Param,
    mute: Param,
}

pub struct Mix {
    sr: f64,
    sine: Vec<f32>,
    tracks: Vec<Track>,
    sources: Vec<Source>,
    samples: Vec<Option<Sample>>,
    events: Vec<Event>,
    notes: Vec<(usize, u32)>, // token -> (voice, gen) of a started note, for its release
    next_token: u32,
    delay_in: Biquad,
    delay: FeedbackDelay,
    reverb_in: Biquad,
    duck: Param,
    wash: Param,
    music: [f32; BLOCK],
    delay_send: [f32; BLOCK],
    out: [f32; 2 * BLOCK], // the master bus, then the reverb send
}

impl Mix {
    fn schedule(&mut self, ev: Event) {
        let mut i = self.events.len();
        while i > 0 && self.events[i - 1].frame > ev.frame {
            i -= 1;
        }
        self.events.insert(i, ev);
    }

    fn token(&mut self) -> u32 {
        self.next_token = self.next_token.wrapping_add(1);
        self.next_token
    }

    fn run(&mut self, ev: Event) {
        let src = &mut self.sources[ev.src];
        match (ev.kind, &mut src.kind) {
            (ATTACK, Kind::Inst(inst)) => {
                if let Some(vi) = inst.voice() {
                    let v = &mut inst.voices[vi];
                    v.gen = v.gen.wrapping_add(1);
                    v.released = false;
                    v.attack(ev.a, ev.b);
                    self.notes[ev.token as usize % TOKENS] = (vi, v.gen);
                } else {
                    self.notes[ev.token as usize % TOKENS] = (usize::MAX, 0);
                }
            }
            (RELEASE, Kind::Inst(inst)) => {
                let (vi, gen) = self.notes[ev.token as usize % TOKENS];
                if vi < inst.made && inst.voices[vi].gen == gen {
                    inst.voices[vi].release();
                }
            }
            (SILENCE, Kind::Inst(inst)) => {
                for v in inst.voices[..inst.made].iter_mut() {
                    if !v.silent() {
                        v.release();
                    }
                }
            }
            (DRUM | CLIP, Kind::Sampler(sm)) => {
                let sample = ev.token as usize;
                if let Some(Some(s)) = self.samples.get(sample) {
                    let clip = ev.kind == CLIP;
                    sm.playing.push(SampleVoice {
                        sample,
                        token: if clip { ev.b as u32 } else { 0 },
                        pos: if clip { ev.a * s.rate } else { 0.0 },
                        step: s.rate / self.sr,
                        end: s.data.len() as f64 - 1.0,
                        level: if clip { 1.0 } else { ev.a },
                        g: if clip { 0.0 } else { 1.0 },
                        inc: if clip { 1.0 / (0.003 * self.sr) } else { 0.0 },
                    });
                }
            }
            (CHOKE, Kind::Sampler(sm)) => {
                for v in sm.playing.iter_mut().filter(|v| v.sample == ev.token as usize) {
                    v.inc = if ev.a > 0.0 { -v.g / (ev.a * self.sr) } else { f64::NEG_INFINITY };
                }
            }
            (CLIP_END | CLIP_STOP, Kind::Sampler(sm)) => {
                for v in sm.playing.iter_mut() {
                    if ev.kind == CLIP_STOP || v.token == ev.token {
                        v.inc = -v.g / (0.03 * self.sr);
                    }
                }
            }
            _ => {}
        }
    }

    fn process(&mut self, start: f64) {
        let n = BLOCK;
        let sr = self.sr;
        for s in self.sources.iter_mut() {
            s.buf = [0.0; BLOCK];
            s.busy = false;
        }
        let mut pos = 0usize;
        while !self.events.is_empty() && self.events[0].frame < start + n as f64 {
            let ev = self.events.remove(0);
            let at = (ev.frame - start).max(0.0) as usize;
            if at > pos {
                self.render(pos, at);
            }
            pos = pos.max(at);
            self.run(ev);
        }
        if pos < n {
            self.render(pos, n);
        }

        for t in self.tracks.iter_mut() {
            t.buf = [0.0; BLOCK];
        }
        for s in self.sources.iter_mut() {
            let t = &mut self.tracks[s.track];
            s.mix(&mut t.buf, start, sr, &self.sine);
        }

        // Tracks: each a mono channel at its fader, into its bus and the reverb and delay sends.
        let (out, rev) = self.out.split_at_mut(BLOCK);
        out.fill(0.0);
        rev.fill(0.0);
        self.music = [0.0; BLOCK];
        self.delay_send = [0.0; BLOCK];
        for t in self.tracks.iter_mut() {
            let vm = t.vol.run(start, n, sr);
            let mm = t.mute.run(start, n, sr);
            let bus = if t.master_bus { &mut *out } else { &mut self.music[..] };
            for i in 0..n {
                let x = t.buf[i] as f64 * CENTER * t.vol.at(vm, i) * t.mute.at(mm, i);
                t.buf[i] = x as f32;
                bus[i] = (bus[i] as f64 + x) as f32;
            }
            if t.rev != 0.0 {
                for i in 0..n {
                    rev[i] = (rev[i] as f64 + t.buf[i] as f64 * t.rev) as f32;
                }
            }
            if t.del != 0.0 {
                for i in 0..n {
                    self.delay_send[i] = (self.delay_send[i] as f64 + t.buf[i] as f64 * t.del) as f32;
                }
            }
        }

        // The delay comes back on the music bus, which ducks on every kick (sidechain pump).
        let send_quiet = peak(&self.delay_send) == 0.0;
        self.delay_in.process(&mut self.delay_send, 0, n, 0);
        self.delay.process(&self.delay_send, &mut self.music, start, sr, send_quiet);
        let dm = self.duck.run(start, n, sr);
        for i in 0..n {
            out[i] = (out[i] as f64 + self.music[i] as f64 * self.duck.at(dm, i)) as f32;
        }

        // The XY pad's space: the whole mix into the reverb too.
        let wm = self.wash.run(start, n, sr);
        if wm || self.wash.v > 0.0 {
            for i in 0..n {
                rev[i] = (rev[i] as f64 + out[i] as f64 * self.wash.at(wm, i)) as f32;
            }
        }
        self.reverb_in.process(rev, 0, n, 0);
    }

    fn render(&mut self, from: usize, to: usize) {
        let (sr, sine, samples) = (self.sr, &self.sine, &self.samples);
        for s in self.sources.iter_mut() {
            s.render(from, to, sr, sine, samples);
        }
    }

    fn param(&mut self, id: usize) -> Option<&mut Param> {
        let nt = self.tracks.len();
        match id {
            0 => Some(&mut self.duck),
            1 => Some(&mut self.wash),
            2 => Some(&mut self.delay.time),
            i if i < 3 + 2 * nt => {
                let t = &mut self.tracks[(i - 3) / 2];
                Some(if (i - 3) % 2 == 0 { &mut t.vol } else { &mut t.mute })
            }
            i => self.sources.get_mut(i - 3 - 2 * nt).map(|s| &mut s.gain),
        }
    }
}

// ---------- the master ----------

pub struct Master {
    sr: f64,
    hp: Biquad,
    lp: Biquad,
    comp: Box<Compressor>,
    limiter: Box<Compressor>,
    params: [Param; 5], // hp, lp, q, dry, out
    input: [f32; 3 * BLOCK], // the master bus, then the reverb return's left and right
    out: [f32; 2 * BLOCK],
}

impl Master {
    fn process(&mut self, start: f64, has_bus: bool, has_rev: u32) {
        let n = BLOCK;
        let sr = self.sr;
        let (l, r) = self.out.split_at_mut(BLOCK);
        let (bus, rev) = self.input.split_at(BLOCK);
        let (rl, rr) = rev.split_at(BLOCK);
        let rr = if has_rev >= 2 { rr } else { rl };

        // The dry mix (stepping back as the space grows) and the reverb return.
        let [hp, lp, q, dry, out] = &mut self.params;
        let dm = dry.run(start, n, sr);
        for i in 0..n {
            let m = if has_bus { bus[i] as f64 * dry.at(dm, i) } else { 0.0 };
            l[i] = (m + if has_rev > 0 { rl[i] as f64 } else { 0.0 }) as f32;
            r[i] = (m + if has_rev > 0 { rr[i] as f64 } else { 0.0 }) as f32;
        }

        // DJ filters: while the pad moves them, new coefficients every 16 samples.
        let hm = hp.run(start, n, sr);
        let lm = lp.run(start, n, sr);
        let qm = q.run(start, n, sr);
        if hm || lm || qm {
            let mut i = 0;
            while i < n {
                let e = n.min(i + 16);
                let qv = q.at(qm, i);
                self.hp.set(hp.at(hm, i), qv);
                self.lp.set(lp.at(lm, i), qv);
                Self::filter(&mut self.hp, &mut self.lp, l, r, i, e);
                i += 16;
            }
        } else {
            self.hp.set(hp.v, q.v);
            self.lp.set(lp.v, q.v);
            Self::filter(&mut self.hp, &mut self.lp, l, r, 0, n);
        }

        self.comp.process(l, Some(&mut *r));
        self.limiter.process(l, Some(&mut *r));

        // Soft clipper after the limiter: linear up to 0.7, then rounds off so peaks never pass 0 dBFS.
        let om = out.run(start, n, sr);
        for ch in [l, r] {
            for i in 0..n {
                let x = (ch[i] as f64).clamp(-1.0, 1.0); // the WaveShaper's curve ends at ±1
                let a = x.abs();
                let y = if a >= 0.7 { x.signum() * (0.7 + 0.29 * ((a - 0.7) / 0.29).tanh()) } else { x };
                ch[i] = (y * out.at(om, i)) as f32;
            }
        }
    }

    fn filter(hp: &mut Biquad, lp: &mut Biquad, l: &mut [f32], r: &mut [f32], from: usize, to: usize) {
        hp.process(l, from, to, 0);
        hp.process(r, from, to, 1);
        lp.process(l, from, to, 0);
        lp.process(r, from, to, 1);
    }
}

// ---------- the interface for the JavaScript glue ----------
// Each AudioWorklet processor has its own instance of this module: one runs a Mix, one a Master.

static mut MIX: Option<Box<Mix>> = None;
static mut MASTER: Option<Box<Master>> = None;
static mut SCRATCH: Vec<f64> = Vec::new(); // numbers handed over from JavaScript (partials)

#[allow(static_mut_refs)]
fn mix() -> &'static mut Mix {
    unsafe { MIX.as_mut().expect("mix_new first") }
}

#[allow(static_mut_refs)]
fn master() -> &'static mut Master {
    unsafe { MASTER.as_mut().expect("master_new first") }
}

#[no_mangle]
pub extern "C" fn mix_new(sr: f64) {
    unsafe {
        MIX = Some(Box::new(Mix {
            sr,
            sine: sine_table(),
            tracks: Vec::new(),
            sources: Vec::new(),
            samples: Vec::new(),
            events: Vec::with_capacity(8192),
            notes: vec![(usize::MAX, 0); TOKENS],
            next_token: 0,
            delay_in: Biquad::new(FilterType::Bandpass, 2000.0, 0.5, 0.0, 1, sr),
            delay: FeedbackDelay { line: DelayLine::new(1.0, sr), time: Param::new(0.375), feedback: 0.35, quiet: f64::INFINITY },
            reverb_in: Biquad::new(FilterType::Highpass, 300.0, 1.0, 0.0, 1, sr),
            duck: Param::new(1.0),
            wash: Param::new(0.0),
            music: [0.0; BLOCK],
            delay_send: [0.0; BLOCK],
            out: [0.0; 2 * BLOCK],
        }));
    }
}

/// A track: a mono channel into the master (`master_bus`) or the music bus, with its sends.
#[no_mangle]
pub extern "C" fn mix_track(master_bus: u32, rev: f64, del: f64) -> u32 {
    let m = mix();
    m.tracks.push(Track { master_bus: master_bus != 0, rev, del, buf: [0.0; BLOCK], vol: Param::new(1.0), mute: Param::new(1.0) });
    (m.tracks.len() - 1) as u32
}

#[no_mangle]
pub extern "C" fn mix_delay(time: f64, feedback: f64, filter: u32, frequency: f64, q: f64) {
    let m = mix();
    let sr = m.sr;
    m.delay.time = Param::new(time);
    m.delay.feedback = feedback;
    m.delay_in = Biquad::new(FilterType::from(filter), frequency, q, 0.0, 1, sr);
}

#[no_mangle]
pub extern "C" fn mix_reverb_in(filter: u32, frequency: f64, q: f64) {
    let m = mix();
    m.reverb_in = Biquad::new(FilterType::from(filter), frequency, q, 0.0, 1, m.sr);
}

/// Hands one number to the next setup call that takes a list (the partials of a custom wave).
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn mix_push(v: f64) {
    unsafe { SCRATCH.push(v) }
}

/// An instrument: wave 0 saw, 1 square, 2 sine, 3 custom (partials pushed before), 4 FM.
/// Envelopes, filter and the rest come with the calls below, then `mix_instrument_done`.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn mix_instrument(track: u32, gain: f64, volume: f64, max_poly: u32, wave: u32, count: u32, spread: f64) -> u32 {
    let m = mix();
    let sr = m.sr;
    let partials = if wave == 3 { unsafe { partials_table(&std::mem::take(&mut SCRATCH)) } } else { Vec::new() };
    let env = Env::new(0.0, 0.0, 1.0, 0.0, sr);
    let kind = if wave == 4 {
        VoiceKind::Fm(FmVoice { env, menv: env, harm: 1.0, index: 1.0, cp: 0.0, mp: 0.0, freq: 440.0 })
    } else {
        let (w, table) = match wave {
            0 => (Wave::Saw, 0),
            1 => (Wave::Square, 0),
            3 => (Wave::Table, 1),
            _ => (Wave::Table, 0),
        };
        VoiceKind::Synth(SynthVoice {
            osc: Osc::new(w, count.clamp(1, 8) as usize, spread, table),
            env,
            porta: 0.0,
            pitch_decay: 0.0,
            octaves: 1.0,
            filter: None,
            freq: 440.0,
            glide: 0.0,
            g: 0.0,
            from: 440.0,
            to: 440.0,
            ctrl: 0,
        })
    };
    let inst = Instrument {
        poly: max_poly > 0,
        max: max_poly.max(1) as usize,
        level: db_to_gain(volume),
        template: Voice { kind, gen: 0, released: false },
        voices: Vec::new(),
        made: 0,
        partials,
    };
    m.sources.push(Source::new(Kind::Inst(inst), track as usize, gain));
    (m.sources.len() - 1) as u32
}

fn template(i: u32) -> &'static mut Voice {
    match &mut mix().sources[i as usize].kind {
        Kind::Inst(inst) => &mut inst.template,
        Kind::Sampler(_) => panic!("not an instrument"),
    }
}

/// An envelope: 0 amplitude, 1 filter, 2 FM modulation.
#[no_mangle]
pub extern "C" fn mix_envelope(i: u32, which: u32, attack: f64, decay: f64, sustain: f64, release: f64) {
    let sr = mix().sr;
    let env = Env::new(attack, decay, sustain, release, sr);
    match (&mut template(i).kind, which) {
        (VoiceKind::Synth(s), 0) => s.env = env,
        (VoiceKind::Synth(s), 1) => {
            if let Some(f) = &mut s.filter {
                f.env = env;
            }
        }
        (VoiceKind::Fm(f), 0) => f.env = env,
        (VoiceKind::Fm(f), 2) => f.menv = env,
        _ => {}
    }
}

/// MonoSynth's filter: a lowpass of `stages` x 12 dB swept by the filter envelope.
#[no_mangle]
pub extern "C" fn mix_filter(i: u32, stages: u32, q: f64, base: f64, octaves: f64, exponent: f64) {
    let sr = mix().sr;
    if let VoiceKind::Synth(s) = &mut template(i).kind {
        s.filter = Some(FilterEnv {
            filter: Biquad::new(FilterType::Lowpass, 350.0, q, 0.0, stages as usize, sr),
            env: Env::new(0.0, 0.0, 1.0, 0.0, sr),
            base,
            range: base * 2f64.powf(octaves) - base,
            exp: exponent,
        });
    }
}

#[no_mangle]
pub extern "C" fn mix_glide(i: u32, portamento: f64, pitch_decay: f64, octaves: f64) {
    let sr = mix().sr;
    if let VoiceKind::Synth(s) = &mut template(i).kind {
        s.porta = portamento * sr;
        s.pitch_decay = pitch_decay * sr;
        s.octaves = octaves;
    }
}

#[no_mangle]
pub extern "C" fn mix_fm(i: u32, harmonicity: f64, index: f64) {
    if let VoiceKind::Fm(f) = &mut template(i).kind {
        f.harm = harmonicity;
        f.index = index;
    }
}

/// Makes every voice of an instrument from its template.
#[no_mangle]
pub extern "C" fn mix_instrument_done(i: u32) {
    if let Kind::Inst(inst) = &mut mix().sources[i as usize].kind {
        inst.voices = vec![inst.template.clone(); inst.max];
        inst.made = if inst.poly { 0 } else { 1 };
    }
}

/// A sample player (the drums, the voice clips) on a track.
#[no_mangle]
pub extern "C" fn mix_sampler(track: u32) -> u32 {
    let m = mix();
    m.sources.push(Source::new(Kind::Sampler(Sampler { playing: Vec::with_capacity(64) }), track as usize, 1.0));
    (m.sources.len() - 1) as u32
}

/// An effect after a source: 0 filter (a type, b frequency, c Q, d gain, e stages), 1 vibrato
/// (a frequency, b depth), 2 chorus (a frequency, b delay ms, c depth, d spread, e wet),
/// 3 distortion (a amount, b oversampled, c wet), 4 compressor (a threshold, b knee, c ratio,
/// d attack, e release), 5 gain (a dB).
#[no_mangle]
pub extern "C" fn mix_fx(src: u32, kind: u32, a: f64, b: f64, c: f64, d: f64, e: f64) {
    let m = mix();
    let sr = m.sr;
    let fx = match kind {
        0 => Fx::Filter(Biquad::new(FilterType::from(a as u32), b, c, d, e as usize, sr)),
        1 => Fx::Vibrato(Vibrato::new(a, b, 0.005, sr)),
        2 => Fx::Chorus(Chorus::new(a, b, c, d, e, sr)),
        3 => Fx::Distortion(Box::new(Distortion::new(a, b != 0.0, c))),
        4 => Fx::Compressor(Box::new(Compressor::new(a, b, c, d, e, sr))),
        _ => Fx::Gain(db_to_gain(a)),
    };
    m.sources[src as usize].fx.push(fx);
}

/// Room for a sample's data (mono): returns where to copy it, then call `mix_sample_rate`.
#[no_mangle]
pub extern "C" fn mix_sample(id: u32, len: u32) -> *mut f32 {
    let m = mix();
    let id = id as usize;
    if m.samples.len() <= id {
        m.samples.resize_with(id + 1, || None);
    }
    m.samples[id] = Some(Sample { data: vec![0.0; len as usize], rate: 48000.0 });
    m.samples[id].as_mut().unwrap().data.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn mix_sample_rate(id: u32, rate: f64) {
    if let Some(Some(s)) = mix().samples.get_mut(id as usize) {
        s.rate = rate;
    }
}

#[no_mangle]
pub extern "C" fn mix_sample_drop(id: u32) {
    if let Some(s) = mix().samples.get_mut(id as usize) {
        *s = None;
    }
}

/// A fader, filter or send: curve 0 set, 1 linear, 2 exponential ramp over `ramp` seconds,
/// 3 approach with time constant `ramp`. Ids: 0 duck, 1 wash, 2 delay time, then each track's
/// volume and mute, then each source's gain.
#[no_mangle]
pub extern "C" fn mix_param(id: u32, frame: f64, curve: u32, value: f64, ramp: f64) {
    let m = mix();
    let frame = frame.max(0.0);
    if let Some(p) = m.param(id as usize) {
        p.add(Ev { frame, curve, value, ramp });
    }
}

/// A note on an instrument: kind 0 play (for `dur` frames), 1 start (held), 2 silence (release all).
/// A chord is one call per note with `first` set on the first: a monophonic synth's envelopes are
/// automation, so a new note cancels whatever was planned for it from its frame on (Tone's
/// cancelAndHoldAtTime), e.g. the release of a note it cuts short.
#[no_mangle]
pub extern "C" fn mix_note(src: u32, kind: u32, frame: f64, freq: f64, dur: f64, vel: f64, first: u32) {
    let m = mix();
    let src = src as usize;
    let poly = matches!(&m.sources[src].kind, Kind::Inst(i) if i.poly);
    if !poly && first != 0 {
        m.events.retain(|e| e.src != src || e.frame < frame || e.kind > SILENCE);
    }
    if kind == 2 {
        m.schedule(Event { frame, kind: SILENCE, src, a: 0.0, b: 0.0, token: 0 });
        return;
    }
    let token = m.token();
    m.schedule(Event { frame, kind: ATTACK, src, a: freq, b: vel, token });
    if kind == 0 {
        m.schedule(Event { frame: frame + dur.round().max(1.0), kind: RELEASE, src, a: 0.0, b: 0.0, token });
    }
}

/// A drum hit (`gain`), or with `fade` > 0 or < 0 a choke: every voice of that sample fades out.
#[no_mangle]
pub extern "C" fn mix_drum(src: u32, sample: u32, frame: f64, gain: f64, choke: f64) {
    let m = mix();
    let kind = if choke != 0.0 { CHOKE } else { DRUM };
    let a = if choke != 0.0 { choke.max(0.0) } else { gain };
    m.schedule(Event { frame, kind, src: src as usize, a, b: 0.0, token: sample });
}

/// A voice clip from `offset` seconds, fading out after `len` frames; `len` < 0 stops every clip.
#[no_mangle]
pub extern "C" fn mix_clip(src: u32, sample: u32, frame: f64, offset: f64, len: f64) {
    let m = mix();
    let src = src as usize;
    if len < 0.0 {
        m.schedule(Event { frame, kind: CLIP_STOP, src, a: 0.0, b: 0.0, token: 0 });
        return;
    }
    let token = m.token();
    m.schedule(Event { frame, kind: CLIP, src, a: offset, b: token as f64, token: sample });
    m.schedule(Event { frame: frame + len.round(), kind: CLIP_END, src, a: 0.0, b: 0.0, token });
}

/// Renders a block from `start`; returns where the master bus and the reverb send are (128 each).
#[no_mangle]
pub extern "C" fn mix_process(start: f64) -> *const f32 {
    let m = mix();
    m.process(start);
    m.out.as_ptr()
}

#[no_mangle]
pub extern "C" fn master_new(sr: f64, top: f64, out: f64) {
    unsafe {
        MASTER = Some(Box::new(Master {
            sr,
            hp: Biquad::new(FilterType::Highpass, 10.0, 1.0, 0.0, 2, sr),
            lp: Biquad::new(FilterType::Lowpass, top, 1.0, 0.0, 2, sr),
            comp: Box::new(Compressor::new(-24.0, 30.0, 12.0, 0.003, 0.25, sr)),
            limiter: Box::new(Compressor::new(-24.0, 30.0, 12.0, 0.003, 0.25, sr)),
            params: [Param::new(10.0), Param::new(top), Param::new(1.0), Param::new(1.0), Param::new(out)],
            input: [0.0; 3 * BLOCK],
            out: [0.0; 2 * BLOCK],
        }));
    }
}

/// The glue compressor (which 0) or the limiter (1).
#[no_mangle]
pub extern "C" fn master_compressor(which: u32, threshold: f64, knee: f64, ratio: f64, attack: f64, release: f64) {
    let m = master();
    let c = Box::new(Compressor::new(threshold, knee, ratio, attack, release, m.sr));
    if which == 0 {
        m.comp = c;
    } else {
        m.limiter = c;
    }
}

/// Ids: 0 highpass, 1 lowpass (Hz), 2 their Q, 3 dry, 4 output gain.
#[no_mangle]
pub extern "C" fn master_param(id: u32, frame: f64, curve: u32, value: f64, ramp: f64) {
    if let Some(p) = master().params.get_mut(id as usize) {
        p.add(Ev { frame: frame.max(0.0), curve, value, ramp });
    }
}

/// Where to copy the inputs: the master bus, then the reverb return's left and right (128 each).
#[no_mangle]
pub extern "C" fn master_input() -> *mut f32 {
    master().input.as_mut_ptr()
}

/// `rev`: how many reverb channels came in. Returns where the left and right output are.
#[no_mangle]
pub extern "C" fn master_process(start: f64, has_bus: u32, rev: u32) -> *const f32 {
    let m = master();
    m.process(start, has_bus != 0, rev);
    m.out.as_ptr()
}
