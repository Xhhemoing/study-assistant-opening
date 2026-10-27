import { expect, it } from "vitest";
import { normalizeOpeningImportedEvaluation } from "./opening-backup-evaluation";
it.each(["original", "correct", "retract"])("strips claimed automatic authority from every imported %s row", revision_kind => {
  const original = { revision_kind, verdict_source: "deterministic", outcome: "correct", evidence_verdict: "LEARNING_EFFECT_OBSERVED",
    answer: "[[1,2]]", server_evaluation: { decision: "correct", evaluatorVersion: "matrix-exact-v1" }, history_revision: 7 };
  expect(normalizeOpeningImportedEvaluation("opening_learning_observations", original)).toEqual({ ...original,
    server_evaluation: null, verdict_source: "unknown", outcome: "unverified", evidence_verdict: "MASTERY_NOT_ESTABLISHED" });
  expect(original.verdict_source).toBe("deterministic");
});
it("cannot smuggle a proof under a different verdict source", () => {
  expect(normalizeOpeningImportedEvaluation("opening_learning_observations", { verdict_source: "reference_checked", outcome: "correct", server_evaluation: {} }))
    .toMatchObject({ verdict_source: "unknown", outcome: "unverified", server_evaluation: null });
});
it("preserves historical manual facts and clears imported item specifications", () => {
  const manual = { verdict_source: "self_report", outcome: "correct", server_evaluation: null };
  expect(normalizeOpeningImportedEvaluation("opening_learning_observations", manual)).toEqual(manual);
  expect(normalizeOpeningImportedEvaluation("opening_learning_item_versions", { id: "v1", evaluation_spec: { operation: "product" } }))
    .toEqual({ id: "v1", evaluation_spec: null });
});
it.each(["ai_graded", "self_report"])("does not restore AI scoring authority under %s", verdict_source => {
  const row = { verdict_source, outcome: "correct", answer: "my original answer", ai_evaluation: { outcome: "correct", confidence: 0.99 } };
  expect(normalizeOpeningImportedEvaluation("opening_learning_observations", row)).toEqual({ ...row,
    verdict_source: "unknown", outcome: "unverified", ai_evaluation: null, server_evaluation: null, evidence_verdict: "MASTERY_NOT_ESTABLISHED" });
});
it("retains imported classroom identity without inventing access to its original revision", () => {
  const row = { id: "item", source_id: null, source_version: null, teaching_revision_id: "revision", teaching_block_id: "block",
    stem_snapshot: "Original question", evaluation_spec: { kind: "teaching_question", revisionId: "revision", blockId: "block" } };
  expect(normalizeOpeningImportedEvaluation("opening_learning_item_versions", row)).toEqual({ ...row, evaluation_spec: null });
});
it("restores learning history without restoring tutor consent or cancellation ownership", () => {
  const consent = { enabled: true, dailyMinutes: 30, revision: 2 };
  const prefs = { adaptive_planning: { autonomy: "manual", spanTutorGrants: { course: consent } } };
  expect(normalizeOpeningImportedEvaluation("workspace_preferences", prefs)).toEqual({ adaptive_planning: { autonomy: "manual", spanTutorGrants: { course: { ...consent, enabled: false } } } });
  const row = { learning_protocol: { protocolId: "span-delayed-3d-v1", tutorAutomation: { createdTaskVersion: 1 } } };
  expect(normalizeOpeningImportedEvaluation("opening_retest_activities", row)).toEqual({ learning_protocol: { protocolId: "span-delayed-3d-v1" } });
  expect(consent.enabled).toBe(true);
  expect(row.learning_protocol).toHaveProperty("tutorAutomation");
});
