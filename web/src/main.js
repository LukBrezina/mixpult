import './style.css';
import * as Tone from 'tone';
import { Engine, cutoffHz, renderWav } from './engine.js';
import { SOUNDS, SOUND_IDS } from './sounds.js';
import {
  newSong, normalizeSong, resizeSong, remapMelodies, isEmpty, chordAtStep,
  DRUM_LANES, TRACKS, CHORD_STYLES, STEP_OPTIONS,
} from './song.js';
import { MOODS, KEYS, chordPalette, voiceChord, melodicRows, pcName } from './theory.js';
import { DRUM_PRESETS, applyDrumPreset, applyProgression, generateBass, generateLead, demoSong } from './patterns.js';
import { el, knob, expMap, xyPad } from './ui.js';

const STORAGE_KEY = 'mixpult.song.v1';
// Home row first, then the top row (without R, which toggles recording) for longer scales.
const PAD_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote',
  'KeyQ', 'KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'];
const keyLabels = { Semicolon: ';', Quote: "'" };
for (const code of PAD_KEYS) if (code.startsWith('Key')) keyLabels[code] = code.slice(3);
const CHORD_COLORS = ['#ff7a6b', '#ffb454', '#f5dd5c', '#7fe09a', '#5cc4ff', '#b49bff'];

const TABS = [
  {
    id: 'drums', name: 'Bicí', color: 'var(--c-drums)',
    hint: 'Pusť smyčku (mezerník) a ťukej do rytmu klávesami A, S, D… nebo klikej na tlačítka. Co ťukneš, uloží se do smyčky. Do mřížky můžeš i rovnou klikat. Nevíš, kde začít? Vyber hotový rytmus.',
  },
  {
    id: 'chords', name: 'Akordy', color: 'var(--c-chords)',
    hint: 'Všechny tyhle akordy k sobě ladí. Během přehrávání akord drž – hraje tak dlouho, jak dlouho držíš klávesu. Nebo vyber akord a maluj ho do řádku dole. Obvykle stačí 4 akordy.',
  },
  {
    id: 'bass', name: 'Basa', color: 'var(--c-bass)',
    hint: 'Každé tlačítko je ve stupnici, takže nic nezní falešně. „Kořen akordu“ hraje vždy základní tón právě znějícího akordu – nejjistější volba. Delší držení = delší tón.',
  },
  {
    id: 'lead', name: 'Melodie', color: 'var(--c-lead)',
    hint: 'Jako basa, jen výš. Svítící řádky jsou tóny právě hrajícího akordu – na nich melodie zní nejlíp, hlavně na začátku doby. Klikni a táhni v mřížce pro delší tón.',
  },
  {
    id: 'fx', name: 'Šmrdlátka', color: 'var(--c-fx)',
    hint: 'Teď jsi DJ. Táhni po ploše: doleva tlumíš výšky, doprava ubíráš basy, nahoru přidáváš ozvěnu. Drž tlačítka „zaseknout“ pro efekt opakování. Pusť a vše se vrátí.',
  },
];
const TRACK_COLOR = Object.fromEntries(TABS.map((t) => [t.id, t.color]));
const TRACK_NAME = Object.fromEntries(TABS.map((t) => [t.id, t.name]));

// ---------- state ----------

let song = loadSong();
const engine = new Engine(song);
let tab = 'drums';
let rec = true;
let pen = 0; // chord used when painting the chord lane, null = eraser
let playStep = -1;
let chordRec = null; // chord being recorded while its pad is held
const perf = { dj: 0, echo: 0, master: 0.9, spring: true };
const undoStack = [];
let lastCheckpoint = { tag: null, t: 0 };
const padHandlers = new Map(); // key code -> { down(): release fn, el }
const heldKeys = new Map(); // key code -> release fn
let view = {}; // references into the current panel, for fast playhead updates

function loadSong() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeSong(JSON.parse(raw), SOUND_IDS);
  } catch {
    /* broken or blocked storage: start fresh */
  }
  return newSong();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(song));
    } catch {
      /* storage full or blocked, the song still lives in memory */
    }
  }, 300);
}

// Undo snapshot. Same tag within 2 s is merged, so one recording pass is one undo step.
function checkpoint(tag = null) {
  const now = performance.now();
  if (tag && tag === lastCheckpoint.tag && now - lastCheckpoint.t < 2000) {
    lastCheckpoint.t = now;
    return;
  }
  undoStack.push(JSON.stringify(song));
  if (undoStack.length > 120) undoStack.shift();
  lastCheckpoint = { tag, t: now };
  document.getElementById('undo').disabled = false;
}

function undo() {
  const snap = undoStack.pop();
  document.getElementById('undo').disabled = !undoStack.length;
  if (!snap) return;
  replaceSong(normalizeSong(JSON.parse(snap), SOUND_IDS));
  toast('Vráceno zpět');
}

function replaceSong(s) {
  song = s;
  chordRec = null;
  engine.setSong(song);
  renderAll();
  save();
}

// Something in the song changed: persist and refresh what shows it.
function changed({ panel = false } = {}) {
  save();
  renderOverview();
  renderTabs();
  if (panel) renderPanel();
  else view.refresh?.();
}

const mod = (a, n) => ((a % n) + n) % n;
const recording = () => rec && engine.playing;
const palette = () => chordPalette(song.mood, song.key);

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- header ----------

const $ = (id) => document.getElementById(id);

