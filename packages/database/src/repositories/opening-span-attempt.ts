import type { Sql, TransactionSql } from "postgres";
import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
import { getSpanProblem, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { spanExerciseInputSchema, type SpanProblem, type Scope } from "@aistudy/contracts";

/** Only server catalogue identities are executable; persisted operands are never trusted. */
export function parseOpeningSpanExercise(value: unknown): SpanProblem | null {
  if (!value || typeof value !== "object") return null;
  const spec = value as Record<string, unknown>;
  if (spec.kind !== "span" || spec.specVersion !== "span-v1" || typeof spec.problemId !== "string"
    || (typeof spec.version !== "number" && typeof spec.version !== "string")) return null;
  return getSpanProblem(spec.problemId, spec.version) ?? getSpanReservedProblem(spec.problemId, spec.version);
}

/** Imported intent can identify a displayed/previously seen question, never an evaluator. */
export function parseOpeningSpanIntent(value: unknown): { problem: SpanProblem; sourceId: string } | null {
  if (!value || typeof value !== "object") return null;
  const parsed = spanExerciseInputSchema.safeParse((value as Record<string, unknown>).spanExercise);
  if (!parsed.success) return null;
  const problem = getSpanProblem(parsed.data.problemId, parsed.data.version) ?? getSpanReservedProblem(parsed.data.problemId, parsed.data.version);
  return problem ? { problem, sourceId: parsed.data.sourceId } : null;
}

/** Missing imported scoring authority must never erase negative exposure history. */
export async function readOpeningSpanExposureHistory(tx: Sql | TransactionSql, scope: Scope) {
  const rows = await tx`SELECT a.create_intent,a.requirement_key,v.evaluation_spec FROM opening_learning_attempts a
    LEFT JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
      AND (a.requirement_key=${SPAN_REQUIREMENT_KEY} OR a.create_intent ? 'spanExercise')`;
  const problemIds = new Set<string>(), familyIds = new Set<string>(), uncertainProblemIds = new Set<string>();
  let unknownHistory = false;
  for (const row of rows) {
    const canonical = parseOpeningSpanExercise(row.evaluation_spec);
    const problem = canonical ?? parseOpeningSpanIntent(row.create_intent)?.problem;
    if (!problem) { unknownHistory = true; continue; }
    problemIds.add(problem.id); familyIds.add(problem.familyId);
    if (!canonical) uncertainProblemIds.add(problem.id);
  }
  return { problemIds, familyIds, uncertainProblemIds, unknownHistory };
}
