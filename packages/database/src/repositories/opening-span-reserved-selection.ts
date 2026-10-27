import type { Scope, SpanProblem, SpanTeachingMode } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { readOpeningSpanExposureHistory } from "./opening-span-attempt";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
export type OpeningSpanReservedChoice = { kind: "available"; problem: SpanProblem } | { kind: "unavailable"; reason: "unknown_history" | "exhausted" };
export function chooseOpeningSpanReservedProblem(history: Pick<Awaited<ReturnType<typeof readOpeningSpanExposureHistory>>, "problemIds" | "familyIds" | "unknownHistory">, mode: SpanTeachingMode): OpeningSpanReservedChoice {
  if (history.unknownHistory) return { kind: "unavailable", reason: "unknown_history" };
  const available = listSpanReservedProblems().filter(problem => !history.problemIds.has(problem.id) && !history.familyIds.has(problem.familyId));
  const desired = mode === "challenge" ? "span-reserved-transfer" : mode === "overview" ? "span-reserved-dependent" : "span-reserved-fraction";
  const problem = available.find(row => row.id === desired) ?? available[0];
  return problem ? { kind: "available", problem } : { kind: "unavailable", reason: "exhausted" };
}
export async function readOpeningSpanReservedChoice(db: Sql | TransactionSql, scope: Scope, mode: SpanTeachingMode) {
  return chooseOpeningSpanReservedProblem(await readOpeningSpanExposureHistory(db, scope), mode);
}
