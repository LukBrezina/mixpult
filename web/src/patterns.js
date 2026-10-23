// Ready-made patterns and "inspire me" generators for beginners.
import { DRUM_LANES, newSong } from './song.js';
import { MOODS, melodicRows, chordPalette, chordBassNote } from './theory.js';

// One bar (16 steps) per lane, x = hit. Tiled over the whole loop.
export const DRUM_PRESETS = [
  {
    name: 'Pop', lanes: {
      kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............',
    },
  },
  {
    name: 'House', lanes: {
      kick: 'x...x...x...x...', clap: '....x.......x...', hat: '..x...x...x...x.', openhat: '..............x.',
    },
  },
  {
    name: 'Hip-hop', lanes: {
      kick: 'x.........x..x..', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xx', rim: '.......x........',
    },
  },
  {
    name: 'Trap', lanes: {
      kick: 'x......x..x.....', clap: '........x.......', hat: 'x.xxx.x.x.xxx.xx', openhat: '..............x.',
    },
  },
  {
    name: 'Reggaeton', lanes: {
      kick: 'x...x...x...x...', snare: '...x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.',
    },
  },
  {
    name: 'Funk', lanes: {
      kick: 'x.x.......x..x..', snare: '....x..x.x..x...', hat: 'xxxxxxxxxxxxxxxx', openhat: '..............x.',
    },
  },
];

export function applyDrumPreset(song, preset) {
  for (const lane of DRUM_LANES) {
    const bar = preset.lanes[lane.id] || '................';
    song.drums.pattern[lane.id] = Array.from({ length: song.steps }, (_, i) => (bar[i % 16] === 'x' ? 1 : 0));
  }
}

// Spread a progression evenly over the loop (4 chords in 2 bars = 2 beats each).
export function applyProgression(song, chords) {
  const beats = song.steps / 4;
  song.chords.beats = Array.from({ length: beats }, (_, b) => chords[Math.floor((b * chords.length) / beats)]);
}

// Bass rhythms over 8 steps (half a bar): [step, rowKind, len]. 'oct' = root an octave up.
const BASS_GROOVES = [
  [[0, 'root', 2], [3, 'root', 1], [6, 'fifth', 2]],
  [[0, 'root', 1], [2, 'root', 1], [4, 'root', 1], [6, 'root', 1]],
  [[0, 'root', 3], [4, 'fifth', 1], [6, 'oct', 1]],
  [[0, 'root', 6], [7, 'root', 1]],
  [[2, 'root', 1], [6, 'root', 1]],
  [[0, 'root', 1], [3, 'oct', 1], [4, 'root', 1], [7, 'fifth', 1]],
];

let rng = Math.random;
export function setRandom(fn) {
  rng = fn;
}
const choice = (arr) => arr[Math.floor(rng() * arr.length)];

export function generateBass(song) {
  const groove = choice(BASS_GROOVES);
  const rows = melodicRows('bass', song.mood, song.key, song.safe);
  const notes = Array(song.steps).fill(null);
  const pal = chordPalette(song.mood, song.key);
  for (let base = 0; base < song.steps; base += 8) {
    for (const [off, kind, len] of groove) {
      const step = base + off;
      if (kind === 'oct') {
        // Octave of the chord root, found among the scale rows; fall back to the root row.
        const c = song.chords.beats[Math.floor(step / 4)];
        const target = c === null ? null : chordBassNote(pal[c], song.key, 'root') + 12;
        const idx = rows.findIndex((r) => r.kind === 'note' && r.midi === target);
        notes[step] = { row: idx >= 0 ? idx : 0, len };
      } else {
        notes[step] = { row: kind === 'root' ? 0 : 1, len };
      }
    }
  }
  song.bass.notes = notes;
}

// Lead rhythms over one bar: [step, len].
const LEAD_RHYTHMS = [
  [[0, 2], [2, 2], [4, 3], [8, 2], [10, 2], [12, 4]],
  [[0, 3], [3, 3], [6, 2], [10, 2], [12, 2], [14, 2]],
  [[0, 1], [2, 1], [4, 2], [7, 1], [8, 4], [14, 1]],
  [[2, 2], [4, 2], [6, 4], [12, 3]],
  [[0, 4], [6, 2], [8, 6]],
];

export function generateLead(song) {
  const rows = melodicRows('lead', song.mood, song.key, song.safe);
  const pal = chordPalette(song.mood, song.key);
  const rhythm = choice(LEAD_RHYTHMS);
  const notes = Array(song.steps).fill(null);
  let pos = Math.floor(rows.length / 2);
  for (let base = 0; base < song.steps; base += 16) {
    const last = base + 16 >= song.steps;
    rhythm.forEach(([off, len], idx) => {
      const step = base + off;
      // Mostly stepwise motion, sometimes a small leap.
      pos += choice([-2, -1, -1, 1, 1, 2, 0]);
      pos = Math.max(1, Math.min(rows.length - 2, pos));
      const c = song.chords.beats[Math.floor(step / 4)];
      if (c !== null && (off % 4 === 0 || (last && idx === rhythm.length - 1))) {
        // Strong beats land on a chord tone, which is what makes a melody sound "right".
        const pcs = pal[c].intervals.map((iv) => (pal[c].rootPc + iv) % 12);
        let best = pos;
        for (let d = 0; d < rows.length; d++) {
          const up = pos + d, down = pos - d;
          if (up < rows.length && pcs.includes(rows[up].midi % 12)) { best = up; break; }
          if (down >= 0 && pcs.includes(rows[down].midi % 12)) { best = down; break; }
        }
        pos = best;
      }
      notes[step] = { row: pos, len };
    });
  }
  song.lead.notes = notes;
}

export function demoSong() {
  const song = newSong();
  song.bpm = 104;
  song.mood = 'happy';
  song.key = MOODS.happy.key;
  song.chords.sound = 'piano';
  song.chords.style = 'syncop';
  song.bass.sound = 'pluck';
  song.lead.sound = 'square';
  applyDrumPreset(song, DRUM_PRESETS[0]);
  song.drums.pattern.clap[28] = 1;
  song.drums.pattern.openhat[30] = 1;
  song.drums.pattern.hat[30] = 0;
  applyProgression(song, MOODS.happy.progressions[0].chords);
  const notes = Array(song.steps).fill(null);
  for (const [s, row, len] of [[0, 0, 2], [3, 0, 1], [6, 1, 2], [8, 0, 2], [11, 0, 1], [14, 1, 2],
    [16, 0, 2], [19, 0, 1], [22, 1, 2], [24, 0, 2], [27, 0, 1], [30, 1, 2]]) notes[s] = { row, len };
  song.bass.notes = notes;
  const lead = Array(song.steps).fill(null);
  for (const [s, row, len] of [[0, 7, 2], [2, 6, 2], [4, 5, 3], [8, 6, 2], [10, 5, 2], [12, 3, 4],
    [16, 4, 2], [18, 5, 2], [20, 7, 3], [24, 6, 2], [26, 5, 2], [28, 4, 4]]) lead[s] = { row, len };
  song.lead.notes = lead;
  return song;
}
