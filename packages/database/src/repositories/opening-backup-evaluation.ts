/** Restored bytes never carry server scoring authority, even on a historical revision. */
export function normalizeOpeningImportedEvaluation(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "opening_learning_item_versions" && "evaluation_spec" in row) return { ...row, evaluation_spec: null };
  if (table !== "opening_learning_observations") return row;
  if (row.verdict_source === "ai_graded" || row.ai_evaluation != null) {
    return { ...row, ai_evaluation: null, server_evaluation: null, verdict_source: "unknown", outcome: "unverified", evidence_verdict: "MASTERY_NOT_ESTABLISHED" };
  }
  if (row.verdict_source === "deterministic" || row.server_evaluation != null) {
    return { ...row, server_evaluation: null, verdict_source: "unknown", outcome: "unverified", evidence_verdict: "MASTERY_NOT_ESTABLISHED" };
  }
  return "server_evaluation" in row ? { ...row, server_evaluation: null } : row;
}
