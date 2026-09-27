import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningConversationRepository, createOpeningSourceChunksRepository, readOpeningConversationSelection } from "@aistudy/database";
import { createTutorService } from "../../apps/web/src/features/opening/tutor/tutor-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { await f.reset(); });
afterAll(async () => { await f?.close(); });
async function seed() {
  const conversations = createOpeningConversationRepository(f.sql);
  const sourceChunks = createOpeningSourceChunksRepository(f.sql);
  const conversation = await conversations.create(f.scope, { title: "selection", courseId: null });
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${f.scope.workspaceId}, 'pages.pdf', 'application/pdf', 1, ${'a'.repeat(64)}, 0, 'uploaded', 'ready')`;
  await sourceChunks.replaceChunks(f.scope, { sourceId, sourceVersion: 0, chunks: [{ page: 4, text: "four", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] });
  const [chunk] = await sourceChunks.listChunks(f.scope, sourceId);
  const saved = await conversations.appendSavedTurn({ scope: f.scope, conversationId: conversation.id,
    text: "page four", mode: "explain", clientKey: randomUUID(), sourceIds: [sourceId],
    learningSessionId: null, currentPage: 4, chunkId: chunk!.id });
  const service = createTutorService({ conversations, sourceChunks,
    readSelection: (scope, id) => readOpeningConversationSelection(f.sql, scope, id) });
  return { conversations, conversation, sourceId, chunkId: chunk!.id, saved, service };
}

it("restores saved source/page/chunk while the assistant is still pending", async () => {
  const { service, conversation, sourceId, chunkId } = await seed();
  expect(await service.resumeConversation(f.scope, conversation.id)).toMatchObject({ sourceIds: [sourceId], currentPage: 4, chunkId });
});

it("does not expose selection to another owner or workspace", async () => {
  const { service, conversation } = await seed();
  expect(await readOpeningConversationSelection(f.sql, f.otherScope, conversation.id)).toBeNull();
  const wrongOwner = { ...f.scope, ownerUserId: f.otherScope.ownerUserId };
  expect(await readOpeningConversationSelection(f.sql, wrongOwner, conversation.id)).toBeNull();
  await expect(service.resumeConversation(wrongOwner, conversation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("uses the latest user turn, including explicitly cleared selection", async () => {
  const { service, conversations, conversation, saved } = await seed();
  await f.sql`UPDATE opening_turns SET created_at = now() - interval '1 hour' WHERE id = ${saved.turnId}`;
  await conversations.appendSavedTurn({ scope: f.scope, conversationId: conversation.id,
    text: "free conversation", mode: "listen", clientKey: randomUUID(), sourceIds: [],
    learningSessionId: null, currentPage: null, chunkId: null });
  expect(await service.resumeConversation(f.scope, conversation.id)).toMatchObject({ sourceIds: [], currentPage: null, chunkId: null });
});

it.each(["version", "excluded", "rejected", "foreign", "parsing"])("does not restore a %s source", async (change) => {
  const { service, conversation, sourceId } = await seed();
  if (change === "version") await f.sql`UPDATE opening_sources SET version = 1 WHERE id = ${sourceId}`;
  if (change === "excluded") await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, deleted_at) VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${sourceId}, now())`;
  if (change === "rejected") await f.sql`UPDATE opening_sources SET upload_state = 'rejected' WHERE id = ${sourceId}`;
  if (change === "foreign") await f.sql`UPDATE opening_sources SET workspace_id = ${f.otherScope.workspaceId} WHERE id = ${sourceId}`;
  if (change === "parsing") await f.sql`UPDATE opening_sources SET parse_state = 'queued' WHERE id = ${sourceId}`;
  expect(await service.resumeConversation(f.scope, conversation.id)).toMatchObject({ sourceIds: [], currentPage: null, chunkId: null });
});

it("drops obsolete page and chunk without losing the conversation", async () => {
  const { service, conversation, sourceId } = await seed();
  await f.sql`UPDATE opening_source_chunks SET page = 5 WHERE source_id = ${sourceId}`;
  expect(await service.resumeConversation(f.scope, conversation.id)).toMatchObject({ sourceIds: [sourceId], currentPage: null, chunkId: null });
});