function initHeader() {
  $('play').addEventListener('click', togglePlay);
  $('rec').addEventListener('click', toggleRec);
  $('metro').addEventListener('click', toggleMetro);
  $('undo').addEventListener('click', undo);
  $('undo').disabled = true;

  $('bpm').addEventListener('input', (e) => {
    checkpoint('bpm');
    song.bpm = Number(e.target.value);
    engine.transport.bpm.rampTo(song.bpm, 0.1);
    $('bpm-out').textContent = song.bpm;
    save();
  });
  $('swing').addEventListener('input', (e) => {
    checkpoint('swing');
    song.swing = Number(e.target.value);
    engine.setSwing(song.swing);
    $('swing-out').textContent = `${Math.round(song.swing * 100)} %`;
    save();
  });

  for (const [id, mood] of Object.entries(MOODS)) $('mood').append(el('option', { value: id }, mood.name));
  for (const k of KEYS) $('key').append(el('option', { value: k.pc }, k.name));
  $('mood').addEventListener('change', (e) => setHarmony(e.target.value, song.key));
  $('key').addEventListener('change', (e) => setHarmony(song.mood, Number(e.target.value)));

  const lengthNames = { 16: '1 takt', 32: '2 takty', 64: '4 takty' };
  for (const n of STEP_OPTIONS) {
    $('length').append(el('button', {
      dataset: { steps: n },
      title: `${n} kroků`,
      onclick: () => {
        if (n === song.steps) return;
        checkpoint();
        resizeSong(song, n);
        changed({ panel: true });
        updateHeader();
      },
    }, lengthNames[n]));
  }

  $('latency').addEventListener('input', (e) => {
    engine.latency = Number(e.target.value) / 1000;
    $('latency-out').textContent = `${e.target.value} ms`;
    try { localStorage.setItem('mixpult.latency', e.target.value); } catch { /* ignore */ }
  });
  try {
    const lat = Number(localStorage.getItem('mixpult.latency') || 0);
    $('latency').value = lat;
    engine.latency = lat / 1000;
  } catch { /* ignore */ }
  $('latency-out').textContent = `${$('latency').value} ms`;

  $('menu').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    $('menu').open = false;
    menuAction(act);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu')) $('menu').open = false;
  });
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      checkpoint();
      replaceSong(normalizeSong(data, SOUND_IDS));
      toast('Písnička načtena');
    } catch {
      toast('Tohle není písnička z Mixpultu');
    }
  });
}

function updateHeader() {
  $('bpm').value = song.bpm;
  $('bpm-out').textContent = song.bpm;
  $('swing').value = song.swing;
  $('swing-out').textContent = `${Math.round(song.swing * 100)} %`;
  $('mood').value = song.mood;
  $('key').value = song.key;
  for (const b of $('length').children) b.classList.toggle('on', Number(b.dataset.steps) === song.steps);
  $('play').classList.toggle('playing', engine.playing);
  $('play').setAttribute('aria-label', engine.playing ? 'Zastavit' : 'Přehrát');
  $('rec').classList.toggle('on', rec);
  $('metro').classList.toggle('on', engine.metronome);
  document.body.classList.toggle('is-recording', recording());
}

function setHarmony(mood, key) {
  checkpoint();
  const prev = { mood: song.mood, key: song.key, safe: song.safe };
  song.mood = mood;
  song.key = key;
  remapMelodies(song, prev);
  changed({ panel: true });
  updateHeader();
}

async function menuAction(act) {
  if (act === 'demo') {
    checkpoint();
    replaceSong(demoSong());
    toast('Ukázka načtena – zmáčkni mezerník');
  } else if (act === 'new') {
    checkpoint();
    stop();
    replaceSong(newSong());
    engine.metronome = true;
    updateHeader();
    setTab('drums');
    toast('Čistý list. Začni bicími.');
  } else if (act === 'save') {
    const blob = new Blob([JSON.stringify(song, null, 1)], { type: 'application/json' });
    download(blob, 'mixpult-pisnicka.json');
  } else if (act === 'open') {
    $('file').click();
  } else if (act === 'record') {
    if (isEmpty(song)) {
      toast('Nejdřív něco nahraj :)');
      return;
    }
    toast('Vyrábím WAV…');
    const blob = await renderWav(song, 2);
    download(blob, `mixpult-${new Date().toISOString().slice(0, 10)}.wav`);
    toast('Hotovo, nahrávka se stahuje');
  }
}

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- transport ----------

async function togglePlay() {
  if (engine.playing) stop();
  else {
    await engine.ready;
    await engine.start();
    updateHeader();
  }
}

function stop() {
  engine.stop();
  chordRec = null;
  updateHeader();
}

function toggleRec() {
  rec = !rec;
  updateHeader();
  toast(rec ? 'Nahrávání zapnuto – ťukání se uloží' : 'Nahrávání vypnuto – můžeš si jen tak hrát');
}

function toggleMetro() {
  engine.metronome = !engine.metronome;
  updateHeader();
}

engine.onStep = (step) => {
  playStep = step;
  if (step >= 0 && step % 4 === 0 && chordRec) continueChordRec(step / 4);
  view.playhead?.(step);
  overviewPlayhead(step);
};

// ---------- overview ----------

