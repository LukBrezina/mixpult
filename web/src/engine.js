// Audio engine: mixer, effects and the step sequencer that plays the song object.
// The engine reads the song on every step, so edits are heard on the next pass of the loop.
// While a knob is touched, that track plays "live" from the knob instead of from the song.
import * as Tone from 'tone';
import { DrumKit, LAYERS, Mixer, SUB, VOICE_FX, instrument, layerSpec } from './sounds.js';
import { clips } from './voice.js';
import { TRACKS, LOOP, SLOT, activeNote } from './song.js';
import { DRUM_LANES, DRUM_GROOVES, layerLevel } from './patterns.js';
import { CHORDS, voiceChord, leadNote, bassNote } from './theory.js';

export const sliderToDb = (v) => (v <= 0.001 ? -Infinity : 40 * Math.log10(v));

// Equal-power crossfade over three layers: x = 0 → first, 0.5 → middle, 1 → last.
export function xfade(x) {
  return [0, 1, 2].map((i) => {
    const d = Math.abs(x * 2 - i);
    return d >= 1 ? 0 : Math.cos((d * Math.PI) / 2);
  });
}

// Off-beat hats a bit softer gives a natural groove for free.
function drumVelocity(lane, step) {
  if (lane === 'hat' || lane === 'openhat') return step % 4 === 0 ? 1 : step % 2 === 0 ? 0.78 : 0.6;
  return step % 4 === 0 ? 1 : 0.9;
}

const MELODIC = ['bass', 'lead'];
const LAYERED = ['chords', ...MELODIC];
const perTrack = (v) => Object.fromEntries(TRACKS.map((t) => [t, v]));
const CHORD_SLOT = SLOT.chords;
// XY "space": the send into the reverb at the top of the pad, and how far the dry mix steps back.
const WASH_SEND = 0.9;
const WASH_DUCK = 0.3;
// Reverb and delay sends per track.
const SENDS = { drums: [0.06, 0], chords: [0.3, 0.12], bass: [0, 0], lead: [0.3, 0.28], voice: [0.32, 0.2] };

export class Engine {
  constructor(song) {
    this.song = song;
    this.transport = Tone.getTransport();
    this.draw = Tone.getDraw();
    this.onStep = null; // UI callback(step), called in sync with the audio
    this.counter = 0;
    this.stutter = null;
    this.breakdown = false;
    this.live = perTrack(null); // { row, x } while a knob is touched
    this.punch = perTrack(false); // recording over the track: its old notes stay silent
    this.liveMidi = perTrack(null);
    this.lastStart = perTrack(0); // latest note start scheduled on each melodic track's synths
    this.sounding = perTrack(null); // the melodic note under way: { midi, until, vel }, for layerIn
    this.x = perTrack(null); // energy currently applied
    this.clipsSent = new Map(); // voice clips the worklet has: id -> AudioBuffer
    this.padDirty = true; // the pad must be (re)started at the next slot
    this.latency = 0; // extra user calibration, seconds
    this.top = Math.min(20000, Tone.getContext().sampleRate * 0.45); // the DJ lowpass when open

    // The whole mix runs in an AudioWorklet (see mix.worklet.js and sounds.js). Every track is a
    // mono channel with sends into one reverb and a dotted delay. Everything except drums goes
    // through the music bus, which ducks on every kick (sidechain pump); the delay returns there.
    // The master: the DJ filters, a glue compressor, a limiter and a soft clipper. The reverb
    // return comes in after the master bus, before the DJ filters, so the master can feed it too:
    // that is the XY pad's space, the whole mix thrown into the room, ringing on after letting go.
    this.mixer = new Mixer({
      tracks: TRACKS.map((id) => ({ id, bus: id === 'drums' ? 'master' : 'music', rev: SENDS[id][0], del: SENDS[id][1] })),
      drums: 'drums',
      voice: 'voice',
      voiceFx: VOICE_FX,
      delay: { time: this.transport.toSeconds('8n.'), feedback: 0.35, filter: { type: 'bandpass', frequency: 2000, Q: 0.5 } },
      reverbIn: { type: 'highpass', frequency: 300 },
      master: {
        top: this.top,
        reverb: { decay: 3.8, preDelay: 0.03 },
        comp: { threshold: -16, ratio: 2.5, attack: 0.015, release: 0.2, knee: 8 },
        limiter: { threshold: -1, ratio: 20, attack: 0.003, release: 0.01, knee: 30 }, // Tone.Limiter
        out: Tone.dbToGain(-1),
      },
    });
    this.tracks = {};
    for (const t of TRACKS) this.tracks[t] = {};
    this.drums = new DrumKit(this.mixer);
    for (const t of LAYERED) {
      // Each layer has its own fader in the worklet, opened by the knob (see setX).
      this.tracks[t].layers = LAYERS[t].map((id) => ({ inst: instrument(this.mixer, { ...layerSpec(t, id), track: t, gain: 0 }) }));
    }
    this.tracks.bass.sub = instrument(this.mixer, { ...SUB, track: 'bass' });
    for (const t of TRACKS) this.setX(t, song[t].x[0], 0);
    this.applyMix();

    this.transport.scheduleRepeat((time) => this.tick(time), '16n', 0);
  }

