import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningProvider, OpeningProviderError } from "@aistudy/ai";
import {
  createOpeningBudgetRepository,
  createOpeningCandidateRepository,
  createOpeningConversationRepository,
  createOpeningSourceChunksRepository,
  createOpeningTutorJobsRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";

/**
 * Guarded durable-tutor-path gate (plan 03-tutor.md): real PostgreSQL, fake
 * provider (test-only, no network). Proves the saved-conversation vertical:
 * appendSavedTurn -> tutor job -> handler -> assistant turn + candidates.
 */
let fixture: OpeningFixture;

const sourceId = "7f0e0f10-0000-4000-8000-000000000001";
const chunkId = "7f0e0f10-0000-4000-8000-000000000002";
const chunk = { id: chunkId, sourceId, sourceVersion: 0, page: 1, slideLabel: null, startMs: null, endMs: null, text: "Newton wrote the laws of motion on this page", imageObjectKey: null };

async function seedConversationAndSource() {
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "tutor gate", courseId: null });
  // Prior completed exchange must reach the real provider HTTP body as history.
  const prior = await conversations.appendSavedTurn({
    scope: fixture.scope,
    conversationId: conversation.id,
    text: "what did we cover yesterday",
    mode: "explain",
    clientKey: `client-${randomUUID()}`,
    sourceIds: [],
    learningSessionId: null,
    currentPage: null,
    chunkId: null,
  });
  await fixture.sql`UPDATE opening_turns SET created_at = now() - interval '1 hour' WHERE id IN (${prior.turnId}, ${prior.assistantTurnId})`;
  await fixture.sql`UPDATE opening_turns SET status='complete', text='we covered inertia' WHERE id=${prior.assistantTurnId}`;
  await fixture.sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${prior.jobId}`;
  const saved = await conversations.appendSavedTurn({
    scope: fixture.scope,
    conversationId: conversation.id,
    text: "explain the laws of motion",
    mode: "explain",
    clientKey: `client-${randomUUID()}`,
    sourceIds: [sourceId],
    learningSessionId: null,
    currentPage: 1,
    chunkId,
  });
  await fixture.sql`
    INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'synthetic.pdf', 'application/pdf', 209,
      ${"a".repeat(64)}, 0, 'uploaded', 'ready')
  `;
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  await chunks.replaceChunks(fixture.scope, { sourceId, sourceVersion: 0, chunks: [chunk] });
  return { conversationId: conversation.id, ...saved };
}

function buildDeps(citedChunkId: string | null, providerError?: Error) {
  const provider = {
    complete: vi.fn(async () => {
      if (providerError) throw providerError;
      return {
        text: "The laws of motion are F = ma.",
        citedChunkIds: citedChunkId ? [citedChunkId] : [],
        requestId: null,
        candidates: [{ kind: "memory", text: "Learner is studying Newton's laws", temporary: false }],
        inputTokens: 100,
        outputTokens: 50,
      };
    }),
  };
  const deps = {
    tutorJobs: createOpeningTutorJobsRepository(fixture.sql),
    chunks: createOpeningSourceChunksRepository(fixture.sql),
    budget: createOpeningBudgetRepository(fixture.sql, { dailyCapCents: 100_000 }),
    provider,
    config: { maxContextCharacters: 12_000, reservedCents: 100, maxOutputTokens: 2_048, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
  };
  return { deps, provider };
}

beforeAll(async () => {
  fixture = await createOpeningFixture();
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await fixture?.close();
});

describe("opening tutor turn durable path (guarded)", () => {
  it("persists the assistant turn and pending candidates exactly once", async () => {
    const seeded = await seedConversationAndSource();
    const actualChunkId = (await fixture.sql`SELECT id FROM opening_source_chunks WHERE source_id = ${sourceId}`)[0].id as string;
    const { deps, provider } = buildDeps(actualChunkId);
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // Prove server history reached the real adapter HTTP body (fetch-only mock).
      // messages[0]=system, then prior user/assistant, then current question+chunks.
      expect(body.messages[0].role).toBe("system");
      expect(body.messages.slice(1, 3)).toEqual([
        { role: "user", content: "what did we cover yesterday" },
        { role: "assistant", content: "we covered inertia" },
      ]);
      expect(body.messages[3].content).toContain("explain the laws of motion");
      expect(body.messages[3].content).toContain("Newton wrote the laws of motion");
      expect(body.messages[3].content).toContain(actualChunkId);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          text: "The laws of motion are F = ma.", citedChunkIds: [actualChunkId],
          candidates: [{ kind: "memory", text: "Learner is studying Newton's laws", temporary: false }],
        }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 },
      }));
    });
    const adapter = createOpeningProvider({ baseUrl: "https://offline.invalid", apiKey: "fake", model: "fake", fetchImpl });
    // Only the network is replaced: exercise worker, real adapter and real DB together.
    const result = await createTutorTurnHandler({ ...deps, provider: adapter })(seeded.jobId);
    expect(result).toEqual({ skipped: false });

    const job = await deps.tutorJobs.get(fixture.scope, seeded.jobId);
    expect(job?.status).toBe("succeeded");
    const turns = await fixture.sql`SELECT role, text, status FROM opening_turns WHERE id = ${seeded.assistantTurnId}`;
    expect(turns[0]).toMatchObject({ role: "assistant", text: "The laws of motion are F = ma.", status: "complete" });
    const persistedCitations = await fixture.sql`SELECT citations FROM opening_turns WHERE id = ${seeded.assistantTurnId}`;
    expect(persistedCitations[0].citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ chunkId: actualChunkId, sourceId }),
    ]));
    const candidates = await fixture.sql`SELECT source_turn_id, source_ids, status, payload FROM opening_assistant_candidates WHERE workspace_id = ${fixture.scope.workspaceId}`;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source_turn_id: seeded.assistantTurnId, status: "pending" });
    expect(candidates[0].source_ids).toEqual([sourceId]);
    expect(candidates[0].payload).toMatchObject({ kind: "memory" });

    const listPending = await createOpeningCandidateRepository(fixture.sql).listPending(fixture.scope);
    expect(listPending).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("skips redelivery without re-persisting a second candidate", async () => {
    const seeded = await seedConversationAndSource();
    const actualChunkId = (await fixture.sql`SELECT id FROM opening_source_chunks WHERE source_id = ${sourceId}`)[0].id as string;
    const { deps } = buildDeps(actualChunkId);
    await createTutorTurnHandler(deps)(seeded.jobId);
    const second = createTutorTurnHandler(deps);
    await expect(second(seeded.jobId)).resolves.toEqual({ skipped: true });
    const candidates = await fixture.sql`SELECT count(*)::int AS count FROM opening_assistant_candidates WHERE workspace_id = ${fixture.scope.workspaceId}`;
    expect(candidates[0].count).toBe(1);
  });

  it("fails definitively on provider auth errors and releases the reservation", async () => {
    const seeded = await seedConversationAndSource();
    const { deps } = buildDeps(null, new OpeningProviderError("PROVIDER_AUTH", "bad key"));
    await expect(createTutorTurnHandler(deps)(seeded.jobId)).rejects.toThrow();
    const job = await deps.tutorJobs.get(fixture.scope, seeded.jobId);
    expect(job?.status).toBe("failed");
    const reservations = await fixture.sql`SELECT state FROM opening_budget_reservations WHERE workspace_id = ${fixture.scope.workspaceId}`;
    expect(reservations[0].state).toBe("released");
    const turns = await fixture.sql`SELECT status FROM opening_turns WHERE id = ${seeded.assistantTurnId}`;
    expect(turns[0].status).toBe("pending");
  });

  it("keeps outcome unknown and retains the reservation on provider timeouts", async () => {
    const seeded = await seedConversationAndSource();
    const { deps } = buildDeps(null, new OpeningProviderError("PROVIDER_TIMEOUT", "timed out", true));
    await expect(createTutorTurnHandler(deps)(seeded.jobId)).rejects.toThrow();
    const job = await deps.tutorJobs.get(fixture.scope, seeded.jobId);
    expect(job?.status).toBe("outcome_unknown");
    const reservations = await fixture.sql`SELECT state FROM opening_budget_reservations WHERE workspace_id = ${fixture.scope.workspaceId}`;
    expect(reservations[0].state).toBe("reserved");
  });

  it("fails content-free when every requested source vanished", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "ghost sources", courseId: null });
    const saved = await conversations.appendSavedTurn({
      scope: fixture.scope, conversationId: conversation.id, text: "hello",
      mode: "explain", clientKey: `client-${randomUUID()}`, sourceIds: [sourceId],
      learningSessionId: null, currentPage: null, chunkId: null,
    });
    const { deps } = buildDeps(null);
    await expect(createTutorTurnHandler(deps)(saved.jobId)).rejects.toThrow(/unavailable/);
    const job = await deps.tutorJobs.get(fixture.scope, saved.jobId);
    expect(job?.status).toBe("failed");
  });
});
