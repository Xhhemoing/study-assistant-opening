import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpeningConversationRepository,
  createOpeningTutorJobsRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { TUTOR_FAILURE_MESSAGE, TUTOR_UNKNOWN_MESSAGE, TUTOR_CANCELLED_MESSAGE, PAGE_CITATION_CLARIFY_MESSAGE } from "@aistudy/domain";

let fixture: OpeningFixture;

beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { await fixture?.close(); });

async function seedConversation() {
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "unknown recovery", courseId: null });
  const append = (text = "请解释这个概念") => conversations.appendSavedTurn({
    scope: fixture.scope,
    conversationId: conversation.id,
    text,
    mode: "explain",
    clientKey: `client-${randomUUID()}`,
    sourceIds: [],
    learningSessionId: null,
    currentPage: null,
    chunkId: null,
  });
  return { conversationId: conversation.id, append };
}

describe("tutor job recovery repository", () => {
  it.each([
    { jobStatus: "failed", turnStatus: "failed", detail: {}, message: TUTOR_FAILURE_MESSAGE },
    { jobStatus: "failed", turnStatus: "failed", detail: { code: "REQUEST_CAP_EXCEEDED" }, message: "该模型今天的请求次数已达上限；可在设置中为该用途指定备用模型。" },
    { jobStatus: "failed", turnStatus: "clarify", detail: { code: "page_not_in_sources", nextAction: "clarify" }, message: PAGE_CITATION_CLARIFY_MESSAGE },
    { jobStatus: "outcome_unknown", turnStatus: "outcome_unknown", detail: {}, message: TUTOR_UNKNOWN_MESSAGE },
    { jobStatus: "outcome_unknown", turnStatus: "pending", detail: {}, message: TUTOR_UNKNOWN_MESSAGE },
    { jobStatus: "cancelled", turnStatus: "failed", detail: {}, message: TUTOR_CANCELLED_MESSAGE },
  ])("hides legacy $jobStatus/$turnStatus diagnostics at job, history and preview reads without rewriting storage", async ({ jobStatus, turnStatus, detail, message }) => {
    const diagnostic = "SQL SELECT credential FROM private at /server/secret.ts:4";
    const { conversationId, append } = await seedConversation();
    const saved = await append(diagnostic);
    await fixture.sql`UPDATE opening_tutor_jobs SET status=${jobStatus}, error=${fixture.sql.json({ message: diagnostic, ...detail })} WHERE id=${saved.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status=${turnStatus}, text=${diagnostic}, created_at=now()+interval '1 second' WHERE id=${saved.assistantTurnId}`;
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const conversations = createOpeningConversationRepository(fixture.sql);

    expect((await jobs.get(fixture.scope, saved.jobId))?.error?.message).toBe(message);
    const turns = await conversations.listTurns(fixture.scope, conversationId);
    expect(turns.find(turn => turn.id === saved.assistantTurnId)).toMatchObject({ text: message, status: turnStatus });
    // A user's technical question is their content, never treated as an exception by string matching.
    expect(turns.find(turn => turn.id === saved.turnId)?.text).toBe(diagnostic);
    const summary = (await conversations.listSummaries(fixture.scope)).find(item => item.id === conversationId)!;
    expect(summary.lastTurnPreview).not.toContain(diagnostic);
    expect(summary.lastTurnPreview).toBe(turnStatus === "failed" && jobStatus !== "cancelled" ? TUTOR_FAILURE_MESSAGE : message);
    expect(await conversations.loadContinuityTurns(fixture.scope, conversationId)).toEqual([
      { id: saved.turnId, role: "user", text: diagnostic, citations: [] },
      ...(turnStatus === "pending" ? [{ id: saved.assistantTurnId, role: "assistant", text: message, citations: [] }] : []),
    ]);
    if (jobStatus === "outcome_unknown") expect(await jobs.findPendingForConversation(fixture.scope, conversationId))
      .toMatchObject({ id: saved.jobId, status: "outcome_unknown", error: { message: TUTOR_UNKNOWN_MESSAGE } });
    expect(await jobs.get(fixture.otherScope, saved.jobId)).toBeNull();
    await expect(conversations.listTurns(fixture.otherScope, conversationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await fixture.sql`SELECT text FROM opening_turns WHERE id=${saved.assistantTurnId}`)[0]?.text).toBe(diagnostic);
  });

  it("preserves successful model and user text even when it looks like a technical exception", async () => {
    const text = "Error: SELECT examples FROM tutorial at /example.ts:1";
    const { conversationId, append } = await seedConversation();
    const saved = await append(text);
    await fixture.sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${saved.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status='complete', text=${text}, created_at=now()+interval '1 second' WHERE id=${saved.assistantTurnId}`;
    const conversations = createOpeningConversationRepository(fixture.sql);
    expect((await conversations.listTurns(fixture.scope, conversationId)).map(turn => turn.text)).toEqual([text, text]);
    expect((await conversations.listSummaries(fixture.scope)).find(item => item.id === conversationId)?.lastTurnPreview).toBe(text);
    expect((await conversations.loadContinuityTurns(fixture.scope, conversationId)).map(turn => turn.text)).toEqual([text, text]);
  });

  it.each(["queued", "running"] as const)("restores the latest %s job with its pending assistant turn", async (status) => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    if (status === "running") await jobs.claim(saved.jobId);

    expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toMatchObject({
      id: saved.jobId, status, error: null,
    });
  });

  it("recovers an unknown job after markUnknown atomically terminates its assistant turn", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const claimed = await jobs.claim(saved.jobId);
    await jobs.markUnknown(fixture.scope, saved.jobId, "provider outcome unknown; usage reconciliation pending", claimed!.claimToken);
    const persisted = await jobs.get(fixture.scope, saved.jobId);

    expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toEqual({
      id: saved.jobId,
      status: "outcome_unknown",
      error: persisted!.error,
      updatedAt: persisted!.updatedAt,
    });
    const turns = await createOpeningConversationRepository(fixture.sql).listTurns(fixture.scope, conversationId);
    expect(turns.find((turn) => turn.id === saved.assistantTurnId)?.status).toBe("outcome_unknown");
  });

  it("still recovers a legacy unknown job whose assistant turn is pending", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown' WHERE id = ${saved.jobId}`;

    expect(await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId))
      .toMatchObject({ id: saved.jobId, status: "outcome_unknown" });
  });

  it.each(["queued", "running", "succeeded", "failed", "cancelled"] as const)(
    "does not revive an older unknown after a newer %s job",
    async (status) => {
      const { conversationId, append } = await seedConversation();
      const old = await append();
      await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown', created_at = now() - interval '1 minute' WHERE id = ${old.jobId}`;
      await fixture.sql`UPDATE opening_turns SET status = 'outcome_unknown' WHERE id = ${old.assistantTurnId}`;
      const latest = await append();
      await fixture.sql`UPDATE opening_tutor_jobs SET status = ${status} WHERE id = ${latest.jobId}`;
      const turnStatus = status === "succeeded" ? "complete" : status === "failed" || status === "cancelled" ? "failed" : "pending";
      await fixture.sql`UPDATE opening_turns SET status = ${turnStatus} WHERE id = ${latest.assistantTurnId}`;

      const result = await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId);
      if (status === "queued" || status === "running") {
        expect(result).toMatchObject({ id: latest.jobId, status });
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it.each(["complete", "failed", "clarify"] as const)("does not recover an unknown job over its protected %s assistant turn", async (status) => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown' WHERE id = ${saved.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = ${status} WHERE id = ${saved.assistantTurnId}`;

    expect(await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId)).toBeNull();
  });

  it("breaks equal creation-time ties by job id before filtering terminal states", async () => {
    const { conversationId, append } = await seedConversation();
    const first = await append();
    const second = await append();
    const newest = first.jobId > second.jobId ? first : second;
    const older = newest === first ? second : first;
    await fixture.sql`UPDATE opening_tutor_jobs SET created_at = '2026-10-15T00:00:00Z' WHERE id IN (${first.jobId}, ${second.jobId})`;
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'outcome_unknown' WHERE id = ${older.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'outcome_unknown' WHERE id = ${older.assistantTurnId}`;
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'succeeded' WHERE id = ${newest.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'complete' WHERE id = ${newest.assistantTurnId}`;

    expect(await createOpeningTutorJobsRepository(fixture.sql).findPendingForConversation(fixture.scope, conversationId)).toBeNull();
  });

  it("keeps recovery bound to both the conversation owner and workspace", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await append();
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    const claimed = await jobs.claim(saved.jobId);
    await jobs.markUnknown(fixture.scope, saved.jobId, "provider timeout", claimed!.claimToken);

    expect(await jobs.findPendingForConversation(fixture.otherScope, conversationId)).toBeNull();
    expect(await jobs.findPendingForConversation({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, conversationId)).toBeNull();
    expect(await jobs.findPendingForConversation({ ...fixture.otherScope, ownerUserId: fixture.scope.ownerUserId }, conversationId)).toBeNull();
  });

  it("keeps concurrent equal-time user/assistant pairs adjacent and aligned with the latest recovery job", async () => {
    const { conversationId, append } = await seedConversation();
    const saved = await Promise.all(["解释导数", "解释积分", "解释极限"].map(async (text) => ({ ...await append(text), text })));
    const ordered = [...saved].sort((left, right) => left.jobId.localeCompare(right.jobId));
    const latest = ordered.at(-1)!;
    await fixture.sql`UPDATE opening_turns SET created_at = '2026-10-15T00:00:00Z' WHERE conversation_id = ${conversationId}`;
    await fixture.sql`UPDATE opening_tutor_jobs SET created_at = '2026-10-15T00:00:00Z', status = 'succeeded' WHERE conversation_id = ${conversationId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'complete' WHERE conversation_id = ${conversationId}`;
    await fixture.sql`UPDATE opening_tutor_jobs SET status = 'running' WHERE id = ${latest.jobId}`;
    await fixture.sql`UPDATE opening_turns SET status = 'pending' WHERE id = ${latest.assistantTurnId}`;
    const jobs = createOpeningTutorJobsRepository(fixture.sql);
    await jobs.markUnknown(fixture.scope, latest.jobId, "provider timeout");
    // Move the user tuple after the terminal assistant tuple. Physical row
    // order must not determine which question recovery puts back in the draft.
    await fixture.sql`UPDATE opening_turns SET text = text WHERE id = ${latest.turnId}`;

    const turns = await createOpeningConversationRepository(fixture.sql).listTurns(fixture.scope, conversationId);
    expect(turns.map((turn) => turn.id)).toEqual(ordered.flatMap((row) => [row.turnId, row.assistantTurnId]));
    expect(turns.at(-2)).toMatchObject({ id: latest.turnId, role: "user", text: latest.text });
    expect(turns.at(-1)).toMatchObject({ id: latest.assistantTurnId, role: "assistant", status: "outcome_unknown" });
    expect(await jobs.findPendingForConversation(fixture.scope, conversationId)).toMatchObject({ id: latest.jobId, status: "outcome_unknown" });
  });
});
