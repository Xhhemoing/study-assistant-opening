import { evaluateArithmeticQuestion } from "../../../domain/src/opening/arithmetic-check";

/** Identity is the supported expression, never its result (2+3 is not 1+4). */
export function reservedArithmeticIdentity(text: string) {
  let expression = text.trim().replace(/^(?:计算|求值|calculate|evaluate)\s*[:：]?\s*/i, "")
    .replace(/\s*(?:=\s*[?？]?|[?？。])\s*$/, "");
  // Only balanced outer math delimiters are aliases; partial delimiters stay unsupported.
  expression = expression.replace(/^\$\$([^$]*)\$\$$/, "$1").replace(/^\$([^$]*)\$$/, "$1")
    .replace(/^\\\(([\s\S]*)\\\)$/, "$1").replace(/^\\\[([\s\S]*)\\\]$/, "$1")
    .replace(/\\(?:dfrac|tfrac|frac)\{(-?\d{1,18})\}\{(-?\d{1,18})\}/g, "($1/$2)")
    .replace(/\\times|×|·/g, "*").replace(/\\div|÷/g, "/").replace(/−/g, "-");
  // Validate before removing spaces: mixed fractions must not become different numbers.
  const value = evaluateArithmeticQuestion(expression);
  if (!value || text.length > 400) return null;
  expression = expression.replace(/\s/g, "");
  return { expression, familyId: `arithmetic:${[...new Set(expression.match(/[+*/-]/g))].sort().join("")}`,
    value: `${value.n}/${value.d}` };
}

/** A label is not a condition. Arbitrary prose/partial matches cannot certify completeness. */
export function reservedArithmeticExposureText(text: string) {
  const whole = reservedArithmeticIdentity(text);
  if (whole) return { complete: true, identity: whole };
  const labeled = /^(?:example|hint|例题|例|示例|提示)\s*[:：]\s*(.+)$/i.exec(text.trim());
  if (labeled) {
    const identity = reservedArithmeticIdentity(labeled[1]!);
    return { complete: !!identity, identity };
  }
  // Non-mathematical prose/metadata carries no expression. Never partially parse
  // conditions, truncated arithmetic, symbolic problems, math delimiters or figures.
  const metadata = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(text)
    || /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(text);
  const unresolved = /[+*/×÷·−=$^<>≤≥{}]|\\(?:frac|dfrac|tfrac|times|div|sqrt|begin|\(|\[)|\d\s*-|-\s*\d|[a-z]\s*-\s*[a-z]|\d.*[()]|[()].*\d|未解|未知|截断|未完成|图中|见图|条件|truncated|unsolved|unknown|pending|streaming|figure|diagram/i.test(text);
  return { complete: metadata || !unresolved, identity: null };
}
