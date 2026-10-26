// The whole mix in two AudioWorklet processors: every instrument, the drum and voice samples, their
// effects, the mixer, the delay and the master chain. Only the reverb stays a Web Audio node (its
// convolution runs mostly off the audio thread). Tone.js built all of this out of hundreds of Web
// Audio nodes, and a mid-range phone spent its whole audio budget walking that graph.
//
// The sound itself is computed in WebAssembly, compiled from Rust (dsp/src/lib.rs): plain machine
// code that never allocates while playing, so there are no garbage collector pauses on the audio
// thread. This file is the glue: it builds the mix from the specs (see sounds.js), turns the
// engine's messages into calls, and copies each block out of the module's memory.
//
//   'mixpult-mix':    sources -> effects -> tracks -> sends, delay, sidechain duck
//                     outputs: [0] the master bus (mono), [1] the reverb send (mono)
//   'mixpult-master': inputs: [0] the master bus, [1] the reverb return (stereo)
//                     DJ filters -> glue compressor -> limiter -> soft clip -> volume
//
// Both get the module's bytes as processorOptions.wasm; each compiles its own instance.

const BLOCK = 128;

function load(bytes) {
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return exports;
}

const time = (msg) => Math.max(currentFrame, Math.round((msg.time ?? 0) * sampleRate));
const CURVES = { set: 0, linear: 1, exp: 2, target: 3 };
const FILTERS = { lowpass: 0, highpass: 1, bandpass: 2, peaking: 3, highshelf: 4 };
const stages = (rolloff) => (rolloff === -24 ? 2 : rolloff === -48 ? 4 : 1);
const WAVES = { sawtooth: 0, square: 1, sine: 2, custom: 3 };

// Views on the module's memory, made again whenever it grows (growing detaches the old buffer).
class View {
  constructor(dsp, ptr, length) {
    this.dsp = dsp;
    this.ptr = ptr;
    this.length = length;
    this.array = null;
  }

  get() {
    if (!this.array || this.array.buffer !== this.dsp.memory.buffer) {
      this.array = new Float32Array(this.dsp.memory.buffer, this.ptr, this.length);
    }
    return this.array;
  }
}

// The effects after a source, from their specs (see sounds.js), with Tone's defaults.
function addFx(dsp, src, specs = []) {
  for (const f of specs) {
    if (f.fx === 'filter') dsp.mix_fx(src, 0, FILTERS[f.type], f.frequency ?? 350, f.Q ?? 1, f.gain ?? 0, stages(f.rolloff));
    else if (f.fx === 'vibrato') dsp.mix_fx(src, 1, f.frequency ?? 5, f.depth ?? 0.1, 0, 0, 0);
    else if (f.fx === 'chorus') dsp.mix_fx(src, 2, f.frequency ?? 1.5, f.delayTime ?? 3.5, f.depth ?? 0.7, f.spread ?? 180, f.wet ?? 0.5);
    else if (f.fx === 'distortion') dsp.mix_fx(src, 3, f.distortion ?? 0.4, (f.oversample ?? 'none') !== 'none' ? 1 : 0, f.wet ?? 1, 0, 0);
    else if (f.fx === 'compressor') dsp.mix_fx(src, 4, f.threshold ?? -24, f.knee ?? 30, f.ratio ?? 12, f.attack ?? 0.003, f.release ?? 0.25);
    else if (f.fx === 'gain') dsp.mix_fx(src, 5, f.db, 0, 0, 0, 0);
  }
}

// Synth, MonoSynth or FMSynth (a PolySynth of them with maxPolyphony), from Tone-like options.
function addInstrument(dsp, s, track) {
  const osc = s.oscillator ?? {};
  const type = osc.type ?? 'sawtooth';
  const fat = type.startsWith('fat');
  const wave = s.kind === 'fm' ? 4 : WAVES[type.replace(/^fat/, '')];
  if (wave === 3) for (const p of osc.partials) dsp.mix_push(p);
  const i = dsp.mix_instrument(track, s.gain ?? 1, s.volume ?? 0, s.maxPolyphony ?? 0, wave, fat ? (osc.count ?? 1) : 1, osc.spread ?? 20);
  const env = (which, e) => dsp.mix_envelope(i, which, e.attack, e.decay, e.sustain, e.release);
  env(0, s.envelope);
  if (s.kind === 'fm') {
    env(2, s.modulationEnvelope);
    dsp.mix_fm(i, s.harmonicity, s.modulationIndex);
  } else if (s.filter) {
    const fe = s.filterEnvelope;
    dsp.mix_filter(i, stages(s.filter.rolloff), s.filter.Q ?? 1, fe.baseFrequency, fe.octaves, fe.exponent ?? 2);
    env(1, fe);
  }
  dsp.mix_glide(i, s.portamento ?? 0, s.pitchDecay ?? 0, s.octaves ?? 1);
  addFx(dsp, i, s.fx);
  dsp.mix_instrument_done(i);
  return i;
}

