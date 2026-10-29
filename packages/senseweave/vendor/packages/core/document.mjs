/** JSON-only semantic documents. Rendering never grants authority to model output. */
import {compileExpr, evaluateExpr} from './expr.mjs';
import {EXTENDED_CATALOG, normalizeExtended, extendedText} from './extended.mjs';
export const SCHEMA_VERSION = '0.2';
export const CATALOG = Object.freeze({
  ...EXTENDED_CATALOG,
  prose: '连续正文',
  callout: '显式条件与提醒',
  steps: '有序过程（不代表执行）',
  compare: '定性比较表',
  code: '不可执行代码',
  math: '受限 MathML 表达式',
  chart: '有单位的数值比较',
  diagram: '受控节点关系图（不是执行日志）',
  matrix: '确定性二维线性映射',
  evidence: '主张与来源关系',
  exercise: '先回忆后揭示（不推断掌握度）',
  calc: '确定性公式计算（可调输入 → 输出）',
  timeline: '按时间排列的阶段或事件（不代表已发生）',
  checklist: '可勾选清单（仅本页状态，不代表已完成）'
});
// Names that bindings such as {{block.name}} can address must be plain identifiers.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function requireContract(ok, code, message) {
  if (!ok) throw new ContractError(code, message);
}
export function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export function cleanText(v, max = 12000) {
  requireContract(typeof v === 'string' && v.length <= max, 'TEXT', '文本类型或长度不合法');
  return v;
}
function finiteNumber(v) {
  requireContract(
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e9,
    'NUMBER',
    '数字必须有限且不超过范围'
  );
  return v;
}
function array(v, max = 50, min = 0) {
  requireContract(
    Array.isArray(v) && v.length >= min && v.length <= max,
    'ARRAY',
    '数组数量不合法'
  );
  return v;
}
export function validId(v) {
  requireContract(
    typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(v),
    'ID',
    'ID 不合法'
  );
  return v;
}
function record(v, code = 'DATA', message = '条目必须为对象') {
  requireContract(isRecord(v), code, message);
  return v;
}
function uniqueIds(items) {
  const seen = new Set();
  for (const x of items) {
    record(x, 'ID', '带 ID 的条目必须为对象');
    validId(x.id);
    requireContract(!seen.has(x.id), 'DUPLICATE', 'ID 重复');
    seen.add(x.id);
  }
}
function jsonShape(v, depth = 0, count = {n: 0, size: 0}) {
  requireContract(depth <= 16 && ++count.n <= 12000, 'BUDGET', '数据层级或节点超出预算');
  if (v === null) {
    count.size += 4;
    return;
  }
  if (typeof v === 'boolean') {
    count.size += v ? 4 : 5;
    return;
  }
  if (typeof v === 'string') {
    cleanText(v, 64000);
    count.size += JSON.stringify(v).length;
    return;
  }
  if (typeof v === 'number') {
    finiteNumber(v);
    count.size += String(v).length;
    return;
  }
  requireContract(Array.isArray(v) || isRecord(v), 'JSON', '只接受 JSON 数据');
  if (Array.isArray(v)) {
    count.size += 2 + Math.max(0, v.length - 1);
    for (const x of v) jsonShape(x, depth + 1, count);
    return;
  }
  requireContract(
    Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null,
    'JSON',
    '对象原型不合法'
  );
  const keys = Object.keys(v);
  count.size += 2 + Math.max(0, keys.length - 1);
  for (const k of keys) {
    requireContract(
      !['__proto__', 'constructor', 'prototype'].includes(k),
      'KEY',
      '保留属性不可使用'
    );
    count.size += JSON.stringify(k).length + 1;
    jsonShape(v[k], depth + 1, count);
  }
}
/** Only outbound human-click links; never a fetch capability. */
export function safeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
export function validateMatrix(m) {
  array(m, 2, 2);
  for (const row of m) {
    array(row, 2, 2);
    for (const x of row) {
      finiteNumber(x);
      requireContract(Math.abs(x) <= 4, 'MATRIX', '矩阵系数范围为 −4 至 4');
    }
  }
  return m;
}
export function matrixFrame(m, t = 1) {
  validateMatrix(m);
  requireContract(Number.isFinite(t) && t >= 0 && t <= 1, 'PARAMETER', '参数范围为 0 至 1');
  const b = m.map((r, i) => r.map((x, j) => (i === j ? 1 - t : 0) + t * x));
  const determinant = b[0][0] * b[1][1] - b[0][1] * b[1][0];
  return {
    matrix: b,
    determinant,
    area: Math.abs(determinant),
    e1: [b[0][0], b[1][0]],
    e2: [b[0][1], b[1][1]],
    t
  };
}
/** Validates and returns a rebuilt tree, so unknown keys never survive normalization. */
export function validateMath(tree, depth = 0, count = {n: 0}) {
  requireContract(depth <= 8 && ++count.n <= 120, 'MATH', '数学表达式超出预算');
  requireContract(isRecord(tree), 'MATH', '数学节点必须是对象');
  const arity = {row: [1, 24], frac: [2, 2], sup: [2, 2], sub: [2, 2], sqrt: [1, 1]};
  if (['text', 'number', 'symbol'].includes(tree.op))
    return {op: tree.op, value: cleanText(tree.value, 80)};
  requireContract(Object.hasOwn(arity, tree.op), 'MATH', '不支持的数学运算');
  const [min, max] = arity[tree.op];
  array(tree.args, max, min);
  return {op: tree.op, args: tree.args.map(x => validateMath(x, depth + 1, count))};
}
/** Linear text form of a math tree for plain view, export and accessible names. */
export function mathText(tree) {
  if (tree.value !== undefined) return tree.value;
  const parts = tree.args.map(mathText);
  // Parenthesize operands that are compound or multi-character words; plain numbers stay bare.
  const atomic = (node, text) =>
    node.op === 'number' ? !/\s/.test(text) : Array.from(text).length === 1;
  const group = i => (atomic(tree.args[i], parts[i]) ? parts[i] : `(${parts[i]})`);
  if (tree.op === 'row') return parts.join(' ');
  if (tree.op === 'frac') return `${group(0)}/${group(1)}`;
  if (tree.op === 'sup') return `${group(0)}^${group(1)}`;
  if (tree.op === 'sub') return `${group(0)}_${group(1)}`;
  return `√${group(0)}`;
}

