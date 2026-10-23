// Drum grooves for the drums knob (up/down picks a groove, left/right adds layers).

export const DRUM_LANES = [
  { id: 'kick', layer: 0 },
  { id: 'clap', layer: 1 },
  { id: 'snare', layer: 1 },
  { id: 'hat', layer: 2 },
  { id: 'openhat', layer: 3 },
  { id: 'tom', layer: 3 },
];

const bar = (s) => [...s].map((c) => (c === 'x' ? 1 : 0));

// Bottom of the knob = the most broken-up groove, top = the most driving one.
export const DRUM_GROOVES = [
  { kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.xxx.x.x.xxx.x.', openhat: '..............x.', tom: '.......x......x.' },
  { kick: 'x...x...x...x...', clap: '....x.......x...', hat: '..x...x...x...x.', openhat: '..............x.', tom: '...x.......x....' },
  { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'xx.xxx.xxx.xxx.x', openhat: '..x...x...x...x.' },
  { kick: 'x...x...x...x...', clap: '....x.......x...', snare: '...........x.x.x', hat: 'xxxxxxxxxxxxxxxx', openhat: '..x...x...x...x.', tom: '.x.......x......' },
].map((g) => Object.fromEntries(DRUM_LANES.map((l) => [l.id, bar(g[l.id] || '................')])));

// How loud each layer is for a given energy x (0..1): the kick is always there,
// claps fade in first, then hats, then open hats and percussion.
const LAYER_RAMPS = [null, [0.04, 0.22], [0.28, 0.5], [0.6, 0.85]];
export function layerLevel(layer, x) {
  const r = LAYER_RAMPS[layer];
  if (!r) return 1;
  return Math.min(1, Math.max(0, (x - r[0]) / (r[1] - r[0])));
}
