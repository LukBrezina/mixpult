// Instrument presets. Every instrument exposes the same small interface so the engine
// does not care whether it is a sampler, a poly synth or a mono synth.
import * as Tone from 'tone';
import { midiToFreq } from './theory.js';
import { DRUM_LANES } from './song.js';

const BASE = (import.meta.env?.BASE_URL ?? '/') + 'samples/';

export const SOUNDS = {
  drums: [
    { id: 'tr909', name: 'TR-909', hint: 'house, techno' },
    { id: 'tr808', name: 'TR-808', hint: 'hip-hop, trap' },
    { id: 'linn', name: 'LinnDrum', hint: '80s pop' },
    { id: 'mpc60', name: 'MPC60', hint: 'boom bap' },
  ],
  chords: [
    { id: 'piano', name: 'Piano', hint: 'opravdové piano' },
    { id: 'epiano', name: 'Elektrické piano', hint: 'lo-fi, soul' },
    { id: 'pad', name: 'Pad', hint: 'měkký koberec' },
    { id: 'stab', name: 'Supersaw', hint: 'taneční' },
  ],
  bass: [
    { id: 'pluck', name: 'Funky', hint: 'krátká, živá' },
    { id: 'sub', name: 'Sub', hint: 'hluboká, kulatá' },
    { id: 'acid', name: 'Acid 303', hint: 'kvákavá' },
    { id: 'reese', name: 'Reese', hint: 'tlustá, temná' },
  ],
  lead: [
    { id: 'square', name: '8-bit', hint: 'herní konzole' },
    { id: 'saw', name: 'Supersaw', hint: 'trance, EDM' },
    { id: 'flute', name: 'Flétna', hint: 'jemná, s vibratem' },
    { id: 'bell', name: 'Zvonek', hint: 'křišťálová' },
  ],
};

export const SOUND_IDS = Object.fromEntries(Object.entries(SOUNDS).map(([k, v]) => [k, v.map((s) => s.id)]));

const PIANO_URLS = {};
for (const o of [2, 3, 4, 5, 6]) {
  for (const [n, f] of [['C', 'C'], ['D#', 'Ds'], ['F#', 'Fs'], ['A', 'A']]) PIANO_URLS[n + o] = f + o + '.mp3';
}
PIANO_URLS.C7 = 'C7.mp3';

// Loudness match between kits (measured RMS of the same pattern).
const KIT_TRIM = { tr909: 1, tr808: 0.65, linn: 1.2, mpc60: 1 };

export class DrumKit {
  constructor(kit, output) {
    this.output = output;
    this.rate = 1;
    this.lanes = {};
    this.trim = new Tone.Gain(1).connect(output);
    for (const lane of DRUM_LANES) this.lanes[lane.id] = new Tone.Gain(1).connect(this.trim);
    this.load(kit);
  }

  load(kit) {
    this.kit = kit;
    this.trim.gain.value = KIT_TRIM[kit] ?? 1;
    const urls = Object.fromEntries(DRUM_LANES.map((l) => [l.id, `${BASE}${kit}/${l.id}.wav`]));
    let buffers;
    this.ready = new Promise((resolve, reject) => {
      buffers = new Tone.ToneAudioBuffers({ urls, onload: resolve, onerror: reject });
    }).then(() => {
      // Kit switched again while this one was loading: drop it.
      if (this.kit !== kit) return buffers.dispose();
      this.buffers?.dispose();
      this.buffers = buffers;
    }, (err) => console.warn(`Kit ${kit} failed to load`, err));
    return this.ready;
  }

  setTune(semitones) {
    this.rate = Math.pow(2, semitones / 12);
  }

  setLaneVol(lane, v) {
    this.lanes[lane].gain.rampTo(v * v, 0.03);
  }

  play(lane, time, velocity = 1) {
    const buf = this.buffers?.get(lane);
    if (!buf?.loaded) return null;
    const src = new Tone.ToneBufferSource({ context: this.output.context, url: buf, playbackRate: this.rate, fadeOut: lane === 'openhat' ? 0.04 : 0.005 });
    src.connect(this.lanes[lane]);
    src.onended = () => src.dispose();
    // A closed hat cuts the open one off, like on the real machines.
    if (lane === 'hat' && this.openHat && this.openHat.state === 'started') this.openHat.stop(time);
    if (lane === 'openhat') this.openHat = src;
    src.start(time, 0, undefined, velocity);
    return src;
  }

