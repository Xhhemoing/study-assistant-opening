import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningSourceChunksRepository } from "@aistudy/database";
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
  it("preserves blank physical pages for preview but never uses blank or unfinished chunks as tutor text", async () => {
    const id = await seed(), repo = createOpeningSourceChunksRepository(f.sql);
    await repo.replaceChunks(f.scope, { sourceId: id, sourceVersion: 1, chunks: [chunk(""), chunk("actual body", 2)] });
    expect((await repo.listChunks(f.scope, id)).map(row => row.page)).toEqual([1, 2]);
    expect((await repo.listForSources(f.scope, [id])).map(row => row.text)).toEqual(["actual body"]);
    await f.sql`UPDATE opening_sources SET parse_state='failed' WHERE id=${id}`;
    expect(await repo.listForSources(f.scope, [id])).toEqual([]);
    expect(await repo.listForSources(f.otherScope, [id])).toEqual([]);
  });
});
