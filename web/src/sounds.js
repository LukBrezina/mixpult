// Instruments, all tuned for a catchy night techno sound. Every instrument has the same small
// interface (play / start / silence). Each melodic track has three layers that the knob's
// left/right position crossfades between, like a DJ blending sounds. All of it plays in an
// AudioWorklet (mix.worklet.js): the instruments and effects are specs here, and the Mixer starts
// the worklet with them and passes notes and fader moves on to it.
import * as Tone from 'tone';
import { midiToFreq } from './theory.js';
import { DRUM_LANES } from './patterns.js';
import mixWorkletUrl from './mix.worklet.js?url';
import dspUrl from './dsp.wasm?url';

const BASE = (import.meta.env?.BASE_URL ?? '/') + 'samples/';

// Left → right on the knob: calm → hard.
export const LAYERS = {
  chords: ['pad', 'stab', 'arp'],
  bass: ['deep', 'banger', 'acid'],
  lead: ['glass', 'bleep', 'laser'],
};

// ---------- the mixer: one AudioWorklet for the whole mix (see mix.worklet.js) ----------

const loaded = new WeakMap(); // raw context -> addModule promise
function loadMixModule(raw) {
  // Not Tone's addAudioWorkletModule: Tone keeps one module per context, and the mic uses that.
  if (!loaded.has(raw)) loaded.set(raw, raw.audioWorklet.addModule(mixWorkletUrl));
  return loaded.get(raw);
}

// The DSP itself, WebAssembly compiled from dsp/src/lib.rs (npm run dsp). Each processor compiles
// its own copy from these bytes.
let dspBytes;
const loadDsp = () =>
  (dspBytes ??= fetch(dspUrl).then((r) => {
    if (!r.ok) throw new Error(`DSP failed to load (${r.status})`);
    return r.arrayBuffer();
  }));

// The master chain's parameters live in the second processor.
const MASTER_PARAMS = new Set(['hp', 'lp', 'q', 'dry', 'out']);

// Collects the instruments while the engine builds its mix, then starts the worklet with all of
// them and the layout (ready). Messages sent before it runs wait in a queue.
export class Mixer {
  constructor(layout) {
    this.context = Tone.getContext();
    this.layout = layout;
    this.instruments = [];
    this.queue = [];
    this.node = null;
    this.master = null;
  }

  add(spec) {
    this.instruments.push(spec);
    return this.instruments.length - 1;
  }

  send(msg, transfer = []) {
    if (this.node) this.node.port.postMessage(msg, transfer);
    else this.queue.push([msg, transfer]);
  }

  // A fader, filter or send at `time`: set (no ramp), or moved over `ramp` seconds along a
  // 'linear' or 'exp' ramp, or approaching with time constant `ramp` ('target').
  param(p, v, time, ramp = 0, curve = 'linear') {
    const msg = { t: 'param', p, v, time, ramp, curve };
    if (!MASTER_PARAMS.has(p)) this.send(msg);
    else if (this.master) this.master.port.postMessage(msg);
    else this.queue.push([msg, [], true]);
  }

  async ready() {
    const ctx = this.context;
    const raw = ctx.rawContext;
    const [wasm] = await Promise.all([loadDsp(), loadMixModule(raw)]);
    // The live context is native (see main.js); offline renders run on Tone's wrapped context.
    const make = (name, options) =>
      raw instanceof BaseAudioContext ? new AudioWorkletNode(raw, name, options) : ctx.createAudioWorkletNode(name, options);
    const { master, ...mix } = this.layout;
    this.node = make('mixpult-mix', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
      processorOptions: { ...mix, instruments: this.instruments, wasm },
    });
    this.master = make('mixpult-master', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ...master, wasm },
    });
    // One reverb for everything, a native convolver: most of its work happens off the audio thread.
    const reverb = (this.reverb = ctx.createConvolver());
    reverb.buffer = reverbImpulse(ctx, master.reverb);
    this.node.connect(this.master, 0, 0);
    this.node.connect(reverb, 1, 0);
    reverb.connect(this.master, 0, 1);
    Tone.connect(this.master, Tone.getDestination());
    for (const [msg, transfer, toMaster] of this.queue) (toMaster ? this.master : this.node).port.postMessage(msg, transfer);
    this.queue = [];
  }
}

