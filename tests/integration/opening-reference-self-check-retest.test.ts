import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningRetestActivityRepository } from "@aistudy/database";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { readOpeningLearningEvidenceContext } from "@aistudy/database";
import { evaluateEvidenceEligibility } from "@aistudy/domain";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations,opening_retest_activities CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

it("updates opening_retest_activities.result after self-compare revision", async () => {
  const f = await learningAttemptFixture(fixture);
  const candidateId = randomUUID(), taskId = randomUUID(), activityId = randomUUID();
  await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch)
    VALUES (${candidateId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${`retest:${candidateId}`}, 'retest',
      ${fixture.sql.json({ id: candidateId, kind: "task", courseId: f.courseId, skillLabel: "fractions", prompt: "Retry", sourceIds: [], dueAt: "2026-09-29T10:00:00.000Z", accepted: false } as never)}, 'succeeded', 0)`;
  await fixture.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version, candidate_id)
    VALUES (${taskId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, 'Retest', 20, NULL, 1, 'pending', 1, ${candidateId})`;
  const activities = createOpeningRetestActivityRepository(fixture.sql);
  await activities.createProposed(fixture.scope, {
    activityId, cycleId: candidateId, candidateId, taskId, courseId: f.courseId, skillLabel: "fractions",
    proposedAt: "2026-09-29T09:00:00.000Z", recommendedAt: "2026-09-29T10:00:00.000Z",
  });
  await activities.accept(fixture.scope, activityId, taskId, "2026-09-29T09:30:00.000Z");

  const attempt = await f.start();
  const original = await f.submit(attempt, { outcome: "unverified", retestId: activityId });
  const [before] = await fixture.sql`SELECT status, result FROM opening_retest_activities WHERE id=${activityId}`;
  expect(before).toEqual({ status: "completed", result: "unverified" });

  const revised = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace", reason: "对照参考核对", clientKey: randomUUID(),
    replacement: {
      answer: original.answer, outcome: "correct", assistance: "independent",
      verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: { referenceSourceId: f.sourceId, method: "learner_self_compare 第1页", scope: "whole_answer" },
    },
  });
  expect(revised.observation?.eligibility?.verifiedCorrect).toBe("yes");
  const [after] = await fixture.sql`SELECT status, result FROM opening_retest_activities WHERE id=${activityId}`;
  expect(after).toEqual({ status: "completed", result: "correct" });
});

it("treats a later attempt on the same problem after reference check as prior revealed", async () => {
  const f = await learningAttemptFixture(fixture);
  const firstAttempt = await f.start();
  const first = await f.submit(firstAttempt, {
    outcome: "correct", verdictSource: "reference_checked", referenceSourceId: f.sourceId,
    referenceCheck: { referenceSourceId: f.sourceId, method: "learner_self_compare", scope: "whole_answer" },
  });
  expect(first.eligibility.verifiedCorrect).toBe("yes");

  const secondAttempt = await f.attempts.create(fixture.scope, {
    sessionId: f.sessionId, clientKey: randomUUID(), problemId: firstAttempt.problemId!,
  });
  const second = await f.submit(secondAttempt, { outcome: "correct", verdictSource: "reference_checked", referenceSourceId: f.sourceId,
    referenceCheck: { referenceSourceId: f.sourceId, method: "learner_self_compare", scope: "whole_answer" } });
  const facts = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, second);
  expect(facts.context.helpHistory?.exposures.some(row =>
    row.level === "revealed" && row.delivered === true && row.attemptId === first.attemptId && row.problemId === first.problemId,
  )).toBe(true);
  const eligibility = evaluateEvidenceEligibility(facts.observation, {
    ...facts.context,
    delayedCheck: {
      protocolId: "protocol-1",
      attemptId: second.attemptId!,
      earliestAt: Date.parse(second.startedAt!) - 1,
      priorAnswerPolicy: "require_unseen_problem",
    },
  });
  expect(eligibility.reasonCodes).toContain("prior_answer_exposure");
  expect(eligibility.independentAttempt).toBe("yes");
  expect(eligibility.usableForDelayedCheck).toBe("no");
});