function renderOverview() {
  const ov = $('overview');
  const steps = song.steps;
  const pal = palette();
  ov.replaceChildren();
  view.ovHeads = [];
  for (const t of TRACKS) {
    const lane = el('div', { class: 'ov-lane', style: { gridTemplateColumns: `repeat(${steps}, 1fr)` } });
    for (let s = 0; s < steps; s++) {
      const cell = el('div', { class: `ov-cell${s % 16 === 0 ? ' bar' : s % 4 === 0 ? ' beat' : ''}` });
      if (t === 'drums') {
        const hits = DRUM_LANES.filter((l) => song.drums.pattern[l.id][s]).length;
        if (hits) cell.style.setProperty('--fill', String(0.35 + hits * 0.2));
      } else if (t === 'chords') {
        const c = song.chords.beats[Math.floor(s / 4)];
        if (c !== null) {
          cell.style.background = CHORD_COLORS[c];
          cell.classList.add('chord');
          if (s % 4 === 0 && (s === 0 || song.chords.beats[s / 4 - 1] !== c)) {
            cell.append(el('span', { class: 'ov-chord-name' }, pal[c].name));
          }
        }
      }
      lane.append(cell);
    }
    if (t === 'bass' || t === 'lead') {
      const rows = melodicRows(t, song.mood, song.key, song.safe).length;
      song[t].notes.forEach((n, s) => {
        if (!n) return;
        lane.append(el('div', {
          class: 'ov-note',
          style: { gridColumn: `${s + 1} / span ${Math.min(n.len, steps - s)}`, '--y': String(1 - n.row / (rows - 1)) },
        }));
      });
    }
    const head = el('div', { class: 'ov-head' });
    lane.append(head);
    view.ovHeads.push(head);
    const audible = engine.audible(t);
    ov.append(el('div', { class: `ov-row${tab === t ? ' sel' : ''}${audible ? '' : ' muted'}`, style: { '--c': TRACK_COLOR[t] } },
      el('button', { class: 'ov-name', onclick: () => setTab(t) }, TRACK_NAME[t]),
      el('button', { class: `ov-btn${song.mute[t] ? ' on' : ''}`, title: 'Ztlumit', onclick: () => toggleMute(t) }, 'M'),
      el('button', { class: `ov-btn solo${song.solo[t] ? ' on' : ''}`, title: 'Jen tahle stopa', onclick: () => toggleSolo(t) }, 'S'),
      lane));
  }
  overviewPlayhead(playStep);
}

function overviewPlayhead(step) {
  for (const h of view.ovHeads || []) {
    h.style.display = step < 0 ? 'none' : 'block';
    h.style.gridColumn = String(step + 1);
  }
}

function toggleMute(t) {
  song.mute[t] = !song.mute[t];
  engine.applyMutes();
  changed({ panel: tab === 'fx' });
}

function toggleSolo(t) {
  song.solo[t] = !song.solo[t];
  engine.applyMutes();
  changed({ panel: tab === 'fx' });
}

// ---------- tabs ----------

function hasContent(t) {
  if (t === 'drums') return DRUM_LANES.some((l) => song.drums.pattern[l.id].some(Boolean));
  if (t === 'chords') return song.chords.beats.some((c) => c !== null);
  if (t === 'bass' || t === 'lead') return song[t].notes.some(Boolean);
  return false;
}

function renderTabs() {
  $('tabs').replaceChildren(...TABS.map((t, i) => el('button', {
    class: `tab${tab === t.id ? ' sel' : ''}${hasContent(t.id) ? ' done' : ''}`,
    style: { '--c': t.color },
    onclick: () => setTab(t.id),
  }, el('span', { class: 'tab-num' }, hasContent(t.id) ? '✓' : String(i + 1)), el('span', { class: 'tab-name' }, t.name))));
}

function setTab(id) {
  if (tab === id) return;
  tab = id;
  renderTabs();
  renderOverview();
  renderPanel();
}

// ---------- shared panel pieces ----------

function keyLabel(code) {
  return keyLabels[code] || code;
}

// Pad button that works with mouse, touch and keyboard. down() returns the release function.
function pad({ code, label, sub, color, cls = '', down }) {
  const b = el('button', { class: `pad ${cls}`, style: color ? { '--pad': color } : undefined },
    el('span', { class: 'pad-label' }, label),
    sub ? el('span', { class: 'pad-sub' }, sub) : null,
    code ? el('kbd', {}, keyLabel(code)) : null);
  let release = null;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    b.classList.add('pressed');
    release = down();
  });
  const up = () => {
    b.classList.remove('pressed');
    release?.();
    release = null;
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  if (code) padHandlers.set(code, { down, el: b });
  return b;
}

function flash(node) {
  if (!node) return;
  node.classList.remove('hit');
  void node.offsetWidth;
  node.classList.add('hit');
}

function chips(items, selected, onPick, cls = '') {
  return el('div', { class: `chips ${cls}` }, ...items.map((it) => el('button', {
    class: `chip${it.id === selected ? ' on' : ''}`,
    title: it.hint || '',
    onclick: () => onPick(it.id),
  }, it.name, it.hint ? el('small', {}, it.hint) : null)));
}

function section(title, ...children) {
  return el('section', { class: 'block' }, title ? el('h3', {}, title) : null, ...children);
}

const fmtHz = (v) => {
  const hz = cutoffHz(v);
  return v > 0.995 ? 'otevřený' : hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
};
const fmtSec = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`);
const fmtPct = (v) => `${Math.round(v * 100)}`;

function trackKnobs(t) {
  const mix = song.mix[t];
  const k = (key, label, opts = {}) => knob({
    label, value: mix[key], color: TRACK_COLOR[t], format: fmtPct, ...opts,
    onInput: (v) => {
      checkpoint(`knob-${t}-${key}`);
      engine.setMix(t, key, v);
      save();
    },
  });
  const list = [
    k('vol', 'Hlasitost', { dflt: 0.75 }),
    k('cutoff', 'Jas', { dflt: 1, format: fmtHz }),
    k('reso', 'Rezonance', { dflt: 0 }),
  ];
  if (t === 'drums') {
    list.push(k('tune', 'Ladění', { min: -12, max: 12, dflt: 0, bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}` }));
  } else {
    list.push(k('attack', 'Náběh', { map: expMap(0.001, 2), format: fmtSec, dflt: engine.tracks[t].inst.defaults.attack }));
    list.push(k('release', 'Doznění', { map: expMap(0.02, 5), format: fmtSec, dflt: engine.tracks[t].inst.defaults.release }));
  }
  if (t === 'bass' || t === 'lead') list.push(k('glide', 'Klouzání', { max: 0.3, dflt: 0, format: fmtSec }));
  list.push(k('reverb', 'Hall', { dflt: 0.2 }), k('delay', 'Ozvěna', { dflt: 0 }));
  return section('Zvuk', el('div', { class: 'knobs' }, ...list));
}

