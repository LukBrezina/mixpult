import './style.css';
import * as Tone from 'tone';
import { Engine, renderWav } from './engine.js';
import { newSong, normalizeSong, apply, TRACKS, ROWS, SLOT, LOOP, isSlotTrack, BPM_RANGE } from './song.js';
import { demoSong } from './demo.js';
import { el, xyPad, knobPad } from './ui.js';
import { strokeCanvas } from './stroke.js';
import { Mic, MAX_CLIP_SEC, addClip, clips, loadClips, newClipId, trimTake, outline } from './voice.js';
import { Coach } from './tour.js';

const STORAGE_KEY = 'mixpult.song.v3';
const MINE_KEY = 'mixpult.song.mine'; // your own song, kept aside while you remix a shared one
const PAD_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF'];
const HOLD_KEY = 'KeyF';
const keyLabels = Object.fromEntries(PAD_KEYS.map((c) => [c, c.slice(3)]));
// Chords are never named: each one is just a colour (index-aligned with CHORDS).
const CHORD_COLORS = ['#ff3ea5', '#ffb03a', '#9b6bff', '#36d6ff', '#ff6b4a', '#4dffb8'];
const CHORD_ORDER = [4, 0, 5, 1, 2, 3]; // knob rows: darkest at the bottom, brightest at the top

const ICONS = {
  drums: '<circle cx="12" cy="13" r="7"/><path d="M5 13h14M9 4l2 4M15 4l-2 4"/>',
  chords: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="1.6"/><circle cx="14" cy="12" r="1.6"/><circle cx="10" cy="17" r="1.6"/>',
  bass: '<path d="M3 14c2.5 0 2.5-6 5-6s2.5 8 5 8 2.5-6 5-6 2 2 3 2"/>',
  lead: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  fx: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};

const TABS = [
  { id: 'drums', name: 'Drums', color: 'var(--c-drums)', labels: ['kick only', '', 'everything'] },
  { id: 'chords', name: 'Mood', color: 'var(--c-chords)', labels: ['pad', 'stab', 'arpeggio'] },
  { id: 'bass', name: 'Bass', color: 'var(--c-bass)', labels: ['deep', 'sharp', 'acid'] },
  { id: 'lead', name: 'Melody', color: 'var(--c-lead)', labels: ['sklo', 'bleep', 'laser'] },
  { id: 'voice', name: 'Voice', color: 'var(--c-voice)' },
  { id: 'fx', name: 'FX', color: 'var(--c-fx)' },
];
const TAB = Object.fromEntries(TABS.map((t) => [t.id, t]));

// ---------- state ----------

// Every new song starts with two clips on the launchpad, so Voice works before you record.
const PRESET_CLIPS = { workit: 'samples/voice/workit.wav', doit: 'samples/voice/doit.wav' };
function freshSong() {
  const s = newSong();
  Object.keys(PRESET_CLIPS).forEach((clip, i) => apply(s, { k: 'pad', i, clip }));
  return s;
}

const stored = readStored();
let song = stored ?? freshSong();
const engine = new Engine(song);
let tab = 'drums';
let playStep = -1;
const undoStack = [];
// Started from the home screen: already full screen, no browser bars.
const homeScreen = navigator.standalone === true
  || matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
let lastUndo = { tag: null, t: 0 };
const padHandlers = new Map(); // key code -> { down(): release fn, el }
const heldKeys = new Map();
let view = {}; // hooks into the current panel: playhead, onStep, knob

// Knob positions [x, row] survive tab switches.
const knobAt = { drums: [0.5, 2], chords: [0.5, CHORD_ORDER.indexOf(0)], bass: [0.5, 0], lead: [0.5, 3] };

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeSong(JSON.parse(raw));
  } catch {
    /* broken or blocked storage: start fresh */
  }
  return null;
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
  }, 400);
}

// Every edit goes through here. `tag` merges a burst of edits (one recording pass) into one undo step.
function dispatch(op, { tag = null } = {}) {
  const now = performance.now();
  const newStep = !(tag && tag === lastUndo.tag && now - lastUndo.t < 2000);
  const before = newStep ? JSON.stringify(song) : null;
  if (!apply(song, op)) return false;
  if (newStep) {
    undoStack.push(before);
    if (undoStack.length > 100) undoStack.shift();
  }
  lastUndo = { tag, t: now };
  engine.sync(op);
  save();
  if (op.k === 'slot' && op.t === 'chords') renderSong();
  if (op.k === 'note' || op.k === 'clear') renderTabs();
  if (op.k === 'mute') renderPanel();
  return true;
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  setSong(normalizeSong(JSON.parse(snap)));
  toast('Undone');
}

function setSong(s) {
  song = s;
  engine.setSong(song);
  save();
  renderAll();
}

const $ = (id) => document.getElementById(id);
const mod = (a, n) => ((a % n) + n) % n;

let toastTimer = null;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- header ----------

