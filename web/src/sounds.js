// Instruments, all tuned for a catchy night techno sound. Every instrument has the same small
// interface (play / start / silence / output). Each melodic track has three layers that the
// knob's left/right position crossfades between, like a DJ blending sounds.
import * as Tone from 'tone';
import { midiToFreq } from './theory.js';
import { DRUM_LANES } from './patterns.js';

const BASE = (import.meta.env?.BASE_URL ?? '/') + 'samples/';

// Left → right on the knob: calm → hard.
export const LAYERS = {
  chords: ['pad', 'stab', 'arp'],
  bass: ['deep', 'banger', 'acid'],
  lead: ['glass', 'bleep', 'laser'],
};

const KIT = 'tr909';
const KIT_TRIM = 1.5;
const LANE_GAIN = { kick: 1, snare: 0.75, clap: 0.65, hat: 0.4, openhat: 0.4, tom: 0.6 };

export class DrumKit {
  constructor(output) {
    this.output = output;
    this.trim = new Tone.Gain(KIT_TRIM).connect(output);
    this.lanes = {};
    for (const lane of DRUM_LANES) this.lanes[lane.id] = new Tone.Gain(LANE_GAIN[lane.id]).connect(this.trim);

    // Sub thump under every kick: deep modern low end.
    this.sub = new Tone.MembraneSynth({
      pitchDecay: 0.045, octaves: 4, volume: -9,
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.05 },
    }).connect(this.lanes.kick);

    // Gated reverb on snare and clap: a big room that is cut off abruptly.
    this.gateVerb = new Tone.Reverb({ decay: 1.4, preDelay: 0.008, wet: 1 });
    this.gate = new Tone.Gate({ threshold: -36, smoothing: 0.02 });
    this.gateSend = new Tone.Gain(0.45);
    this.gateSend.chain(this.gateVerb, this.gate, this.trim);
    this.lanes.snare.connect(this.gateSend);
    this.lanes.clap.connect(this.gateSend);

    const urls = Object.fromEntries(DRUM_LANES.map((l) => [l.id, `${BASE}${KIT}/${l.id}.wav`]));
    this.loading = new Promise((resolve, reject) => {
      this.buffers = new Tone.ToneAudioBuffers({ urls, onload: resolve, onerror: reject });
    }).catch((err) => console.warn('Drums failed to load', err));
  }

  get ready() {
    return Promise.all([this.loading, this.gateVerb.ready]);
  }

  play(lane, time, velocity = 1) {
    const buf = this.buffers.get(lane);
    if (!buf?.loaded) return;
    // Explicit context: this runs inside the sequencer, also during offline rendering.
    const src = new Tone.ToneBufferSource({ context: this.output.context, url: buf, fadeOut: lane === 'openhat' ? 0.04 : 0.005 });
    src.connect(this.lanes[lane]);
    src.onended = () => src.dispose();
    // A closed hat cuts the open one off, like on the real machines.
    if (lane === 'hat' && this.openHat?.state === 'started') this.openHat.stop(time);
    if (lane === 'openhat') this.openHat = src;
    src.start(time, 0, undefined, velocity);
    if (lane === 'kick') this.sub.triggerAttackRelease('A1', 0.3, time, velocity);
  }
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

function polyInstrument(synth, out) {
  return {
    output: out,
    play(midis, time, dur, vel) {
      synth.triggerAttackRelease(midis.map(midiToFreq), dur, time, vel);
    },
    start(midis, time, vel = 0.8) {
      synth.triggerAttack(midis.map(midiToFreq), time, vel);
    },
    silence(time) {
      synth.releaseAll(time);
    },
  };
}

function monoInstrument(voice, out) {
  return {
    output: out,
    play(midi, time, dur, vel) {
      voice.triggerAttackRelease(midiToFreq(midi), dur, time, vel);
    },
    start(midi, time, vel = 0.85) {
      voice.triggerAttack(midiToFreq(midi), time, vel);
    },
    silence(time) {
      voice.triggerRelease(time);
    },
  };
}

export function createLayer(track, id) {
  if (track === 'chords') return createChords(id);
  if (track === 'bass') return createBassTop(id);
  return createLead(id);
}

