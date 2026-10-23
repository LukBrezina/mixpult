// Audio engine: mixer, effects and the step sequencer that plays the song object.
// The engine reads the song on every step, so edits are heard on the next pass of the loop.
import * as Tone from 'tone';
import { DrumKit, createInstrument } from './sounds.js';
import { DRUM_LANES, TRACKS, chordAtStep } from './song.js';
import { chordPalette, voiceChord, melodicRows, chordBassNote } from './theory.js';

export const sliderToDb = (v) => (v <= 0.001 ? -Infinity : 40 * Math.log10(v));
export const cutoffHz = (v) => 60 * Math.pow(20000 / 60, v);
const resoQ = (v) => 0.7 + v * 11;

// Drum dynamics: off-beat hats a bit softer gives a natural groove for free.
function drumVelocity(lane, step) {
  if (lane === 'hat' || lane === 'openhat') return step % 4 === 0 ? 1 : step % 2 === 0 ? 0.78 : 0.6;
  return step % 4 === 0 ? 1 : 0.9;
}

export class Engine {
  constructor(song) {
    this.song = song;
    this.transport = Tone.getTransport();
    this.draw = Tone.getDraw();
    this.onStep = null; // UI callback(step), called in sync with the audio
    this.counter = 0;
    this.stutter = null;
    this.held = { chords: 0, bass: 0, lead: 0 };
    this.lastDrumMonitor = {};
    this.scheduledDrum = {};
    this.metronome = false;
    this.latency = 0; // extra user calibration, seconds

    // Master: echo throw -> DJ filters -> glue compressor -> limiter.
    this.master = new Tone.Gain(1);
    this.echo = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.45, wet: 0 });
    this.djHP = new Tone.Filter({ type: 'highpass', frequency: 10, rolloff: -24, Q: 1 });
    this.djLP = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -24, Q: 1 });
    this.comp = new Tone.Compressor({ threshold: -16, ratio: 2.5, attack: 0.015, release: 0.25, knee: 8 });
    this.limiter = new Tone.Limiter(-1);
    this.out = new Tone.Volume(0);
    this.master.chain(this.echo, this.djHP, this.djLP, this.comp, this.limiter, this.out, Tone.getDestination());

    this.reverb = new Tone.Reverb({ decay: 2.6, preDelay: 0.02, wet: 1 });
    this.reverbIn = new Tone.Filter({ type: 'highpass', frequency: 250 });
    this.reverbIn.chain(this.reverb, this.master);
    this.delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.38, wet: 1 });
    this.delayIn = new Tone.Filter({ type: 'bandpass', frequency: 1800, Q: 0.4 });
    this.delayIn.chain(this.delay, this.master);

    this.tracks = {};
    for (const t of TRACKS) {
      const filter = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -24, Q: 0.7 });
      const channel = new Tone.Channel();
      const rev = new Tone.Gain(0);
      const del = new Tone.Gain(0);
      filter.connect(channel);
      channel.connect(this.master);
      channel.connect(rev);
      channel.connect(del);
      rev.connect(this.reverbIn);
      del.connect(this.delayIn);
      this.tracks[t] = { filter, channel, rev, del, inst: null };
    }

    this.click = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.03 },
      volume: -14,
    }).connect(this.limiter);

    this.drums = new DrumKit(song.drums.kit, this.tracks.drums.filter);
    for (const t of ['chords', 'bass', 'lead']) this.setSound(t, song[t].sound, false);
    this.applyAll();

    this.transport.scheduleRepeat((time) => this.tick(time), '16n', 0);
  }

  get ready() {
    return Promise.all([this.drums.ready, this.reverb.ready, ...['chords', 'bass', 'lead'].map((t) => this.tracks[t].inst.ready)]);
  }

  // ---------- song / mixer ----------

  setSong(song) {
    this.song = song;
    if (this.drums.kit !== song.drums.kit) this.drums.load(song.drums.kit);
    for (const t of ['chords', 'bass', 'lead']) {
      if (this.tracks[t].soundId !== song[t].sound) this.setSound(t, song[t].sound, false);
    }
    this.applyAll();
  }

  // resetEnv: take the preset's own attack/release (when the user picks a new sound).
  setSound(track, id, resetEnv = true) {
    const tr = this.tracks[track];
    const old = tr.inst;
    if (old) {
      old.silence(Tone.now());
      setTimeout(() => old.dispose(), 3000);
    }
    const inst = createInstrument(track, id);
    inst.output.connect(tr.filter);
    tr.inst = inst;
    tr.soundId = id;
    const mix = this.song.mix[track];
    if (resetEnv || mix.attack === undefined) {
      mix.attack = inst.defaults.attack;
      mix.release = inst.defaults.release;
    }
    inst.setEnv(mix.attack, mix.release);
    inst.setGlide(mix.glide ?? 0);
    return inst.ready;
  }

  setKit(kit) {
    return this.drums.load(kit);
  }

  applyAll() {
    for (const t of ['chords', 'bass', 'lead']) {
      const mix = this.song.mix[t];
      if (mix.attack === undefined || mix.release === undefined) {
        mix.attack = this.tracks[t].inst.defaults.attack;
        mix.release = this.tracks[t].inst.defaults.release;
      }
    }
    for (const t of TRACKS) {
      for (const [k, v] of Object.entries(this.song.mix[t])) this.setMix(t, k, v);
    }
    for (const lane of DRUM_LANES) this.drums.setLaneVol(lane.id, this.song.drums.laneVol[lane.id]);
    this.applyMutes();
    this.transport.bpm.value = this.song.bpm;
    this.setSwing(this.song.swing);
  }

  setMix(track, key, v) {
    const tr = this.tracks[track];
    const mix = this.song.mix[track];
    mix[key] = v;
    switch (key) {
      case 'vol': tr.channel.volume.rampTo(sliderToDb(v), 0.05); break;
      case 'cutoff': tr.filter.frequency.rampTo(cutoffHz(v), 0.05); break;
      case 'reso': tr.filter.Q.rampTo(resoQ(v), 0.05); break;
      case 'reverb': tr.rev.gain.rampTo(v, 0.05); break;
      case 'delay': tr.del.gain.rampTo(v * 0.8, 0.05); break;
      case 'attack':
      case 'release': tr.inst?.setEnv(mix.attack, mix.release); break;
      case 'glide': tr.inst?.setGlide(v); break;
      case 'tune': this.drums.setTune(v); break;
    }
  }

  audible(track) {
    const anySolo = TRACKS.some((t) => this.song.solo[t]);
    return anySolo ? this.song.solo[track] : !this.song.mute[track];
  }

  applyMutes() {
    for (const t of TRACKS) this.tracks[t].channel.mute = !this.audible(t);
  }

  setSwing(v) {
    this.transport.swing = v;
    this.transport.swingSubdivision = '16n';
  }

  // -1 = lowpass all the way down, 0 = off, +1 = highpass all the way up.
  setDjFilter(x) {
    const lp = x < 0 ? 20000 * Math.pow(140 / 20000, -x) : 20000;
    const hp = x > 0 ? 20 * Math.pow(7000 / 20, x) : 10;
    const q = 1 + Math.abs(x) * 3;
    this.djLP.frequency.rampTo(lp, 0.04);
    this.djHP.frequency.rampTo(hp, 0.04);
    this.djLP.Q.rampTo(q, 0.04);
    this.djHP.Q.rampTo(q, 0.04);
  }

  setEcho(y) {
    this.echo.wet.rampTo(y * 0.55, 0.05);
    this.echo.feedback.rampTo(0.3 + y * 0.35, 0.05);
  }

  setMasterVol(v) {
    this.out.volume.rampTo(sliderToDb(v), 0.05);
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
    this.transport.position = 0;
    this.transport.start('+0.06');
    this._playing = true;
  }

  stop() {
    this._playing = false;
    this.transport.stop();
    const now = Tone.now();
    for (const t of ['chords', 'bass', 'lead']) this.tracks[t].inst.silence(now);
    this.draw.cancel();
    this.onStep?.(-1);
  }

  stepSeconds() {
    return this.transport.toSeconds('16n');
  }

  // Loop step the listener hears right now (fractional, not wrapped). Used for live recording.
  heardStepFloat() {
    const ctx = Tone.getContext().rawContext;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + this.latency;
    const ticks = this.transport.getTicksAtTime(Tone.immediate() - lat);
    return ticks / (this.transport.PPQ / 4);
  }

  setStutter(len) {
    this.stutter = len ? { len, anchor: null } : null;
  }

  // ---------- sequencer ----------

  tick(time) {
    const song = this.song;
    const steps = song.steps;
    let step = this.counter % steps;
    this.counter++;
    if (this.stutter) {
      if (this.stutter.anchor === null) this.stutter.anchor = step - (step % this.stutter.len);
      step = this.stutter.anchor + ((step - this.stutter.anchor + steps) % steps) % this.stutter.len;
    }

    if (this.audible('drums')) this.tickDrums(step, time);
    if (this.audible('chords') && !this.held.chords) this.tickChords(step, time);
    for (const t of ['bass', 'lead']) {
      if (this.audible(t) && !this.held[t]) this.tickMelodic(t, step, time);
    }
    if (this.metronome && step % 4 === 0) this.click.triggerAttackRelease(step % 16 === 0 ? 1760 : 1320, 0.03, time);

    if (this.onStep) this.draw.schedule(() => this.onStep(step), time);
  }

  tickDrums(step, time) {
    for (const lane of DRUM_LANES) {
      if (!this.song.drums.pattern[lane.id][step]) continue;
      // The user just tapped this drum live, do not double it.
      if (Math.abs(time - (this.lastDrumMonitor[lane.id] ?? -1)) < this.stepSeconds() * 0.6) continue;
      const src = this.drums.play(lane.id, time, drumVelocity(lane.id, step));
      if (src) this.scheduledDrum[lane.id] = { src, time };
    }
  }

  chordNotes(step) {
    const c = chordAtStep(this.song, step);
    if (c === null || c === undefined) return null;
    const chord = chordPalette(this.song.mood, this.song.key)[c];
    return { idx: c, chord, notes: voiceChord(chord) };
  }

  tickChords(step, time) {
    const cur = this.chordNotes(step);
    if (!cur) return;
    const inst = this.tracks.chords.inst;
    const sd = this.stepSeconds();
    const beats = this.song.chords.beats;
    const beat = Math.floor(step / 4);
    switch (this.song.chords.style) {
      case 'hold': {
        if (step % 4 !== 0 || (beat > 0 && beats[beat - 1] === cur.idx)) return;
        let run = 1;
        while (beat + run < beats.length && beats[beat + run] === cur.idx) run++;
        inst.play(cur.notes, time, run * 4 * sd - 0.02, 0.75);
        break;
      }
      case 'beats':
        if (step % 4 === 0) inst.play(cur.notes, time, 3 * sd, step % 16 === 0 ? 0.8 : 0.68);
        break;
      case 'offbeat':
        if (step % 4 === 2) inst.play(cur.notes, time, 1.2 * sd, 0.72);
        break;
      case 'syncop':
        if ([0, 3, 6].includes(step % 8)) inst.play(cur.notes, time, 2 * sd, step % 8 === 0 ? 0.8 : 0.66);
        break;
      case 'arp': {
        const arp = [...cur.notes, cur.notes[0] + 12];
        const note = arp[step % arp.length];
        inst.play([note], time, sd * 0.9, step % 4 === 0 ? 0.75 : 0.6);
        break;
      }
    }
  }

  resolveRow(track, rowIdx, step) {
    const row = melodicRows(track, this.song.mood, this.song.key, this.song.safe)[rowIdx];
    if (!row) return null;
    if (row.kind === 'note') return row.midi;
    const cur = this.chordNotes(step);
    const chord = cur ? cur.chord : chordPalette(this.song.mood, this.song.key)[0];
    return chordBassNote(chord, this.song.key, row.kind);
  }

  tickMelodic(track, step, time) {
    const notes = this.song[track].notes;
    const n = notes[step];
    if (!n) return;
    const midi = this.resolveRow(track, n.row, step);
    if (midi === null) return;
    // Mono synth: a note must end before the next one starts, otherwise its release cuts the next note.
    let dist = 1;
    while (dist < notes.length && !notes[(step + dist) % notes.length]) dist++;
    const len = Math.min(n.len, dist, notes.length - step);
    const sd = this.stepSeconds();
    const dur = len * sd - (len >= dist ? 0.008 : 0);
    const vel = track === 'bass' ? (step % 4 === 0 ? 0.95 : 0.8) : (step % 4 === 0 ? 0.85 : 0.75);
    this.tracks[track].inst.play(midi, time, dur, vel);
  }

  // ---------- live playing ----------

  hitDrum(lane) {
    const now = Tone.immediate();
    this.lastDrumMonitor[lane] = now;
    // If the sequencer already scheduled this drum a moment from now, the tap replaces it.
    const sch = this.scheduledDrum[lane];
    if (sch && sch.time > now - 0.005 && sch.time - now < this.stepSeconds() * 0.6) {
      try { sch.src.stop(now); } catch { /* already stopped */ }
    }
    this.drums.play(lane, now, 1);
  }

  // While a pad is held, the sequencer leaves that track alone so the two do not fight.
  noteOn(track, payload) {
    const inst = this.tracks[track].inst;
    const now = Tone.immediate();
    this.held[track]++;
    if (track === 'chords') {
      inst.start(payload, now, 0.8);
      return;
    }
    // Mono tracks: last pressed note wins, releasing it falls back to the one still held.
    (this.monoStack ??= { bass: [], lead: [] })[track].push(payload);
    inst.start(payload, now, 0.9);
  }

  noteOff(track, payload) {
    const inst = this.tracks[track].inst;
    const now = Tone.immediate();
    this.held[track] = Math.max(0, this.held[track] - 1);
    if (track === 'chords') {
      inst.stop(payload, now);
      return;
    }
    const stack = this.monoStack[track];
    const wasTop = stack[stack.length - 1] === payload;
    const i = stack.lastIndexOf(payload);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length) inst.stop(payload, now);
    else if (wasTop) inst.start(stack[stack.length - 1], now, 0.9);
  }
}

// ---------- export ----------

// Renders the song offline (faster than real time, sample exact) and returns a 16-bit WAV blob.
export async function renderWav(song, loops = 2, tail = 2.5) {
  const copy = JSON.parse(JSON.stringify(song));
  const loopSec = (copy.steps * 60) / copy.bpm / 4;
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
