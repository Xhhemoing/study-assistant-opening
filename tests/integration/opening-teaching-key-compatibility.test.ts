import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serverEvaluationSchema, type LearningObservation } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createCardRepository, createOpeningAiGradingRepository, createOpeningTeachingContentRepository, createOpeningTeachingHintRepository } from "@aistudy/database";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { readOpeningCourseEvidence, readOpeningCourseObservationHeads } from "../../packages/database/src/repositories/opening-learning-read";
import { refreshOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import { syncOpeningAutomaticErrorCard } from "../../packages/database/src/repositories/opening-auto-error-cards";
import * as evaluator from "../../packages/database/src/repositories/opening-teaching-question-evaluation";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });

async function seed() {
  const base = await learningAttemptFixture(f);
  const [session] = await f.sql`SELECT activity_id FROM opening_learning_sessions WHERE id=${base.sessionId}`;
  const activityId = String(session!.activity_id), blockId = randomUUID(), keyId = randomUUID();
  await f.sql`UPDATE opening_teaching_activities SET source_ids=${[base.sourceId]} WHERE id=${activityId}`;
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "Compatibility arithmetic", blocks: [
    { id: blockId, type: "prompt", content: { text: "1/2 + 1/2", interaction: { kind: "numeric" } } },
    { id: keyId, type: "answer_key", content: { answer: "1", hidden: true,
      hints: { direction: "比较分母。", concept: "同分母分数相加。", firstStep: "分子相加。" } } },
  ] });
  await content.publishActivitySpec(f.scope, { activityId, teachingUnitId: unit.id, expectedVersion: 0,
    expectedRevisionNumber: 1, revisionNumber: 1, blockOrder: [
      { blockId, blockType: "prompt", role: "prompt", position: 0 },
      { blockId: keyId, blockType: "answer_key", role: "answer_key", position: 1 },
    ], sourceRefs: [{ sourceId: base.sourceId, chunkId: base.chunkId, version: 1 }] });
  const service = createOpeningAttemptService(f.sql);
  const start = () => service.create(f.scope, { sessionId: base.sessionId, clientKey: randomUUID(),
    teachingBlock: { blockId, contentVersion: 1 } });
  const input = (attempt: Awaited<ReturnType<typeof start>>, answer: string, clientKey = randomUUID()) => ({
    sessionId: base.sessionId, courseId: base.courseId, skillLabel: "fractions", sourceIds: [base.sourceId],
    attemptId: attempt.id, problemId: attempt.problemId, answer, outcome: "unverified" as const,
    assistance: "independent" as const, clientKey,
  });
  // Synthetic persisted facts from the evaluator-enabled era. This helper does
  // not enable any writer or bypass bridge submit in application code.
  const historical = async (decision: "correct" | "incorrect" | "abstain") => {
    const attempt = await start(), request = input(attempt, decision === "incorrect" ? "2" : "1");
    const original = await base.learning.insertObservation(f.scope, request);
    const evaluation = serverEvaluationSchema.parse({ observationId: original.id, attemptId: attempt.id,
      problemId: attempt.problemId, itemVersionId: attempt.itemVersionId, requirementKey: attempt.requirementKey,
      evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1", decision,
      outcome: decision === "abstain" ? "unverified" : decision, reasonCodes: ["historical-fixture"], evaluatedAt: original.recordedAt });
    await f.sql.begin(async tx => {
      await tx`UPDATE opening_learning_observations SET outcome=${evaluation.outcome},verdict_source='deterministic',
        server_evaluation=${tx.json(evaluation)} WHERE id=${original.id}`;
      await refreshOpeningLearningEligibility(tx, f.scope, [original.id]);
      if (decision === "incorrect") await syncOpeningAutomaticErrorCard(tx, f.scope, original.id);
    });
    return { attempt, request, original, evaluation };
  };
  const read = () => readOpeningCourseObservationHeads(f.sql, f.scope, base.courseId);
  return { ...base, activityId, service, start, input, historical, read };
}