function soundPicker(t) {
  if (t === 'drums') {
    return chips(SOUNDS.drums, song.drums.kit, async (id) => {
      checkpoint();
      song.drums.kit = id;
      changed({ panel: true });
      await engine.setKit(id);
      if (!engine.playing) engine.drums.play('kick', Tone.immediate());
    }, 'sound-chips');
  }
  return chips(SOUNDS[t], song[t].sound, async (id) => {
    checkpoint();
    song[t].sound = id;
    const ready = engine.setSound(t, id);
    changed({ panel: true });
    await ready;
    if (!engine.playing) previewTrack(t);
  }, 'sound-chips');
}

function previewTrack(t) {
  const now = Tone.immediate();
  const inst = engine.tracks[t].inst;
  if (t === 'chords') inst.play(voiceChord(palette()[pen ?? 0]), now, 0.8, 0.75);
  else inst.play(melodicRows(t, song.mood, song.key, song.safe).find((r) => r.kind === 'note').midi + (t === 'bass' ? 12 : 0), now, 0.3, 0.85);
}

function panelHead(t) {
  const meta = TABS.find((x) => x.id === t);
  return el('div', { class: 'panel-head', style: { '--c': meta.color } },
    el('h2', {}, el('span', { class: 'step-badge' }, String(TABS.indexOf(meta) + 1)), meta.name),
    el('p', { class: 'hint' }, meta.hint));
}

// Grid with columns per step, plus ruler and a playhead overlay. Returns { wrap, grid, cells, head }.
function stepGrid({ rows, cols, stepPerCol = 1, rowLabels, cls }) {
  const colTpl = `repeat(${cols}, minmax(var(--cell-min), 1fr))`;
  const ruler = el('div', { class: 'ruler', style: { gridTemplateColumns: colTpl } });
  const colsPerBeat = 4 / stepPerCol;
  for (let c = 0; c < cols; c += colsPerBeat) {
    const step = c * stepPerCol;
    const bar = Math.floor(step / 16) + 1;
    const beat = Math.floor((step % 16) / 4) + 1;
    ruler.append(el('span', { class: beat === 1 ? 'bar' : '', style: { gridColumn: `${c + 1} / span ${colsPerBeat}` } }, beat === 1 ? `takt ${bar}` : String(beat)));
  }
  const grid = el('div', { class: `grid ${cls}`, style: { gridTemplateColumns: colTpl, gridTemplateRows: `repeat(${rows}, var(--row-h))` } });
  const cells = [];
  for (let r = 0; r < rows; r++) {
    cells.push([]);
    for (let c = 0; c < cols; c++) {
      const step = c * stepPerCol;
      const cell = el('div', {
        class: `cell${Math.floor(step / 4) % 2 ? ' odd' : ''}${step % 16 === 0 ? ' bar' : step % 4 === 0 ? ' beat' : ''}`,
        dataset: { r, c },
        style: { gridRow: String(r + 1), gridColumn: String(c + 1) },
      });
      cells[r].push(cell);
      grid.append(cell);
    }
  }
  const head = el('div', { class: 'playhead', style: { gridRow: '1 / -1', display: 'none' } });
  grid.append(head);
  const labels = el('div', { class: 'row-labels', style: { gridTemplateRows: `repeat(${rows}, var(--row-h))` } }, ...rowLabels);
  const wrap = el('div', { class: `editor editor-${cls.split(' ')[0]}` }, el('div', { class: 'row-labels-col' }, el('div', { class: 'ruler-spacer' }), labels),
    el('div', { class: 'grid-scroll' }, ruler, grid));
  const setHead = (step) => {
    head.style.display = step < 0 ? 'none' : 'block';
    if (step >= 0) head.style.gridColumn = String(Math.floor(step / stepPerCol) + 1);
  };
  return { wrap, grid, cells, setHead };
}

// Pointer painting over grid cells (mouse drag and touch).
function paintable(grid, { start, move, end }) {
  let active = false;
  let last = null;
  const cellAt = (e) => document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList?.contains('cell') && grid.contains(n));
  grid.addEventListener('contextmenu', (e) => e.preventDefault());
  grid.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest?.('.cell') || cellAt(e);
    if (!cell && !e.target.closest('.note')) return;
    e.preventDefault();
    grid.setPointerCapture(e.pointerId);
    active = start(e, cell) !== false;
    last = cell;
  });
  grid.addEventListener('pointermove', (e) => {
    if (!active) return;
    const cell = cellAt(e);
    if (cell && cell !== last) {
      last = cell;
      move(e, cell);
    }
  });
  const stop = () => {
    if (!active) return;
    active = false;
    end?.();
  };
  grid.addEventListener('pointerup', stop);
  grid.addEventListener('pointercancel', stop);
}

// ---------- drums ----------

function drumDown(lane) {
  engine.hitDrum(lane);
  if (recording()) {
    const step = mod(Math.round(engine.heardStepFloat()), song.steps);
    if (!song.drums.pattern[lane][step]) {
      checkpoint('rec-drums');
      song.drums.pattern[lane][step] = 1;
      changed();
    }
  }
  return null;
}

