import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
import { getSpanProblem } from "@aistudy/domain";
import type { SpanProblem } from "@aistudy/contracts";

/** Only server catalogue identities are executable; persisted operands are never trusted. */
export function parseOpeningSpanExercise(value: unknown): SpanProblem | null {
  if (!value || typeof value !== "object") return null;
  const spec = value as Record<string, unknown>;
  if (spec.kind !== "span" || spec.specVersion !== "span-v1" || typeof spec.problemId !== "string"
    || (typeof spec.version !== "number" && typeof spec.version !== "string")) return null;
  return getSpanProblem(spec.problemId, spec.version) ?? getSpanReservedProblem(spec.problemId, spec.version);
}