it.each(["correct", "incorrect", "abstain"] as const)("reads and replays saved teaching %s without rescoring or rewriting history", async decision => {
  const x = await seed(), old = await x.historical(decision);
  const spy = vi.spyOn(evaluator, "evaluateOpeningTeachingKeyAttempt").mockRejectedValue(new Error("must not rescore"));
  const before = await f.sql`SELECT * FROM opening_learning_observations WHERE id=${old.original.id}`;
  const replay = await x.learning.insertObservation(f.scope, old.request);
  expect(replay.serverEvaluation).toEqual(old.evaluation);
  expect(replay.eligibility).toMatchObject({ verifiedCorrect: decision === "correct" ? "yes" : decision === "incorrect" ? "no" : "unknown",
    usableForCurrentVersion: "yes" });
  expect(replay.allowsIndependent).toBe(decision === "correct");
  expect(await f.sql`SELECT * FROM opening_learning_observations WHERE id=${old.original.id}`).toEqual(before);
  expect(spy).not.toHaveBeenCalled();
  await expect(x.learning.insertObservation(f.otherScope, old.request)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(x.learning.insertObservation(f.scope, { ...old.request, answer: "changed" })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("preserves the old reader counterexample: pre-teaching-key schema rejects the new receipt", async () => {
  const x = await seed(), old = await x.historical("correct");
  // Exact discriminator set at 7ff0ee5af524a9d98a371a7924a74df3a93933c9.
  // The three unchanged variant schemas retain all original strict field checks.
  const legacy = z.discriminatedUnion("evaluatorVersion", [serverEvaluationSchema.options[1],
    serverEvaluationSchema.options[2], serverEvaluationSchema.options[3]]);
  expect(legacy.safeParse(old.evaluation).success).toBe(false);
  expect(serverEvaluationSchema.safeParse(old.evaluation).success).toBe(true);
  expect(legacy.safeParse({ ...old.evaluation, evaluatorVersion: "matrix-exact-v1", specVersion: "matrix-arithmetic-v1" }).success).toBe(true);
});

it.each(["wrong_attempt", "wrong_problem", "unknown_evaluator", "unknown_spec", "invalidated"] as const)(
  "does not upgrade historical %s", async change => {
    const x = await seed(), old = await x.historical("correct");
    if (change === "invalidated") await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.sourceId}`;
    else {
      const evaluation = { ...old.evaluation, ...(change === "wrong_attempt" ? { attemptId: randomUUID() }
        : change === "wrong_problem" ? { problemId: randomUUID() }
        : change === "unknown_evaluator" ? { evaluatorVersion: "unknown-exact" } : { specVersion: "unknown" }) };
      await f.sql`UPDATE opening_learning_observations SET server_evaluation=${f.sql.json(evaluation)} WHERE id=${old.original.id}`;
    }
    const evidence = await readOpeningCourseEvidence(f.sql, f.scope, x.courseId), facts = evidence.evidenceContexts[old.original.id]!;
    const qualification = evaluateEvidenceEligibility(facts.observation, facts.context);
    if (change === "invalidated") expect(qualification.usableForCurrentVersion).not.toBe("yes");
    else expect(qualification.verifiedCorrect).toBe("unknown");
  });

it("keeps legacy AI/self-report records and new bridge answers readable without deterministic promotion", async () => {
  const x = await seed(), ordinary = await x.start();
  const spy = vi.spyOn(evaluator, "evaluateOpeningTeachingKeyAttempt").mockRejectedValue(new Error("writer paused"));
  const submitted = await x.submit(ordinary, { answer: "1", outcome: "unverified" });
  expect(submitted).toMatchObject({ verdictSource: "self_report", outcome: "unverified", allowsIndependent: false });
  expect(submitted.serverEvaluation).toBeUndefined();
  expect(await f.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation' AND payload->>'observationId'=${submitted.id}`).toHaveLength(1);
  expect((await x.read()).find(row => row.id === submitted.id)?.eligibility?.verifiedCorrect).toBe("unknown");
  const graded = await createOpeningAiGradingRepository(f.sql).apply(f.scope, { observationId: submitted.id }, {
    outcome: "correct", confidence: 0.99, questionMatch: true, feedback: "合成历史反馈，无模型调用。",
    criteria: [{ label: "加法", verdict: "correct", feedback: "分子相加。" }],
  }, "compatibility-fixture");
  expect(graded.verdictSource).toBe("ai_graded");
  expect((await x.read()).some(row => row.verdictSource === "ai_graded" && row.serverEvaluation === undefined)).toBe(true);
  expect(await readOpeningCourseEvidence(f.sql, f.otherScope, x.courseId)).toEqual({ observations: [], evidenceContexts: {} });
  expect(spy).not.toHaveBeenCalled();
});

it.each(["replace", "retract"] as const)("keeps historical wrong cards paused on %s and preserves same-question feedback", async revisionKind => {
  const x = await seed(), old = await x.historical("incorrect"), cards = createCardRepository(f.sql);
  const [card] = await cards.listCards(f.scope);
  expect(card).toMatchObject({ originObservationRootId: old.original.id, autoPaused: false });
  expect(card!.back).toContain("参考答案：1");
  const state = await cards.getState({ ...f.scope, cardId: card!.id });
  await x.learning.reviseObservation(f.scope, { rootObservationId: old.original.id, revisesObservationId: old.original.id,
    expectedHead: old.original.id, revisionKind, reason: "compatibility correction", clientKey: randomUUID(),
    ...(revisionKind === "replace" ? { replacement: { answer: "1", outcome: "unverified", assistance: "independent", verdictSource: "self_report" } } : {}),
  } as Parameters<typeof x.learning.reviseObservation>[1]);
  expect((await cards.listCards(f.scope))[0]).toMatchObject({ id: card!.id, autoPaused: true });
  expect(await cards.getState({ ...f.scope, cardId: card!.id })).toEqual(state);
  const again = await x.start(), fallback = await x.submit(again, { answer: "答案：1", outcome: "unverified" });
  expect(again.problemId).toBe(old.attempt.problemId);
  expect(fallback.eligibility?.independentAttempt).not.toBe("yes");
  expect(fallback.allowsIndependent).toBe(false);
  const historical = await x.learning.observationHistory(f.scope, old.original.id);
  expect(JSON.stringify(historical)).toContain("teaching-key-exact-v1");
});

it("retains delivered hints for new bridge answers", async () => {
  const x = await seed(), attempt = await x.start();
  await createOpeningTeachingHintRepository(f.sql).read(f.scope, { attemptId: attempt.id, level: 1 });
  const result: LearningObservation = await x.service.submit(f.scope, attempt.id, { clientKey: randomUUID(), answer: "1",
    assistance: "independent", outcome: "unverified", verdictSource: "self_report" });
  expect(result).toMatchObject({ assistance: "hinted", verdictSource: "self_report", outcome: "unverified" });
  expect(result.eligibility?.independentAttempt).toBe("no");
});
