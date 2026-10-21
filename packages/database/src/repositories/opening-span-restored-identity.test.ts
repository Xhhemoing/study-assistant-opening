import { expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import { getSpanProblem, spanProblemStem, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { mapLearningAttempt } from "./opening-learning-attempts";
import { readOpeningSpanExposureHistory } from "./opening-span-attempt";
import { evaluateOpeningSpanAttempt } from "./opening-span-evaluation";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const scope = { workspaceId: id, ownerUserId: id };
const problem = getSpanProblem("span-example-2d")!;
const intent = { spanExercise: { sourceId: id, problemId: problem.id, version: 1 }, spanValidation: { eligible: true, firstFamilyExposure: true, reasonCode: null } };
const restored = { id, workspace_id: id, session_id: id, course_id: id, skill_label: "线性组合与 span", requirement_key: SPAN_REQUIREMENT_KEY,
  problem_id: id, item_version_id: id, source_ids: [id], source_versions: { [id]: 1 }, started_at: new Date("2026-10-21T00:00:00Z"),
  submitted_at: null, observation_id: null, history_revision: 1, evaluation_spec: null, create_intent: intent,
  item_stem_snapshot: spanProblemStem(problem), item_source_id: id };

it("restores only canonical display identity while overriding imported positive eligibility", () => {
  const attempt = mapLearningAttempt(restored);
  expect(attempt.spanExercise).toEqual(problem);
  expect(attempt.spanValidation).toEqual({ eligible: false, firstFamilyExposure: false, reasonCode: "restored_identity_unverified" });
  expect(attempt.id).toBe(id); expect(attempt.submittedAt).toBeNull();
  expect(restored.evaluation_spec).toBeNull(); expect(intent.spanValidation.eligible).toBe(true);
});

it.each([{ item_stem_snapshot: "different question" }, { item_source_id: other }, { create_intent: { spanExercise: { sourceId: id, problemId: "missing-old-id", version: 1 } } }])("does not silently replace an unrecognized restored question: %j", change => {
  const attempt = mapLearningAttempt({ ...restored, ...change });
  expect(attempt.spanExercise).toBeUndefined();
  expect(attempt.spanValidation).toMatchObject({ eligible: false, reasonCode: "restored_identity_unavailable" });
});

it("retains imported issued identities as negative history even when scoring authority was stripped", async () => {
  const tx = (async () => [{ create_intent: intent, requirement_key: SPAN_REQUIREMENT_KEY, evaluation_spec: null }]) as unknown as TransactionSql;
  const history = await readOpeningSpanExposureHistory(tx, scope);
  expect([...history.problemIds]).toEqual([problem.id]); expect([...history.familyIds]).toEqual([problem.familyId]);
  expect([...history.uncertainProblemIds]).toEqual([problem.id]); expect(history.unknownHistory).toBe(false);
});

it("retains an unknown-history restriction instead of declaring an absent old identity unseen", async () => {
  const tx = (async () => [{ create_intent: { spanExercise: { sourceId: id, problemId: "span-reserved-parallel-q01", version: 1 } }, requirement_key: SPAN_REQUIREMENT_KEY, evaluation_spec: null }]) as unknown as TransactionSql;
  expect((await readOpeningSpanExposureHistory(tx, scope)).unknownHistory).toBe(true);
});

it("keeps a newly reissued canonical answer assisted after importing the same old question", async () => {
  const spec = { kind: "span", specVersion: "span-v1", problemId: problem.id, version: 1 };
  let calls = 0;
  const tx = Object.assign(async () => {
    calls += 1;
    if (calls === 1) return [{ evaluation_spec: spec, source_id: id, source_version: 1, stem_snapshot: spanProblemStem(problem), current_stem: spanProblemStem(problem), current_source_version: 1 }];
    if (calls === 2) return []; // No imported automatic verdict survives restoration.
    return [{ evaluation_spec: null, create_intent: intent, requirement_key: SPAN_REQUIREMENT_KEY }];
  }, { json: (value: unknown) => value }) as unknown as TransactionSql;
  const result = await evaluateOpeningSpanAttempt(tx, scope, { ...restored, id: other }, JSON.stringify({ membership: "in_span", coefficients: ["3", "-1/2"],
    equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] }), [{ id, version: 1 }]);
  expect(result).toMatchObject({ decision: "correct", priorFeedback: true });
});

it("never reconstructs the stripped evaluator for a pending restored answer", async () => {
  const tx = (async () => [{ evaluation_spec: null }]) as unknown as TransactionSql;
  expect(await evaluateOpeningSpanAttempt(tx, scope, restored, "{}", [{ id, version: 1 }]))
    .toMatchObject({ decision: "abstain", outcome: "unverified", reasonCodes: ["missing_or_unsupported_spec"] });
});
