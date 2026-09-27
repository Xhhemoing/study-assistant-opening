import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningProvider } from "@aistudy/ai";
import {
  createOpeningBudgetRepository,
  createOpeningConversationRepository,
  createOpeningMemoryRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceChunksRepository,
  createOpeningTutorJobsRepository,
} from "@aistudy/database";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

/** RP1: real Postgres + handler + adapter; fetch is the only mock. */
let fixture: OpeningFixture;
const SECRET_Q = "secret-prior-question-rp1";
const SECRET_A = "secret-prior-answer-rp1";
const CHUNK = "secret-chunk-text-rp1";
const ALLOWED = "allowed-chunk-text-rp1";
const FOLLOW = "follow-up-without-sources-rp1";
const SELECTED = "follow-up-selects-excluded-rp1";

beforeAll(async () => {
  fixture = await createOpeningFixture();
  const sql0023 = readFileSync(
    resolve("packages/database/src/migrations/0023_opening_memory_privacy_epoch.sql"),
    "utf8",
  );
  await fixture.sql.unsafe(sql0023);
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_privacy_exclusions, opening_memories RESTART IDENTITY CASCADE`;
  await fixture.sql`UPDATE workspaces SET privacy_epoch = 0 WHERE id = ${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });

async function seedSourceTurn(text: string, sourceIds: string[]) {
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "rp1", courseId: null });
  const saved = await conversations.appendSavedTurn({
    scope: fixture.scope, conversationId: conversation.id, text, mode: "explain",
    clientKey: randomUUID(), sourceIds, learningSessionId: null, currentPage: null, chunkId: null,
  });
  return { conversationId: conversation.id, ...saved };
}

