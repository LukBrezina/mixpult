import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHORDS, LEAD_ROWS, BASS_ROWS, chordPcs, voiceChord, leadNote, bassNote } from './theory.js';
import { newSong, apply, normalizeSong, activeNote, LOOP, ROWS, SLOT } from './song.js';
import { DRUM_GROOVES, DRUM_LANES, layerLevel } from './patterns.js';
import { demoSong } from './demo.js';

test('chords are colour chords in F minor', () => {
  assert.deepEqual(CHORDS.map((c) => c.name), ['Fm9', 'Dbmaj7', 'Abmaj7', 'Ebadd9', 'Bbm7', 'Cm7']);
});

test('nothing can clash: every bass and lead row is a tone of the chord under it', () => {
  for (const chord of CHORDS) {
    const tones = chordPcs(chord);
    const voiced = voiceChord(chord);
    assert.ok(voiced.at(-1) - voiced[0] < 12 && voiced.length >= 3);
    for (let b = 0; b < BASS_ROWS; b++) {
      const bass = bassNote(chord, b);
      assert.ok(tones.includes(bass % 12), `bass row ${b} over ${chord.name}`);
      assert.ok(bass >= 29 && bass < 64);
    }
    for (let r = 0; r < LEAD_ROWS; r++) assert.ok(tones.includes(leadNote(chord, r) % 12), `${chord.name} lead row ${r}`);
  }
});

test('rows go up, and the same row stays in a similar place across chords', () => {
  for (const chord of CHORDS) {
    for (let r = 1; r < LEAD_ROWS; r++) assert.ok(leadNote(chord, r) > leadNote(chord, r - 1));
    for (let r = 1; r < BASS_ROWS; r++) assert.ok(bassNote(chord, r) > bassNote(chord, r - 1));
  }
  for (let r = 0; r < LEAD_ROWS; r++) {
    const notes = CHORDS.map((c) => leadNote(c, r));
    assert.ok(Math.max(...notes) - Math.min(...notes) <= 6, `row ${r} spread ${notes}`);
  }
  // Same knob height, different chord, (usually) a different note: that is the point.
  assert.notEqual(leadNote(CHORDS[0], 1), leadNote(CHORDS[5], 1));
});

test('apply validates ops', () => {
  const s = newSong();
  assert.equal(apply(s, { k: 'slot', t: 'chords', i: 15, v: 3 }), true);
  assert.equal(s.chords.slots[15], 3);
  assert.equal(apply(s, { k: 'slot', t: 'chords', i: LOOP / SLOT.chords, v: 0 }), false);
  assert.equal(apply(s, { k: 'slot', t: 'drums', i: 0, v: ROWS.drums }), false);
  assert.equal(apply(s, { k: 'slot', t: 'bass', i: 0, v: 0 }), false);
  assert.equal(apply(s, { k: 'x', t: 'lead', s: LOOP - 2, v: [0.2, 0.333] }), true);
  assert.deepEqual(s.lead.x.slice(LOOP - 2), [0.2, 0.33]);
  assert.equal(apply(s, { k: 'x', t: 'lead', s: LOOP - 1, v: [0.2, 0.3] }), false);
  assert.equal(apply(s, { k: 'x', t: 'lead', s: 0, v: [2] }), false);
  assert.equal(apply(s, { k: 'note', t: 'lead', s: 0, note: { row: LEAD_ROWS, len: 1 } }), false);
  assert.equal(apply(s, { k: 'note', t: 'drums', s: 0, note: { row: 0, len: 1 } }), false);
  assert.equal(apply(s, { k: 'vol', t: 'bass', v: 3 }), false);
  // Voice pads hold clip ids, nothing else.
  assert.equal(apply(s, { k: 'pad', i: 0, clip: '../x' }), false);
  assert.equal(apply(s, { k: 'pad', i: ROWS.voice, clip: 'ab12' }), false);
  assert.equal(apply(s, { k: 'pad', i: 2, clip: 'ab12' }), true);
  assert.equal(apply(s, { k: 'note', t: 'voice', s: 0, note: { row: 2, len: 4 } }), true);
  assert.equal(normalizeSong(JSON.parse(JSON.stringify(s))).voice.pads[2], 'ab12');
  assert.equal(apply(s, { k: 'bpm', v: 128 }), true);
  assert.equal(s.bpm, 128);
  assert.equal(apply(s, { k: 'bpm', v: 300 }), false);
  assert.equal(apply(s, { k: 'bpm', v: 128.5 }), false);
  assert.equal(apply(s, { k: 'whatever' }), false);
  assert.equal(apply(s, null), false);
});

test('mono notes: a long note swallows notes that start inside it, len is capped', () => {
  const s = newSong();
  apply(s, { k: 'note', t: 'lead', s: 4, note: { row: 1, len: 1 } });
  apply(s, { k: 'note', t: 'lead', s: 6, note: { row: 2, len: 1 } });
  apply(s, { k: 'note', t: 'lead', s: 2, note: { row: 3, len: 6 } });
  assert.deepEqual(s.lead.notes.slice(0, 8).map((n) => n && n.row), [null, null, 3, null, null, null, null, null]);
  apply(s, { k: 'note', t: 'lead', s: LOOP - 2, note: { row: 0, len: 9 } });
  assert.equal(s.lead.notes[LOOP - 2].len, 2);
  assert.deepEqual(activeNote(s.lead.notes, 5), { start: 2, note: s.lead.notes[2] });
  assert.equal(activeNote(s.lead.notes, 8), null);
  apply(s, { k: 'clear', t: 'lead' });
  assert.ok(s.lead.notes.every((n) => n === null));
});

test('normalizeSong: round trip and junk', () => {
  const demo = demoSong();
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(demo))), demo);
  assert.deepEqual(normalizeSong({ v: 2, bpm: 120 }), newSong());
  const junk = normalizeSong({ v: 3, chords: { slots: [99, 1, 'x', 2] }, lead: { notes: [{ row: -1, len: 2 }, { row: 2, len: 3 }], x: [5, 0.1] } });
  assert.deepEqual(junk.chords.slots.slice(0, 4), [0, 1, 0, 2]);
  assert.equal(junk.lead.notes[0], null);
  assert.deepEqual(junk.lead.notes[1], { row: 2, len: 3 });
  assert.deepEqual(junk.lead.x.slice(0, 2), [0.5, 0.1]);
});

test('drum grooves and energy layers', () => {
  assert.equal(DRUM_GROOVES.length, ROWS.drums);
  for (const g of DRUM_GROOVES) {
    for (const l of DRUM_LANES) assert.equal(g[l.id].length, 16);
    assert.ok(g.kick.some(Boolean));
  }
  // Far left: only the kick. Far right: everything. More energy never removes a layer.
  for (const l of DRUM_LANES) {
    assert.equal(layerLevel(l.layer, 0), l.layer === 0 ? 1 : 0);
    assert.equal(layerLevel(l.layer, 1), 1);
    for (let x = 0; x < 1; x += 0.05) assert.ok(layerLevel(l.layer, x + 0.05) >= layerLevel(l.layer, x));
  }
});
