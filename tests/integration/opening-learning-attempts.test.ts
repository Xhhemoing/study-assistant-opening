import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningLearningEvidenceContext } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { nextLearningHistoryRevision } from "../../packages/database/src/repositories/opening-learning-facts";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

it("captures server identity and preserves it when the mutable problem/source later changes", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  expect(attempt.id).toBeTruthy(); expect(attempt.problemId).toBeTruthy(); expect(attempt.itemVersionId).toBeTruthy();
  expect(attempt.sourceVersions).toEqual({ [f.sourceId]: 1 });
  const observation = await f.submit(attempt);
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_problem_refs SET source_version=2,stem_snapshot='changed question' WHERE problem_id=${attempt.problemId!}`;
  const context = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, observation);
  expect(context.observation.itemVersionId).toBe(attempt.itemVersionId);
  expect(context.context.version?.applicability).toBe("changed_needs_check");
  const [row] = await fixture.sql`SELECT source_versions,item_version_id FROM opening_learning_observations WHERE id=${observation.id}`;
  expect(row?.source_versions).toEqual({ [f.sourceId]: 1 });
  expect(row?.item_version_id).toBe(attempt.itemVersionId);
});

it("does not let help for problem A pollute an unrelated attempt B in the same session", async () => {
  const f = await learningAttemptFixture(fixture), a = await f.start(), b = await f.start();
  const help = await f.help(a);
  expect(help.attemptId).toBe(a.id); expect(help.problemId).toBe(a.problemId); expect(help.deliveredAt).toBeTruthy();
  expect((await f.submit(a)).eligibility.independentAttempt).toBe("no");
  const other = await f.submit(b);
  expect(other.eligibility.independentAttempt).toBe("yes");
  expect(other.eligibility.verifiedCorrect).toBe("unknown");
});

it("retains historical same-problem answer exposure across new attempts", async () => {
  const f = await learningAttemptFixture(fixture), first = await f.start();
  await f.help(first, "revealed");
  const second = await f.attempts.create(fixture.scope, { sessionId: f.sessionId, problemId: first.problemId, clientKey: randomUUID() });
  const result = await f.submit(second);
  expect(result.eligibility.reasonCodes).toContain("prior_answer_exposure");
  expect(result.eligibility.usableForDelayedCheck).not.toBe("yes");
});

it("records help after submission without retroactively marking it as pre-submit help", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start(), record = await f.submit(attempt);
  const delivered = await f.help(attempt);
  expect(Date.parse(delivered.deliveredAt!)).toBeGreaterThanOrEqual(Date.parse(record.submittedAt!));
  const facts = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, record);
  expect(evaluateEvidenceEligibility(facts.observation, facts.context).independentAttempt).toBe("yes");
});

it("keeps public reference comparisons as self-reports and unlinked ordinary observations unknown", async () => {
  const f = await learningAttemptFixture(fixture);
  const labelOnly = await f.submit(await f.start(), { verdictSource: "reference_checked", referenceSourceId: f.sourceId });
  expect(labelOnly.eligibility.verifiedCorrect).toBe("unknown");
  const attempt = await f.start();
  const compare = { clientKey: randomUUID(), verdictSource: "reference_checked", referenceSourceId: f.sourceId,
    referenceCheck: { referenceSourceId: f.sourceId, method: "Compared each step against the reference solution", scope: "whole_answer" } };
  const checked = await f.submit(attempt, compare);
  expect(checked.verdictSource).toBe("self_report");
  expect(checked.eligibility.verifiedCorrect).toBe("unknown");
  expect(checked.eligibility.reasonCodes).toContain("learner_reference_compare");
  expect(checked.allowsIndependent).toBe(false);
  expect(checked.referenceCheck?.checkerId).toBe(fixture.scope.ownerUserId);
  expect((await f.submit(attempt, compare)).id).toBe(checked.id);
  const [stored] = await fixture.sql`SELECT verdict_source,submitted_intent->>'verdictSource' AS requested_source
    FROM opening_learning_observations WHERE id=${checked.id}`;
  expect(stored).toEqual({ verdict_source: "self_report", requested_source: "reference_checked" });
  const legacy = await f.learning.insertObservation(fixture.scope, { sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  expect(legacy.itemVersionId).toBeNull(); expect(legacy.attemptId).toBeNull();
  expect(legacy.eligibility.independentAttempt).toBe("unknown"); expect(legacy.allowsIndependent).toBe(false);
});

it("replays exact requests without advancing the committed revision and conflicts on different intent", async () => {
  const f = await learningAttemptFixture(fixture), key = randomUUID();
  const first = await f.start({ clientKey: key }), replay = await f.start({ clientKey: key });
  expect(replay.id).toBe(first.id);
  const submitKey = randomUUID(), record = await f.submit(first, { clientKey: submitKey });
  expect((await f.submit(first, { clientKey: submitKey })).id).toBe(record.id);
  await expect(f.submit(first, { clientKey: submitKey, answer: "changed" })).rejects.toMatchObject({ code: "CONFLICT" });
  const [revision] = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  expect(Number(revision?.revision)).toBe(2);
  await expect(fixture.sql.begin(async (tx) => { await nextLearningHistoryRevision(tx, fixture.scope, f.courseId); throw new Error("rollback"); })).rejects.toThrow("rollback");
  const [after] = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  expect(Number(after?.revision)).toBe(2);
});

it("serializes concurrent fact commits into a contiguous course revision", async () => {
  const f = await learningAttemptFixture(fixture);
  const attempts = await Promise.all(Array.from({ length: 6 }, () => f.start()));
  expect(attempts.map(attempt => attempt.historyRevision).sort((a,b) => a-b)).toEqual([1,2,3,4,5,6]);
  const [revision] = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  expect(Number(revision?.revision)).toBe(6);
  expect(await fixture.sql`SELECT id FROM opening_learning_attempts WHERE course_id=${f.courseId}`).toHaveLength(6);
});