function initHeader() {
  $('play').addEventListener('click', togglePlay);
  $('share').addEventListener('click', shareSong);
  $('menu').addEventListener('toggle', () => {
    $('menu-undo').disabled = !undoStack.length;
    $('menu-mine').hidden = !readMine();
    // ponytail: screen numbers for sorting out iPhone layout gaps from a screenshot; drop once settled.
    const safe = getComputedStyle($('tabs')).paddingBottom;
    $('screen-info').textContent = `view ${Math.round(window.innerHeight)} · app ${Math.round(document.body.getBoundingClientRect().height)} · screen ${screen.height} · pad ${safe}${homeScreen ? ' · home' : ''}`;
  });
  initFullscreen();

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
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#menu')) $('menu').open = false;
  });
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data?.v !== 3) throw new Error('not a v3 song');
      undoStack.push(JSON.stringify(song));
      setSong(normalizeSong(data));
      toast('Song loaded');
    } catch {
      toast('That is not a Mixpult song');
    }
  });
}

// Android and desktop get the real Fullscreen API. iPhone Safari has none for pages, only
// "Add to Home Screen", which opens the app without browser bars (see the apple-* metas).
function initFullscreen() {
  const btn = $('fullscreen');
  if (homeScreen) {
    btn.hidden = true;
    return;
  }
  const root = document.documentElement;
  const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
  // In full screen the button has nothing left to do (the system gesture or Esc leaves it).
  const sync = () => { btn.hidden = !!(document.fullscreenElement ?? document.webkitFullscreenElement); };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  btn.addEventListener('click', async () => {
    if (!request) {
      toast('On iPhone: Share → Add to Home Screen, then it runs full screen', 5000);
      return;
    }
    try {
      await request.call(root, { navigationUI: 'hide' });
      await screen.orientation?.lock?.('portrait').catch(() => {});
    } catch {
      toast('Full screen is not available here');
    }
  });
}

async function menuAction(act) {
  if (act === 'new') {
    undoStack.push(JSON.stringify(song));
    setSong(freshSong());
    await loadPresetClips();
    toast('Blank slate');
  } else if (act === 'mine') {
    const mine = readMine();
    if (!mine) return;
    undoStack.push(JSON.stringify(song));
    setSong(mine);
    try { localStorage.removeItem(MINE_KEY); } catch { /* ignore */ }
    toast('Back to your song');
  } else if (act === 'tour') {
    startTour();
  } else if (act === 'undo') {
    undo();
  } else if (act === 'clear') {
    dispatch({ k: 'clear', t: tab });
  } else if (act === 'save') {
    download(new Blob([JSON.stringify(song)], { type: 'application/json' }), 'mixpult-song.json');
  } else if (act === 'open') {
    $('file').click();
  } else if (act === 'wav') {
    toast('Rendering WAV…');
    const blob = await renderWav(song, 2);
    download(blob, `mixpult-${new Date().toISOString().slice(0, 10)}.wav`);
    toast('Done, downloading');
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

function showPlaying() {
  $('play').classList.toggle('playing', engine.playing);
  $('play').setAttribute('aria-label', engine.playing ? 'Stop' : 'Play');
  document.body.classList.toggle('is-playing', engine.playing);
  if (tour && !tour.started && engine.playing) tourUpdate();
}

async function togglePlay() {
  if (engine.playing) engine.stop();
  else await startLoop();
  showPlaying();
}

// Touching a knob or the record button starts the loop: everything happens over the running loop.
async function startLoop() {
  if (engine.playing) return;
  await unlockAudio();
  await engine.ready;
  await engine.start();
  showPlaying();
}

// iPhone: play through the silent switch, and start audio on the first touch.
async function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* not supported */ }
  await Tone.start();
}

engine.onStep = (step) => {
  playStep = step;
  songPlayhead(step);
  view.onStep?.(step);
};

// ---------- the loop at a glance: the mood colours, half a bar each ----------

function renderSong() {
  $('song').replaceChildren(el('button', { class: 'timeline', 'aria-label': 'Mood across the loop', onclick: () => setTab('chords') },
    ...song.chords.slots.map((c, i) => el('i', { class: i % 2 ? '' : 'bar', style: { '--chord': CHORD_COLORS[c] } })),
    el('span', { class: 'timeline-head' })));
  songPlayhead(playStep);
}

function songPlayhead(step) {
  const head = $('song').querySelector('.timeline-head');
  if (!head) return;
  head.style.display = step < 0 ? 'none' : 'block';
  head.style.left = `${((step + 0.5) / LOOP) * 100}%`;
}

// ---------- tabs ----------

function hasContent(t) {
  if (!isSlotTrack(t) && t !== 'fx') return song[t].notes.some(Boolean);
  return t !== 'fx';
}

function renderTabs() {
  $('tabs').replaceChildren(...TABS.map((t) => el('button', {
    class: `tab${tab === t.id ? ' sel' : ''}${hasContent(t.id) ? ' done' : ''}`,
    style: { '--c': t.color },
    onclick: () => setTab(t.id),
  }, svgIcon(ICONS[t.id]), el('span', {}, t.name))));
}

