import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningAiGradingRepository, listObservationHeadsByActivity, reviseOpeningLearningObservation } from "@aistudy/database";
import { deriveOpenProblems } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
const proposal = { outcome: "correct" as const, questionMatch: true, confidence: 0.93, feedback: "结果为1。",
  criteria: [{ label: "分数相加", verdict: "correct" as const, feedback: "分子相加。" }] };

async function seed() {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const original = await f.submit(attempt, { answer: "1", outcome: "unverified" });
  const grader = createOpeningAiGradingRepository(fixture.sql);
  const graded = await grader.apply(fixture.scope, { observationId: original.id }, proposal, "fixture");
  const [row] = await fixture.sql`SELECT activity_id FROM opening_learning_sessions WHERE id=${f.sessionId}`;
  const activityId = String(row!.activity_id);
  const heads = () => listObservationHeadsByActivity(fixture.sql, fixture.scope, activityId);
  return { ...f, attempt, original, graded, grader, activityId, heads };
}

it("resumes AI-only evidence as unverified, and a lost response replay preserves feedback without an additional score or scan", async () => {
  const f = await seed(), heads = await f.heads();
  expect(heads).toEqual([{ problemId: f.original.problemId, itemVersionId: f.original.itemVersionId, outcome: "unverified" }]);
  expect(deriveOpenProblems({ attempts: [], observationHeads: heads, checkpointOpenProblemIds: [f.original.problemId!] })).toEqual([
    { problemId: f.original.problemId, itemVersionId: f.original.itemVersionId, reason: "unverified_unresolved" },
  ]);
  expect((await f.grader.apply(fixture.scope, { observationId: f.original.id }, proposal, "fixture")).id).toBe(f.graded.id);
  const [stored] = await fixture.sql`SELECT outcome, to_jsonb(o) AS fact FROM opening_learning_observations o WHERE id=${f.graded.id}`;
  expect(stored!.outcome).toBe("correct");
  expect(JSON.stringify(stored!.fact)).toContain(proposal.feedback);
  expect(JSON.stringify(stored!.fact)).toContain(proposal.criteria[0]!.feedback);
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE COALESCE(root_observation_id,id)=${f.original.id}`).toHaveLength(2);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE key=${`retest-scan:${f.courseId}:${f.graded.id}`}`).toHaveLength(1);
  expect(await listObservationHeadsByActivity(fixture.sql, fixture.otherScope, f.activityId)).toEqual([]);
});

it("resumes a manual correction as unverified and rejects the earlier delayed grading response", async () => {
  const f = await seed();
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: f.original.id, revisesObservationId: f.graded.id, expectedHead: f.graded.id,
    revisionKind: "replace", reason: "修正答案", clientKey: randomUUID(),
    replacement: { answer: "2", outcome: "incorrect", assistance: "independent" },
  });
  expect(await f.heads()).toEqual([{ problemId: f.original.problemId, itemVersionId: f.original.itemVersionId, outcome: "unverified" }]);
  await expect(f.grader.apply(fixture.scope, { observationId: f.original.id }, proposal, "fixture")).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await f.heads())[0]!.outcome).toBe("unverified");
});

it("does not restore correctness from outdated, excluded or retracted evidence", async () => {
  const f = await seed();
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  expect((await f.heads())[0]!.outcome).toBe("unverified");
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${f.sourceId}`;
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${f.sourceId})`;
  expect(await f.heads()).toEqual([]);
  const another = await seed();
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: another.original.id, revisesObservationId: another.graded.id, expectedHead: another.graded.id,
    revisionKind: "retract", reason: "撤回", clientKey: randomUUID(),
  });
  expect(await another.heads()).toEqual([]);
});
