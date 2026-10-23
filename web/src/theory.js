// Music theory helpers. Pure functions, no audio here, so they can be tested in node.

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Major keys spelled with flats: F, Bb, Eb, Ab, Db.
const FLAT_MAJOR_KEYS = new Set([5, 10, 3, 8, 1]);

export const KEYS = SHARP.map((name, pc) => ({ pc, name }));

export const SCALES = {
  major: { steps: [0, 2, 4, 5, 7, 9, 11], penta: [0, 2, 4, 7, 9], relMajor: 0 },
  minor: { steps: [0, 2, 3, 5, 7, 8, 10], penta: [0, 3, 5, 7, 10], relMajor: 3 },
  dorian: { steps: [0, 2, 3, 5, 7, 9, 10], penta: [0, 3, 5, 7, 10], relMajor: 10 },
};

// Palette indices refer to chordPalette() order (diatonic chords without the diminished one).
export const MOODS = {
  happy: {
    name: 'Veselá', scale: 'major', sevenths: false, key: 0,
    progressions: [
      { name: 'Pop hit', chords: [0, 4, 5, 3] },
      { name: 'Sentimentální', chords: [5, 3, 0, 4] },
      { name: 'Padesátky', chords: [0, 5, 3, 4] },
      { name: 'Hymna', chords: [3, 0, 4, 4] },
    ],
  },
  sad: {
    name: 'Smutná', scale: 'minor', sevenths: false, key: 9,
    progressions: [
      { name: 'Epická', chords: [0, 4, 1, 5] },
      { name: 'Melancholie', chords: [0, 2, 4, 3] },
      { name: 'Flamenco', chords: [0, 5, 4, 5] },
      { name: 'Filmová', chords: [4, 5, 0, 0] },
    ],
  },
  chill: {
    name: 'Chill / lo-fi', scale: 'major', sevenths: true, key: 5,
    progressions: [
      { name: 'Jazzová II-V-I', chords: [1, 4, 0, 0] },
      { name: 'Kavárna', chords: [3, 2, 1, 0] },
      { name: 'Neo soul', chords: [3, 4, 2, 5] },
      { name: 'Nedělní ráno', chords: [0, 3, 0, 3] },
    ],
  },
  night: {
    name: 'Noční', scale: 'minor', sevenths: true, key: 2,
    progressions: [
      { name: 'Půlnoc', chords: [0, 4, 3, 2] },
      { name: 'Město', chords: [0, 5, 4, 3] },
      { name: 'Deep house', chords: [0, 2, 0, 4] },
      { name: 'Synthwave', chords: [0, 4, 1, 5] },
    ],
  },
  funky: {
    name: 'Funky', scale: 'dorian', sevenths: true, key: 7,
    progressions: [
      { name: 'Funk', chords: [0, 3, 0, 3] },
      { name: 'Groove', chords: [0, 1, 2, 1] },
      { name: 'Disco', chords: [0, 5, 3, 0] },
      { name: 'Jam', chords: [0, 0, 3, 4] },
    ],
  },
};

const QUALITIES = {
  '0,4,7': { suffix: '', minor: false },
  '0,3,7': { suffix: 'm', minor: true },
  '0,4,7,11': { suffix: 'maj7', minor: false },
  '0,3,7,10': { suffix: 'm7', minor: true },
  '0,4,7,10': { suffix: '7', minor: false },
};

function useFlats(keyPc, scaleName) {
  return FLAT_MAJOR_KEYS.has((keyPc + SCALES[scaleName].relMajor) % 12);
}

export function pcName(pc, keyPc, scaleName) {
  return (useFlats(keyPc, scaleName) ? FLAT : SHARP)[((pc % 12) + 12) % 12];
}

export function midiName(midi, keyPc, scaleName) {
  return pcName(midi, keyPc, scaleName) + (Math.floor(midi / 12) - 1);
}

// Diatonic chords of the mood, stacked in thirds, diminished ones left out.
export function chordPalette(mood, keyPc) {
  const m = MOODS[mood];
  const steps = SCALES[m.scale].steps;
  const size = m.sevenths ? 4 : 3;
  const out = [];
  for (let deg = 0; deg < 7; deg++) {
    const rootOff = steps[deg];
    const intervals = [];
    for (let i = 0; i < size; i++) {
      const s = deg + i * 2;
      intervals.push(steps[s % 7] + 12 * Math.floor(s / 7) - rootOff);
    }
    const q = QUALITIES[intervals.join(',')];
    if (!q) continue; // diminished / half-diminished
    const rootPc = (keyPc + rootOff) % 12;
    out.push({
      degree: deg,
      rootPc,
      intervals,
      minor: q.minor,
      name: pcName(rootPc, keyPc, m.scale) + q.suffix,
    });
  }
  return out;
}

// Close voicing inside one octave window [lo, lo + 12), which keeps voice leading smooth.
export function voiceChord(chord, lo = 54) {
  return chord.intervals
    .map((iv) => {
      const pc = (chord.rootPc + iv) % 12;
      return lo + ((pc - lo) % 12 + 12) % 12;
    })
    .sort((a, b) => a - b);
}

// Lowest note of a register whose root lies in [from, from + 12).
export function registerRoot(keyPc, from) {
  return from + ((keyPc - from) % 12 + 12) % 12;
}

// Ascending scale notes starting from root, `count` notes long.
export function scaleRun(rootMidi, intervals, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(rootMidi + intervals[i % intervals.length] + 12 * Math.floor(i / intervals.length));
  }
  return out;
}

export const BASS_FROM = 28; // E1
export const LEAD_FROM = 57; // A3

// Rows of the melodic tracks, low to high. Bass gets two chord-following rows first.
export function melodicRows(track, mood, keyPc, safe) {
  const scale = SCALES[MOODS[mood].scale];
  const iv = safe ? scale.penta : scale.steps;
  if (track === 'bass') {
    const notes = scaleRun(registerRoot(keyPc, BASS_FROM), iv, iv.length + 3);
    return [
      { kind: 'root', label: 'Kořen' },
      { kind: 'fifth', label: 'Kvinta' },
      ...notes.map((midi) => ({ kind: 'note', midi })),
    ];
  }
  const notes = scaleRun(registerRoot(keyPc, LEAD_FROM), iv, iv.length * 2 + 1);
  return notes.map((midi) => ({ kind: 'note', midi }));
}

export function nearestIndex(list, value) {
  let best = 0;
  for (let i = 1; i < list.length; i++) {
    if (Math.abs(list[i] - value) < Math.abs(list[best] - value)) best = i;
  }
  return best;
}

// Bass note for a chord-following row: chord root in the bass register.
export function chordBassNote(chord, keyPc, kind) {
  const root = registerRoot(chord.rootPc, registerRoot(keyPc, BASS_FROM));
  return kind === 'fifth' ? root + 7 : root;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