  get ready() {
    this.mixerReady ??= this.mixer.ready();
    return Promise.all([this.drums.ready, this.mixerReady]);
  }

  // ---------- song / mixer ----------

  setSong(song) {
    this.song = song;
    this.applyMix();
    this.retriggerPad();
  }

  // Bring the mixer in line with the song after an op. Only mixer ops touch the mixer: a
  // recording sends an op every step, and fresh volume ramps on every channel each time kept
  // the audio thread busy enough that a phone broke up while recording.
  sync(op) {
    if (['bpm', 'vol', 'mute'].includes(op.k)) this.applyMix();
    if (op.k === 'slot' && op.t === 'chords') this.retriggerPad();
  }

  applyMix() {
    const now = Tone.now();
    if (Math.round(this.transport.bpm.value) !== this.song.bpm) {
      this.transport.bpm.value = this.song.bpm;
      // The delay was set in note values: keep it on the beat at the new tempo.
      this.mixer.param('delayTime', this.transport.toSeconds('8n.'), now, 0.1);
    }
    for (const t of TRACKS) {
      this.mixer.param('vol.' + t, Tone.dbToGain(sliderToDb(this.song.vol[t])), now, 0.05);
      this.mixer.param('mute.' + t, this.song.mute[t] ? 0 : 1, now, 0.005);
    }
  }

  audible(track) {
    return !this.song.mute[track];
  }

  // Left/right energy: crossfades the three layers of a track (drums use it per hit).
  setX(t, x, time) {
    const was = this.x[t];
    if (was !== null && Math.abs(x - was) < 0.004) return;
    this.x[t] = x;
    if (!this.tracks[t].layers) return; // drums use it per hit, voice not at all
    const before = was === null ? null : xfade(was);
    xfade(x).forEach((g, i) => {
      this.mixer.param('gain.' + this.tracks[t].layers[i].inst.index, g, time, 0.025, 'target');
      if (before && before[i] === 0 && g > 0) this.layerIn(t, i, time);
    });
  }

  // Only the layers the knob lets through play notes: at most two of three are ever audible, and
  // synths playing into a closed fader would cost a phone's CPU for nothing.
  heardLayers(t) {
    const g = xfade(this.x[t]);
    return this.tracks[t].layers.filter((_, i) => g[i] > 0);
  }

  // A layer fades in while its track sounds: it joins the note (or pad chord) under way.
  layerIn(t, i, time) {
    if (!this.audible(t) || this.stutter) return;
    const { inst } = this.tracks[t].layers[i];
    if (t === 'chords') {
      if (i !== 0) return; // stabs and arpeggio play on the next step anyway
      if (this.live.chords) inst.start(voiceChord(CHORDS[this.live.chords.row]), time, 0.7);
      else if (this.playing) {
        const pos = (this.transport.getTicksAtTime(time) / (this.transport.PPQ / 4)) % LOOP;
        const left = (CHORD_SLOT - (pos % CHORD_SLOT)) * this.stepSeconds() - 0.03;
        if (left > 0.08) inst.play(voiceChord(this.chordAt(Math.floor(pos))), time, left, 0.7);
        this.padDirty = true; // the next slot starts it properly
      }
      return;
    }
    const n = this.sounding[t];
    // Never before the track's latest start: a mono synth refuses that (see liveTime).
    const at = Math.max(time, this.lastStart[t] + 0.003);
    if (!n || n.until < at + 0.05) return;
    if (n.until === Infinity) inst.start(n.midi, at, n.vel);
    else inst.play(n.midi, at, n.until - at, n.vel);
    this.noteStarted(t, at);
  }

