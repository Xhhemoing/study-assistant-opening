/**
 * Deterministic extraction of implicit structure from prose (zero model calls).
 * Every item, label, date and number is a verbatim slice of the answer, and every candidate
 * passes the core grounding gate before it is offered. Conservative on purpose: narrative,
 * reasoning, approximate numbers, mixed units, part–whole mixes and one/two-item content stay text.
 */
import {buildProposalBlock, groundingViolations} from '../core/grounding.mjs';

const UNIT = '(?:平方米|平方千米|立方米|千克|公斤|毫升|千米|公里|分钟|小时|万元|亿元|分贝|毫安|千瓦|μmol|mol|cm|mm|km|kg|ml|mL|秒|分|天|次|个|人|元|米|克|岁|题|页|本|篇|件|台|辆|吨|升|册|所|名|%|％|Ω|℃|°C)';
const SERIES = new RegExp(`^(.{1,24}?)(?:只用了|用了|花了|需要|耗时|是|为|降到|降至|跌到|升到|升至|回升到|涨到|达到|增至|减至|增加到|减少到|有|占|得了|考了|拿了)?\\s*(-?\\d+(?:\\.\\d+)?)\\s*(${UNIT})$`);
const APPROX = /约|大约|大概|左右|接近|将近|近|超过|不到|多达|上下|估计|可能|一半/;
const COMPARATIVE = /比|多出|少了|相差|差了|倍/;
const TOTAL = /总|合计|一共|共计|总共|全部|整体/;
const LEAD = /^(?:其中|分别是|分别|而且|而|和|与|及|以及|还有|另外|此外|则|在|对于|至于|所以|因此)+/;
const TEMPORAL_LABEL = /^(?:\d{4}\s*年|(?:周|星期)[一二三四五六日天]|第\s*[一二三四五六七八九十\d]{1,3}\s*(?:次|周|天|日|月|年|季度|学期|单元|轮|阶段|课时)|\d{1,2}\s*月|[上下]半年|[上下]学期|期中|期末|月考|一模|二模|三模|(?:day|week)\s*\d{1,3}|Q[1-4])/i;
const MARK = '(首先|第一步|第[一二三四五六七八九十]步|第[一二三四五六七八九十][，,、]|先|其次|然后|接着|随后|再|之后|接下来|最后|最终)';
const MARK_START = new RegExp(`^(?:(?:你|我们|大家)?(?:可以|应该|应当|需要|要|建议|就|可))?${MARK}`);
const FIRST = /^(?:首先|第一步|第一|先)$/;
const EXPLICIT = /^第[一二三四五六七八九十]步$/;
const NARRATIVE = /先是|后来|终于|只好|可是|竟然|于是|不料|突然|结果他|结果她|(?:他|她|他们|她们|小明|小红|小王|小李|老王|爷爷|奶奶|妈妈|爸爸)(?:先|首先|最后|然后)/;
const CHECKLIST_HEAD = /(?:需要|准备|要带|带上|带好|携带|检查|清单|包括|如下|以下几[点项样件]|注意以下)[^。：:\n]{0,10}[：:]\s*$/;
const COMPARE_INTENT = /优缺点|优劣|利弊|好处.{0,6}(?:不足|坏处|缺点|弊端)|(?:优点|长处).{0,6}(?:缺点|短处)|各有什么|各自有什么|有什么不同|有何不同|区别|对比|比较/;

