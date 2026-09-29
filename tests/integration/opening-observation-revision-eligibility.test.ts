import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { LearningObservation, ObservationRevisionInput } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningLearningEvidenceContext } from "@aistudy/database";
import { reviseOpeningLearningObservation, readOpeningObservationHistory } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
type Replacement = Extract<ObservationRevisionInput, { revisionKind: "replace" }>["replacement"];
async function replace(previous: LearningObservation, extra: Partial<Replacement> = {}) {
  const result = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: previous.rootObservationId ?? previous.id, revisesObservationId: previous.id, expectedHead: previous.id,
    revisionKind: "replace", reason: "Correct the recorded observation", clientKey: randomUUID(),
    replacement: { answer: previous.answer, outcome: previous.outcome, assistance: previous.assistance, ...extra },
  });
  return result.observation!;
}
const referenceCheck = (sourceId: string) => ({ referenceSourceId: sourceId, method: "Compare the whole answer against the reference", scope: "whole_answer" as const });
const capturedFacts = (record: LearningObservation) => ({
  attemptId: record.attemptId, problemId: record.problemId, itemVersionId: record.itemVersionId,
  startedAt: record.startedAt, submittedAt: record.submittedAt, occurredAt: record.occurredAt, sourceVersions: record.sourceVersions,
});

it.each(["hinted", "revealed"] as const)("does not qualify an answer corrected after delivered %s help as independent", async level => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const original = await f.submit(attempt, { answer: "2", outcome: "incorrect" });
  const delivered = await f.help(attempt, level);
  const corrected = await replace(original, { answer: "1", outcome: "correct", referenceCheck: referenceCheck(f.sourceId) });
  expect(Date.parse(delivered.deliveredAt!)).toBeGreaterThan(Date.parse(original.submittedAt!));
  expect(Date.parse(corrected.recordedAt!)).toBeGreaterThan(Date.parse(delivered.deliveredAt!));
  expect(corrected).toMatchObject(capturedFacts(original));
  expect(corrected.eligibility).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "no" });
  expect(corrected.eligibility?.reasonCodes).toContain("help_before_submission");
  expect(await fixture.sql`SELECT id FROM opening_learning_attempts WHERE session_id=${f.sessionId}`).toHaveLength(1);
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id);
  expect(history.revisions[0]?.eligibility?.independentAttempt).toBe("yes");
  expect(history.revisions[1]?.eligibility?.independentAttempt).toBe("no");
});

it("keeps original answer qualification and captured sources when attribution moves after feedback", async () => {
  const f = await learningAttemptFixture(fixture), destination = await learningAttemptFixture(fixture), attempt = await f.start();
  const original = await f.submit(attempt, { referenceCheck: referenceCheck(f.sourceId), verdictSource: "reference_checked", referenceSourceId: f.sourceId });
  await f.help(attempt, "revealed");
  const moved = await replace(original, { courseId: destination.courseId, skillLabel: "renamed skill", requirementKey: "new-requirement" });
  expect(moved).toMatchObject({ ...capturedFacts(original), courseId: destination.courseId, referenceCheck: original.referenceCheck });
  expect(moved.eligibility).toEqual(original.eligibility);
  expect(moved.eligibility).toMatchObject({ usableForDelayedCheck: "unknown" });
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await backupRows(fixture.sql, fixture.scope).chunk(f.sourceId, 2);
  const relabeled = await replace(moved, { skillLabel: "corrected label" });
  const facts = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, relabeled);
  expect(relabeled).toMatchObject(capturedFacts(original));
  expect(facts.context.version?.applicability).toBe("changed_needs_check");
  expect(relabeled.eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "unknown" });
  expect(await fixture.sql`SELECT id FROM opening_learning_attempts WHERE session_id=${f.sessionId}`).toHaveLength(1);
});

it("does not treat an outcome or reference-check correction as a new answer", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const original = await f.submit(attempt, { outcome: "unverified" });
  await f.help(attempt, "revealed");
  const checked = await replace(original, { outcome: "correct", referenceCheck: referenceCheck(f.sourceId) });
  expect(checked.answer).toBe(original.answer);
  expect(checked).toMatchObject(capturedFacts(original));
  expect(checked.eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes" });
  const facts = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, checked);
  expect(facts.observation.submittedAt).toBe(Date.parse(original.submittedAt!));
});

it("uses only the latest answer change in the requested version's ancestry, even across attribution changes", async () => {
  const f = await learningAttemptFixture(fixture), destination = await learningAttemptFixture(fixture), attempt = await f.start();
  const original = await f.submit(attempt, { answer: "2", outcome: "incorrect" });
  const firstAnswer = await replace(original, { answer: "1", outcome: "correct", referenceCheck: referenceCheck(f.sourceId) });
  await f.help(attempt, "hinted");
  const moved = await replace(firstAnswer, { courseId: destination.courseId });
  expect(moved.eligibility?.independentAttempt).toBe("yes");
  const checked = await replace(moved, { referenceCheck: referenceCheck(f.sourceId) });
  expect(checked.eligibility?.independentAttempt).toBe("yes");
  const newAnswer = await replace(checked, { answer: "1.0", referenceCheck: referenceCheck(f.sourceId) });
  expect(newAnswer.eligibility?.independentAttempt).toBe("no");
  const metadata = await replace(newAnswer, { skillLabel: "corrected label" });
  expect(metadata.eligibility?.independentAttempt).toBe("no");
  const restoredText = await replace(metadata, { answer: original.answer, outcome: original.outcome });
  expect(restoredText.eligibility?.independentAttempt).toBe("no");
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id);
  expect(history.revisions.map(record => record.eligibility?.independentAttempt)).toEqual(["yes", "yes", "yes", "yes", "no", "no", "no"]);
  for (const record of history.revisions) expect(record).toMatchObject(capturedFacts(original));
  const facts = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, moved);
  expect(facts.observation.submittedAt).toBe(Date.parse(original.submittedAt!));
  expect(facts.context.helpHistory?.answerRecordedAt).toBe(Date.parse(firstAnswer.recordedAt!));
  expect(evaluateEvidenceEligibility(facts.observation, facts.context).independentAttempt).toBe("yes");
});
