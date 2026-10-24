import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { AiGradingProposal, LearningObservation, MaterialManifest, ObservationInput } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningLearningAttemptRepository, createOpeningMaterialManifestRepository, readOpeningCourseEvidence } from "@aistudy/database";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningAiGradingContext } from "../../packages/database/src/repositories/opening-ai-grading-context";
import { createOpeningAiGradingJobRepository } from "../../packages/database/src/repositories/opening-ai-grading-jobs";
import { openingEligibilityStateQuery, repairOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { readOpeningObservationHistory, reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { syncOpeningAutomaticErrorCard } from "../../packages/database/src/repositories/opening-auto-error-cards";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
const key = { family: "unit-circle", number: "1", subquestion: "" };
const proposal: AiGradingProposal = { outcome: "incorrect", confidence: .99, questionMatch: true, feedback: "请检查单位圆的定义。",
  criteria: [{ label: "定义", verdict: "incorrect", feedback: "这里没有给出半径为1的条件。" }] };
const sorted = <T extends { sourceId: string }>(refs: T[]) => refs.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

async function setup(status: "trusted" | "unverified" | "disputed" = "trusted") {
  const f = await learningAttemptFixture(fixture), { sql, scope } = fixture;
  const manifests = createOpeningMaterialManifestRepository(sql), rows = backupRows(sql, scope);
  const questionManifest: MaterialManifest = { role: "exercise", sections: [], answers: [], questions: [
    { ...key, page: 1, stem: "解释单位圆的定义。" }, { ...key, number: "2", page: 1, stem: "解释复平面的坐标。" },
  ] };
  await manifests.write(scope, f.sourceId, { sourceVersion: 1, expectedRevision: 0, manifest: questionManifest });
  const answerId = await rows.source(); await rows.chunk(answerId);
  const answerManifest: MaterialManifest = { role: "answer_key", sections: [], questions: [], answers: [
    { page: 1, questionSourceId: f.sourceId, questionSourceVersion: 1, question: key, text: "参考甲：到原点的距离为1。", status, reason: "fixture review" },
  ] };
  await manifests.write(scope, answerId, { sourceVersion: 1, expectedRevision: 0, manifest: answerManifest });
  const start = () => createOpeningLearningAttemptRepository(sql).create(scope, {
    sessionId: f.sessionId, clientKey: randomUUID(), materialQuestion: { sourceId: f.sourceId, sourceVersion: 1, ...key },
  });
  const grades = createOpeningAiGradingRepository(sql);
  const writeAnswers = async (manifest: MaterialManifest) => {
    const current = await manifests.read(scope, answerId);
    return manifests.write(scope, answerId, { sourceVersion: 1, expectedRevision: current.revision, manifest });
  };
  const grade = async (original: LearningObservation) => {
    const input = { observationId: original.id }, captured = await grades.context(scope, input);
    return grades.apply(scope, input, proposal, "stored-fixture-grade", captured.materialProvenance);
  };
  const filter = { courseId: f.courseId, groups: [{ skillLabel: "fractions", requirementKey: null }] };
  return { ...f, manifests, questionManifest, answerId, answerManifest, rows, start, grades, writeAnswers, grade, filter };
}
async function state(rootId: string) {
  const [result] = await openingEligibilityStateQuery(fixture.sql, fixture.scope, { rootIds: [rootId] });
  expect(result).toBeDefined(); return result!;
}
async function currentEvidence(observation: LearningObservation) {
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, observation);
  return { evidence, eligibility: evaluateEvidenceEligibility(evidence.observation, evidence.context) };
}
/** Real PG read transaction ends before this barrier; installation uses another transaction. */
function pauseWriteTransaction(sql: Sql, ordinal = 1) {
  let ready!: () => void, resume!: () => void, count = 0;
  const captured = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { resume = resolve; });
  const wrapped = new Proxy(sql, { get(target, property, receiver) {
    if (property !== "begin") return Reflect.get(target, property, receiver);
    return async (...args: unknown[]) => {
      if (typeof args[0] === "function" && ++count === ordinal) { ready(); await released; }
      return Reflect.apply(target.begin, target, args);
    };
  } }) as Sql;
  const waitForCapture = (work: Promise<unknown>) => Promise.race([captured, work.then(() => {
    throw new Error("operation completed without reaching the expected transaction boundary");
  })]);
  return { sql: wrapped, waitForCapture, resume };
}