export function validateGraph(data) {
  requireContract(isRecord(data), 'GRAPH', '图关系必须是对象');
  const nodes = array(data.nodes, 12, 1);
  uniqueIds(nodes);
  nodes.forEach(n => {
    cleanText(n.label, 80);
    if (n.shape !== undefined) requireContract(['rect', 'round', 'diamond', 'stadium'].includes(n.shape), 'GRAPH', '节点形状不合法');
  });
  if (data.direction !== undefined) requireContract(['TD', 'TB', 'LR', 'RL', 'BT'].includes(data.direction), 'GRAPH', '图方向不合法');
  const ids = new Set(nodes.map(n => n.id)),
    seen = new Set();
  array(data.edges, 20).forEach(e => {
    record(e, 'GRAPH', '关系必须为对象');
    validId(e.from);
    validId(e.to);
    requireContract(ids.has(e.from) && ids.has(e.to), 'GRAPH', '关系端点不存在');
    requireContract(
      ['sequence', 'dependency', 'hypothesis'].includes(e.relation),
      'GRAPH',
      '关系类型不合法'
    );
    // Optional edge label (e.g. a decision branch "是/否"); two branches between one pair stay distinct.
    if (e.label !== undefined) requireContract(cleanText(e.label, 80).trim() !== '', 'GRAPH', '关系标签不能为空');
    if (e.style !== undefined) requireContract(['solid', 'dashed', 'thick'].includes(e.style), 'GRAPH', '关系线型不合法');
    const key = [e.from, e.to, e.relation, e.label ?? '', e.style ?? (e.relation === 'hypothesis' ? 'dashed' : 'solid')].join('|');
    requireContract(!seen.has(key), 'DUPLICATE', '关系重复');
    seen.add(key);
  });
  return {
    ...(data.direction === undefined ? {} : {direction: data.direction}),
    nodes: nodes.map(n => ({id: n.id, label: n.label, ...(n.shape === undefined ? {} : {shape: n.shape})})),
    edges: data.edges.map(e => ({from: e.from, to: e.to, relation: e.relation, ...(e.style === undefined ? {} : {style: e.style}), ...(e.label === undefined ? {} : {label: e.label})}))
  };
}
/** Deterministic DAG layering. Cycles/dense layers retain tables instead of pretending to be a readable flow. */
export function layoutDiagram(data) {
  validateGraph(data);
  const degree = new Map(data.nodes.map(n => [n.id, 0])),
    level = new Map(data.nodes.map(n => [n.id, 0]));
  for (const e of data.edges) degree.set(e.to, degree.get(e.to) + 1);
  const queue = data.nodes.filter(n => degree.get(n.id) === 0).map(n => n.id);
  let processed = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    processed++;
    for (const edge of data.edges.filter(e => e.from === id)) {
      level.set(edge.to, Math.max(level.get(edge.to), level.get(id) + 1));
      degree.set(edge.to, degree.get(edge.to) - 1);
      if (degree.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  const cyclic = processed !== data.nodes.length;
  const layers = new Map();
  for (const node of data.nodes) {
    const l = level.get(node.id);
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l).push(node);
  }
  const dense = [...layers.values()].some(nodes => nodes.length > 3);
  const horizontal = ['LR', 'RL'].includes(data.direction),
    reverse = ['RL', 'BT'].includes(data.direction),
    count = Math.max(...level.values()) + 1,
    width = horizontal ? count * 224 + 36 : 560,
    height = horizontal ? 360 : count * 112 + 36;
  const nodes = data.nodes.map(n => {
    const siblings = layers.get(level.get(n.id));
    const layer = reverse ? count - 1 - level.get(n.id) : level.get(n.id);
    return {
      ...n,
      x: horizontal ? layer * 224 + 112 : ((siblings.indexOf(n) + 1) * width) / (siblings.length + 1),
      y: horizontal ? ((siblings.indexOf(n) + 1) * height) / (siblings.length + 1) : layer * 112 + 42
    };
  });
  return {nodes, width, height, cyclic, dense};
}

function validateBlock(block, sourceIds, warnings) {
  requireContract(isRecord(block), 'BLOCK', '内容块必须为对象');
  validId(block.id);
  cleanText(block.type, 60);
  const b = {
    id: block.id,
    type: block.type,
    title: cleanText(block.title ?? '', 200),
    body: cleanText(block.body ?? ''),
    refs: [],
    qualifiers: []
  };
  b.refs = array(block.refs ?? [], 20).map(x => {
    validId(x);
    if (!sourceIds.has(x)) warnings.push(`来源 ${x} 不在已提供的材料中，不能视为有效引用。`);
    return x;
  });
  b.qualifiers = array(block.qualifiers ?? [], 8).map(x => cleanText(x, 1000));
  // Verbatim answer span this component stands in for (placement 'replace'). Shown behind
  // "查看原文" and used by every text projection instead of the component's own rendering.
  if (block.original !== undefined && b.type !== 'prose') {
    const original = cleanText(block.original, 60000);
    if (original.trim()) b.original = original;
  }
  // Opt-in Markdown subset for the body text of prose/callout; anything else stays literal text.
  if (block.format !== undefined) {
    requireContract(
      ['text', 'markdown'].includes(block.format),
      'FORMAT',
      '正文格式只能是 text 或 markdown'
    );
    if (block.format === 'markdown' && ['prose', 'callout'].includes(b.type)) b.format = 'markdown';
  }
  if (!Object.hasOwn(CATALOG, b.type)) {
    warnings.push(`未知组件 ${b.type} 已保留文字回退。`);
    b.type = 'prose';
    delete b.original;
    b.body = block.fallback ?? b.body;
    b.data = {};
    cleanText(b.body);
    return b;
  }
  const d = block.data ?? {};
  requireContract(isRecord(d), 'DATA', '组件 data 必须为对象');
  b.data = normalizeData(b.type, d);
  return b;
}
/** Rebuild data from the catalog's known fields only; extra keys such as html/actions are dropped. */
function normalizeData(type, d) {
  if (Object.hasOwn(EXTENDED_CATALOG, type)) return normalizeExtended(type, d);
  switch (type) {
    case 'steps':
      return {items: array(d.items, 16, 1).map(x => cleanText(x, 2000))};
    case 'compare': {
      const columns = array(d.columns, 6, 2).map(x => cleanText(x, 100));
      const rows = array(d.rows, 30, 1).map(r =>
        array(r, columns.length, columns.length).map(x => cleanText(x, 1000))
      );
      return {columns, rows};
    }
    case 'code':
      return {language: cleanText(d.language ?? 'text', 30), code: cleanText(d.code, 16000)};
    case 'math':
      return {expression: validateMath(d.expression)};
    case 'chart': {
      const unit = cleanText(d.unit, 50);
      requireContract(!!unit.trim(), 'UNIT', '图表必须显式声明单位或“未声明”');
      const labels = new Set();
      const rows = array(d.rows, 20, 1).map(r => {
        record(r, 'CHART', '数据行必须为对象');
        cleanText(r.label, 80);
        requireContract(!labels.has(r.label), 'DUPLICATE', '数据标签重复');
        labels.add(r.label);
        return {label: r.label, value: finiteNumber(r.value)};
      });
      // Bounds must come from supplied data, not a visual guess.
      return d.note === undefined ? {unit, rows} : {unit, rows, note: cleanText(d.note, 1000)};
    }
    case 'matrix':
      return {matrix: validateMatrix(d.matrix).map(row => [...row])};
    case 'diagram':
      return validateGraph(d);
    case 'exercise':
      return {
        question: cleanText(d.question, 3000),
        answer: cleanText(d.answer, 5000),
        hints: array(d.hints ?? [], 4).map(x => cleanText(x, 1000))
      };
    case 'calc':
      return validateCalc(d);
    case 'timeline':
      return {
        items: array(d.items, 16, 1).map(x => {
          record(x, 'TIMELINE', '时间线条目必须为对象');
          const item = {when: cleanText(x.when, 60), title: cleanText(x.title, 200)};
          if (x.detail !== undefined) item.detail = cleanText(x.detail, 2000);
          return item;
        })
      };
    case 'checklist': {
      const items = array(d.items, 20, 1);
      uniqueIds(items);
      return {items: items.map(x => ({id: x.id, text: cleanText(x.text, 1000)}))};
    }
    case 'evidence':
      return {
        claims: array(d.claims, 16, 1).map(c => {
          record(c, 'EVIDENCE', '主张必须为对象');
          requireContract(
            ['supported', 'inferred', 'contested', 'missing'].includes(c.relation),
            'EVIDENCE',
            '来源关系不合法'
          );
          return {
            text: cleanText(c.text, 2000),
            relation: c.relation,
            sourceIds: array(c.sourceIds ?? [], 10).map(validId)
          };
        })
      };
    default:
      return {};
  }
}
/**
 * calc: inputs are bounded numbers; outputs are safe expressions over input IDs and earlier
 * outputs. The model supplies formulas, never results: values are always computed here.
 */
export function validateCalc(d) {
  const inputs = array(d.inputs, 8, 1),
    outputs = array(d.outputs, 8, 1);
  uniqueIds([...inputs, ...outputs]);
  const known = new Set();
  const ident = id => requireContract(IDENT.test(id), 'CALC', `变量 ${id} 必须是字母开头的标识符`);
  return {
    inputs: inputs.map(x => {
      ident(x.id);
      const [value, min, max] = [x.value, x.min, x.max].map(finiteNumber);
      requireContract(
        min < max && value >= min && value <= max,
        'CALC',
        `${x.id} 的取值范围不合法`
      );
      const step = x.step === undefined ? (max - min) / 100 : finiteNumber(x.step);
      requireContract(step > 0 && step <= max - min, 'CALC', `${x.id} 的步长不合法`);
      known.add(x.id);
      const unit = cleanText(x.unit ?? '', 30);
      return {id: x.id, label: cleanText(x.label, 80), value, min, max, step, unit};
    }),
    outputs: outputs.map(x => {
      ident(x.id);
      const expr = cleanText(x.expr, 240);
      for (const n of compileExpr(expr).names)
        requireContract(known.has(n), 'CALC', `公式 ${x.id} 引用了未定义或靠后的变量 ${n}`);
      const digits = x.digits ?? 2;
      requireContract(
        Number.isInteger(digits) && digits >= 0 && digits <= 6,
        'CALC',
        '小数位数为 0–6'
      );
      known.add(x.id);
      const unit = cleanText(x.unit ?? '', 30);
      const o = {id: x.id, label: cleanText(x.label, 80), expr, unit, digits};
      if (x.primary === true) o.primary = true;
      return o;
    })
  };
}
/** Evaluate a calc block. `overrides` holds the reader's current input values (clamped). */
export function calcValues(data, overrides = {}) {
  const values = new Map();
  for (const x of data.inputs) {
    const o = overrides?.[x.id];
    const ok = typeof o === 'number' && Number.isFinite(o);
    values.set(x.id, ok ? Math.min(x.max, Math.max(x.min, o)) : x.value);
  }
  for (const x of data.outputs) {
    let v = NaN;
    try {
      v = evaluateExpr(compileExpr(x.expr).ast, values);
    } catch {}
    values.set(x.id, Number.isFinite(v) ? v : NaN);
  }
  return values;
}
/**
 * One shared scope for every number the reader sees: text bindings, calc outputs and figure
 * metrics all read from here, so prose cannot drift from the figure it describes.
 * `overrides` maps calc block IDs to the reader's current input values.
 */
export function documentScope(doc, overrides = {}) {
  const values = new Map(),
    digits = new Map();
  for (const b of doc.blocks) {
    if (!IDENT.test(b.id)) continue;
    const put = (name, v, d) => {
      values.set(`${b.id}.${name}`, v);
      if (d !== undefined) digits.set(`${b.id}.${name}`, d);
    };
    if (b.type === 'matrix') {
      const f = matrixFrame(b.data.matrix);
      const [[a, c], [e, g]] = b.data.matrix;
      put('det', f.determinant);
      put('area', f.area);
      Object.entries({a11: a, a12: c, a21: e, a22: g}).forEach(([k, v]) => put(k, v));
    }
    if (b.type === 'chart') {
      const v = b.data.rows.map(r => r.value);
      const sum = v.reduce((x, y) => x + y, 0);
      put('sum', sum);
      put('min', Math.min(...v));
      put('max', Math.max(...v));
      put('mean', sum / v.length);
      put('count', v.length);
    }
    if (b.type === 'calc') {
      const calc = calcValues(b.data, overrides[b.id]);
      for (const x of b.data.inputs) put(x.id, calc.get(x.id));
      for (const x of b.data.outputs) put(x.id, calc.get(x.id), x.digits);
    }
  }
  return {values, digits};
}
/** `{{expr}}` or `{{expr|digits}}` inside summary or body text. */
export const BINDING = /\{\{\s*([^{}|]{1,240}?)\s*(?:\|\s*(\d))?\s*\}\}/g;
export function formatNumber(v, digits) {
  if (!Number.isFinite(v)) return '无定义';
  const d = digits ?? (Number.isInteger(v) ? 0 : 2);
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: d,
    minimumFractionDigits: digits === undefined ? 0 : d,
    useGrouping: Math.abs(v) >= 10000
  }).format(v);
}
/** Resolve one binding against a scope; anything unresolvable reports ok:false. */
export function resolveBinding(src, digits, scope) {
  try {
    const {ast, names} = compileExpr(src);
    for (const n of names) if (!scope.values.has(n)) return {ok: false};
    const value = evaluateExpr(ast, scope.values);
    const d = digits === undefined ? scope.digits.get(src.trim()) : Number(digits);
    return {ok: true, value, text: formatNumber(value, d)};
  } catch {
    return {ok: false};
  }
}
/** Split text into literal and bound parts. Unresolved bindings stay as literal text. */
export function bindParts(text, scope) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(BINDING)) {
    const r = resolveBinding(m[1], m[2], scope);
    if (!r.ok) continue;
    if (m.index > last) parts.push({text: text.slice(last, m.index)});
    parts.push({text: r.text, expr: m[1].trim()});
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({text: text.slice(last)});
  return parts;
}
export function bindText(text, scope) {
  return bindParts(text, scope)
    .map(p => p.text)
    .join('');
}
function bindingWarnings(doc, scope = documentScope(doc)) {
  const out = [];
  for (const text of [doc.summary, ...doc.blocks.map(b => b.body)])
    for (const m of text.matchAll(BINDING))
      if (!resolveBinding(m[1], m[2], scope).ok)
        out.push(`数值绑定 ${m[0]} 无法解析，按原文显示。`);
  return out;
}
/** Normalize a host registry; restricted/missing entries lose excerpt and URL here, before any transport. */
export function normalizeSources(sources = []) {
  array(sources, 40);
  jsonShape(sources);
  uniqueIds(sources);
  return sources.map(s => {
    const access = ['available', 'restricted', 'missing'].includes(s.access) ? s.access : 'missing';
    return {
      id: s.id,
      title: cleanText(s.title, 200),
      url: access === 'available' ? safeUrl(s.url) : null,
      excerpt: access === 'available' ? cleanText(s.excerpt ?? '', 4000) : '',
      locator: cleanText(s.locator ?? '', 200),
      access
    };
  });
}
/** source registry must be provided by the trusted host, never read from a model's assertion of verification. */
export function validateDocument(input, {sources = [], partial = false} = {}) {
  const budget = {n: 0, size: 0};
  jsonShape(input, 0, budget);
  requireContract(budget.size <= 180000, 'BUDGET', '文档超过 180,000 字符预算');
  requireContract(
    isRecord(input) && input.schemaVersion === SCHEMA_VERSION,
    'VERSION',
    '不支持的文档协议版本'
  );
  validId(input.id);
  requireContract(
    Number.isSafeInteger(input.revision) && input.revision >= 1,
    'REVISION',
    '版本必须为正整数'
  );
  const registry = normalizeSources(sources);
  // Set by patchBlock: the producer revision a local edit started from.
  if (input.baseRevision !== undefined)
    requireContract(
      Number.isSafeInteger(input.baseRevision) &&
        input.baseRevision >= 1 &&
        input.baseRevision < input.revision,
      'REVISION',
      '基础版本必须小于当前版本'
    );
  const warnings = array(input.warnings ?? [], 16).map(x => cleanText(x, 1000));
  const blocks = array(input.blocks, 40).map(b =>
    validateBlock(b, new Set(registry.map(s => s.id)), warnings)
  );
  uniqueIds(blocks);
  const out = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    revision: input.revision,
    ...(input.baseRevision === undefined ? {} : {baseRevision: input.baseRevision}),
    title: cleanText(input.title, 200),
    summary: cleanText(input.summary ?? '', 4000),
    warnings: [...new Set(warnings)].slice(0, 16),
    blocks,
    sources: registry,
    originalText: cleanText(input.originalText ?? '', 60000)
  };
  // Runtime findings are recomputed on every validation and never read from the input, so a
  // producer cannot pre-fill them and a fixed inconsistency does not leave a stale message.
  // A partial (still streaming) document may bind to blocks that have not arrived yet.
  if (partial) out.checks = [];
  else {
    const scope = documentScope(out);
    out.checks = [...new Set([...bindingWarnings(out, scope), ...consistencyWarnings(out, scope)])].slice(
      0,
      16
    );
  }
  return out;
}
/**
 * Cross-block check: a hard-coded number written right after a computed quantity's name
 * ("行列式为 3") must match the value the runtime computes. Bound values are always consistent.
 */