  // XY pad. x: -1 = lowpass down, 0 = off, +1 = highpass up. y: 0..1 space (plus a little
  // resonance, so a sweep up there sings), with the dry mix stepping back as the hall grows.
  setXY(x, y) {
    const lp = x < 0 ? this.top * Math.pow(160 / this.top, -x) : this.top;
    const hp = x > 0 ? 20 * Math.pow(6000 / 20, x) : 10;
    const q = 0.8 + y * 3;
    const now = Tone.now();
    this.mixer.param('lp', lp, now, 0.04, 'exp');
    this.mixer.param('hp', hp, now, 0.04, 'exp');
    this.mixer.param('q', q, now, 0.04);
    this.mixer.param('wash', WASH_SEND * Math.sqrt(y), now, 0.06);
    this.mixer.param('dry', 1 - WASH_DUCK * y, now, 0.06);
  }

  // Beat repeat, like a DJ loop roll: while held, the first `len` steps of the current beat play
  // over and over, locked to the grid. The song runs on underneath, and letting go waits for the
  // next beat, so the way back always lands on a kick, right where the song has got to.
  setStutter(len) {
    const st = this.stutter;
    if (len && st) Object.assign(st, { len, release: false });
    else if (len) {
      this.stutter = { len, anchor: null, release: false };
      this.tracks.chords.layers[0].inst.silence(Tone.immediate()); // the long pad gives way to the repeats
    } else if (st) {
      if (this.playing) st.release = true;
      else this.stutter = null;
    }
  }

  setBreakdown(on) {
    this.breakdown = on;
    if (on) this.silenceTrack('bass', Tone.now());
  }

  // ---------- transport ----------

  // Own flag: transport.state still says "stopped" during the short scheduled start delay.
  get playing() {
    return this._playing === true;
  }

  async start() {
    await Tone.start();
    if (this.playing) return;
    this.counter = 0;
    this.padDirty = true;
    this.transport.position = 0;
    this.transport.start('+0.06');
    this._playing = true;
  }

  stop() {
    this._playing = false;
    this.transport.stop();
    const now = Tone.now();
    for (const t of LAYERED) this.silenceTrack(t, now);
    this.stopClips(now);
    this.liveMidi = perTrack(null);
    this.draw.cancel();
    this.onStep?.(-1);
  }

  // Silences everything at the very end, reverb and delay tails too (while the mic records).
  hush(on) {
    this.mixer.param('out', Tone.dbToGain(on ? -80 : -1), Tone.now(), on ? 0.12 : 0.05, 'exp');
  }

  stepSeconds() {
    return this.transport.toSeconds('16n');
  }

  // Loop step the listener hears right now (fractional, counting up from the start, not wrapped).
  heardStepFloat() {
    const ctx = Tone.getContext().rawContext;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + this.latency;
    // Never before 0: Tone throws for a time ahead of its first state (just after the context starts).
    const ticks = this.transport.getTicksAtTime(Math.max(0, Tone.immediate() - lat));
    return Math.max(0, ticks / (this.transport.PPQ / 4));
  }

  heardStep() {
    return this.playing ? Math.floor(this.heardStepFloat()) % LOOP : 0;
  }

  chordIndexAt(step) {
    if (this.live.chords) return this.live.chords.row;
    return this.song.chords.slots[Math.floor((((step % LOOP) + LOOP) % LOOP) / CHORD_SLOT)];
  }

  chordAt(step) {
    return CHORDS[this.chordIndexAt(step)];
  }

  noteFor(track, row, step) {
    const chord = this.chordAt(step);
    return track === 'bass' ? bassNote(chord, row) : leadNote(chord, row);
  }

  // ---------- sequencer ----------