function drumsPanel() {
  const pads = DRUM_LANES.map((lane, i) => pad({ code: PAD_KEYS[i], label: lane.name, color: 'var(--c-drums)', down: () => drumDown(lane.id) }));

  const labels = DRUM_LANES.map((lane) => {
    const vol = el('input', {
      type: 'range', min: 0, max: 1, step: 0.01, value: song.drums.laneVol[lane.id], class: 'lane-vol', title: 'Hlasitost',
      oninput: (e) => {
        checkpoint(`lanevol-${lane.id}`);
        song.drums.laneVol[lane.id] = Number(e.target.value);
        engine.drums.setLaneVol(lane.id, song.drums.laneVol[lane.id]);
        save();
      },
    });
    return el('div', { class: 'row-label' },
      el('button', { class: 'lane-name', onclick: () => engine.drums.play(lane.id, Tone.immediate()) }, lane.name), vol);
  });
  const g = stepGrid({ rows: DRUM_LANES.length, cols: song.steps, rowLabels: labels, cls: 'drum-grid' });

  const refresh = () => {
    DRUM_LANES.forEach((lane, r) => {
      song.drums.pattern[lane.id].forEach((v, s) => g.cells[r][s].classList.toggle('on', !!v));
    });
  };
  let paintVal = 1;
  let touched = false;
  const paint = (cell) => {
    const lane = DRUM_LANES[Number(cell.dataset.r)].id;
    const s = Number(cell.dataset.c);
    if (song.drums.pattern[lane][s] === paintVal) return;
    if (!touched) checkpoint();
    touched = true;
    song.drums.pattern[lane][s] = paintVal;
    cell.classList.toggle('on', !!paintVal);
    if (paintVal && !engine.playing) engine.drums.play(lane, Tone.immediate());
  };
  paintable(g.grid, {
    start: (e, cell) => {
      if (!cell) return false;
      touched = false;
      const lane = DRUM_LANES[Number(cell.dataset.r)].id;
      paintVal = e.button === 2 ? 0 : song.drums.pattern[lane][Number(cell.dataset.c)] ? 0 : 1;
      paint(cell);
    },
    move: (_e, cell) => paint(cell),
    end: () => touched && changed(),
  });
  refresh();

  view.refresh = refresh;
  view.playhead = (step) => {
    g.setHead(step);
    if (step < 0) return;
    DRUM_LANES.forEach((lane, i) => {
      if (song.drums.pattern[lane.id][step] && engine.audible('drums')) flash(pads[i]);
    });
  };

  const presets = el('div', { class: 'tool-row' },
    el('span', { class: 'tool-label' }, 'Hotové rytmy'),
    ...DRUM_PRESETS.map((p) => el('button', {
      class: 'chip small',
      onclick: () => {
        checkpoint();
        applyDrumPreset(song, p);
        changed();
        toast(`Rytmus ${p.name} – uprav si ho po svém`);
      },
    }, p.name)),
    el('button', { class: 'chip small danger', onclick: () => clearTrack('drums') }, 'Vymazat bicí'));

  return [
    panelHead('drums'),
    section('Bicí souprava', soundPicker('drums')),
    section(null, presets),
    section('Ťukej', el('div', { class: 'pads drums' }, ...pads)),
    section('Smyčka', g.wrap),
    trackKnobs('drums'),
  ];
}

function clearTrack(t) {
  checkpoint();
  if (t === 'drums') for (const l of DRUM_LANES) song.drums.pattern[l.id].fill(0);
  else if (t === 'chords') song.chords.beats.fill(null);
  else song[t].notes.fill(null);
  changed();
}

// ---------- chords ----------

function chordDown(i) {
  pen = i;
  view.markPen?.();
  const notes = voiceChord(palette()[i]);
  engine.noteOn('chords', notes);
  if (recording()) {
    checkpoint('rec-chords');
    const abs = Math.round(engine.heardStepFloat() / 4);
    chordRec = { idx: i, start: abs, writes: [] };
    writeChordBeat(abs);
  }
  return () => {
    engine.noteOff('chords', notes);
    if (chordRec?.idx === i) finishChordRec();
  };
}

function writeChordBeat(abs) {
  const beats = song.chords.beats;
  const b = mod(abs, beats.length);
  if (chordRec.writes.some((w) => w.abs === abs)) return;
  chordRec.writes.push({ abs, b, prev: beats[b] });
  beats[b] = chordRec.idx;
  changed();
}

// Called on every beat while a chord pad is held during recording.
function continueChordRec() {
  if (!engine.playing) return;
  writeChordBeat(Math.round(engine.heardStepFloat() / 4));
}

// Release slightly after a beat started should not claim that beat.
function finishChordRec() {
  const end = Math.round(engine.heardStepFloat() / 4);
  const rec = chordRec;
  chordRec = null;
  if (!rec) return;
  for (const w of [...rec.writes].reverse()) {
    if (w.abs > rec.start && w.abs >= end) song.chords.beats[w.b] = w.prev;
  }
  changed();
}

