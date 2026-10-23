import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOODS, SCALES, chordPalette, voiceChord, melodicRows, chordBassNote, registerRoot } from './theory.js';
import { newSong, normalizeSong, resizeSong, remapMelodies } from './song.js';
import { applyProgression, generateBass, generateLead, demoSong, setRandom, DRUM_PRESETS, applyDrumPreset } from './patterns.js';

const SOUNDS = { drums: ['tr909', 'tr808'], chords: ['piano', 'pad'], bass: ['pluck', 'sub'], lead: ['square'] };

test('palettes: six chords per mood, every chord tone inside the scale', () => {
  for (const [id, mood] of Object.entries(MOODS)) {
    for (let key = 0; key < 12; key++) {
      const pal = chordPalette(id, key);
      assert.equal(pal.length, 6, `${id} ${key}`);
      const scalePcs = SCALES[mood.scale].steps.map((s) => (s + key) % 12);
      for (const ch of pal) {
        for (const iv of ch.intervals) assert.ok(scalePcs.includes((ch.rootPc + iv) % 12), `${id} ${key} ${ch.name}`);
      }
      for (const p of mood.progressions) for (const c of p.chords) assert.ok(c < pal.length);
    }
  }
});

test('chord names', () => {
  assert.deepEqual(chordPalette('happy', 0).map((c) => c.name), ['C', 'Dm', 'Em', 'F', 'G', 'Am']);
  assert.deepEqual(chordPalette('sad', 9).map((c) => c.name), ['Am', 'C', 'Dm', 'Em', 'F', 'G']);
  assert.deepEqual(chordPalette('chill', 5).map((c) => c.name), ['Fmaj7', 'Gm7', 'Am7', 'Bbmaj7', 'C7', 'Dm7']);
  assert.deepEqual(chordPalette('funky', 7).map((c) => c.name), ['Gm7', 'Am7', 'Bbmaj7', 'C7', 'Dm7', 'Fmaj7']);
});

test('voicing stays in one octave window and keeps the chord tones', () => {
  for (const ch of chordPalette('night', 2)) {
    const v = voiceChord(ch);
    assert.ok(v[v.length - 1] - v[0] < 12);
    assert.ok(v.every((n) => n >= 54 && n < 66));
    assert.deepEqual(new Set(v.map((n) => n % 12)), new Set(ch.intervals.map((i) => (ch.rootPc + i) % 12)));
  }
});

test('melodic rows are in scale, ascending, and in a sane register', () => {
  for (const mood of Object.keys(MOODS)) {
    for (let key = 0; key < 12; key++) {
      for (const safe of [true, false]) {
        const scale = SCALES[MOODS[mood].scale];
        const pcs = (safe ? scale.penta : scale.steps).map((s) => (s + key) % 12);
        for (const t of ['bass', 'lead']) {
          const notes = melodicRows(t, mood, key, safe).filter((r) => r.kind === 'note').map((r) => r.midi);
          assert.ok(notes.every((n) => pcs.includes(n % 12)));
          assert.ok(notes.every((n, i) => i === 0 || n > notes[i - 1]));
          if (t === 'bass') assert.ok(notes[0] >= 28 && notes[0] < 40);
          else assert.ok(notes[0] >= 57 && notes[0] < 69 && notes[notes.length - 1] <= 93);
          assert.equal(notes[0] % 12, key);
        }
      }
    }
  }
});

test('chord-following bass notes are the chord root / fifth', () => {
  const pal = chordPalette('happy', 0);
  const g = pal[4]; // G
  assert.equal(chordBassNote(g, 0, 'root') % 12, 7);
  assert.equal(chordBassNote(g, 0, 'fifth') - chordBassNote(g, 0, 'root'), 7);
  assert.equal(registerRoot(0, 28), 36);
});

