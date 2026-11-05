import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository } from "@aistudy/database";
import { readOpeningSourceContent } from "../../packages/database/src/repositories/opening-source-content";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
async function seed() {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES
    (${id},${f.scope.workspaceId},'notes.pdf','application/pdf',8,${'ab'.repeat(32)},1,'uploaded','running')`;
  return id;
}
const chunk = (text: string, page = 1) => ({ text, page, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null });
describe("source chunks usability", () => {
  it("retains unchanged identities on extension but removes changed or omitted chunks", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk("saved"), chunk("old", 2)] });
    const before = await repo.listChunks(f.scope, id);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1,
      chunks: [chunk("saved"), chunk("new", 2), chunk("added", 3)] });
    const extended = await repo.listChunks(f.scope, id);
    expect(extended[0]).toEqual(before[0]);
    expect(extended[1]!.id).not.toBe(before[1]!.id);
    expect(extended.map(row => row.text)).toEqual(["saved", "new", "added"]);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk("saved")] });
    expect(await repo.listChunks(f.scope, id)).toEqual([before[0]]);
  });
  it("reads only the requested owned version and page, preserves empty pages and bounds body output", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk(""), chunk("B".repeat(21000), 2)] });
    const content = await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 2 });
    expect(content).toMatchObject({ version: 1, currentVersion: 1, page: 2, pages: [1,2], readablePages: 1, characters: 21000, truncated: true });
    expect(content.text.length).toBe(20000);
    expect((await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 1 })).text).toBe("");
    await expect(readOpeningSourceContent(f.sql, f.otherScope, id, { version: 1, page: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }, id, { version: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, { version: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, { page: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.sql`UPDATE opening_sources SET version=2,parse_state='running' WHERE id=${id}`;
    expect(await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 2 })).toMatchObject({ version: 1, currentVersion: 2 });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, {})).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each([{ chunks: [] }, { chunks: [chunk(" \n\t")] }])("does not commit ready or erase prior chunks when parsing has no body (%#)", async ({ chunks }) => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk("earlier readable body")] });
    await expect(repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks })).rejects.toThrow("no readable text");
    expect((await repo.listChunks(f.scope, id)).map(row => row.text)).toEqual(["earlier readable body"]);
  });
  it("preserves ready and pinned historical owner reads after a real memory AI exclusion without asset deletion", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await f.sql`UPDATE opening_sources SET parse_state='ready' WHERE id=${id}`;
    await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text)
      VALUES(${id},1,1,'PRIVATE-EXCLUDED-CONTENT')`;
    const conversationId = randomUUID(), turnId = randomUUID();
    await f.sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
      VALUES(${conversationId},${f.scope.workspaceId},${f.scope.ownerUserId},'privacy action')`;
    await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids)
      VALUES(${turnId},${f.scope.workspaceId},${conversationId},'user','origin','listen','complete',${[id]})`;
    const memories = createOpeningMemoryRepository(f.sql);
    const memory = await memories.proposeMemory(f.scope, { text: 'private memory', sourceTurnIds: [turnId], expiresAt: null });
    await memories.deleteMemory(f.scope, { id: memory.id, expectedVersion: memory.version,
      deleteSourceText: false, clientKey: randomUUID() });
    const privacy = createOpeningPrivacyRepository(f.sql);
    expect(await privacy.isSourceExcluded(f.scope, id)).toBe(true);
    expect(await privacy.isSourceAssetDeleted(f.scope, id)).toBe(false);
    expect((await repo.listForSources(f.scope, [id])).map(row => row.text)).toEqual(['PRIVATE-EXCLUDED-CONTENT']);
    expect(await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 1 }))
      .toMatchObject({ version: 1, currentVersion: 1, text: 'PRIVATE-EXCLUDED-CONTENT' });
    await f.sql`UPDATE opening_sources SET version=2,parse_state='queued' WHERE id=${id}`;
    expect(await readOpeningSourceContent(f.sql, f.scope, id, { version: 1, page: 1 }))
      .toMatchObject({ version: 1, currentVersion: 2, text: 'PRIVATE-EXCLUDED-CONTENT' });
    await expect(readOpeningSourceContent(f.sql, f.scope, id, {})).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(readOpeningSourceContent(f.sql, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }, id,
      { version: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await repo.listForSources(f.scope, [id])).toEqual([]);
  });
  it("never opens raw unpublished PDF chunks just because a source is queued, running, failed or not_started", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text)
      VALUES(${id},1,1,'unpublished renderer output')`;
    for (const state of ["queued", "running", "failed", "not_started"]) {
      await f.sql`UPDATE opening_sources SET parse_state=${state} WHERE id=${id}`;
      await expect(readOpeningSourceContent(f.sql, f.scope, id, {})).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await repo.listForSources(f.scope, [id])).toEqual([]);
    }
  });
  it("preserves blank physical pages and already-published tutor text across a later failed retry", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk(""), chunk("actual body", 2)] });
    expect((await repo.listChunks(f.scope, id)).map(row => row.page)).toEqual([1, 2]);
    expect((await repo.listForSources(f.scope, [id])).map(row => row.text)).toEqual(["actual body"]);
    await f.sql`UPDATE opening_sources SET parse_state='failed' WHERE id=${id}`;
    expect((await repo.listForSources(f.scope, [id])).map(row => row.text)).toEqual(["actual body"]);
    expect(await repo.listForSources(f.otherScope, [id])).toEqual([]);
  });
});