function chordsPanel() {
  const pal = palette();
  const padEls = pal.map((ch, i) => pad({
    code: PAD_KEYS[i], label: ch.name, sub: ch.minor ? 'smutnější' : 'veselejší', color: CHORD_COLORS[i], cls: 'chord-pad', down: () => chordDown(i),
  }));
  const eraser = pad({
    code: PAD_KEYS[pal.length], label: 'Ticho', sub: 'guma', cls: 'chord-pad eraser',
    down: () => {
      pen = null;
      view.markPen?.();
      return null;
    },
  });
  const markPen = () => {
    padEls.forEach((p, i) => p.classList.toggle('selected', pen === i));
    eraser.classList.toggle('selected', pen === null);
  };
  view.markPen = markPen;
  markPen();

  const beatsN = song.steps / 4;
  const g = stepGrid({ rows: 1, cols: beatsN, stepPerCol: 4, rowLabels: [el('div', { class: 'row-label' }, 'Akordy')], cls: 'chord-grid' });
  const blocks = [];
  const refresh = () => {
    for (const b of blocks.splice(0)) b.remove();
    const beats = song.chords.beats;
    let i = 0;
    while (i < beatsN) {
      const c = beats[i];
      let run = 1;
      while (i + run < beatsN && beats[i + run] === c) run++;
      if (c !== null) {
        const blk = el('div', { class: 'chord-block', style: { gridRow: '1', gridColumn: `${i + 1} / span ${run}`, '--chord': CHORD_COLORS[c] } },
          el('span', {}, pal[c].name), run > 1 ? el('small', {}, `${run} doby`) : null);
        g.grid.insertBefore(blk, g.grid.lastChild);
        blocks.push(blk);
      }
      i += run;
    }
  };
  let touched = false;
  let paintVal = 0;
  const paint = (cell) => {
    const b = Number(cell.dataset.c);
    if (song.chords.beats[b] === paintVal) return;
    if (!touched) checkpoint();
    touched = true;
    song.chords.beats[b] = paintVal;
    refresh();
  };
  paintable(g.grid, {
    start: (e, cell) => {
      if (!cell) return false;
      touched = false;
      paintVal = e.button === 2 ? null : pen;
      paint(cell);
      if (paintVal !== null && !engine.playing) engine.tracks.chords.inst.play(voiceChord(pal[paintVal]), Tone.immediate(), 0.6, 0.7);
    },
    move: (_e, cell) => paint(cell),
    end: () => touched && changed(),
  });
  refresh();
  view.refresh = refresh;
  let lastChord = null;
  view.playhead = (step) => {
    g.setHead(step);
    const c = step < 0 ? null : chordAtStep(song, step);
    if (c !== lastChord) {
      lastChord = c;
      padEls.forEach((p, i) => p.classList.toggle('sounding', i === c));
    }
  };

  const progressions = el('div', { class: 'tool-row' },
    el('span', { class: 'tool-label' }, 'Hotové postupy'),
    ...MOODS[song.mood].progressions.map((p) => el('button', {
      class: 'chip small',
      onclick: () => {
        checkpoint();
        applyProgression(song, p.chords);
        changed();
        toast(`${p.name}: ${p.chords.map((c) => pal[c].name).join(' → ')}`);
      },
    }, p.name, el('small', {}, p.chords.map((c) => pal[c].name).join(' '))),
    ),
    el('button', { class: 'chip small danger', onclick: () => clearTrack('chords') }, 'Vymazat akordy'));

  const styles = chips(CHORD_STYLES, song.chords.style, (id) => {
    checkpoint();
    song.chords.style = id;
    changed({ panel: true });
  }, 'style-chips');

  return [
    panelHead('chords'),
    section('Nástroj', soundPicker('chords')),
    section('Jak hrát', styles),
    section(null, progressions),
    section(`Akordy v náladě „${MOODS[song.mood].name}“`, el('div', { class: 'pads chords' }, ...padEls, eraser)),
    section('Smyčka', g.wrap),
    trackKnobs('chords'),
  ];
}

// ---------- bass & lead ----------

function melodicDown(t, r) {
  const stepNow = engine.playing ? mod(Math.round(engine.heardStepFloat()), song.steps) : 0;
  const midi = engine.resolveRow(t, r, stepNow);
  engine.noteOn(t, midi);
  const startF = recording() ? engine.heardStepFloat() : null;
  return () => {
    engine.noteOff(t, midi);
    if (startF === null || !engine.playing) return;
    const start = Math.round(startF);
    const len = Math.min(song.steps, Math.max(1, Math.round(engine.heardStepFloat()) - start));
    checkpoint(`rec-${t}`);
    writeNote(t, mod(start, song.steps), r, len);
    changed();
  };
}

// Mono track: a new note replaces whatever starts inside its length.
function writeNote(t, s, row, len) {
  const notes = song[t].notes;
  len = Math.min(len, notes.length - s);
  for (let k = 1; k < len; k++) notes[s + k] = null;
  notes[s] = { row, len };
}

