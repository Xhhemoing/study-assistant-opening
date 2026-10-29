/** Server-only parameterized supply. Never export through the public domain barrel. */
import type { SpanProblem } from "@aistudy/contracts";
import { SPAN_KNOWLEDGE_COMPONENTS } from "./span-teaching-catalog";
import { formatSpanRational, parseSpanRational, rational } from "./span-rational";
export type SpanItemPurpose = "teaching" | "validation" | "retest" | "research";
const purposes: SpanItemPurpose[] = ["teaching", "validation", "retest", "research"];
export const SPAN_GENERATOR_VERSION = "1";
export const SPAN_GENERATED_SEED = 1729;
export const SPAN_GENERATED_CAPACITY = 12;
export function spanProblemContentKey(problem: Pick<SpanProblem, "vectors" | "target">): string {
  const normalize = (values: string[]) => values.map(value => {
    const parsed = parseSpanRational(value);
    if (!parsed) throw new RangeError("Invalid span operand");
    return formatSpanRational(parsed);
  });
  return JSON.stringify([problem.vectors.map(normalize), normalize(problem.target)]);
}
export function generateSpanItem(purpose: SpanItemPurpose, index: number, seed = SPAN_GENERATED_SEED, version = SPAN_GENERATOR_VERSION): SpanProblem {
  if (version !== SPAN_GENERATOR_VERSION || !purposes.includes(purpose) || !Number.isInteger(seed) || seed < 0 || seed > 9999
    || !Number.isInteger(index) || index < 0 || index >= SPAN_GENERATED_CAPACITY) throw new RangeError("Unsupported span generation identity");
  // Disjoint integer partitions; version/ID are deliberately absent from content identity.
  const n = BigInt(seed * 64 + purposes.indexOf(purpose) * SPAN_GENERATED_CAPACITY + index + 2);
  return { id: `span-reserved-generated-${purpose}-${seed}-${index}`, version, familyId: "span:rational-3d",
    vectors: [[String(n), "0", "1"], ["0", String(n + 1n), "-1"]],
    target: [formatSpanRational(rational(n * n, 2n)), formatSpanRational(rational(-(n + 1n) * (n + 1n), 3n)), formatSpanRational(rational(5n * n + 2n, 6n))],
    knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] };
}
export function parseGeneratedSpanItem(id: string, version: string | number): { problem: SpanProblem; purpose: SpanItemPurpose } | null {
  const match = /^span-reserved-generated-(teaching|validation|retest|research)-(0|[1-9]\d{0,3})-(0|[1-9]\d?)$/.exec(id);
  if (!match || String(version) !== SPAN_GENERATOR_VERSION || Number(match[3]) >= SPAN_GENERATED_CAPACITY) return null;
  const purpose = match[1] as SpanItemPurpose;
  return { problem: generateSpanItem(purpose, Number(match[3]), Number(match[2]), String(version)), purpose };
}
export function listGeneratedSpanItems(purpose: SpanItemPurpose): SpanProblem[] {
  return Array.from({ length: SPAN_GENERATED_CAPACITY }, (_, index) => generateSpanItem(purpose, index));
}
