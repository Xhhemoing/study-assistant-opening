import { z } from "zod";
import { hasRecordReadDemand, type QueryHistory } from "./system-record-demand";
export * from "./system-record-demand";

/** User intent, separate from server-issued source/record disclosure authority. */
export const composerPurposeSchema = z.enum(["answer", "explain_state", "teach", "plan", "query"]);
export type ComposerPurpose = z.infer<typeof composerPurposeSchema>;
/** Teaching response semantics only; these do not authorize queries, grading, or task writes. */
export type LearningMessageIntent = "general" | "concept" | "solve" | "submit_attempt" | "frustrated" | "skip";
/** The one routing owner. Legacy querySystem remains a compatible explicit selection. */
export function resolveComposerPurpose(input: { purpose?: ComposerPurpose; querySystem?: boolean }): ComposerPurpose {
  if (input.querySystem && input.purpose && !["query", "explain_state"].includes(input.purpose)) throw new Error("conflicting composer purpose");
  return input.purpose ?? (input.querySystem ? "query" : "answer");
}
export function isSystemQueryPurpose(input: { purpose?: ComposerPurpose; querySystem?: boolean; text?: string; history?: QueryHistory }): boolean {
  const purpose = resolveComposerPurpose(input);
  return ["query", "explain_state"].includes(purpose) || purpose === "answer" && !!input.text && hasRecordReadDemand(input.text, input.history);
}