/** Replace quoted spans with same-length filler so markers inside quotes are not structure. */
function maskQuotes(text) {
  return text.replace(/“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|‘[^’\n]*’|`[^`\n]*`/g, m => '□'.repeat(m.length));
}
/** Prose paragraphs (never fences, tables, lists, headings, quotes or display math) with offsets. */
function paragraphs(text) {
  const out = [];
  let fence = null, math = false, start = -1, at = 0;
  const lines = text.split('\n');
  const flush = end => {if (start >= 0) {const body = text.slice(start, end).replace(/\s+$/, ''); if (body.trim()) out.push({start, end: start + body.length, text: body});} start = -1;};
  for (const line of lines) {
    const lineEnd = at + line.length, t = line.trim();
    const fenceMatch = t.match(/^(`{3,}|~{3,})/);
    if (fence) {if (fenceMatch && t.startsWith(fence)) fence = null; at = lineEnd + 1; continue;}
    if (math) {if (t === '$$' || t === '\\]') math = false; at = lineEnd + 1; continue;}
    if (fenceMatch) {flush(at); fence = fenceMatch[1]; at = lineEnd + 1; continue;}
    if (t === '$$' || t === '\\[') {flush(at); math = true; at = lineEnd + 1; continue;}
    if (!t || /^(?:\||#{1,6}\s|>|[-+*]\s|\d{1,3}[.)、]\s?|[-*_]{3,}$|<)/.test(t)) {flush(at); at = lineEnd + 1; continue;}
    if (start < 0) start = at;
    at = lineEnd + 1;
  }
  flush(text.length);
  return out;
}
/** Clauses split at the given punctuation, with absolute offsets and trimmed edges. */
function clauses(masked, base, punct) {
  const out = [];
  let s = 0;
  const push = e => {
    let a = s, b = e;
    while (a < b && /\s/.test(masked[a])) a++;
    while (b > a && /[\s。．！!？?；;，,、：:]/.test(masked[b - 1])) b--;
    if (b > a) out.push({start: base + a, end: base + b, text: masked.slice(a, b)});
  };
  for (let i = 0; i < masked.length; i++) if (punct.includes(masked[i])) {push(i); s = i + 1;}
  push(masked.length);
  return out;
}
const lossless = (text, start, end, spans) => {
  let at = start;
  for (const [a, b] of spans) {if (!/^[\s，,。．；;、：:！!？?]*$/.test(text.slice(at, a))) return false; at = b;}
  return /^[\s，,。．；;、：:！!？?]*$/.test(text.slice(at, end));
};
function candidate(text, kind, type, payload, start, end, placement, extra = {}) {
  const id = `auto_${start}_${type}`;
  let block;
  try {block = buildProposalBlock(type, payload, id);} catch {return null;}
  const source = text.slice(start, end);
  // Hard gate: nothing reaches policy unless it is grounded in the exact span it replaces/annotates.
  if (groundingViolations(block, source).length) return null;
  return {id, block, format: 'prose', implicit: kind, placement, start, end, source,
    sourceRef: {kind: 'text', start, end}, fidelity: {level: 'exact', losses: []}, ...extra};
}

function sequence(text, p, masked, context) {
  if (NARRATIVE.test(masked) || /故事|叙事|情节|小说/.test(context.instruction)) return null;
  const sentenceParts = clauses(masked, p.start, '。．！!？?；;\n');
  const units = sentenceParts.flatMap(s => {
    const local = masked.slice(s.start - p.start, s.end - p.start);
    return clauses(local, s.start, '，,').map(c => ({...c, sentence: s}));
  });
  const marked = units.map(u => ({...u, mark: u.text.match(MARK_START)?.[1]?.replace(/[，,、]$/, '') ?? null}));
  const first = marked.findIndex(u => u.mark && FIRST.test(u.mark));
  if (first < 0) return null;
  const items = [];
  for (let i = first; i < marked.length; i++) {
    const u = marked[i];
    if (u.mark && (i === first || !FIRST.test(u.mark) || items.length === 0)) items.push({start: u.start, end: u.end, sentence: u.sentence, marks: [u.mark]});
    else if (u.mark && FIRST.test(u.mark)) break; // a second "first" starts another sequence
    else if (items.length) {
      const cur = items.at(-1);
      // Continuation clauses stay inside the current item only within its sentence or before the next mark.
      const nextMarked = marked.slice(i + 1).some(x => x.mark);
      if (u.sentence === cur.sentence || nextMarked) cur.end = u.end; else break;
    }
  }
  const explicit = items.every(x => EXPLICIT.test(x.marks[0]));
  if (items.length < 3 && !(items.length === 2 && explicit)) return null;
  if (items.length > 16 || !/最后|最终|然后|接着|再|其次|随后|之后|接下来|第[二三四五六七八九十]/.test(items.slice(1).map(x => x.marks[0]).join(''))) return null;
  const values = items.map(x => text.slice(x.start, x.end));
  if (values.some(v => v.length < 3 || v.length > 400)) return null;
  const start = items[0].start, end = items.at(-1).end;
  if (!lossless(text, start, end, items.map(x => [x.start, x.end]))) return null;
  return candidate(text, 'sequence', 'steps', {items: values}, start, end, 'replace');
}

function enumeration(text, p, masked) {
  const out = [];
  for (const m of masked.matchAll(/[：:]/g)) {
    const head = masked.slice(0, m.index + 1);
    if (!CHECKLIST_HEAD.test(head.slice(Math.max(0, head.lastIndexOf('。') + 1)))) continue;
    const from = m.index + 1, stop = masked.slice(from).search(/[。\n]/);
    const to = stop < 0 ? masked.length : from + stop;
    const body = masked.slice(from, to);
    const punct = /[，,；;]/.test(body) ? '，,；;' : '、';
    const parts = clauses(body, p.start + from, punct);
    if (parts.length < 3 || parts.length > 20 || parts.some(x => x.end - x.start < 2 || x.end - x.start > 120)) continue;
    const items = parts.map(x => text.slice(x.start, x.end));
    const c = candidate(text, 'enumeration', 'checklist', {items}, parts[0].start, parts.at(-1).end, 'replace');
    if (c) out.push(c);
  }
  return out;
}

