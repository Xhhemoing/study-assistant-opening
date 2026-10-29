import {
  validateDocument,
  normalizeSources,
  projectText,
  exportDocument,
  matrixFrame,
  patchBlock,
  layoutDiagram,
  mathText,
  documentScope,
  resolveBinding,
  calcValues,
  formatNumber,
  BINDING,
  CATALOG
} from '../core/document.mjs';
import {parseMarkdown} from '../core/markdown.mjs';
import {composeText} from '../core/compose.mjs';
import {ELEMENT_CSS} from './style.mjs';
import {renderExtended} from './extended.mjs';
import {applyMotion, sketchify, annotate, sketchable} from './motion.mjs';
import {diagramShape, diagramEdge, diagramShapeNames, diagramStyleNames, diagramDirectionNames} from './diagram.mjs';
/**
 * Placement 'replace': the component stands in for a verbatim answer span. A native
 * <details> keeps the original one keyboard/screen-reader step away, collapsed by default.
 */
function originalDisclosure(b) {
  const details = el('details', undefined, {class: 'sw-original', 'data-original-for': b.id});
  details.append(
    el('summary', '查看原文', {'aria-label': '查看原文：组件依据的逐字原文'}),
    el('p', b.original, {class: 'sw-original-text', lang: 'zh-CN'})
  );
  return details;
}
function el(tag, text, attrs = {}) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
/** Table cells accept either plain values or already-built inline nodes. */
function cell(tag, value, attrs) {
  if (Array.isArray(value)) {
    const n = el(tag, undefined, attrs);
    n.append(...value);
    return n;
  }
  return el(tag, String(value), attrs);
}
const literal = text => [document.createTextNode(text)];
/**
 * Text with {{expr}} bindings → text nodes plus `.bound` spans. Each span keeps its expression,
 * so refreshBindings can recompute every number in place when an input changes. While a
 * document is still streaming, a binding to a block that has not arrived yet shows "…".
 */