  dispose() {
    this.buffers?.dispose();
    for (const g of Object.values(this.lanes)) g.dispose();
    this.trim.dispose();
  }
}

function polyInstrument(synth, out, { attack, release }) {
  return {
    poly: true,
    defaults: { attack, release },
    ready: Promise.resolve(),
    play(midis, time, dur, vel) {
      synth.triggerAttackRelease(midis.map(midiToFreq), dur, time, vel);
    },
    start(midis, time, vel = 0.8) {
      synth.triggerAttack(midis.map(midiToFreq), time, vel);
    },
    stop(midis, time) {
      synth.triggerRelease(midis.map(midiToFreq), time);
    },
    silence(time) {
      synth.releaseAll(time);
    },
    setEnv(a, r) {
      synth.set({ envelope: { attack: a, release: r } });
    },
    setGlide() {},
    output: out,
    dispose() {
      synth.dispose();
      if (out !== synth) out.dispose();
    },
  };
}

function monoInstrument(synth, out, { attack, release }, extra = []) {
  return {
    poly: false,
    defaults: { attack, release },
    ready: Promise.resolve(),
    play(midi, time, dur, vel) {
      synth.triggerAttackRelease(midiToFreq(midi), dur, time, vel);
    },
    start(midi, time, vel = 0.85) {
      synth.triggerAttack(midiToFreq(midi), time, vel);
    },
    stop(_midi, time) {
      synth.triggerRelease(time);
    },
    silence(time) {
      synth.triggerRelease(time);
    },
    setEnv(a, r) {
      synth.envelope.attack = a;
      synth.envelope.release = r;
    },
    setGlide(s) {
      synth.portamento = s;
    },
    output: out,
    dispose() {
      synth.dispose();
      for (const n of extra) n.dispose();
    },
  };
}

// Chain helper: connects nodes in order and returns the last one.
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

export function createInstrument(track, id) {
  if (track === 'chords') return createChords(id);
  if (track === 'bass') return createBass(id);
  return createLead(id);
}

function createChords(id) {
  if (id === 'piano') {
    let loaded;
    const ready = new Promise((resolve) => (loaded = resolve));
    const s = new Tone.Sampler({ urls: PIANO_URLS, baseUrl: BASE + 'piano/', attack: 0, release: 1.2, volume: 4, onload: () => loaded() });
    const inst = polyInstrument(s, s, { attack: 0.001, release: 1.2 });
    inst.ready = ready;
    inst.setEnv = (a, r) => {
      s.attack = a;
      s.release = r;
    };
    return inst;
  }
  if (id === 'epiano') {
    const s = new Tone.PolySynth(Tone.FMSynth, {
      maxPolyphony: 24,
      volume: 3,
      harmonicity: 1,
      modulationIndex: 3.2,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.004, decay: 1.6, sustain: 0.35, release: 1.1 },
      modulationEnvelope: { attack: 0.002, decay: 0.45, sustain: 0.12, release: 0.9 },
    });
    const trem = new Tone.Tremolo({ frequency: 4.5, depth: 0.25, spread: 120 }).start();
    const chorus = new Tone.Chorus({ frequency: 0.8, delayTime: 3, depth: 0.4, wet: 0.35 }).start();
    const out = chain(s, trem, chorus);
    const inst = polyInstrument(s, out, { attack: 0.004, release: 1.1 });
    const dispose = inst.dispose;
    inst.dispose = () => {
      dispose();
      trem.dispose();
    };
    return inst;
  }
  if (id === 'pad') {
    const s = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 24,
      volume: -10.5,
      oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
      envelope: { attack: 0.5, decay: 0.6, sustain: 0.85, release: 2.2 },
    });
    const lp = new Tone.Filter({ type: 'lowpass', frequency: 1500, rolloff: -24, Q: 0.5 });
    const chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 4, depth: 0.6, wet: 0.5 }).start();
    const out = chain(s, lp, chorus);
    const inst = polyInstrument(s, out, { attack: 0.5, release: 2.2 });
    const dispose = inst.dispose;
    inst.dispose = () => {
      dispose();
      lp.dispose();
    };
    return inst;
  }
  // stab
  const s = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 24,
    volume: -6,
    oscillator: { type: 'fatsawtooth', count: 5, spread: 38 },
    envelope: { attack: 0.003, decay: 0.3, sustain: 0.35, release: 0.35 },
  });
  const lp = new Tone.Filter({ type: 'lowpass', frequency: 4200, rolloff: -12, Q: 0.8 });
  const out = chain(s, lp);
  const inst = polyInstrument(s, out, { attack: 0.003, release: 0.35 });
  inst.dispose = () => {
    s.dispose();
    lp.dispose();
  };
  return inst;
}

