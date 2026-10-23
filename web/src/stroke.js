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
  function hline(x0, x1, y, w) {
    ctx.moveTo(x0, y);
    ctx.lineTo(Math.min(x1, w), y);
    if (x1 > w) {
      ctx.moveTo(0, y);
      ctx.lineTo(x1 - w, y);
    }
  }

  function glowStroke(c, width, glow) {
    ctx.strokeStyle = c;
    ctx.lineWidth = width;
    ctx.shadowColor = c;
    ctx.shadowBlur = glow;
    ctx.stroke();
    ctx.shadowBlur = 0;
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const st = state();
    const xOf = (step) => (step / steps) * w;
    const targetY = yOf(st.row, h);
    penY = penY === null ? targetY : penY + (targetY - penY) * Math.min(1, dt * 18);
    const penX = st.pos === null ? 14 : xOf(st.pos);

    // Guides: faint rows, beats, and stronger bar lines.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      const y = Math.round(yOf(r, h)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    for (let s = 4; s < steps; s += 4) {
      ctx.strokeStyle = s % 16 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.13)';
      ctx.beginPath();
      ctx.moveTo(Math.round(xOf(s)) + 0.5, 6);
      ctx.lineTo(Math.round(xOf(s)) + 0.5, h - 6);
      ctx.stroke();
    }

    // What is recorded: one glowing line, joined where notes touch.
    const rec = st.recorded;
    rec.forEach((n, i) => {
      const prev = rec[i - 1];
      const joined = prev && prev.s + prev.len === n.s;
      const y = yOf(n.row, h);
      const c = color(n.row);
      ctx.beginPath();
      ctx.moveTo(xOf(n.s), joined ? yOf(prev.row, h) : y);
      ctx.lineTo(xOf(n.s), y);
      ctx.lineTo(xOf(n.s + n.len) - (rec[i + 1]?.s === n.s + n.len ? 0 : 3), y);
      glowStroke(c, 2.5 + 5 * n.w, 12);
      ctx.beginPath();
      ctx.arc(xOf(n.s), y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
    });

    // Being drawn right now: thicker, with a white-hot core.
    for (const p of st.pending) {
      const len = Math.max(0, p.to - p.from);
      if (len <= 0) continue;
      const x0 = xOf(((p.from % steps) + steps) % steps);
      const y = yOf(p.row, h);
      ctx.beginPath();
      hline(x0, x0 + xOf(Math.min(len, steps)), y, w);
      glowStroke(color(p.row), 4 + 6 * p.w, 22);
      ctx.beginPath();
      hline(x0, x0 + xOf(Math.min(len, steps)), y, w);
      glowStroke('rgba(255,255,255,0.9)', 2, 0);
    }

    // The knob's trail: where you would be drawing. Fades out over one loop.
    const penColor = color(st.row);
    if (st.pos !== null) {
      const tail = trail.at(-1);
      if (!tail || tail.x !== st.pos) trail.push({ x: st.pos, y: penY, t: now });
      const loopMs = 1000 * steps * (st.stepSec || 0.12);
      while (trail.length && now - trail[0].t > loopMs) trail.shift();
      ctx.lineWidth = 2;
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        if (b.x < a.x) continue; // wrapped around
        ctx.strokeStyle = penColor;
        ctx.globalAlpha = 0.32 * (1 - (now - b.t) / loopMs);
        ctx.beginPath();
        ctx.moveTo(xOf(a.x), a.y);
        ctx.lineTo(xOf(b.x), b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
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
    ctx.lineWidth = 2;
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
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.strokeStyle = p.white ? '#fff' : penColor;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The pen.
    const r = (st.holding ? 9 + Math.sin(now / 60) * 1.5 : 5) + 4 * st.x;
    ctx.beginPath();
    ctx.arc(penX, penY, r, 0, Math.PI * 2);
    ctx.fillStyle = penColor;
    ctx.shadowColor = penColor;
    ctx.shadowBlur = st.holding ? 30 : 14;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(penX, penY, st.holding ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return canvas;
}
