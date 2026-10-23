// Small DOM helpers and the two custom controls: rotary knob and XY pad.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) node.style.setProperty(p, val);
        else node.style[p] = val;
      }
    }
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Rotary knob. Drag up/down, scroll, arrow keys; double click resets.
// `map` converts between the knob position (0..1) and the real value, for log scales.
export function knob({ label, value, dflt, min = 0, max = 1, map, format, onInput, bipolar = false, size = 'md', color }) {
  const toPos = map ? map.toPos : (v) => (v - min) / (max - min);
  const fromPos = map ? map.fromPos : (p) => min + p * (max - min);
  let pos = clamp01(toPos(value));
  const R = 22;
  const C = 2 * Math.PI * R;
  const arcLen = C * 0.75;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 56 56');
  svg.innerHTML = `
    <circle class="knob-track" cx="28" cy="28" r="${R}" stroke-dasharray="${arcLen} ${C}" transform="rotate(135 28 28)"/>
    <circle class="knob-fill" cx="28" cy="28" r="${R}" transform="rotate(135 28 28)"/>
    <circle class="knob-cap" cx="28" cy="28" r="15"/>
    <line class="knob-pointer" x1="28" y1="28" x2="28" y2="16"/>`;
  const fill = svg.querySelector('.knob-fill');
  const pointer = svg.querySelector('.knob-pointer');
  const out = el('span', { class: 'knob-value' });
  const dial = el('div', { class: 'knob-dial', tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100 });
  dial.append(svg);
  const root = el('div', { class: `knob knob-${size}`, style: color ? { '--knob-color': color } : undefined }, dial, el('label', {}, label), out);

  function paint() {
    const v = fromPos(pos);
    if (bipolar) {
      const centre = arcLen / 2;
      const len = Math.abs(pos - 0.5) * arcLen;
      const start = pos >= 0.5 ? centre : centre - len;
      fill.setAttribute('stroke-dasharray', `0 ${start} ${len} ${C}`);
      fill.style.opacity = len < 0.5 ? 0 : 1; // round caps would draw a dot for an empty arc
    } else {
      fill.setAttribute('stroke-dasharray', `${pos * arcLen} ${C}`);
      fill.style.opacity = pos * arcLen < 0.5 ? 0 : 1;
    }
    pointer.setAttribute('transform', `rotate(${-135 + pos * 270} 28 28)`);
    out.textContent = format ? format(v) : Math.round(pos * 100);
    dial.setAttribute('aria-valuenow', Math.round(pos * 100));
    dial.setAttribute('aria-valuetext', out.textContent);
  }

  function setPos(p, emit = true) {
    p = clamp01(p);
    if (p === pos && emit) return;
    pos = p;
    paint();
    if (emit) onInput?.(fromPos(pos));
  }

  let drag = null;
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, pos };
    root.classList.add('active');
    e.preventDefault();
    dial.focus();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const range = e.shiftKey ? 800 : 180;
    setPos(drag.pos + (drag.y - e.clientY) / range);
  });
  const end = () => {
    drag = null;
    root.classList.remove('active');
  };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('dblclick', () => setPos(toPos(dflt ?? (bipolar ? fromPos(0.5) : value))));
  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    setPos(pos - Math.sign(e.deltaY) * 0.03);
  }, { passive: false });
  dial.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (d) {
      e.preventDefault();
      e.stopPropagation();
      setPos(pos + d);
    }
  });

  paint();
  root.set = (v) => setPos(toPos(v), false);
  return root;
}

// Exponential knob mapping between lo and hi.
export const expMap = (lo, hi) => ({
  toPos: (v) => Math.log(v / lo) / Math.log(hi / lo),
  fromPos: (p) => lo * Math.pow(hi / lo, p),
});

// XY pad for performance effects. x, y in 0..1 (y = 1 at the top). Springs back to `home` on release.
export function xyPad({ labels, home = [0.5, 0], spring = () => true, onMove }) {
  const puck = el('div', { class: 'xy-puck' });
  const pad = el('div', { class: 'xy-pad', role: 'application', 'aria-label': 'Efektová plocha' },
    el('span', { class: 'xy-label xy-left' }, labels.left),
    el('span', { class: 'xy-label xy-right' }, labels.right),
    el('span', { class: 'xy-label xy-top' }, labels.top),
    el('span', { class: 'xy-label xy-bottom' }, labels.bottom),
    puck);
  let cur = [...home];
  // The puck stays fully inside the pad (inset by its radius).
  function place([x, y]) {
    puck.style.left = `calc(18px + ${x} * (100% - 36px))`;
    puck.style.top = `calc(18px + ${1 - y} * (100% - 36px))`;
  }
  function fromEvent(e) {
    const r = pad.getBoundingClientRect();
    return [clamp01((e.clientX - r.left - 18) / (r.width - 36)), clamp01(1 - (e.clientY - r.top - 18) / (r.height - 36))];
  }
  let down = false;
  pad.addEventListener('pointerdown', (e) => {
    down = true;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('active');
    cur = fromEvent(e);
    place(cur);
    onMove(...cur);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!down) return;
    cur = fromEvent(e);
    place(cur);
    onMove(...cur);
  });
  const up = () => {
    if (!down) return;
    down = false;
    pad.classList.remove('active');
    if (spring()) {
      cur = [...home];
      place(cur);
      onMove(...cur);
    }
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  place(cur);
  pad.set = (x, y) => {
    cur = [x, y];
    place(cur);
  };
  return pad;
}
