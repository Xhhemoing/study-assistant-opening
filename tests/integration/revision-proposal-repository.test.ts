import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createRevisionProposalRepository, createSqlClient, type RevisionProposalRepository } from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for revision proposal repository tests");
const userId = randomUUID();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const documentId = randomUUID();
const blockId = randomUUID();
const proposedId = randomUUID();
const block = (id: string, text: string, position = 0) => ({ id, type: "paragraph", position, content: { text } });

describe("revision proposal repository", () => {
  const sql = createSqlClient(databaseUrl);
  let repository: RevisionProposalRepository;
  beforeAll(async () => { await applyMigrations(sql); repository = createRevisionProposalRepository(sql); });
  beforeEach(async () => {
    await sql`TRUNCATE revision_proposals, library_revisions, library_blocks, library_documents, sessions, workspaces, users RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO users (id,email,display_name,password_hash) VALUES (${userId},${`proposal-${randomUUID()}@example.com`},'Proposal user','test')`;
    await sql`INSERT INTO workspaces (id,owner_user_id) VALUES (${workspaceId},${userId}),(${otherWorkspaceId},${userId})`;
    await sql`INSERT INTO library_documents (id,workspace_id,title,lifecycle,current_revision_number) VALUES (${documentId},${workspaceId},'Base','confirmed',1)`;
    await sql`INSERT INTO library_blocks (id,workspace_id,document_id,type,position,content) VALUES (${blockId},${workspaceId},${documentId},'paragraph',0,${sql.json({ text: "current" })})`;
    await sql`INSERT INTO library_revisions (workspace_id,document_id,revision_number,title,lifecycle,reason,blocks) VALUES (${workspaceId},${documentId},1,'Base','confirmed','create',${sql.json([block(blockId,"current")])})`;
  });
  afterAll(async () => sql.end({ timeout: 5 }));

  it("stores immutable snapshots and deterministic diff", async () => {
    const proposal = await repository.create({ workspaceId, documentId, baseRevisionNumber: 1, proposedTitle: "Next", proposedBlocks: [block(blockId, "proposed"), block(proposedId, "added", 1)], source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} }, supportState: "supported" });
    expect(proposal).toMatchObject({
      status: "pending",
      baseRevisionNumber: 1,
      baseTitle: "Base",
      baseBlocks: [block(blockId, "current")],
      proposedTitle: "Next",
    });
    expect(proposal.diff.map((entry) => entry.kind)).toEqual(["changed", "added"]);
    await expect(repository.get({ workspaceId: otherWorkspaceId, proposalId: proposal.id })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
  });

  // The implementation must lock the current document before reading its blocks,
  // so base revision, title, and blocks are one immutable transaction snapshot.

  it("rejects terminal repeats and accepts with one append-only revision", async () => {
    const proposal = await repository.create({ workspaceId, documentId, baseRevisionNumber: 1, proposedBlocks: [block(blockId, "accepted")], source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} }, supportState: "partial" });
    const accepted = await repository.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: userId });
    const repeated = await repository.review({ workspaceId, proposalId: proposal.id, action: "reject", actorUserId: userId });
    const revisions = await sql`SELECT revision_number FROM library_revisions WHERE document_id=${documentId} ORDER BY revision_number`;
    expect(accepted.proposal.status).toBe("accepted");
    expect(repeated.proposal).toEqual(accepted.proposal);
    expect(revisions.map((row) => row.revision_number)).toEqual([1, 2]);
  });

  it("repeats an accepted decision idempotently after the target document is soft-deleted", async () => {
    const proposal = await repository.create({ workspaceId, documentId, baseRevisionNumber: 1, proposedBlocks: [block(blockId, "accepted")], source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} }, supportState: "supported" });
    const accepted = await repository.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: userId });
    await sql`UPDATE library_documents SET deleted_at=now() WHERE id=${documentId} AND workspace_id=${workspaceId}`;

    const repeated = await repository.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: userId });

    expect(repeated.proposal).toEqual(accepted.proposal);
    expect(repeated.document).toBeNull();
    expect((await sql`SELECT count(*)::int AS count FROM library_revisions WHERE document_id=${documentId}`)[0]!.count).toBe(2);
  });

  it("rejects removal-only partial acceptance without mutating the document or proposal", async () => {
    const proposal = await repository.create({
      workspaceId,
      documentId,
      baseRevisionNumber: 1,
      proposedBlocks: [block(proposedId, "replacement")],
      source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} },
      supportState: "partial",
    });

    await expect(repository.review({
      workspaceId,
      proposalId: proposal.id,
      action: "partial_accept",
      selectedProposalBlockIds: [blockId],
      actorUserId: userId,
    })).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Document requires at least one block",
    });

    const currentBlocks = await sql`SELECT id FROM library_blocks WHERE document_id=${documentId} ORDER BY position`;
    const revisions = await sql`SELECT revision_number FROM library_revisions WHERE document_id=${documentId} ORDER BY revision_number`;
    const storedProposal = await repository.get({ workspaceId, proposalId: proposal.id });
    expect(currentBlocks).toEqual([{ id: blockId }]);
    expect(revisions.map((row) => row.revision_number)).toEqual([1]);
    expect(storedProposal.status).toBe("pending");
  });

  it("marks stale acceptance conflicted without changing the document", async () => {
    const proposal = await repository.create({ workspaceId, documentId, baseRevisionNumber: 1, proposedBlocks: [block(blockId, "proposal")], source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} }, supportState: "supported" });
    await sql`UPDATE library_documents SET current_revision_number=2, title='Concurrent' WHERE id=${documentId}`;
    const result = await repository.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: userId });
    expect(result.proposal.status).toBe("conflicted");
    expect(result.document?.title).toBe("Concurrent");
    expect((await sql`SELECT count(*)::int AS count FROM library_revisions WHERE document_id=${documentId}`)[0]!.count).toBe(1);
  });

  it("rejects stale proposals terminally without adding a revision and is idempotent", async () => {
    const proposal = await repository.create({ workspaceId, documentId, baseRevisionNumber: 1, proposedBlocks: [block(blockId, "proposal")], source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} }, supportState: "supported" });
    await sql`UPDATE library_documents SET current_revision_number=2, title='Concurrent' WHERE id=${documentId}`;
    const rejected = await repository.review({ workspaceId, proposalId: proposal.id, action: "reject", actorUserId: userId });
    const repeated = await repository.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: userId });
    const revisions = await sql`SELECT revision_number FROM library_revisions WHERE document_id=${documentId} ORDER BY revision_number`;
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.proposal.review?.action).toBe("reject");
    expect(repeated.proposal).toEqual(rejected.proposal);
    expect(revisions.map((row) => row.revision_number)).toEqual([1]);
  });
});
