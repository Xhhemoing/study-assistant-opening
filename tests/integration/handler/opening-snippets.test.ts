import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLibraryRepository } from "@aistudy/database";
import { POST as reply } from "../../../apps/web/src/app/api/opening/ephemeral/route";
import { POST as save } from "../../../apps/web/src/app/api/opening/snippets/route";
import { complete, ephemeralCounts, postEphemeral, resetEphemeralRows, sql, startEphemeralHandler, stopEphemeralHandler, workspaceForCookie } from "./opening-ephemeral-harness";
beforeAll(startEphemeralHandler);
beforeEach(resetEphemeralRows);
afterAll(stopEphemeralHandler);
const output = (text: string) => ({ text, citedChunkIds: [], candidates: [], requestId: randomUUID(), inputTokens: 2, outputTokens: 2 });

describe("explicit snippet save handler", () => {
  it("saves only the confirmed excerpt and retains material provenance from a preceding temporary reply", async () => {
    const workspaceId = await workspaceForCookie(), sourceId = randomUUID(), chunkId = randomUUID();
    await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${sourceId},${workspaceId},'source.txt','text/plain',1,${'a'.repeat(64)},0,'uploaded','ready')`;
    await sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${chunkId},${sourceId},0,1,'PRIVATE-SOURCE-BODY')`;
    const before = await ephemeralCounts();
    complete.mockResolvedValueOnce(output("FIRST-PRIVATE-ANSWER"));
    const firstResponse = await reply(postEphemeral({ text: "read source", sourceIds: [sourceId], mode: "listen", history: [] }));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.provenanceId).toEqual(expect.any(String));
    complete.mockResolvedValueOnce(output("SECOND-FULL-ANSWER with selected excerpt and unselected details"));
    const secondResponse = await reply(postEphemeral({ text: "continue", sourceIds: [], mode: "listen", historyPrivacyEpoch: first.privacyEpoch,
      history: [{ role: "assistant", text: first.text, provenanceId: first.provenanceId }] }));
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect((await ephemeralCounts()).documents).toBe(before.documents);
    const savedResponse = await save(postEphemeral({ title: "My linked note", text: "selected excerpt", provenanceId: second.provenanceId }));
    expect(savedResponse.status).toBe(201);
    expect(savedResponse.headers.get("cache-control")).toBe("no-store");
    const { documentId } = await savedResponse.json();
    const document = await createLibraryRepository(sql).getDocument({ workspaceId, documentId });
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]!.content).toMatchObject({ blockNoteContent: "selected excerpt" });
    expect(JSON.stringify(document)).not.toMatch(/FIRST-PRIVATE|SECOND-FULL|unselected|PRIVATE-SOURCE/);
    expect((await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)[0]!.context_source_refs).toEqual([{ sourceId, sourceVersion: 0 }]);
    const after = await ephemeralCounts();
    expect(after).toEqual({ ...before, documents: before.documents+1, blocks: before.blocks+1, revisions: before.revisions+1, reservations: before.reservations+2 });
  });

  it("rejects forged, foreign and unknown receipt saves without creating a note", async () => {
    const workspaceId = await workspaceForCookie();
    const epoch = Number((await sql`SELECT privacy_epoch FROM workspaces WHERE id=${workspaceId}`)[0]!.privacy_epoch);
    const before = await ephemeralCounts();
    const forged = await save(postEphemeral({ title: "forged", text: "must not save", provenanceId: randomUUID() }));
    expect(forged.status).toBe(404);
    complete.mockResolvedValueOnce(output("unknown history output"));
    const unknownResponse = await reply(postEphemeral({ text: "continue", sourceIds: [], mode: "listen", historyPrivacyEpoch: epoch, history: [{ role: "assistant", text: "old body without a receipt" }] }));
    expect(unknownResponse.status).toBe(200);
    const freshReply = await unknownResponse.json();
    expect(freshReply).toMatchObject({ historyDiscarded: true, provenanceId: expect.any(String) });
    expect(complete.mock.calls.at(-1)?.[0]).toMatchObject({ history: [] });
    expect(JSON.stringify(complete.mock.calls.at(-1)?.[0])).not.toContain("old body without a receipt");
    const freshReceipt = (await sql`SELECT context_source_refs FROM opening_ephemeral_provenance WHERE id=${freshReply.provenanceId}`)[0]!;
    expect(freshReceipt.context_source_refs).toEqual([]);
    // The discarded history did not participate in this new reply. Simulate a legacy unknown receipt explicitly.
    const unknown = (await sql`UPDATE opening_ephemeral_provenance SET context_source_refs=NULL
      WHERE id=${freshReply.provenanceId} AND workspace_id=${workspaceId} RETURNING id`)[0]!;
    const denied = await save(postEphemeral({ title: "unknown", text: "must not save", provenanceId: unknown.id }));
    expect(denied.status).toBe(409);
    const foreignId = randomUUID();
    await sql`UPDATE opening_ephemeral_provenance SET owner_user_id=${foreignId} WHERE id=${unknown.id}`;
    const foreign = await save(postEphemeral({ title: "foreign", text: "must not save", provenanceId: unknown.id }));
    expect(foreign.status).toBe(404);
    expect((await ephemeralCounts()).documents).toBe(before.documents);
  });

  it("requires authentication and rejects client-authored lineage fields", async () => {
    const unauthenticated = await save(new Request("http://localhost/api/opening/snippets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", text: "y", provenanceId: randomUUID() }) }));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
    const before = await ephemeralCounts();
    const invalid = await save(postEphemeral({ title: "x", text: "y", provenanceId: randomUUID(), sourceRefs: [] }));
    expect(invalid.status).toBe(400);
    expect(await ephemeralCounts()).toEqual(before);
  });
});