  tick(time) {
    let step = this.counter % LOOP;
    this.counter++;
    let st = this.stutter;
    const resume = st?.release && step % 4 === 0;
    if (resume) this.stutter = st = null;
    let sliceStart = false;
    let sliceLen = 0;
    if (st) {
      // From the start of the beat, where the kick is, so the repeat always has a punch. The first
      // slice may start off the grid (a press between the 16ths), the rest are on it.
      const first = st.anchor === null;
      if (first) st.anchor = step - (step % 4);
      const k = step % st.len;
      sliceStart = first || k === 0;
      sliceLen = st.len - k;
      step = st.anchor + k;
    }

    for (const t of TRACKS) this.setX(t, this.live[t]?.x ?? this.song[t].x[step], time);
    if (!this.breakdown) this.tickDrums(step, time);
    if (st) {
      if (sliceStart) this.tickRepeat(step, time, sliceLen * this.stepSeconds());
    } else {
      if (resume) this.resumePad(step, time);
      this.tickChords(step, time);
      if (!this.breakdown) this.tickMelodic('bass', step, time, resume);
      this.tickMelodic('lead', step, time, resume);
      this.tickVoice(step, time, resume);
    }

    // A live note held across a chord change follows the new chord.
    if (step % CHORD_SLOT === 0) {
      for (const t of MELODIC) {
        if (!this.live[t] || this.liveMidi[t] === null) continue;
        const midi = this.noteFor(t, this.live[t].row, step);
        if (midi !== this.liveMidi[t]) {
          this.liveMidi[t] = midi;
          this.startNote(t, midi, time);
        }
      }
    }

    if (this.onStep) this.draw.schedule(() => this.onStep(step), time);
  }

  duck(time) {
    this.mixer.param('duck', 0.6, time);
    this.mixer.param('duck', 1, time + 0.015, 0.07, 'target');
  }

  tickDrums(step, time) {
    if (!this.audible('drums')) return;
    const groove = DRUM_GROOVES[this.live.drums?.row ?? this.song.drums.slots[Math.floor(step / SLOT.drums)]];
    const s = step % 16;
    if (groove.kick[s]) this.duck(time);
    for (const lane of DRUM_LANES) {
      if (!groove[lane.id][s]) continue;
      const level = layerLevel(lane.layer, this.x.drums);
      if (level > 0.02) this.drums.play(lane.id, time, drumVelocity(lane.id, s) * level);
    }
  }

  tickChords(step, time) {
    if (!this.audible('chords')) return;
    const c = this.chordIndexAt(step);
    const notes = voiceChord(CHORDS[c]);
    const [pad, stab, arp] = this.tracks.chords.layers;
    const g = xfade(this.x.chords);
    const sd = this.stepSeconds();
    const s = step % 16;

    // Pad: one long chord for as long as it stays the same within the bar. Faded out, it is skipped;
    // sliding left brings it in through layerIn. The live chord is held by setLive instead.
    if (!this.live.chords && s % CHORD_SLOT === 0 && (s === 0 || this.padDirty || this.chordIndexAt(step - 1) !== c)) {
      let run = CHORD_SLOT;
      while (s + run < 16 && this.chordIndexAt(step + run) === c) run += CHORD_SLOT;
      if (g[0] > 0) pad.inst.play(notes, time, run * sd - 0.03, 0.7);
      this.padDirty = false;
    }
    // Stabs on the off-beat (the kick owns the beat), arpeggio on every 16th.
    if (g[1] > 0.01 && s % 4 === 2) stab.inst.play(notes, time, 1.2 * sd, s === 14 ? 0.85 : 0.75);
    if (g[2] > 0.01) {
      const up = [notes[0], notes[1], notes[2], notes[0] + 12];
      arp.inst.play([up[s % 4]], time, sd * 0.9, s % 4 === 0 ? 0.75 : 0.6);
    }
  }

  // `resume`: back from a beat repeat, so a note that began earlier comes back for the rest of it.
  tickMelodic(track, step, time, resume = false) {
    if (!this.audible(track) || this.live[track] || this.punch[track]) return;
    const notes = this.song[track].notes;
    let start = step;
    let n = notes[step];
    // A long note crossing into a new chord is re-pitched to it, so it never clashes.
    if (!n && (resume || step % CHORD_SLOT === 0)) {
      const act = activeNote(notes, step);
      if (act) {
        start = act.start;
        n = act.note;
      }
    }
    if (!n) return;
    let dist = 1;
    while (step + dist < LOOP && !notes[step + dist]) dist++;
    const len = Math.min(start + n.len - step, dist, CHORD_SLOT - (step % CHORD_SLOT));
    // Mono synths: end just before the next note, otherwise its release cuts the next one.
    const dur = len * this.stepSeconds() - (len >= dist ? 0.008 : 0);
    const vel = step % 4 === 0 ? 0.95 : 0.8;
    const midi = this.noteFor(track, n.row, step);
    for (const l of this.heardLayers(track)) l.inst.play(midi, time, dur, vel);
    this.tracks[track].sub?.play(midi, time, dur, vel);
    this.noteStarted(track, time);
    this.sounding[track] = { midi, until: time + dur, vel };
  }