function melodicPanel(t) {
  const rows = melodicRows(t, song.mood, song.key, song.safe);
  const R = rows.length;
  const rowName = (row) => (row.kind === 'note' ? pcName(row.midi, song.key, MOODS[song.mood].scale) : row.label);
  const rowOct = (row) => (row.kind === 'note' ? String(Math.floor(row.midi / 12) - 1) : 'akordu');
  const color = TRACK_COLOR[t];

  const padEls = rows.map((row, r) => pad({
    code: PAD_KEYS[r], label: rowName(row), sub: rowOct(row), color,
    cls: row.kind !== 'note' ? 'special' : '', down: () => melodicDown(t, r),
  }));

  // Display top = highest note; special bass rows at the very bottom.
  const disp = (r) => R - 1 - r;
  const labels = rows.map((_, i) => {
    const row = rows[R - 1 - i];
    return el('div', { class: `row-label${row.kind !== 'note' ? ' special' : ''}` },
      el('span', { class: 'note-name' }, rowName(row)), el('small', {}, rowOct(row)));
  });
  const g = stepGrid({ rows: R, cols: song.steps, rowLabels: labels, cls: `note-grid ${t}` });
  let noteEls = [];
  const refresh = () => {
    for (const n of noteEls) n.remove();
    noteEls = [];
    song[t].notes.forEach((n, s) => {
      if (!n) return;
      const len = Math.min(n.len, song.steps - s);
      const ne = el('div', {
        class: `note${rows[n.row]?.kind !== 'note' ? ' special' : ''}`,
        dataset: { s },
        style: { gridRow: String(disp(n.row) + 1), gridColumn: `${s + 1} / span ${len}` },
      });
      g.grid.insertBefore(ne, g.grid.lastChild);
      noteEls.push(ne);
    });
  };

  let drag = null;
  paintable(g.grid, {
    start: (e, cell) => {
      const noteEl = e.target.closest('.note');
      checkpoint();
      if (noteEl || (e.button === 2 && cell)) {
        // Click on a note (or right click anywhere on its row start) deletes it.
        const s = noteEl ? Number(noteEl.dataset.s) : Number(cell.dataset.c);
        song[t].notes[s] = null;
        refresh();
        changed();
        return false;
      }
      const s = Number(cell.dataset.c);
      const r = R - 1 - Number(cell.dataset.r);
      writeNote(t, s, r, 1);
      drag = { s, r };
      refresh();
      if (!engine.playing) engine.tracks[t].inst.play(engine.resolveRow(t, r, s), Tone.immediate(), 0.25, 0.85);
      return true;
    },
    move: (_e, cell) => {
      if (!drag) return;
      const len = Math.max(1, Number(cell.dataset.c) - drag.s + 1);
      writeNote(t, drag.s, drag.r, len);
      refresh();
    },
    end: () => {
      drag = null;
      changed();
    },
  });
  refresh();
  view.refresh = refresh;

  const nowChord = el('span', { class: 'now-chord' }, '–');
  let lastChord;
  const lightChordTones = (c) => {
    const pal = palette();
    const pcs = c === null || c === undefined ? [] : pal[c].intervals.map((iv) => (pal[c].rootPc + iv) % 12);
    rows.forEach((row, r) => {
      const lit = row.kind !== 'note' ? c !== null && c !== undefined : pcs.includes(row.midi % 12);
      labels[disp(r)].classList.toggle('chord-tone', lit);
      padEls[r].classList.toggle('chord-tone', lit);
    });
    nowChord.textContent = c === null || c === undefined ? '–' : pal[c].name;
    nowChord.style.setProperty('--chord', c === null || c === undefined ? 'transparent' : CHORD_COLORS[c]);
  };
  view.playhead = (step) => {
    g.setHead(step);
    const c = chordAtStep(song, Math.max(0, step));
    if (c !== lastChord) {
      lastChord = c;
      lightChordTones(c);
    }
    if (step >= 0) {
      const n = song[t].notes[step];
      if (n && engine.audible(t)) flash(padEls[n.row]);
    }
  };
  lightChordTones(chordAtStep(song, Math.max(0, playStep)));

  const tools = el('div', { class: 'tool-row' },
    el('button', {
      class: 'chip small accent',
      onclick: () => {
        checkpoint();
        if (t === 'bass') generateBass(song);
        else generateLead(song);
        changed();
        toast(song.chords.beats.every((c) => c === null) ? 'Tip: s akordy to bude znít ještě líp' : 'Vymyšleno – klikni znovu pro jinou verzi');
      },
    }, '🎲 Vymysli za mě'),
    el('label', { class: 'switch', title: 'Pentatonika: 5 tónů, které zní dobře vždycky' },
      el('input', {
        type: 'checkbox', checked: song.safe,
        onchange: (e) => {
          checkpoint();
          const prev = { mood: song.mood, key: song.key, safe: song.safe };
          song.safe = e.target.checked;
          remapMelodies(song, prev);
          changed({ panel: true });
        },
      }),
      el('span', {}, 'Jen bezpečné tóny')),
    el('button', { class: 'chip small danger', onclick: () => clearTrack(t) }, t === 'bass' ? 'Vymazat basu' : 'Vymazat melodii'));

  return [
    panelHead(t),
    section('Nástroj', soundPicker(t)),
    section(null, tools),
    section(null, el('div', { class: 'pads-head' }, el('h3', {}, 'Hraj'), el('div', { class: 'now' }, 'Teď hraje akord ', nowChord)),
      el('div', { class: `pads melodic ${t}` }, ...padEls)),
    section('Smyčka', g.wrap),
    trackKnobs(t),
  ];
}

// ---------- fx ----------

const STUTTERS = [
  { len: 4, name: 'Zaseknout', sub: 'po dobách' },
  { len: 2, name: 'Zaseknout', sub: 'po osminách' },
  { len: 1, name: 'Zaseknout', sub: 'po šestnáctinách' },
];

function fxPanel() {
  const dj = knob({
    label: 'DJ filtr', value: perf.dj, min: -1, max: 1, dflt: 0, bipolar: true, size: 'lg', color: 'var(--c-fx)',
    format: (v) => (v < -0.02 ? 'tlumí výšky' : v > 0.02 ? 'ubírá basy' : 'vypnuto'),
    onInput: (v) => {
      perf.dj = v;
      engine.setDjFilter(v);
      xy.set(v / 2 + 0.5, perf.echo);
    },
  });
  const echo = knob({
    label: 'Ozvěna', value: perf.echo, dflt: 0, size: 'lg', color: 'var(--c-fx)', format: fmtPct,
    onInput: (v) => {
      perf.echo = v;
      engine.setEcho(v);
      xy.set(perf.dj / 2 + 0.5, v);
    },
  });
  const master = knob({
    label: 'Celková hlasitost', value: perf.master, dflt: 0.9, size: 'lg', color: 'var(--c-fx)', format: fmtPct,
    onInput: (v) => {
      perf.master = v;
      engine.setMasterVol(v);
    },
  });
  const xy = xyPad({
    labels: { left: '◀ tlumit výšky', right: 'ubrat basy ▶', top: '▲ ozvěna', bottom: '' },
    home: [0.5, 0],
    spring: () => perf.spring,
    onMove: (x, y) => {
      perf.dj = (x - 0.5) * 2;
      perf.echo = y;
      engine.setDjFilter(perf.dj);
      engine.setEcho(perf.echo);
      dj.set(perf.dj);
      echo.set(perf.echo);
    },
  });
  xy.set(perf.dj / 2 + 0.5, perf.echo);

  const stutterPads = STUTTERS.map((st, i) => pad({
    code: PAD_KEYS[i], label: st.name, sub: st.sub, color: 'var(--c-fx)', cls: 'fx-pad',
    down: () => {
      engine.setStutter(st.len);
      return () => engine.setStutter(null);
    },
  }));

  const strips = TRACKS.map((t) => {
    const mk = (key, label) => knob({
      label, value: song.mix[t][key], color: TRACK_COLOR[t], format: fmtPct, size: 'sm',
      onInput: (v) => {
        checkpoint(`knob-${t}-${key}`);
        engine.setMix(t, key, v);
        save();
      },
    });
    return el('div', { class: `strip${engine.audible(t) ? '' : ' muted'}`, style: { '--c': TRACK_COLOR[t] } },
      el('div', { class: 'strip-name' }, TRACK_NAME[t]),
      mk('vol', 'Hlasitost'), mk('cutoff', 'Jas'), mk('reverb', 'Hall'), mk('delay', 'Ozvěna'),
      el('div', { class: 'strip-btns' },
        el('button', { class: `ov-btn${song.mute[t] ? ' on' : ''}`, onclick: () => toggleMute(t) }, 'M'),
        el('button', { class: `ov-btn solo${song.solo[t] ? ' on' : ''}`, onclick: () => toggleSolo(t) }, 'S')));
  });

  const spring = el('label', { class: 'switch' },
    el('input', { type: 'checkbox', checked: perf.spring, onchange: (e) => (perf.spring = e.target.checked) }),
    el('span', {}, 'Po puštění vrátit na střed'));
  const reset = el('button', {
    class: 'chip small',
    onclick: () => {
      perf.dj = 0;
      perf.echo = 0;
      engine.setDjFilter(0);
      engine.setEcho(0);
      renderPanel();
    },
  }, 'Vypnout efekty');

  view.refresh = null;
  view.playhead = null;

  return [
    panelHead('fx'),
    el('div', { class: 'fx-layout' },
      section('Efektová plocha', xy, el('div', { class: 'tool-row' }, spring, reset)),
      el('div', { class: 'fx-side' },
        section('Knoflíky', el('div', { class: 'knobs' }, dj, echo, master)),
        section('Drž pro efekt', el('div', { class: 'pads fx' }, ...stutterPads)))),
    section('Mixpult', el('div', { class: 'mixer' }, ...strips)),
  ];
}

