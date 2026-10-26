// The loop as a drawing: time runs left to right, height is the knob, thickness is its energy.
// Where the knob is goes by as a faint trail; whatever you hold the button for is drawn solid,
// with sparks flying off the pen.
import { el } from './ui.js';

const PAD_Y = 22;
const MAX_SPARKS = 220;

// state() → { pos: loop step (float) or null when stopped, row, x, holding, stepSec,
//             recorded: [{ s, len, row, w }], pending: [{ from, to, row, w }] (unwrapped steps) }
// w = energy 0..1 drawn as line thickness.
export function strokeCanvas({ rows, steps, color, state, onTap }) {
  const canvas = el('canvas', { class: 'stroke' });
  const ctx = canvas.getContext('2d');
  const trail = [];
  const sparks = [];
  let penY = null;
  let last = performance.now();
  let wasConnected = false;
  let wasHolding = false;

  const yOf = (row, h) => h - PAD_Y - (rows > 1 ? row / (rows - 1) : 0.5) * (h - 2 * PAD_Y);

  if (onTap) {
    canvas.addEventListener('pointerdown', (e) => {
      const b = canvas.getBoundingClientRect();
      onTap(((e.clientX - b.left) / b.width) * steps);
    });
  }

  function emit(x, y, n, burst) {
    for (let i = 0; i < n && sparks.length < MAX_SPARKS; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = burst ? 80 + Math.random() * 260 : 40 + Math.random() * 120;
      sparks.push({
        x, y,
        vx: burst ? Math.cos(a) * v : -(60 + Math.random() * 180),
        vy: burst ? Math.sin(a) * v : (Math.random() - 0.65) * 160,
        age: 0,
        life: 0.35 + Math.random() * 0.55,
        white: Math.random() < 0.35,
      });
    }
  }

  // A segment in pattern steps, drawn with wrap-around at the loop end.
  function hline(path, x0, x1, y, w) {
    path.moveTo(x0, y);
    path.lineTo(Math.min(x1, w), y);
    if (x1 > w) {
      path.moveTo(0, y);
      path.lineTo(x1 - w, y);
    }
  }

  // A glow without shadowBlur: wide, faint strokes under the line. Shadows and hundreds of
  // separate strokes per frame kept a phone's GPU so busy that the audio broke up, so all
  // drawing is batched and blur-free.
  function softStroke(g, path, c, width, glow) {
    g.strokeStyle = c;
    for (const [spread, alpha] of [[1, 0.07], [0.6, 0.12], [0.3, 0.22]]) {
      g.globalAlpha = alpha;
      g.lineWidth = width + glow * spread;
      g.stroke(path);
    }
    g.globalAlpha = 1;
    g.lineWidth = width;
    g.stroke(path);
  }

  // Strokes sorted into a few alpha buckets, one path each.
  const BUCKETS = 6;
  function buckets() {
    return Array.from({ length: BUCKETS }, () => new Path2D());
  }
  function strokeBuckets(paths, c, maxAlpha) {
    ctx.strokeStyle = c;
    paths.forEach((path, i) => {
      ctx.globalAlpha = (maxAlpha * (i + 1)) / BUCKETS;
      ctx.stroke(path);
    });
    ctx.globalAlpha = 1;
  }
  const bucketOf = (a) => Math.min(BUCKETS - 1, Math.max(0, Math.floor(a * BUCKETS)));

  // Guides and the recorded line only change while recording: drawn into a layer that is
  // copied in every frame.
  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  let layerKey = '';
  function drawLayer(rec, w, h, dpr) {
    const key = `${w}x${h}x${dpr}|${rec.map((n) => `${n.s},${n.len},${n.row},${n.w.toFixed(2)}`).join(';')}`;
    if (key === layerKey) return;
    layerKey = key;
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    }
    const g = lctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const xOf = (step) => (step / steps) * w;

    // Guides: faint rows, beats, and stronger bar lines.
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.beginPath();
    for (let r = 0; r < rows; r++) {
      const y = Math.round(yOf(r, h)) + 0.5;
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.stroke();
    for (let s = 4; s < steps; s += 4) {
      g.strokeStyle = s % 16 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.13)';
      g.beginPath();
      g.moveTo(Math.round(xOf(s)) + 0.5, 6);
      g.lineTo(Math.round(xOf(s)) + 0.5, h - 6);
      g.stroke();
    }

    // What is recorded: one glowing line, joined where notes touch.
    rec.forEach((n, i) => {
      const prev = rec[i - 1];
      const joined = prev && prev.s + prev.len === n.s;
      const y = yOf(n.row, h);
      const c = color(n.row);
      const path = new Path2D();
      path.moveTo(xOf(n.s), joined ? yOf(prev.row, h) : y);
      path.lineTo(xOf(n.s), y);
      path.lineTo(xOf(n.s + n.len) - (rec[i + 1]?.s === n.s + n.len ? 0 : 3), y);
      softStroke(g, path, c, 2.5 + 5 * n.w, 14);
      g.beginPath();
      g.arc(xOf(n.s), y, 3.2, 0, Math.PI * 2);
      g.fillStyle = c;
      g.fill();
    });
  }

  function frame(now) {
    if (!canvas.isConnected) {
      if (wasConnected) return; // panel was replaced: stop the loop
      requestAnimationFrame(frame);
      return;
    }
    wasConnected = true;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const st = state();
    drawLayer(st.recorded, w, h, dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const xOf = (step) => (step / steps) * w;
    const targetY = yOf(st.row, h);
    penY = penY === null ? targetY : penY + (targetY - penY) * Math.min(1, dt * 18);
    const penX = st.pos === null ? 14 : xOf(st.pos);

    // Being drawn right now: thicker, with a white-hot core.
    for (const p of st.pending) {
      const len = Math.max(0, p.to - p.from);
      if (len <= 0) continue;
      const x0 = xOf(((p.from % steps) + steps) % steps);
      const y = yOf(p.row, h);
      const path = new Path2D();
      hline(path, x0, x0 + xOf(Math.min(len, steps)), y, w);
      softStroke(ctx, path, color(p.row), 4 + 6 * p.w, 22);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke(path);
    }

    // The knob's trail: where you would be drawing. Fades out over one loop.
    const penColor = color(st.row);
    if (st.pos !== null) {
      const tail = trail.at(-1);
      if (!tail || tail.x !== st.pos) trail.push({ x: st.pos, y: penY, t: now });
      const loopMs = 1000 * steps * (st.stepSec || 0.12);
      while (trail.length && now - trail[0].t > loopMs) trail.shift();
      const fade = buckets();
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        if (b.x < a.x) continue; // wrapped around
        const path = fade[bucketOf(1 - (now - b.t) / loopMs)];
        path.moveTo(xOf(a.x), a.y);
        path.lineTo(xOf(b.x), b.y);
      }
      ctx.lineWidth = 2;
      strokeBuckets(fade, penColor, 0.32);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(penX, 4);
      ctx.lineTo(penX, h - 4);
      ctx.stroke();
    } else {
      trail.length = 0;
      ctx.setLineDash([4, 8]);
      ctx.strokeStyle = penColor;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(penX, penY);
      ctx.lineTo(w, penY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Sparks.
    if (st.holding && !wasHolding) emit(penX, penY, 36, true);
    if (st.holding) emit(penX, penY, st.pos === null ? 2 : 4, st.pos === null);
    wasHolding = st.holding;
    const white = buckets();
    const tinted = buckets();
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.age += dt;
      if (p.age >= p.life) {
        sparks.splice(i, 1);
        continue;
      }
      p.vy += 420 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const path = (p.white ? white : tinted)[bucketOf(1 - p.age / p.life)];
      path.moveTo(p.x, p.y);
      path.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
    }
    ctx.lineWidth = 2;
    strokeBuckets(white, '#fff', 1);
    strokeBuckets(tinted, penColor, 1);

    // The pen.
    const r = (st.holding ? 9 + Math.sin(now / 60) * 1.5 : 5) + 4 * st.x;
    const halo = r + (st.holding ? 30 : 14);
    const glow = ctx.createRadialGradient(penX, penY, r * 0.6, penX, penY, halo);
    glow.addColorStop(0, penColor);
    glow.addColorStop(1, 'transparent');
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(penX, penY, halo, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(penX, penY, r, 0, Math.PI * 2);
    ctx.fillStyle = penColor;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(penX, penY, st.holding ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return canvas;
}