it("captures actual question and external answer revisions, including the complete unverified reverse set", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const otherAnswerId = await f.rows.source("uploaded", 0); await f.rows.chunk(otherAnswerId, 0);
  await f.manifests.write(scope, otherAnswerId, { sourceVersion: 0, expectedRevision: 0,
    manifest: { ...f.answerManifest, answers: [{ ...f.answerManifest.answers[0]!, text: "不应进入提示的待核验答案", status: "unverified" }] } });
  const original = await f.submit(await f.start(), { outcome: "unverified", answer: "一条曲线" });
  const captured = await f.grades.context(scope, { observationId: original.id });
  const questionRevision = (await f.manifests.read(scope, f.sourceId)).revision;
  const answerRefs = [{ sourceId: f.answerId, sourceVersion: 1, manifestRevision: 1 },
    { sourceId: otherAnswerId, sourceVersion: 0, manifestRevision: 1 }];
  expect(captured.materialProvenance).toEqual({
    materialAnswerRefs: sorted(answerRefs),
    materialSourceRefs: sorted([{ sourceId: f.sourceId, sourceVersion: 1, manifestRevision: questionRevision }, ...answerRefs]),
  });
  expect(captured.referenceText).toContain("参考甲");
  expect(captured.referenceText).not.toContain("不应进入提示");
  expect(captured.sourceIds).toContain(f.answerId);
  expect(captured.sourceIds).not.toContain(otherAnswerId);
  const graded = await f.grades.apply(scope, { observationId: original.id }, proposal, "fixture", captured.materialProvenance);
  expect(graded.aiEvaluation).toMatchObject(captured.materialProvenance);
  expect(graded.eligibility).toMatchObject({ verifiedCorrect: "no", usableForCurrentVersion: "yes" });
  const input = await currentEvidence(graded), projection = await state(original.id);
  expect(input.evidence.context.version?.applicability).toBe("exact");
  expect(input.evidence.dependencies.itemMatches).toBe(true);
  expect(projection.live_material_dependencies).toEqual(input.evidence.dependencies.materialDependencies);
  expect(projection.projected_source_states).toEqual({ sourceStates: input.evidence.dependencies.sourceStates,
    materialDependencies: input.evidence.dependencies.materialDependencies });
  expect(projection.fresh).toBe(true);
  const [stored] = await sql`SELECT ai_evaluation FROM opening_learning_observations WHERE id=${graded.id}`;
  expect(stored!.ai_evaluation).toMatchObject(captured.materialProvenance);
  expect(await f.grades.apply(scope, { observationId: original.id }, proposal, "fixture", captured.materialProvenance)).toMatchObject({ id: graded.id });
});

