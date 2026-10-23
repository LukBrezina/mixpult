// Music theory for one fixed vibe: catchy night techno in F minor.
// Bass and lead rows are relative to the current chord, so the same pad plays a different
// note over a different chord, keeps its up/down position, and never clashes.

export const KEY = 5; // F
export const SCALE = [0, 2, 3, 5, 7, 8, 10]; // natural minor
export const BPM = 130;

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const pcName = (pc) => NAMES[((pc % 12) + 12) % 12];

const SCALE_PCS = SCALE.map((s) => (KEY + s) % 12);

// Hand-picked diatonic colour chords (sevenths and ninths) that make good techno stabs.
// [scale degree, intervals above the root, suffix]
const PALETTE = [
  [0, [0, 3, 7, 10, 14], 'm9'], // i     Fm9
  [5, [0, 4, 7, 11], 'maj7'], // bVI   Dbmaj7
  [2, [0, 4, 7, 11], 'maj7'], // III   Abmaj7
  [6, [0, 4, 7, 14], 'add9'], // bVII  Ebadd9
  [3, [0, 3, 7, 10], 'm7'], // iv    Bbm7
  [4, [0, 3, 7, 10], 'm7'], // v     Cm7
];

export const CHORDS = PALETTE.map(([deg, intervals, suffix]) => {
  const rootPc = (KEY + SCALE[deg]) % 12;
  return { rootPc, intervals, minor: intervals[1] === 3, name: pcName(rootPc) + suffix };
});

export const chordPcs = (chord) => chord.intervals.map((iv) => (chord.rootPc + iv) % 12);

// Close voicing inside one octave window [lo, lo + 12): smooth voice leading for free.
// From middle C up, so the chords sit above the bass instead of fighting it.
// Five-note chords drop the root (the bass plays it), which keeps the pad from getting muddy.
export function voiceChord(chord, lo = 60) {
  const pcs = chordPcs(chord);
  return (pcs.length > 4 ? pcs.slice(1) : pcs)
    .map((pc) => lo + ((pc - lo) % 12 + 12) % 12)
    .sort((a, b) => a - b);
}

export const LEAD_ROWS = 8;
export const BASS_ROWS = 4;
const LEAD_FROM = 65; // F4
const BASS_FROM = 29; // F1, 44 Hz

// Row 0 = lowest. Lead rows walk up through the chord's own tones (7ths and 9ths included):
// rich enough for a synthwave hook, impossible to hit a sour note, and every chord moves the pads.
// Four tones per chord (the m9 leaves its 9th to the pad), so all chords climb at the same rate.
export function leadNote(chord, row) {
  const pcs = chordPcs(chord).slice(0, 4);
  let n = LEAD_FROM;
  let found = -1;
  while (true) {
    if (pcs.includes(n % 12) && ++found === row) return n;
    n++;
  }
}

// Bass rows: root, fifth, octave, octave + fifth. Chord tones only, the root sits in F1..E2.
export function bassNote(chord, row) {
  const root = BASS_FROM + ((chord.rootPc - BASS_FROM) % 12 + 12) % 12;
  return root + [0, 7, 12, 19][row];
}

export const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