function series(text, p, masked, context) {
  const parts = clauses(masked, p.start, '，,；;。．、\n');
  const rows = [];
  for (const c of parts) {
    const m = c.text.match(SERIES);
    if (!m) continue;
    const rawLabel = m[1];
    // A number closing a range ("第1—3天", "3~5 次") or an ordinal ("第3天") is not a measured value.
    if (/(?:\d\s*(?:[—–\-~～]|至|到)|第)\s*$/.test(rawLabel)) continue;
    const lead = rawLabel.match(LEAD)?.[0]?.length ?? 0;
    const label = rawLabel.slice(lead).trim();
    if (!label || label.length > 16 || /^[\d.\s-]+$/.test(label) || /[□]/.test(label)) continue;
    rows.push({clause: c, label, labelStart: c.start + lead, value: Number(m[2]), unit: m[3].replace('％', '%'),
      approx: APPROX.test(c.text), comparative: COMPARATIVE.test(label), total: TOTAL.test(label)});
  }
  const groups = new Map();
  for (const r of rows) (groups.get(r.unit) ?? groups.set(r.unit, []).get(r.unit)).push(r);
  const out = [];
  for (const [unit, all] of groups) {
    if (all.some(r => r.approx || r.comparative)) continue;
    const xs = all.filter(r => !r.total);
    if (xs.length < 3 || xs.length > 20 || new Set(xs.map(r => r.label)).size !== xs.length) continue;
    // Part–whole mix (one value equals the sum of the rest) is ambiguous; keep text.
    const sum = xs.reduce((s, r) => s + r.value, 0);
    if (xs.some(r => Math.abs(r.value * 2 - sum) < 1e-9)) continue;
    // Reasoning with derived values ("所以乙有 3 个") is not a dataset.
    const span = masked.slice(xs[0].clause.start - p.start, xs.at(-1).clause.end - p.start);
    if (/所以|因此|那么|可得|算出|求得|等于/.test(span)) continue;
    const temporal = xs.every(r => TEMPORAL_LABEL.test(r.label));
    const type = temporal && !context.tasks.includes('compare') ? 'plot' : 'chart';
    const payload = {unit, xLabel: temporal ? '时间/次序' : '项目', yLabel: '数值', rows: xs.map(r => ({label: r.label, value: r.value}))};
    const sentenceEnd = idx => {const rest = text.slice(idx, p.end).search(/[。．！!？?；;\n]/); return rest < 0 ? p.end : idx + rest + 1;};
    const start = xs[0].clause.start, end = Math.min(p.end, sentenceEnd(xs.at(-1).clause.end));
    const c = candidate(text, 'series', type, payload, start, end, 'after', {temporal});
    if (c) out.push(c);
  }
  return out;
}

