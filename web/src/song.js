// Song data model: defaults, validation of untrusted input (localStorage / imported files), resizing.
import { MOODS, melodicRows, nearestIndex, chordPalette } from './theory.js';

export const TRACKS = ['drums', 'chords', 'bass', 'lead'];

export const DRUM_LANES = [
  { id: 'kick', name: 'Kopák' },
  { id: 'snare', name: 'Virbl' },
  { id: 'clap', name: 'Tlesk' },
  { id: 'hat', name: 'Hi-hat' },
  { id: 'openhat', name: 'Otevřený hat' },
  { id: 'tom', name: 'Tom' },
  { id: 'rim', name: 'Rimshot' },
  { id: 'crash', name: 'Činel' },
];

export const STEP_OPTIONS = [16, 32, 64];
export const CHORD_STYLES = [
  { id: 'hold', name: 'Držet' },
  { id: 'beats', name: 'Na doby' },
  { id: 'offbeat', name: 'Offbeat' },
  { id: 'syncop', name: 'Synkopy' },
  { id: 'arp', name: 'Arpeggio' },
];

export const DEFAULT_LANE_VOL = { kick: 1, snare: 0.8, clap: 0.7, hat: 0.5, openhat: 0.45, tom: 0.7, rim: 0.6, crash: 0.4 };

const DEFAULT_MIX = {
  drums: { vol: 0.8, cutoff: 1, reso: 0, reverb: 0.08, delay: 0, tune: 0 },
  chords: { vol: 0.7, cutoff: 1, reso: 0, reverb: 0.3, delay: 0.05 },
  bass: { vol: 0.75, cutoff: 1, reso: 0, reverb: 0, delay: 0, glide: 0.03 },
  lead: { vol: 0.65, cutoff: 1, reso: 0, reverb: 0.25, delay: 0.2, glide: 0 },
};

export function newSong() {
  const steps = 32;
  const song = {
    v: 1,
    bpm: 100,
    swing: 0,
    steps,
    mood: 'happy',
    key: MOODS.happy.key,
    safe: true,
    drums: { kit: 'tr909', pattern: {}, laneVol: { ...DEFAULT_LANE_VOL } },
    chords: { sound: 'piano', style: 'hold', beats: Array(steps / 4).fill(null) },
    bass: { sound: 'pluck', notes: Array(steps).fill(null) },
    lead: { sound: 'square', notes: Array(steps).fill(null) },
    mix: {},
    mute: { drums: false, chords: false, bass: false, lead: false },
    solo: { drums: false, chords: false, bass: false, lead: false },
  };
  for (const lane of DRUM_LANES) song.drums.pattern[lane.id] = Array(steps).fill(0);
  for (const t of TRACKS) song.mix[t] = { ...DEFAULT_MIX[t] };
  return song;
}

const clamp = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

