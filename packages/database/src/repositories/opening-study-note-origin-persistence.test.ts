import { describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { studyNoteCreateSchema, studyNoteCreateResultSchema, type StudyNoteCreate } from "@aistudy/contracts";
import { createOpeningStudyNoteRepository } from "./opening-study-notes";
import { resolveLearningAssetOrigin } from "./opening-learning-asset-links";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, courseId = id(3), activityId = id(4), a = id(5), b = id(6);
const now = "2026-11-11T03:00:00.000Z";
const input: StudyNoteCreate = studyNoteCreateSchema.parse({ clientKey: "study-origin-note-key", title: "Original explanation", text: "My understanding, not a grade.",
  courseId: null, goalId: null, requirementId: null, purpose: "exploration", origin: { purpose: "learning_help", courseId, activityId } });

function fixture({ refs = [{ sourceId: a, version: "2" }, { sourceId: b, sourceVersion: 0 }] as unknown,
  activitySources = [a, b], unavailable = [] as string[], insertFault = "", sourceFault = false,
  selected = input, contentVersion = 7, specVersion = 7, blockOrder = [{ blockId: id(10) }],
  receipt = undefined as Record<string, unknown> | undefined, missingSource = false,
  sourceState = {} as Record<string, unknown> } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [], writes: Array<{ sql: string; values: unknown[] }> = [];
  const failure = new Error("storage unavailable");
  let saved: Record<string, unknown> | undefined;
  const query = vi.fn((parts: TemplateStringsArray, ...values: unknown[]): unknown => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim();
    if (!/^(SELECT|INSERT|UPDATE)\b/.test(sql)) return { fragment: sql, values };
    calls.push({ sql, values });
    if (sql.startsWith("INSERT INTO") || sql.startsWith("UPDATE ")) { writes.push({ sql, values }); if (insertFault && sql.startsWith(insertFault)) throw failure; }
    if (sql.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
    if (sql.startsWith("INSERT INTO opening_workspace_history_revisions")) return Promise.resolve([]);
    if (sql.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return Promise.resolve([{ revision: 0 }]);
    if (sql.startsWith("SELECT * FROM opening_learning_asset_links")) { saved = receipt; return Promise.resolve(receipt ? [receipt] : []); }
    if (sql.startsWith("SELECT id FROM courses")) return Promise.resolve([{ id: courseId }]);
    if (sql.startsWith("SELECT * FROM opening_teaching_activities")) return Promise.resolve([{ id: activityId, course_id: courseId, content_version: contentVersion, source_ids: activitySources }]);
    if (sql.startsWith("SELECT source_ids FROM opening_teaching_activities")) return Promise.resolve([{ source_ids: activitySources }]);
    if (sql.startsWith("SELECT block_order,source_refs,version")) return Promise.resolve([{ block_order: blockOrder, source_refs: refs, version: specVersion }]);
    if (sql.startsWith("SELECT s.id FROM opening_sources")) return Promise.resolve([{ id: a }]);
    if (sql.startsWith("SELECT id,version FROM opening_sources")) return Promise.resolve([{ id: a, version: 9 }]);
    if (sql.startsWith("SELECT version FROM opening_source_versions")) return Promise.resolve([{ version: 2 }]);
    if (sql.startsWith("SELECT id FROM opening_source_chunks")) return Promise.resolve([{ id: id(12) }]);
    if (sql.startsWith("SELECT block_order FROM opening_teaching_activity_specs")) return Promise.resolve([{ block_order: blockOrder }]);
    if (sql.startsWith("SELECT source_refs FROM opening_teaching_activity_specs")) return Promise.resolve([{ source_refs: refs }]);
    if (sql.startsWith("SELECT s.name,s.version")) {
      if (sourceFault) throw failure;
      return Promise.resolve(missingSource ? [] : [{ name: values[1] === a ? "Alpha" : "Beta", version: 9, upload_state: "uploaded", deleted: unavailable.includes(String(values[1])), historical: true, ...sourceState }]);
    }
    if (sql.startsWith("INSERT INTO library_") || sql.startsWith("INSERT INTO opening_note_provenance")) return Promise.resolve([]);
    if (sql.startsWith("SELECT id FROM course_asset_memberships")) return Promise.resolve([{ id: id(8) }]);
    if (sql.startsWith("INSERT INTO opening_learning_asset_links")) {
      saved = { id: id(9), workspace_id: values[0], owner_user_id: values[1], asset_type: values[2], asset_id: values[3], asset_version: values[4],
        course_id: values[5], goal_id: values[6], requirement_id: values[7], purpose: values[8], origin_json: values[9], source_refs: values[10], client_key: values[11], create_intent: values[12],
        status: "active", revision: 1, created_at: now, updated_at: now };
      return Promise.resolve([saved]);
    }
    if (sql.startsWith("SELECT d.id FROM library_documents")) return Promise.resolve([{ id: saved!.asset_id }]);
    if (sql.startsWith("SELECT course_id,content_version,checkpoint_json")) return Promise.resolve([{ course_id: courseId, content_version: contentVersion, checkpoint_json: {} }]);
    if (sql.startsWith("SELECT archived_at FROM courses")) return Promise.resolve([{ archived_at: null }]);
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const tx = Object.assign(query, { json: (value: unknown) => value }) as unknown as TransactionSql;
  const pool = vi.fn(() => { throw new Error("use tx, not pool"); });
  const sql = Object.assign(pool, { begin: async (fn: (client: TransactionSql) => unknown) => fn(tx) }) as unknown as Sql;
  return { tx, sql, pool, calls, writes, failure, getSaved: () => saved!, create: () => createOpeningStudyNoteRepository(sql).create(scope, selected) };
}

describe("study note → original activity lineage → persisted note and asset link", () => {
  it("persists the same full versioned refs in provenance and link, then reads version-pinned hrefs", async () => {
    const f = fixture();
    const result = studyNoteCreateResultSchema.parse(await f.create());
    const refs = [{ sourceId: a, sourceVersion: 2 }, { sourceId: b, sourceVersion: 0 }];
    expect(result.link.link.sourceRefs).toEqual(refs);
    expect(result.link.sourceHrefs.map(ref => ref.href)).toEqual([`/opening/library?source=${a}&version=2`, `/opening/library?source=${b}&version=0`]);
    expect(result.link.originHref).toBe(`/opening/courses/${courseId}/study?activity=${activityId}`);
    const provenance = f.writes.find(call => call.sql.startsWith("INSERT INTO opening_note_provenance"))!;
    const link = f.writes.find(call => call.sql.startsWith("INSERT INTO opening_learning_asset_links"))!;
    expect(provenance.values).toEqual([result.documentId, scope.workspaceId, refs]);
    expect(link.values.slice(0, 9)).toEqual([scope.workspaceId, scope.ownerUserId, "document", result.documentId, null, null, null, null, "exploration"]);
    expect(link.values[10]).toEqual(refs);
    expect(link.values[12]).toEqual({ kind: "study-note", input });
    expect(f.pool).not.toHaveBeenCalled();
    expect(f.writes.map(call => call.sql.split("(")[0]!.trim())).toEqual(["INSERT INTO opening_workspace_history_revisions", "INSERT INTO library_documents", "INSERT INTO library_blocks", "INSERT INTO library_revisions", "INSERT INTO opening_note_provenance", "INSERT INTO opening_learning_asset_links"]);
    const spec = f.calls.find(call => call.sql.startsWith("SELECT source_refs"))!;
    expect(spec.values).toEqual([activityId, scope.workspaceId, scope.ownerUserId, null, null]);
    expect(f.calls.slice(0, 5).map(call => call.sql)).toEqual([
      "SELECT id FROM workspaces WHERE id=? AND owner_user_id=?",
      "INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision) VALUES (?,?,0) ON CONFLICT DO NOTHING",
      "SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=? AND owner_user_id=? FOR UPDATE",
      "SELECT id FROM workspaces WHERE id=? AND owner_user_id=? FOR UPDATE",
      "SELECT * FROM opening_learning_asset_links WHERE workspace_id=? AND owner_user_id=? AND client_key=?",
    ]);
    expect(f.calls.slice(0, 4).every(call => JSON.stringify(call.values) === JSON.stringify([scope.workspaceId, scope.ownerUserId]))).toBe(true);
    expect(f.calls[4]!.values).toEqual([scope.workspaceId, scope.ownerUserId, input.clientKey]);
  });
  it("keeps note text, generated document/block identities and the first revision snapshot aligned", async () => {
    const f = fixture(); const result = await f.create();
    const document = f.writes.find(call => call.sql.startsWith("INSERT INTO library_documents"))!;
    const block = f.writes.find(call => call.sql.startsWith("INSERT INTO library_blocks"))!;
    const revision = f.writes.find(call => call.sql.startsWith("INSERT INTO library_revisions"))!;
    const content = { blockNoteContent: [{ type: "text", text: input.text, styles: {} }], props: null, children: [] };
    expect(document.values).toEqual([result.documentId, scope.workspaceId, input.title]);
    expect(block.values).toEqual([expect.any(String), scope.workspaceId, result.documentId, content]);
    expect(revision.values).toEqual([expect.any(String), scope.workspaceId, result.documentId, input.title,
      [{ id: block.values[0], type: "paragraph", position: 0, content }]]);
    expect(new Set([result.documentId, block.values[0], revision.values[0]]).size).toBe(3);
  });
  it("pins the original block version through resolver, provenance, create intent and return href", async () => {
    const selected = { ...input, origin: { ...input.origin!, contentVersion: 7, blockId: id(10) } };
    const f = fixture({ selected, refs: [{ sourceId: a, version: "2" }] });
    const result = await f.create();
    expect(result.link.originHref).toBe(`/opening/courses/${courseId}/study?activity=${activityId}&block=${id(10)}&contentVersion=7`);
    expect(result.link.link.origin).toMatchObject({ contentVersion: 7, blockId: id(10) });
    const spec = f.calls.find(call => call.sql.startsWith("SELECT source_refs"))!;
    expect(spec.values).toEqual([activityId, scope.workspaceId, scope.ownerUserId, 7, 7]);
    const available = f.calls.find(call => call.sql.startsWith("SELECT s.id FROM opening_sources"))!;
    expect(available.values).toEqual([a, scope.workspaceId, true, 2, 2, 2]);
    expect(f.writes.find(call => call.sql.startsWith("INSERT INTO opening_learning_asset_links"))!.values[12]).toEqual({ kind: "study-note", input: selected });
  });
  it.each(["activity", "spec", "block"])("rejects a stale %s identity before any note write", async mismatch => {
    const selected = { ...input, origin: { ...input.origin!, contentVersion: 7, blockId: id(10) } };
    const f = fixture({ selected, contentVersion: mismatch === "activity" ? 8 : 7, specVersion: mismatch === "spec" ? 8 : 7,
      blockOrder: [{ blockId: mismatch === "block" ? id(11) : id(10) }] });
    await expect(f.create()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.writes).toHaveLength(1);
  });
  it("prefers explicit sourceVersion zero over legacy version and deduplicates only identical source/version pairs", async () => {
    const refs = [{ sourceId: a, sourceVersion: 0, version: "9" }, { sourceId: a, version: "0" }, { sourceId: a, version: "2" }];
    const before = structuredClone(refs), f = fixture({ refs }); const result = await f.create();
    expect(result.link.link.sourceRefs).toEqual([{ sourceId: a, sourceVersion: 0 }, { sourceId: a, sourceVersion: 2 }]);
    expect(f.calls.filter(call => call.sql.startsWith("SELECT s.name")).map(call => call.values)).toEqual([[0, a, scope.workspaceId], [2, a, scope.workspaceId], [0, a, scope.workspaceId], [2, a, scope.workspaceId]]);
    expect(refs).toEqual(before);
  });
  it("uses the resolved pinned source as fallback when an activity has selected sources but no spec refs", async () => {
    const selected = { ...input, origin: { ...input.origin!, sourceId: a, sourceVersion: 2 } };
    const f = fixture({ selected, refs: null }); const result = await f.create();
    expect(result.link.link.sourceRefs).toEqual([{ sourceId: a, sourceVersion: 2 }]);
    expect(result.link.link.origin).toMatchObject({ sourceId: a, sourceVersion: 2 });
    expect(f.calls.filter(call => call.sql.startsWith("SELECT s.name")).every(call => call.values[0] === 2)).toBe(true);
    expect(f.calls.some(call => call.sql.startsWith("SELECT asset_id,purpose"))).toBe(false);
  });
  it("preserves pinned receipt lineage on replay instead of resolving newly malformed activity specs", async () => {
    const original = fixture(); const first = await original.create();
    const replay = fixture({ receipt: original.getSaved(), refs: [{ sourceId: b }], activitySources: [b] });
    const result = await replay.create();
    expect(result).toEqual(first);
    expect(replay.calls.some(call => call.sql.startsWith("SELECT source_refs") || call.sql.startsWith("SELECT * FROM opening_teaching_activities"))).toBe(false);
    expect(replay.writes.map(call => call.sql.split("(")[0]!.trim())).toEqual(["INSERT INTO opening_workspace_history_revisions"]);
    expect(replay.calls.filter(call => call.sql.startsWith("SELECT s.name")).map(call => call.values)).toEqual([[2, a, scope.workspaceId], [0, b, scope.workspaceId]]);
  });
  it("returns unavailable receipt history without deleting stored refs or repinning to a newer source", async () => {
    const original = fixture(); const first = await original.create();
    const replay = fixture({ receipt: original.getSaved(), unavailable: [b] }); const result = await replay.create();
    expect(result.documentId).toBe(first.documentId);
    expect(result.link.link.sourceRefs).toEqual(first.link.link.sourceRefs);
    expect(result.link.sourceHrefs.map(ref => ref.href)).toEqual([`/opening/library?source=${a}&version=2`]);
    expect(result.link.originAvailable).toBe(false); expect(result.link.originHref).toBeNull();
    expect(result.link.warnings).toContain("一条原材料引用已不可读取，保留其版本记录。");
    expect(replay.calls.some(call => call.sql.startsWith("SELECT source_refs"))).toBe(false);
    expect(replay.writes).toHaveLength(1);
  });
  it("keeps raw create intent distinct from normalized refs when checking receipt identity", async () => {
    const original = fixture(); await original.create();
    const selected = { ...input, origin: { ...input.origin!, sourceVersion: null } };
    const replay = fixture({ selected, receipt: original.getSaved() });
    await expect(replay.create()).rejects.toMatchObject({ code: "CONFLICT", message: "这次保存的原请求内容已变化，请保留原请求核对。" });
    expect(replay.calls.some(call => call.sql.startsWith("SELECT s.name") || call.sql.startsWith("SELECT * FROM opening_teaching_activities"))).toBe(false);
    expect(replay.writes).toHaveLength(1);
  });
  it("merges the anchor's pinned source and spec versions without collapsing different versions to current v9", async () => {
    const selected = { ...input, origin: { ...input.origin!, sourceId: a, sourceVersion: 2 } };
    const f = fixture({ selected, refs: [{ sourceId: a, version: "2" }, { sourceId: a, version: "3" }, { sourceId: b, sourceVersion: 0 }] });
    const result = await f.create();
    expect(result.link.link.sourceRefs).toEqual([{ sourceId: a, sourceVersion: 2 }, { sourceId: a, sourceVersion: 3 }, { sourceId: b, sourceVersion: 0 }]);
    expect(f.writes.find(call => call.sql.startsWith("INSERT INTO opening_note_provenance"))!.values[2]).toEqual(result.link.link.sourceRefs);
  });
  it("retains an explicitly resolved anchor source even when the activity spec only lists another source", async () => {
    const selected = { ...input, origin: { ...input.origin!, sourceId: a, sourceVersion: 2 } };
    const f = fixture({ selected, refs: [{ sourceId: b, sourceVersion: 0 }] }); const result = await f.create();
    expect(result.link.link.sourceRefs).toEqual([{ sourceId: a, sourceVersion: 2 }, { sourceId: b, sourceVersion: 0 }]);
    expect(f.calls.filter(call => call.sql.startsWith("SELECT s.name")).slice(0, 2).map(call => call.values)).toEqual([[2, a, scope.workspaceId], [0, b, scope.workspaceId]]);
    expect(f.writes.find(call => call.sql.startsWith("INSERT INTO opening_note_provenance"))!.values[2]).toEqual(result.link.link.sourceRefs);
  });
  it("allows an activity with no selected sources and absent spec to remain known source-free", async () => {
    const f = fixture({ refs: null, activitySources: [] }); const result = await f.create();
    expect(result.link.link.sourceRefs).toEqual([]);
    expect(f.calls.some(call => call.sql.startsWith("SELECT s.name"))).toBe(false);
  });
  it.each([
    ["missing version", [{ sourceId: a }]], ["invalid source UUID", [{ sourceId: "bad", version: 2 }]],
    ["negative version", [{ sourceId: a, version: -1 }]], ["fractional version", [{ sourceId: a, version: "2.5" }]],
    ["explicit malformed sourceVersion overrides a legal version", [{ sourceId: a, sourceVersion: "2", version: 2 }]],
    ["one invalid among valid", [{ sourceId: a, version: 2 }, { sourceId: b }]],
  ])("refuses %s before writing the note or link", async (_label, refs) => {
    const f = fixture({ refs });
    await expect(f.create()).rejects.toMatchObject({ code: "CONFLICT", message: "原活动出处版本不完整，请先核对原材料；未保存关联。" });
    expect(f.writes.filter(call => !call.sql.includes("opening_workspace_history_revisions"))).toEqual([]);
    expect(f.calls.some(call => call.sql.startsWith("SELECT s.name"))).toBe(false);
  });
  it("rejects an unavailable second dependency without switching either ref to current v9", async () => {
    const f = fixture({ unavailable: [b] });
    await expect(f.create()).rejects.toMatchObject({ code: "CONFLICT", message: "原材料版本已不可用，未切换到新材料保存。" });
    expect(f.calls.filter(call => call.sql.startsWith("SELECT s.name")).map(call => call.values)).toEqual([[2, a, scope.workspaceId], [0, b, scope.workspaceId]]);
    expect(f.writes).toHaveLength(1);
  });
  it.each([null, {}])("rejects absent/nonarray spec refs when the activity selected sources: %j", async refs => {
    const f = fixture({ refs });
    await expect(f.create()).rejects.toMatchObject({ code: "CONFLICT", message: "原活动缺少可确认的出处版本，请先从原资料入口记录笔记。" });
    expect(f.writes).toHaveLength(1);
  });
  it("allows an explicit empty consumed lineage even when activity selection lists sources", async () => {
    const f = fixture({ refs: [] });
    const result = await f.create();
    expect(result.link.link.sourceRefs).toEqual([]);
    expect(result.link.sourceHrefs).toEqual([]);
    expect(f.calls.some(call => call.sql.startsWith("SELECT s.name"))).toBe(false);
  });
  it.each([
    ["historical version absent", { historical: false }], ["source upload not complete", { upload_state: "pending" }],
  ])("does not persist an origin whose %s", async (_label, sourceState) => {
    const f = fixture({ sourceState });
    await expect(f.create()).rejects.toMatchObject({ code: "CONFLICT", message: "原材料版本已不可用，未切换到新材料保存。" });
    expect(f.writes).toHaveLength(1);
    expect(f.calls.filter(call => call.sql.startsWith("SELECT s.name")).map(call => call.values)).toEqual([[2, a, scope.workspaceId]]);
  });
  it("does not silently convert a disappeared source into known empty provenance", async () => {
    const f = fixture({ missingSource: true });
    await expect(f.create()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.writes).toHaveLength(1);
  });
  it("propagates source storage failure rather than persisting an empty-lineage note", async () => {
    const f = fixture({ sourceFault: true });
    await expect(f.create()).rejects.toBe(f.failure);
    expect(f.writes).toHaveLength(1);
  });
  it.each(["INSERT INTO library_documents", "INSERT INTO library_blocks", "INSERT INTO library_revisions", "INSERT INTO opening_note_provenance", "INSERT INTO opening_learning_asset_links"])("does not attempt later writes after %s rejects", async insertFault => {
    const f = fixture({ insertFault });
    await expect(f.create()).rejects.toBe(f.failure);
    expect(f.writes.at(-1)!.sql.startsWith(insertFault)).toBe(true);
    // Prior attempted fake writes are not committed rows or a rollback proof.
  });
  it("resolves no-origin as known source-free without performing any storage query", async () => {
    const f = fixture();
    expect(await resolveLearningAssetOrigin(f.tx, scope, null)).toEqual({ origin: null, refs: [] });
    expect(f.calls).toEqual([]);
  });
});