it.each(["text", "status", "association", "remove", "new-answer-source", "classification"] as const)(
  "withholds a saved grade after %s changes and pauses existing automatic cards without altering immutable facts", async change => {
    const f = await setup(), { sql, scope } = fixture;
    const original = await f.submit(await f.start(), { outcome: "unverified", answer: "一条曲线" }), graded = await f.grade(original);
    expect(await sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id} AND auto_paused=false`).toHaveLength(1);
    const [before] = await sql`SELECT * FROM opening_learning_observations WHERE id=${graded.id}`;
    if (change === "new-answer-source") {
      const id = await f.rows.source(); await f.rows.chunk(id);
      await f.manifests.write(scope, id, { sourceVersion: 1, expectedRevision: 0, manifest: f.answerManifest });
    } else if (change === "classification") {
      const current = await f.manifests.read(scope, f.sourceId);
      await f.manifests.write(scope, f.sourceId, { sourceVersion: 1, expectedRevision: current.revision,
        manifest: { ...f.questionManifest, role: "mixed", sections: [{ startPage: 1, endPage: 1, role: "exercise" }] } });
    } else {
      const next = structuredClone(f.answerManifest), answer = next.answers[0]!;
      if (change === "text") answer.text = "参考乙：补充复数模的定义。";
      if (change === "status") answer.status = "unverified";
      if (change === "association") answer.question = { ...key, number: "2" };
      if (change === "remove") next.answers = [];
      await f.writeAnswers(next);
    }
    const { evidence, eligibility } = await currentEvidence(graded);
    expect(evidence.context.version?.applicability).toBe("exact");
    expect(evidence.dependencies.itemMatches).toBe(true);
    expect(eligibility).toMatchObject({ verifiedCorrect: "unknown", usableForCurrentVersion: "unknown",
      reasonCodes: expect.arrayContaining(["material_assessment_changed", "version_exact"]) });
    expect(eligibility.reasonCodes).not.toContain("ai_graded_incorrect");
    expect(await sql`SELECT * FROM opening_learning_observations WHERE id=${graded.id}`).toEqual([before]);
    expect(await sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id} AND auto_paused=false`).toHaveLength(0);
    expect((await state(original.id)).fresh).toBe(false);
    expect(await repairOpeningLearningEligibility(sql, scope, f.filter)).toBe(1);
    expect(await state(original.id)).toMatchObject({ fresh: true, live_item_matches: true, version_applicability: "exact",
      verified_correct: "unknown", usable_for_current_version: "unknown" });
  },
);

it("does not revive old scores or automatic cards after dispute→trusted, even with the exact original answer text", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" }), graded = await f.grade(original);
  await f.writeAnswers({ ...f.answerManifest, answers: [{ ...f.answerManifest.answers[0]!, status: "disputed" }] });
  expect((await currentEvidence(graded)).eligibility).toMatchObject({ verifiedCorrect: "unknown", usableForCurrentVersion: "no" });
  await f.writeAnswers(f.answerManifest);
  const after = await currentEvidence(graded);
  expect(after.eligibility).toMatchObject({ verifiedCorrect: "unknown", usableForCurrentVersion: "unknown" });
  expect(after.evidence.context.version?.applicability).toBe("exact");
  expect(after.eligibility.reasonCodes).not.toContain("material_answer_disputed");
  await sql.begin(tx => syncOpeningAutomaticErrorCard(tx, scope, graded.id));
  expect(await sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id} AND auto_paused=false`).toHaveLength(0);
  expect((await readOpeningObservationHistory(sql, scope, original.id)).revisions.at(-1)).toMatchObject({ answer: graded.answer,
    outcome: "incorrect", aiEvaluation: graded.aiEvaluation, eligibility: { verifiedCorrect: "unknown" } });
});

it("withdraws a formerly correct score as well without inventing new help or changing the original outcome", async () => {
  const f = await setup(), { scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified", answer: "到原点的距离为1的点集" });
  const input = { observationId: original.id }, captured = await f.grades.context(scope, input);
  const graded = await f.grades.apply(scope, input, { ...proposal, outcome: "correct", feedback: "定义正确。",
    criteria: [{ label: "定义", verdict: "correct", feedback: "给出了距离条件。" }] }, "fixture", captured.materialProvenance);
  expect(graded.eligibility?.verifiedCorrect).toBe("yes");
  await f.writeAnswers({ ...f.answerManifest, answers: [{ ...f.answerManifest.answers[0]!, text: "补充修订后的参考解释。" }] });
  const after = (await readOpeningObservationHistory(fixture.sql, scope, original.id)).revisions.at(-1)!;
  expect(after).toMatchObject({ answer: graded.answer, outcome: "correct", aiEvaluation: graded.aiEvaluation,
    eligibility: { independentAttempt: graded.eligibility!.independentAttempt, verifiedCorrect: "unknown", usableForCurrentVersion: "unknown" } });
  expect(after.eligibility?.reasonCodes).not.toContain("ai_graded_correct");
});

it("retains invalidation after a newly associated external answer is removed again", async () => {
  const f = await setup(), { scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" }), graded = await f.grade(original);
  const id = await f.rows.source(); await f.rows.chunk(id);
  await f.manifests.write(scope, id, { sourceVersion: 1, expectedRevision: 0, manifest: f.answerManifest });
  expect((await currentEvidence(graded)).eligibility.verifiedCorrect).toBe("unknown");
  await f.manifests.write(scope, id, { sourceVersion: 1, expectedRevision: 1, manifest: { ...f.answerManifest, answers: [] } });
  // The manifest writer must also advance the affected question source's metadata
  // revision. Otherwise removing a new reverse link restores the old dependency set.
  expect((await currentEvidence(graded)).eligibility).toMatchObject({ verifiedCorrect: "unknown", usableForCurrentVersion: "unknown",
    reasonCodes: expect.arrayContaining(["material_assessment_changed"]) });
});

it("does not manufacture provenance for a legacy classified score", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" }), graded = await f.grade(original);
  await sql`UPDATE opening_learning_observations SET ai_evaluation=ai_evaluation-'materialAnswerRefs'-'materialSourceRefs' WHERE id=${graded.id}`;
  const historical = (await readOpeningObservationHistory(sql, scope, original.id)).revisions.at(-1)!;
  expect(historical.aiEvaluation).not.toHaveProperty("materialSourceRefs");
  expect(historical.eligibility).toMatchObject({ verifiedCorrect: "unknown", usableForCurrentVersion: "unknown",
    reasonCodes: expect.arrayContaining(["material_assessment_provenance_unknown"]) });
});

it("does not backfill a legacy adapter's omitted dependencies during apply", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" });
  const graded = await f.grades.apply(scope, { observationId: original.id }, proposal, "legacy-adapter");
  expect(graded.aiEvaluation).not.toHaveProperty("materialSourceRefs");
  expect(graded.eligibility).toMatchObject({ verifiedCorrect: "unknown", usableForCurrentVersion: "unknown",
    reasonCodes: expect.arrayContaining(["material_assessment_provenance_unknown"]) });
  expect(await sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id} AND auto_paused=false`).toHaveLength(0);
});