  // One beat-repeat slice: everything that sounds at `step` starts again, whether its note began
  // there or earlier (otherwise a repeat of the middle of a long note is silence).
  tickRepeat(step, time, dur) {
    const len = dur * 0.9;
    if (this.audible('chords') && !this.live.chords) {
      const notes = voiceChord(this.chordAt(step));
      for (const l of this.heardLayers('chords')) l.inst.play(notes, time, len, 0.7);
    }
    for (const t of MELODIC) {
      if (!this.audible(t) || this.live[t] || this.punch[t] || (t === 'bass' && this.breakdown)) continue;
      const act = activeNote(this.song[t].notes, step);
      if (!act) continue;
      const midi = this.noteFor(t, act.note.row, step);
      for (const l of this.heardLayers(t)) l.inst.play(midi, time, len, 0.9);
      this.tracks[t].sub?.play(midi, time, len, 0.9);
      this.noteStarted(t, time);
      this.sounding[t] = { midi, until: time + len, vel: 0.9 };
    }
    const v = activeNote(this.song.voice.notes, step);
    if (v && this.audible('voice') && !this.live.voice && !this.punch.voice) {
      this.playClip(v.note.row, time, dur, (step - v.start) * this.stepSeconds());
    }
    this.padDirty = true;
  }

  // Voice pads in the loop: a note plays its pad's clip for as long as the pad was held.
  tickVoice(step, time, resume = false) {
    if (!this.audible('voice') || this.live.voice || this.punch.voice) return;
    const notes = this.song.voice.notes;
    const act = notes[step] ? { start: step, note: notes[step] } : resume && activeNote(notes, step);
    if (!act) return;
    let dist = 1;
    while (step + dist < LOOP && !notes[step + dist]) dist++;
    const sd = this.stepSeconds();
    this.playClip(act.note.row, time, Math.min(act.start + act.note.len - step, dist) * sd, (step - act.start) * sd);
  }

  // One clip at a time, like chopping on a launchpad: a new one cuts the last.
  playClip(pad, time, dur = Infinity, offset = 0) {
    const id = this.song.voice.pads[pad];
    const buf = clips.get(id);
    this.stopClips(time);
    if (!buf || offset >= buf.duration) return;
    this.sendClip(id, buf);
    this.mixer.send({ t: 'clip', id: 'clip:' + id, time, offset, len: Math.min(dur, buf.duration - offset) });
  }

  // The worklet gets a clip the first time it plays (and lets go of clips no longer on the pads).
  sendClip(id, buf) {
    if (this.clipsSent.get(id) === buf) return;
    const pads = new Set(this.song.voice.pads);
    const drop = [...this.clipsSent.keys()].filter((k) => !pads.has(k));
    for (const k of drop) this.clipsSent.delete(k);
    this.clipsSent.set(id, buf);
    const data = buf.getChannelData(0).slice();
    this.mixer.send({ t: 'sample', id: 'clip:' + id, data, rate: buf.sampleRate, drop: drop.map((k) => 'clip:' + k) }, [data.buffer]);
  }

  stopClips(time) {
    this.mixer.send({ t: 'clipStop', time });
  }

  startNote(track, midi, time, vel = 0.9) {
    for (const l of this.heardLayers(track)) l.inst.start(midi, time, vel);
    this.tracks[track].sub?.start(midi, time, vel);
    this.noteStarted(track, time);
    this.sounding[track] = { midi, until: Infinity, vel };
  }

  // Tone moves a start that is already in the past (a late tick) to the current time.
  noteStarted(track, time) {
    this.lastStart[track] = Math.max(this.lastStart[track], time, Tone.immediate());
  }

  // A live note starts now, but the sequencer schedules a little ahead of the clock, and a mono
  // synth refuses a start before one it already has (the note would be lost). So never earlier
  // than just after the last scheduled start: at most a few milliseconds late.
  liveTime(track) {
    return Math.max(Tone.immediate(), this.lastStart[track] + 0.003);
  }

