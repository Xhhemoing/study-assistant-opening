import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOpeningConversationRepository, createOpeningSourceChunksRepository,
  readOpeningConversationSelection, readOpeningSavedTurnRetry,
} from "@aistudy/database";
import { createTutorService } from "../../apps/web/src/features/opening/tutor/tutor-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

async function seed() {
  const conversations = createOpeningConversationRepository(f.sql);
  const sourceChunks = createOpeningSourceChunksRepository(f.sql);
  const conversation = await conversations.create(f.scope, { title: "original failed intent", courseId: null });
  const sourceA = randomUUID(), sourceB = randomUUID();
  for (const sourceId of [sourceA, sourceB]) {
    await f.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${f.scope.workspaceId}, 'intent.pdf', 'application/pdf', 1, ${'a'.repeat(64)}, 0, 'uploaded', 'ready')`;
    await sourceChunks.replaceChunks(f.scope, { sourceId, sourceVersion: 0,
      chunks: [{ page: 4, text: `original-${sourceId}`, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] });
  }
  const [chunk] = await sourceChunks.listChunks(f.scope, sourceA);
  const contextAnchor = { purpose: "material_read" as const, sourceId: sourceA, sourceVersion: 0, page: 4, chunkId: chunk!.id };
  const original = { scope: f.scope, conversationId: conversation.id, text: "原资料 A 第四页的问题", mode: "hint" as const,
    sourceIds: [sourceA], currentPage: 4, chunkId: chunk!.id, learningSessionId: null,
    contextAnchor, purpose: "answer" as const, strategyTemplateId: "original-strategy", clientKey: randomUUID() };
  const saved = await conversations.appendSavedTurn(original);
  await f.sql`UPDATE opening_turns SET status='failed', text='服务未能完成' WHERE id=${saved.assistantTurnId}`;
  await f.sql`UPDATE opening_tutor_jobs SET status='failed' WHERE id=${saved.jobId}`;
  const service = createTutorService({ conversations, sourceChunks,
    readSelection: (scope, id) => readOpeningConversationSelection(f.sql, scope, id),
    readFailedTurnRetry: (scope, id, assistantId) => readOpeningSavedTurnRetry(f.sql, scope, id, assistantId) });
  const retry = { conversationId: conversation.id, text: "已经改成 B 的当前输入", mode: "explain" as const,
    sourceIds: [sourceB], sourceSelection: "selected" as const, currentPage: 4,
    privacy: "saved" as const, clientKey: `retry-${saved.assistantTurnId}` };
  return { conversations, service, sourceA, sourceB, conversation, original, saved, retry };
}

async function counts(conversationId: string) {
  const [row] = await f.sql`SELECT
    (SELECT count(*)::int FROM opening_turns WHERE conversation_id=${conversationId}) AS turns,
    (SELECT count(*)::int FROM opening_tutor_jobs WHERE conversation_id=${conversationId}) AS jobs`;
  return row;
}

describe("original persisted failed-turn intent", () => {
  it("restores A/page/chunk/context/purpose from storage, ignores current B, and replays one retry job", async () => {
    const s = await seed();
    const first = await s.service.submitTurn(f.scope, s.retry);
    const [user] = await f.sql`SELECT text, mode, source_ids, source_versions, current_page, chunk_id,
      learning_session_id, attempt_id, strategy_template_id, context_anchor, composer_purpose
      FROM opening_turns WHERE id=${first.turnId}`;
    expect(user).toMatchObject({ text: s.original.text, mode: "hint", source_ids: [s.sourceA],
      source_versions: { [s.sourceA]: 0 }, current_page: 4, chunk_id: s.original.chunkId,
      learning_session_id: null, attempt_id: null, strategy_template_id: "original-strategy",
      context_anchor: s.original.contextAnchor, composer_purpose: "answer" });
    expect(user!.source_ids).not.toContain(s.sourceB);
    const before = await counts(s.conversation.id);
    const again = await s.service.submitTurn(f.scope, { ...s.retry, text: "仍然不同的编辑正文" });
    expect(again).toMatchObject({ jobId: first.jobId, turnId: first.turnId, replayed: true });
    expect(await counts(s.conversation.id)).toEqual(before);
    const [original] = await f.sql`SELECT text, source_ids, status FROM opening_turns WHERE id=${s.saved.turnId}`;
    expect(original).toMatchObject({ text: s.original.text, source_ids: [s.sourceA], status: "complete" });
  });

  it.each(["version", "excluded", "unknown", "foreign-owner", "other-conversation"])("rejects %s without creating any new turns or jobs", async change => {
    const s = await seed();
    if (change === "version") await f.sql`UPDATE opening_sources SET version=1 WHERE id=${s.sourceA}`;
    if (change === "excluded") await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, deleted_at)
      VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${s.sourceA}, now())`;
    if (change === "unknown") await f.sql`UPDATE opening_tutor_jobs SET status='outcome_unknown' WHERE id=${s.saved.jobId}`;
    const request = change === "other-conversation"
      ? { ...s.retry, conversationId: (await s.conversations.create(f.scope, { title: "other", courseId: null })).id } : s.retry;
    const scope = change === "foreign-owner" ? { ...f.scope, ownerUserId: f.otherScope.ownerUserId } : f.scope;
    const before = await counts(s.conversation.id);
    await expect(s.service.submitTurn(scope, request)).rejects.toBeInstanceOf(Error);
    expect(await counts(s.conversation.id)).toEqual(before);
  });

  it("rejects a direct append that swaps B into an otherwise valid retry key", async () => {
    const s = await seed(), before = await counts(s.conversation.id);
    await expect(s.conversations.appendSavedTurn({ ...s.original, clientKey: s.retry.clientKey, sourceIds: [s.sourceB] }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await counts(s.conversation.id)).toEqual(before);
  });

  it("keeps a user-authored new B question independent of the original retry", async () => {
    const s = await seed();
    const independent = await s.service.submitTurn(f.scope, { ...s.retry, text: "针对 B 的另一条新问题", clientKey: randomUUID() });
    const [turn] = await f.sql`SELECT text, source_ids FROM opening_turns WHERE id=${independent.turnId}`;
    expect(turn).toMatchObject({ text: "针对 B 的另一条新问题", source_ids: [s.sourceB] });
  });
});