it("keeps an actual source-byte version change distinct from material revisions and item identity", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" }), graded = await f.grade(original);
  await sql`UPDATE opening_sources SET version=2 WHERE id=${f.answerId}`;
  await f.rows.chunk(f.answerId, 2);
  await f.manifests.write(scope, f.answerId, { sourceVersion: 2, expectedRevision: 0, manifest: f.answerManifest });
  const { evidence, eligibility } = await currentEvidence(graded);
  expect(evidence.dependencies.materialDependencies.materialAnswerRefs).toEqual([
    { sourceId: f.answerId, sourceVersion: 2, manifestRevision: 1 },
  ]);
  expect(evidence.dependencies.itemMatches).toBe(true);
  expect(evidence.context.version?.applicability).toBe("changed_needs_check");
  expect(eligibility.reasonCodes).toEqual(expect.arrayContaining(["material_assessment_changed", "version_changed_needs_check"]));
  expect(await repairOpeningLearningEligibility(sql, scope, f.filter)).toBe(1);
  expect(await state(original.id)).toMatchObject({ fresh: true, live_item_matches: true, version_applicability: "changed_needs_check",
    verified_correct: "unknown", usable_for_current_version: "unknown" });
});

it("detects out-of-band metadata writes in SQL freshness and rejects captured repair CAS without a counter change", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" }), graded = await f.grade(original);
  await sql`UPDATE opening_source_versions SET material_manifest_revision=material_manifest_revision+1,
    material_manifest=jsonb_set(material_manifest,'{answers,0,text}',to_jsonb('external update'::text)) WHERE source_id=${f.answerId} AND version=1`;
  expect((await state(original.id)).fresh).toBe(false);
  const pause = pauseWriteTransaction(sql), repair = repairOpeningLearningEligibility(pause.sql, scope, f.filter);
  try {
    await pause.waitForCapture(repair);
    await sql`UPDATE opening_source_versions SET material_manifest_revision=material_manifest_revision+1 WHERE source_id=${f.answerId} AND version=1`;
  } finally { pause.resume(); }
  expect(await repair).toBe(0);
  expect((await state(original.id)).fresh).toBe(false);
  expect(await repairOpeningLearningEligibility(sql, scope, f.filter)).toBe(1);
  const input = await currentEvidence(graded), projection = await state(original.id);
  expect(projection).toMatchObject({ fresh: true, verified_correct: "unknown", version_applicability: "exact", live_item_matches: true });
  expect(projection.live_material_dependencies).toEqual(input.evidence.dependencies.materialDependencies);
});

