// Small DOM helpers and the custom controls: XY effect pad and the snapping knob pad.

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

// XY pad for performance effects. x, y in 0..1 (y = 1 at the top). Springs back to `home` on release.
export function xyPad({ labels, home = [0.5, 0], onMove, onRelease }) {
  const puck = el('div', { class: 'xy-puck' });
  const pad = el('div', { class: 'xy-pad', role: 'application', 'aria-label': 'Effects pad' },
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
    cur = [...home];
    place(cur);
    onMove(...cur);
    onRelease?.();
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

// Knob pad: a 2D puck. Up/down snaps to `rows` (row 0 at the bottom), left/right is smooth (0..1).
// Drag anywhere on it; the puck jumps to the finger and stays where it is let go.
// onTouch(true/false) says when a finger is on it (so the app can play what you are fiddling with).
export function knobPad({ rows, value = [0.5, 0], rowColor, labels = [], label, onChange, onTouch }) {
  const INSET = 24;
  const puck = el('div', { class: 'knob-puck' });
  const yPos = (r) => `calc(${INSET}px + ${rows > 1 ? r / (rows - 1) : 0.5} * (100% - ${2 * INSET}px))`;
  const pad = el('div', { class: 'knob-pad', role: 'slider', tabindex: 0, 'aria-label': label },
    ...Array.from({ length: rows }, (_, r) => el('i', { class: 'knob-row', style: { bottom: yPos(r), '--rc': rowColor(r) } })),
    el('div', { class: 'knob-labels' }, ...labels.map((txt) => el('span', {}, txt))),
    puck);
  let [x, row] = value;
  function place() {
    puck.style.left = `calc(${INSET}px + ${x} * (100% - ${2 * INSET}px))`;
    puck.style.bottom = yPos(row);
    pad.style.setProperty('--pc', rowColor(row));
    pad.setAttribute('aria-valuenow', String(row + 1));
  }
  function set(nx, nr) {
    nx = clamp01(nx);
    nr = Math.max(0, Math.min(rows - 1, nr));
    if (Math.abs(nx - x) < 0.002 && nr === row) return;
    [x, row] = [nx, nr];
    place();
    onChange(x, row);
  }
  function fromEvent(e) {
    const b = pad.getBoundingClientRect();
    return [
      (e.clientX - b.left - INSET) / (b.width - 2 * INSET),
      Math.round(clamp01(1 - (e.clientY - b.top - INSET) / (b.height - 2 * INSET)) * (rows - 1)),
    ];
  }
  let down = false;
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    down = true;
    try { pad.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    pad.classList.add('active');
    set(...fromEvent(e));
    onTouch?.(true);
  });
  pad.addEventListener('pointermove', (e) => down && set(...fromEvent(e)));
  const up = () => {
    if (!down) return;
    down = false;
    pad.classList.remove('active');
    onTouch?.(false);
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  place();
  pad.nudge = (dx, dr) => set(x + dx, row + dr);
  pad.value = () => [x, row];
  return pad;
}
