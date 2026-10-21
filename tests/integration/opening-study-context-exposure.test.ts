import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningConversationRepository, createOpeningTutorJobsRepository, createOpeningStudyIntentRepository, createOpeningStudyContextRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

it("resolves the attempt's server identities and rejects a course/item/chunk from a different context", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const resolver = createOpeningStudyContextRepository(fixture.sql);
  const anchor = await resolver.resolve(fixture.scope, { purpose: "learning_help", attemptId: attempt.id });
  expect(anchor).toMatchObject({ courseId: f.courseId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId,
    sourceId: f.sourceId, sourceVersion: 1, chunkId: f.chunkId, page: 1 });
  await expect(resolver.resolve(fixture.scope, { purpose: "learning_help", attemptId: attempt.id, courseId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(resolver.resolve({ ...fixture.scope, ownerUserId: randomUUID() }, { purpose: "learning_help", attemptId: attempt.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(resolver.resolve(fixture.scope, { purpose: "learning_help", attemptId: attempt.id, itemVersionId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(resolver.resolve(fixture.scope, { purpose: "material_read", sourceId: f.sourceId, sourceVersion: 2, chunkId: f.chunkId })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("keeps generated, released and acknowledged facts distinct and retries idempotent", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const exposures = createOpeningStudyExposureRepository(fixture.sql);
  const input = { releaseKey: randomUUID(), contextAnchor: { purpose: "learning_help" as const, attemptId: attempt.id }, origin: "assistant" as const, kind: "hint" as const, level: "hinted" as const };
  const generated = await exposures.generate(fixture.scope, input);
  expect(generated.releasedAt).toBeNull();
  await expect(exposures.acknowledge(fixture.scope, generated.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await exposures.generate(fixture.scope, input)).toEqual(generated);
  const released = await exposures.release(fixture.scope, generated.id);
  expect(released.releasedAt).not.toBeNull();
  expect(released.acknowledgedAt).toBeNull();
  expect(await exposures.release(fixture.scope, generated.id)).toEqual(released);
  const ack = await exposures.acknowledge(fixture.scope, generated.id);
  expect(ack.acknowledgedAt).not.toBeNull();
  expect(await exposures.acknowledge(fixture.scope, generated.id)).toEqual(ack);
  await expect(exposures.generate(fixture.scope, { ...input, level: "revealed" })).rejects.toMatchObject({ code: "CONFLICT" });
  const [counter] = await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(Number(counter!.revision)).toBe(1);
});

it("a release before submission prevents independence without waiting for acknowledgment", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const exposures = createOpeningStudyExposureRepository(fixture.sql);
  const receipt = await exposures.deliver(fixture.scope, { releaseKey: randomUUID(), contextAnchor: { purpose: "learning_help", attemptId: attempt.id },
    origin: "assistant", kind: "hint", level: "hinted" });
  expect(receipt.acknowledgedAt).toBeNull();
  const answer = await f.submit(attempt);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe("no");
});

it("a generated-only answer stays independent and a later release cannot rewrite answer ordering", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const exposures = createOpeningStudyExposureRepository(fixture.sql);
  const generated = await exposures.generate(fixture.scope, { releaseKey: randomUUID(), contextAnchor: { purpose: "learning_help", attemptId: attempt.id },
    origin: "assistant", kind: "hint", level: "hinted" });
  const answer = await f.submit(attempt);
  const before = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(before.observation, before.context).independentAttempt).toBe("yes");
  await exposures.release(fixture.scope, generated.id);
  const after = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(after.observation, after.context).independentAttempt).toBe("yes");
});

it("records a material excerpt against a matching item without inventing an assistant turn", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const receipt = await createOpeningStudyExposureRepository(fixture.sql).deliver(fixture.scope, { releaseKey: randomUUID(),
    contextAnchor: { purpose: "material_read", courseId: f.courseId, itemVersionId: attempt.itemVersionId },
    origin: "material_excerpt", kind: "solution", level: "revealed" });
  expect(receipt.contextAnchor.itemVersionId).toBe(attempt.itemVersionId);
  const [stored] = await fixture.sql`SELECT turn_id,session_id,problem_id FROM opening_help_exposures WHERE id=${receipt.id}`;
  expect(stored).toEqual({ turn_id: null, session_id: null, problem_id: attempt.problemId });
  const answer = await f.submit(attempt);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe("unknown");
});


it.each([false, true])("saved tutor generation stays inert until actual conversation delivery (read=%s)", async (readBeforeAnswer) => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const conversations = createOpeningConversationRepository(fixture.sql), jobs = createOpeningTutorJobsRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "Tutor release", courseId: f.courseId });
  const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: "Give a hint", mode: "hint", clientKey: randomUUID(), sourceIds: [f.sourceId], learningSessionId: f.sessionId,
    attemptId: attempt.id, currentPage: 1, chunkId: f.chunkId });
  const claimed = await jobs.claim(saved.jobId);
  await jobs.completeTurn({ scope: fixture.scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId,
    text: "Use a common denominator", citations: [], candidates: [], claimToken: claimed!.claimToken,
    helpExposure: { id: randomUUID(), sessionId: f.sessionId, attemptId: attempt.id, problemId: attempt.problemId,
      turnId: saved.assistantTurnId, kind: "hint", level: "hinted", delivered: true, contextAnchor: attempt.contextAnchor } });
  const [generated] = await fixture.sql`SELECT delivered,released_at,acknowledged_at FROM opening_help_exposures WHERE turn_id=${saved.assistantTurnId}`;
  expect(generated).toEqual({ delivered: false, released_at: null, acknowledged_at: null });
  if (readBeforeAnswer) {
    const turns = await conversations.listTurns(fixture.scope, conversation.id);
    expect(turns.find(turn => turn.id === saved.assistantTurnId)?.exposureReceipt?.releasedAt).not.toBeNull();
  }
  const answer = await f.submit(attempt);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe(readBeforeAnswer ? "no" : "yes");
});

it("keeps source-only excerpt exposure uncertain and does not contaminate a different page", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const exposures = createOpeningStudyExposureRepository(fixture.sql);
  await fixture.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${randomUUID()},${f.sourceId},1,2,'Unrelated page')`;
  await exposures.deliver(fixture.scope, { releaseKey: randomUUID(), contextAnchor: { purpose: "material_read", sourceId: f.sourceId, sourceVersion: 1, page: 2 },
    origin: "material_excerpt", kind: "hint", level: "hinted" });
  const answer = await f.submit(attempt);
  const before = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(before.observation, before.context).independentAttempt).toBe("yes");
  const next = await f.start({ problemId: attempt.problemId, problem: undefined });
  await exposures.deliver(fixture.scope, { releaseKey: randomUUID(), contextAnchor: { purpose: "material_read", sourceId: f.sourceId, sourceVersion: 1, chunkId: f.chunkId, page: 1 },
    origin: "material_excerpt", kind: "hint", level: "hinted" });
  const nextAnswer = await f.submit(next);
  const after = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, nextAnswer);
  expect(evaluateEvidenceEligibility(after.observation, after.context).independentAttempt).toBe("unknown");
});

it("retains an unknown legacy card source version without replacing it with the current version", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const receipt = await createOpeningStudyExposureRepository(fixture.sql).deliver(fixture.scope, {
    releaseKey: randomUUID(), contextAnchor: { purpose: "card_answer", courseId: f.courseId }, origin: "card_answer", kind: "solution", level: "revealed",
    originReference: { type: "card", id: randomUUID(), version: "1", skillLabel: "fractions", sourceRefs: [{ sourceId: f.sourceId, sourceVersion: null }] },
  });
  expect(receipt.contextAnchor.sourceVersion).toBeNull();
  const answer = await f.submit(attempt);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe("unknown");
});

it("keeps a generic note's possible open-attempt association uncertain and does not carry it to a future attempt", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  await createOpeningStudyExposureRepository(fixture.sql).deliver(fixture.scope, {
    releaseKey: randomUUID(), contextAnchor: { purpose: "note_read", attemptId: attempt.id }, origin: "note", kind: "hint", level: "hinted",
    originReference: { type: "note", id: randomUUID(), version: "1", possibleOpenAttemptOnly: true },
  });
  const first = await f.submit(attempt);
  const firstEvidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, first);
  expect(evaluateEvidenceEligibility(firstEvidence.observation, firstEvidence.context).independentAttempt).toBe("unknown");
  const next = await f.start({ problemId: attempt.problemId, problem: undefined });
  const second = await f.submit(next);
  const secondEvidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, second);
  expect(evaluateEvidenceEligibility(secondEvidence.observation, secondEvidence.context).independentAttempt).toBe("yes");
});


it.each(["math", "language"] as const)("keeps confirmed language help scoped to the actual %s target through the real submit service", async domain => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  if (domain === "language") await fixture.sql`UPDATE opening_learning_attempts SET requirement_key='language:reading:v1' WHERE id=${attempt.id}`;
  await createOpeningStudyExposureRepository(fixture.sql).deliver(fixture.scope, { releaseKey: randomUUID(),
    contextAnchor: { purpose: "language_support", attemptId: attempt.id }, origin: "assistant", kind: "hint", level: "hinted", supportDomain: "language" });
  const answer = await createOpeningAttemptService(fixture.sql).submit(fixture.scope, attempt.id, {
    clientKey: randomUUID(), answer: "1", outcome: "correct", assistance: "independent" });
  expect(answer.assistance).toBe(domain === "math" ? "independent" : "hinted");
  expect(answer.eligibility?.independentAttempt).toBe(domain === "math" ? "yes" : "no");
});

it("does not promote another question's help into the submitted attempt's declared assistance", async () => {
  const f = await learningAttemptFixture(fixture), helped = await f.start(), other = await f.start();
  await f.help(helped);
  const answer = await createOpeningAttemptService(fixture.sql).submit(fixture.scope, other.id, {
    clientKey: randomUUID(), answer: "1", outcome: "correct", assistance: "independent" });
  expect(answer.assistance).toBe("independent");
  expect(answer.eligibility?.independentAttempt).toBe("yes");
});


it("reads the actual attempt session's latest server intent for saved and ephemeral tutor paths", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const intents = createOpeningStudyIntentRepository(fixture.sql);
  const intent = { purpose: "review" as const, timeBudgetMinutes: 10, language: "en" as const, pace: "slow" as const,
    continuous: false, selfReportedFatigue: "unknown" as const, explanationStyle: "key_steps" as const };
  await intents.append(fixture.scope, { sessionId: f.sessionId, attemptId: attempt.id, clientKey: randomUUID(), change: { kind: "preference", intent } });
  const ambiguous = await intents.append(fixture.scope, { sessionId: f.sessionId, attemptId: attempt.id, clientKey: randomUUID(), change: { kind: "explicit_request", text: "串讲还是自学" } });
  expect(ambiguous.intent).toEqual(intent);
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "Owned session intent", courseId: f.courseId });
  const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id, text: "Continue", mode: "hint",
    clientKey: randomUUID(), sourceIds: [f.sourceId], learningSessionId: f.sessionId, attemptId: attempt.id, currentPage: null, chunkId: null });
  const turn = await createOpeningTutorJobsRepository(fixture.sql).getUserTurn(saved.turnId, fixture.scope.workspaceId);
  expect(turn?.studyIntent).toMatchObject({ id: ambiguous.id, action: "clarify_intent", intent });
  const resolver = createOpeningStudyContextRepository(fixture.sql);
  expect(await resolver.sessionIntent(fixture.scope, { purpose: "learning_help", attemptId: attempt.id })).toMatchObject({ id: ambiguous.id, intent });
  await expect(resolver.sessionIntent({ ...fixture.scope, ownerUserId: randomUUID() }, { purpose: "learning_help", attemptId: attempt.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("applies saved typed intent and answer reports once with an owned running lease, preserving newer preferences on replay", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const jobs = createOpeningTutorJobsRepository(fixture.sql), conversations = createOpeningConversationRepository(fixture.sql);
  const intents = createOpeningStudyIntentRepository(fixture.sql);
  const start = async (text: string, purpose?: "query" | "explain_state" | "plan") => {
    const conversation = await conversations.create(fixture.scope, { title: "Typed preferences", courseId: f.courseId });
    const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id, text, mode: "hint",
      clientKey: randomUUID(), sourceIds: [f.sourceId], learningSessionId: f.sessionId, attemptId: attempt.id, currentPage: null, chunkId: null, ...(purpose ? { purpose } : {}) });
    const claimed = await jobs.claim(saved.jobId);
    return { userTurnId: saved.turnId, jobId: saved.jobId, claimToken: claimed!.claimToken };
  };
  const carriedText = "【从学习界面带入的提问背景；尚未作为资料证据核验，也不表示我已掌握】\n抄了答案\n\n我的问题：\n慢一点，我是猜的";
  const typed = await start(carriedText);
  await expect(jobs.applyUserTurnIntent(fixture.scope, { ...typed, claimToken: randomUUID() })).rejects.toThrow("lease");
  expect(await intents.latest(fixture.scope, f.sessionId)).toBeNull();
  expect(await jobs.applyUserTurnIntent(fixture.scope, typed)).toMatchObject({ intent: { pace: "slow" } });
  expect((await jobs.getUserTurn(typed.userTurnId, fixture.scope.workspaceId))?.text).toBe(carriedText);
  expect(await intents.latest(fixture.scope, f.sessionId)).toMatchObject({ version: 1, signals: ["guessed"], attemptId: attempt.id });
  const newer = await intents.append(fixture.scope, { sessionId: f.sessionId, attemptId: attempt.id, clientKey: randomUUID(),
    change: { kind: "explicit_request", text: "用英文，快一点" } });
  expect(await jobs.applyUserTurnIntent(fixture.scope, typed)).toMatchObject({ intent: newer.intent });
  expect((await intents.latest(fixture.scope, f.sessionId))?.version).toBe(2);
  await jobs.applyUserTurnIntent(fixture.scope, await start("“我是猜的”是什么意思"));
  expect((await intents.latest(fixture.scope, f.sessionId))?.version).toBe(2);
  for (const purpose of ["query", "explain_state", "plan"] as const) {
    await expect(jobs.applyUserTurnIntent(fixture.scope, await start("快速串讲", purpose))).rejects.toThrow("composer purpose");
    expect((await intents.latest(fixture.scope, f.sessionId))?.version).toBe(2);
  }
  await jobs.applyUserTurnIntent(fixture.scope, await start("今天的天空很蓝"));
  expect((await intents.latest(fixture.scope, f.sessionId))?.version).toBe(2);
  expect(await jobs.applyUserTurnIntent(fixture.scope, await start("串讲还是自学"))).toMatchObject({ intent: newer.intent, action: "clarify_intent" });
  expect((await intents.latest(fixture.scope, f.sessionId))?.version).toBe(3);
  const context = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, await f.submit(attempt));
  expect(context.context.selfReportedAnswerConditions).toMatchObject({ reportedGuess: true });
});

it.each(["cancelled", "outcome_unknown"] as const)("keeps actually streamed help after a %s job, so the next submission is not independent", async terminal => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const conversations = createOpeningConversationRepository(fixture.sql), jobs = createOpeningTutorJobsRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "Partial streamed hint", courseId: f.courseId });
  const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: "给下一步提示", mode: "hint", clientKey: randomUUID(), sourceIds: [f.sourceId], learningSessionId: f.sessionId,
    attemptId: attempt.id, currentPage: 1, chunkId: f.chunkId });
  const claimed = await jobs.claim(saved.jobId);
  const exposure = await createOpeningStudyExposureRepository(fixture.sql).generate(fixture.scope, {
    releaseKey: `assistant:${saved.assistantTurnId}`, contextAnchor: { purpose: "learning_help", attemptId: attempt.id },
    origin: "assistant", turnId: saved.assistantTurnId, sessionId: f.sessionId, kind: "hint", level: "hinted",
  });
  const [workspace] = await fixture.sql`SELECT privacy_epoch FROM workspaces WHERE id=${fixture.scope.workspaceId}`;
  const context = { privacyEpoch: Number(workspace!.privacy_epoch), claimToken: claimed!.claimToken,
    contextSourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }], exposureReceiptId: exposure.id };
  expect(await jobs.readStream(fixture.otherScope, saved.jobId, context)).toBeNull();
  await expect(jobs.readStream(fixture.scope, saved.jobId, { ...context, privacyEpoch: context.privacyEpoch + 1 })).rejects.toThrow("authorization changed");
  expect((await fixture.sql`SELECT delivered FROM opening_help_exposures WHERE id=${exposure.id}`)[0]?.delivered).toBe(false);
  expect(await jobs.readStream(fixture.scope, saved.jobId, context)).toMatchObject({ status: "running" });
  const firstRelease = (await fixture.sql`SELECT released_at FROM opening_help_exposures WHERE id=${exposure.id}`)[0]?.released_at;
  expect(firstRelease).not.toBeNull();
  // Reconnection is a second actual delivery but must not move the first-exposure timestamp.
  await jobs.readStream(fixture.scope, saved.jobId, context);
  expect((await fixture.sql`SELECT released_at FROM opening_help_exposures WHERE id=${exposure.id}`)[0]?.released_at).toEqual(firstRelease);
  if (terminal === "cancelled") await jobs.cancel(fixture.scope, saved.jobId);
  else await jobs.markUnknown(fixture.scope, saved.jobId, "stream interrupted", claimed!.claimToken);
  expect(await jobs.readStream(fixture.scope, saved.jobId, context)).toMatchObject({ status: terminal });
  const reopened = await conversations.listTurns(fixture.scope, conversation.id);
  expect(reopened.find(turn => turn.id === saved.assistantTurnId)?.exposureReceipt?.releasedAt).not.toBeNull();
  expect((await fixture.sql`SELECT released_at FROM opening_help_exposures WHERE id=${exposure.id}`)[0]?.released_at).toEqual(firstRelease);
  const answer = await f.submit(attempt);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe("no");
});

it("does not release a generated stream after cancellation or material exclusion", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const conversations = createOpeningConversationRepository(fixture.sql), jobs = createOpeningTutorJobsRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "Unread streamed hint", courseId: f.courseId });
  const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: "提示", mode: "hint", clientKey: randomUUID(), sourceIds: [f.sourceId], learningSessionId: f.sessionId,
    attemptId: attempt.id, currentPage: 1, chunkId: f.chunkId });
  const claimed = await jobs.claim(saved.jobId);
  const exposure = await createOpeningStudyExposureRepository(fixture.sql).generate(fixture.scope, {
    releaseKey: `assistant:${saved.assistantTurnId}`, contextAnchor: { purpose: "learning_help", attemptId: attempt.id },
    origin: "assistant", turnId: saved.assistantTurnId, sessionId: f.sessionId, kind: "hint", level: "hinted",
  });
  const [workspace] = await fixture.sql`SELECT privacy_epoch FROM workspaces WHERE id=${fixture.scope.workspaceId}`;
  const context = { privacyEpoch: Number(workspace!.privacy_epoch), claimToken: claimed!.claimToken,
    contextSourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }], exposureReceiptId: exposure.id };
  await fixture.sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${f.sourceId}`;
  await expect(jobs.readStream(fixture.scope, saved.jobId, context)).rejects.toThrow("material unavailable");
  await fixture.sql`UPDATE opening_sources SET upload_state='uploaded' WHERE id=${f.sourceId}`;
  await jobs.cancel(fixture.scope, saved.jobId);
  expect(await jobs.readStream(fixture.scope, saved.jobId, context)).toMatchObject({ status: "cancelled" });
  await conversations.listTurns(fixture.scope, conversation.id);
  expect((await fixture.sql`SELECT delivered FROM opening_help_exposures WHERE id=${exposure.id}`)[0]?.delivered).toBe(false);
  const answer = await f.submit(attempt);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe("yes");
});


