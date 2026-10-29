/**
 * Decoration layer for <sense-weave>: controlled motion presets, deterministic hand-drawn
 * ("sketch") rendering and verbatim annotations. Pure DOM/CSS/WAAPI, no dependencies.
 * Everything here is optional: content is complete before and without any of it.
 */
const SVG = 'http://www.w3.org/2000/svg';
export const MOTION_PRESETS = Object.freeze(['none', 'reveal', 'stagger', 'draw', 'step-through', 'highlight', 'count-up', 'write']);
const SKETCH_TYPES = new Set(['steps', 'checklist', 'timeline', 'chart', 'plot', 'compare', 'diagram', 'derivation', 'callout']);

/** FNV-1a: stable seed from a block id, so the same block always gets the same strokes. */
export function seedOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193);}
  return h >>> 0;
}
/** mulberry32: small deterministic PRNG. Never Math.random, so re-renders never flicker. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296;};
}
const r2 = n => Math.round(n * 100) / 100;
/** A wobbly polyline through the given points: each segment bends through a jittered midpoint. */
export function roughPolyline(points, random, amp = 1.6) {
  if (points.length < 2) return '';
  const j = () => (random() - 0.5) * 2 * amp;
  let d = `M ${r2(points[0][0] + j())} ${r2(points[0][1] + j())}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    const mx = (x0 + x1) / 2 + j(), my = (y0 + y1) / 2 + j();
    d += ` Q ${r2(mx)} ${r2(my)} ${r2(x1 + j())} ${r2(y1 + j())}`;
  }
  return d;
}
/** Hand-drawn rectangle: two overlapping wobbly outlines, like a pen going round twice. */
export function roughRect(x, y, w, h, random, amp = 1.4) {
  const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + 0.2]];
  return roughPolyline(pts, random, amp) + ' ' + roughPolyline(pts.map(([a, b]) => [a + 0.6, b - 0.4]), random, amp * 0.8);
}
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
const num = (el, name) => Number.parseFloat(el.getAttribute(name) ?? '0') || 0;

/** Apply hand-drawn strokes to a rendered block. Idempotent per block node. */
export function sketchify(section, blockId) {
  if (section.dataset.sketched === 'yes') return;
  section.dataset.sketched = 'yes';
  section.setAttribute('data-sketch', '');
  const random = rng(seedOf(blockId));
  for (const chart of section.querySelectorAll('svg')) {
    chart.classList.add('sw-sketch-svg');
    for (const rect of [...chart.querySelectorAll('rect')]) {
      const w = num(rect, 'width'), h = num(rect, 'height');
      if (w <= 0 || h <= 0 || rect.closest('defs')) continue;
      const vb = chart.viewBox?.baseVal;
      if (vb && w >= vb.width * 0.95 && h >= vb.height * 0.95) continue; // background
      const path = svg('path', {d: roughRect(num(rect, 'x'), num(rect, 'y'), w, h, random), class: 'sw-rough', fill: rect.getAttribute('fill') ?? 'none', 'fill-opacity': '0.85', 'data-rough': 'rect', pathLength: '1'});
      const title = rect.querySelector('title');
      if (title) path.append(title.cloneNode(true));
      rect.setAttribute('opacity', '0');
      rect.after(path);
    }
    for (const line of [...chart.querySelectorAll('polyline')]) {
      const pts = (line.getAttribute('points') ?? '').trim().split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
      if (pts.length < 2) continue;
      const path = svg('path', {d: roughPolyline(pts, random, 1.8), class: `${line.getAttribute('class') ?? ''} sw-rough`, fill: 'none', pathLength: '1'});
      line.setAttribute('opacity', '0');
      line.after(path);
    }
    for (const line of [...chart.querySelectorAll('line')]) {
      const x1 = num(line, 'x1'), y1 = num(line, 'y1'), x2 = num(line, 'x2'), y2 = num(line, 'y2');
      const path = svg('path', {d: roughPolyline([[x1, y1], [(x1 + x2) / 2, (y1 + y2) / 2], [x2, y2]], random, 0.9), class: `${line.getAttribute('class') ?? ''} sw-rough-line`, fill: 'none', ...(line.getAttribute('stroke') ? {stroke: line.getAttribute('stroke')} : {})});
      line.setAttribute('opacity', '0');
      line.after(path);
    }
  }
  // A wobbly frame drawn in a normalized 100×100 box that stretches with the block.
  const frame = svg('svg', {class: 'sw-sketch-frame', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false'});
  frame.append(svg('path', {d: roughRect(1, 1, 98, 98, random, 0.7), 'vector-effect': 'non-scaling-stroke', fill: 'none'}));
  section.append(frame); // on top, so figure backgrounds never hide the frame
}

/** Number the animatable children so CSS can stagger them without inline timing logic. */
function index(section, selector) {
  [...section.querySelectorAll(selector)].slice(0, 24).forEach((n, i) => n.style.setProperty('--sw-i', String(i)));
}
/** Count up to numbers that are already displayed. The final text is restored exactly. */
function countUp(section, isReduced) {
  if (isReduced() || !globalThis.requestAnimationFrame) return;
  const nodes = [...section.querySelectorAll('svg text.sw-value, svg text[data-value]')].slice(0, 20);
  for (const node of nodes) {
    const final = node.textContent ?? '';
    const m = final.match(/-?\d+(?:\.\d+)?/);
    if (!m) continue;
    const target = Number(m[0]), decimals = (m[0].split('.')[1] ?? '').length, start = performance.now(), duration = 700;
    const step = now => {
      if (!node.isConnected || isReduced()) {node.textContent = final; return;}
      const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 3;
      node.textContent = t >= 1 ? final : final.replace(m[0], (target * eased).toFixed(decimals));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
/** Mark the largest value so a "highlight" preset can draw attention to the key difference. */
function markKey(section) {
  const bars = [...section.querySelectorAll('svg [data-value]')];
  if (bars.length > 1) {
    const max = Math.max(...bars.map(b => Number(b.getAttribute('data-value'))));
    bars.filter(b => Number(b.getAttribute('data-value')) === max).forEach(b => b.classList.add('sw-key'));
  }
}

/** Play one preset once on a freshly rendered block. Returns the preset actually applied. */
export function applyMotion(section, preset, {isReduced = () => false} = {}) {
  if (!MOTION_PRESETS.includes(preset) || preset === 'none' || isReduced()) return 'none';
  section.dataset.motion = preset;
  if (preset === 'stagger' || preset === 'step-through' || preset === 'write') index(section, ':scope > ol > li, :scope > ul > li, .checklist li, .timeline > li, .sw-derivation > li, table tbody tr');
  if (preset === 'highlight') {index(section, 'table th, table tbody tr'); markKey(section);}
  if (preset === 'draw') index(section, 'svg rect, svg path.sw-rough, svg polyline, svg circle');
  if (preset === 'count-up') countUp(section, isReduced);
  // Drop the trigger after it played, so later re-renders of the same node never replay it.
  const done = () => {section.dataset.motionDone = preset;};
  section.addEventListener('animationend', done, {once: true});
  return preset;
}

/** Wrap verbatim phrases inside rendered prose. Text is never changed, only marked. */
export function annotate(section, annotations) {
  let count = 0;
  for (const a of annotations) {
    const phrase = a.phrase;
    if (typeof phrase !== 'string' || phrase.length < 2) continue;
    const walker = section.ownerDocument.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('mark.sw-annot, code, pre, button, summary')) continue;
      const at = node.data.indexOf(phrase);
      if (at < 0) continue;
      const target = node.splitText(at);
      target.splitText(phrase.length);
      const mark = section.ownerDocument.createElement('mark');
      mark.className = 'sw-annot';
      mark.dataset.kind = a.kind === 'circle' ? 'circle' : 'underline';
      mark.style.setProperty('--sw-i', String(count++));
      target.replaceWith(mark);
      mark.append(target);
      break;
    }
  }
  return count;
}

export function sketchable(type) {return SKETCH_TYPES.has(type);}
