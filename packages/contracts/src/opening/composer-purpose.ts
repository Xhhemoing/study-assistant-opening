import { z } from "zod";

/** User intent, separate from server-issued source/record disclosure authority. */
export const composerPurposeSchema = z.enum(["answer", "explain_state", "teach", "plan", "query"]);
export type ComposerPurpose = z.infer<typeof composerPurposeSchema>;
/** The one routing owner. Legacy querySystem remains a compatible explicit selection. */
export function resolveComposerPurpose(input: { purpose?: ComposerPurpose; querySystem?: boolean }): ComposerPurpose {
  if (input.querySystem && input.purpose && !["query", "explain_state"].includes(input.purpose)) throw new Error("conflicting composer purpose");
  return input.purpose ?? (input.querySystem ? "query" : "answer");
}
export function isSystemQueryPurpose(input: { purpose?: ComposerPurpose; querySystem?: boolean }): boolean {
  return ["query", "explain_state"].includes(resolveComposerPurpose(input));
}
