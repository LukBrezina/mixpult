// Audio engine: mixer, effects and the step sequencer that plays the song object.
// The engine reads the song on every step, so edits are heard on the next pass of the loop.
// While a knob is touched, that track plays "live" from the knob instead of from the song.
import * as Tone from 'tone';
import { DrumKit, LAYERS, createLayer, createSub, createVoiceChain } from './sounds.js';
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
    this.liveMidi = perTrack(null);
    this.x = perTrack(null); // energy currently applied
    this.clipSources = new Map(); // voice clips playing right now -> their end time
    this.offline = Tone.getContext() instanceof Tone.OfflineContext;
    this.padDirty = true; // the pad must be (re)started at the next slot
    this.latency = 0; // extra user calibration, seconds

    // Master: DJ filters -> glue compressor -> limiter.
    this.master = new Tone.Gain(1);
    this.djHP = new Tone.Filter({ type: 'highpass', frequency: 10, rolloff: -24, Q: 1 });
    this.djLP = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -24, Q: 1 });
    this.comp = new Tone.Compressor({ threshold: -16, ratio: 2.5, attack: 0.015, release: 0.2, knee: 8 });
    this.limiter = new Tone.Limiter(-1);
    // Soft clipper after the limiter: linear up to 0.7, then rounds off so peaks never pass 0 dBFS.
    this.clip = new Tone.WaveShaper((x) => {
      const a = Math.abs(x);
      return a < 0.7 ? x : Math.sign(x) * (0.7 + 0.29 * Math.tanh((a - 0.7) / 0.29));
    }, 4096);
    this.out = new Tone.Volume(-1);
    this.master.chain(this.djHP, this.djLP, this.comp, this.limiter, this.clip, this.out, Tone.getDestination());

    // Everything except drums goes through this bus, which ducks on every kick (sidechain pump).
    this.music = new Tone.Gain(1).connect(this.master);

    this.reverb = new Tone.Reverb({ decay: 3.8, preDelay: 0.03, wet: 1 });
    this.reverbIn = new Tone.Filter({ type: 'highpass', frequency: 300 });
    this.reverbIn.chain(this.reverb, this.music);
    this.delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.35, wet: 1 });
    this.delayIn = new Tone.Filter({ type: 'bandpass', frequency: 2000, Q: 0.5 });
    this.delayIn.chain(this.delay, this.music);

    const SENDS = { drums: [0.06, 0], chords: [0.3, 0.12], bass: [0, 0], lead: [0.3, 0.28], voice: [0.32, 0.2] };
    this.tracks = {};
    for (const t of TRACKS) {
      const channel = new Tone.Channel();
      channel.connect(t === 'drums' ? this.master : this.music);
      const [rev, del] = SENDS[t];
      if (rev) channel.connect(new Tone.Gain(rev).connect(this.reverbIn));
      if (del) channel.connect(new Tone.Gain(del).connect(this.delayIn));
      this.tracks[t] = { channel };
    }

    this.drums = new DrumKit(this.tracks.drums.channel);
    this.voice = createVoiceChain();
    this.voice.output.connect(this.tracks.voice.channel);
    for (const t of LAYERED) {
      const tr = this.tracks[t];
      tr.layers = LAYERS[t].map((id) => {
        const inst = createLayer(t, id);
        const gain = new Tone.Gain(0).connect(tr.channel);
        inst.output.connect(gain);
        return { inst, gain };
      });
    }
    this.tracks.bass.sub = createSub();
    this.tracks.bass.sub.output.connect(this.tracks.bass.channel);
    for (const t of TRACKS) this.setX(t, song[t].x[0], 0);
    this.applyMix();

    this.transport.scheduleRepeat((time) => this.tick(time), '16n', 0);
  }

  get ready() {
    return Promise.all([this.drums.ready, this.reverb.ready]);
  }

  // ---------- song / mixer ----------

  setSong(song) {
    this.song = song;
    this.sync({ k: 'slot', t: 'chords' });
  }

  // Bring the mixer in line with the song after an op.
  sync(op) {
    this.applyMix();
    if (op?.k === 'slot' && op.t === 'chords') this.retriggerPad();
  }

  applyMix() {
    if (Math.round(this.transport.bpm.value) !== this.song.bpm) {
      this.transport.bpm.value = this.song.bpm;
      // The delay was set in note values: keep it on the beat at the new tempo.
      this.delay.delayTime.rampTo(this.transport.toSeconds('8n.'), 0.1);
    }
    for (const t of TRACKS) {
      const tr = this.tracks[t];
      tr.channel.volume.rampTo(sliderToDb(this.song.vol[t]), 0.05);
      tr.channel.mute = this.song.mute[t];
    }
  }

  audible(track) {
    return !this.song.mute[track];
  }

  // Left/right energy: crossfades the three layers of a track (drums use it per hit).
  setX(t, x, time) {
    if (this.x[t] !== null && Math.abs(x - this.x[t]) < 0.004) return;
    this.x[t] = x;
    if (!this.tracks[t].layers) return; // drums use it per hit, voice not at all
    xfade(x).forEach((g, i) => this.tracks[t].layers[i].gain.gain.setTargetAtTime(g, time, 0.025));
  }

  // XY pad. x: -1 = lowpass down, 0 = off, +1 = highpass up. y: 0..1 resonance.
  setXY(x, y) {
    const lp = x < 0 ? 20000 * Math.pow(160 / 20000, -x) : 20000;
    const hp = x > 0 ? 20 * Math.pow(6000 / 20, x) : 10;
    const q = 0.8 + y * 9;
    this.djLP.frequency.rampTo(lp, 0.04);
    this.djHP.frequency.rampTo(hp, 0.04);
    this.djLP.Q.rampTo(q, 0.04);
    this.djHP.Q.rampTo(q, 0.04);
  }

  // Beat repeat: while held, the first `len` steps of the current beat play over and over.
  setStutter(len) {
    const was = this.stutter;
    this.stutter = len ? { len, anchor: null, n: 0 } : null;
    if (len && !was) this.tracks.chords.layers[0].inst.silence(Tone.immediate()); // the long pad gives way to the repeats
    if (was && !len) this.retriggerPad(); // the pad comes back right away, not at the next slot
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
    this.out.volume.rampTo(on ? -80 : -1, on ? 0.12 : 0.05);
  }

  stepSeconds() {
    return this.transport.toSeconds('16n');
  }

  // Loop step the listener hears right now (fractional, counting up from the start, not wrapped).
  heardStepFloat() {
    const ctx = Tone.getContext().rawContext;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + this.latency;
    const ticks = this.transport.getTicksAtTime(Tone.immediate() - lat);
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
    const st = this.stutter;
    let sliceStart = false;
    if (st) {
      // From the start of the beat, where the kick is, so the repeat always has a punch.
      if (st.anchor === null) st.anchor = step - (step % 4);
      sliceStart = st.n % st.len === 0;
      step = st.anchor + (st.n++ % st.len);
    }

    for (const t of TRACKS) this.setX(t, this.live[t]?.x ?? this.song[t].x[step], time);
    if (!this.breakdown) this.tickDrums(step, time);
    if (st) {
      if (sliceStart) this.tickRepeat(step, time, st.len * this.stepSeconds());
    } else {
      this.tickChords(step, time);
      if (!this.breakdown) this.tickMelodic('bass', step, time);
      this.tickMelodic('lead', step, time);
      this.tickVoice(step, time);
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
    const g = this.music.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0.6, time);
    g.setTargetAtTime(1, time + 0.015, 0.07);
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

    // Pad: one long chord for as long as it stays the same within the bar. Always played, even when
    // faded out, so sliding left brings it in smoothly. The live chord is held by setLive instead.
    if (!this.live.chords && s % CHORD_SLOT === 0 && (s === 0 || this.padDirty || this.chordIndexAt(step - 1) !== c)) {
      let run = CHORD_SLOT;
      while (s + run < 16 && this.chordIndexAt(step + run) === c) run += CHORD_SLOT;
      pad.inst.play(notes, time, run * sd - 0.03, 0.7);
      this.padDirty = false;
    }
    // Stabs on the off-beat (the kick owns the beat), arpeggio on every 16th.
    if (g[1] > 0.01 && s % 4 === 2) stab.inst.play(notes, time, 1.2 * sd, s === 14 ? 0.85 : 0.75);
    if (g[2] > 0.01) {
      const up = [notes[0], notes[1], notes[2], notes[0] + 12];
      arp.inst.play([up[s % 4]], time, sd * 0.9, s % 4 === 0 ? 0.75 : 0.6);
    }
  }

  tickMelodic(track, step, time) {
    if (!this.audible(track) || this.live[track]) return;
    const notes = this.song[track].notes;
    let start = step;
    let n = notes[step];
    // A long note crossing into a new chord is re-pitched to it, so it never clashes.
    if (!n && step % CHORD_SLOT === 0) {
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
    for (const l of this.tracks[track].layers) l.inst.play(midi, time, dur, vel);
    this.tracks[track].sub?.play(midi, time, dur, vel);
  }

  // One beat-repeat slice: everything that sounds at `step` starts again, whether its note began
  // there or earlier (otherwise a repeat of the middle of a long note is silence).
  tickRepeat(step, time, dur) {
    const len = dur * 0.9;
    if (this.audible('chords') && !this.live.chords) {
      const notes = voiceChord(this.chordAt(step));
      for (const l of this.tracks.chords.layers) l.inst.play(notes, time, len, 0.7);
    }
    for (const t of MELODIC) {
      if (!this.audible(t) || this.live[t] || (t === 'bass' && this.breakdown)) continue;
      const act = activeNote(this.song[t].notes, step);
      if (!act) continue;
      const midi = this.noteFor(t, act.note.row, step);
      for (const l of this.tracks[t].layers) l.inst.play(midi, time, len, 0.9);
      this.tracks[t].sub?.play(midi, time, len, 0.9);
    }
    const v = activeNote(this.song.voice.notes, step);
    if (v && this.audible('voice') && !this.live.voice) {
      this.playClip(v.note.row, time, dur, (step - v.start) * this.stepSeconds());
    }
    this.padDirty = true;
  }

  // Voice pads in the loop: a note plays its pad's clip for as long as the pad was held.
  tickVoice(step, time) {
    const notes = this.song.voice.notes;
    const n = notes[step];
    if (!n || !this.audible('voice') || this.live.voice) return;
    let dist = 1;
    while (step + dist < LOOP && !notes[step + dist]) dist++;
    this.playClip(n.row, time, Math.min(n.len, dist) * this.stepSeconds());
  }

  // One clip at a time, like chopping on a launchpad: a new one cuts the last.
  playClip(pad, time, dur = Infinity, offset = 0) {
    const buf = clips.get(this.song.voice.pads[pad]);
    this.stopClips(time);
    if (!buf || offset >= buf.duration) return;
    // Cleaned up here by time, not in onended: an offline render (WAV export) runs the whole
    // sequencer before rendering a sample, and disposing there would silence every clip.
    for (const [old, end] of this.clipSources) {
      if (!this.offline && end < time - 1) {
        old.dispose();
        this.clipSources.delete(old);
      }
    }
    const src = new Tone.ToneBufferSource({ context: this.voice.input.context, url: buf, fadeIn: 0.003, fadeOut: 0.03 });
    src.connect(this.voice.input);
    const len = Math.min(dur, buf.duration - offset);
    this.clipSources.set(src, time + len);
    src.start(time, offset, len);
  }

  stopClips(time) {
    for (const [src, end] of this.clipSources) if (end > time) src.stop(time);
  }

  startNote(track, midi, time, vel = 0.9) {
    for (const l of this.tracks[track].layers) l.inst.start(midi, time, vel);
    this.tracks[track].sub?.start(midi, time, vel);
  }

  silenceTrack(track, time) {
    for (const l of this.tracks[track].layers) l.inst.silence(time);
    this.tracks[track].sub?.silence(time);
  }

  // ---------- live (knob touched) ----------

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
        pad.start(voiceChord(CHORDS[v.row]), now + 0.005, 0.7);
      }
    } else if (t !== 'drums') {
      const midi = this.noteFor(t, v.row, this.heardStep());
      if (!prev || midi !== this.liveMidi[t]) {
        this.liveMidi[t] = midi;
        this.startNote(t, midi, now);
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

  // Plays the song's chord for the rest of the current slot, e.g. after a live chord or an edit.
  retriggerPad() {
    if (this.live.chords) return;
    const pad = this.tracks.chords.layers[0].inst;
    const now = Tone.immediate();
    pad.silence(now);
    this.padDirty = true;
    if (!this.playing || !this.audible('chords')) return;
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
