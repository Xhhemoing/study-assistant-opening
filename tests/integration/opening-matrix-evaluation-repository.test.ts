import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningLearningRepository, readOpeningObservationHistory, reviseOpeningLearningObservation } from "@aistudy/database";
import { matrixExerciseSkillLabel } from "@aistudy/domain";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
async function matrixFixture(key: "dimensions" | "addition" | "scalar" | "multiplication" = "multiplication") {
  const f = await learningAttemptFixture(fixture), service = createOpeningAttemptService(fixture.sql);
  const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], skillLabel: matrixExerciseSkillLabel(key) });
  const input = { sessionId: session.id, clientKey: randomUUID(), matrixExercise: { sourceId: f.sourceId, exerciseKey: key, variant: 0 } };
  const start = (extra = {}) => service.create(fixture.scope, { ...input, clientKey: randomUUID(), ...extra });
  const submit = (id: string, extra = {}) => service.submit(fixture.scope, id, { clientKey: randomUUID(), answer: "[[-3,0],[3,7]]",
    outcome: "unverified", verdictSource: "self_report", assistance: "independent", ...extra });
  return { ...f, session, service, input, start, submit };
}

it("creates a canonical server question and grades into the original attempt/observation transaction", async () => {
  const f = await matrixFixture(), attempt = await f.start(), record = await f.submit(attempt.id, { outcome: "incorrect" });
  expect(attempt.matrixExercise).toMatchObject({ exerciseKey: "multiplication", variant: 0 });
  expect(attempt.requirementKey).toBe("matrix:matrix-arithmetic-v1:multiplication");
  expect(record).toMatchObject({ answer: "[[-3,0],[3,7]]", outcome: "correct", verdictSource: "deterministic",
    attemptId: attempt.id, itemVersionId: attempt.itemVersionId, referenceCheck: null,
    serverEvaluation: { observationId: record.id, attemptId: attempt.id, problemId: attempt.problemId,
      itemVersionId: attempt.itemVersionId, requirementKey: attempt.requirementKey, decision: "correct", evaluatorVersion: "matrix-exact-v1" },
    eligibility: { independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown" } });
  expect(await fixture.sql`SELECT observation_id FROM opening_learning_attempts WHERE id=${attempt.id}`).toEqual([{ observation_id: record.id }]);
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id=${attempt.id}`).toHaveLength(1);
});
it("ignores self-reported correctness and abstains rather than treating unparseable work as wrong", async () => {
  const f = await matrixFixture(), wrong = await f.start(), badFormat = await f.start({ matrixExercise: { ...f.input.matrixExercise, variant: 1 } });
  expect(await f.submit(wrong.id, { answer: "[[1,2],[3,4]]", outcome: "correct" })).toMatchObject({ outcome: "incorrect", eligibility: { verifiedCorrect: "no" } });
  expect(await f.submit(badFormat.id, { answer: "A times B", outcome: "correct" })).toMatchObject({ outcome: "unverified", serverEvaluation: { decision: "abstain", reasonCodes: ["ambiguous_input"] }, eligibility: { verifiedCorrect: "unknown" } });
});
it("reuses a question across sessions, respects known feedback, and rejects a different skill attribution", async () => {
  const f = await matrixFixture(), first = await f.start(); await f.submit(first.id);
  const otherSession = await f.learning.createSession(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], skillLabel: "矩阵乘法" });
  const repeated = await f.start({ sessionId: otherSession.id });
  expect(repeated.problemId).toBe(first.problemId); expect(repeated.itemVersionId).toBe(first.itemVersionId);
  expect(await f.submit(repeated.id)).toMatchObject({ eligibility: { independentAttempt: "no", verifiedCorrect: "yes" } });
  await expect(f.start({ sessionId: f.sessionId })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(f.attempts.create(fixture.scope, { sessionId: f.sessionId, problemId: first.problemId, clientKey: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION" });
});
it("counts feedback received between the starts and submissions of overlapping attempts", async () => {
  const f = await matrixFixture(), first = await f.start(), overlapping = await f.start();
  expect(first.problemId).toBe(overlapping.problemId);
  await f.submit(first.id);
  expect(await f.submit(overlapping.id)).toMatchObject({ assistance: "hinted", eligibility: {
    independentAttempt: "no", verifiedCorrect: "yes", reasonCodes: expect.arrayContaining(["prior_evaluation_feedback"]),
  } });
});
it("cannot erase received feedback by retracting the source observation and revising a repeated answer", async () => {
  const f = await matrixFixture(), first = await f.start(), original = await f.submit(first.id);
  const repeated = await f.start(), answer = await f.submit(repeated.id);
  expect(original).toMatchObject({ verdictSource: "deterministic", serverEvaluation: { decision: "correct" },
    eligibility: { independentAttempt: "yes", verifiedCorrect: "yes" } });
  expect(answer).toMatchObject({ verdictSource: "deterministic", serverEvaluation: { decision: "correct" },
    eligibility: { independentAttempt: "no", verifiedCorrect: "yes" } });
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, { rootObservationId: original.id, revisesObservationId: original.id,
    expectedHead: original.id, clientKey: randomUUID(), revisionKind: "retract", reason: "撤回本次结果" });
  const corrected = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: answer.id, revisesObservationId: answer.id, expectedHead: answer.id, clientKey: randomUUID(), revisionKind: "replace",
    reason: "补充手动参考核对并自述独立", replacement: { answer: answer.answer, outcome: "correct", assistance: "independent",
      verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: { referenceSourceId: f.sourceId, method: "逐项对照参考计算", scope: "whole_answer" } },
  });
  expect(corrected.observation?.serverEvaluation).toBeUndefined();
  expect(corrected.observation).toMatchObject({ verdictSource: "self_report", referenceCheck: {
    referenceId: f.sourceId, checkerId: fixture.scope.ownerUserId, scope: "whole_answer",
  }, eligibility: {
    independentAttempt: "no", verifiedCorrect: "unknown", reasonCodes: expect.arrayContaining([
      "prior_evaluation_feedback", "learner_reference_compare", "verification_source_untrusted",
    ]),
  } });
});
it("recognizes the same catalogue question after changing its material association or source version", async () => {
  const f = await matrixFixture(), first = await f.start(); await f.submit(first.id);
  const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source(); await rows.chunk(sourceId);
  const anotherSession = await f.learning.createSession(fixture.scope, { courseId: f.courseId, sourceIds: [sourceId], skillLabel: "矩阵乘法" });
  const otherSource = await f.start({ sessionId: anotherSession.id, matrixExercise: { ...f.input.matrixExercise, sourceId } });
  expect(otherSource.problemId).not.toBe(first.problemId);
  expect(await f.submit(otherSource.id)).toMatchObject({ assistance: "hinted", eligibility: { independentAttempt: "no" } });
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET source_version=2 WHERE source_id=${f.sourceId}`;
  const nextVersion = await f.start();
  expect(nextVersion.itemVersionId).not.toBe(first.itemVersionId);
  expect(await f.submit(nextVersion.id)).toMatchObject({ assistance: "hinted", eligibility: { independentAttempt: "no" } });
});
it("binds source versions and refuses hidden or foreign data without creating an answer", async () => {
  const f = await matrixFixture(), attempt = await f.start();
  await expect(f.service.submit(fixture.otherScope, attempt.id, { clientKey: randomUUID(), answer: "[]", outcome: "correct", assistance: "independent" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET source_version=2 WHERE source_id=${f.sourceId}`;
  expect(await f.submit(attempt.id)).toMatchObject({ outcome: "unverified", serverEvaluation: { decision: "abstain", reasonCodes: ["version_changed"] }, eligibility: { usableForCurrentVersion: "unknown", verifiedCorrect: "unknown" } });
  const another = await f.start();
  await fixture.sql`INSERT INTO opening_privacy_exclusions(id,workspace_id,source_id) VALUES (${randomUUID()},${fixture.scope.workspaceId},${f.sourceId})`;
  await expect(f.submit(another.id)).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id=${another.id}`).toHaveLength(0);
});
it("does not allow the direct observation path to bypass automatic grading", async () => {
  const f = await matrixFixture(), attempt = await f.start();
  const record = await f.learning.insertObservation(fixture.scope, { attemptId: attempt.id, sessionId: attempt.sessionId, courseId: attempt.courseId,
    skillLabel: attempt.skillLabel, sourceIds: attempt.sourceIds, problemId: attempt.problemId, answer: "[[0]]", outcome: "correct", assistance: "independent", clientKey: randomUUID() });
  expect(record).toMatchObject({ outcome: "incorrect", verdictSource: "deterministic", serverEvaluation: { decision: "incorrect" } });
});
it("replays exact requests once, conflicts on changed answers, and serializes competing submissions", async () => {
  const f = await matrixFixture(), attempt = await f.start(), clientKey = randomUUID();
  const records = await Promise.all([f.submit(attempt.id, { clientKey }), f.submit(attempt.id, { clientKey })]);
  expect(records[0]!.id).toBe(records[1]!.id);
  await expect(f.submit(attempt.id, { clientKey, answer: "[[0]]" })).rejects.toMatchObject({ code: "CONFLICT" });
  const other = await f.start({ matrixExercise: { ...f.input.matrixExercise, variant: 1 } });
  const results = await Promise.allSettled([f.submit(other.id), f.submit(other.id, { answer: "[[0]]" })]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id=${other.id}`).toHaveLength(1);
});
it("preserves the original automatic fact while a dispute creates an unverified effective head", async () => {
  const f = await matrixFixture(), attempt = await f.start(), original = await f.submit(attempt.id);
  const operation = { rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    clientKey: randomUUID(), revisionKind: "replace" as const, reason: "自动评价有异议", replacement: {
      answer: original.answer, outcome: "unverified" as const, assistance: original.assistance, verdictSource: "self_report" as const } };
  const revised = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, operation);
  expect(revised.observation?.serverEvaluation).toBeUndefined();
  expect(revised.observation).toMatchObject({ outcome: "unverified", eligibility: { verifiedCorrect: "unknown" } });
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id);
  expect(history.headObservationId).toBe(revised.headObservationId);
  expect(history.revisions.find(row => row.id === original.id)?.serverEvaluation).toMatchObject({ decision: "correct" });
  await expect(reviseOpeningLearningObservation(fixture.sql, fixture.scope, { ...operation, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
});

function failAfterObservation(sql: Sql): Sql {
  return new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => work(new Proxy(tx, {
      apply(query, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        if (args[0].join("?").includes("UPDATE opening_learning_attempts SET submitted_at")) throw new Error("injected attempt-link failure");
        return Reflect.apply(query, thisArg, args);
      },
    })));
  } });
}
it("rolls back the answer, automatic verdict and history watermark together when linking fails", async () => {
  const f = await matrixFixture(), attempt = await f.start();
  const before = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  await expect(createOpeningLearningRepository(failAfterObservation(fixture.sql)).insertObservation(fixture.scope, {
    attemptId: attempt.id, sessionId: attempt.sessionId, courseId: attempt.courseId, skillLabel: attempt.skillLabel, sourceIds: attempt.sourceIds,
    problemId: attempt.problemId, answer: "[[-3,0],[3,7]]", outcome: "unverified", assistance: "independent", clientKey: randomUUID(),
  })).rejects.toThrow("injected attempt-link failure");
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id=${attempt.id}`).toHaveLength(0);
  expect(await fixture.sql`SELECT submitted_at,observation_id FROM opening_learning_attempts WHERE id=${attempt.id}`).toEqual([{ submitted_at: null, observation_id: null }]);
  expect(await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`).toEqual(before);
});
