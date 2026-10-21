import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobStatusResponseSchema, turnRecordSchema } from "@aistudy/contracts";
import {
  createOpeningBudgetRepository,
  createOpeningConversationRepository,
  createOpeningSourceChunksRepository,
  createOpeningTutorJobsRepository,
  createSqlClient,
} from "@aistudy/database";
import { PAGE_CITATION_CLARIFY_MESSAGE, PageCitationClarifyError, TUTOR_FAILURE_MESSAGE } from "@aistudy/domain";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";

/**
 * LAB-A01/U01 clarify loop on real PostgreSQL (migrated through 0058). Uses
 * DATABASE_URL directly and seeds its own user/workspace, so it can run on a
 * scratch database without the opening-test-DB fixture.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the clarify loop test");

const sql = createSqlClient(databaseUrl, { max: 2 });
const userId = randomUUID();
const workspaceId = randomUUID();
const scope = { workspaceId, ownerUserId: userId };

beforeAll(async () => {
  await sql`INSERT INTO users (id, email, display_name, password_hash)
    VALUES (${userId}, ${`${userId}@example.com`}, 'Clarify loop', 'test')`;
  await sql`INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${userId})`;
});

afterAll(async () => {
  for (const table of ["opening_budget_reservations", "opening_tutor_jobs", "opening_turns", "opening_conversations"]) {
    await sql.unsafe(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
  }
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => undefined);
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => undefined);
  await sql.end({ timeout: 5 });
});

async function seedTurn() {
  const conversations = createOpeningConversationRepository(sql);
  const conversation = await conversations.create(scope, { title: "clarify loop", courseId: null });
  const saved = await conversations.appendSavedTurn({
    scope, conversationId: conversation.id, text: "第 3 页的公式怎么来的", mode: "explain",
    clientKey: `client-${randomUUID()}`, sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null,
  });
  return { conversationId: conversation.id, ...saved };
}

async function turnRow(id: string) {
  return (await sql<{ status: string; text: string }[]>`SELECT status, text FROM opening_turns WHERE id = ${id}`)[0];
}

describe("LAB-U01 clarify loop (real PostgreSQL)", () => {
  it("database accepts 'clarify' and still rejects unknown turn statuses", async () => {
    const { assistantTurnId } = await seedTurn();
    await expect(sql`UPDATE opening_turns SET status = 'refused' WHERE id = ${assistantTurnId}`).rejects.toThrow(/opening_turns_status_check/);
    await sql`UPDATE opening_turns SET status = 'clarify' WHERE id = ${assistantTurnId}`;
    expect((await turnRow(assistantTurnId))?.status).toBe("clarify");
  });

  it("worker refusal: job failed with {code,nextAction}, turn clarify, contract-valid on both read paths", async () => {
    const { conversationId, assistantTurnId, jobId } = await seedTurn();
    const tutorJobs = createOpeningTutorJobsRepository(sql);
    const provider = { complete: vi.fn() };
    const handler = createTutorTurnHandler({
      tutorJobs,
      chunks: createOpeningSourceChunksRepository(sql),
      budget: createOpeningBudgetRepository(sql, { envCapCents: 100_000 }),
      provider,
      config: { maxContextCharacters: 12_000, reservedCents: 100, maxOutputTokens: 2_048, inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
      // Throw the refusal inside the handler's try block (tip has no hard page guard).
      resolveModel: async () => { throw new PageCitationClarifyError(); },
    } as never);
    await expect(handler(jobId)).rejects.toBeInstanceOf(PageCitationClarifyError);
    expect(provider.complete).not.toHaveBeenCalled();

    const job = await tutorJobs.get(scope, jobId);
    expect(job).toMatchObject({ status: "failed" });
    const response = jobStatusResponseSchema.parse({ id: job!.id, status: job!.status, error: job!.error, updatedAt: job!.updatedAt });
    expect(response.error).toEqual({ message: PAGE_CITATION_CLARIFY_MESSAGE, code: "page_not_in_sources", nextAction: "clarify" });

    expect(await turnRow(assistantTurnId)).toEqual({ status: "clarify", text: PAGE_CITATION_CLARIFY_MESSAGE });
    const turns = await createOpeningConversationRepository(sql).listTurns(scope, conversationId);
    const parsed = turns.map((turn) => turnRecordSchema.parse(turn));
    expect(parsed.find((turn) => turn.id === assistantTurnId)).toMatchObject({ status: "clarify" });
    expect(await tutorJobs.findPendingForConversation(scope, conversationId)).toBeNull();
    await expect(handler(jobId)).resolves.toEqual({ skipped: true });
  });

  it("never rewrites a clarify turn from a stale-job sweep, a late failure or a cancel", async () => {
    const { assistantTurnId, jobId } = await seedTurn();
    const tutorJobs = createOpeningTutorJobsRepository(sql);
    await sql`UPDATE opening_tutor_jobs SET status = 'running' WHERE id = ${jobId}`;
    await tutorJobs.fail(scope, jobId, PAGE_CITATION_CLARIFY_MESSAGE, { code: "page_not_in_sources", nextAction: "clarify" });
    const stale = () => sql`UPDATE opening_tutor_jobs SET status = 'running', updated_at = now() - interval '10 minutes' WHERE id = ${jobId}`;
    await stale();
    await tutorJobs.markUnknown(scope, jobId, "provider outcome unknown");
    expect(await turnRow(assistantTurnId)).toEqual({ status: "clarify", text: PAGE_CITATION_CLARIFY_MESSAGE });
    await stale();
    await tutorJobs.fail(scope, jobId, "late failure");
    expect(await turnRow(assistantTurnId)).toEqual({ status: "clarify", text: PAGE_CITATION_CLARIFY_MESSAGE });
    await stale();
    await tutorJobs.cancel(scope, jobId);
    expect(await turnRow(assistantTurnId)).toEqual({ status: "clarify", text: PAGE_CITATION_CLARIFY_MESSAGE });
  });

  it("an ordinary failure still ends the turn as failed with a plain {message} error", async () => {
    const { assistantTurnId, jobId } = await seedTurn();
    const tutorJobs = createOpeningTutorJobsRepository(sql);
    await sql`UPDATE opening_tutor_jobs SET status = 'running' WHERE id = ${jobId}`;
    await tutorJobs.fail(scope, jobId, "provider rejected the request");
    expect((await turnRow(assistantTurnId))?.status).toBe("failed");
    expect((await tutorJobs.get(scope, jobId))?.error).toEqual({ message: TUTOR_FAILURE_MESSAGE });
  });
});
