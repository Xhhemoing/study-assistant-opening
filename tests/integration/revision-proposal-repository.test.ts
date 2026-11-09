import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createRevisionProposalRepository, createSqlClient, lockWorkspaceLearningHistory, type RevisionProposalRepository } from "@aistudy/database";
import type { Sql } from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for revision proposal repository tests");
const userId = randomUUID();
const otherUserId = randomUUID();
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
    await sql`INSERT INTO users (id,email,display_name,password_hash) VALUES (${userId},${`proposal-${randomUUID()}@example.com`},'Proposal user','test'),(${otherUserId},${`proposal-${randomUUID()}@example.com`},'Other user','test')`;
    await sql`INSERT INTO workspaces (id,owner_user_id) VALUES (${workspaceId},${userId}),(${otherWorkspaceId},${otherUserId})`;
    await sql`INSERT INTO library_documents (id,workspace_id,title,lifecycle,current_revision_number) VALUES (${documentId},${workspaceId},'Base','confirmed',1)`;
    await sql`INSERT INTO library_blocks (id,workspace_id,document_id,type,position,content) VALUES (${blockId},${workspaceId},${documentId},'paragraph',0,${sql.json({ text: "current" })})`;
    await sql`INSERT INTO library_revisions (workspace_id,document_id,revision_number,title,lifecycle,reason,blocks) VALUES (${workspaceId},${documentId},1,'Base','confirmed','create',${sql.json([block(blockId,"current")])})`;
  });
  afterAll(async () => sql.end({ timeout: 5 }));

  async function pendingProposal() {
    return repository.create({ workspaceId, documentId, baseRevisionNumber: 1,
      proposedBlocks: [block(blockId, "proposal")],
      source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} }, supportState: "supported" });
  }
  async function conflictProposal() {
    const proposal = await pendingProposal();
    await sql`UPDATE library_documents SET current_revision_number=2, title='Concurrent' WHERE id=${documentId}`;
    await sql`INSERT INTO library_revisions (workspace_id,document_id,revision_number,parent_revision_number,title,lifecycle,reason,blocks)
      VALUES (${workspaceId},${documentId},2,1,'Concurrent','confirmed','edit',${sql.json([block(blockId, "current")])})`;
    await repository.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: userId });
    return proposal;
  }
  async function historyRevision() {
    const rows = await sql`SELECT owner_user_id,revision FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner_user_id).toBe(userId);
    return Number(rows[0]!.revision);
  }
  async function expectHistoryBlocked(waiter: number, holder: number) {
    const deadline = Date.now() + 2000;
    do {
      const rows = await sql`SELECT a.query FROM pg_stat_activity a WHERE a.pid=${waiter}
        AND ${holder} = ANY(pg_blocking_pids(a.pid))
        AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
      if (rows.length) {
        expect(rows[0]!.query).toContain("opening_workspace_history_revisions");
        return;
      }
    } while (Date.now() < deadline);
    throw new Error("Repository never reached the PostgreSQL history lock barrier");
  }

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

  it.each([
    ["review", "same"], ["resolve", "same"], ["review", "different"], ["resolve", "different"],
  ] as const)("%s waits only for %s-workspace history before business locks", async (operation, scope) => {
    const proposal = operation === "resolve" ? await conflictProposal() : await pendingProposal();
    // Seed a nonzero watermark so accidentally advancing or resetting it is observable.
    await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES (${workspaceId},${userId},19) ON CONFLICT (workspace_id,owner_user_id) DO UPDATE SET revision=19`;
    const holder = createSqlClient(databaseUrl!, { max: 1 });
    const writer = createSqlClient(databaseUrl!, { max: 1 });
    const [{ pid: holderPid }] = await holder`SELECT pg_backend_pid() AS pid`;
    const [{ pid: writerPid }] = await writer`SELECT pg_backend_pid() AS pid`;
    let release!: () => void, ready!: () => void, failed!: (error: unknown) => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const opened = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const held = holder.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope === "same"
        ? { workspaceId, ownerUserId: userId }
        : { workspaceId: otherWorkspaceId, ownerUserId: otherUserId });
      ready();
      await proceed;
    });
    held.catch(failed);
    let result: ReturnType<RevisionProposalRepository["review"]> | undefined;
    const started = new Date();
    let blockedAt: number | undefined;
    try {
      await opened;
      const repo = createRevisionProposalRepository(writer);
      // A valid non-owner reviewer remains audit identity, not the history owner.
      result = operation === "review"
        ? repo.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: otherUserId })
        : repo.resolveConflict({ workspaceId, proposalId: proposal.id, action: "preserve_both",
          selectedProposalBlockIds: [blockId], expectedCurrentRevisionNumber: 2, actorUserId: otherUserId });
      result.catch(() => undefined);
      if (scope === "same") {
        await expectHistoryBlocked(Number(writerPid), Number(holderPid));
        blockedAt = Date.now();
        // NOWAIT proves the waiter has not acquired even the original workspace
        // lock, nor the proposal/document locks, while history is held.
        await sql.begin(async tx => {
          await tx`SELECT id FROM workspaces WHERE id=${workspaceId} FOR UPDATE NOWAIT`;
          await tx`SELECT id FROM revision_proposals WHERE id=${proposal.id} FOR UPDATE NOWAIT`;
          await tx`SELECT id FROM library_documents WHERE id=${documentId} FOR UPDATE NOWAIT`;
        });
        expect((await sql`SELECT status FROM revision_proposals WHERE id=${proposal.id}`)[0]!.status)
          .toBe(operation === "review" ? "pending" : "conflicted");
        release();
        await held;
      }
      // For a different workspace this completes BEFORE releasing the holder.
      const accepted = await result;
      expect(accepted.proposal.status).toBe("accepted");
      expect(accepted.proposal.review?.actorUserId).toBe(otherUserId);
      expect(accepted.document?.currentRevisionNumber).toBe(operation === "review" ? 2 : 3);
      expect(accepted.document?.blocks.some(entry => entry.content.text === "proposal")).toBe(true);
      const repeated = operation === "review"
        ? await repo.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: otherUserId })
        : await repo.resolveConflict({ workspaceId, proposalId: proposal.id, action: "preserve_both",
          selectedProposalBlockIds: [blockId], expectedCurrentRevisionNumber: 2, actorUserId: otherUserId });
      expect(repeated.proposal).toEqual(accepted.proposal);
      expect((await sql`SELECT count(*)::int AS n FROM library_revisions WHERE document_id=${documentId}`)[0]!.n)
        .toBe(operation === "review" ? 2 : 3);
      expect(await historyRevision()).toBe(19);
    } finally {
      release();
      await Promise.allSettled([held, ...(result ? [result] : [])]);
      await Promise.all([holder.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
      console.info("history fence timing", { operation, scope, start: started.toISOString(), end: new Date().toISOString(),
        observedWaitToCompletionMs: blockedAt === undefined ? null : Date.now() - blockedAt });
    }
  });

  it.each(["review", "resolve"] as const)("rolls back %s including appended blocks and revisions", async operation => {
    const proposal = operation === "resolve" ? await conflictProposal() : await pendingProposal();
    const before = {
      document: await sql`SELECT * FROM library_documents WHERE id=${documentId}`,
      blocks: await sql`SELECT * FROM library_blocks WHERE document_id=${documentId} ORDER BY position`,
      revisions: await sql`SELECT * FROM library_revisions WHERE document_id=${documentId} ORDER BY revision_number`,
      proposal: await repository.get({ workspaceId, proposalId: proposal.id }),
    };
    await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES (${workspaceId},${userId},19) ON CONFLICT (workspace_id,owner_user_id) DO UPDATE SET revision=19`;
    const rollback = new Error("rollback after real repository mutations");
    // Only wrap the transaction boundary: all statements and locks are real PG.
    const aborting = new Proxy(sql, { get(target, property) {
      if (property !== "begin") return Reflect.get(target, property);
      return (callback: (tx: Sql) => Promise<unknown>) => target.begin(async tx => {
        await callback(tx as unknown as Sql);
        const [document] = await tx`SELECT current_revision_number FROM library_documents WHERE id=${documentId}`;
        expect(document!.current_revision_number).toBe(operation === "review" ? 2 : 3);
        throw rollback;
      });
    } });
    const repo = createRevisionProposalRepository(aborting);
    const result = operation === "review"
      ? repo.review({ workspaceId, proposalId: proposal.id, action: "accept", actorUserId: userId })
      : repo.resolveConflict({ workspaceId, proposalId: proposal.id, action: "preserve_both",
        selectedProposalBlockIds: [blockId], expectedCurrentRevisionNumber: 2, actorUserId: userId });
    await expect(result).rejects.toBe(rollback);
    expect(await sql`SELECT * FROM library_documents WHERE id=${documentId}`).toEqual(before.document);
    expect(await sql`SELECT * FROM library_blocks WHERE document_id=${documentId} ORDER BY position`).toEqual(before.blocks);
    expect(await sql`SELECT * FROM library_revisions WHERE document_id=${documentId} ORDER BY revision_number`).toEqual(before.revisions);
    expect(await repository.get({ workspaceId, proposalId: proposal.id })).toEqual(before.proposal);
    expect(await historyRevision()).toBe(19);
  });

  it("rejects a stale conflict resolution without adding a revision or changing history", async () => {
    const proposal = await conflictProposal();
    const before = await repository.get({ workspaceId, proposalId: proposal.id });
    const beforeHistory = await historyRevision();
    await expect(repository.resolveConflict({ workspaceId, proposalId: proposal.id, action: "preserve_both",
      selectedProposalBlockIds: [blockId], expectedCurrentRevisionNumber: 1, actorUserId: userId }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repository.get({ workspaceId, proposalId: proposal.id })).toEqual(before);
    expect((await sql`SELECT count(*)::int AS n FROM library_revisions WHERE document_id=${documentId}`)[0]!.n).toBe(2);
    expect(await historyRevision()).toBe(beforeHistory);
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