const DATE = /^(?:在|于|到了|直到|截至|到)?\s*((\d{3,4})\s*年(?:\s*(\d{1,2})\s*月)?(?:\s*(\d{1,2})\s*日)?|(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?)/;
function events(text, p, masked) {
  const parts = clauses(masked, p.start, '，,；;。．\n');
  const items = [];
  let year = null;
  for (const c of parts) {
    const m = c.text.match(DATE);
    if (m && (m[2] || year !== null)) {
      if (m[2]) year = Number(m[2]);
      const month = Number(m[3] ?? m[5] ?? 0), day = Number(m[4] ?? m[6] ?? 0);
      if (month > 12 || day > 31) return null;
      const whenStart = c.start + m.index + m[0].indexOf(m[1]), whenEnd = whenStart + m[1].length;
      if (whenEnd >= c.end) continue;
      items.push({start: c.start, whenStart, whenEnd, titleStart: whenEnd, end: c.end, rank: year * 10000 + month * 100 + day});
    } else if (items.length && c.start - items.at(-1).end <= 2) items.at(-1).end = c.end;
  }
  if (items.length < 3 || items.length > 16) return null;
  if (items.some((x, i) => i && x.rank < items[i - 1].rank) || items.some(x => x.rank < 1000000)) return null;
  const values = items.map(x => ({when: text.slice(x.whenStart, x.whenEnd).trim(), title: text.slice(x.titleStart, x.end).replace(/^[\s，,]+/, '').trim()}));
  if (values.some(v => v.title.length < 2 || v.title.length > 200 || v.when.length > 60)) return null;
  const start = items[0].start, end = items.at(-1).end;
  const replace = lossless(text, start, end, items.map(x => [x.start, x.end])) && items.every(x => x.start === x.whenStart || /^[\s在于到了直截至]*$/.test(text.slice(x.start, x.whenStart)));
  return candidate(text, 'events', 'timeline', {items: values}, start, end, replace && items.every(x => x.start === x.whenStart) ? 'replace' : 'after');
}

function subjectsFromPrompt(prompt) {
  const m = prompt.match(/([\p{L}\p{N}]{1,10}?)(?:和|与|跟|还是|vs\.?|VS|对比)([\p{L}\p{N}]{1,10}?)(?:各有|各自|有什么|有哪些|的(?:优缺点|区别|好处|不同|利弊)|相比|哪个|比较|之间|分别)/u);
  if (!m) return null;
  const clean = s => s.replace(/^(?:住在|选择|选|用|学|在|去|买|做|读|请问|比较|对比)+/, '');
  const a = clean(m[1]), b = clean(m[2]);
  return a && b && a !== b ? [a, b] : null;
}
function comparison(text, p, masked, context) {
  if (!COMPARE_INTENT.test(context.instruction) && !(/优点|好处|优势/.test(masked) && /缺点|不足|坏处|劣势/.test(masked))) return null;
  const segments = clauses(masked, p.start, '。．；;\n');
  const marked = [];
  for (const s of segments) {
    const m = s.text.match(/^(?:而|对于|至于|相比之下[，,]?)?(.{1,12}?)的(优点|好处|优势|长处)(?:是|在于|有|：|:)\s*(.+?)[，,]\s*(?:而)?(缺点|不足|坏处|劣势|短处)(?:是|在于|有|：|:)\s*(.+)$/);
    if (m) marked.push({s, subject: m[1], pros: m[3], cons: m[5], prosHead: m[2], consHead: m[4]});
  }
  const locate = (seg, piece) => {const at = seg.text.indexOf(piece); return text.slice(seg.start + at, seg.start + at + piece.length);};
  let pair = null;
  if (marked.length === 2 && marked[0].subject !== marked[1].subject)
    pair = marked.map(x => ({subject: locate(x.s, x.subject), pros: locate(x.s, x.pros), cons: locate(x.s, x.cons), s: x.s, heads: [x.prosHead, x.consHead]}));
  else {
    const subjects = subjectsFromPrompt(context.instruction);
    if (!subjects) return null;
    const found = subjects.map(name => segments.find(s => s.text.replace(/^(?:而|对于|至于|相比之下[，,]?|住在|在)/, '').startsWith(name)));
    if (found.some(x => !x) || found[0] === found[1]) return null;
    pair = found.map((s, i) => {
      const cut = s.text.match(/[，,]\s*(?:但是?|不过|然而|可是|却|只是)/);
      if (!cut) return null;
      const pros = s.text.slice(0, cut.index), cons = s.text.slice(cut.index + cut[0].length);
      if (pros.length < 4 || cons.length < 2) return null;
      return {subject: subjects[i], pros: locate(s, pros), cons: locate(s, cons), s};
    });
    if (pair.some(x => !x)) return null;
  }
  const heads = /好处/.test(context.instruction) ? ['好处', /不足/.test(context.instruction) ? '不足' : '坏处'] : ['优点', '缺点'];
  const payload = {columns: ['方面', pair[0].subject, pair[1].subject], rows: [[heads[0], pair[0].pros, pair[1].pros], [heads[1], pair[0].cons, pair[1].cons]]};
  const start = Math.min(pair[0].s.start, pair[1].s.start), end = Math.max(pair[0].s.end, pair[1].s.end);
  const finish = Math.min(p.end, end + (/[。．；;]/.test(text[end] ?? '') ? 1 : 0));
  return candidate(text, 'comparison', 'compare', payload, start, finish, 'after');
}

const EQUATION = /[=＝]/;
function derivations(text, p, masked) {
  const parts = clauses(masked, p.start, '。．；;\n');
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) {
      const lines = run.map(x => text.slice(x.start, x.end));
      const c = candidate(text, 'derivation', 'derivation', {lines}, run[0].start, run.at(-1).end, lossless(text, run[0].start, run.at(-1).end, run.map(x => [x.start, x.end])) ? 'replace' : 'after');
      if (c) out.push(c);
    }
    run = [];
  };
  for (const c of parts) {if (EQUATION.test(c.text) && c.text.length <= 400) run.push(c); else flush();}
  flush();
  return out;
}

/**
 * @param {string} text answer text
 * @param {{instruction?:string,tasks?:string[],derive?:boolean}} context instruction is the host's
 *   current user prompt (already stripped of quotes/examples); derive enables board derivations.
 */
export function discoverProseStructures(text, context = {}) {
  const ctx = {instruction: context.instruction ?? '', tasks: context.tasks ?? [], derive: context.derive === true};
  const out = [];
  for (const p of paragraphs(text)) {
    const masked = maskQuotes(p.text);
    const found = [
      ...(ctx.derive ? derivations(text, p, masked) : []),
      sequence(text, p, masked, ctx),
      ...enumeration(text, p, masked),
      ...series(text, p, masked, ctx),
      events(text, p, masked),
      comparison(text, p, masked, ctx)
    ].filter(Boolean);
    out.push(...found);
  }
  return out;
}
