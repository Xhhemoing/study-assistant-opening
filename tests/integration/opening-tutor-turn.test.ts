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
  await fixture.sql`
    INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'synthetic.pdf', 'application/pdf', 209,
      ${"a".repeat(64)}, 0, 'uploaded', 'ready')
  `;
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

  it("retrieves the turn snapshot when the source has advanced since submission", async () => {
    const seeded = await seedConversationAndSource();
    const actualChunkId = (await fixture.sql`SELECT id FROM opening_source_chunks WHERE source_id = ${sourceId}`)[0].id as string;
    await fixture.sql`UPDATE opening_sources SET version = 1 WHERE id = ${sourceId}`;
    const { deps, provider } = buildDeps(actualChunkId);

    await createTutorTurnHandler(deps)(seeded.jobId);

    expect(provider.complete.mock.calls[0][0].chunks).toEqual([
      expect.objectContaining({ id: actualChunkId, sourceVersion: 0, text: chunk.text }),
    ]);
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

  it("persists delivered help exposure with the completed assistant turn", async () => {
    const seeded = await seedConversationAndSource();
    const sessionId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_learning_sessions
        (id, workspace_id, owner_user_id, course_id, skill_label)
      VALUES (${sessionId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${randomUUID()}, 'motion')
    `;
    await fixture.sql`
      UPDATE opening_turns
      SET learning_session_id = ${sessionId}
      WHERE id = ${seeded.turnId}
    `;
    const actualChunkId = (await fixture.sql`SELECT id FROM opening_source_chunks WHERE source_id = ${sourceId}`)[0].id as string;
    const { deps } = buildDeps(actualChunkId);

    await createTutorTurnHandler(deps)(seeded.jobId);

    const rows = await fixture.sql`
      SELECT e.session_id, e.turn_id, e.level, e.delivered, t.status AS turn_status
      FROM opening_help_exposures e
      JOIN opening_turns t ON t.id = e.turn_id
      WHERE e.session_id = ${sessionId}
    `;
    expect(rows).toEqual([{
      session_id: sessionId,
      turn_id: seeded.assistantTurnId,
      level: "revealed",
      delivered: true,
      turn_status: "complete",
    }]);
  });

  it("does not leave help exposure when exposure persistence fails after assistant update", async () => {
    const seeded = await seedConversationAndSource();
    const sessionId = randomUUID();
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'running' WHERE id = ${seeded.jobId}`;
    const repository = createOpeningTutorJobsRepository(fixture.sql);

    await expect(repository.completeTurn({
      scope: fixture.scope,
      jobId: seeded.jobId,
      assistantTurnId: seeded.assistantTurnId,
      text: "hint",
      citations: [],
      candidates: [],
      helpExposure: {
        id: randomUUID(),
        sessionId,
        problemId: null,
        turnId: seeded.assistantTurnId,
        level: "hinted",
        delivered: true,
      },
    })).rejects.toThrow("session not found");

    const job = await repository.get(fixture.scope, seeded.jobId);
    const turns = await fixture.sql`
      SELECT status, text FROM opening_turns WHERE id = ${seeded.assistantTurnId}
    `;
    const exposures = await fixture.sql`
      SELECT id FROM opening_help_exposures WHERE session_id = ${sessionId}
    `;
    expect(job?.status).toBe("running");
    expect(turns).toEqual([{ status: "pending", text: "" }]);
    expect(exposures).toHaveLength(0);
  });


  it("returns the original assistant turn when appending the same client key and canonical intent", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "replay", courseId: null });
    const input = {
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "same request",
      mode: "explain" as const,
      clientKey: `client-${randomUUID()}`,
      sourceIds: [],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    };
    const first = await conversations.appendSavedTurn(input);
    const replay = await conversations.appendSavedTurn(input);
    expect(replay).toEqual(first);
    expect(replay.assistantTurnId).not.toBe(replay.turnId);
    const turns = await fixture.sql`SELECT id, role FROM opening_turns WHERE id IN (${replay.turnId}, ${replay.assistantTurnId}) ORDER BY role`;
    expect(turns).toEqual([
      { id: replay.assistantTurnId, role: "assistant" },
      { id: replay.turnId, role: "user" },
    ]);
  });

  it("rejects a client-key replay when the saved intent changes", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "conflict", courseId: null });
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'synthetic.pdf', 'application/pdf', 209,
        ${"a".repeat(64)}, 0, 'uploaded', 'ready')
    `;
    const input = {
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "same request",
      mode: "explain" as const,
      clientKey: `client-${randomUUID()}`,
      sourceIds: [],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    };
    await conversations.appendSavedTurn(input);

    await expect(conversations.appendSavedTurn({ ...input, text: "changed request" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(conversations.appendSavedTurn({ ...input, mode: "hint" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(conversations.appendSavedTurn({ ...input, sourceIds: [sourceId] })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects every replay of a legacy client-key turn with a null intent hash", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "legacy replay", courseId: null });
    const input = {
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "legacy request",
      mode: "explain" as const,
      clientKey: `client-${randomUUID()}`,
      sourceIds: [],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    };
    const saved = await conversations.appendSavedTurn(input);
    await fixture.sql`UPDATE opening_turns SET intent_hash = NULL WHERE id = ${saved.turnId}`;

    await expect(conversations.appendSavedTurn(input)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(conversations.appendSavedTurn({ ...input, text: "changed legacy request" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a source that belongs to another workspace", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "ownership", courseId: null });
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.otherScope.workspaceId}, 'other.pdf', 'application/pdf', 209,
        ${"b".repeat(64)}, 0, 'uploaded', 'ready')
    `;

    await expect(conversations.appendSavedTurn({
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "cross-workspace source",
      mode: "explain",
      clientKey: `client-${randomUUID()}`,
      sourceIds: [sourceId],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serializes concurrent appends for one client key", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "concurrent", courseId: null });
    const input = {
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "same request",
      mode: "explain" as const,
      clientKey: `client-${randomUUID()}`,
      sourceIds: [],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    };
    const [first, second] = await Promise.all([
      conversations.appendSavedTurn(input),
      conversations.appendSavedTurn(input),
    ]);
    expect(second).toEqual(first);
    const rows = await fixture.sql`SELECT count(*)::int AS count FROM opening_turns WHERE workspace_id = ${fixture.scope.workspaceId} AND client_key = ${input.clientKey}`;
    expect(rows[0].count).toBe(1);
  });

  it("does not return a job when its conversation owner changes", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "job ownership", courseId: null });
    const saved = await conversations.appendSavedTurn({
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "owned question",
      mode: "explain",
      clientKey: `client-${randomUUID()}`,
      sourceIds: [],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    });
    await fixture.sql`
      UPDATE opening_conversations
      SET owner_user_id = ${randomUUID()}
      WHERE id = ${conversation.id}
    `;

    await expect(
      createOpeningTutorJobsRepository(fixture.sql).get(fixture.scope, saved.jobId),
    ).resolves.toBeNull();
  });

  it("rejects an uploaded source that is not parse-ready", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "not ready", courseId: null });
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'pending-parse.pdf', 'application/pdf', 209,
        ${"a".repeat(64)}, 0, 'uploaded', 'running')
    `;

    await expect(conversations.appendSavedTurn({
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "use pending source",
      mode: "explain",
      clientKey: `client-${randomUUID()}`,
      sourceIds: [sourceId],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a source that is parse-ready but no longer uploaded", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "revoked source", courseId: null });
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'revoked.pdf', 'application/pdf', 209,
        ${"a".repeat(64)}, 0, 'rejected', 'ready')
    `;

    await expect(conversations.appendSavedTurn({
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "use revoked source",
      mode: "explain",
      clientKey: `client-${randomUUID()}`,
      sourceIds: [sourceId],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("snapshots owned source versions on the server, ignoring a client version hint", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "source snapshot", courseId: null });
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'synthetic.pdf', 'application/pdf', 209,
        ${"a".repeat(64)}, 7, 'uploaded', 'ready')
    `;
    const input = {
      scope: fixture.scope,
      conversationId: conversation.id,
      text: "versioned request",
      mode: "explain" as const,
      clientKey: `client-${randomUUID()}`,
      sourceIds: [sourceId],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    } as Parameters<typeof conversations.appendSavedTurn>[0] & { sourceVersion?: number };
    input.sourceVersion = 999;
    const saved = await conversations.appendSavedTurn(input);
    const rows = await fixture.sql`SELECT source_versions, intent_hash FROM opening_turns WHERE id = ${saved.turnId}`;
    expect(rows[0].source_versions).toEqual({ [sourceId]: 7 });
    expect(rows[0].intent_hash).toMatch(/^[a-f0-9]{64}$/);

    await fixture.sql`UPDATE opening_sources SET version = 8 WHERE id = ${sourceId}`;
    const replay = await conversations.appendSavedTurn(input);
    expect(replay).toEqual(saved);

    await expect(conversations.appendSavedTurn({ ...input, text: "changed versioned request" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(conversations.appendSavedTurn({ ...input, mode: "hint" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(conversations.appendSavedTurn({ ...input, sourceIds: [] })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails definitively on provider auth errors and releases the reservation", async () => {
    const seeded = await seedConversationAndSource();
    const { deps } = buildDeps(null, new OpeningProviderError("PROVIDER_AUTH", "bad key"));
    await expect(createTutorTurnHandler(deps)(seeded.jobId)).rejects.toThrow();
    const job = await deps.tutorJobs.get(fixture.scope, seeded.jobId);
    expect(job?.status).toBe("failed");
    const reservations = await fixture.sql`SELECT state FROM opening_budget_reservations WHERE workspace_id = ${fixture.scope.workspaceId}`;
    expect(reservations[0].state).toBe("released");
    const turns = await fixture.sql`SELECT status, text FROM opening_turns WHERE id = ${seeded.assistantTurnId}`;
    expect(turns[0]).toMatchObject({ status: "failed", text: "bad key" });
  });

  it("keeps outcome unknown and retains the reservation on provider timeouts", async () => {
    const seeded = await seedConversationAndSource();
    const { deps } = buildDeps(null, new OpeningProviderError("PROVIDER_TIMEOUT", "timed out", true));
    await expect(createTutorTurnHandler(deps)(seeded.jobId)).rejects.toThrow();
    const job = await deps.tutorJobs.get(fixture.scope, seeded.jobId);
    expect(job?.status).toBe("outcome_unknown");
    const reservations = await fixture.sql`SELECT state FROM opening_budget_reservations WHERE workspace_id = ${fixture.scope.workspaceId}`;
    expect(reservations[0].state).toBe("reserved");
    const turns = await fixture.sql`SELECT status, text FROM opening_turns WHERE id = ${seeded.assistantTurnId}`;
    expect(turns[0]).toMatchObject({
      status: "failed",
      text: "provider outcome unknown; usage reconciliation pending",
    });
  });

  it("fails content-free when every requested source vanished", async () => {
    const conversations = createOpeningConversationRepository(fixture.sql);
    const conversation = await conversations.create(fixture.scope, { title: "ghost sources", courseId: null });
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'synthetic.pdf', 'application/pdf', 209,
        ${"a".repeat(64)}, 0, 'uploaded', 'ready')
    `;
    const saved = await conversations.appendSavedTurn({
      scope: fixture.scope, conversationId: conversation.id, text: "hello",
      mode: "explain", clientKey: `client-${randomUUID()}`, sourceIds: [sourceId],
      learningSessionId: null, currentPage: null, chunkId: null,
    });
    await fixture.sql`UPDATE opening_sources SET upload_state = 'rejected', parse_state = 'failed' WHERE id = ${sourceId}`;
    const { deps } = buildDeps(null);
    await expect(createTutorTurnHandler(deps)(saved.jobId)).rejects.toThrow(/unavailable/);
    const job = await deps.tutorJobs.get(fixture.scope, saved.jobId);
    expect(job?.status).toBe("failed");
  });
});