export function consistencyWarnings(doc, scope = documentScope(doc)) {
  const named = [];
  for (const b of doc.blocks) {
    if (b.type === 'matrix')
      named.push(
        [['行列式', 'det'], `${b.id}.det`],
        [['面积倍数', '面积变为', '面积放大'], `${b.id}.area`]
      );
    if (b.type === 'calc')
      for (const x of [...b.data.inputs, ...b.data.outputs])
        if (Array.from(x.label).length >= 2) named.push([[x.label], `${b.id}.${x.id}`]);
  }
  const out = [];
  for (const text of [doc.summary, ...doc.blocks.map(b => b.body)]) {
    const literal = text.replace(BINDING, ' ');
    for (const [labels, key] of named) {
      const expected = scope.values.get(key);
      if (!Number.isFinite(expected)) continue;
      for (const label of labels)
        for (let at = literal.indexOf(label); at >= 0; at = literal.indexOf(label, at + 1)) {
          // Only a value statement in the same clause counts ("行列式为 3", "面积变为 2 倍");
          // "利率调低 0.5" describes a change and is ignored.
          const tail = literal.slice(at + label.length, at + label.length + 16);
          const m = /(?:为|是)$/.test(label)
            ? tail.match(/^\s*([\-−]?\d+(?:\.\d+)?)/)
            : tail.match(
                /^[^0-9\-−\n。；;，,、！？!?]{0,6}?(?:为|是|=|＝|：|:|约|等于|变为)\s*([\-−]?\d+(?:\.\d+)?)/
              );
          if (!m) continue;
          const said = Number(m[1].replace('−', '-'));
          const decimals = m[1].split('.')[1]?.length ?? 0;
          const tolerance = Math.max(1e-9, Math.abs(expected) * 0.005, 10 ** -decimals / 2);
          if (Math.abs(said - expected) > tolerance)
            out.push(
              `正文写“${label} ${m[1]}”，但按组件数据计算为 ${formatNumber(expected)}；请以计算结果为准。`
            );
        }
    }
  }
  return out;
}
/** Split into chunks of at most `max` UTF-16 units, preferring paragraph or line breaks and never splitting a surrogate pair. */
export function splitText(text, max = 12000) {
  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    const paragraph = rest.lastIndexOf('\n\n', max - 2);
    const line = rest.lastIndexOf('\n', max - 1);
    let cut = max;
    if (paragraph >= max / 2) cut = paragraph + 2;
    else if (line >= max / 2) cut = line + 1;
    else if (/[\ud800-\udbff]/.test(rest[cut - 1])) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}
