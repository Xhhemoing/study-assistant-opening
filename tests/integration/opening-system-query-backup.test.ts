import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyOpeningRestore, createOpeningConversationRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import { validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { createBackupFixture, type BackupFixture } from "./opening-backup-records-fixture";
let fixture: BackupFixture;
beforeEach(async () => { fixture = await createBackupFixture(); });
afterEach(async () => { await fixture?.dispose(); });

it.each(["record_lookup", "source_review", "link_only"])("rejects a query archive hiding deleted source information (%s), then reads a safe restored archive", async kind => {
  const { sql, scope, rows } = fixture, conversationId = await rows.conversation(); await rows.turn(conversationId);
  const snapshot = await readOpeningBackupRecords(sql, scope);
  const safe: OpeningBackup = JSON.parse(JSON.stringify({ format: "opening-backup", version: 1, workspaceId: scope.workspaceId, ...snapshot, objects: [] }));
  const hostile = structuredClone(safe), sourceId = randomUUID(), asOf = "2026-10-19T00:00:00Z";
  const authorization = { purpose: kind === "source_review" ? "source_review" : "system_record_lookup", workspaceId: scope.workspaceId, principalId: scope.ownerUserId, role: "workspace_owner", permissionRevision: "owner-fixture" };
  const mark = { sourceId, deletedAt: asOf, assetDeletedAt: asOf }; hostile.deletionJournal = [mark];
  const row = hostile.tables.opening_turns[0] as Record<string, unknown>;
  row.query_system = true; row.text = "DELETED_QUERY_INFORMATION";
  row.system_query = { authorization, version: "study-query-v1", asOf, privacyEpoch: 0, mode: "deterministic", status: "ok", reason: "read", results: [{
    authorization, name: "materials", status: "ok", reason: "read", asOf, version: "1", sourceRefs: [], nextOffset: null,
    evidence: [{ id: "material", kind: "material", title: "DELETED_SOURCE_TITLE", href: `/opening/library?source=${sourceId}&version=1`, ...(kind === "link_only" ? {} : { sourceId, sourceVersion: 1 }) }],
    data: kind === "link_only" ? [] : [{ id: randomUUID(), sourceId, sourceVersion: 1, physicalPage: 1, truncated: false, exposure: "content_withheld", summary: "DELETED_SOURCE_SUMMARY", ...(kind === "source_review" ? { excerpt: "DELETED_ANSWER" } : {}) }],
  }] };
  const preview = validateOpeningRestore(hostile, [mark], snapshot.memoryDeletions);
  expect(preview.allowed).toBe(false); expect(preview.errors).toContain("turn query receipt is invalid");
  if (kind !== "link_only") expect(preview.errors).toContain("table opening_turns references a deleted source");
  await sql`DELETE FROM opening_conversations WHERE id=${conversationId}`;
  const result = await applyOpeningRestore({ sql, confirmLocalRestore: true, backup: hostile, currentDeletionJournal: [mark], currentMemoryDeletions: snapshot.memoryDeletions });
  expect(result).toMatchObject({ ok: false, mutated: false });
  expect(await sql`SELECT id FROM opening_turns WHERE workspace_id=${scope.workspaceId}`).toHaveLength(0);
  expect(await applyOpeningRestore({ sql, confirmLocalRestore: true, backup: safe, currentDeletionJournal: [], currentMemoryDeletions: snapshot.memoryDeletions })).toMatchObject({ ok: true });
  const restored = await createOpeningConversationRepository(sql).listTurns(scope, conversationId);
  expect(restored).toHaveLength(1); expect(restored[0]!.systemQuery).toBeNull(); expect(JSON.stringify(restored)).not.toContain("DELETED_");
});

it("rejects an otherwise schema-valid source_review receipt even without a deletion journal", async () => {
  const { sql, scope, rows } = fixture, sourceId = await rows.source(), conversationId = await rows.conversation(); await rows.turn(conversationId);
  const snapshot = await readOpeningBackupRecords(sql, scope), asOf = "2026-10-19T00:00:00Z";
  const backup: OpeningBackup = JSON.parse(JSON.stringify({ format: "opening-backup", version: 1, workspaceId: scope.workspaceId, ...snapshot, objects: [] }));
  const authorization = { purpose: "source_review", workspaceId: scope.workspaceId, principalId: scope.ownerUserId, role: "workspace_owner", permissionRevision: "owner-fixture" };
  const ref = { sourceId, sourceVersion: 1 }, row = backup.tables.opening_turns[0] as Record<string, unknown>;
  row.query_system = true; row.context_source_refs = [ref];
  row.system_query = { authorization, version: "study-query-v1", asOf, privacyEpoch: 0, mode: "deterministic", status: "ok", reason: "read", results: [{
    authorization, name: "materials", status: "ok", reason: "read", asOf, version: "1", sourceRefs: [ref], evidence: [], nextOffset: null,
    data: [{ id: randomUUID(), ...ref, physicalPage: 1, truncated: false, exposure: "not_assessed", summary: "source review", excerpt: "ANSWER_NOT_FOR_CHAT" }],
  }] };
  expect(systemQueryReceiptSchema.safeParse(row.system_query).success).toBe(true);
  expect(validateOpeningRestore(backup, [], snapshot.memoryDeletions)).toMatchObject({ allowed: false, errors: expect.arrayContaining(["turn query receipt is invalid"]) });
  await sql`DELETE FROM opening_conversations WHERE id=${conversationId}`; await sql`DELETE FROM opening_sources WHERE id=${sourceId}`;
  expect(await applyOpeningRestore({ sql, confirmLocalRestore: true, backup, currentDeletionJournal: [], currentMemoryDeletions: snapshot.memoryDeletions })).toMatchObject({ ok: false, mutated: false });
  expect(await sql`SELECT id FROM opening_turns WHERE workspace_id=${scope.workspaceId}`).toHaveLength(0);
});

it.each(["data", "evidence", "link"])("redacts legacy query history after asset deletion even when only nested %s names the source", async location => {
  const { sql, scope, rows } = fixture, sourceId = await rows.source(), repo = createOpeningConversationRepository(sql);
  const conversation = await repo.create(scope, { title: "Legacy receipt", courseId: null });
  const saved = await repo.appendSavedTurn({ scope, conversationId: conversation.id, querySystem: true, text: "材料在哪页", mode: "listen", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  const nested = location === "data" ? { data: [{ sourceId, sourceVersion: 1 }] } : { evidence: [location === "evidence" ? { sourceId, sourceVersion: 1 } : { href: `/opening/library?source=${sourceId.toUpperCase()}&version=1` }] };
  await sql`UPDATE opening_turns SET text='LEGACY_DELETED_INFORMATION',status='complete',context_source_refs='[]'::jsonb,
    system_query=${sql.json({ results: [nested] })} WHERE id=${saved.assistantTurnId}`;
  await sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${saved.jobId}`;
  expect((await repo.listTurns(scope, conversation.id)).find(turn => turn.role === "assistant")!.text).toContain("无法核实");
  expect(JSON.stringify(await repo.listSummaries(scope))).not.toContain("LEGACY_DELETED_INFORMATION");
  await rows.exclude(sourceId); await sql`UPDATE opening_privacy_exclusions SET asset_deleted_at=now() WHERE workspace_id=${scope.workspaceId} AND source_id=${sourceId}`;
  const turn = (await repo.listTurns(scope, conversation.id)).find(turn => turn.role === "assistant")!;
  expect(turn.text).toBe("关联材料已删除，此回答内容不再显示。"); expect(turn.systemQuery).toBeNull();
  expect(JSON.stringify(await repo.loadContinuityTurns(scope, conversation.id))).not.toContain("LEGACY_DELETED_INFORMATION");
  expect(JSON.stringify(await repo.listSummaries(scope))).not.toContain("LEGACY_DELETED_INFORMATION");
  const next = await repo.appendSavedTurn({ scope, conversationId: conversation.id, text: "跟进", mode: "listen", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  expect((await createOpeningTutorJobsRepository(sql).loadHistoryContext(scope, next.turnId)).history).toEqual([]);
});