class MixpultMix extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    const dsp = (this.dsp = load(o.wasm));
    dsp.mix_new(sampleRate);
    const tracks = new Map(o.tracks.map((t) => [t.id, dsp.mix_track(t.bus === 'master' ? 1 : 0, t.rev, t.del)]));
    // Instruments first: their source numbers are their indexes in the engine.
    for (const s of o.instruments) addInstrument(dsp, s, tracks.get(s.track));
    this.drums = dsp.mix_sampler(tracks.get(o.drums));
    this.clips = dsp.mix_sampler(tracks.get(o.voice));
    addFx(dsp, this.clips, o.voiceFx);
    const { delay, reverbIn } = o;
    dsp.mix_delay(delay.time, delay.feedback, FILTERS[delay.filter.type], delay.filter.frequency, delay.filter.Q ?? 1);
    dsp.mix_reverb_in(FILTERS[reverbIn.type], reverbIn.frequency, reverbIn.Q ?? 1);

    this.params = new Map([['duck', 0], ['wash', 1], ['delayTime', 2]]);
    o.tracks.forEach((t, k) => {
      this.params.set('vol.' + t.id, 3 + 2 * k);
      this.params.set('mute.' + t.id, 4 + 2 * k);
    });
    o.instruments.forEach((_, i) => this.params.set('gain.' + i, 3 + 2 * o.tracks.length + i));
    this.samples = new Map(); // sample name -> its number in the module
    this.bus = this.rev = null;
    this.port.onmessage = (e) => this.receive(e.data);
  }

  sample(id) {
    if (!this.samples.has(id)) this.samples.set(id, this.samples.size);
    return this.samples.get(id);
  }

  receive(msg) {
    const { dsp } = this;
    const frame = time(msg);
    switch (msg.t) {
      case 'param': {
        const id = this.params.get(msg.p);
        if (id !== undefined) dsp.mix_param(id, frame, CURVES[msg.curve ?? 'linear'], msg.v, msg.ramp ?? 0);
        break;
      }
      case 'sample': {
        const n = this.sample(msg.id);
        const ptr = dsp.mix_sample(n, msg.data.length);
        new Float32Array(dsp.memory.buffer, ptr, msg.data.length).set(msg.data);
        dsp.mix_sample_rate(n, msg.rate);
        for (const id of msg.drop ?? []) if (this.samples.has(id)) dsp.mix_sample_drop(this.samples.get(id));
        break;
      }
      // { t: 'play' | 'start' | 'silence', i, f: [Hz], time, dur, vel }
      case 'play':
      case 'start':
        msg.f.forEach((f, k) => dsp.mix_note(msg.i, msg.t === 'play' ? 0 : 1, frame, f, (msg.dur ?? 0) * sampleRate, msg.vel ?? 1, k === 0 ? 1 : 0));
        break;
      case 'silence':
        dsp.mix_note(msg.i, 2, frame, 0, 0, 0, 1);
        break;
      // Drum hits ({ id, gain }), a closed hat cutting the open one ({ id, fade }), and the voice
      // clips ({ id, offset, len } / clipStop).
      case 'drum':
        if (this.samples.has(msg.id)) dsp.mix_drum(this.drums, this.samples.get(msg.id), frame, msg.gain, 0);
        break;
      case 'choke':
        if (this.samples.has(msg.id)) dsp.mix_drum(this.drums, this.samples.get(msg.id), frame, 0, msg.fade > 0 ? msg.fade : -1);
        break;
      case 'clip':
        if (this.samples.has(msg.id)) dsp.mix_clip(this.clips, this.samples.get(msg.id), frame, msg.offset ?? 0, Math.round(msg.len * sampleRate));
        break;
      case 'clipStop':
        dsp.mix_clip(this.clips, 0, frame, 0, -1);
        break;
    }
  }

  process(_, outputs) {
    const ptr = this.dsp.mix_process(currentFrame);
    if (!this.bus) {
      this.bus = new View(this.dsp, ptr, BLOCK);
      this.rev = new View(this.dsp, ptr + 4 * BLOCK, BLOCK);
    }
    outputs[0][0].set(this.bus.get());
    outputs[1][0].set(this.rev.get());
    return true;
  }
}

const MASTER_PARAMS = { hp: 0, lp: 1, q: 2, dry: 3, out: 4 };

class MixpultMaster extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    const dsp = (this.dsp = load(o.wasm));
    dsp.master_new(sampleRate, o.top, o.out);
    for (const [which, c] of [o.comp, o.limiter].entries()) {
      dsp.master_compressor(which, c.threshold ?? -24, c.knee ?? 30, c.ratio ?? 12, c.attack ?? 0.003, c.release ?? 0.25);
    }
    const input = dsp.master_input();
    this.inputs = [0, 1, 2].map((k) => new View(dsp, input + 4 * BLOCK * k, BLOCK));
    this.outputs = null;
    this.port.onmessage = ({ data: m }) => {
      const id = MASTER_PARAMS[m.p];
      if (id !== undefined) dsp.master_param(id, time(m), CURVES[m.curve ?? 'linear'], m.v, m.ramp ?? 0);
    };
  }

  process(inputs, outputs) {
    const bus = inputs[0][0];
    const rev = inputs[1];
    if (bus) this.inputs[0].get().set(bus);
    if (rev[0]) this.inputs[1].get().set(rev[0]);
    if (rev[1]) this.inputs[2].get().set(rev[1]);
    const ptr = this.dsp.master_process(currentFrame, bus ? 1 : 0, rev.length);
    if (!this.outputs) this.outputs = [0, 1].map((k) => new View(this.dsp, ptr + 4 * BLOCK * k, BLOCK));
    outputs[0][0].set(this.outputs[0].get());
    outputs[0][1].set(this.outputs[1].get());
    return true;
  }
}

registerProcessor('mixpult-mix', MixpultMix);
registerProcessor('mixpult-master', MixpultMaster);
