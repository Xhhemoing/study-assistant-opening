import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations, createSqlClient, createIdentityRepository, createLibraryRepository, createBackupRestoreRepository,
  createOpeningBudgetRepository, createOpeningEphemeralProvenanceRepository, createOpeningNoteRepository,
  createRevisionProposalRepository, createOpeningSourceActionsRepository,
} from "@aistudy/database";
import type { ContextSourceRef } from "@aistudy/database";
import { openRaceSession, closeRace, track, waitUntilBlocked } from "./opening-race-helpers";

const sql = createSqlClient(process.env.DATABASE_URL!);
const library = createLibraryRepository(sql), backups = createBackupRestoreRepository(sql);
const provenance = createOpeningEphemeralProvenanceRepository(sql), notes = createOpeningNoteRepository(sql);
const proposals = createRevisionProposalRepository(sql);
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
  const reserved = await createOpeningBudgetRepository(sql, { envCapCents: 100_000 }).reserve(owner, { purpose: "tutor", amountCents: 1, requestId });
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

const proposalSource = { kind: "user" as const, provider: null, model: null, sourceId: null, metadata: {} };
const sourceKeys = { stagingKey: (id: string) => `opening/sources/${id}/staging`, finalKey: (id: string, version: number) => `opening/sources/${id}/${version}` };
async function proposalFixture(status: "pending" | "conflicted" | "accepted" | "rejected" = "pending") {
  const sourceId = await source();
  const { documentId } = await save([{ sourceId, sourceVersion: 0 }]);
  const document = await library.getDocument({ workspaceId: scope.workspaceId, documentId });
  const proposedBlocks = [{ ...document.blocks[0]!, content: { text: "PRIVATE-PROPOSED-SNAPSHOT" } }];
  const input = { workspaceId: scope.workspaceId, documentId, baseRevisionNumber: 1, proposedBlocks, source: proposalSource, supportState: "supported" as const };
  const proposal = await proposals.create(input);
  if (status === "conflicted") {
    await library.updateDocument({ workspaceId: scope.workspaceId, documentId, expectedRevisionNumber: 1,
      blocks: [{ ...document.blocks[0]!, content: { text: "PRIVATE-CURRENT-CONFLICT" } }] });
    await proposals.review({ workspaceId: scope.workspaceId, proposalId: proposal.id, action: "accept", actorUserId: scope.ownerUserId });
  } else if (status !== "pending") {
    await proposals.review({ workspaceId: scope.workspaceId, proposalId: proposal.id, action: status === "accepted" ? "accept" : "reject", actorUserId: scope.ownerUserId });
  }
  return { sourceId, documentId, proposal, input };
}
async function proposalState(documentId: string) {
  return {
    proposals: await sql`SELECT * FROM revision_proposals WHERE document_id=${documentId} ORDER BY id`,
    document: await sql`SELECT * FROM library_documents WHERE id=${documentId}`,
    blocks: await sql`SELECT * FROM library_blocks WHERE document_id=${documentId} ORDER BY position`,
    revisions: await sql`SELECT * FROM library_revisions WHERE document_id=${documentId} ORDER BY revision_number`,
  };
}