function svgIcon(paths) {
  const span = el('span', { class: 'tab-icon' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`;
  return span;
}

function setTab(id) {
  tab = id;
  renderTabs();
  renderPanel();
}

// ---------- shared pieces ----------

// The tab name lives in the header.
function renderHeader() {
  const title = $('tab-title');
  title.textContent = TAB[tab].name;
  title.style.setProperty('--c', TAB[tab].color);
  const clear = $('menu-clear');
  clear.hidden = isSlotTrack(tab) || tab === 'fx';
  clear.textContent = `Clear ${TAB[tab].name.toLowerCase()}`;
}

// Pad that works with touch, mouse and keyboard. down(event) returns the release function.
function pad({ code, label, sub, cls = '', down }) {
  const b = el('button', { class: `pad ${cls}` },
    el('span', { class: 'pad-label' }, label),
    sub !== undefined ? el('span', { class: 'pad-sub' }, sub) : null,
    code ? el('kbd', {}, keyLabels[code] ?? code.slice(3)) : null);
  let release = null;
  let held = false;
  b.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    held = true;
    try { b.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    b.classList.add('pressed');
    if (Tone.getContext().state !== 'running') await unlockAudio();
    release = down(e);
    // Let go while the audio was still waking up (iPhone): still a tap, never a stuck press.
    if (!held) up();
  });
  const up = () => {
    held = false;
    b.classList.remove('pressed');
    release?.();
    release = null;
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  if (code) padHandlers.set(code, { down, el: b });
  return b;
}

// ---------- a track: knob + record button + the loop as a line ----------

const trackHex = (t) => getComputedStyle(document.documentElement).getPropertyValue(`--c-${t}`).trim();
const loopPos = () => (engine.playing ? engine.heardStepFloat() % LOOP : null);

// Writes a held note [a, b) (loop steps counting up from the start) into the loop, split at its end.
function commitNote(t, row, a, b) {
  const s = Math.round(a);
  const len = Math.min(LOOP, Math.max(1, Math.round(b) - s));
  const start = mod(s, LOOP);
  const first = Math.min(len, LOOP - start);
  dispatch({ k: 'note', t, s: start, note: { row, len: first } }, { tag: `rec-${t}` });
  if (len > first) dispatch({ k: 'note', t, s: 0, note: { row, len: len - first } }, { tag: `rec-${t}` });
}

// What the line shows: runs of equal slots (drums, chords) or notes as they are played (bass, lead),
// each with its average energy.
function segments(t, toRow = (v) => v) {
  const xs = song[t].x;
  const avg = (s, len) => xs.slice(s, s + len).reduce((a, b) => a + b, 0) / len;
  const out = [];
  if (isSlotTrack(t)) {
    const size = SLOT[t];
    song[t].slots.forEach((v, i) => {
      const last = out.at(-1);
      if (last && last.v === v) last.len += size;
      else out.push({ s: i * size, len: size, v });
    });
    for (const seg of out) Object.assign(seg, { row: toRow(seg.v), w: avg(seg.s, seg.len) });
    return out;
  }
  song[t].notes.forEach((n, s) => n && out.push({ s, len: n.len, row: n.row, w: xs[s] }));
  out.forEach((n, i) => {
    if (out[i + 1]) n.len = Math.min(n.len, out[i + 1].s - n.s);
  });
  return out;
}

function trackPanel(t) {
  const slotTrack = isSlotTrack(t);
  const toValue = (row) => (t === 'chords' ? CHORD_ORDER[row] : row);
  const toRow = (v) => (t === 'chords' ? CHORD_ORDER.indexOf(v) : v);
  const colorOf = t === 'chords' ? (row) => CHORD_COLORS[CHORD_ORDER[row]] : () => trackHex(t);
  const live = () => ({ row: toValue(knobAt[t][1]), x: knobAt[t][0] });
  let touching = false;
  // { from, row, gated } while recording; from = null while no note is being written.
  // gated: the knob was touched during this hold, so from then on notes sound and record only
  // while the knob is touched, exactly like playing it without recording (sharp, chopped notes).
  let rec = null;

  const writeSlot = (pos) => {
    const i = Math.floor((pos % LOOP) / SLOT[t]);
    const v = toValue(knobAt[t][1]);
    if (song[t].slots[i] !== v) dispatch({ k: 'slot', t, i, v }, { tag: `rec-${t}` });
  };

  const knob = knobPad({
    rows: ROWS[t],
    value: knobAt[t],
    rowColor: colorOf,
    labels: TAB[t].labels,
    label: TAB[t].name,
    onChange: (x, row) => {
      const moved = row !== knobAt[t][1];
      knobAt[t] = [x, row];
      if (!touching && !rec) return;
      engine.setLive(t, live());
      if (!moved || rec?.from == null || !engine.playing) return;
      // Recording and the row changed: the line steps to the new height.
      const now = engine.heardStepFloat();
      if (slotTrack) writeSlot(now);
      else commitNote(t, rec.row, rec.from, now);
      rec = { ...rec, from: now, row };
    },
    onTouch: async (on) => {
      touching = on;
      const gate = rec && !slotTrack;
      if (on) {
        if (gate) {
          rec.gated = true;
          rec.row = knobAt[t][1];
          engine.clearLive(t); // a fresh attack, as without recording
          rec.from = engine.playing ? engine.heardStepFloat() : null;
          if (rec.from != null) rec.wrote = true;
        }
        engine.setLive(t, live());
        await startLoop();
      } else if (gate && rec.gated) {
        if (rec.from != null && engine.playing) commitNote(t, rec.row, rec.from, engine.heardStepFloat());
        rec.from = null;
        engine.clearLive(t);
      } else if (!rec) engine.clearLive(t);
    },
  });

  const recBtn = pad({
    code: HOLD_KEY,
    label: 'Hold',
    sub: 'to record',
    cls: `hold ${t}`,
    down: () => {
      rec = { from: null, row: knobAt[t][1], gated: touching && !slotTrack, wrote: false };
      engine.setLive(t, live());
      const begin = () => {
        if (rec.gated && !touching) return;
        rec.from = engine.heardStepFloat();
        rec.wrote = true;
        if (slotTrack) writeSlot(rec.from);
      };
      // Right away when the loop runs, so short chopped taps on the button all become notes.
      if (engine.playing) begin();
      else {
        const mine = rec;
        startLoop().then(() => rec === mine && begin());
      }
      return () => {
        if (rec?.from != null && engine.playing && !slotTrack) commitNote(t, rec.row, rec.from, engine.heardStepFloat());
        const wrote = rec?.wrote;
        rec = null;
        if (!touching) engine.clearLive(t);
        if (wrote) tourDid(t);
      };
    },
  });

  // While recording, every step takes the knob's energy, and drums/chords take its row per slot.
  view.onStep = (step) => {
    if (step < 0 || rec?.from == null) return;
    dispatch({ k: 'x', t, s: step, v: [knobAt[t][0]] }, { tag: `rec-${t}` });
    if (slotTrack && step % SLOT[t] === 0) writeSlot(step);
  };

  const canvas = strokeCanvas({
    rows: ROWS[t],
    steps: LOOP,
    color: colorOf,
    state: () => ({
      pos: loopPos(),
      row: knobAt[t][1],
      x: knobAt[t][0],
      holding: !!rec,
      stepSec: engine.stepSeconds(),
      recorded: segments(t, toRow),
      pending: rec?.from != null && engine.playing
        ? [{ from: rec.from, to: engine.heardStepFloat(), row: slotTrack ? knobAt[t][1] : rec.row, w: knobAt[t][0] }]
        : [],
    }),
  });

  view.knob = knob;
  return [
    el('section', { class: 'block stroke-stage' }, canvas, el('div', { class: 'stroke-controls' }, knob, recBtn)),
  ];
}

// ---------- voice: a launchpad of your own clips ----------

const VOICE_COLORS = ['#d4ff3a', '#4dffb8', '#36d6ff', '#9b6bff', '#ff3ea5', '#ffb03a'];
const VOICE_GRID = [4, 5, 2, 3, 0, 1]; // on screen top row first; pad 0 is bottom left, like the line
const VOICE_KEYS = ['KeyZ', 'KeyX', 'KeyA', 'KeyS', 'KeyQ', 'KeyW']; // by pad, same layout
const mic = new Mic();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Count-in clicks go straight to the speakers: the music output is hushed while recording.
let beeper = null;
function beep(note) {
  beeper ??= new Tone.Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.002, decay: 0.09, sustain: 0, release: 0.05 },
    volume: -10,
  }).toDestination();
  beeper.triggerAttackRelease(note, 0.09);
}

function voicePanel() {
  const t = 'voice';
  let active = null; // pad sounding right now
  let lastPad = 0;
  let recording = false; // the hold button is down
  let held = null; // { row, from } a pad press being written into the loop
  let wrote = false; // this hold of the record button put a clip into the loop

  const commitHeld = () => {
    if (held && engine.playing) commitNote(t, held.row, held.from, engine.heardStepFloat());
    held = null;
  };
  const startHeld = (row) => {
    commitHeld();
    if (recording && engine.playing) {
      held = { row, from: engine.heardStepFloat() };
      wrote = true;
    }
  };

  // Hold a pad: the music goes quiet, a count-in of three beats, then talk until you let go.
  // The loop stays stopped meanwhile: the phone records and plays back better that way.
  const overlay = el('div', { class: 'take-overlay' }, el('b'), el('span'), el('i', { class: 'take-meter' }, el('i')));
  const show = (big, small, cls) => {
    overlay.className = `take-overlay show ${cls}`;
    overlay.querySelector('b').textContent = big;
    overlay.querySelector('span').textContent = small;
  };

  function takeClip(i, b) {
    engine.stop();
    showPlaying();
    engine.hush(true);
    b.classList.add('taking');
    b.querySelector('.pad-sub').textContent = 'keep holding';
    let released = false;
    let talking = false;
    const opening = mic.start().then(() => true, (err) => {
      console.warn(err);
      toast(window.isSecureContext ? 'This needs the microphone. Allow it in the browser settings.' : 'The microphone only works over https://', 4000);
      return false;
    });

    (async () => {
      const beat = engine.stepSeconds() * 4 * 1000;
      for (const n of [3, 2, 1]) {
        if (released) return;
        show(String(n), 'get ready', 'count');
        beep(n === 1 ? 'A5' : 'E5');
        await sleep(beat);
      }
      if (released) return;
      show('…', 'opening the mic', 'count');
      if (!(await opening) || released) return;
      mic.mark();
      talking = true;
      show('REC', 'talk now, let go when done', 'rec');
      b.querySelector('.pad-sub').textContent = 'recording';
      const meter = overlay.querySelector('.take-meter i');
      let lvl = 0;
      const draw = () => {
        if (!talking) return;
        lvl = Math.max(mic.level, lvl * 0.9);
        meter.style.width = `${Math.min(100, Math.sqrt(lvl) * 110)}%`;
        requestAnimationFrame(draw);
      };
      draw();
    })();

    return async () => {
      released = true;
      const wasTalking = talking;
      talking = false;
      overlay.className = 'take-overlay';
      const data = (await opening) ? mic.stop() : null;
      engine.hush(false);
      if (!wasTalking) {
        if (data) toast('Keep holding the pad through the count-in, then talk.', 3000);
        return renderPanel();
      }
      const clip = trimTake(data, mic.rate);
      if (!clip) toast('Nothing heard. Hold the pad and talk.', 3000);
      else {
        const id = newClipId();
        addClip(id, clip, mic.rate);
        dispatch({ k: 'pad', i, clip: id });
        toast('Clip recorded. Tap the pad to play it.');
      }
      renderPanel();
    };
  }

  const pads = VOICE_GRID.map((i) => {
    const clip = song.voice.pads[i];
    const empty = !clip;
    const b = pad({
      code: VOICE_KEYS[i],
      label: '',
      sub: empty ? 'hold & talk' : '',
      cls: `vpad${empty ? ' empty' : ''}`,
      down: (e) => {
        // The mic badge in the corner of a full pad records it again.
        if (empty || e?.target?.closest?.('.rerec')) return takeClip(i, b);
        active = lastPad = i;
        engine.setLive(t, { row: i, x: 0.5 });
        if (engine.playing) startHeld(i);
        else startLoop().then(() => active === i && startHeld(i));
        return () => {
          if (held?.row === i) commitHeld();
          if (active === i) {
            active = null;
            engine.clearLive(t);
          }
        };
      },
    });
    b.style.setProperty('--c', VOICE_COLORS[i]);
    b.dataset.pad = i;
    const wave = !empty && outline(clip);
    if (wave) {
      const bars = wave.map((v, k) => `<rect x="${k * 4}" y="${12 - 11 * v}" width="2.4" height="${Math.max(1, 22 * v)}" rx="1"/>`).join('');
      b.querySelector('.pad-label').innerHTML = `<svg class="wave" viewBox="0 0 ${wave.length * 4} 24" preserveAspectRatio="none">${bars}</svg>`;
      b.append(el('span', { class: 'rerec', title: 'Hold to record again', 'aria-label': 'Hold to record again' }, svgIcon(ICONS.voice)));
    } else if (empty) {
      b.querySelector('.pad-label').innerHTML = `<svg viewBox="0 0 24 24">${ICONS.voice}</svg>`;
    }
    return b;
  });

  const recBtn = pad({
    code: HOLD_KEY,
    label: 'Hold',
    sub: 'to record',
    cls: 'hold voice',
    down: () => {
      recording = true;
      wrote = false;
      startLoop().then(() => recording && active !== null && startHeld(active));
      return () => {
        commitHeld();
        recording = false;
        if (wrote) tourDid(t);
      };
    },
  });

  const canvas = strokeCanvas({
    rows: ROWS[t],
    steps: LOOP,
    color: (row) => VOICE_COLORS[row],
    state: () => ({
      pos: loopPos(),
      row: active ?? lastPad,
      x: 0.5,
      holding: recording,
      stepSec: engine.stepSeconds(),
      recorded: segments(t),
      pending: held && engine.playing ? [{ from: held.from, to: engine.heardStepFloat(), row: held.row, w: 0.5 }] : [],
    }),
  });

  return [
    el('section', { class: 'block stroke-stage' }, canvas, overlay, el('div', { class: 'stroke-controls' }, el('div', { class: 'launchpad' }, ...pads), recBtn)),
  ];
}

// ---------- fx ----------

function fxPanel() {
  const xy = xyPad({
    labels: { left: '◀ muffle', right: 'thin ▶', top: '▲ squelch', bottom: '' },
    home: [0.5, 0],
    onMove: (x, y) => engine.setXY((x - 0.5) * 2, y),
    onRelease: () => tourDid('fx'),
  });

  const hold = (code, label, sub, on, off) => pad({
    code, label, sub, cls: 'fx',
    down: () => {
      on();
      return off;
    },
  });
  const holds = [
    hold(PAD_KEYS[0], 'Stutter', 'eighths', () => engine.setStutter(2), () => engine.setStutter(null)),
    hold(PAD_KEYS[1], 'Stutter', 'fast', () => engine.setStutter(1), () => engine.setStutter(null)),
    hold(PAD_KEYS[2], 'Breakdown', 'let go = drop', () => engine.setBreakdown(true), () => engine.setBreakdown(false)),
  ];

  const mix = TRACKS.map((t) => el('div', { class: `mix-row${song.mute[t] ? ' muted' : ''}`, style: { '--c': TAB[t].color } },
    el('span', { class: 'mix-name' }, TAB[t].name),
    el('input', {
      type: 'range', min: 0, max: 1, step: 0.01, value: song.vol[t], 'aria-label': `${TAB[t].name} volume`,
      oninput: (e) => dispatch({ k: 'vol', t, v: Number(e.target.value) }, { tag: `vol-${t}` }),
    }),
    el('button', { class: `mute${song.mute[t] ? ' on' : ''}`, onclick: () => dispatch({ k: 'mute', t, v: !song.mute[t] }) },
      song.mute[t] ? 'muted' : 'on')));

  // Tempo: a slider, plus nudges for exact steps.
  const bpmOut = el('output', { class: 'tempo-value' }, String(song.bpm));
  const setBpm = (v) => {
    v = Math.max(BPM_RANGE[0], Math.min(BPM_RANGE[1], v));
    if (!dispatch({ k: 'bpm', v }, { tag: 'bpm' })) return;
    bpmOut.textContent = String(v);
    slider.value = v;
  };
  const slider = el('input', {
    type: 'range', min: BPM_RANGE[0], max: BPM_RANGE[1], step: 1, value: song.bpm, 'aria-label': 'Tempo',
    oninput: (e) => setBpm(Number(e.target.value)),
  });
  const tempo = el('div', { class: 'tempo' },
    el('button', { class: 'chip', 'aria-label': 'Slower', onclick: () => setBpm(song.bpm - 1) }, '−'),
    el('div', { class: 'tempo-main' }, bpmOut, el('small', {}, 'BPM'), slider),
    el('button', { class: 'chip', 'aria-label': 'Faster', onclick: () => setBpm(song.bpm + 1) }, '+'));

  return [
    el('section', { class: 'block xy-block' }, xy),
    el('section', { class: 'block' }, el('h3', {}, 'Hold'), el('div', { class: 'pads pads-3' }, ...holds)),
    el('section', { class: 'block' }, el('h3', {}, 'Tempo'), tempo),
    el('section', { class: 'block' }, el('h3', {}, 'Levels'), el('div', { class: 'mix' }, ...mix)),
  ];
}

// ---------- render ----------

function renderPanel() {
  padHandlers.clear();
  for (const t of TRACKS) engine.clearLive(t);
  mic.stop();
  view = {};
  renderHeader();
  const p = $('panel');
  p.style.setProperty('--c', TAB[tab].color);
  p.replaceChildren(...(tab === 'fx' ? fxPanel() : tab === 'voice' ? voicePanel() : trackPanel(tab)).filter(Boolean));
  p.scrollTop = 0;
  if (tour) requestAnimationFrame(tourUpdate);
}

function renderAll() {
  renderSong();
  renderTabs();
  renderPanel();
}

// ---------- keyboard (desktop) ----------

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
  // Arrows move the knob (left/right in tenths).
  const arrow = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0] }[e.code];
  if (arrow && view.knob) {
    e.preventDefault();
    view.knob.nudge(...arrow);
    return;
  }
  const h = padHandlers.get(e.code);
  if (e.repeat) {
    if (h || e.code === 'Space') e.preventDefault();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (/^Digit[1-6]$/.test(e.code)) {
    setTab(TABS[Number(e.code.slice(5)) - 1].id);
  } else if (h && !heldKeys.has(e.code)) {
    e.preventDefault();
    unlockAudio();
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

navigator.keyboard?.getLayoutMap?.().then((map) => {
  for (const code of [...PAD_KEYS, ...VOICE_KEYS]) {
    const l = map.get(code);
    if (l) keyLabels[code] = l.toUpperCase();
  }
  renderPanel();
}).catch(() => {});

// ---------- first run: full screen, then a tour ----------

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SHARE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

// Before anything plays: how to get rid of the browser bars. An iPhone can only do it from the
// home screen (that copy of the app starts its own first run there); elsewhere one tap does it.
function fullscreenGuide() {
  return new Promise((resolve) => {
    const request = document.documentElement.requestFullscreen ?? document.documentElement.webkitRequestFullscreen;
    const done = () => {
      dlg.close();
      dlg.remove();
      resolve();
    };
    const li = (html) => {
      const item = el('li');
      item.innerHTML = `<span>${html}</span>`;
      return item;
    };
    const ios = isIOS && !request;
    const dlg = el('dialog', { class: 'welcome' },
      el('h2', {}, el('span', { class: 'logo' }, 'mixpult')),
      el('p', {}, 'Night techno from your fingertips. It plays best full screen, without the browser around it.'),
      ios
        ? el('ol', { class: 'guide-steps' },
          li(`Tap ${SHARE_ICON} <b>Share</b> (behind <b>•••</b> in Safari)`),
          li(`Choose ${PLUS_ICON} <b>Add to Home Screen</b>`),
          li('Open <b>Mixpult</b> from your home screen'))
        : null,
      el('div', { class: 'welcome-actions' },
        ios
          ? el('button', { class: 'btn-secondary', onclick: done }, 'Stay in Safari')
          : [
            el('button', { class: 'btn-secondary', onclick: done }, 'Not now'),
            el('button', {
              class: 'btn-primary',
              onclick: async () => {
                try {
                  await request.call(document.documentElement, { navigationUI: 'hide' });
                  await screen.orientation?.lock?.('portrait').catch(() => {});
                } catch { /* stays in the browser */ }
                done();
              },
            }, 'Go full screen'),
          ]));
    document.body.append(dlg);
    dlg.showModal();
    document.activeElement?.blur(); // no focus ring on the first button for a touch
  });
}

// The tour: tap play, then ghost thumbs show the move (left thumb plays, right thumb holds record);
// once you have recorded something the next tab blinks, and opening it ends the tour.
const TOUR_KEY = 'mixpult.tour';
const coach = new Coach();
let tour = null; // { started, did: the tab you recorded on } while the tour runs

function startTour() {
  tour = { started: engine.playing, did: null };
  tourUpdate();
}

function endTour(msg) {
  tour = null;
  coach.clear();
  try { localStorage.setItem(TOUR_KEY, 'done'); } catch { /* ignore */ }
  if (msg) toast(msg, 3000);
}

function tourDid(t) {
  if (!tour?.started || tour.did) return;
  tour.did = t;
  tourUpdate();
}

function tourUpdate() {
  coach.clear();
  if (!tour) return;
  const skip = () => endTour();
  if (!tour.started) {
    if (!engine.playing) {
      coach.pulse($('play'));
      coach.tip('Tap play', $('play'), 'below', skip);
      return;
    }
    tour.started = true;
  }
  const panel = $('panel');
  if (tour.did) {
    if (tab !== tour.did) return endTour('You got it. Now explore the other tabs and jam around!');
    const i = (TABS.findIndex((x) => x.id === tab) + 1) % TABS.length;
    const next = TABS[i];
    const btn = $('tabs').children[i];
    coach.pulse(btn);
    coach.tip(`Next: ${next.name}`, btn, 'above', skip);
    return;
  }
  const hold = panel.querySelector('.pad.hold');
  if (tab === 'fx') {
    const xy = panel.querySelector('.xy-pad');
    coach.hands({ left: xy, move: 'drag' });
    coach.tip('Drag around, then let go', xy, 'over', skip);
  } else if (tab === 'voice') {
    const clip = panel.querySelector('.vpad:not(.empty)');
    coach.hands({ left: clip ?? panel.querySelector('.vpad'), right: clip ? hold : null, move: 'tap' });
    coach.tip(clip ? 'Hold record, tap a clip' : 'Hold a pad and talk', panel.querySelector('canvas'), 'over', skip);
  } else {
    coach.hands({ left: panel.querySelector('.knob-pad'), right: hold, move: 'slide' });
    coach.tip('Hold record, slide the pad', panel.querySelector('canvas'), 'over', skip);
  }
}

// The ghost thumbs step aside while you touch the screen.
document.addEventListener('pointerdown', () => coach.away(true), true);
document.addEventListener('pointerup', () => coach.away(false), true);
document.addEventListener('pointercancel', () => coach.away(false), true);

// Fetches the preset clips a song uses but this device has not stored yet.
async function loadPresetClips() {
  const missing = Object.entries(PRESET_CLIPS).filter(([id]) => song.voice.pads.includes(id) && !clips.has(id));
  await Promise.all(missing.map(async ([id, file]) => {
    try {
      const res = await fetch((import.meta.env.BASE_URL ?? '/') + file);
      const buf = await Tone.getContext().rawContext.decodeAudioData(await res.arrayBuffer());
      const data = trimTake(buf.getChannelData(0), buf.sampleRate);
      if (data) addClip(id, data, buf.sampleRate);
    } catch (err) {
      console.warn('Preset clip not loaded', id, err);
    }
  }));
}

// ---------- sharing ----------

// A shared song is a frozen copy on the server (see worker.js) with its own voice clips. Whoever
// opens the link gets their own copy to remix; the link always plays the original.
const SHARE_ID = /^[a-z0-9]{10}$/;

function readMine() {
  try {
    const raw = localStorage.getItem(MINE_KEY);
    return raw ? normalizeSong(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

// Clips travel as 16-bit PCM in base64: half the size of floats, no audible difference.
function encodeClip(buf) {
  const f = buf.getChannelData(0);
  const pcm = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { rate: buf.sampleRate, pcm: btoa(bin) };
}

function decodeClip(c) {
  if (typeof c?.pcm !== 'string' || !(c.rate >= 8000 && c.rate <= 96000)) return null;
  const bin = atob(c.pcm);
  const pcm = new Int16Array(Math.min(bin.length >> 1, Math.ceil(c.rate * MAX_CLIP_SEC)));
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return Float32Array.from(pcm, (v) => v / 32767);
}

async function shareSong() {
  const btn = $('share');
  if (btn.disabled) return;
  btn.disabled = true;
  toast('Making a link…', 15000);
  try {
    const own = {};
    for (const id of song.voice.pads) {
      if (id && !(id in PRESET_CLIPS) && clips.has(id)) own[id] = encodeClip(clips.get(id));
    }
    const res = await fetch('/api/songs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ song, clips: own }),
    });
    if (!res.ok) throw new Error(`share failed: ${res.status}`);
    const { id } = await res.json();
    $('toast').classList.remove('show');
    shareDialog(`${location.origin}${location.pathname}?s=${id}`);
  } catch (err) {
    console.warn(err);
    toast('Could not make a link. Are you online?', 3000);
  } finally {
    btn.disabled = false;
  }
}

// The link is ready: share it from a fresh tap (iPhone refuses to open the share sheet after
// waiting for the upload), or copy it.
function shareDialog(url) {
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  const dlg = el('dialog', { class: 'welcome' },
    el('h2', {}, 'Your song has a link'),
    el('p', {}, 'Whoever opens it hears your track and can remix their own copy. This link always plays it the way it is now.'),
    el('input', { class: 'share-url', value: url, readonly: true, onfocus: (e) => e.target.select() }),
    el('div', { class: 'welcome-actions' },
      el('button', {
        class: 'btn-secondary',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast('Link copied');
          } catch {
            toast('Copy it from the box above');
            return;
          }
          close();
        },
      }, 'Copy'),
      navigator.share
        ? el('button', {
          class: 'btn-primary',
          onclick: async () => {
            try {
              await navigator.share({ title: 'Mixpult', text: 'I made a track, remix it:', url });
              close();
            } catch { /* cancelled */ }
          },
        }, 'Share…')
        : el('button', { class: 'btn-primary', onclick: close }, 'Done')));
  dlg.addEventListener('click', (e) => e.target === dlg && close());
  document.body.append(dlg);
  dlg.showModal();
  document.activeElement?.blur();
}

// Opening a shared link: your own song is kept aside (Back to my song in the menu), the shared one
// plays, and the tour shows how to change it.
async function openShared(id) {
  history.replaceState(null, '', location.pathname); // a reload keeps your remix
  let data;
  let remix;
  try {
    const res = await fetch(`/api/songs/${id}`);
    if (!res.ok) throw new Error(`not found: ${res.status}`);
    data = await res.json();
    if (data?.song?.v !== 3) throw new Error('not a song');
    remix = normalizeSong(data.song);
  } catch (err) {
    console.warn(err);
    toast('That shared song could not be opened.', 4000);
    return;
  }
  for (const [cid, c] of Object.entries(data.clips ?? {})) {
    if (!remix.voice.pads.includes(cid)) continue;
    const pcm = decodeClip(c);
    if (pcm) addClip(cid, pcm, c.rate);
  }
  if (stored && !readMine() && JSON.stringify(stored) !== JSON.stringify(remix)) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(stored)); } catch { /* storage full */ }
  }
  setSong(remix);
  await loadPresetClips();
  renderPanel();

  const dlg = el('dialog', { class: 'welcome' },
    el('h2', {}, el('span', { class: 'logo' }, 'mixpult')),
    el('p', {}, 'Someone made this track and shared it with you. Hear it, then make it yours: your changes stay on your phone, the original stays as it is.'),
    el('div', { class: 'welcome-actions' },
      el('button', {
        class: 'btn-primary',
        onclick: async () => {
          dlg.close();
          dlg.remove();
          await startLoop();
          startTour();
        },
      }, '▶ Play it')));
  document.body.append(dlg);
  dlg.showModal();
  document.activeElement?.blur();
}

// ---------- boot ----------

Tone.getContext().lookAhead = 0.05;
// One screen, exactly: see body in style.css. --app-h follows the visible height (it shrinks
// with Safari's bars). The status bar is opaque on purpose: with black-translucent, iOS 26 sizes a
// home-screen app's view a status bar short and leaves that strip blank under the tab bar.
function fitScreen() {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}
fitScreen();
window.addEventListener('resize', fitScreen);
window.visualViewport?.addEventListener('resize', fitScreen);
window.addEventListener('orientationchange', () => setTimeout(fitScreen, 300));
initHeader();
renderAll();
// Keep the clips of the current song and of your own song set aside while remixing.
loadClips(new Set([...song.voice.pads, ...(readMine()?.voice.pads ?? [])].filter(Boolean)))
  .then(loadPresetClips)
  .then(() => tab === 'voice' && renderPanel());
const sharedId = new URLSearchParams(location.search).get('s');
if (sharedId && SHARE_ID.test(sharedId)) {
  openShared(sharedId);
} else if (!stored) {
  // Touch screens outside an installed app first learn how to go full screen; desktops skip it.
  const guide = !homeScreen && matchMedia('(pointer: coarse)').matches;
  (guide ? fullscreenGuide() : Promise.resolve()).then(startTour);
}

// Handle for automated tests in the browser console.
window.__mixpult = { engine, get song() { return song; }, Tone, renderWav, setSong, demoSong, newSong, dispatch, LOOP, addClip };
