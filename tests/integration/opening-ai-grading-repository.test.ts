import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { AiGradingInput, AiGradingProposal, LearningObservation } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningAiGradingJobRepository, readOpeningBackupRecords, readOpeningCourseEvidence } from "@aistudy/database";
import { normalizeOpeningImportedEvaluation } from "../../packages/database/src/repositories/opening-backup-evaluation";
import { nextLearningStep } from "@aistudy/domain";
import { reviseOpeningLearningObservation, readOpeningObservationHistory } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
const proposal = (outcome: "correct" | "incorrect" = "correct"): AiGradingProposal => ({
  outcome, questionMatch: true, confidence: 0.93, feedback: outcome === "correct" ? "分母相同，分子相加，结果为1。" : "同分母相加时只加分子。",
  criteria: [{ label: "同分母分数相加", verdict: outcome, feedback: "核对分子相加与约分。" }],
});
const repository = () => createOpeningAiGradingRepository(fixture.sql);
const grade = (observation: LearningObservation, result = proposal(), extra: Partial<AiGradingInput> = {}) =>
  repository().apply(fixture.scope, { observationId: observation.id, ...extra }, result, "test-grader");
const correct = (original: LearningObservation, head: LearningObservation, answer = head.answer) => reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
  rootObservationId: original.rootObservationId ?? original.id, revisesObservationId: head.id, expectedHead: head.id,
  revisionKind: "replace", reason: "AI判错了", clientKey: randomUUID(), replacement: { answer, outcome: "incorrect", assistance: head.assistance },
});

it("appends an AI assessment for a free answer without changing the original, including nullable requirement", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { outcome: "unverified", referenceSourceId: f.sourceId });
  const [before] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${original.id}`;
  const context = await repository().context(fixture.scope, { observationId: original.id });
  expect(context).toMatchObject({ stem: "1/2 + 1/2?", referenceText: "source evidence", existing: null });
  const graded = await grade(original);
  expect(graded).toMatchObject({ rootObservationId: original.id, revisesObservationId: original.id, answer: "1", verdictSource: "ai_graded",
    outcome: "correct", referenceSourceId: f.sourceId, aiEvaluation: { observationId: graded.id, attemptId: original.attemptId, requirementKey: null, modelLabel: "test-grader" },
    eligibility: { verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes" } });
  const [after] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${original.id}`;
  expect({ ...after, effective_head_id: before!.effective_head_id }).toEqual(before);
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations.map(row => row.id)).toEqual([graded.id]);
  const [scan] = await fixture.sql`SELECT id FROM opening_jobs WHERE key=${`retest-scan:${f.courseId}:${graded.id}`}`;
  expect(scan).toBeDefined();
});

it("ten own-material answers become effective results and errors select targeted explanation", async () => {
  const f = await learningAttemptFixture(fixture);
  for (let i = 0; i < 10; i++) {
    const incorrect = i % 2 === 1;
    const original = await f.submit(await f.start(), { outcome: "unverified", answer: incorrect ? "2" : "1" });
    const graded = await grade(original, proposal(incorrect ? "incorrect" : "correct"));
    expect(graded.eligibility?.verifiedCorrect).toBe(incorrect ? "no" : "yes");
    if (incorrect) expect(nextLearningStep({ wantsFullExplanation: false, status: "needs_check", observations: [{
      id: graded.id, skillLabel: graded.skillLabel, attemptedAt: graded.submittedAt ?? graded.occurredAt,
      problemId: graded.problemId ?? null, independentAttempt: graded.eligibility!.independentAttempt,
      assistance: graded.assistance, verifiedCorrect: graded.eligibility!.verifiedCorrect,
      usableForCurrentVersion: graded.eligibility!.usableForCurrentVersion,
    }] }).activityKind).toBe("targeted_explain");
  }
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations).toHaveLength(10);
});

it.each([
  { confidence: 0.79 }, { questionMatch: false }, { outcome: "unverified" as const },
  { criteria: [{ label: "缺少步骤", verdict: "unverified" as const, feedback: "无法确认过程" }] },
])("retains uncertain feedback without making a binary outcome: %j", async patch => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const graded = await grade(original, { ...proposal(), ...patch });
  expect(graded).toMatchObject({ outcome: "unverified", aiEvaluation: { outcome: "unverified" }, eligibility: { verifiedCorrect: "unknown" } });
});