// Tone.Reverb's room: white noise that swells in after the pre-delay and decays exponentially
// (Tone's exponentialApproachValueAtTime: a time constant for 90 % of the decay, then linear).
function reverbImpulse(ctx, { decay, preDelay }) {
  const rate = ctx.sampleRate;
  const n = Math.round((decay + preDelay) * rate);
  const ir = ctx.createBuffer(2, n, rate);
  const tc = Math.log(decay + 1) / Math.log(200);
  const hold = preDelay + 0.9 * decay;
  const atHold = Math.exp(-(0.9 * decay) / tc);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const g = t < preDelay ? 0 : t < hold ? Math.exp(-(t - preDelay) / tc) : atHold * (1 - (t - hold) / (0.1 * decay));
      d[i] = (Math.random() * 2 - 1) * g;
    }
  }
  return ir;
}

// An instrument in the mix: notes go to its synth in the worklet.
export function instrument(mixer, spec) {
  const index = mixer.add(spec);
  const freqs = (m) => (Array.isArray(m) ? m : [m]).map(midiToFreq);
  return {
    index,
    play(midi, time, dur, vel) {
      mixer.send({ t: 'play', i: index, f: freqs(midi), time, dur, vel });
    },
    start(midi, time, vel = spec.maxPolyphony ? 0.8 : 0.85) {
      mixer.send({ t: 'start', i: index, f: freqs(midi), time, vel });
    },
    silence(time) {
      mixer.send({ t: 'silence', i: index, time });
    },
  };
}

// ---------- drums ----------

const KIT = 'tr909';
const KIT_TRIM = 1.5;
const LANE_GAIN = { kick: 1, snare: 0.75, clap: 0.65, hat: 0.4, openhat: 0.4, tom: 0.6 };

export class DrumKit {
  constructor(mixer) {
    this.mixer = mixer;
    // Sub thump under every kick: deep modern low end (a MembraneSynth at -9 dB in the kick lane).
    this.sub = instrument(mixer, {
      track: 'drums',
      pitchDecay: 0.045,
      octaves: 4,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.05 },
      volume: -9 + Tone.gainToDb(LANE_GAIN.kick * KIT_TRIM),
    });

    const urls = Object.fromEntries(DRUM_LANES.map((l) => [l.id, `${BASE}${KIT}/${l.id}.wav`]));
    this.loading = new Promise((resolve, reject) => {
      this.buffers = new Tone.ToneAudioBuffers({ urls, onload: resolve, onerror: reject });
    })
      .then(() => Promise.all(['snare', 'clap'].map((lane) => this.bakeGateVerb(lane))))
      .then(() => {
        for (const lane of DRUM_LANES) this.upload(lane.id);
        this.loaded = true;
      })
      .catch((err) => console.warn('Drums failed to load', err));
  }

  // The worklet gets each sample as one mono channel: the track sums to mono anyway.
  upload(lane) {
    const buf = this.buffers.get(lane).get();
    const data = buf.getChannelData(0).slice();
    if (buf.numberOfChannels > 1) {
      const right = buf.getChannelData(1);
      for (let i = 0; i < data.length; i++) data[i] = (data[i] + right[i]) / 2;
    }
    this.mixer.send({ t: 'sample', id: lane, data, rate: buf.sampleRate }, [data.buffer]);
  }

  // Gated reverb on snare and clap: a big room that is cut off abruptly. It is rendered into the
  // samples once at load: a convolver running live was enough to tip a phone's audio over.
  async bakeGateVerb(lane, send = 0.45) {
    const dry = this.buffers.get(lane).get();
    const ir = gatedImpulse(dry.sampleRate);
    const ctx = new OfflineAudioContext(2, dry.length + ir.length, dry.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = dry;
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = send;
    src.connect(ctx.destination);
    src.connect(verb).connect(wet).connect(ctx.destination);
    src.start();
    this.buffers.add(lane, await ctx.startRendering());
  }

  get ready() {
    return this.loading;
  }

  play(lane, time, velocity = 1) {
    if (!this.loaded) return;
    // A closed hat cuts the open one off, like on the real machines.
    if (lane === 'hat') this.mixer.send({ t: 'choke', id: 'openhat', time, fade: 0.04 });
    this.mixer.send({ t: 'drum', id: lane, time, gain: velocity * LANE_GAIN[lane] * KIT_TRIM });
    if (lane === 'kick') this.sub.play(33, time, 0.3, velocity); // A1
  }
}