// Builds a valid song from anything (old saves, hand-edited JSON). Unknown fields are dropped.
export function normalizeSong(raw, sounds) {
  const s = newSong();
  if (!raw || typeof raw !== 'object') return s;
  s.steps = pick(raw.steps, STEP_OPTIONS, s.steps);
  s.bpm = Math.round(clamp(raw.bpm, 60, 180, s.bpm));
  s.swing = clamp(raw.swing, 0, 0.6, 0);
  s.mood = pick(raw.mood, Object.keys(MOODS), s.mood);
  s.key = Math.round(clamp(raw.key, 0, 11, MOODS[s.mood].key));
  s.safe = raw.safe !== false;

  const d = raw.drums || {};
  s.drums.kit = pick(d.kit, sounds.drums, s.drums.kit);
  for (const lane of DRUM_LANES) {
    const src = Array.isArray(d.pattern?.[lane.id]) ? d.pattern[lane.id] : [];
    s.drums.pattern[lane.id] = Array.from({ length: s.steps }, (_, i) => (src[i] ? 1 : 0));
    s.drums.laneVol[lane.id] = clamp(d.laneVol?.[lane.id], 0, 1, DEFAULT_LANE_VOL[lane.id]);
  }

  const c = raw.chords || {};
  const palSize = chordPalette(s.mood, s.key).length;
  s.chords.sound = pick(c.sound, sounds.chords, s.chords.sound);
  s.chords.style = pick(c.style, CHORD_STYLES.map((x) => x.id), s.chords.style);
  s.chords.beats = Array.from({ length: s.steps / 4 }, (_, i) => {
    const v = c.beats?.[i];
    return Number.isInteger(v) && v >= 0 && v < palSize ? v : null;
  });

  for (const t of ['bass', 'lead']) {
    const src = raw[t] || {};
    const rows = melodicRows(t, s.mood, s.key, s.safe).length;
    s[t].sound = pick(src.sound, sounds[t], s[t].sound);
    s[t].notes = Array.from({ length: s.steps }, (_, i) => {
      const n = src.notes?.[i];
      if (!n || !Number.isInteger(n.row) || n.row < 0 || n.row >= rows) return null;
      return { row: n.row, len: Math.round(clamp(n.len, 1, s.steps, 1)) };
    });
  }

  for (const t of TRACKS) {
    const m = raw.mix?.[t] || {};
    for (const k of Object.keys(s.mix[t])) {
      const hi = k === 'tune' ? 12 : k === 'glide' ? 0.3 : 1;
      const lo = k === 'tune' ? -12 : 0;
      s.mix[t][k] = clamp(m[k], lo, hi, s.mix[t][k]);
    }
    if (typeof m.attack === 'number') s.mix[t].attack = clamp(m.attack, 0.001, 3, undefined);
    if (typeof m.release === 'number') s.mix[t].release = clamp(m.release, 0.01, 5, undefined);
    s.mute[t] = raw.mute?.[t] === true;
    s.solo[t] = raw.solo?.[t] === true;
  }
  return s;
}

function tile(arr, len) {
  return Array.from({ length: len }, (_, i) => arr[i % arr.length]);
}

// Longer loop repeats what is already there, shorter loop cuts the end off.
export function resizeSong(song, steps) {
  if (steps === song.steps) return;
  const grow = steps > song.steps;
  for (const lane of DRUM_LANES) {
    song.drums.pattern[lane.id] = grow ? tile(song.drums.pattern[lane.id], steps) : song.drums.pattern[lane.id].slice(0, steps);
  }
  song.chords.beats = grow ? tile(song.chords.beats, steps / 4) : song.chords.beats.slice(0, steps / 4);
  for (const t of ['bass', 'lead']) {
    const notes = grow ? tile(song[t].notes, steps).map((n) => (n ? { ...n } : null)) : song[t].notes.slice(0, steps);
    song[t].notes = notes.map((n, i) => (n ? { ...n, len: Math.min(n.len, steps - i) } : null));
  }
  song.steps = steps;
}

// Switching mood/key/safe mode: keep melodies as close in pitch as possible.
export function remapMelodies(song, prev) {
  for (const t of ['bass', 'lead']) {
    const oldRows = melodicRows(t, prev.mood, prev.key, prev.safe);
    const newRows = melodicRows(t, song.mood, song.key, song.safe);
    const newNoteRows = newRows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'note');
    song[t].notes = song[t].notes.map((n) => {
      if (!n) return null;
      const old = oldRows[n.row];
      if (!old) return null;
      if (old.kind !== 'note') return n; // chord-following rows stay as they are
      // Same key: keep pitch. Key change: keep the scale degree (transpose).
      const target = song.key === prev.key ? old.midi : old.midi + (newRows.find((r) => r.kind === 'note').midi - oldRows.find((r) => r.kind === 'note').midi);
      const idx = nearestIndex(newNoteRows.map((x) => x.r.midi), target);
      return { ...n, row: newNoteRows[idx].i };
    });
  }
  const palSize = chordPalette(song.mood, song.key).length;
  song.chords.beats = song.chords.beats.map((c) => (c !== null && c < palSize ? c : null));
}

export function chordAtStep(song, step) {
  return song.chords.beats[Math.floor(step / 4) % song.chords.beats.length];
}

export function isEmpty(song) {
  return (
    DRUM_LANES.every((l) => song.drums.pattern[l.id].every((v) => !v)) &&
    song.chords.beats.every((c) => c === null) &&
    song.bass.notes.every((n) => !n) &&
    song.lead.notes.every((n) => !n)
  );
}
