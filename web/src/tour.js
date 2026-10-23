// Coach marks for the first-run tour: ghost thumbs that act out a move on the real controls,
// a short tip, and a pulsing target. Only visuals; main.js decides what to show when.
import { el } from './ui.js';

// A thumb seen from above, pointing up; its tip is the top edge.
const THUMB = `<svg viewBox="0 0 60 110" aria-hidden="true">
  <path class="skin" d="M30 2c15.5 0 27 12.5 27 29v77H3V31C3 14.5 14.5 2 30 2z"/>
  <path class="nail" d="M30 9c9 0 15 6.5 15 15v9c0 4.5-6.5 7-15 7s-15-2.5-15-7v-9c0-8.5 6-15 15-15z"/>
  <path class="crease" d="M12 66c11 4 25 4 36 0"/>
</svg>`;

export class Coach {
  constructor() {
    this.layer = el('div', { class: 'coach' });
    document.body.append(this.layer);
    this.marks = []; // { node, target, side }
    this.pulsed = null;
    const place = () => this.place();
    addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
  }

  // Ghost thumbs. `right` is held down (the record button); `left` acts out `move` on its
  // target: 'slide' (a knob), 'tap' (launchpad pads) or 'drag' (the FX pad).
  hands({ left, right, move = 'slide' }) {
    if (right) this.#mark(this.#thumb('right hold'), right, 'center');
    if (left) this.#mark(this.#thumb(`left ${move}`), left, 'center');
    this.place();
  }

  // A short tip next to `target` ('below', 'above' or 'over' it), with an optional skip link.
  tip(text, target, side, onSkip) {
    const node = el('div', { class: `coach-tip ${side}` }, el('span', {}, text),
      onSkip ? el('button', { class: 'coach-skip', onclick: onSkip }, 'Skip tour') : null);
    this.#mark(node, target, side);
    this.place();
  }

  pulse(target) {
    this.pulsed?.classList.remove('coach-pulse');
    this.pulsed = target;
    target?.classList.add('coach-pulse');
  }

  // Step aside while a finger is on the screen, so the ghost never covers what you do.
  away(on) {
    this.layer.classList.toggle('away', on);
  }

  clear() {
    for (const m of this.marks) m.node.remove();
    this.marks = [];
    this.pulse(null);
  }

  place() {
    const w = document.documentElement.clientWidth;
    for (const { node, target, side } of this.marks) {
      const r = target.getBoundingClientRect();
      const x = r.left + r.width / 2;
      // 'over' sits near the top of its target, out of the way of what happens below.
      const y = side === 'below' ? r.bottom
        : side === 'above' ? r.top
          : side === 'over' ? r.top + Math.min(r.height / 2, 36)
            : r.top + r.height / 2;
      node.style.setProperty('--tw', `${r.width}px`);
      node.style.setProperty('--th', `${r.height}px`);
      node.style.top = `${y}px`;
      if (!node.classList.contains('coach-tip')) {
        node.style.left = `${x}px`;
        continue;
      }
      // Tips stay on screen; their arrow keeps pointing at the target.
      const half = node.offsetWidth / 2;
      const left = Math.min(w - 12 - half, Math.max(12 + half, x));
      node.style.left = `${left}px`;
      node.style.setProperty('--arrow', `${x - left}px`);
    }
  }

  #thumb(cls) {
    const node = el('div', { class: `thumb ${cls}` }, el('i', { class: 'touch' }));
    node.insertAdjacentHTML('beforeend', THUMB);
    return node;
  }

  #mark(node, target, side) {
    this.layer.append(node);
    this.marks.push({ node, target, side });
  }
}
