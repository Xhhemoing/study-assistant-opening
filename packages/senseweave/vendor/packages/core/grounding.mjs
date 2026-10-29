/**
 * Verbatim grounding gate for every non-authored component (local prose extraction and
 * AI proposals alike). A component may only re-arrange text that already exists: every
 * number and every content string must occur in the quoted source. Structural labels
 * (units, axis names, fixed comparison headers, notes) are the only exceptions.
 */
import {validateDocument, SCHEMA_VERSION} from './document.mjs';

const SEPARATORS = /[\s，,。．.、；;：:！!？?“”"'‘’（）()【】\[\]《》<>]/g;
export const normalizeForGrounding = value => String(value).normalize('NFKC').replace(SEPARATORS, '');
// Keys whose string values describe structure rather than carry content.
const STRUCTURAL_KEYS = new Set(['unit', 'yUnit', 'xLabel', 'yLabel', 'note', 'kind', 'xKind', 'id', 'math']);
// Fixed comparison vocabulary that may label rows/columns without appearing in the source.
export const COMPARE_HEADERS = Object.freeze(['维度', '方面', '项目', '优点', '缺点', '好处', '不足', '长处', '短处', '优势', '劣势', '利', '弊', '特点', 'Aspect', 'Pros', 'Cons']);

/** Numbers that appear in the source, read the same way the components store them. */
export function sourceNumbers(source) {
  const set = new Set();
  for (const m of String(source).normalize('NFKC').matchAll(/(?<![\d.])-?\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) {set.add(n); if (n < 0) set.add(-n);}
  }
  return set;
}

/** Exact contiguous occurrence; tolerant only of leading/trailing whitespace in the quote. */
export function isVerbatimQuote(quote, text) {
  if (typeof quote !== 'string' || typeof text !== 'string') return false;
  const q = quote.trim();
  return q.length >= 2 && text.includes(q);
}

/**
 * Returns the list of values in `block.data` that are not grounded in `source`
 * (empty list = grounded). `extraLabels` are structural strings the host vouches for.
 */
export function groundingViolations(block, source, {extraLabels = []} = {}) {
  const text = String(source ?? '');
  const src = normalizeForGrounding(text), numbers = sourceNumbers(text), bad = [];
  const allowed = new Set([...COMPARE_HEADERS, ...extraLabels].map(normalizeForGrounding));
  const walk = (value, key, path) => {
    if (value === null || value === undefined || typeof value === 'boolean') return;
    if (typeof value === 'number') {if (!numbers.has(value)) bad.push(value); return;}
    if (typeof value === 'string') {
      if (STRUCTURAL_KEYS.has(key)) return;
      const n = normalizeForGrounding(value);
      if (!n) return;
      if (src.includes(n)) return;
      if (path.startsWith('columns') || path.startsWith('header')) {if (allowed.has(n)) return;}
      if (path === 'rows.0' && allowed.has(n)) return;
      bad.push(value);
      return;
    }
    if (Array.isArray(value)) {value.forEach((x, i) => walk(x, key, path ? `${path}.${i}` : String(i))); return;}
    if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k, path ? `${path}.${k}` : k);
  };
  const data = block?.data ?? {};
  if (block?.type === 'compare') {
    // Header row and first column may use the fixed vocabulary; every other cell is content.
    data.columns?.forEach((c, i) => walk(c, 'header', i === 0 ? 'header' : 'columns'));
    data.rows?.forEach(row => row.forEach((cell, i) => walk(cell, 'cell', i === 0 ? 'rows.0' : 'cell')));
    return bad;
  }
  if (block?.type === 'checklist') {data.items?.forEach(x => walk(x.text, 'text', 'items')); return bad;}
  walk(data, '', '');
  return bad;
}

export function isGrounded(block, source, options) {return groundingViolations(block, source, options).length === 0;}

/** Validate one block in isolation. Throws ContractError/EXTENDED on invalid structure. */
export function validateProposalBlock(block) {
  return validateDocument({schemaVersion: SCHEMA_VERSION, id: 'probe', revision: 1, title: '', blocks: [block]}).blocks[0];
}

const str = x => typeof x === 'string' ? x : typeof x?.title === 'string' ? x.title : typeof x?.text === 'string' ? x.text : '';
/**
 * Build a component from a compact proposal shape (what a model or the local extractor emits).
 * Unknown types throw. The result is validated but NOT yet grounded; callers must run
 * groundingViolations against the quoted source.
 */
export function buildProposalBlock(type, p, id) {
  if (!p || typeof p !== 'object') throw Object.assign(new Error('proposal data must be an object'), {code: 'PROPOSAL'});
  let data;
  if (type === 'steps') data = {items: (p.items ?? []).map(str)};
  else if (type === 'checklist') data = {items: (p.items ?? []).map((x, i) => ({id: `c${i + 1}`, text: str(x)}))};
  else if (type === 'chart') data = {unit: p.unit, rows: (p.rows ?? []).map(r => ({label: String(r?.label ?? ''), value: r?.value})), note: '由原文逐项映射，未生成新数据。'};
  else if (type === 'plot') data = {kind: 'line', xKind: 'ordinal', xLabel: p.xLabel ?? '项', yLabel: p.yLabel ?? '值', yUnit: p.unit,
    points: (p.rows ?? p.points ?? []).map(r => ({x: String(r?.label ?? r?.x ?? ''), y: r?.value ?? r?.y})), note: '由原文逐项映射；线段只连接已提供的数据点，不代表插值、预测或因果。'};
  else if (type === 'timeline') data = {items: (p.items ?? []).map(x => ({when: String(x?.when ?? ''), title: String(x?.title ?? '')}))};
  else if (type === 'compare') data = {columns: p.columns, rows: p.rows};
  else if (type === 'derivation') data = {lines: (p.lines ?? p.items ?? []).map(x => ({text: str(x) || String(x ?? '')}))};
  else throw Object.assign(new Error(`no proposal builder for ${type}`), {code: 'PROPOSAL'});
  return validateProposalBlock({id, type, data});
}