  silenceTrack(track, time) {
    for (const l of this.tracks[track].layers) l.inst.silence(time);
    this.tracks[track].sub?.silence(time);
    if (track in this.sounding) this.sounding[track] = null;
  }

  // ---------- live (knob touched) ----------

  // Recording replaces what a track had: while record is held its old notes stay silent, so you
  // only hear what you play (main.js erases them as the loop passes).
  setPunch(t, on) {
    if (this.punch[t] === on) return;
    this.punch[t] = on;
    if (!on || this.live[t]) return;
    // Also cuts a note the sequencer has already scheduled a moment ahead.
    if (t === 'voice') this.stopClips(Tone.immediate());
    else this.silenceTrack(t, this.liveTime(t));
  }

  // The track follows the knob right now: { row, x }. Row is the groove (drums), the chord index
  // (chords), the pitch row (bass, lead) or the pad (voice, which (re)starts its clip on every call).
  setLive(t, v) {
    const prev = this.live[t];
    this.live[t] = v;
    const now = Tone.immediate();
    this.setX(t, v.x, now);
    if (t === 'voice') this.playClip(v.row, now);
    else if (t === 'chords') {
      if (prev?.row !== v.row) {
        const pad = this.tracks.chords.layers[0].inst;
        pad.silence(now);
        if (xfade(v.x)[0] > 0) pad.start(voiceChord(CHORDS[v.row]), now + 0.005, 0.7);
      }
    } else if (t !== 'drums') {
      const midi = this.noteFor(t, v.row, this.heardStep());
      if (!prev || midi !== this.liveMidi[t]) {
        this.liveMidi[t] = midi;
        this.startNote(t, midi, this.liveTime(t));
      }
    }
  }

  clearLive(t) {
    if (!this.live[t]) return;
    this.live[t] = null;
    const now = Tone.immediate();
    if (t === 'voice') this.stopClips(now);
    else if (t === 'chords') this.retriggerPad();
    else if (t !== 'drums') {
      this.silenceTrack(t, now);
      this.liveMidi[t] = null;
    }
  }

  // Back from a beat repeat in the middle of a chord slot: the pad plays the rest of it.
  resumePad(step, time) {
    if (this.live.chords || !this.audible('chords') || step % CHORD_SLOT === 0 || xfade(this.x.chords)[0] === 0) return;
    const left = (CHORD_SLOT - (step % CHORD_SLOT)) * this.stepSeconds() - 0.03;
    this.tracks.chords.layers[0].inst.play(voiceChord(this.chordAt(step)), time, left, 0.7);
  }

  // Plays the song's chord for the rest of the current slot, e.g. after a live chord or an edit.
  retriggerPad() {
    if (this.live.chords) return;
    const pad = this.tracks.chords.layers[0].inst;
    const now = Tone.immediate();
    pad.silence(now);
    this.padDirty = true;
    if (!this.playing || !this.audible('chords') || xfade(this.x.chords)[0] === 0) return;
    const pos = this.heardStepFloat() % LOOP;
    const slot = Math.floor(pos / CHORD_SLOT);
    const left = ((slot + 1) * CHORD_SLOT - pos) * this.stepSeconds() - 0.03;
    if (left > 0.08) pad.play(voiceChord(CHORDS[this.song.chords.slots[slot]]), now + 0.005, left, 0.7);
  }
}

// ---------- export ----------

// Renders the song offline (faster than real time, sample exact) and returns a 16-bit WAV blob.
export async function renderWav(song, loops = 1, tail = 3) {
  const copy = JSON.parse(JSON.stringify(song));
  const loopSec = (LOOP * 60) / song.bpm / 4;
  const buf = await Tone.Offline(async ({ transport }) => {
    const e = new Engine(copy);
    await e.ready;
    transport.start(0);
    transport.stop(loopSec * loops);
  }, loopSec * loops + tail, 2, 44100);
  return encodeWav(buf.get());
}

function encodeWav(ab) {
  const chs = ab.numberOfChannels;
  const n = ab.length;
  const view = new DataView(new ArrayBuffer(44 + n * chs * 2));
  const str = (o, t) => [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * chs * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, chs, true);
  view.setUint32(24, ab.sampleRate, true);
  view.setUint32(28, ab.sampleRate * chs * 2, true);
  view.setUint16(32, chs * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * chs * 2, true);
  const data = [...Array(chs)].map((_, c) => ab.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < chs; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}
