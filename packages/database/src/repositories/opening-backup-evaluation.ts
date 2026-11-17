/** Restored bytes never carry server scoring authority, even on a historical revision. */
export function normalizeOpeningImportedEvaluation(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "course_goals") return { ...row, active: false,
    lifecycle: ["archived", "stopped"].includes(String(row.lifecycle)) ? row.lifecycle : "paused" };
  if (table === "course_requirements") return { ...row, approved_at: null };
  if (table === "course_requirement_evidence_links") return { ...row, active: false };
  if (table === "opening_learning_asset_links") return { ...row, status: "detached" };
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (table === "workspace_preferences" && record(row.adaptive_planning) && record(row.adaptive_planning.spanTutorGrants)) {
    return { ...row, adaptive_planning: { ...row.adaptive_planning, spanTutorGrants: Object.fromEntries(
      Object.entries(row.adaptive_planning.spanTutorGrants).map(([id, grant]) => [id, record(grant) ? { ...grant, enabled: false } : grant])
    ) } };
  }
  if (table === "opening_retest_activities" && record(row.learning_protocol)) {
    const protocol = { ...row.learning_protocol };
    delete protocol.tutorAutomation;
    return { ...row, learning_protocol: protocol };
  }
  // Only the incoming copy loses authority. Retain plans, receipts and old history verbatim.
  if (table === "opening_teaching_activities" && record(row.goal_json)) {
    const goal = { ...row.goal_json };
    delete goal.spanCourseBinding;
    const intent = record(row.create_intent) ? { ...row.create_intent } : row.create_intent;
    if (record(intent)) delete intent.spanCourseBinding;
    return { ...row, goal_json: goal, ...(record(intent) ? { create_intent: intent } : {}) };
  }
  if (table === "opening_learning_attempts" && record(row.create_intent)) {
    const intent = { ...row.create_intent };
    delete intent.spanCourseBinding;
    return { ...row, create_intent: intent };
  }
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