// A gated room: dense noise, a quick swell, a slow sag, then a hard cut after `secs`. Softened
// above about 6 kHz like real walls, a different noise per side for width.
function gatedImpulse(rate, secs = 0.32) {
  const n = Math.round(secs * rate);
  const ir = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: rate });
  const attack = 0.006 * rate;
  const fade = 0.02 * rate;
  const smooth = Math.exp((-2 * Math.PI * 6000) / rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp = (1 - smooth) * (Math.random() * 2 - 1) + smooth * lp;
      const env = Math.min(1, i / attack) * (1 - 0.45 * (i / n)) * Math.min(1, (n - i) / fade);
      d[i] = lp * env;
    }
  }
  return ir;
}

// ---------- effects, as specs for the worklet ----------

// Web Audio's BiquadFilter; -24 dB per octave is two in a row (as in Tone.Filter, same Q on both).
export const filter = (type, frequency, { Q = 1, gain = 0, rolloff = -12 } = {}) => ({ fx: 'filter', type, frequency, Q, gain, rolloff });
const vibrato = (frequency, depth) => ({ fx: 'vibrato', frequency, depth });
const chorus = (opts) => ({ fx: 'chorus', ...opts });
const distortion = (amount, wet = 1) => ({ fx: 'distortion', distortion: amount, oversample: '2x', wet });

// Vocal chain in the Fred again.. spirit: cleaned up, squashed, bright and airy, a bit of grit and
// width. The space (reverb, dotted delay) and the pump on every kick come from the mix.
export const VOICE_FX = [
  filter('highpass', 120, { rolloff: -24 }),
  filter('peaking', 320, { Q: 1, gain: -3 }), // less boxy
  { fx: 'compressor', threshold: -28, ratio: 5, knee: 8, attack: 0.003, release: 0.1 },
  filter('peaking', 3200, { Q: 0.8, gain: 3 }), // presence
  filter('highshelf', 9000, { gain: 5 }), // air
  distortion(0.12, 0.35),
  chorus({ frequency: 0.7, delayTime: 5, depth: 0.3, spread: 180, wet: 0.22 }),
  { fx: 'gain', db: 2 },
];

// ---------- synths ----------

// Specs read like Tone options: Synth (oscillator + envelope), MonoSynth (+ filter and
// filterEnvelope), FMSynth (kind 'fm'); maxPolyphony makes it a PolySynth of those. `fx` are the
// effects after it.
export function layerSpec(track, id) {
  if (track === 'chords') return chordsSpec(id);
  if (track === 'bass') return bassTopSpec(id);
  return leadSpec(id);
}