async function seedPriorExchange() {
  const sourceId = randomUUID();
  await fixture.sql`
    INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'secret.pdf', 'application/pdf', 64,
      ${"b".repeat(64)}, 0, 'uploaded', 'ready')`;
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  await chunks.replaceChunks(fixture.scope, {
    sourceId, sourceVersion: 0,
    chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: CHUNK, imageObjectKey: null }],
  });
  const prior = await seedSourceTurn(SECRET_Q, [sourceId]);
  await fixture.sql`UPDATE opening_turns SET created_at = now() - interval '1 hour' WHERE id IN (${prior.turnId}, ${prior.assistantTurnId})`;
  await fixture.sql`UPDATE opening_turns SET status='complete', text=${SECRET_A} WHERE id=${prior.assistantTurnId}`;
  await fixture.sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${prior.jobId}`;
  return { sourceId, conversationId: prior.conversationId, priorTurnId: prior.turnId };
}

function captureFetch() {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ text: "ok", citedChunkIds: [], candidates: [] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    }));
  });
  return { bodies, fetchImpl };
}

function handler(fetchImpl: typeof fetch) {
  return createTutorTurnHandler({
    tutorJobs: createOpeningTutorJobsRepository(fixture.sql),
    chunks: createOpeningSourceChunksRepository(fixture.sql),
    budget: createOpeningBudgetRepository(fixture.sql, { dailyCapCents: 100_000 }),
    provider: createOpeningProvider({
      baseUrl: "https://offline.invalid", apiKey: "fake", model: "fake", fetchImpl,
    }),
    privacy: createOpeningPrivacyRepository(fixture.sql),
    config: {
      maxContextCharacters: 12_000, reservedCents: 100, maxOutputTokens: 256,
      inputCentsPerMillion: 100, outputCentsPerMillion: 200,
    },
  });
}

describe("RP1 provider input privacy (guarded)", () => {
  it("sends prior secret history before exclusion and drops it after deleteMemory", async () => {
    const { sourceId, conversationId, priorTurnId } = await seedPriorExchange();
    const baseline = await seedSourceTurn("baseline-question-rp1", []);
    await fixture.sql`UPDATE opening_turns SET conversation_id = ${conversationId} WHERE id IN (${baseline.turnId}, ${baseline.assistantTurnId})`;
    await fixture.sql`UPDATE opening_tutor_jobs SET conversation_id = ${conversationId} WHERE id = ${baseline.jobId}`;
    const before = captureFetch();
    await expect(handler(before.fetchImpl)(baseline.jobId)).resolves.toEqual({ skipped: false });
    expect(before.fetchImpl).toHaveBeenCalledTimes(1);
    expect(before.bodies[0]).toContain(SECRET_Q);
    expect(before.bodies[0]).toContain(SECRET_A);
    expect(before.bodies[0]).toContain("baseline-question-rp1");

    const memories = createOpeningMemoryRepository(fixture.sql);
    const proposed = await memories.proposeMemory(fixture.scope, {
      text: "privacy marker", sourceTurnIds: [priorTurnId], expiresAt: null,
    });
    const receipt = await memories.deleteMemory(fixture.scope, {
      id: proposed.id, expectedVersion: proposed.version, deleteSourceText: false, clientKey: randomUUID(),
    });
    expect(receipt.excludedSourceIds).toEqual([sourceId]);
    expect(await createOpeningPrivacyRepository(fixture.sql).isSourceExcluded(fixture.scope, sourceId)).toBe(true);

    const follow = await seedSourceTurn(FOLLOW, []);
    await fixture.sql`UPDATE opening_turns SET conversation_id = ${conversationId} WHERE id IN (${follow.turnId}, ${follow.assistantTurnId})`;
    await fixture.sql`UPDATE opening_tutor_jobs SET conversation_id = ${conversationId} WHERE id = ${follow.jobId}`;
    const after = captureFetch();
    await expect(handler(after.fetchImpl)(follow.jobId)).resolves.toEqual({ skipped: false });
    expect(after.fetchImpl).toHaveBeenCalledTimes(1);
    expect(after.bodies[0]).toContain(FOLLOW);
    expect(after.bodies[0]).not.toContain(SECRET_Q);
    expect(after.bodies[0]).not.toContain(SECRET_A);
    expect(after.bodies[0]).not.toContain(CHUNK);
    const done = await fixture.sql`SELECT status FROM opening_tutor_jobs WHERE id = ${follow.jobId}`;
    expect(done[0].status).toBe("succeeded");
  });

  it("does not send chunks of an excluded source selected beside an allowed source", async () => {
    const { sourceId, conversationId, priorTurnId } = await seedPriorExchange();
    const allowedId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${allowedId}, ${fixture.scope.workspaceId}, 'open.pdf', 'application/pdf', 64,
        ${"c".repeat(64)}, 0, 'uploaded', 'ready')`;
    await createOpeningSourceChunksRepository(fixture.sql).replaceChunks(fixture.scope, {
      sourceId: allowedId, sourceVersion: 0,
      chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: ALLOWED, imageObjectKey: null }],
    });
    const memories = createOpeningMemoryRepository(fixture.sql);
    const proposed = await memories.proposeMemory(fixture.scope, {
      text: "privacy marker", sourceTurnIds: [priorTurnId], expiresAt: null,
    });
    await memories.deleteMemory(fixture.scope, {
      id: proposed.id, expectedVersion: proposed.version, deleteSourceText: false, clientKey: randomUUID(),
    });
    const follow = await seedSourceTurn(SELECTED, [sourceId, allowedId]);
    await fixture.sql`UPDATE opening_turns SET conversation_id = ${conversationId} WHERE id IN (${follow.turnId}, ${follow.assistantTurnId})`;
    await fixture.sql`UPDATE opening_tutor_jobs SET conversation_id = ${conversationId} WHERE id = ${follow.jobId}`;
    const captured = captureFetch();
    await expect(handler(captured.fetchImpl)(follow.jobId)).resolves.toEqual({ skipped: false });
    expect(captured.fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured.bodies[0]).toContain(SELECTED);
    expect(captured.bodies[0]).toContain(ALLOWED);
    expect(captured.bodies[0]).not.toContain(CHUNK);
    expect(captured.bodies[0]).not.toContain(SECRET_Q);
    expect(captured.bodies[0]).not.toContain(SECRET_A);
  });
});