// ---------- render ----------

function renderPanel() {
  padHandlers.clear();
  view = { ovHeads: view.ovHeads };
  const build = { drums: drumsPanel, chords: chordsPanel, bass: () => melodicPanel('bass'), lead: () => melodicPanel('lead'), fx: fxPanel }[tab];
  const p = $('panel');
  p.style.setProperty('--c', TRACK_COLOR[tab]);
  p.replaceChildren(...build());
  view.playhead?.(playStep);
}

function renderAll() {
  updateHeader();
  renderTabs();
  renderOverview();
  renderPanel();
}

// ---------- keyboard ----------

function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['range', 'checkbox'].includes(t.type)));
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  if (e.metaKey || e.ctrlKey) {
    if (e.code === 'KeyZ') {
      e.preventDefault();
      undo();
    }
    return;
  }
  if (e.altKey) return;
  const h = padHandlers.get(e.code);
  if (e.repeat) {
    if (h || e.code === 'Space') e.preventDefault();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (/^Digit[1-5]$/.test(e.code)) {
    setTab(TABS[Number(e.code.slice(5)) - 1].id);
  } else if (e.code === 'KeyR') {
    toggleRec();
  } else if (e.code === 'KeyM') {
    toggleMetro();
  } else if (h && !heldKeys.has(e.code)) {
    e.preventDefault();
    Tone.start();
    h.el.classList.add('pressed');
    heldKeys.set(e.code, { release: h.down(), el: h.el });
  }
});

window.addEventListener('keyup', (e) => {
  const held = heldKeys.get(e.code);
  if (!held) return;
  heldKeys.delete(e.code);
  held.el.classList.remove('pressed');
  held.release?.();
});

window.addEventListener('blur', () => {
  for (const [code, held] of heldKeys) {
    held.el.classList.remove('pressed');
    held.release?.();
    heldKeys.delete(code);
  }
});

// Real key labels for the user's layout (Czech keyboard shows ů and § instead of ; and ').
navigator.keyboard?.getLayoutMap?.().then((map) => {
  for (const code of PAD_KEYS) {
    const l = map.get(code);
    if (l) keyLabels[code] = l.toUpperCase();
  }
  renderPanel();
}).catch(() => {});

// ---------- welcome ----------

function welcome() {
  const close = () => {
    Tone.start();
    dlg.close();
    dlg.remove();
  };
  const dlg = el('dialog', { class: 'welcome' },
    el('h2', {}, 'Ahoj! Tohle je ', el('span', { class: 'logo' }, 'mixpult')),
    el('p', {}, 'Složíš tady písničku za pár minut, i když nevíš nic o hudbě. Smyčka se pořád dokola přehrává a ty do ní postupně přidáváš:'),
    el('ol', { class: 'steps' },
      ...TABS.map((t) => el('li', { style: { '--c': t.color } }, el('b', {}, t.name), ' – ',
        { drums: 'ťukáš rytmus', chords: 'vybíráš akordy, které k sobě ladí', bass: 'hraješ basu, nic nezní falešně', lead: 'přidáš melodii', fx: 'hraješ si na DJe s efekty' }[t.id]))),
    el('div', { class: 'welcome-actions' },
      el('button', {
        class: 'btn-primary',
        onclick: () => {
          close();
          setTab('drums');
          toast('Zmáčkni mezerník a začni ťukat');
        },
      }, 'Začít od nuly'),
      el('button', {
        class: 'btn-secondary',
        onclick: async () => {
          close();
          replaceSong(demoSong());
          await engine.ready;
          await engine.start();
          updateHeader();
        },
      }, 'Pustit ukázku')));
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- boot ----------

Tone.getContext().lookAhead = 0.05;
// Empty loop would play silence; the click gives a beginner something to tap along to.
engine.metronome = isEmpty(song);
initHeader();
renderAll();
if (isEmpty(song)) welcome();

// Handle for automated tests in the browser console.
window.__mixpult = { engine, get song() { return song; }, Tone, Engine, renderWav, replaceSong, demoSong, normalizeSong, SOUND_IDS };
