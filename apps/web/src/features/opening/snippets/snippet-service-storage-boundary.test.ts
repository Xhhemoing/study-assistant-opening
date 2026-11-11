import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import type { SnippetCreateInput } from "@aistudy/contracts";
import { createOpeningSnippetService } from "./snippet-service";
import { createOpeningNoteRepository } from "../../../../../../packages/database/src/repositories/opening-note-provenance";

const hooks = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("@aistudy/database", () => ({ createOpeningNoteRepository: hooks.factory }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const principal = { workspaceId: id(1), userId: id(2), sessionId: id(3) }, proof = id(4);
const flat = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`).join("\n\n");
const nested = (n: number) => Array.from({ length: n }, (_, i) => `- p${i}\n  - c${i}`).join("\n");
function storage() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn((parts: TemplateStringsArray, ...values: unknown[]): unknown => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim();
    if (!/^(SELECT|INSERT)\b/.test(sql)) return { fragment: sql, values };
    calls.push({ sql, values });
    if (sql.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: principal.workspaceId }]);
    if (sql.startsWith("INSERT INTO opening_workspace_history_revisions")) return Promise.resolve([]);
    if (sql.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return Promise.resolve([{ revision: 0 }]);
    if (sql.startsWith("SELECT context_source_refs FROM opening_ephemeral_provenance")) return Promise.resolve([{ context_source_refs: [] }]);
    if (sql.startsWith("SELECT t.context_source_refs,t.citations")) return Promise.resolve([{ context_source_refs: [], citations: [] }]);
    if (sql.startsWith("SELECT ? AS included")) return Promise.resolve([{ included: true }]);
    if (sql.startsWith("INSERT INTO library_") || sql.startsWith("INSERT INTO opening_note_provenance")) return Promise.resolve([]);
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const tx = Object.assign(query, { json: (value: unknown) => value }) as unknown as TransactionSql;
  const pool = vi.fn(() => { throw new Error("expected transaction handle"); });
  const begin = vi.fn(async (fn: (db: TransactionSql) => unknown) => fn(tx));
  const sql = Object.assign(pool, { begin }) as unknown as Sql;
  const blocks = () => calls.filter(call => call.sql.startsWith("INSERT INTO library_blocks"));
  return { sql, tx, pool, begin, calls, blocks };
}
beforeEach(() => { vi.resetAllMocks(); hooks.factory.mockImplementation(createOpeningNoteRepository); });

// No DOM or HTTP: the only replacement is the public database factory export.
// Its implementation delegates to the actual immutable note repository.
describe("snippet factory → real Markdown conversion → real note block storage", () => {
  it.each([
    ["flat 400", flat(400), 400, "paragraph"], ["flat 401", flat(401), 1, "paragraph"],
    ["recursive 400", nested(200), 200, "bulletListItem"], ["recursive 401", `${nested(200)}\n- overflow`, 1, "paragraph"],
  ])("applies the converted block budget at %s before repository ID allocation", async (_label, text, count, type) => {
    const f = storage(), service = createOpeningSnippetService(f.sql, { OPENING_CHAT_PROSE: "1" });
    const result = await service.save(principal, { title: "Budget", text, provenanceId: proof });
    expect(f.blocks()).toHaveLength(count);
    expect(f.blocks().every(call => call.values[3] === type)).toBe(true);
    expect(f.blocks().every(call => call.values[1] === principal.workspaceId && call.values[2] === result.documentId)).toBe(true);
    const body = f.blocks()[0]!.values[5];
    if (count === 1) expect(body).toEqual({ blockNoteContent: text, props: null, children: [] });
    else if (type === "bulletListItem") expect(body).toMatchObject({ blockNoteContent: [{ type: "text", text: "p0", styles: {} }], children: [{ id: expect.any(String), type: "bulletListItem", content: [{ type: "text", text: "c0", styles: {} }] }] });
    else expect(body).toEqual({ blockNoteContent: [{ type: "text", text: "p0", styles: {} }], props: null, children: [] });
    const revision = f.calls.find(call => call.sql.startsWith("INSERT INTO library_revisions"))!;
    const snapshots = revision.values[4] as Array<{ id: string; type: string; position: number; content: unknown }>;
    expect(snapshots).toEqual(f.blocks().map(call => ({ id: call.values[0], type: call.values[3], position: call.values[4], content: call.values[5] })));
    expect(f.pool).not.toHaveBeenCalled(); expect(f.begin).toHaveBeenCalledOnce();
  });
  it("counts converted blocks, not raw Markdown nodes dropped by the converter", async () => {
    const f = storage(), text = `${flat(400)}\n\n<div>discarded-html-node</div>`;
    await createOpeningSnippetService(f.sql, { OPENING_CHAT_PROSE: "1" }).save(principal, { title: "Converted budget", text, provenanceId: proof });
    expect(f.blocks()).toHaveLength(400);
    expect(f.blocks()[0]!.values[5]).toMatchObject({ blockNoteContent: [{ type: "text", text: "p0" }] });
    expect(JSON.stringify(f.blocks())).not.toContain("discarded-html-node");
  });
  it("keeps a single multiline code block structured rather than budgeting text lines as blocks", async () => {
    const f = storage(), code = Array.from({ length: 401 }, (_, n) => `line${n}`).join("\n");
    await createOpeningSnippetService(f.sql, { OPENING_CHAT_PROSE: "1" }).save(principal, { title: "Code", text: `\`\`\`ts\n${code}\n\`\`\``, provenanceId: proof });
    expect(f.blocks()).toHaveLength(1);
    expect(f.blocks()[0]!.values.slice(3)).toEqual(["codeBlock", 0, { blockNoteContent: code, props: { language: "ts" }, children: [] }]);
  });
  it("uses the actual prose default when only an empty env is supplied", async () => {
    const f = storage();
    await createOpeningSnippetService(f.sql, {}).save(principal, { title: "Default", text: "## Heading", provenanceId: proof });
    expect(f.blocks()[0]!.values[3]).toBe("heading");
    expect(f.blocks()[0]!.values[5]).toMatchObject({ props: { level: 2 }, blockNoteContent: [{ text: "Heading" }] });
  });
  it("samples the injected prose switch per save, not once when constructing the factory", async () => {
    const f = storage(), env = { OPENING_CHAT_PROSE: "0" }, service = createOpeningSnippetService(f.sql, env);
    const raw = { title: "Switch", text: "# Heading\n\nbody", provenanceId: proof };
    await service.save(principal, raw); expect(f.blocks().map(call => call.values[3])).toEqual(["paragraph"]);
    expect(f.blocks()[0]!.values[5]).toEqual({ blockNoteContent: raw.text, props: null, children: [] });
    env.OPENING_CHAT_PROSE = "1"; await service.save(principal, raw);
    expect(f.blocks().slice(1).map(call => call.values[3])).toEqual(["heading", "paragraph"]);
    expect(hooks.factory).toHaveBeenCalledExactlyOnceWith(f.sql);
  });
  it("keeps different factory instances' injected environments and storage handles independent", async () => {
    const first = storage(), second = storage(), raw = { title: "Separate", text: "## Heading", provenanceId: proof };
    const plain = createOpeningSnippetService(first.sql, { OPENING_CHAT_PROSE: "0" });
    const prose = createOpeningSnippetService(second.sql, { OPENING_CHAT_PROSE: "1" });
    await prose.save(principal, raw); await plain.save(principal, raw);
    expect(first.blocks()[0]!.values[3]).toBe("paragraph"); expect(second.blocks()[0]!.values[3]).toBe("heading");
    expect(hooks.factory.mock.calls.map(call => call[0])).toEqual([first.sql, second.sql]);
  });
  it.each(["provenanceId", "savedTurnId"] as const)("uses principal scope and trimmed body for %s without changing the request", async origin => {
    const f = storage(), raw = { title: "  Confirmed  ", text: "  ## Selected  ", [origin]: proof }, before = structuredClone(raw);
    await createOpeningSnippetService(f.sql, { OPENING_CHAT_PROSE: "1" }).save(principal, raw);
    expect(raw).toEqual(before);
    const document = f.calls.find(call => call.sql.startsWith("INSERT INTO library_documents"))!;
    expect(document.values.slice(1)).toEqual([principal.workspaceId, "Confirmed"]);
    expect(f.blocks()[0]!.values[5]).toMatchObject({ blockNoteContent: [{ text: "Selected" }] });
    const originCall = f.calls.find(call => call.sql.startsWith(origin === "savedTurnId" ? "SELECT t.context_source_refs" : "SELECT context_source_refs"))!;
    expect(originCall.values).toEqual([proof, principal.workspaceId, principal.userId]);
  });
  it("converts the contract-trimmed excerpt rather than interpreting its surrounding four-space indentation as code", async () => {
    const f = storage(), raw = { title: "  Selected  ", text: "    ## Selected\n\nbody    ", provenanceId: proof };
    await createOpeningSnippetService(f.sql, { OPENING_CHAT_PROSE: "1" }).save(principal, raw);
    expect(f.blocks().map(call => call.values[3])).toEqual(["heading", "paragraph"]);
    expect(f.blocks()[0]!.values[5]).toEqual({ blockNoteContent: [{ type: "text", text: "Selected", styles: {} }], props: { level: 2 }, children: [] });
    expect(f.blocks()[1]!.values[5]).toEqual({ blockNoteContent: [{ type: "text", text: "body", styles: {} }], props: null, children: [] });
    expect(raw.text).toBe("    ## Selected\n\nbody    ");
  });
  it("passes repository rejection through unchanged and never creates a replacement save", async () => {
    const f = storage(), error = new Error("note storage unavailable"), saveSnippet = vi.fn().mockRejectedValue(error);
    hooks.factory.mockReturnValueOnce({ saveSnippet });
    const input: SnippetCreateInput = { title: "Selected", text: "## text", provenanceId: proof };
    await expect(createOpeningSnippetService(f.sql, { OPENING_CHAT_PROSE: "1" }).save(principal, input)).rejects.toBe(error);
    expect(saveSnippet).toHaveBeenCalledExactlyOnceWith({ workspaceId: principal.workspaceId, ownerUserId: principal.userId }, input,
      [{ type: "heading", props: { level: 2 }, content: [{ type: "text", text: "text", styles: {} }], children: [] }]);
    expect(f.calls).toEqual([]);
  });
});