function boundNodes(text, scope, streaming) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(BINDING)) {
    const r = resolveBinding(m[1], m[2], scope);
    if (!r.ok && !streaming) continue;
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const expr = m[1].trim();
    out.push(
      el('span', r.ok ? r.text : '…', {
        class: r.ok ? 'bound' : 'bound waiting',
        'data-expr': expr,
        ...(m[2] === undefined ? {} : {'data-digits': m[2]}),
        title: `由 ${expr} 实时计算`
      })
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
function inlineNodes(items, bind = literal) {
  return items.flatMap(x => {
    if (x.type === 'text') return bind(x.text);
    if (x.type === 'code') return el('code', x.text);
    if (x.type === 'link') {
      const a = el('a', undefined, {
        href: x.href,
        target: '_blank',
        rel: 'noopener noreferrer',
        referrerpolicy: 'no-referrer'
      });
      a.append(...inlineNodes(x.children, bind));
      return a;
    }
    const n = el(x.type === 'strong' ? 'strong' : x.type === 'em' ? 'em' : 'del');
    n.append(...inlineNodes(x.children, bind));
    return n;
  });
}
/** Markdown subset tree → DOM. Block titles are h2, so Markdown headings start at h3. */
function markdownNodes(blocks, bind = literal) {
  return blocks.map(x => {
    if (x.type === 'paragraph') {
      const p = el('p');
      p.append(...inlineNodes(x.children, bind));
      return p;
    }
    if (x.type === 'heading') {
      const h = el(`h${Math.min(6, x.level + 2)}`);
      h.append(...inlineNodes(x.children, bind));
      return h;
    }
    if (x.type === 'code') {
      const pre = el('pre');
      pre.append(el('code', x.text, x.language ? {'data-language': x.language} : {}));
      return pre;
    }
    if (x.type === 'rule') return el('hr');
    if (x.type === 'quote') {
      const q = el('blockquote');
      q.append(...markdownNodes(x.children, bind));
      return q;
    }
    if (x.type === 'list') {
      const list = el(x.ordered ? 'ol' : 'ul', undefined, x.start > 1 ? {start: x.start} : {});
      for (const item of x.items) {
        const li = el('li');
        li.append(...inlineNodes(item, bind));
        list.append(li);
      }
      return list;
    }
    return tableOf(
      x.header.map(c => inlineNodes(c, bind)),
      x.rows.map(r => r.map(c => inlineNodes(c, bind)))
    );
  });
}
function bodyNode(b, bind = literal) {
  if (b.format !== 'markdown') {
    const p = el('p', undefined, {class: 'body-copy'});
    p.append(...bind(b.body));
    return p;
  }
  const wrap = el('div', undefined, {class: 'body-copy markdown'});
  wrap.append(...markdownNodes(parseMarkdown(b.body), bind));
  return wrap;
}
function btn(text, fn, attrs = {}) {
  const b = el('button', text, {type: 'button', ...attrs});
  b.addEventListener('click', fn);
  return b;
}
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    // Presentation attributes cannot resolve CSS variables; theme tokens go through style.
    if (typeof v === 'string' && v.startsWith('var(')) n.style.setProperty(k, v);
    else n.setAttribute(k, String(v));
  }
  return n;
}
function tableOf(columns, rows, inline = null, blockId = '') {
  const wrap = el('div', undefined, {
    class: 'table-wrap',
    tabindex: '0',
    role: 'region',
    'aria-label': '可横向滚动的数据表'
  });
  const table = el('table');
  const head = el('thead'),
    tr = el('tr');
  columns.forEach(x => tr.append(cell('th', x, {scope: 'col'})));
  head.append(tr);
  const body = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    row.forEach(x => r.append(cell('td', (typeof x === 'string' && inline?.(x, {blockId, type: 'compare', role: 'cell'})) || x)));
    body.append(r);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
function mathNode(tree) {
  const tags = {
    row: 'mrow',
    frac: 'mfrac',
    sup: 'msup',
    sub: 'msub',
    sqrt: 'msqrt',
    text: 'mtext',
    number: 'mn',
    symbol: 'mo'
  };
  const n = document.createElementNS('http://www.w3.org/1998/Math/MathML', tags[tree.op]);
  if (tree.args) tree.args.forEach(x => n.append(mathNode(x)));
  else n.textContent = tree.value;
  return n;
}
function downloadText(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = el('a', undefined, {href: url, download: name});
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Embeddable dependency-free Web Component. Shadow DOM isolates style, not security. */
export class SenseWeave extends HTMLElement {
  static get observedAttributes() {
    return ['chrome'];
  }
  attributeChangedCallback(name) {
    if (name === 'chrome' && this._ready && this._doc) this.render();
  }
  /** chrome="none": only the blocks, for hosts that place single blocks inside their own message layout. */
  get bare() {
    return this.getAttribute('chrome') === 'none';
  }
  /**
   * Optional host hook for short inline text (table cells, steps, timeline, checklist labels):
   * (text, {blockId, type, role}) => Node[] | Node | null. Lets a host apply its own TeX renderer or
   * citation links. Returning null keeps the built-in plain text. Host nodes are trusted host output.
   */
  get renderInline() {
    return this._renderInline ?? null;
  }
  set renderInline(fn) {
    if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('renderInline must be a function');
    this._renderInline = fn ?? null;
    if (this._ready && this._doc) {
      this.nodes?.forEach(n => n.remove());
      this.nodes?.clear();
      this.render();
    }
  }
  inline(text, info) {
    const fn = this._renderInline;
    if (!fn || typeof text !== 'string' || !text) return null;
    try {
      const out = fn(text, info);
      if (!out) return null;
      const list = (Array.isArray(out) ? out : [out]).filter(n => n instanceof Node);
      return list.length ? list : null;
    } catch (error) {
      this.dispatchEvent(new CustomEvent('sw-interaction', {detail: {type: 'inline.error', blockId: info?.blockId, message: String(error?.message ?? error)}}));
      return null;
    }
  }
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this._sources = [];
    this._doc = null;
    this.nodes = new Map();
    this.local = new Map();
    this.mode = 'rich';
    this._motionPreference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    this._motion = this._motionPreference?.matches ?? false;
    this._motionOverride = false;
    this._onMotionPreference = event => {
      if (!this._motionOverride) {this._motion = event.matches; this.applyMotionPreference();}
    };
    this.log = [];
    this.pending = null;
    this.dirty = false;
    this._timers = new Set();
    this._printCleanups = [];
    this._afterPrint = () => {
      for (const cleanup of this._printCleanups.splice(0)) cleanup();
    };
    this._beforePrint = () => {
      this._afterPrint();
      for (const section of this.body?.children ?? []) {
        const cleanup = section._swPrint?.();
        if (cleanup) this._printCleanups.push(cleanup);
      }
    };
  }
  connectedCallback() {
    this._printWindow?.removeEventListener('beforeprint', this._beforePrint);
    this._printWindow?.removeEventListener('afterprint', this._afterPrint);
    this._printWindow = this.ownerDocument.defaultView;
    this._printWindow?.addEventListener('beforeprint', this._beforePrint);
    this._printWindow?.addEventListener('afterprint', this._afterPrint);
    this._motionPreference?.removeEventListener?.('change', this._onMotionPreference);
    this._motionPreference?.addEventListener?.('change', this._onMotionPreference);
    if (!this._motionOverride) this._motion = this._motionPreference?.matches ?? false;
    if (this._ready) {
      this.applyMotionPreference();
      if (this._visibility) document.addEventListener('visibilitychange', this._visibility);
      return;
    }
    this._ready = true;
    const style = el('style', ELEMENT_CSS);
    this.root = el('article', undefined, {part: 'surface'});
    this.head = el('header', undefined, {part: 'header'});
    this.toolbar = el('div', undefined, {class: 'toolbar', part: 'toolbar'});
    this.stream = el('div', '', {class: 'stream', hidden: '', part: 'stream'});
    this.notice = el('div', '', {class: 'notice', role: 'status', part: 'notice'});
    this.live = el('div', '', {
      class: 'sr',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });
    this.body = el('div', undefined, {class: 'body', part: 'body'});
    this.plain = el('div', undefined, {class: 'plain', hidden: '', part: 'plain'});
    this.sourcesArea = el('div', undefined, {part: 'sources'});
    this.root.append(
      this.head,
      this.toolbar,
      this.stream,
      this.notice,
      this.body,
      this.plain,
      this.sourcesArea,
      this.live
    );
    this.shadowRoot.append(style, this.root);
    this.makeToolbar();
    this.applyMotionPreference();
    if (this._doc) this.render();
    this._visibility = () => {
      if (document.hidden) this.stopMotion();
    };
    document.addEventListener('visibilitychange', this._visibility);
  }
  disconnectedCallback() {
    this.stopMotion();
    this._printWindow?.removeEventListener('beforeprint', this._beforePrint);
    this._printWindow?.removeEventListener('afterprint', this._afterPrint);
    this._printWindow = null;
    this._afterPrint();
    this._motionPreference?.removeEventListener?.('change', this._onMotionPreference);
    document.removeEventListener('visibilitychange', this._visibility);
  }
  stopMotion() {
    for (const t of this._timers) clearInterval(t);
    this._timers.clear();
    this.shadowRoot?.querySelectorAll('[data-play]').forEach(x => {
      x.textContent = '播放变化';
      x.dataset.running = 'no';
    });
  }
  get motion() {return this._motion;}
  set motion(value) {
    this._motionOverride = true;
    this._motion = value === true;
    this.applyMotionPreference();
  }
  applyMotionPreference() {
    if (!this._ready) return;
    this.toggleAttribute('data-reduced-motion', this._motion);
    this.motionButton?.setAttribute('aria-pressed', String(this._motion));
    if (this._motion) this.stopMotion();
  }
  /**
   * Presentation hints from the runtime (envelope.hints): motion presets, sketch style and
   * verbatim annotations. Decoration only; ignored for a different document id.
   */
  get hints() {
    return this._hints ? structuredClone(this._hints) : null;
  }
  set hints(value) {
    this._hints = value && typeof value === 'object' ? structuredClone(value) : null;
    if (!this._ready || !this._doc) return;
    for (const b of this._doc.blocks) {
      const node = this.nodes.get(b.id);
      if (node) this.decorate(node, b);
    }
  }
  hintsFor(b) {
    const h = this._hints;
    if (!h || !this._doc || h.documentId && h.documentId !== this._doc.id) return null;
    return {
      motion: h.motion?.enabled ? h.motion.blocks?.[b.id]?.preset ?? 'none' : 'none',
      sketch: !!h.sketch?.enabled && (Array.isArray(h.sketch.blocks) && h.sketch.blocks.includes(b.id) || b.type === 'derivation') && sketchable(b.type),
      annotations: (h.annotations ?? []).filter(a => a.blockId === b.id).slice(0, 5)
    };
  }
  decorate(node, b) {
    const h = this.hintsFor(b);
    if (!h) return;
    if (h.sketch) sketchify(node, b.id);
    if (h.annotations.length && !node.querySelector('mark.sw-annot')) annotate(node, h.annotations);
    // Play once per block content, never while composing/streaming, never for reduced motion.
    this._played ??= new Set();
    const key = `${this._doc.id}:${b.id}:${node.dataset.signature ?? ''}`;
    if (h.motion === 'none' || this._composing || this._played.has(key) || node.dataset.motion) return;
    this._played.add(key);
    if (this._played.size > 200) this._played.delete(this._played.values().next().value);
    applyMotion(node, h.motion, {isReduced: () => this._motion === true || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches});
  }
  get sources() {
    return structuredClone(this._sources);
  }
  set sources(value) {
    const registry = normalizeSources(value ?? []);
    const next = this._doc ? validateDocument(this._doc, {sources: registry, partial: !!this._composing}) : null;
    const pending = this.pending ? validateDocument(this.pending, {sources: registry}) : null;
    // Stage both validations before committing authorization: a queued revision must never
    // carry a formerly available registry back into the current document after revocation.
    this._sources = registry;
    this.pending = pending;
    // Assignment order must not matter: re-check the current document against the new registry.
    if (this._doc) {
      this._doc = next;
      if (this._ready) this.render();
    }
  }
  /**
   * Order documents by [producer revision, local edits]. patchBlock keeps the producer revision
   * in baseRevision, so a local edit (r1 → r2) never collides with the producer's own r2.
   */
  static versionOf(doc) {
    const base = doc.baseRevision ?? doc.revision;
    return [base, doc.revision - base];
  }
  set document(value) {
    const doc = validateDocument(value, {sources: this._sources});
    // The final commit of a document that was being composed replaces the live preview. Only
    // changed blocks re-render, so the reader's slider positions and checkboxes stay put.
    if (this._composing && this._doc?.id === doc.id) {
      this._composing = false;
      this._pendingType = null;
      this._doc = doc;
      if (this._ready) this.render();
      return;
    }
    this._composing = false;
    this._pendingType = null;
    const same = this._doc?.id === doc.id;
    if (same && JSON.stringify(doc) === JSON.stringify(this._doc)) return;
    const [inBase, inLocal] = SenseWeave.versionOf(doc);
    const [curBase, curLocal] = same ? SenseWeave.versionOf(this._doc) : [0, 0];
    const order = inBase - curBase || inLocal - curLocal;
    if (same && order < 0) {
      this.showNotice('已忽略迟到的旧版本。');
      return;
    }
    if (same && order === 0) {
      this.showNotice('同版本内容冲突，保留当前文档。');
      return;
    }
    // A newer producer revision while the reader has drafts or local parameter edits is staged.
    if (same && (this.dirty || curLocal > 0) && inBase > curBase) {
      this.pending = doc;
      this.showNotice('有新版本。你的草稿已保留；先导出或对比，不会自动覆盖。');
      this.updateButton.hidden = false;
      return;
    }
    if (this._doc?.id !== doc.id) {
      this.stopMotion();
      this.local.clear();
      this.nodes.clear();
      this.body?.replaceChildren();
      this.dirty = false;
      this.pending = null;
    }
    this._doc = doc;
    if (this._ready) this.render();
  }
  get document() {
    return structuredClone(this._doc);
  }
  makeToolbar() {
    this.richButton = btn('图文阅读', () => this.setMode('rich'), {'aria-pressed': 'true'});
    this.plainButton = btn('纯文字', () => this.setMode('plain'), {'aria-pressed': 'false'});
    this.motionButton = btn(
      '减少动态',
      () => {
        this.motion = !this.motion;
      },
      {'aria-pressed': String(this.motion)}
    );
    this.updateButton = btn('对比新版本', () => this.comparePending());
    this.updateButton.hidden = true;
    this.rev = el('span', '', {class: 'revision'});
    this.toolbar.append(
      this.richButton,
      this.plainButton,
      this.motionButton,
      btn('导出正文', () =>
        downloadText(
          'senseweave-output.txt',
          this._doc ? projectText(this._doc, {overrides: this.overrides()}) : '',
          'text/plain'
        )
      ),
      btn('导出规格', () =>
        downloadText(
          'senseweave-document.json',
          JSON.stringify(this._doc ? exportDocument(this._doc) : null, null, 2),
          'application/json'
        )
      ),
      this.updateButton,
      this.rev
    );
  }
  setMode(mode) {
    this.mode = mode;
    this.stopMotion();
    this.body.hidden = mode === 'plain';
    this.sourcesArea.hidden = mode === 'plain';
    this.plain.hidden = mode !== 'plain';
    this.richButton.setAttribute('aria-pressed', String(mode === 'rich'));
    this.plainButton.setAttribute('aria-pressed', String(mode === 'plain'));
    if (this._doc) this.plain.textContent = projectText(this._doc, {includeOriginal: false, overrides: this.overrides()});
    this.emit('view.mode', {mode});
  }
  setStream(text) {
    if (!this._ready) this.connectedCallback();
    this.stream.hidden = !text;
    this.stream.textContent = text;
  }
  /**
   * Progressive rendering of an inline-composed answer. Call with the full text received so
   * far; finished components render as soon as their fence closes, an open fence shows a
   * placeholder. The later `document` commit with the same id ends the preview.
   */
  setComposing(text, {id = this._doc?.id ?? 'composing'} = {}) {
    if (!this._ready) this.connectedCallback();
    const {document: doc, pending} = composeText(text, {
      id,
      title: '正在生成…',
      sources: this._sources
    });
    this.setPreview(doc, pending);
  }
  /** Commit a precompiled streaming preview without parsing the same full text twice. */
  setPreview(value, pending = null) {
    if (!this._ready) this.connectedCallback();
    const doc = validateDocument(value, {sources: this._sources, partial: true});
    if (this._doc?.id !== doc.id) {
      this.stopMotion();
      this.local.clear();
      this.nodes.clear();
      this.body.replaceChildren();
      this.dirty = false;
      this.pending = null;
      this.updateButton.hidden = true;
    }
    this._composing = true;
    this._pendingType = pending?.type ?? null;
    this._doc = doc;
    this.stream.hidden = true;
    this.render();
  }
  /** Ends a preview without a commit (failure or cancel): show exactly what was received. */
  finishComposing(text) {
    if (!this._composing) return;
    const {document: doc} = composeText(text, {
      id: this._doc.id,
      sources: this._sources,
      final: true
    });
    this.document = doc;
  }
  /** Current calc input values by block, used by bindings, outputs and the text projection. */
  overrides() {
    const out = {};
    for (const [id, s] of this.local) if (s.calc) out[id] = s.calc;
    return out;
  }
  /** Recompute every bound number in place from the one shared scope. */
  refreshBindings() {
    if (!this._doc || !this.shadowRoot) return;
    const scope = documentScope(this._doc, this.overrides());
    for (const span of this.shadowRoot.querySelectorAll('.bound')) {
      const r = resolveBinding(span.dataset.expr, span.dataset.digits, scope);
      if (r.ok) {
        span.textContent = r.text;
        span.classList.remove('waiting');
      } else if (!this._composing) span.textContent = `{{${span.dataset.expr}}}`;
    }
    this.plain.textContent = projectText(this._doc, {includeOriginal: false, overrides: this.overrides()});
  }
  showNotice(text) {
    if (this.notice) this.notice.textContent = text;
  }
  announce(text) {
    this.live.textContent = text;
  }
  emit(type, detail = {}) {
    const event = {type, documentId: this._doc?.id, revision: this._doc?.revision, ...detail};
    this.log.push(event);
    if (this.log.length > 200) this.log.shift();
    this.dispatchEvent(
      new CustomEvent('sw-interaction', {detail: event, bubbles: true, composed: true})
    );
  }
  comparePending() {
    if (!this.pending) return;
    const box = el('section', undefined, {class: 'warning'});
    box.append(
      el('h2', '版本对比：不会覆盖你的输入'),
      el('p', `当前 r${this._doc.revision} → 新版 r${this.pending.revision}`),
      tableOf(
        ['变化位置', '当前', '新版本'],
        [
          ['摘要', this._doc.summary, this.pending.summary],
          ...this.pending.blocks
            .filter(
              b => JSON.stringify(b) !== JSON.stringify(this._doc.blocks.find(x => x.id === b.id))
            )
            .map(b => [
              b.title || b.id,
              JSON.stringify(this._doc.blocks.find(x => x.id === b.id) ?? '新增'),
              JSON.stringify(b)
            ]),
          ...this._doc.blocks
            .filter(b => !this.pending.blocks.some(x => x.id === b.id))
            .map(b => [b.title || b.id, '保留于当前版本', '新版删除'])
        ]
      )
    );
    box.append(
      btn('应用新版并保留交互草稿', () => {
        // Authorization belongs to the current host registry, not a saved revision.
        this._doc = validateDocument(this.pending, {sources: this._sources});
        this.pending = null;
        this.dirty = false;
        this.updateButton.hidden = true;
        box.remove();
        this.render();
        this.showNotice('已应用新版；相同块 ID 的输入仍保留，请检查题目是否变化。');
      })
    );
    this.notice.replaceChildren(box);
  }
  render() {
    const doc = this._doc;
    const scope = documentScope(doc, this.overrides());
    this._bind = text => boundNodes(text, scope, this._composing);
    const summary = el('p', undefined, {class: 'summary'});
    summary.append(...this._bind(doc.summary));
    this.head.replaceChildren(
      el('div', this._composing ? 'GENERATING · 边写边出图' : 'SEMANTIC OUTPUT · 可检查的表达', {
        class: 'eyebrow'
      }),
      el('h1', doc.title),
      summary
    );
    this.root.toggleAttribute('data-composing', !!this._composing);
    const [base, local] = SenseWeave.versionOf(doc);
    this.rev.textContent = this._composing
      ? `生成中 · 已就绪 ${doc.blocks.length} 个语义块`
      : `内容版本 r${base}${local ? ` · 本地修改 ${local} 次` : ''} · ${doc.blocks.length} 个语义块`;
    this.plain.textContent = projectText(doc, {includeOriginal: false, overrides: this.overrides()});
    const wanted = new Set(doc.blocks.map(b => b.id));
    for (const [id, n] of this.nodes)
      if (!wanted.has(id)) {
        n.remove();
        this.nodes.delete(id);
      }
    // Only changed blocks are replaced. View state and drafts are held separately by stable block ID.
    for (const [index, b] of doc.blocks.entries()) {
      // Bound text depends on other blocks' data; editing a matrix must refresh that prose.
      // Calc inputs are excluded: they update spans in place without rebuilding sliders.
      const bound = b.body.includes('{{');
      const signature =
        JSON.stringify(b) +
        (b.type === 'evidence' ? JSON.stringify(doc.sources.map(s => [s.id, s.access])) : '') +
        (bound ? JSON.stringify([...documentScope(doc).values]) : '') +
        (this._composing && bound ? ':live' : '');
      let node = this.nodes.get(b.id);
      if (!node || node.dataset.signature !== signature) {
        if (node) {
          this.stopMotion();
          node._swCaptureState?.();
        }
        const next = this.renderBlock(b);
        if (b.original) next.append(originalDisclosure(b));
        next.dataset.signature = signature;
        next.dataset.block = b.id;
        this.decorate(next, b);
        if (node) node.replaceWith(next);
        node = next;
        this.nodes.set(b.id, node);
      }
      const current = this.body.children[index];
      if (current !== node) this.body.insertBefore(node, current ?? null);
    }
    // Placeholder for a component whose fence is still open. Never a half-parsed component.
    this.skeleton?.remove();
    this.skeleton = null;
    if (this._composing && this._pendingType) {
      const name = CATALOG[this._pendingType] ?? '组件';
      this.skeleton = el('section', undefined, {
        class: 'skeleton',
        'aria-busy': 'true',
        'aria-label': `正在生成：${name}`
      });
      this.skeleton.append(
        el('span', `正在生成 · ${name}`, {class: 'meta'}),
        el('div', undefined, {class: 'bar'}),
        el('div', undefined, {class: 'bar short'})
      );
      this.body.append(this.skeleton);
    }
    this.sourcesArea.replaceChildren();
    if (doc.warnings.length) {
      const w = el('div', undefined, {class: 'warning'});
      doc.warnings.forEach(x => w.append(el('p', x)));
      this.head.append(w);
    }
    if (doc.checks?.length) {
      const c = el('div', undefined, {class: 'warning checks', role: 'note'});
      c.append(el('strong', '一致性检查'));
      doc.checks.forEach(x => c.append(el('p', x)));
      this.head.append(c);
    }
    if (!this.bare && doc.originalText && !/```\s*sw:exercise/.test(doc.originalText)) {
      const raw = el('details');
      raw.append(el('summary', '查看原始回答 · 不被增强结构覆盖'), el('pre', doc.originalText, {class: 'raw-source'}));
      this.sourcesArea.append(raw);
    }
    if (doc.sources.length) {
      const d = el('details');
      d.id = 'sources';
      d.append(el('summary', `来源与访问范围 · ${doc.sources.length}`));
      for (const s of doc.sources) {
        const card = el('section', undefined, {
          class: 'source',
          id: `source-${s.id}`,
          tabindex: '-1'
        });
        card.append(el('strong', s.title), el('p', s.locator, {class: 'meta'}));
        if (s.access === 'available') {
          card.append(el('p', s.excerpt));
          if (s.url)
            card.append(
              el('a', '打开原始来源 ↗', {
                href: s.url,
                target: '_blank',
                rel: 'noopener noreferrer',
                referrerpolicy: 'no-referrer'
              })
            );
        } else card.append(el('p', '材料当前不可访问；有来源名称不等于完成核验。'));
        d.append(card);
      }
      this.sourcesArea.append(d);
    }
    this.body.hidden = this.mode === 'plain';
    this.sourcesArea.hidden = this.mode === 'plain';
    this.plain.hidden = this.mode !== 'plain';
    // Announce once per document, not on every streamed chunk.
    if (!this._composing) {
      if (!this.bare) this.announce(`内容已就绪：${doc.title}`);
    }
    else if (this._announced !== doc.id) {
      this._announced = doc.id;
      this.announce('正在生成回答，完成后会再次提示。');
    }
  }
  localState(b) {
    if (!this.local.has(b.id))
      this.local.set(b.id, {
        draft: '',
        hints: 0,
        revealed: false,
        submitted: false,
        t: 0,
        matrixDraft: null
      });
    return this.local.get(b.id);
  }
  sourceButton(id) {
    return btn(
      `来源 ${id}`,
      () => {
        const d = this.sourcesArea.querySelector('#sources');
        const s = this._doc.sources.find(x => x.id === id);
        if (!d || !s) {
          this.showNotice(`未提供来源 ${id}，无法核验。`);
          return;
        }
        d.open = true;
        const target = [...d.querySelectorAll('.source')].find(x => x.id === `source-${id}`);
        target?.focus();
        this.emit('source.open', {sourceId: id});
      },
      {class: 'citation'}
    );
  }
  renderBlock(b) {
    const section = el('section', undefined, {'data-type': b.type});
    if (b.title) section.append(el('h2', b.title));
    if (b.body) section.append(bodyNode(b, this._bind));
    const data = b.data ?? {};
    const state = this.localState(b);
    const inline = (text, info) => this.inline(text, info);
    renderExtended(section, b, state, (type, detail) => this.emit(type, detail), inline);
    if (b.type === 'callout') section.classList.add('callout');
    if (b.type === 'calc') this.renderCalc(section, b, state);
    if (b.type === 'timeline') {
      const ol = el('ol', undefined, {class: 'timeline'});
      for (const x of data.items) {
        const li = el('li');
        const title = el('strong');
        title.append(...(inline(x.title, {blockId: b.id, type: 'timeline', role: 'title'}) ?? literal(x.title)));
        li.append(el('span', x.when, {class: 'when'}), title);
        if (x.detail) {
          const detail = el('p', undefined, {class: 'detail'});
          detail.append(...(inline(x.detail, {blockId: b.id, type: 'timeline', role: 'detail'}) ?? literal(x.detail)));
          li.append(detail);
        }
        ol.append(li);
      }
      section.append(ol);
    }
    if (b.type === 'checklist') this.renderChecklist(section, b, state);
    if (b.type === 'steps') {
      const ol = el('ol');
      data.items.forEach(x => {
        const li = el('li');
        li.append(...(inline(x, {blockId: b.id, type: 'steps', role: 'item'}) ?? literal(x)));
        ol.append(li);
      });
      section.append(ol);
    }
    if (b.type === 'compare') section.append(tableOf(data.columns, data.rows, inline, b.id));
    if (b.type === 'derivation') {
      // Board derivation: each line is verbatim answer text. $…$ spans are set in a math face only.
      const ol = el('ol', undefined, {class: 'sw-derivation', 'aria-label': '逐行推导'});
      data.lines.forEach(line => {
        const li = el('li');
        const host = inline(line.text, {blockId: b.id, type: 'derivation', role: 'item'});
        if (host) li.append(...host);
        else for (const [i, part] of line.text.split(/(\$[^$\n]{1,200}\$)/).entries()) {
          if (!part) continue;
          li.append(i % 2 ? el('span', part.slice(1, -1), {class: 'sw-math-inline'}) : document.createTextNode(part));
        }
        if (line.note) li.append(el('span', line.note, {class: 'meta sw-derivation-note'}));
        ol.append(li);
      });
      section.append(ol);
    }
    if (b.type === 'code') {
      const pre = el('pre');
      pre.append(el('code', data.code));
      const label = `${data.language ?? 'text'} · 仅展示，不执行`;
      const meta = el('p', label, {class: 'meta'});
      // Copy is a user action on text already shown; a refused clipboard is reported, not hidden.
      const copy = btn('复制代码', async () => {
        let ok = false;
        try {
          await navigator.clipboard.writeText(data.code);
          ok = true;
        } catch {}
        meta.textContent = `${label} · ${ok ? '已复制' : '浏览器未允许写入剪贴板'}`;
        this.emit('code.copy', {blockId: b.id, copied: ok});
      });
      section.append(pre, meta, copy);
    }
    if (b.type === 'math') {
      const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
      math.setAttribute('display', 'block');
      // The accessible name is the expression itself, not the surrounding explanation.
      math.setAttribute('aria-label', mathText(data.expression));
      math.append(mathNode(data.expression));
      section.append(math);
    }
    if (b.type === 'matrix') this.renderMatrix(section, b, state);
    if (b.type === 'chart') this.renderChart(section, b, state);
    if (b.type === 'diagram') this.renderDiagram(section, b, state);
    if (b.type === 'evidence') {
      const relations = {
        supported: '关联依据 · 仍需核验',
        inferred: '设计推断',
        contested: '存在分歧',
        missing: '证据缺口'
      };
      for (const c of data.claims) {
        const row = el('div', undefined, {class: 'claim'});
        const missing =
          !c.sourceIds?.length ||
          c.sourceIds.some(
            id => !this._doc.sources.some(s => s.id === id && s.access === 'available')
          );
        row.append(
          el('span', missing ? '材料不可核验' : relations[c.relation], {
            class: `badge ${missing || c.relation === 'missing' ? 'caution' : ''}`
          }),
          el('span', c.text)
        );
        const refs = el('div');
        (c.sourceIds ?? []).forEach(id => refs.append(this.sourceButton(id)));
        row.append(refs);
        section.append(row);
      }
    }
    if (b.type === 'exercise') this.renderExercise(section, b, state);
    if (b.qualifiers.length) {
      const q = el('div', undefined, {class: 'qualifiers'});
      b.qualifiers.forEach(x => q.append(el('p', '条件 / 边界：' + x)));
      section.append(q);
    }
    if (b.refs.length) {
      const refs = el('div');
      b.refs.forEach(id => refs.append(this.sourceButton(id)));
      section.append(refs);
    }
    return section;
  }
  renderMatrix(section, b, state) {
    const matrix = b.data.matrix;
    const extent = Math.max(
      2,
      ...matrix.flat().map(Math.abs),
      Math.abs(matrix[0][0] + matrix[0][1]),
      Math.abs(matrix[1][0] + matrix[1][1])
    );
    const unit = 120 / extent;
    const figure = el('figure', undefined, {class: 'figure'});
    const scene = el('div');
    const controls = el('div', undefined, {class: 'figure-tools'});
    const metrics = el('div', undefined, {class: 'metrics'});
    const range = el('input', undefined, {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      'aria-label': '变换进度'
    });
    range.value = state.t;
    const label = el('label', '观察进度', {class: 'range-label'});
    label.append(range);
    const group = el('div', undefined, {class: 'group'});
    const draw = () => {
      const f = matrixFrame(matrix, state.t);
      const sv = svgEl('svg', {
        viewBox: '0 0 500 300',
        role: 'img',
        'aria-label': `变换进度 ${f.t}，面积倍数 ${f.area}`
      });
      sv.append(svgEl('rect', {x: 0, y: 0, width: 500, height: 300, fill: 'var(--sw-figure-bg)'}));
      const pt = ([x, y]) => [250 + x * unit, 158 - y * unit];
      for (let i = -8; i <= 8; i++) {
        sv.append(
          svgEl('line', {
            x1: 34,
            y1: 158 - i * unit,
            x2: 466,
            y2: 158 - i * unit,
            stroke: 'var(--sw-grid)'
          }),
          svgEl('line', {
            x1: 250 + i * unit,
            y1: 20,
            x2: 250 + i * unit,
            y2: 278,
            stroke: 'var(--sw-grid)'
          })
        );
      }
      sv.append(
        svgEl('line', {x1: 25, y1: 158, x2: 475, y2: 158, stroke: 'var(--sw-axis)'}),
        svgEl('line', {x1: 250, y1: 16, x2: 250, y2: 282, stroke: 'var(--sw-axis)'})
      );
      const original = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ]
        .map(pt)
        .map(x => x.join(','))
        .join(' ');
      sv.append(
        svgEl('polygon', {
          points: original,
          fill: 'none',
          stroke: 'var(--sw-muted-line)',
          'stroke-dasharray': '4 4'
        })
      );
      const points = [[0, 0], f.e1, [f.e1[0] + f.e2[0], f.e1[1] + f.e2[1]], f.e2]
        .map(pt)
        .map(x => x.join(','))
        .join(' ');
      sv.append(
        svgEl('polygon', {
          points,
          fill: 'var(--sw-shape-fill)',
          'fill-opacity': '.65',
          stroke: 'var(--sw-accent)',
          'stroke-width': 2
        })
      );
      for (const [v, color, name] of [
        [f.e1, 'var(--sw-vector-1)', 'B(t)e₁'],
        [f.e2, 'var(--sw-vector-2)', 'B(t)e₂']
      ]) {
        const p = pt(v);
        sv.append(
          svgEl('line', {x1: 250, y1: 158, x2: p[0], y2: p[1], stroke: color, 'stroke-width': 3}),
          svgEl('circle', {cx: p[0], cy: p[1], r: 4, fill: color})
        );
        const text = svgEl('text', {x: p[0] + 7, y: p[1] - 9, fill: color, 'font-size': 13});
        text.textContent = name;
        sv.append(text);
      }
      scene.replaceChildren(sv);
      metrics.replaceChildren(
        el('span', `t = ${f.t.toFixed(2)}`),
        el('strong', `det B(t) = ${Number(f.determinant.toFixed(4))}`),
        el('strong', `面积 = ${Number(f.area.toFixed(4))}`)
      );
    };
    range.addEventListener('input', () => {
      state.t = Number(range.value);
      draw();
    });
    let timer = null;
    const play = btn(
      '播放变化',
      () => {
        if (timer && this._timers.has(timer)) {
          clearInterval(timer);
          this._timers.delete(timer);
          timer = null;
          play.textContent = '播放变化';
          return;
        }
        if (this.motion) {
          this.showNotice('已开启减少动态：请用滑块或关键帧观察。');
          return;
        }
        if (state.t >= 1) state.t = 0;
        timer = setInterval(() => {
          state.t = Math.min(1, state.t + 0.0125);
          range.value = state.t;
          draw();
          if (state.t >= 1) {
            clearInterval(timer);
            this._timers.delete(timer);
            timer = null;
            play.textContent = '播放变化';
          }
        }, 50);
        this._timers.add(timer);
        play.textContent = '暂停';
      },
      {'data-play': 'true'}
    );
    group.append(
      play,
      ...[0, 0.5, 1].map(t =>
        btn(`关键帧 ${t}`, () => {
          this.stopMotion();
          state.t = t;
          range.value = t;
          draw();
        })
      )
    );
    controls.append(label, group, metrics);
    figure.append(
      scene,
      controls,
      el(
        'figcaption',
        '虚线为原始单位正方形；坐标使用同一尺度。图形、向量与面积由同一个 B(t) 计算。'
      )
    );
    section.append(figure);
    const edit = el('details');
    edit.append(el('summary', '修改目标矩阵 · 创建新版本'));
    const fields = el('div', undefined, {class: 'matrix-fields'});
    const inputs = [];
    matrix.flat().forEach((x, i) => {
      const input = el('input', undefined, {
        type: 'number',
        min: '-4',
        max: '4',
        step: '.1',
        'aria-label': `矩阵第${Math.floor(i / 2) + 1}行第${(i % 2) + 1}列`
      });
      input.value = state.matrixDraft?.[i] ?? x;
      input.addEventListener('input', () => {
        state.matrixDraft = inputs.map(x => x.value);
        this.dirty = true;
      });
      inputs.push(input);
      fields.append(input);
    });
    edit.append(
      fields,
      btn('应用矩阵', () => {
        try {
          if (inputs.some(x => !x.value.trim())) throw new Error('矩阵系数不能为空');
          const v = inputs.map(x => Number(x.value));
          const next = {
            ...b,
            data: {
              matrix: [
                [v[0], v[1]],
                [v[2], v[3]]
              ]
            }
          };
          this._doc = patchBlock(this._doc, b.id, next, this._doc.revision);
          state.matrixDraft = null;
          this.dirty = [...this.local.values()].some(s => s.draft || s.matrixDraft);
          this.stopMotion();
          this.render();
          this.emit('content.revised', {blockId: b.id});
        } catch (e) {
          this.showNotice(e.message);
        }
      })
    );
    section.append(edit);
    draw();
  }
  renderChart(section, b, state) {
    const d = b.data;
    const figure = el('figure', undefined, {class: 'figure'}),
      area = el('div');
    const redraw = () => {
      const rows = state.sort ? [...d.rows].sort((a, b) => b.value - a.value) : d.rows;
      const min = Math.min(0, ...rows.map(r => r.value)),
        max = Math.max(0, ...rows.map(r => r.value));
      const scale = x => 150 + ((x - min) / (max - min || 1)) * 280;
      const sv = svgEl('svg', {
        viewBox: `0 0 500 ${rows.length * 47 + 30}`,
        role: 'img',
        'aria-label': b.title || `数值比较图（${d.unit}）`
      });
      sv.append(
        svgEl('line', {
          x1: scale(0),
          x2: scale(0),
          y1: 10,
          y2: rows.length * 47 + 10,
          stroke: 'var(--sw-axis)'
        })
      );
      rows.forEach((r, i) => {
        const t = svgEl('text', {
          x: 12,
          y: i * 47 + 34,
          fill: 'var(--sw-figure-ink)',
          'font-size': 13
        });
        t.textContent = r.label.length > 13 ? r.label.slice(0, 13) + '…' : r.label;
        const bar = svgEl('rect', {
          x: Math.min(scale(0), scale(r.value)),
          y: i * 47 + 14,
          width: Math.max(0, Math.abs(scale(r.value) - scale(0))),
          height: 26,
          rx: 3,
          fill: r.value < 0 ? 'var(--sw-negative)' : 'var(--sw-positive)',
          'data-value': r.value
        });
        // Full label and value on hover/focus; the visible label is truncated at 13 characters.
        const tip = svgEl('title');
        tip.textContent = `${r.label}：${r.value} ${d.unit}`;
        bar.append(tip);
        const n = svgEl('text', {
          x: Math.min(470, Math.max(scale(0), scale(r.value)) + 6),
          y: i * 47 + 33,
          fill: 'var(--sw-figure-ink)',
          'font-size': 12,
          class: 'sw-value'
        });
        n.textContent = r.value;
        sv.append(t, bar, n);
      });
      area.replaceChildren(sv);
    };
    figure.append(area, el('figcaption', `${d.note ?? '输入数据；未独立核实'} · 单位：${d.unit}`));
    const raw=el('details');raw.open=!!state.rawOpen;raw.append(el('summary','查看全部原始数据'),tableOf(['类别', `数值（${d.unit}）`],d.rows.map(r=>[r.label,r.value])));raw.addEventListener('toggle',()=>{state.rawOpen=raw.open;});
    section.append(
      figure,
      btn('切换按数值排序', () => {
        state.sort = !state.sort;
        redraw();
        this.emit('view.sort', {blockId: b.id});
      }),
      raw
    );
    redraw();
  }

  renderDiagram(section, b, state = {}) {
    const d = b.data,
      layout = layoutDiagram(d);
    const relation = {sequence: '顺序', dependency: '依赖', hypothesis: '假设'};
    if (layout.cyclic || layout.dense)
      section.append(
        el(
          'p',
          layout.cyclic
            ? '包含循环关系：本版使用节点与关系表，不强行画成线性流程。'
            : '同层节点过多：使用关系表保留可读性。',
          {class: 'warning'}
        )
      );
    else {
      const figure = el('figure', undefined, {class: 'figure'}),
        wrap = el('div', undefined, {
          class: 'diagram-viewport',
          tabindex: '0',
          role: 'region',
          'aria-label': '节点关系图；小屏幕可横向滚动，完整关系在下方文字版'
        });
      const sv = svgEl('svg', {
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        role: 'img',
        'aria-label': b.title || '节点关系图'
      });
      const defs = svgEl('defs'),
        marker = svgEl('marker', {
          id: `arrow-${b.id}`,
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 6,
          markerHeight: 6,
          orient: 'auto-start-reverse'
        });
      marker.append(svgEl('path', {d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--sw-edge)'}));
      defs.append(marker);
      sv.append(defs);
      const nodes = new Map(layout.nodes.map(n => [n.id, n]));
      const lanes = new Map();
      for (const edge of d.edges) {
        const key = `${edge.from}\u0000${edge.to}`;
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key).push(edge);
      }
      for (const edge of d.edges) {
        const group = lanes.get(`${edge.from}\u0000${edge.to}`);
        const offset = (group.indexOf(edge) - (group.length - 1) / 2) * Math.min(24, 96 / Math.max(1, group.length - 1));
        const a = nodes.get(edge.from),
          z = nodes.get(edge.to),
          geometry = diagramEdge(a, z, d.direction, offset),
          style = edge.style ?? (edge.relation === 'hypothesis' ? 'dashed' : 'solid');
        sv.append(
          svgEl('path', {
            d: geometry.d,
            fill: 'none',
            stroke: 'var(--sw-edge)',
            'stroke-width': style === 'thick' ? 4 : 2,
            'stroke-dasharray': style === 'dashed' ? '5 5' : 'none',
            'marker-end': `url(#arrow-${b.id})`
          })
        );
        const label = svgEl('text', {
          x: geometry.x,
          y: geometry.y,
          fill: 'var(--sw-muted)',
          'font-size': 11
        });
        // An authored edge label (a decision branch such as 是/否) is shown instead of the relation name.
        label.textContent = edge.label ?? relation[edge.relation];
        sv.append(label);
      }
      for (const n of layout.nodes) {
        const shape = diagramShape(n);
        sv.append(svgEl(shape.tag, shape.attrs));
        const text = svgEl('text', {
          x: n.x,
          y: n.y - 3,
          'text-anchor': 'middle',
          fill: 'var(--sw-figure-ink)',
          'font-size': 13
        });
        const parts = Array.from(n.label);
        for (let i = 0; i < Math.min(parts.length, 22); i += 11) {
          const span = svgEl('tspan', {x: n.x, dy: i === 0 ? 0 : 18});
          span.textContent =
            parts.slice(i, i + 11).join('') + (i === 11 && parts.length > 22 ? '…' : '');
          text.append(span);
        }
        sv.append(text);
      }
      wrap.append(sv);
      figure.append(
        wrap,
        el(
          'figcaption',
          '节点关系来自提供的规格；箭头表达关系，不代表已经执行。完整标签与端点见下方文字版。'
        )
      );
      section.append(figure);
    }
    // When the figure is drawn, the node/edge tables are the text equivalent, not a second reading
    // task: keep them in the DOM (screen readers, print) but collapsed. Without a figure they stay open.
    const drawn = !!section.querySelector('figure');
    const holder = drawn ? el('details', undefined, {class: 'diagram-text'}) : section;
    if (drawn) {
      holder.append(el('summary', '查看节点与关系（文字版）'));
      holder.open = !!state.diagramTextOpen;
      holder.addEventListener('toggle', () => {
        state.diagramTextOpen = holder.open;
      });
    }
    if (d.direction !== undefined) holder.append(el('p', `方向：${d.direction}（${diagramDirectionNames[d.direction]}）`));
    const shaped = d.nodes.some(n => n.shape !== undefined);
    holder.append(
      tableOf(
        shaped ? ['节点', '完整名称', '形状'] : ['节点', '完整名称'],
        d.nodes.map(n => [n.id, n.label, ...(shaped ? [diagramShapeNames[n.shape] ?? '默认圆角矩形'] : [])])
      )
    );
    if (d.edges.length) {
      const labelled = d.edges.some(e => e.label), styled = d.edges.some(e => e.style !== undefined);
      holder.append(
        tableOf(
          ['从', '到', '关系', ...(labelled ? ['标签'] : []), ...(styled ? ['线型'] : [])],
          d.edges.map(e => [e.from, e.to, relation[e.relation], ...(labelled ? [e.label ?? ''] : []), ...(styled ? [diagramStyleNames[e.style ?? (e.relation === 'hypothesis' ? 'dashed' : 'solid')]] : [])])
        )
      );
    }
    if (drawn) section.append(holder);
  }

  /** Sliders plus number fields; outputs and every {{binding}} recompute from one scope. */
  renderCalc(section, b, state) {
    const d = b.data;
    state.calc ??= {};
    const card = el('div', undefined, {class: 'calc'});
    const inputs = el('div', undefined, {class: 'calc-inputs'});
    const outputs = el('dl', undefined, {class: 'calc-outputs', 'aria-live': 'polite'});
    const inputControls = [];
    const drawOutputs = () => {
      const v = calcValues(d, state.calc);
      outputs.replaceChildren();
      const main = d.outputs.find(x => x.primary) ?? d.outputs.at(-1);
      d.outputs.forEach(x => {
        // One headline result is styled larger: the `primary` output, else the last one.
        const row = el('div', undefined, {class: x === main ? 'out main' : 'out'});
        row.append(
          el('dt', x.label),
          el('dd', `${formatNumber(v.get(x.id), x.digits)}${x.unit ? ' ' + x.unit : ''}`, {
            title: `公式：${x.expr}`
          })
        );
        outputs.append(row);
      });
    };
    for (const x of d.inputs) {
      const id = `calc-${b.id}-${x.id}`;
      const value = state.calc[x.id] ?? x.value;
      const row = el('div', undefined, {class: 'calc-row'});
      const range = el('input', undefined, {
        type: 'range',
        min: x.min,
        max: x.max,
        step: x.step,
        'aria-label': x.label
      });
      const number = el('input', undefined, {
        type: 'number',
        id,
        min: x.min,
        max: x.max,
        step: x.step,
        class: 'calc-number'
      });
      range.value = number.value = value;
      inputControls.push({range,number,value:x.value});
      const set = (raw, from) => {
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) return;
        const clamped = Math.min(x.max, Math.max(x.min, n));
        state.calc[x.id] = clamped;
        if (from !== range) range.value = clamped;
        if (from !== number && Number(number.value) !== clamped) number.value = clamped;
        drawOutputs();
        this.refreshBindings();
      };
      range.addEventListener('input', () => set(range.value, range));
      number.addEventListener('input', () => set(number.value, number));
      const commitInput = () => this.emit('calc.input', {blockId: b.id, input: x.id, value: state.calc[x.id] ?? x.value});
      number.addEventListener('change', () => {number.value = state.calc[x.id] ?? x.value; commitInput();});
      range.addEventListener('change', commitInput);
      const label = el('label', undefined, {for: id});
      label.append(
        el('span', x.label),
        el('small', `${x.min}–${x.max}${x.unit ? ' ' + x.unit : ''}`)
      );
      const unit = el('span', x.unit, {class: 'unit'});
      row.append(label, range, number, unit);
      inputs.append(row);
    }
    const reset = btn('恢复默认值', () => {
      state.calc = {};
      // Keep the controls, keyboard focus and the reader's formula disclosure intact.
      for (const {range,number,value} of inputControls) range.value = number.value = value;
      drawOutputs();
      this.refreshBindings();
      this.emit('calc.reset', {blockId: b.id});
    });
    const formulas = el('details', undefined, {class: 'formulas'});
    formulas.append(el('summary', '查看公式 · 结果由本地计算，不来自模型'));
    formulas.append(
      tableOf(
        ['输出', '公式'],
        d.outputs.map(x => [x.label, x.expr])
      )
    );
    card.append(inputs, outputs, el('div', undefined, {class: 'group'}), formulas);
    card.querySelector('.group').append(reset);
    section.append(card);
    drawOutputs();
  }
  renderChecklist(section, b, state) {
    state.checked ??= new Set();
    const list = el('ul', undefined, {class: 'checklist'});
    const progress = el('p', '', {class: 'meta', role: 'status'});
    const draw = () =>
      (progress.textContent = `本页已勾选 ${state.checked.size} / ${b.data.items.length} · 只保存在当前页面，不代表事项已完成`);
    for (const x of b.data.items) {
      const id = `check-${b.id}-${x.id}`;
      const li = el('li');
      const box = el('input', undefined, {type: 'checkbox', id});
      box.checked = state.checked.has(x.id);
      box.addEventListener('change', () => {
        if (box.checked) state.checked.add(x.id);
        else state.checked.delete(x.id);
        draw();
        this.emit('checklist.toggle', {blockId: b.id, itemId: x.id, checked: box.checked});
      });
      const label = el('label', undefined, {for: id});
      label.append(...(this.inline(x.text, {blockId: b.id, type: 'checklist', role: 'item'}) ?? literal(x.text)));
      li.append(box, label);
      list.append(li);
    }
    section.append(list, progress);
    draw();
  }
  renderExercise(section, b, state) {
    const d = b.data;
    const questionSignature = JSON.stringify([d.question, d.answer, d.hints]);
    if (state.questionSignature && state.questionSignature !== questionSignature) {
      state.revealed = false;
      state.hints = 0;
      state.submitted = false;
      if (state.draft)
        section.append(
          el('p', '题目或答案已更新；以下草稿来自旧版本，请重新检查。', {class: 'warning'})
        );
    }
    state.questionSignature = questionSignature;
    section.append(el('p', d.question, {class: 'question'}));
    const id = `draft-${b.id}`;
    section.append(el('label', '你的尝试', {for: id, class: 'meta'}));
    const input = el('textarea', undefined, {
      id,
      class: 'answer-input',
      placeholder: '先写出你的想法；不会自动发送或打分。',
      maxlength: '5000'
    });
    input.value = state.draft;
    input.addEventListener('input', () => {
      state.draft = input.value;
      this.dirty = true;
    });
    const feedback = el('p', '', {class: 'feedback', role: 'status'});
    const help = el('div'),
      answer = el('div', undefined, {class: 'answer'});
    const drawHelp = () => {
      help.replaceChildren();
      (d.hints ?? [])
        .slice(0, state.hints)
        .forEach(x => help.append(el('p', '提示：' + x, {class: 'hint'})));
      answer.hidden = !state.revealed;
      answer.textContent = state.revealed ? d.answer : '';
    };
    const group = el('div', undefined, {class: 'group'});
    group.append(
      btn('提交本地尝试', () => {
        if (!state.draft.trim()) {
          feedback.textContent = '请先写出你的尝试，或直接跳过。';
          return;
        }
        if (state.submitted) {
          feedback.textContent = '本次尝试已经记录；编辑后可继续自我对照，不重复计次。';
          return;
        }
        state.submitted = true;
        this.emit('practice.attempt', {
          blockId: b.id,
          helpExposed: state.hints > 0 || state.revealed,
          answerLength: state.draft.length
        });
        feedback.textContent = '已记录本地尝试。未评分，也未推断掌握度。';
      }),
      btn('给一点提示', () => {
        if (state.hints < (d.hints ?? []).length) {
          state.hints++;
          this.emit('practice.hint', {blockId: b.id, index: state.hints});
          drawHelp();
        } else feedback.textContent = '没有更多提示，可以查看答案或跳过。';
      }),
      btn('揭示答案', () => {
        if (!state.revealed) {
          state.revealed = true;
          this.emit('practice.reveal', {blockId: b.id});
          drawHelp();
        }
      }),
      btn('跳过', () => {
        feedback.textContent = '已跳过；不会记为答错或掌握。';
        this.emit('practice.skip', {blockId: b.id});
      })
    );
    section.append(input, group, feedback, help, answer);
    drawHelp();
  }
}
if (!customElements.get('sense-weave')) customElements.define('sense-weave', SenseWeave);