function createBass(id) {
  const presets = {
    pluck: {
      volume: -6,
      oscillator: { type: 'square' },
      filter: { Q: 2, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.003, decay: 0.35, sustain: 0.25, release: 0.12 },
      filterEnvelope: { attack: 0.002, decay: 0.18, sustain: 0.15, release: 0.15, baseFrequency: 180, octaves: 3.2 },
    },
    sub: {
      volume: -8,
      oscillator: { type: 'sine' },
      filter: { Q: 0, type: 'lowpass', rolloff: -12 },
      envelope: { attack: 0.006, decay: 0.2, sustain: 0.9, release: 0.18 },
      filterEnvelope: { attack: 0.001, decay: 0.1, sustain: 1, release: 0.1, baseFrequency: 3000, octaves: 0 },
    },
    acid: {
      volume: -6.5,
      oscillator: { type: 'sawtooth' },
      filter: { Q: 7, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.003, decay: 0.3, sustain: 0.5, release: 0.08 },
      filterEnvelope: { attack: 0.002, decay: 0.22, sustain: 0.08, release: 0.2, baseFrequency: 140, octaves: 4.2, exponent: 2 },
    },
    reese: {
      volume: -1,
      oscillator: { type: 'fatsawtooth', count: 2, spread: 28 },
      filter: { Q: 1, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.2 },
      filterEnvelope: { attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.3, baseFrequency: 260, octaves: 1.6 },
    },
  };
  const p = presets[id] || presets.pluck;
  const s = new Tone.MonoSynth(p);
  const extra = [];
  let out = s;
  if (id === 'sub') {
    // A touch of 2nd harmonic so the sub is audible on laptop speakers too.
    const cheb = new Tone.Chebyshev({ order: 2, wet: 0.25 });
    out = chain(s, cheb);
    extra.push(cheb);
  } else if (id === 'acid') {
    const dist = new Tone.Distortion({ distortion: 0.35, wet: 0.35, oversample: '2x' });
    out = chain(s, dist);
    extra.push(dist);
  }
  return monoInstrument(s, out, { attack: p.envelope.attack, release: p.envelope.release }, extra);
}

function createLead(id) {
  const extra = [];
  let s;
  let out;
  if (id === 'bell') {
    s = new Tone.FMSynth({
      volume: 0,
      harmonicity: 3.01,
      modulationIndex: 11,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.001, decay: 1.4, sustain: 0, release: 1.4 },
      modulationEnvelope: { attack: 0.001, decay: 0.6, sustain: 0, release: 0.6 },
    });
    out = s;
  } else {
    const presets = {
      square: {
        volume: -12,
        oscillator: { type: 'pulse', width: 0.3 },
        filter: { Q: 1, type: 'lowpass', rolloff: -12 },
        envelope: { attack: 0.004, decay: 0.2, sustain: 0.6, release: 0.18 },
        filterEnvelope: { attack: 0.002, decay: 0.3, sustain: 0.5, release: 0.2, baseFrequency: 1400, octaves: 2.5 },
      },
      saw: {
        volume: -4,
        oscillator: { type: 'fatsawtooth', count: 3, spread: 18 },
        filter: { Q: 1.5, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.006, decay: 0.25, sustain: 0.7, release: 0.3 },
        filterEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.4, release: 0.3, baseFrequency: 900, octaves: 3 },
      },
      flute: {
        volume: -10,
        oscillator: { type: 'triangle' },
        filter: { Q: 0.5, type: 'lowpass', rolloff: -12 },
        envelope: { attack: 0.06, decay: 0.2, sustain: 0.85, release: 0.35 },
        filterEnvelope: { attack: 0.06, decay: 0.2, sustain: 1, release: 0.3, baseFrequency: 2500, octaves: 1 },
      },
    };
    const p = presets[id] || presets.square;
    s = new Tone.MonoSynth(p);
    out = s;
    if (id === 'flute' || id === 'square') {
      const vib = new Tone.Vibrato({ frequency: 5.2, depth: id === 'flute' ? 0.12 : 0.05 });
      out = chain(s, vib);
      extra.push(vib);
    }
  }
  const env = s.envelope;
  return monoInstrument(s, out, { attack: env.attack, release: env.release }, extra);
}
