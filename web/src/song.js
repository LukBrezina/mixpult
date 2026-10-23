// Song data model. Every change goes through apply(song, op) with a small plain-object op,
// so a future co-op jam only has to send ops over the network.
import { CHORDS, LEAD_ROWS, BASS_ROWS, BPM } from './theory.js';
import { DRUM_GROOVES } from './patterns.js';

export const TRACKS = ['drums', 'chords', 'bass', 'lead', 'voice'];
export const BARS = 8;
export const LOOP = BARS * 16; // steps (16ths)

// Knob rows per track. Drums and chords are "slot" tracks: one value per slot, painted while
// recording. Bass, lead and voice are note tracks. Voice rows are launchpad pads, each holding a
// recorded clip (by id; the audio itself lives in IndexedDB).
export const VOICE_PADS = 6;
export const ROWS = { drums: DRUM_GROOVES.length, chords: CHORDS.length, bass: BASS_ROWS, lead: LEAD_ROWS, voice: VOICE_PADS };
const CLIP_ID = /^[a-z0-9]{1,24}$/;
export const SLOT = { drums: 16, chords: 8 }; // drums change per bar, chords per half bar
export const isSlotTrack = (t) => t in SLOT;
export const BPM_RANGE = [100, 160];

// Every track also records the knob's left/right position ("energy", 0..1) per step.
const X_DEFAULT = 0.5;

export function newSong() {
  const x = () => Array(LOOP).fill(X_DEFAULT);
  return {
    v: 3,
    bpm: BPM,
    drums: { slots: Array(LOOP / SLOT.drums).fill(2), x: x() },
    chords: { slots: Array(LOOP / SLOT.chords).fill(0), x: x() },
    bass: { notes: Array(LOOP).fill(null), x: x() },
    lead: { notes: Array(LOOP).fill(null), x: x() },
    voice: { pads: Array(VOICE_PADS).fill(null), notes: Array(LOOP).fill(null), x: x() },
    vol: { drums: 0.8, chords: 0.8, bass: 0.8, lead: 0.7, voice: 0.8 },
    mute: { drums: false, chords: false, bass: false, lead: false, voice: false },
  };
}

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v < hi;

function validNote(n, t) {
  return !!n && int(n.row, 0, ROWS[t]) && Number.isInteger(n.len) && n.len >= 1;
}

// Mono track: a note covers `len` steps, anything starting inside it is removed.
function writeNote(notes, s, note) {
  if (!note) {
    notes[s] = null;
    return;
  }
  const len = Math.min(note.len, notes.length - s);
  for (let k = 1; k < len; k++) notes[s + k] = null;
  notes[s] = { row: note.row, len };
}

// Applies one edit. Returns false for ops that are invalid (bad input from files or the network).
export function apply(song, op) {
  switch (op?.k) {
    case 'slot': // { t: drums|chords, i, v }
      if (!isSlotTrack(op.t) || !int(op.i, 0, LOOP / SLOT[op.t]) || !int(op.v, 0, ROWS[op.t])) return false;
      song[op.t].slots[op.i] = op.v;
      return true;
    case 'x': // { t, s, v: [x, x, ...] } energy from step s on
      if (!TRACKS.includes(op.t) || !int(op.s, 0, LOOP) || !Array.isArray(op.v) || op.s + op.v.length > LOOP) return false;
      if (!op.v.every((v) => num(v, 0, 1))) return false;
      op.v.forEach((v, i) => (song[op.t].x[op.s + i] = Math.round(v * 100) / 100));
      return true;
    case 'note': {
      if (isSlotTrack(op.t) || !ROWS[op.t] || !int(op.s, 0, LOOP)) return false;
      if (op.note && !validNote(op.note, op.t)) return false;
      writeNote(song[op.t].notes, op.s, op.note);
      return true;
    }
    case 'pad': // { i, clip: id or null } a voice pad got a new recording
      if (!int(op.i, 0, VOICE_PADS) || !(op.clip === null || (typeof op.clip === 'string' && CLIP_ID.test(op.clip)))) return false;
      song.voice.pads[op.i] = op.clip;
      return true;
    case 'clear':
      if (isSlotTrack(op.t) || !ROWS[op.t]) return false;
      song[op.t].notes = Array(LOOP).fill(null);
      return true;
    case 'bpm': // { v } whole beats per minute
      if (!Number.isInteger(op.v) || op.v < BPM_RANGE[0] || op.v > BPM_RANGE[1]) return false;
      song.bpm = op.v;
      return true;
    case 'vol':
      if (!TRACKS.includes(op.t) || !num(op.v, 0, 1)) return false;
      song.vol[op.t] = op.v;
      return true;
    case 'mute':
      if (!TRACKS.includes(op.t)) return false;
      song.mute[op.t] = !!op.v;
      return true;
    default:
      return false;
  }
}

// Builds a valid song from anything (saved file, localStorage) by replaying it as ops.
export function normalizeSong(raw) {
  const s = newSong();
  if (!raw || typeof raw !== 'object' || raw.v !== 3) return s;
  apply(s, { k: 'bpm', v: raw.bpm });
  for (const t of TRACKS) {
    const src = raw[t] || {};
    if (isSlotTrack(t)) (Array.isArray(src.slots) ? src.slots : []).forEach((v, i) => apply(s, { k: 'slot', t, i, v }));
    else (Array.isArray(src.notes) ? src.notes : []).forEach((note, i) => note && apply(s, { k: 'note', t, s: i, note }));
    if (Array.isArray(src.x)) src.x.slice(0, LOOP).forEach((v, i) => apply(s, { k: 'x', t, s: i, v: [v] }));
    apply(s, { k: 'vol', t, v: raw.vol?.[t] });
    if (t === 'voice') (Array.isArray(src.pads) ? src.pads : []).forEach((clip, i) => apply(s, { k: 'pad', i, clip }));
    apply(s, { k: 'mute', t, v: raw.mute?.[t] });
  }
  return s;
}

// The note sounding at `step` (it may have started earlier), with the step it started on.
export function activeNote(notes, step) {
  for (let s = step; s >= 0; s--) {
    const n = notes[s];
    if (n) return s + n.len > step ? { start: s, note: n } : null;
  }
  return null;
}