it("a pre-generated streaming receipt stays inert in pending history and releases only with completed answer delivery", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const conversations = createOpeningConversationRepository(fixture.sql), jobs = createOpeningTutorJobsRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "Streaming history", courseId: f.courseId });
  const saved = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: "提示", mode: "hint", clientKey: randomUUID(), sourceIds: [f.sourceId], learningSessionId: f.sessionId,
    attemptId: attempt.id, currentPage: 1, chunkId: f.chunkId });
  const claimed = await jobs.claim(saved.jobId);
  const generatedExposure = { releaseKey: `assistant:${saved.assistantTurnId}`,
    contextAnchor: { purpose: "learning_help" as const, attemptId: attempt.id }, origin: "assistant" as const,
    turnId: saved.assistantTurnId, sessionId: f.sessionId, kind: "hint" as const, level: "hinted" as const };
  const exposure = await createOpeningStudyExposureRepository(fixture.sql).generate(fixture.scope, generatedExposure);
  const pending = await conversations.listTurns(fixture.scope, conversation.id);
  expect(pending.find(turn => turn.id === saved.assistantTurnId)?.exposureReceipt?.releasedAt).toBeNull();
  await conversations.releaseReturnedTurnIds(fixture.scope, conversation.id, [saved.assistantTurnId]);
  expect((await fixture.sql`SELECT delivered FROM opening_help_exposures WHERE id=${exposure.id}`)[0]?.delivered).toBe(false);
  await jobs.completeTurn({ scope: fixture.scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId,
    text: "先把分母统一。", citations: [], candidates: [], claimToken: claimed!.claimToken,
    contextSourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }], generatedExposure });
  expect((await fixture.sql`SELECT delivered FROM opening_help_exposures WHERE id=${exposure.id}`)[0]?.delivered).toBe(false);
  const complete = await conversations.listTurns(fixture.scope, conversation.id);
  const delivered = complete.find(turn => turn.id === saved.assistantTurnId)?.exposureReceipt;
  expect(delivered?.releasedAt).not.toBeNull();
  const repeated = await conversations.listTurns(fixture.scope, conversation.id);
  expect(repeated.find(turn => turn.id === saved.assistantTurnId)?.exposureReceipt).toEqual(delivered);
});