function chordsSpec(id) {
  if (id === 'stab') {
    // Short, bright chord hit with a snappy filter: the classic techno stab.
    return {
      maxPolyphony: 24,
      volume: 1,
      oscillator: { type: 'fatsawtooth', count: 2, spread: 14 },
      filter: { type: 'lowpass', rolloff: -24, Q: 2.5 },
      envelope: { attack: 0.002, decay: 0.22, sustain: 0.25, release: 0.18 },
      filterEnvelope: { attack: 0.001, decay: 0.16, sustain: 0.15, release: 0.2, baseFrequency: 420, octaves: 3.6 },
      fx: [filter('highpass', 180)],
    };
  }
  if (id === 'arp') {
    // Drawbar-ish organ played as a fast arpeggio: a few sine partials, instant on and off.
    return {
      maxPolyphony: 16,
      volume: -8.5,
      oscillator: { type: 'custom', partials: [1, 0.7, 0.45, 0.3, 0, 0.2, 0, 0.12] },
      envelope: { attack: 0.004, decay: 0.1, sustain: 0.9, release: 0.06 },
      fx: [vibrato(6.2, 0.04)],
    };
  }
  // pad: wide detuned saws, chorus.
  return {
    maxPolyphony: 16,
    volume: -5,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
    envelope: { attack: 0.03, decay: 0.5, sustain: 0.75, release: 0.9 },
    fx: [filter('lowpass', 2600, { rolloff: -24, Q: 0.6 }), chorus({ frequency: 0.5, delayTime: 3.5, depth: 0.7, wet: 0.5 })],
  };
}

// The deep part of every bass: one clean sine sub, always there whatever the knob says.
export const SUB = {
  oscillator: { type: 'sine' },
  envelope: { attack: 0.004, decay: 0.3, sustain: 0.8, release: 0.1 },
  volume: -6,
};

// The crisp part: a distorted, high-passed top layer over the sub.
function bassTopSpec(id) {
  const { drive, ...spec } = {
    deep: {
      oscillator: { type: 'sawtooth' },
      filter: { type: 'lowpass', rolloff: -24, Q: 1 },
      envelope: { attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.1 },
      filterEnvelope: { attack: 0.004, decay: 0.25, sustain: 0.3, release: 0.1, baseFrequency: 160, octaves: 2 },
      drive: 0.15,
      volume: -4,
    },
    banger: {
      oscillator: { type: 'sawtooth' },
      filter: { type: 'lowpass', rolloff: -24, Q: 3 },
      envelope: { attack: 0.003, decay: 0.25, sustain: 0.55, release: 0.08 },
      filterEnvelope: { attack: 0.002, decay: 0.18, sustain: 0.3, release: 0.1, baseFrequency: 320, octaves: 3.4 },
      drive: 0.6,
      volume: -5,
    },
    acid: {
      // 303-style: resonant filter that squelches on every note, plus a little slide.
      portamento: 0.035,
      oscillator: { type: 'sawtooth' },
      filter: { type: 'lowpass', rolloff: -24, Q: 9 },
      envelope: { attack: 0.002, decay: 0.2, sustain: 0.4, release: 0.05 },
      filterEnvelope: { attack: 0.001, decay: 0.17, sustain: 0.1, release: 0.08, baseFrequency: 210, octaves: 4.2, exponent: 2 },
      drive: 0.5,
      volume: -6,
    },
  }[id];
  return { ...spec, fx: [distortion(drive), filter('highpass', 140, { rolloff: -24 })] };
}

function leadSpec(id) {
  if (id === 'glass') {
    return {
      kind: 'fm',
      volume: 2,
      harmonicity: 3.01,
      modulationIndex: 9,
      envelope: { attack: 0.002, decay: 1.2, sustain: 0.15, release: 1.2 },
      modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0.1, release: 0.6 },
    };
  }
  if (id === 'bleep') {
    return {
      volume: -10,
      portamento: 0.012,
      oscillator: { type: 'square' },
      filter: { type: 'lowpass', rolloff: -12, Q: 2 },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0.55, release: 0.07 },
      filterEnvelope: { attack: 0.001, decay: 0.09, sustain: 0.5, release: 0.1, baseFrequency: 1500, octaves: 2.4 },
    };
  }
  // laser: detuned supersaw with a touch of vibrato.
  return {
    volume: -4,
    portamento: 0.02,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
    filter: { type: 'lowpass', rolloff: -24, Q: 1.5 },
    envelope: { attack: 0.008, decay: 0.25, sustain: 0.7, release: 0.3 },
    filterEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.45, release: 0.3, baseFrequency: 900, octaves: 3 },
    fx: [vibrato(5, 0.03)],
  };
}
