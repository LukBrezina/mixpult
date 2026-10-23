// A full song for tests and level checks (render it and measure). Not offered in the app:
// people make their own.
import { newSong, apply, LOOP } from './song.js';

export function demoSong() {
  const song = newSong();
  [0, 0, 0, 0, 1, 1, 3, 3].forEach((v, i) => {
    apply(song, { k: 'slot', t: 'chords', i, v });
    apply(song, { k: 'slot', t: 'chords', i: i + 8, v });
  });
  // Rolling bass: off the kick, octave on the "and".
  for (let s = 0; s < LOOP; s++) if (s % 4) apply(song, { k: 'note', t: 'bass', s, note: { row: s % 8 === 3 ? 2 : 0, len: 1 } });
  // A 3-3-2 riff, answered every other bar.
  for (let b = 0; b < 8; b++) {
    const end = b % 2 ? 1 : 5;
    [[0, 4], [3, 4], [6, 5], [8, 3], [11, 3], [14, end]].forEach(([s, row]) => apply(song, { k: 'note', t: 'lead', s: b * 16 + s, note: { row, len: 2 } }));
  }
  return song;
}
