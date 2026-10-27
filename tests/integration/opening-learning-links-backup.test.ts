import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBackupRestoreRepository, createOpeningStudyNoteRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

it("round trips a real exploration note and detached association without creating learning evidence", async () => {
  const input = { title: "探索后的理解", text: "我需要先说明条件，再写推导。", clientKey: randomUUID(),
    courseId: null, goalId: null, requirementId: null, origin: null, purpose: "exploration" as const };
  const notes = createOpeningStudyNoteRepository(f.sql);
  const saved = await notes.create(f.scope, input);
  expect((await notes.create(f.scope, input)).documentId).toBe(saved.documentId);
  const backups = createBackupRestoreRepository(f.sql);
  const packed = await backups.exportWorkspace(f.scope);
  expect(packed.records.documents).toHaveLength(1);
  expect(packed.records.documents[0]?.learningAssetLinks).toEqual([
    expect.objectContaining({ id: saved.link.link.id, asset_id: saved.documentId, status: "active" }),
  ]);
  const copy = freshRecordIds(packed);
  const restored = await backups.restoreWorkspace({ ...f.otherScope, packed: copy.packed, conflictPolicy: "reject" });
  expect(restored.applied.documents).toBe(1);
  const documentId = copy.ids.get(saved.documentId)!;
  const [link] = await f.sql`SELECT status,asset_id,source_refs,origin_json FROM opening_learning_asset_links WHERE id=${copy.ids.get(saved.link.link.id)!}`;
  expect(link).toMatchObject({ status: "detached", asset_id: documentId, source_refs: [], origin_json: {} });
  const [block] = await f.sql`SELECT content FROM library_blocks WHERE document_id=${documentId}`;
  expect(JSON.stringify(block?.content)).toContain(input.text);
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  const skipped = await backups.restoreWorkspace({ ...f.otherScope, packed: copy.packed, conflictPolicy: "skip" });
  expect(skipped.skipped.documents).toBe(1);
  expect(await f.sql`SELECT id FROM opening_learning_asset_links WHERE workspace_id=${f.otherScope.workspaceId}`).toHaveLength(1);
});

it("rejects forged document associations and atomically rolls back note restore", async () => {
  const saved = await createOpeningStudyNoteRepository(f.sql).create(f.scope, {
    title: "待恢复", text: "保留内容", clientKey: randomUUID(), courseId: null, goalId: null,
    requirementId: null, origin: null, purpose: "understanding",
  });
  const backups = createBackupRestoreRepository(f.sql);
  const packed = await backups.exportWorkspace(f.scope);
  const links = packed.records.documents[0]!.learningAssetLinks as Record<string, unknown>[];
  links[0]!.asset_id = randomUUID();
  const copy = freshRecordIds(packed);
  await expect(backups.restoreWorkspace({ ...f.otherScope, packed: copy.packed, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await f.sql`SELECT id FROM library_documents WHERE id=${copy.ids.get(saved.documentId)!}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_learning_asset_links WHERE workspace_id=${f.otherScope.workspaceId}`).toHaveLength(0);
});

// Import a copy into an empty workspace without deleting append-only production-shaped history.
function freshRecordIds<T>(packed: T): { packed: T; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.id === "string") ids.set(row.id, randomUUID());
    Object.values(row).forEach(collect);
  };
  collect((packed as { records: unknown }).records);
  return { packed: JSON.parse(JSON.stringify(packed, (_key, value) => typeof value === "string" ? ids.get(value) ?? value : value)) as T, ids };
}
