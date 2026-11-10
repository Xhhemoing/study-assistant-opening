import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningAiGradingRepository, createOpeningBudgetRepository, createOpeningConversationRepository,
  createOpeningPrivacyRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository,
} from "@aistudy/database";
import type { ProviderInput } from "@aistudy/contracts";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

async function seed(photo = false) {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const original = await f.submit(attempt, { answer: "sm95 wrong saved answer", outcome: "unverified" });
  let workSource: { id: string; version: number; physicalPage: number } | undefined;
  if (photo) {
    const id = randomUUID();
    await fixture.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES (${id},${fixture.scope.workspaceId},'sm95 sealed work','image/png',64,${"d".repeat(64)},0,'uploaded','ready')`;
    workSource = { id, version: 0, physicalPage: 1 };
  }
  const graded = await createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope, {
    observationId: original.id, ...(workSource ? { workSourceId: workSource.id, workSourceVersion: 0, physicalPage: 1 } : {}),
  }, { outcome: "incorrect", questionMatch: true, confidence: 0.9, feedback: "sm95 feedback: the answer is wrong",
    criteria: [{ label: "sm95 criterion", verdict: "incorrect", feedback: "sm95 correction" }],
    ...(photo ? { transcription: "sm95 model transcription, not the question" } : {}) }, "sm95 fake grader");
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { courseId: f.courseId, title: "sm95 native bound explanation" });
  const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: "请讲解本次作答", mode: "explain", purpose: "answer", clientKey: randomUUID(), sourceIds: [],
    learningSessionId: f.sessionId, attemptId: attempt.id, contextAnchor: { purpose: "learning_help", courseId: f.courseId, attemptId: attempt.id },
    currentPage: null, chunkId: null });
  const jobs = createOpeningTutorJobsRepository(fixture.sql);
  const claim = async () => {
    const claimed = await jobs.claim(saved.jobId);
    return { userTurnId: saved.turnId, jobId: saved.jobId, claimToken: claimed!.claimToken };
  };
  const correct = () => reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: original.id, revisesObservationId: graded.id, expectedHead: graded.id, revisionKind: "replace",
    reason: "sm95 changed answer", clientKey: randomUUID(),
    replacement: { answer: "sm95 revised answer", outcome: "unverified", assistance: graded.assistance },
  });
  return { ...f, attempt, original, graded, saved, jobs, claim, correct, conversations, conversation, workSource };
}

function handler(f: Awaited<ReturnType<typeof seed>>, hook?: () => Promise<void>) {
  const inputs: ProviderInput[] = [];
  const provider = { complete: vi.fn(async (input: ProviderInput) => {
    inputs.push(input);
    await hook?.();
    return { text: "sm95 explanation", citedChunkIds: [], candidates: [], inputTokens: 10, outputTokens: 5, requestId: null };
  }) };
  const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100000 });
  return { inputs, provider, run: createTutorTurnHandler({ tutorJobs: f.jobs, chunks: createOpeningSourceChunksRepository(fixture.sql),
    budget, provider, privacy: createOpeningPrivacyRepository(fixture.sql), retrieveContext: createOpeningMaterialRetriever(fixture.sql, budget, null),
    config: { maxContextCharacters: 5000, reservedCents: 1, maxOutputTokens: 256, inputCentsPerMillion: 100, outputCentsPerMillion: 200 } }) };
}

const completion = (f: Awaited<ReturnType<typeof seed>>, target: Awaited<ReturnType<typeof f.claim>>) => ({
  scope: fixture.scope, jobId: f.saved.jobId, assistantTurnId: f.saved.assistantTurnId, claimToken: target.claimToken,
  text: "must not persist stale answer", citations: [], candidates: [],
});

describe("sm95 same-attempt explain context", () => {
  it.each([false, true])("captures original question/answer/effective grade and provenance, sealed photo=%s; redelivery is inert", async photo => {
    const f = await seed(photo), h = handler(f);
    expect(await h.run(f.saved.jobId)).toEqual({ skipped: false });
    const payload = JSON.parse(h.inputs[0]!.text);
    expect(payload.request).toBe("请讲解本次作答");
    expect(payload.attemptContext).toMatchObject({ originalQuestion: "1/2 + 1/2?", rootObservationId: f.original.id,
      headObservationId: f.graded.id, originalAnswer: { answer: "sm95 wrong saved answer", answerRevision: 1 },
      currentAnswer: { answer: "sm95 wrong saved answer", observationId: f.graded.id, answerRevision: 1 },
      effectiveGrading: { observationId: f.graded.id, answerRevision: 1, aiEvaluation: { feedback: "sm95 feedback: the answer is wrong" } },
      workSource: f.workSource ?? null });
    const [turn] = await fixture.sql`SELECT context_source_refs FROM opening_turns WHERE id=${f.saved.assistantTurnId}`;
    expect(turn!.context_source_refs).toContainEqual({ sourceId: f.sourceId, sourceVersion: f.original.sourceVersions![f.sourceId] });
    if (photo) expect(turn!.context_source_refs).toContainEqual({ sourceId: f.workSource!.id, sourceVersion: 0 });
    const before = await fixture.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`;
    expect(await h.run(f.saved.jobId)).toEqual({ skipped: true });
    expect(h.provider.complete).toHaveBeenCalledOnce();
    expect(await fixture.sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY id`).toEqual(before);
    await f.conversations.listTurns(fixture.scope, f.conversation.id);
    const exposures = await fixture.sql`SELECT * FROM opening_help_exposures WHERE turn_id=${f.saved.assistantTurnId}`;
    await f.conversations.listTurns(fixture.scope, f.conversation.id);
    expect(exposures).toHaveLength(1);
    expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE turn_id=${f.saved.assistantTurnId}`).toEqual(exposures);
  });

  it("rejects foreign owner and foreign workspace without reading another account", async () => {
    const f = await seed(), target = await f.claim();
    for (const scope of [fixture.otherScope, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }]) {
      await expect(f.jobs.readAttemptContext(scope, target)).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it.each(["epoch", "answer", "course", "exclude", "purpose", "photo", "source-version", "owner", "session", "attempt", "item"])("fails closed on late %s drift at assertion AND completion", async drift => {
    const f = await seed(drift === "photo"), target = await f.claim();
    const snapshot = await f.jobs.readAttemptContext(fixture.scope, target);
    expect(snapshot).not.toBeNull();
    if (drift === "epoch") await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
    if (drift === "answer") await f.correct();
    if (drift === "course") await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${f.courseId}`;
    if (drift === "exclude") await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
    if (drift === "purpose") await fixture.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE course_id=${f.courseId}`;
    if (drift === "photo") await fixture.sql`UPDATE opening_learning_observations SET grading_work_source=${fixture.sql.json({ ...f.workSource!, version: 1 })} WHERE id=${f.graded.id}`;
    if (drift === "source-version") await fixture.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${f.sourceId}`;
    if (drift === "owner") {
      const owner = randomUUID();
      await fixture.sql`INSERT INTO users(id,email,display_name,password_hash) VALUES (${owner},${`${owner}@example.com`},'sm95 new owner','test')`;
      await fixture.sql`UPDATE workspaces SET owner_user_id=${owner} WHERE id=${fixture.scope.workspaceId}`;
    }
    if (drift === "session") await fixture.sql`UPDATE opening_turns SET learning_session_id=${randomUUID()} WHERE id IN (${f.saved.turnId},${f.saved.assistantTurnId})`;
    if (drift === "attempt") await fixture.sql`UPDATE opening_turns SET context_anchor=jsonb_set(context_anchor,'{attemptId}',${fixture.sql.json(randomUUID())}) WHERE id=${f.saved.turnId}`;
    if (drift === "item") await fixture.sql`UPDATE opening_turns SET context_anchor=jsonb_set(context_anchor,'{itemVersionId}',${fixture.sql.json(randomUUID())}) WHERE id=${f.saved.turnId}`;
    await expect(f.jobs.assertAttemptContext(fixture.scope, target, snapshot!)).rejects.toThrow();
    await expect(f.jobs.completeTurn(completion(f, target), { attemptContext: { target, snapshot: snapshot! } })).rejects.toThrow();
    expect((await fixture.sql`SELECT status FROM opening_turns WHERE id=${f.saved.assistantTurnId}`)[0]!.status).not.toBe("complete");
    if (drift === "owner") await fixture.sql`UPDATE workspaces SET owner_user_id=${fixture.scope.ownerUserId} WHERE id=${fixture.scope.workspaceId}`;
  });

  it("loads current revised answer but never carries old grade to it; rejects forged old grading at a new head", async () => {
    const f = await seed(), revised = await f.correct(), target = await f.claim();
    const snapshot = await f.jobs.readAttemptContext(fixture.scope, target);
    expect(snapshot).toMatchObject({ currentAnswer: { answer: "sm95 revised answer", answerRevision: 2 }, effectiveGrading: null });
    await fixture.sql`UPDATE opening_learning_observations SET ai_evaluation=${fixture.sql.json(f.graded.aiEvaluation!)},verdict_source='ai_graded'
      WHERE id=${revised.observation!.id}`;
    await expect(f.jobs.readAttemptContext(fixture.scope, target)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("loads only the saved stem before submission, without inventing an answer or grade", async () => {
    const f = await seed(), next = await f.start();
    const saved = await f.conversations.appendSavedTurn({ scope: fixture.scope, conversationId: f.conversation.id,
      text: "请讲解这道题", mode: "explain", purpose: "answer", clientKey: randomUUID(), sourceIds: [],
      learningSessionId: f.sessionId, attemptId: next.id, currentPage: null, chunkId: null });
    const claimed = await f.jobs.claim(saved.jobId);
    const snapshot = await f.jobs.readAttemptContext(fixture.scope, { userTurnId: saved.turnId, jobId: saved.jobId, claimToken: claimed!.claimToken });
    expect(snapshot).toMatchObject({ originalQuestion: "1/2 + 1/2?", originalAnswer: null, currentAnswer: null, effectiveGrading: null });
  });

  it("rejects a grade with a mismatched answer revision even if its observation id matches", async () => {
    const f = await seed(), target = await f.claim();
    await fixture.sql`UPDATE opening_learning_observations SET answer_revision=2 WHERE id=${f.graded.id}`;
    await expect(f.jobs.readAttemptContext(fixture.scope, target)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("late answer edit during provider call is not published and cannot cause a second paid send", async () => {
    const f = await seed(), h = handler(f, async () => { await f.correct(); });
    await expect(h.run(f.saved.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.provider.complete).toHaveBeenCalledOnce();
    expect(await h.run(f.saved.jobId)).toEqual({ skipped: true });
    expect(h.provider.complete).toHaveBeenCalledOnce();
    expect((await fixture.sql`SELECT status FROM opening_turns WHERE id=${f.saved.assistantTurnId}`)[0]!.status).not.toBe("complete");
  });
});