it("rejects a captured repair after a new reverse link from a previously unrelated source appears", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" }); await f.grade(original);
  const id = await f.rows.source(); await f.rows.chunk(id);
  await f.manifests.write(scope, id, { sourceVersion: 1, expectedRevision: 0, manifest: { ...f.answerManifest, answers: [] } });
  await sql`DELETE FROM opening_learning_eligibility WHERE root_observation_id=${original.id}`;
  const pause = pauseWriteTransaction(sql), repair = repairOpeningLearningEligibility(pause.sql, scope, f.filter);
  try {
    await pause.waitForCapture(repair);
    // Deliberately bypass history/invalidation: the live dependency comparison,
    // not just the ordinary writer's watermark, must reject this stale install.
    await sql`UPDATE opening_source_versions SET material_manifest=${sql.json(f.answerManifest)},
      material_manifest_revision=material_manifest_revision+1 WHERE source_id=${id} AND version=1`;
  } finally { pause.resume(); }
  expect(await repair).toBe(0);
  expect(await sql`SELECT 1 FROM opening_learning_eligibility WHERE root_observation_id=${original.id}`).toHaveLength(0);
  expect(await repairOpeningLearningEligibility(sql, scope, f.filter)).toBe(1);
  expect(await state(original.id)).toMatchObject({ fresh: true, verified_correct: "unknown", usable_for_current_version: "unknown" });
});

it("migrates a legacy array projection and prevents an older repair overwriting new JSON dependencies at the same watermark", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" }); await f.grade(original);
  await sql`UPDATE opening_learning_eligibility SET source_states=source_states->'sourceStates' WHERE root_observation_id=${original.id}`;
  expect((await state(original.id)).fresh).toBe(false);
  expect(await repairOpeningLearningEligibility(sql, scope, f.filter)).toBe(1);
  expect((await state(original.id)).fresh).toBe(true);
  await sql`UPDATE opening_source_versions SET material_manifest_revision=material_manifest_revision+1 WHERE source_id=${f.answerId} AND version=1`;
  const pause = pauseWriteTransaction(sql), older = repairOpeningLearningEligibility(pause.sql, scope, f.filter);
  let installed = 0;
  try {
    await pause.waitForCapture(older);
    installed = await repairOpeningLearningEligibility(sql, scope, f.filter);
  } finally { pause.resume(); }
  expect(installed).toBe(1);
  // Both batches captured the same new material state and workspace watermark.
  // The old projection's JSONB dependencies are part of the UPDATE CAS too.
  expect(await older).toBe(0);
  expect(await state(original.id)).toMatchObject({ fresh: true, verified_correct: "unknown", usable_for_current_version: "unknown" });
});

it("rechecks the originally captured provenance inside final publication after pre-apply validation already passed", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" });
  const input = { observationId: original.id }, captured = await f.grades.context(scope, input);
  // apply does one context transaction before its final revise transaction.
  const pause = pauseWriteTransaction(sql, 2), grades = createOpeningAiGradingRepository(pause.sql);
  const publication = grades.apply(scope, input, proposal, "late-result", captured.materialProvenance);
  const rejected = expect(publication).rejects.toMatchObject({ code: "CONFLICT" });
  try {
    await pause.waitForCapture(publication);
    await f.writeAnswers({ ...f.answerManifest, answers: [{ ...f.answerManifest.answers[0]!, text: "发送后修订的答案" }] });
  } finally { pause.resume(); }
  await rejected;
  expect(await sql`SELECT id FROM opening_learning_observations WHERE revises_observation_id=${original.id}`).toHaveLength(0);
  expect(await sql`SELECT id FROM cards WHERE origin_observation_root_id=${original.id}`).toHaveLength(0);
  expect((await readOpeningObservationHistory(sql, scope, original.id)).headObservationId).toBe(original.id);
});

