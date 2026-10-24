/**
 * Safe arithmetic for calc outputs and text bindings. Numbers, names, + - * / % ^, parentheses
 * and a fixed function list only: no strings, property access, assignment or arbitrary calls.
 * Parsing produces a plain JSON tree; evaluation never touches globals.
 */
const MAX_SOURCE = 240,
  MAX_TOKENS = 120,
  MAX_DEPTH = 24;
const round = (x, d = 0) => {
  if (!Number.isInteger(d) || d < 0 || d > 6) fail('round 的位数必须是 0–6 的整数');
  const k = 10 ** d;
  return Math.round(x * k) / k;
};
// [min arity, max arity, implementation]
const FUNCS = Object.freeze({
  abs: [1, 1, Math.abs],
  sqrt: [1, 1, Math.sqrt],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  exp: [1, 1, Math.exp],
  ln: [1, 1, Math.log],
  log10: [1, 1, Math.log10],
  pow: [2, 2, Math.pow],
  min: [1, 8, Math.min],
  max: [1, 8, Math.max],
  round: [1, 2, round]
});
export const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}(?:\.[A-Za-z_][A-Za-z0-9_]{0,31})?$/;
function fail(message) {
  throw Object.assign(new Error(message), {code: 'EXPR'});
}
function tokenize(src) {
  if (typeof src !== 'string' || !src.trim() || src.length > MAX_SOURCE)
    fail(`公式必须是 1–${MAX_SOURCE} 个字符`);
  const re =
    /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)|([-+*/%^(),]))/y;
  const out = [];
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m) fail(`公式第 ${at + 1} 个字符无法识别`);
    if (m[1] !== undefined) out.push({t: 'num', v: Number(m[1])});
    else if (m[2] !== undefined) out.push({t: 'name', v: m[2]});
    else out.push({t: m[3]});
    if (out.length > MAX_TOKENS) fail('公式过长');
  }
  return out;
}
/** Returns {ast, names}; `names` lists every variable the expression reads. */
export function compileExpr(src) {
  const tokens = tokenize(src);
  const names = new Set();
  let i = 0,
    depth = 0;
  const peek = () => tokens[i]?.t;
  const take = t => {
    if (peek() !== t) fail(`公式缺少 ${t}`);
    i++;
  };
  const nest = fn => {
    if (++depth > MAX_DEPTH) fail('公式嵌套过深');
    const v = fn();
    depth--;
    return v;
  };
  function additive() {
    let a = multiplicative();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++].t;
      a = {op, a, b: multiplicative()};
    }
    return a;
  }
  function multiplicative() {
    let a = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = tokens[i++].t;
      a = {op, a, b: unary()};
    }
    return a;
  }
  function unary() {
    return nest(() => {
      if (peek() === '-') {
        i++;
        return {op: 'neg', a: unary()};
      }
      if (peek() === '+') {
        i++;
        return unary();
      }
      return power();
    });
  }
  function power() {
    const a = primary();
    // Right-associative, and binds tighter than unary minus on its left: -2^2 = -(2^2).
    if (peek() === '^') {
      i++;
      return {op: '^', a, b: unary()};
    }
    return a;
  }
  function primary() {
    const tok = tokens[i++];
    if (!tok) fail('公式不完整');
    if (tok.t === 'num') return {num: tok.v};
    if (tok.t === '(') {
      const v = nest(additive);
      take(')');
      return v;
    }
    if (tok.t === 'name') {
      if (peek() !== '(') {
        names.add(tok.v);
        return {name: tok.v};
      }
      if (!Object.hasOwn(FUNCS, tok.v)) fail(`不支持的函数 ${tok.v}`);
      i++;
      const args = [];
      if (peek() !== ')') {
        args.push(nest(additive));
        while (peek() === ',') {
          i++;
          args.push(nest(additive));
        }
      }
      take(')');
      const [min, max] = FUNCS[tok.v];
      if (args.length < min || args.length > max) fail(`${tok.v} 的参数数量不合法`);
      return {fn: tok.v, args};
    }
    fail(`公式中多余的 ${tok.t}`);
  }
  const ast = additive();
  if (i !== tokens.length) fail(`公式中多余的 ${tokens[i].t ?? tokens[i].v}`);
  for (const n of names) if (!NAME.test(n)) fail(`名称 ${n} 不合法`);
  return {ast, names};
}
/** Evaluates a compiled tree. `scope` maps names to numbers; a missing name is an error. */
export function evaluateExpr(ast, scope) {
  const get = name => {
    const v = scope instanceof Map ? scope.get(name) : Object.hasOwn(scope, name) && scope[name];
    if (typeof v !== 'number')
      throw Object.assign(new Error(`名称 ${name} 没有值`), {code: 'UNBOUND'});
    return v;
  };
  const run = n => {
    if (n.num !== undefined) return n.num;
    if (n.name !== undefined) return get(n.name);
    if (n.fn !== undefined) return FUNCS[n.fn][2](...n.args.map(run));
    if (n.op === 'neg') return -run(n.a);
    const a = run(n.a),
      b = run(n.b);
    if (n.op === '+') return a + b;
    if (n.op === '-') return a - b;
    if (n.op === '*') return a * b;
    if (n.op === '/') return a / b;
    if (n.op === '%') return a % b;
    return a ** b;
  };
  return run(ast);
}
export function evaluate(src, scope = {}) {
  return evaluateExpr(compileExpr(src).ast, scope);
}
