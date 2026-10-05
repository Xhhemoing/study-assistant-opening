import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningBudgetRepository, createOpeningConversationRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import { OpeningProviderError } from "@aistudy/ai";
import type { LearningObservation } from "@aistudy/contracts";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST as createAttempt } from "../../../apps/web/src/app/api/opening/attempts/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { POST as submitTurn } from "../../../apps/web/src/app/api/opening/turns/route";
import { createTutorTurnHandler, type TutorTurnDeps } from "../../../apps/worker/src/jobs/tutor-turn";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { learningAttemptFixture } from "../opening-learning-attempt-fixture";
let fixture: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600 });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await fixture?.close(); });
const req = (body: unknown, cookie = fixture.cookie) => new Request("http://localhost/api/opening/attempts", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const answer = () => ({ clientKey: randomUUID(), answer: "1", outcome: "correct", assistance: "independent" });
function tutorHandler(chunkId: string, provider: TutorTurnDeps["provider"] = {
  complete: async () => ({ text: "Start with the common denominator", citedChunkIds: [chunkId], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 }),
}) {
  return createTutorTurnHandler({
    tutorJobs: createOpeningTutorJobsRepository(fixture.sql), chunks: createOpeningSourceChunksRepository(fixture.sql),
    budget: createOpeningBudgetRepository(fixture.sql, { dailyCapCents: 100_000 }), provider,
    config: { maxContextCharacters: 12000, reservedCents: 10, maxOutputTokens: 1000, inputCentsPerMillion: 100, outputCentsPerMillion: 100 },
  });
}
it("starts and submits server-owned attempts, preserving replay and refusing client qualification", async () => {
  const f = await learningAttemptFixture(fixture), input = { sessionId: f.sessionId, clientKey: randomUUID(),
    problem: { sourceId: f.sourceId, chunkId: f.chunkId, physicalPage: 1, stemSnapshot: "1/2 + 1/2?", artifactKind: "reference_item" } };
  const start = await createAttempt(req(input)); expect(start.status).toBe(201);
  const attempt = await start.json(); expect(attempt.itemVersionId).toBeTruthy();
  expect((await createAttempt(req(input, ""))).status).toBe(401);
  expect((await createAttempt(req({ ...input, startedAt: "2026-01-01T00:00:00Z" }))).status).toBe(400);
  const body = answer(), response = await submitAttempt(req(body), params(attempt.id));
  expect(response.status).toBe(201); const observation = await response.json();
  expect(observation.attemptId).toBe(attempt.id); expect(observation.eligibility.verifiedCorrect).toBe("unknown");
  expect(await (await submitAttempt(req(body), params(attempt.id))).json()).toMatchObject({ id: observation.id });
  expect((await submitAttempt(req({ ...body, eligibility: { verifiedCorrect: "yes" } }), params(attempt.id))).status).toBe(400);
  expect((await submitAttempt(req(body), params(randomUUID()))).status).toBe(404);
});
it.each(["hint", "explain"] as const)("records %s delivery through the actual tutor service and terminal transaction", async (mode) => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const conversation = await createOpeningConversationRepository(fixture.sql).create(fixture.scope, { title: "Attempt help", courseId: f.courseId });
  const response = await submitTurn(req({ conversationId: conversation.id, text: "Help with this problem", sourceIds: [f.sourceId], mode, privacy: "saved",
    learningSessionId: f.sessionId, attemptId: attempt.id, clientKey: randomUUID(), currentPage: 1, chunkId: f.chunkId }));
  expect(response.status).toBe(201); const job = await response.json() as { jobId: string };
  const handler = tutorHandler(f.chunkId);
  await handler(job.jobId);
  await expect(handler(job.jobId)).resolves.toEqual({ skipped: true });
  const helpRows = await fixture.sql`SELECT h.*,t.status FROM opening_help_exposures h JOIN opening_turns t ON t.id=h.turn_id WHERE h.attempt_id=${attempt.id}`;
  expect(helpRows).toHaveLength(1);
  expect(helpRows[0]).toMatchObject({ session_id: f.sessionId, attempt_id: attempt.id, problem_id: attempt.problemId,
    level: mode === "hint" ? "hinted" : "revealed", delivered: true, status: "complete" });
  expect(helpRows[0]?.delivered_at).toBeTruthy();
  const observation = await submitAttempt(req(answer()), params(attempt.id));
  expect(observation.status).toBe(201);
  const body = await observation.json() as LearningObservation;
  expect(body.assistance).toBe("independent");
  expect(body.eligibility).toMatchObject({ independentAttempt: "no", verifiedCorrect: "unknown", reasonCodes: expect.arrayContaining(["help_before_submission"]) });

  const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId] });
  const freshAttempt = await f.start({ sessionId: session.id });
  const fresh = await submitAttempt(req(answer()), params(freshAttempt.id));
  expect(fresh.status).toBe(201);
  expect((await fresh.json() as LearningObservation).eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "unknown" });
});
it.each(["PROVIDER_AUTH", "PROVIDER_TIMEOUT"])("does not record delivered help for %s failures", async (code) => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const conversation = await createOpeningConversationRepository(fixture.sql).create(fixture.scope, { title: "Failed help", courseId: f.courseId });
  const response = await submitTurn(req({ conversationId: conversation.id, text: "Give one hint", sourceIds: [f.sourceId], mode: "hint", privacy: "saved",
    learningSessionId: f.sessionId, attemptId: attempt.id, clientKey: randomUUID(), currentPage: 1, chunkId: f.chunkId }));
  expect(response.status).toBe(201);
  const { jobId } = await response.json() as { jobId: string };
  const failure = new OpeningProviderError(code, "provider failed", code === "PROVIDER_TIMEOUT");
  await expect(tutorHandler(f.chunkId, { complete: async () => { throw failure; } })(jobId)).rejects.toBe(failure);
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE session_id=${f.sessionId}`).toHaveLength(0);
  const job = await createOpeningTutorJobsRepository(fixture.sql).get(fixture.scope, jobId);
  expect(job?.status).toBe(code === "PROVIDER_AUTH" ? "failed" : "outcome_unknown");
  const [turn] = await fixture.sql`SELECT status FROM opening_turns WHERE id=${job!.assistantTurnId}`;
  expect(turn?.status).toBe(job?.status);
  const submitted = await submitAttempt(req(answer()), params(attempt.id));
  expect(submitted.status).toBe(201);
  expect((await submitted.json() as LearningObservation).eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "unknown" });
});

it.each(["listen", "think_together"] as const)("does not attach a learning session or help exposure in %s mode", async (mode) => {
  const f = await learningAttemptFixture(fixture);
  const conversation = await createOpeningConversationRepository(fixture.sql).create(fixture.scope, { title: "Conversation only", courseId: f.courseId });
  const response = await submitTurn(req({ conversationId: conversation.id, text: "Talk through the context", sourceIds: [f.sourceId], mode, privacy: "saved",
    learningSessionId: f.sessionId, clientKey: randomUUID(), currentPage: 1, chunkId: f.chunkId }));
  expect(response.status).toBe(201);
  const body = await response.json() as { jobId: string };
  await tutorHandler(f.chunkId)(body.jobId);
  expect(await fixture.sql`SELECT learning_session_id FROM opening_turns WHERE conversation_id=${conversation.id}`)
    .toEqual([{ learning_session_id: null }, { learning_session_id: null }]);
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
});

it.each(["other_course", "unassigned", "session_only"])("refuses %s conversations for attempt help without leaving work", async (kind) => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const conversation = await createOpeningConversationRepository(fixture.sql).create(fixture.scope, {
    title: "Wrong attempt course", courseId: kind === "unassigned" ? null : randomUUID(),
  });
  const response = await submitTurn(req({ conversationId: conversation.id, text: "Give a hint", sourceIds: [f.sourceId], mode: "hint", privacy: "saved",
    learningSessionId: f.sessionId, ...(kind === "session_only" ? {} : { attemptId: attempt.id }), clientKey: randomUUID(), currentPage: 1, chunkId: f.chunkId }));
  expect(response.status).toBe(400);
  expect(await fixture.sql`SELECT id FROM opening_turns WHERE conversation_id=${conversation.id}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_tutor_jobs WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE attempt_id=${attempt.id}`).toHaveLength(0);
});