function createChords(id) {
  if (id === 'stab') {
    // Short, bright chord hit with a snappy filter: the classic techno stab.
    const s = new Tone.PolySynth(Tone.MonoSynth, {
      maxPolyphony: 24,
      volume: 1,
      oscillator: { type: 'fatsawtooth', count: 2, spread: 14 },
      filter: { type: 'lowpass', rolloff: -24, Q: 2.5 },
      envelope: { attack: 0.002, decay: 0.22, sustain: 0.25, release: 0.18 },
      filterEnvelope: { attack: 0.001, decay: 0.16, sustain: 0.15, release: 0.2, baseFrequency: 420, octaves: 3.6 },
    });
    const hp = new Tone.Filter({ type: 'highpass', frequency: 180, rolloff: -12 });
    return polyInstrument(s, chain(s, hp));
  }
  if (id === 'arp') {
    // Drawbar-ish organ played as a fast arpeggio: a few sine partials, instant on and off.
    const s = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 16,
      volume: -8.5,
      oscillator: { type: 'custom', partials: [1, 0.7, 0.45, 0.3, 0, 0.2, 0, 0.12] },
      envelope: { attack: 0.004, decay: 0.1, sustain: 0.9, release: 0.06 },
    });
    const vib = new Tone.Vibrato({ frequency: 6.2, depth: 0.04 });
    return polyInstrument(s, chain(s, vib));
  }
  // pad: wide detuned saws, chorus.
  const s = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 16,
    volume: -5,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
    envelope: { attack: 0.03, decay: 0.5, sustain: 0.75, release: 0.9 },
  });
  const lp = new Tone.Filter({ type: 'lowpass', frequency: 2600, rolloff: -24, Q: 0.6 });
  const chorus = new Tone.Chorus({ frequency: 0.5, delayTime: 3.5, depth: 0.7, wet: 0.5 }).start();
  return polyInstrument(s, chain(s, lp, chorus));
}

// The deep part of every bass: one clean sine sub, always there whatever the knob says.
export function createSub() {
  const sub = new Tone.Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.004, decay: 0.3, sustain: 0.8, release: 0.1 },
    volume: -6,
  });
  return monoInstrument(sub, sub);
}

// The crisp part: a distorted, high-passed top layer over the sub.
function createBassTop(id) {
  const opts = {
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
  const { drive, ...synthOpts } = opts;
  const s = new Tone.MonoSynth(synthOpts);
  const dist = new Tone.Distortion({ distortion: drive, oversample: '2x' });
  const hp = new Tone.Filter({ type: 'highpass', frequency: 140, rolloff: -24 });
  return monoInstrument(s, chain(s, dist, hp));
}

function createLead(id) {
  if (id === 'glass') {
    const s = new Tone.FMSynth({
      volume: 2,
      harmonicity: 3.01,
      modulationIndex: 9,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.002, decay: 1.2, sustain: 0.15, release: 1.2 },
      modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0.1, release: 0.6 },
    });
    return monoInstrument(s, s);
  }
  if (id === 'bleep') {
    const s = new Tone.MonoSynth({
      volume: -10,
      portamento: 0.012,
      oscillator: { type: 'square' },
      filter: { type: 'lowpass', rolloff: -12, Q: 2 },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0.55, release: 0.07 },
      filterEnvelope: { attack: 0.001, decay: 0.09, sustain: 0.5, release: 0.1, baseFrequency: 1500, octaves: 2.4 },
    });
    return monoInstrument(s, s);
  }
  // laser: detuned supersaw with a touch of vibrato.
  const s = new Tone.MonoSynth({
    volume: -4,
    portamento: 0.02,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
    filter: { type: 'lowpass', rolloff: -24, Q: 1.5 },
    envelope: { attack: 0.008, decay: 0.25, sustain: 0.7, release: 0.3 },
    filterEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.45, release: 0.3, baseFrequency: 900, octaves: 3 },
  });
  const vib = new Tone.Vibrato({ frequency: 5, depth: 0.03 });
  return monoInstrument(s, chain(s, vib));
}

// Vocal chain in the Fred again.. spirit: cleaned up, squashed, bright and airy, a bit of grit and
// width. The space (reverb, dotted delay) and the pump on every kick come from the engine.
export function createVoiceChain() {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(Tone.dbToGain(2));
  const chorus = new Tone.Chorus({ frequency: 0.7, delayTime: 5, depth: 0.3, spread: 180, wet: 0.22 }).start();
  input.chain(
    new Tone.Filter({ type: 'highpass', frequency: 120, rolloff: -24 }),
    new Tone.Filter({ type: 'peaking', frequency: 320, Q: 1, gain: -3 }), // less boxy
    new Tone.Compressor({ threshold: -28, ratio: 5, knee: 8, attack: 0.003, release: 0.1 }),
    new Tone.Filter({ type: 'peaking', frequency: 3200, Q: 0.8, gain: 3 }), // presence
    new Tone.Filter({ type: 'highshelf', frequency: 9000, gain: 5 }), // air
    new Tone.Distortion({ distortion: 0.12, oversample: '2x', wet: 0.35 }),
    chorus,
    output,
  );
  return { input, output };
}