it("keeps hinted work assisted, and earlier AI feedback stays exposure after a user correction", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  await f.help(attempt);
  const original = await f.submit(attempt), graded = await grade(original);
  expect(graded.eligibility).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "no" });
  const corrected = await correct(original, graded);
  expect(corrected.observation).toMatchObject({ verdictSource: "self_report", eligibility: { verifiedCorrect: "unknown" } });
  expect(corrected.observation?.aiEvaluation).toBeUndefined();
  const repeated = await f.start({ problem: undefined, problemId: original.problemId });
  const repeatedAnswer = await f.submit(repeated);
  expect(repeatedAnswer.eligibility.independentAttempt).toBe("no");
  expect(repeatedAnswer.eligibility.reasonCodes).toContain("prior_evaluation_feedback");
});

it("replays the same grade once, while concurrent user corrections cannot be overwritten", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const [a, b] = await Promise.all([grade(original), grade(original)]);
  expect(a.id).toBe(b.id);
  expect((await repository().context(fixture.scope, { observationId: original.id })).existing?.id).toBe(a.id);
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id);
  expect(history.revisions).toHaveLength(2);
  const another = await f.submit(await f.start());
  await repository().context(fixture.scope, { observationId: another.id });
  const userRevision = await correct(another, another, "重新检查后的答案");
  await expect(grade(another)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await readOpeningObservationHistory(fixture.sql, fixture.scope, another.id)).headObservationId).toBe(userRevision.headObservationId);
});

it.each([
  { answer: "2/2", model: "incorrect" as const },
  { answer: "2", model: "correct" as const },
  { answer: "1/2+1/2=2/4=1", model: "correct" as const },
])("abstains on arithmetic disagreement without error cards or extra retest scans: %j", async ({ answer, model }) => {
  const f = await learningAttemptFixture(fixture);
  const original = await f.submit(await f.start(), { answer, outcome: "unverified" });
  const graded = await grade(original, proposal(model));
  expect(graded).toMatchObject({ outcome: "unverified", answer, eligibility: { verifiedCorrect: "unknown" },
    aiEvaluation: { outcome: "unverified", misconceptionId: null } });
  expect(graded.aiEvaluation?.feedback).toContain("程序验算");
  const evidence = await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId);
  expect(evidence.observations.map(row => row.id)).toEqual([graded.id]);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE key=${`retest-scan:${f.courseId}:${graded.id}`}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id}`).toHaveLength(0);
  expect((await grade(original, proposal(model))).id).toBe(graded.id);
  expect((await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id)).revisions).toHaveLength(2);
});

it("rejects other owners, stale material versions and privacy exclusions before grading or writing", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  await expect(repository().context(fixture.otherScope, { observationId: original.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await repository().context(fixture.scope, { observationId: original.id });
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await expect(grade(original)).rejects.toMatchObject({ code: "CONFLICT" });
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${f.sourceId}`;
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${f.sourceId})`;
  await expect(grade(original)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("binds an owned photo to the evaluation, keeps its transcription separate and excludes it from independent credit", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { answer: "", outcome: "unverified" });
  const rows = backupRows(fixture.sql, fixture.scope), photoId = await rows.source();
  await fixture.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const input = { workSourceId: photoId, workSourceVersion: 1, physicalPage: 1 };
  const graded = await grade(original, { ...proposal(), transcription: "1/2 + 1/2 = 1" }, input);
  expect(graded).toMatchObject({ answer: "", assistance: "unknown", aiEvaluation: { transcription: "1/2 + 1/2 = 1", workSource: { id: photoId, version: 1, physicalPage: 1 } },
    eligibility: { verifiedCorrect: "yes", independentAttempt: "unknown" } });
  expect(graded.sourceIds).toContain(photoId);
  expect(graded.sourceVersions?.[photoId]).toBe(1);
  const identity = { id: photoId, version: 1, physicalPage: 1 };
  expect(graded.aiEvaluation?.workSource).toEqual(identity);
  const jobs = createOpeningAiGradingJobRepository(fixture.sql);
  expect((await jobs.read(fixture.scope, { observationId: original.id })).workSource).toEqual(identity);
  const corrected = await correct(original, graded);
  expect(corrected.observation?.verdictSource).toBe("self_report");
  expect((await jobs.read(fixture.scope, { observationId: original.id })).workSource).toEqual(identity);
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id);
  expect(history.revisions.find(row => row.id === graded.id)?.aiEvaluation?.workSource).toEqual(identity);
  const backup = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  for (const id of [graded.id, corrected.observation!.id]) {
    expect(backup.tables.opening_learning_observations.find(row => row.id === id)?.grading_work_source).toEqual(identity);
  }
  await expect(repository().context(fixture.scope, { observationId: original.id, ...input })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repository().context(fixture.scope, { observationId: original.id })).rejects.toMatchObject({ code: "CONFLICT" });
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${photoId})`;
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations).toHaveLength(0);
});