it("preserves a disputed photo submission but never enqueues/retries it or restores eligibility by manual attribution", async () => {
  const f = await setup("disputed"), { sql, scope } = fixture, attempt = await f.start();
  const photoId = await f.rows.source();
  await sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${photoId}`;
  const input: ObservationInput = { attemptId: attempt.id, sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    problemId: attempt.problemId, answer: "", outcome: "unverified", assistance: "independent", clientKey: randomUUID() };
  const workSource = { id: photoId, version: 1, physicalPage: 1 };
  const saved = await f.learning.insertObservation(scope, input, { workSource });
  expect(saved).toMatchObject({ answer: "", eligibility: { verifiedCorrect: "unknown", usableForCurrentVersion: "no" } });
  expect(saved.sourceVersions?.[photoId]).toBe(1);
  expect((await f.learning.insertObservation(scope, input, { workSource })).id).toBe(saved.id);
  const sealing = await sql.begin(tx => readOpeningAiGradingContext(tx, scope, { observationId: saved.id }, { provenanceOnly: true }));
  expect(sealing).toMatchObject({ workSource, referenceText: "" });
  await expect(f.grades.context(scope, { observationId: saved.id })).rejects.toMatchObject({ code: "CONFLICT" });
  const jobs = createOpeningAiGradingJobRepository(sql);
  expect(await jobs.enqueue(scope, { observationId: saved.id })).toMatchObject({ status: "needs_manual", retryable: false });
  expect(await sql`SELECT id FROM opening_jobs WHERE kind='grade-observation' AND payload->>'observationId'=${saved.id}`).toHaveLength(0);
  const corrected = (await reviseOpeningLearningObservation(sql, scope, { rootObservationId: saved.id, revisesObservationId: saved.id,
    expectedHead: saved.id, clientKey: randomUUID(), revisionKind: "replace", reason: "补充手写答案文字",
    replacement: { answer: "只画了一个圆", outcome: "incorrect", assistance: "independent" } })).observation!;
  expect(corrected.eligibility?.verifiedCorrect).toBe("unknown");
  expect(await sql`SELECT id FROM opening_jobs WHERE kind='grade-observation' AND payload->>'observationId'=${corrected.id}`).toHaveLength(0);
  expect((await readOpeningCourseEvidence(sql, scope, f.courseId)).observations.map(row => row.id)).toContain(corrected.id);
});

it("keeps unknown spend and its paid operation key across manifest changes and changed grading admission", async () => {
  const f = await setup(), { sql, scope } = fixture;
  const original = await f.submit(await f.start(), { outcome: "unverified" });
  const captured = await f.grades.context(scope, { observationId: original.id });
  await sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${scope.workspaceId},'grading',1,${captured.operationId},'reserved',clock_timestamp(),clock_timestamp())`;
  const before = await sql`SELECT * FROM opening_budget_reservations WHERE request_id=${captured.operationId}`;
  await f.writeAnswers({ ...f.answerManifest, answers: [{ ...f.answerManifest.answers[0]!, text: "同一费用输入的新参考答案" }] });
  expect((await f.grades.context(scope, { observationId: original.id })).operationId).toBe(captured.operationId);
  expect(await f.grades.ledger(scope, captured.operationId)).toBe("unknown");
  expect(await createOpeningAiGradingJobRepository(sql).enqueue(scope, { observationId: original.id })).toMatchObject({ status: "unknown_cost", retryable: false });
  expect(await sql`SELECT * FROM opening_budget_reservations WHERE request_id=${captured.operationId}`).toEqual(before);
  await expect(f.grades.apply(scope, { observationId: original.id }, proposal, "late", captured.materialProvenance)).rejects.toMatchObject({ code: "CONFLICT" });
});