/**
 * Wrap existing chat text. `format: 'markdown'` renders a safe subset (no HTML, https links only);
 * the source string itself is kept unchanged, so plain view and export still show the original.
 */
export function plainDocument(text, id = 'plain', title = '正文', {format = 'text'} = {}) {
  cleanText(text, 60000);
  const pieces = splitText(text);
  return validateDocument({
    schemaVersion: SCHEMA_VERSION,
    id,
    revision: 1,
    title,
    summary: '',
    warnings: [],
    originalText: text,
    blocks: pieces.map((body, i) => ({id: `text-${i}`, type: 'prose', title: '', body, format}))
  });
}
export function projectText(doc, {includeAnswers = false, includeOriginal = true, overrides = {}} = {}) {
  const scope = documentScope(doc, overrides);
  const lines = [
    doc.title,
    bindText(doc.summary, scope),
    ...doc.warnings.map(x => '注意：' + x),
    ...(doc.checks ?? []).map(x => '一致性检查：' + x)
  ];
  for (const b of doc.blocks) {
    // A component that replaced its source span projects that span verbatim: plain text,
    // copy and downgrade read the answer itself, never a second rendering of it.
    if (typeof b.original === 'string' && b.original) {
      lines.push('', b.original);
      continue;
    }
    lines.push('', b.title, bindText(b.body, scope), ...b.qualifiers.map(x => '条件：' + x));
    const d = b.data ?? {};
    if (Object.hasOwn(EXTENDED_CATALOG, b.type)) lines.push(extendedText(b.type, d));
    if (b.type === 'calc') {
      const v = calcValues(d, overrides[b.id]);
      const unit = x => (x.unit ? ' ' + x.unit : '');
      for (const x of d.inputs) lines.push(`${x.label} = ${formatNumber(v.get(x.id))}${unit(x)}`);
      for (const x of d.outputs)
        lines.push(
          `${x.label} = ${formatNumber(v.get(x.id), x.digits)}${unit(x)}（公式：${x.expr}）`
        );
    }
    if (b.type === 'timeline')
      lines.push(...d.items.map(x => `${x.when}：${x.title}${x.detail ? ' — ' + x.detail : ''}`));
    if (b.type === 'checklist') lines.push(...d.items.map(x => '☐ ' + x.text));
    if (b.type === 'steps') lines.push(...d.items.map((x, i) => `${i + 1}. ${x}`));
    if (b.type === 'compare') lines.push(d.columns.join(' | '), ...d.rows.map(r => r.join(' | ')));
    if (b.type === 'code') lines.push(d.code);
    if (b.type === 'math') lines.push(mathText(d.expression));
    if (b.type === 'diagram') {
      if (d.direction !== undefined) lines.push(`方向: ${d.direction}`);
      lines.push(...d.nodes.map(n => `${n.id}: ${n.label}${n.shape === undefined ? '' : ` [${n.shape}]`}`));
      lines.push(...d.edges.map(e => `${e.from} → ${e.to} [${e.relation}]${e.label ? ` ${e.label}` : ''}${e.style === undefined ? '' : ` [${e.style}]`}`));
    }
    if (b.type === 'matrix') {
      const f = matrixFrame(d.matrix);
      lines.push(`A=${JSON.stringify(d.matrix)}；det(A)=${f.determinant}；面积倍数=${f.area}`);
    }
    if (b.type === 'chart') {
      lines.push(...d.rows.map(r => `${r.label}：${r.value} ${d.unit}`));
      if (d.note) lines.push('数据说明：' + d.note);
    }
    if (b.type === 'evidence')
      lines.push(
        ...d.claims.map(
          c => `${c.text} [${c.relation}] 来源：${c.sourceIds?.join(', ') || '未提供'}`
        )
      );
    if (b.type === 'exercise') {
      lines.push(d.question);
      if (includeAnswers) lines.push('答案：' + d.answer);
      else lines.push('答案未导出；请先独立回忆。');
    }
    if (b.refs.length) lines.push('来源 ID：' + b.refs.join(', '));
  }
  if (includeOriginal && doc.originalText && (includeAnswers || !/```\s*sw:exercise/.test(doc.originalText))) lines.push('', '原始回答（增强结构不替代原文）', doc.originalText);
  for (const s of doc.sources)
    lines.push(
      '',
      `[${s.id}] ${s.title} (${s.access})`,
      s.locator,
      s.access === 'available' ? s.excerpt : '材料不可见；不能核验',
      s.access === 'available' ? (s.url ?? '') : ''
    );
  return lines.filter(x => x !== undefined).join('\n');
}
/** Readable export redacts restricted source excerpts; a source badge is never an entailment certificate. */
export function exportDocument(doc) {
  const out = structuredClone(doc);
  // A raw inline fence may contain the exercise answer; hiding only data.answer is insufficient.
  if (out.blocks.some(b => b.type === 'exercise') && /```\s*sw:exercise/.test(out.originalText)) out.originalText = '';
  out.sources = out.sources.map(s =>
    s.access === 'available' ? s : {...s, excerpt: '', url: null}
  );
  out.blocks = out.blocks.map(b =>
    b.type === 'exercise' ? {...b, data: {...b.data, answer: '[未导出答案]', hints: []}} : b
  );
  return out;
}
export function patchBlock(doc, blockId, replacement, expectedRevision) {
  requireContract(doc.revision === expectedRevision, 'CONFLICT', '内容已更新，请先对比版本');
  requireContract(
    doc.blocks.some(b => b.id === blockId) && replacement.id === blockId,
    'BLOCK',
    '待修改内容不存在或 ID 不匹配'
  );
  const changedNumeric = ['matrix', 'chart', 'calc'].includes(replacement.type);
  const warnings = [...doc.warnings];
  if (changedNumeric)
    warnings.push('参数已修改；绑定的数值已同步重算，未绑定的文字可能仍对应旧参数，请重新核验。');
  return validateDocument(
    {
      ...doc,
      revision: doc.revision + 1,
      // Local edits remember the producer revision they started from, so a later
      // upstream revision with the same number is not mistaken for a conflict.
      baseRevision: doc.baseRevision ?? doc.revision,
      warnings: [...new Set(warnings)].slice(0, 16),
      blocks: doc.blocks.map(b => (b.id === blockId ? replacement : b))
    },
    {sources: doc.sources}
  );
}
/** Independent migration of the original 0.1 lab's three data contracts. */
export function migrateLab(old) {
  requireContract(old?.schemaVersion === '0.1.0', 'VERSION', '仅迁移原 0.1.0 规格');
  const b = {id: 'legacy', title: old.title, body: old.summary, qualifiers: old.warnings ?? []};
  if (old.kind === 'transform') {
    b.type = 'matrix';
    b.data = {matrix: old.matrix};
  } else if (old.kind === 'chart') {
    b.type = 'chart';
    b.data = {rows: old.data, unit: old.unit ?? '未声明'};
  } else if (old.kind === 'flow') {
    b.type = 'diagram';
    b.data = {nodes: old.nodes, edges: old.edges ?? []};
    b.qualifiers.push('保留节点、端点和关系类型；关系图不是运行成功或因果证明。');
  } else b.type = 'prose';
  return validateDocument({
    schemaVersion: SCHEMA_VERSION,
    id: old.artifactId ?? 'migrated',
    revision: old.revision ?? 1,
    title: old.title,
    summary: old.summary,
    warnings: ['从旧规则演示迁移；不是已核验业务结果。'],
    blocks: [b]
  });
}
