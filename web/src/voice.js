// Voice clips for the launchpad: recorded from the mic while the loop is paused (an iPhone drops
// playback quality while the mic is on), trimmed and normalized, kept in IndexedDB (far too big
// for localStorage).
import * as Tone from 'tone';

export const MAX_CLIP_SEC = 8;
const PEAK = 0.9;

// ---------- clips ----------

export const clips = new Map(); // id -> AudioBuffer (mono)

export const newClipId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function toBuffer({ data, rate }) {
  const b = new AudioBuffer({ length: Math.max(1, data.length), sampleRate: rate, numberOfChannels: 1 });
  b.copyToChannel(data, 0);
  return b;
}

export function addClip(id, data, rate) {
  clips.set(id, toBuffer({ data, rate }));
  store('readwrite', (s) => s.put({ data, rate }, id)).catch((err) => console.warn('Clip not saved', err));
}

// Loads the clips the song uses and deletes the rest (recorded over, or undone).
export function loadClips(keep) {
  return store('readwrite', (s) => {
    s.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      if (keep.has(cur.key)) clips.set(cur.key, toBuffer(cur.value));
      else cur.delete();
      cur.continue();
    };
  }).catch((err) => console.warn('Clips not loaded', err));
}

let dbPromise = null;
function store(mode, fn) {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('mixpult', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('clips');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('clips', mode);
    fn(tx.objectStore('clips'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Cuts the silence before and after the words, fades the edges, normalizes.
// Returns null when there is nothing but silence.
export function trimTake(data, rate) {
  const win = Math.round(rate * 0.01);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak < 0.003) return null;
  const loud = (i) => {
    let m = 0;
    for (let j = i; j < Math.min(data.length, i + win); j++) m = Math.max(m, Math.abs(data[j]));
    return m > peak * 0.06; // about -24 dB under the loudest moment
  };
  let a = 0;
  while (a < data.length && !loud(a)) a += win;
  let b = data.length - win;
  while (b > a && !loud(b)) b -= win;
  a = Math.max(0, a - Math.round(rate * 0.03)); // keep the breath before the first word
  b = Math.min(data.length, b + win + Math.round(rate * 0.12)); // and the tail of the last one
  const out = data.slice(a, Math.min(b, a + rate * MAX_CLIP_SEC)).map((v) => (v * PEAK) / peak);
  const fadeIn = Math.min(out.length, Math.round(rate * 0.005));
  const fadeOut = Math.min(out.length, Math.round(rate * 0.04));
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] *= i / fadeOut;
  return out.length > rate * 0.08 ? out : null;
}

// Loudness outline of a clip for drawing on its pad, n values 0..1.
export function outline(id, n = 28) {
  const buf = clips.get(id);
  if (!buf) return null;
  const d = buf.getChannelData(0);
  const size = Math.max(1, Math.floor(d.length / n));
  return Array.from({ length: n }, (_, k) => {
    let m = 0;
    for (let i = k * size; i < Math.min(d.length, (k + 1) * size); i++) m = Math.max(m, Math.abs(d[i]));
    return m / PEAK;
  });
}

// ---------- microphone ----------

// Copies the mic signal out of the audio thread in blocks.
const TAP = `registerProcessor('mixpult-tap', class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n === this.buf.length) {
      this.port.postMessage(this.buf, [this.buf.buffer]);
      this.buf = new Float32Array(2048);
      this.n = 0;
    }
    return true;
  }
});`;

export class Mic {
  // Opens the mic and starts collecting. Throws when there is no mic or no permission.
  async start() {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('No microphone access (needs https)');
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* not supported */ }
    // No echo cancellation or noise suppression: they make a voice sound like a phone call.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = Tone.getContext();
    Mic.worklet ??= ctx.addAudioWorkletModule(URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' })));
    await Mic.worklet;
    this.stream = stream;
    this.rate = ctx.sampleRate;
    this.chunks = [];
    this.src = ctx.createMediaStreamSource(stream);
    this.tap = ctx.createAudioWorkletNode('mixpult-tap');
    this.level = 0;
    this.tap.port.onmessage = (e) => {
      this.level = e.data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      if (this.chunks.length * 2048 < this.rate * (MAX_CLIP_SEC + 4)) this.chunks.push(e.data);
    };
    this.silent = new Tone.Gain(0).toDestination(); // keeps the tap running everywhere
    this.src.connect(this.tap);
    Tone.connect(this.tap, this.silent);
  }

  // Forget what was heard so far (the count-in): the take starts now.
  mark() {
    this.chunks = [];
  }

  // Closes the mic and returns everything it heard since start() or mark().
  stop() {
    if (!this.stream) return null;
    this.stream.getTracks().forEach((t) => t.stop());
    this.src.disconnect();
    this.tap.disconnect();
    this.tap.port.onmessage = null;
    this.silent.dispose();
    this.stream = null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not supported */ }
    const out = new Float32Array(this.chunks.length * 2048);
    this.chunks.forEach((c, i) => out.set(c, i * 2048));
    return out;
  }
}
