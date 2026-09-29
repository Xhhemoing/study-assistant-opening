import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations, createSqlClient, createIdentityRepository, createLibraryRepository, createBackupRestoreRepository,
  createOpeningBudgetRepository, createOpeningEphemeralProvenanceRepository, createOpeningNoteRepository,
} from "@aistudy/database";
import type { ContextSourceRef } from "@aistudy/database";

const sql = createSqlClient(process.env.DATABASE_URL!);
const library = createLibraryRepository(sql), backups = createBackupRestoreRepository(sql);
const provenance = createOpeningEphemeralProvenanceRepository(sql), notes = createOpeningNoteRepository(sql);
const scopes: Array<{ workspaceId: string; ownerUserId: string }> = [];
let scope: { workspaceId: string; ownerUserId: string };
beforeAll(async () => { await applyMigrations(sql); });
beforeEach(async () => {
  const owner = await createIdentityRepository(sql).createUserWithWorkspace({ email: `${randomUUID()}@example.com`, displayName: "Snippet owner", passwordHash: "unused" });
  scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };
  scopes.push(scope);
});
afterAll(async () => {
  await wipeNotes();
  for (const owner of scopes) {
    await sql`DELETE FROM workspaces WHERE id=${owner.workspaceId}`;
    await sql`DELETE FROM users WHERE id=${owner.ownerUserId}`;
  }
  await sql.end({ timeout: 5 });
});
// Test-only isolated database reset preserves the production append-only revision trigger.
async function wipeNotes() { await sql`TRUNCATE library_documents RESTART IDENTITY CASCADE`; }
async function source() {
  const id = randomUUID();
  await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${scope.workspaceId},'source.txt','text/plain',1,${'a'.repeat(64)},0,'uploaded','ready')`;
  return id;
}
async function receipt(refs: ContextSourceRef[] | null, owner = scope) {
  const requestId = `test:${randomUUID()}`;
  const reserved = await createOpeningBudgetRepository(sql, { dailyCapCents: 100_000 }).reserve(owner, { purpose: "tutor", amountCents: 1, requestId });
  const epoch = Number((await sql`SELECT privacy_epoch FROM workspaces WHERE id=${owner.workspaceId}`)[0]!.privacy_epoch);
  const exposedId = await provenance.record(owner, { requestId, privacyEpoch: epoch, contextSourceRefs: refs });
  return { id: reserved.id, exposedId, epoch };
}
async function save(refs: ContextSourceRef[] = []) {
  const proof = await receipt(refs);
  const result = await notes.saveSnippet(scope, { title: "Linked snippet", text: "ONLY-CONFIRMED-EXCERPT", provenanceId: proof.id });
  return { ...result, proof };
}
async function exclude(sourceId: string, permanent = false) {
  await sql.begin(async tx => {
    await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    await tx`INSERT INTO opening_privacy_exclusions(id,workspace_id,source_id,deleted_at,asset_deleted_at)
      VALUES(${randomUUID()},${scope.workspaceId},${sourceId},now(),${permanent ? new Date() : null})`;
    await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
  });
}

describe("Opening linked note persistence", () => {
  it("resolves complete history from owned receipt rows, with missing, foreign and unknown receipts isolated", async () => {
    const sourceId = await source();
    const proof = await receipt([{ sourceId, sourceVersion: 0 }]);
    expect(await provenance.resolveHistory(scope, [{ provenanceId: proof.id }], proof.epoch)).toEqual([{ sourceId, sourceVersion: 0 }]);
    expect(await provenance.resolveHistory(scope, [{}], proof.epoch)).toBeNull();
    expect(await provenance.resolveHistory({ ...scope, ownerUserId: randomUUID() }, [{ provenanceId: proof.id }], proof.epoch)).toBeNull();
    const unknown = await receipt(null);
    expect(unknown.exposedId).toBeNull();
    expect(await provenance.resolveHistory(scope, [{ provenanceId: unknown.id }], proof.epoch)).toBeNull();
    await expect(notes.saveSnippet(scope, { title: "unknown", text: "must not save", provenanceId: unknown.id })).rejects.toMatchObject({ code: "PROVENANCE_UNKNOWN" });
    expect(await library.listDocuments({ workspaceId: scope.workspaceId })).toEqual([]);
  });

  it("stores only confirmed excerpt and retains source linkage through ordinary edits and receipt cleanup", async () => {
    const sourceId = await source();
    const { documentId, proof } = await save([{ sourceId, sourceVersion: 0 }]);
    const original = await library.getDocument({ workspaceId: scope.workspaceId, documentId });
    expect(original.blocks[0]!.content).toMatchObject({ blockNoteContent: "ONLY-CONFIRMED-EXCERPT" });
    await library.updateDocument({ workspaceId: scope.workspaceId, documentId, expectedRevisionNumber: 1,
      title: "Edited note", blocks: [{ id: original.blocks[0]!.id, type: "paragraph", content: { blockNoteContent: "USER-EDITED-EXCERPT", props: null, children: [] } }] });
    await sql`DELETE FROM opening_budget_reservations WHERE id=${proof.id}`;
    expect((await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)[0]!.context_source_refs).toEqual([{ sourceId, sourceVersion: 0 }]);
    expect((await library.getDocument({ workspaceId: scope.workspaceId, documentId })).blocks[0]!.content).toMatchObject({ blockNoteContent: "USER-EDITED-EXCERPT" });
  });

  it("allows personal reading after AI exclusion while blocking new saves, export and old-backup restore", async () => {
    const sourceId = await source();
    const { documentId, proof } = await save([{ sourceId, sourceVersion: 0 }]);
    const packed = await backups.exportWorkspace(scope);
    await exclude(sourceId);
    expect((await library.getDocument({ workspaceId: scope.workspaceId, documentId })).id).toBe(documentId);
    await expect(notes.saveSnippet(scope, { title: "no copy", text: "must not save", provenanceId: proof.id })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    const filtered = await backups.exportWorkspace(scope);
    expect(JSON.stringify(filtered)).not.toContain("ONLY-CONFIRMED-EXCERPT");
    expect(filtered.records.documents).toEqual([]);
    await wipeNotes();
    await expect(backups.restoreWorkspace({ ...scope, packed, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await library.listDocuments({ workspaceId: scope.workspaceId })).toEqual([]);
  });

  it("hides current body, old revisions, block reads and search after permanent source deletion", async () => {
    const sourceId = await source();
    const { documentId } = await save([{ sourceId, sourceVersion: 0 }]);
    const original = await library.getDocument({ workspaceId: scope.workspaceId, documentId });
    await exclude(sourceId, true);
    await expect(library.getDocument({ workspaceId: scope.workspaceId, documentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(library.getBlock({ workspaceId: scope.workspaceId, blockId: original.blocks[0]!.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(library.getRevision({ workspaceId: scope.workspaceId, documentId, revisionNumber: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(library.listRevisions({ workspaceId: scope.workspaceId, documentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await library.listDocuments({ workspaceId: scope.workspaceId })).toEqual([]);
    expect(await library.searchLibrary({ workspaceId: scope.workspaceId, query: "ONLY-CONFIRMED" })).toEqual([]);
    await expect(library.updateDocument({ workspaceId: scope.workspaceId, documentId, expectedRevisionNumber: 1, blocks: [{ id: original.blocks[0]!.id, type: "paragraph", content: { text: "revive" } }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(await backups.exportWorkspace(scope))).not.toContain("ONLY-CONFIRMED-EXCERPT");
  });

  it("round-trips linkage beside a real source/course membership without pretending native backup includes the source", async () => {
    const sourceId = await source(), courseId = randomUUID();
    await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Source course',${randomUUID()})`;
    await sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
      VALUES(${randomUUID()},${scope.workspaceId},${courseId},'source',${sourceId},'core',0,'course')`;
    const { documentId } = await save([{ sourceId, sourceVersion: 0 }]);
    const packed = await backups.exportWorkspace(scope);
    expect(packed.records.memberships).toEqual([]);
    expect(packed.records.documents[0]).toMatchObject({ id: documentId, openingProvenance: { contextSourceRefs: [{ sourceId, sourceVersion: 0 }] } });
    await wipeNotes();
    await backups.restoreWorkspace({ ...scope, packed, conflictPolicy: "skip" });
    expect((await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)[0]!.context_source_refs).toEqual([{ sourceId, sourceVersion: 0 }]);
    await exclude(sourceId, true);
    await expect(library.getDocument({ workspaceId: scope.workspaceId, documentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects cross-workspace, absent-source, unknown and stripped-provenance restores atomically", async () => {
    const sourceId = await source();
    await save([{ sourceId, sourceVersion: 0 }]);
    const packed = await backups.exportWorkspace(scope);
    const other = await createIdentityRepository(sql).createUserWithWorkspace({ email: `${randomUUID()}@example.com`, displayName: "Other", passwordHash: "unused" });
    const otherScope = { workspaceId: other.workspace.id, ownerUserId: other.user.id }; scopes.push(otherScope);
    const foreignPacked = structuredClone(packed);
    const foreignDocumentId = randomUUID(), foreignBlockId = randomUUID();
    (foreignPacked.records.documents[0] as Record<string, unknown>).id = foreignDocumentId;
    for (const raw of foreignPacked.records.blocks) Object.assign(raw as object, { id: foreignBlockId, documentId: foreignDocumentId });
    for (const raw of foreignPacked.records.revisions) {
      const revision = raw as Record<string, unknown>;
      Object.assign(revision, { id: randomUUID(), documentId: foreignDocumentId });
      for (const block of revision.blocks as Array<Record<string, unknown>>) block.id = foreignBlockId;
    }
    await expect(backups.restoreWorkspace({ ...otherScope, packed: foreignPacked, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM library_documents WHERE id=${foreignDocumentId}`).toHaveLength(0);
    expect(await library.listDocuments({ workspaceId: otherScope.workspaceId })).toEqual([]);
    await wipeNotes();
    const missing = structuredClone(packed); delete (missing.records.documents[0] as Record<string, unknown>).openingProvenance;
    await expect(backups.restoreWorkspace({ ...scope, packed: missing, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    const unknown = structuredClone(packed); (unknown.records.documents[0] as Record<string, unknown>).openingProvenance = { contextSourceRefs: null };
    await expect(backups.restoreWorkspace({ ...scope, packed: unknown, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    await sql`DELETE FROM opening_sources WHERE id=${sourceId}`;
    await expect(backups.restoreWorkspace({ ...scope, packed, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await library.listDocuments({ workspaceId: scope.workspaceId })).toEqual([]);
  });
});
