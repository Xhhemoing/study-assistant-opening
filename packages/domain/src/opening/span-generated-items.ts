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
const additionalFamilies = ["independent-2d", "consistent-3d", "inconsistent-3d", "dependent-generators", "geometry-line", "geometry-plane"] as const;
export function generateSpanItem(purpose: SpanItemPurpose, index: number, seed = SPAN_GENERATED_SEED, version = SPAN_GENERATOR_VERSION, family = "rational-3d"): SpanProblem {
  if (version !== SPAN_GENERATOR_VERSION || !purposes.includes(purpose) || !Number.isInteger(seed) || seed < 0 || seed > 9999
    || !Number.isInteger(index) || index < 0 || index >= SPAN_GENERATED_CAPACITY) throw new RangeError("Unsupported span generation identity");
  if (family !== "rational-3d") {
    if (!additionalFamilies.some(candidate => candidate === family)) throw new RangeError("Unsupported span family");
    // Injective seed/purpose/ordinal partition. The shipped seed keeps arithmetic small;
    // distinct third coordinates separate families without claiming transfer.
    const partition = purposes.indexOf(purpose);
    const n = (seed - SPAN_GENERATED_SEED) * 48 + partition * 12 + index + 2;
    const a = index - 5 + partition, b = partition - index, k = 2 + index % 3;
    let vectors: SpanProblem["vectors"], target: string[];
    if (family === "dependent-generators" || family === "geometry-line") {
      const c = family === "geometry-line" ? 8 : 7;
      vectors = [["1", String(n), String(c)], [String(k), String(k * n), String(k * c)]];
      target = [String(a), String(a * n), String(a * c)];
      if (family === "geometry-line" && index % 2 === 1) target[1] = String(a * n + partition + 1);
    } else {
      const c = family === "consistent-3d" ? 1 : family === "inconsistent-3d" ? 3 : 5;
      const d = c + 1;
      vectors = [["1", String(n)], ["0", "1"]];
      target = [String(a), String(a * n + b)];
      if (family !== "independent-2d") {
        vectors[0]!.push(String(c)); vectors[1]!.push(String(d));
        const offset = family === "inconsistent-3d" || (family === "geometry-plane" && index % 2 === 1) ? partition + 1 : 0;
        target.push(String(a * c + b * d + offset));
      }
    }
    return { id: `span-reserved-generated-${purpose}-${family}-${seed}-${index}`, version, familyId: `span:${family}`,
      vectors, target, knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS,
        ...(family.startsWith("geometry-") ? ["linear-system:consistency", family === "geometry-line" ? "geometry:line-equation" : "geometry:plane-equation"] : [])] };
  }
  // Disjoint integer partitions; version/ID are deliberately absent from content identity.
  const n = BigInt(seed * 64 + purposes.indexOf(purpose) * SPAN_GENERATED_CAPACITY + index + 2);
  return { id: `span-reserved-generated-${purpose}-${seed}-${index}`, version, familyId: "span:rational-3d",
    vectors: [[String(n), "0", "1"], ["0", String(n + 1n), "-1"]],
    target: [formatSpanRational(rational(n * n, 2n)), formatSpanRational(rational(-(n + 1n) * (n + 1n), 3n)), formatSpanRational(rational(5n * n + 2n, 6n))],
    knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] };
}
export function parseGeneratedSpanItem(id: string, version: string | number): { problem: SpanProblem; purpose: SpanItemPurpose } | null {
  const expanded = /^span-reserved-generated-(teaching|validation|retest|research)-(independent-2d|consistent-3d|inconsistent-3d|dependent-generators|geometry-line|geometry-plane)-(0|[1-9]\d{0,3})-(0|[1-9]\d?)$/.exec(id);
  if (expanded) {
    if (String(version) !== SPAN_GENERATOR_VERSION || Number(expanded[4]) >= SPAN_GENERATED_CAPACITY) return null;
    const purpose = expanded[1] as SpanItemPurpose;
    return { problem: generateSpanItem(purpose, Number(expanded[4]), Number(expanded[3]), String(version), expanded[2]), purpose };
  }
  const match = /^span-reserved-generated-(teaching|validation|retest|research)-(0|[1-9]\d{0,3})-(0|[1-9]\d?)$/.exec(id);
  if (!match || String(version) !== SPAN_GENERATOR_VERSION || Number(match[3]) >= SPAN_GENERATED_CAPACITY) return null;
  const purpose = match[1] as SpanItemPurpose;
  return { problem: generateSpanItem(purpose, Number(match[3]), Number(match[2]), String(version)), purpose };
}
export function listGeneratedSpanItems(purpose: SpanItemPurpose): SpanProblem[] {
  return ["rational-3d", ...additionalFamilies].flatMap(family =>
    Array.from({ length: SPAN_GENERATED_CAPACITY }, (_, index) => generateSpanItem(purpose, index, SPAN_GENERATED_SEED, SPAN_GENERATOR_VERSION, family)));
}