describe("Opening linked note revision proposal privacy", () => {
  it.each(["pending", "conflicted", "accepted", "rejected"] as const)("hides %s snapshots and denies every mutation after permanent source deletion", async status => {
    const fixture = await proposalFixture(status);
    const before = await proposalState(fixture.documentId);
    await createOpeningSourceActionsRepository(sql).apply(scope, fixture.sourceId,
      { action: "delete", expectedVersion: 0, expectedMembershipIds: [] }, sourceKeys, new Date());
    const target = { workspaceId: scope.workspaceId, proposalId: fixture.proposal.id };
    await expect(proposals.get(target)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(proposals.list({ workspaceId: scope.workspaceId, documentId: fixture.documentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const action of ["accept", "partial_accept", "reject"] as const) {
      await expect(proposals.review({ ...target, action, selectedProposalBlockIds: fixture.proposal.proposedBlocks.map(block => block.id), actorUserId: scope.ownerUserId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(proposals.resolveConflict({ ...target, action: "preserve_both", selectedProposalBlockIds: fixture.proposal.proposedBlocks.map(block => block.id), actorUserId: scope.ownerUserId, expectedCurrentRevisionNumber: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(proposals.create(fixture.input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await proposalState(fixture.documentId)).toEqual(before);
  });

  it.each(["accept", "partial_accept", "reject"] as const)("allows %s and new personal proposals after AI-only exclusion", async action => {
    const fixture = await proposalFixture();
    await exclude(fixture.sourceId);
    const created = await proposals.create(fixture.input);
    expect((await proposals.get({ workspaceId: scope.workspaceId, proposalId: created.id })).baseBlocks).toEqual(fixture.proposal.baseBlocks);
    expect(await proposals.list({ workspaceId: scope.workspaceId, documentId: fixture.documentId })).toHaveLength(2);
    const result = await proposals.review({ workspaceId: scope.workspaceId, proposalId: created.id, action, actorUserId: scope.ownerUserId, selectedProposalBlockIds: created.proposedBlocks.map(block => block.id) });
    expect(result.proposal.status).toBe(action === "reject" ? "rejected" : "accepted");
  });

  it("allows personal conflict snapshots and resolution after AI-only exclusion", async () => {
    const fixture = await proposalFixture("conflicted");
    await exclude(fixture.sourceId);
    const target = { workspaceId: scope.workspaceId, proposalId: fixture.proposal.id };
    expect((await proposals.get(target)).conflict?.currentBlocks[0]!.content).toEqual({ text: "PRIVATE-CURRENT-CONFLICT" });
    const result = await proposals.resolveConflict({ ...target, action: "preserve_both", selectedProposalBlockIds: fixture.proposal.proposedBlocks.map(block => block.id), actorUserId: scope.ownerUserId, expectedCurrentRevisionNumber: 2 });
    expect(result.proposal.status).toBe("accepted");
    expect(result.document?.currentRevisionNumber).toBe(3);
  });

  it.each(["get", "review", "resolve"] as const)("serializes %s behind in-flight permanent deletion before exposing or changing snapshots", async operation => {
    const fixture = await proposalFixture(operation === "resolve" ? "conflicted" : "pending");
    const before = await proposalState(fixture.documentId);
    const gate = openRaceSession(), deletion = openRaceSession(), reader = openRaceSession();
    let unlock = () => {};
    const pending: Promise<unknown>[] = [];
    try {
      const [gateSession, deletionSession, readerSession] = await Promise.all([gate.ready, deletion.ready, reader.ready]);
      let opened = () => {};
      const locked = new Promise<void>(resolve => { opened = resolve; });
      const released = new Promise<void>(resolve => { unlock = resolve; });
      const held = track(gateSession.sql.begin(async tx => {
        await tx`SELECT id FROM opening_sources WHERE id=${fixture.sourceId} FOR UPDATE`;
        opened();
        await released;
      }));
      pending.push(held);
      await Promise.race([locked, held]);
      const deleted = track(createOpeningSourceActionsRepository(deletionSession.sql).apply(scope, fixture.sourceId,
        { action: "delete", expectedVersion: 0, expectedMembershipIds: [] }, sourceKeys, new Date()));
      pending.push(deleted);
      await waitUntilBlocked(sql, deletionSession.pid, gateSession.pid, "source deletion", /FROM opening_sources[\s\S]*FOR UPDATE/i);
      const repository = createRevisionProposalRepository(readerSession.sql);
      const target = { workspaceId: scope.workspaceId, proposalId: fixture.proposal.id };
      const read = track<unknown>(operation === "get" ? repository.get(target)
        : operation === "review" ? repository.review({ ...target, action: "accept", actorUserId: scope.ownerUserId })
          : repository.resolveConflict({ ...target, action: "preserve_both", selectedProposalBlockIds: fixture.proposal.proposedBlocks.map(block => block.id), actorUserId: scope.ownerUserId, expectedCurrentRevisionNumber: 2 }));
      pending.push(read);
      await waitUntilBlocked(sql, readerSession.pid, deletionSession.pid, `proposal ${operation}`, /FROM workspaces[\s\S]*FOR (UPDATE|SHARE)/i);
      unlock();
      await held;
      await deleted;
      await expect(read).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await proposalState(fixture.documentId)).toEqual(before);
    } finally {
      unlock();
      await Promise.allSettled(pending);
      await Promise.all([closeRace(gate.sql), closeRace(deletion.sql), closeRace(reader.sql)]);
    }
  }, 20_000);
});