it("removes imported AI correctness but retains the earlier feedback exposure", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start()), graded = await grade(original);
  const [row] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${graded.id}`;
  const imported = normalizeOpeningImportedEvaluation("opening_learning_observations", row!);
  await fixture.sql`UPDATE opening_learning_observations SET verdict_source=${String(imported.verdict_source)},
    outcome=${String(imported.outcome)},ai_evaluation=NULL,server_evaluation=NULL WHERE id=${graded.id}`;
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id);
  expect(history.revisions.at(-1)?.eligibility?.verifiedCorrect).toBe("unknown");
  const repeated = await f.start({ problem: undefined, problemId: original.problemId });
  const answer = await f.submit(repeated);
  expect(answer.eligibility.independentAttempt).toBe("no");
  expect(answer.eligibility.reasonCodes).toContain("prior_evaluation_feedback");
});

it("uses a ready PDF page from its original file without requiring a pre-rendered image", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const rows = backupRows(fixture.sql, fixture.scope), pdfId = await rows.source(), chunkId = await rows.chunk(pdfId);
  await fixture.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdfId}`;
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  const input = { observationId: original.id, workSourceId: pdfId, workSourceVersion: 1, physicalPage: 1 };
  expect((await repository().context(fixture.scope, input)).workSource).toEqual({ id: pdfId, version: 1, physicalPage: 1 });
  await expect(repository().context(fixture.scope, { ...input, physicalPage: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
  const graded = await grade(original, proposal(), input);
  const identity = { id: pdfId, version: 1, physicalPage: 1 };
  expect(graded.aiEvaluation?.workSource).toEqual(identity);
  const status = await createOpeningAiGradingJobRepository(fixture.sql).read(fixture.scope, { observationId: original.id });
  expect(status.status).toBe("graded");
  expect(status.workSource).toEqual(identity);
});

it("does not count an answer edited after AI feedback as an independent first attempt", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { answer: "2" });
  const first = await grade(original, proposal("incorrect"));
  const revision = await correct(original, first, "1");
  const second = await grade(revision.observation!);
  expect(second).toMatchObject({ outcome: "correct", eligibility: { verifiedCorrect: "yes", independentAttempt: "no" } });
  expect(second.eligibility?.reasonCodes).toContain("prior_evaluation_feedback");
});

it("rejects an extra photo before creating an unreadable result when the answer already has 32 sources", async () => {
  const f = await learningAttemptFixture(fixture), rows = backupRows(fixture.sql, fixture.scope), sourceIds = [f.sourceId];
  for (let i = 1; i < 32; i++) { const id = await rows.source(); await rows.chunk(id); sourceIds.push(id); }
  await fixture.sql`UPDATE opening_learning_sessions SET source_ids=${sourceIds} WHERE id=${f.sessionId}`;
  const original = await f.submit(await f.start(), { sourceIds });
  const photoId = await rows.source();
  await fixture.sql`UPDATE opening_sources SET mime='image/png' WHERE id=${photoId}`;
  const input = { observationId: original.id, workSourceId: photoId, workSourceVersion: 1, physicalPage: 1 };
  await expect(repository().context(fixture.scope, input)).rejects.toMatchObject({ code: "VALIDATION" });
  expect((await readOpeningObservationHistory(fixture.sql, fixture.scope, original.id)).revisions).toHaveLength(1);
});