test('normalizeSong rejects junk and keeps valid data', () => {
  const s = normalizeSong({ steps: 999, bpm: 'x', mood: 'nope', drums: { kit: '<script>', pattern: { kick: [1, 'a', 0] } }, bass: { notes: [{ row: 99, len: 2 }, { row: 2, len: 500 }] } }, SOUNDS);
  assert.equal(s.steps, 32);
  assert.equal(s.bpm, 100);
  assert.equal(s.mood, 'happy');
  assert.equal(s.drums.kit, 'tr909');
  assert.deepEqual(s.drums.pattern.kick.slice(0, 3), [1, 1, 0]);
  assert.equal(s.drums.pattern.kick.length, 32);
  assert.equal(s.bass.notes[0], null);
  assert.deepEqual(s.bass.notes[1], { row: 2, len: 32 });
  const demo = demoSong();
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(demo)), SOUNDS).lead.notes, demo.lead.notes);
  assert.equal(normalizeSong(null, SOUNDS).steps, 32);
});

test('resize tiles when growing and cuts when shrinking', () => {
  const s = demoSong();
  const kick = [...s.drums.pattern.kick];
  resizeSong(s, 64);
  assert.equal(s.drums.pattern.kick.length, 64);
  assert.deepEqual(s.drums.pattern.kick.slice(32), kick);
  assert.equal(s.chords.beats.length, 16);
  assert.notEqual(s.bass.notes[32], s.bass.notes[0]); // copied, not shared
  resizeSong(s, 16);
  assert.equal(s.lead.notes.length, 16);
  assert.ok(s.lead.notes.every((n, i) => !n || i + n.len <= 16));
});

test('progressions spread over the loop', () => {
  const s = newSong();
  applyProgression(s, [0, 4, 5, 3]);
  assert.deepEqual(s.chords.beats, [0, 0, 4, 4, 5, 5, 3, 3]);
  resizeSong(s, 16);
  applyProgression(s, [0, 4, 5, 3]);
  assert.deepEqual(s.chords.beats, [0, 4, 5, 3]);
});

test('remap on key change transposes, on safe toggle keeps pitch', () => {
  const s = demoSong();
  const before = s.lead.notes.map((n) => n && n.row);
  const prev = { mood: s.mood, key: s.key, safe: s.safe };
  s.key = 2;
  remapMelodies(s, prev);
  assert.deepEqual(s.lead.notes.map((n) => n && n.row), before); // same degrees in D
  const rowsPenta = melodicRows('lead', s.mood, s.key, true);
  const pitches = s.lead.notes.map((n) => n && rowsPenta[n.row].midi);
  s.safe = false;
  remapMelodies(s, { mood: s.mood, key: s.key, safe: true });
  const rowsFull = melodicRows('lead', s.mood, s.key, false);
  assert.deepEqual(s.lead.notes.map((n) => n && rowsFull[n.row].midi), pitches); // penta is a subset of the full scale
});

test('generators produce valid notes that fit the chords', () => {
  let seed = 1;
  setRandom(() => ((seed = (seed * 16807) % 2147483647) / 2147483647));
  for (let i = 0; i < 50; i++) {
    const s = demoSong();
    s.mood = Object.keys(MOODS)[i % 5];
    s.key = i % 12;
    generateBass(s);
    generateLead(s);
    applyDrumPreset(s, DRUM_PRESETS[i % DRUM_PRESETS.length]);
    const rows = melodicRows('lead', s.mood, s.key, s.safe);
    const pal = chordPalette(s.mood, s.key);
    s.lead.notes.forEach((n, step) => {
      if (!n) return;
      assert.ok(n.row >= 0 && n.row < rows.length && n.len >= 1);
      if (step % 4 === 0) {
        const c = pal[s.chords.beats[Math.floor(step / 4)]];
        const pcs = c.intervals.map((iv) => (c.rootPc + iv) % 12);
        assert.ok(pcs.includes(rows[n.row].midi % 12), 'strong beat lands on a chord tone');
      }
    });
    assert.ok(s.bass.notes.some(Boolean));
    const bassRows = melodicRows('bass', s.mood, s.key, s.safe).length;
    assert.ok(s.bass.notes.every((n) => !n || (n.row < bassRows && n.len >= 1)));
  }
  setRandom(Math.random);
});
