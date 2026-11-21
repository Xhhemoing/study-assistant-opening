import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createLibraryRepository, createRevisionProposalRepository, createSqlClient, lockWorkspaceLearningHistory, type RevisionProposalRepository } from "@aistudy/database";
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

  describe("protected answer-block redaction and preservation", () => {
    const source = { kind: "user" as const, provider: null, model: null, sourceId: null, metadata: {} };

    async function seedProtectedDocument() {
      const library = createLibraryRepository(sql);
      const leadAnswer = { id: randomUUID(), type: "answer_key", content: { answer: "RP_LEAD_ANSWER_SECRET" } };
      const visibleA = { id: randomUUID(), type: "paragraph", content: { text: "RP_PUBLIC_A" } };
      const midSolution = { id: randomUUID(), type: "solution", content: { solution: "RP_MID_SOLUTION_SECRET" } };
      const midNestedRoleKey = { id: randomUUID(), type: "text", content: { role: "answer_key", text: "RP_NESTED_ROLE_SECRET" } };
      const midNestedTypeSol = { id: randomUUID(), type: "text", content: { blockType: "solution", text: "RP_NESTED_TYPE_SECRET" } };
      const midProvenance = { id: randomUUID(), type: "paragraph", content: { text: "RP_PROVENANCE_SECRET" } };
      const visibleB = { id: randomUUID(), type: "paragraph", content: { text: "RP_PUBLIC_B" } };
      const trailAnswer = { id: randomUUID(), type: "answer_key", content: { answer: "RP_TRAIL_ANSWER_SECRET" } };
      const allBlocks = [
        leadAnswer,
        visibleA,
        midSolution,
        midNestedRoleKey,
        midNestedTypeSol,
        midProvenance,
        visibleB,
        trailAnswer,
      ];
      const secrets = [
        "RP_LEAD_ANSWER_SECRET",
        "RP_MID_SOLUTION_SECRET",
        "RP_NESTED_ROLE_SECRET",
        "RP_NESTED_TYPE_SECRET",
        "RP_PROVENANCE_SECRET",
        "RP_TRAIL_ANSWER_SECRET",
      ];
      const doc = await library.createDocument({
        workspaceId,
        title: "Protected Lesson Note",
        lifecycle: "confirmed",
        blocks: allBlocks,
      });
      await sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
        VALUES(${doc.id},${workspaceId},${sql.json([{ answerKeyBlockIds: [midProvenance.id.toUpperCase()] }])})`;
      return {
        library,
        doc,
        leadAnswer,
        visibleA,
        midSolution,
        midNestedRoleKey,
        midNestedTypeSol,
        midProvenance,
        visibleB,
        trailAnswer,
        allBlocks,
        secrets,
      };
    }

    it("redacts hidden answer blocks from created, listed, fetched, and legacy proposals", async () => {
      const fx = await seedProtectedDocument();
      const created = await repository.create({
        workspaceId,
        documentId: fx.doc.id,
        baseRevisionNumber: 1,
        proposedTitle: "Edited Lesson Note",
        proposedBlocks: [
          { id: fx.visibleA.id, type: "paragraph", position: 0, content: { text: "RP_PUBLIC_A_PROPOSED" } },
          { id: fx.visibleB.id, type: "paragraph", position: 1, content: { text: "RP_PUBLIC_B" } },
        ],
        source,
        supportState: "supported",
      });

      expect(created.baseBlocks.map((b) => b.id)).toEqual([fx.visibleA.id, fx.visibleB.id]);
      expect(created.diff.map((d) => d.blockId)).toEqual([fx.visibleA.id, fx.visibleB.id]);

      const [stored] = await sql`SELECT base_blocks, proposed_blocks, diff FROM revision_proposals WHERE id=${created.id}`;
      const listed = await repository.list({ workspaceId, documentId: fx.doc.id });
      const fetched = await repository.get({ workspaceId, proposalId: created.id });

      for (const secret of fx.secrets) {
        expect(JSON.stringify(created)).not.toContain(secret);
        expect(JSON.stringify(stored)).not.toContain(secret);
        expect(JSON.stringify(listed)).not.toContain(secret);
        expect(JSON.stringify(fetched)).not.toContain(secret);
      }

      // Legacy DB row persisted prior to redaction must still be redacted on list/get.
      const legacyId = randomUUID();
      const legacyBase = fx.allBlocks.map((b, position) => ({ ...b, position }));
      const legacyConflict = {
        currentRevisionNumber: 1,
        currentTitle: "Protected Lesson Note",
        currentBlocks: legacyBase,
        conflictedAt: new Date().toISOString(),
      };
      const legacyDiff = [
        { blockId: fx.leadAnswer.id, kind: "removed", base: legacyBase[0], proposed: null },
        { blockId: fx.midProvenance.id, kind: "changed", base: legacyBase[5], proposed: { ...legacyBase[5]!, content: { text: "FORGED" } } },
        { blockId: fx.visibleA.id, kind: "unchanged", base: legacyBase[1], proposed: legacyBase[1] },
      ];
      await sql`INSERT INTO revision_proposals(
        id,workspace_id,document_id,base_revision_number,base_title,base_blocks,proposed_title,proposed_blocks,diff,source,provenance,support_state,status,review_action,reviewer_user_id,reviewed_at,current_conflict
      ) VALUES (
        ${legacyId},${workspaceId},${fx.doc.id},1,'Protected Lesson Note',${sql.json(legacyBase as never)},'Legacy',${sql.json(legacyBase as never)},${sql.json(legacyDiff as never)},${sql.json(source as never)},${sql.json({ origin: "manual", actorUserId: userId, sourceDocumentId: null, sourceRevisionNumber: 1 } as never)},'supported','conflicted','accept',${userId},now(),${sql.json(legacyConflict as never)}
      )`;

      const legacyFetched = await repository.get({ workspaceId, proposalId: legacyId });
      const legacyListed = (await repository.list({ workspaceId, documentId: fx.doc.id })).find((p) => p.id === legacyId)!;
      for (const view of [legacyFetched, legacyListed]) {
        expect(view.baseBlocks.map((b) => b.id)).toEqual([fx.visibleA.id, fx.visibleB.id]);
        expect(view.proposedBlocks.map((b) => b.id)).toEqual([fx.visibleA.id, fx.visibleB.id]);
        expect(view.diff.map((d) => d.blockId)).toEqual([fx.visibleA.id]);
        expect(view.conflict?.currentBlocks.map((b) => b.id)).toEqual([fx.visibleA.id, fx.visibleB.id]);
        for (const secret of fx.secrets) {
          expect(JSON.stringify(view)).not.toContain(secret);
        }
      }
    });

    it("rejects forging answer blocks or reusing protected IDs on create, review, and resolveConflict", async () => {
      const fx = await seedProtectedDocument();
      const cleanBlock = { id: fx.visibleA.id, type: "paragraph", position: 0, content: { text: "clean" } };
      const forgeryPayloads: Array<Array<Record<string, unknown>>> = [
        [cleanBlock, { id: randomUUID(), type: "answer_key", position: 1, content: { answer: "forged" } }],
        [cleanBlock, { id: randomUUID(), type: "solution", position: 1, content: { solution: "forged" } }],
        [cleanBlock, { id: randomUUID(), type: "paragraph", role: "answer_key", position: 1, content: { text: "forged" } }],
        [cleanBlock, { id: randomUUID(), type: "paragraph", blockType: "solution", position: 1, content: { text: "forged" } }],
        [cleanBlock, { id: randomUUID(), type: "text", position: 1, content: { role: "answer_key", text: "forged" } }],
        [cleanBlock, { id: randomUUID(), type: "text", position: 1, content: { blockType: "solution", text: "forged" } }],
        [cleanBlock, { id: fx.leadAnswer.id, type: "paragraph", position: 1, content: { text: "overwrite lead" } }],
        [cleanBlock, { id: fx.midNestedRoleKey.id, type: "paragraph", position: 1, content: { text: "overwrite nested" } }],
        [cleanBlock, { id: fx.midProvenance.id.toUpperCase(), type: "paragraph", position: 1, content: { text: "overwrite provenance" } }],
      ];

      for (const proposedBlocks of forgeryPayloads) {
        await expect(repository.create({
          workspaceId,
          documentId: fx.doc.id,
          baseRevisionNumber: 1,
          proposedBlocks: proposedBlocks as Parameters<RevisionProposalRepository["create"]>[0]["proposedBlocks"],
          source,
          supportState: "supported",
        })).rejects.toMatchObject({ code: "VALIDATION" });
      }
      expect((await sql`SELECT count(*)::int AS count FROM revision_proposals WHERE document_id=${fx.doc.id}`)[0]!.count).toBe(0);

      // A legacy pending proposal with a forged/protected block cannot be accepted or partially accepted.
      const forgedPendingId = randomUUID();
      const forgedProposed = [
        cleanBlock,
        { id: fx.leadAnswer.id, type: "paragraph", position: 1, content: { text: "hijacked" } },
      ];
      await sql`INSERT INTO revision_proposals(
        id,workspace_id,document_id,base_revision_number,base_title,base_blocks,proposed_title,proposed_blocks,diff,source,provenance,support_state
      ) VALUES (
        ${forgedPendingId},${workspaceId},${fx.doc.id},1,'Protected Lesson Note',${sql.json([cleanBlock] as never)},'Hijack',${sql.json(forgedProposed as never)},${sql.json([] as never)},${sql.json(source as never)},${sql.json({ origin: "manual", actorUserId: userId, sourceDocumentId: null, sourceRevisionNumber: 1 } as never)},'supported'
      )`;

      await expect(repository.review({
        workspaceId,
        proposalId: forgedPendingId,
        action: "accept",
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(repository.review({
        workspaceId,
        proposalId: forgedPendingId,
        action: "partial_accept",
        selectedProposalBlockIds: [fx.visibleA.id],
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION" });

      // Attempting partial_accept selecting a protected block ID from a legacy diff is also rejected.
      const cleanPending = await repository.create({
        workspaceId,
        documentId: fx.doc.id,
        baseRevisionNumber: 1,
        proposedBlocks: [cleanBlock],
        source,
        supportState: "supported",
      });
      await expect(repository.review({
        workspaceId,
        proposalId: cleanPending.id,
        action: "partial_accept",
        selectedProposalBlockIds: [fx.midProvenance.id.toUpperCase()],
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION" });

      // A conflicted proposal whose proposed block ID later becomes protected cannot be resolved.
      const lateProtectedId = randomUUID();
      const lateProposal = await repository.create({
        workspaceId,
        documentId: fx.doc.id,
        baseRevisionNumber: 1,
        proposedBlocks: [cleanBlock, { id: lateProtectedId, type: "paragraph", position: 1, content: { text: "later protected" } }],
        source,
        supportState: "supported",
      });
      await fx.library.updateDocument({
        workspaceId,
        documentId: fx.doc.id,
        expectedRevisionNumber: 1,
        blocks: [
          { id: fx.visibleA.id, type: "paragraph", content: { text: "RP_PUBLIC_A_CONCURRENT" } },
          { id: fx.visibleB.id, type: "paragraph", content: { text: "RP_PUBLIC_B" } },
        ],
      });
      const conflicted = await repository.review({
        workspaceId,
        proposalId: lateProposal.id,
        action: "accept",
        actorUserId: userId,
      });
      expect(conflicted.proposal.status).toBe("conflicted");
      await sql`UPDATE opening_note_provenance
        SET context_source_refs = context_source_refs || ${sql.json([{ answerKeyBlockIds: [lateProtectedId] }])}::jsonb
        WHERE document_id=${fx.doc.id}`;
      await expect(repository.resolveConflict({
        workspaceId,
        proposalId: lateProposal.id,
        action: "preserve_both",
        selectedProposalBlockIds: [lateProtectedId],
        expectedCurrentRevisionNumber: 2,
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION" });

      const liveBlocks = await sql`SELECT id FROM library_blocks WHERE document_id=${fx.doc.id} ORDER BY position`;
      expect(liveBlocks.map((b) => b.id)).toEqual(fx.allBlocks.map((b) => b.id));
    });

    it("preserves all hidden answer blocks across accept, partial_accept, and preserve_both without leaking them", async () => {
      const fx = await seedProtectedDocument();
      const addedBlockId = randomUUID();

      // 1. Full accept replacing visibleA, removing visibleB, adding addedBlockId.
      const acceptProposal = await repository.create({
        workspaceId,
        documentId: fx.doc.id,
        baseRevisionNumber: 1,
        proposedTitle: "Accepted Title",
        proposedBlocks: [
          { id: fx.visibleA.id, type: "paragraph", position: 0, content: { text: "RP_PUBLIC_A_ACCEPTED" } },
          { id: addedBlockId, type: "paragraph", position: 1, content: { text: "RP_PUBLIC_ADDED" } },
        ],
        source,
        supportState: "supported",
      });
      const accepted = await repository.review({
        workspaceId,
        proposalId: acceptProposal.id,
        action: "accept",
        actorUserId: userId,
      });
      expect(accepted.proposal.status).toBe("accepted");
      expect(accepted.document?.currentRevisionNumber).toBe(2);
      expect(accepted.document?.blocks.map((b) => b.id)).toEqual([fx.visibleA.id, addedBlockId]);
      for (const secret of fx.secrets) {
        expect(JSON.stringify(accepted)).not.toContain(secret);
      }

      const expectedRev2Order = [
        fx.leadAnswer.id,
        fx.visibleA.id,
        fx.midSolution.id,
        fx.midNestedRoleKey.id,
        fx.midNestedTypeSol.id,
        fx.midProvenance.id,
        addedBlockId,
        fx.trailAnswer.id,
      ];
      const rev2Live = await sql`SELECT id, position FROM library_blocks WHERE document_id=${fx.doc.id} ORDER BY position`;
      const [rev2Snap] = await sql`SELECT blocks FROM library_revisions WHERE document_id=${fx.doc.id} AND revision_number=2`;
      expect(rev2Live.map((b) => b.id)).toEqual(expectedRev2Order);
      expect(rev2Live.map((b) => b.position)).toEqual(expectedRev2Order.map((_, idx) => idx));
      expect((rev2Snap!.blocks as Array<{ id: string }>).map((b) => b.id)).toEqual(expectedRev2Order);

      // 2. Partial accept editing only visibleA keeps addedBlockId and all hidden blocks intact.
      const partialProposal = await repository.create({
        workspaceId,
        documentId: fx.doc.id,
        baseRevisionNumber: 2,
        proposedBlocks: [
          { id: fx.visibleA.id, type: "paragraph", position: 0, content: { text: "RP_PUBLIC_A_PARTIAL" } },
        ],
        source,
        supportState: "partial",
      });
      const partialAccepted = await repository.review({
        workspaceId,
        proposalId: partialProposal.id,
        action: "partial_accept",
        selectedProposalBlockIds: [fx.visibleA.id],
        actorUserId: userId,
      });
      expect(partialAccepted.proposal.status).toBe("accepted");
      expect(partialAccepted.document?.currentRevisionNumber).toBe(3);
      expect(partialAccepted.document?.blocks.map((b) => b.id)).toEqual([fx.visibleA.id, addedBlockId]);
      for (const secret of fx.secrets) {
        expect(JSON.stringify(partialAccepted)).not.toContain(secret);
      }
      const rev3Live = await sql`SELECT id FROM library_blocks WHERE document_id=${fx.doc.id} ORDER BY position`;
      expect(rev3Live.map((b) => b.id)).toEqual(expectedRev2Order);

      // 3. Conflict + preserve_both keeps conflict snapshot redacted and preserves all hidden blocks on resolution.
      const conflictBaseProposal = await repository.create({
        workspaceId,
        documentId: fx.doc.id,
        baseRevisionNumber: 3,
        proposedBlocks: [
          { id: fx.visibleA.id, type: "paragraph", position: 0, content: { text: "RP_PUBLIC_A_PRESERVE_BOTH" } },
          { id: addedBlockId, type: "paragraph", position: 1, content: { text: "RP_PUBLIC_ADDED" } },
        ],
        source,
        supportState: "supported",
      });
      await fx.library.updateDocument({
        workspaceId,
        documentId: fx.doc.id,
        expectedRevisionNumber: 3,
        blocks: [
          { id: fx.visibleA.id, type: "paragraph", content: { text: "RP_PUBLIC_A_CONCURRENT_V4" } },
          { id: addedBlockId, type: "paragraph", content: { text: "RP_PUBLIC_ADDED" } },
        ],
      });
      const conflicted = await repository.review({
        workspaceId,
        proposalId: conflictBaseProposal.id,
        action: "accept",
        actorUserId: userId,
      });
      expect(conflicted.proposal.status).toBe("conflicted");
      expect(conflicted.proposal.conflict?.currentBlocks.map((b) => b.id)).toEqual([fx.visibleA.id, addedBlockId]);
      const [storedConflict] = await sql`SELECT current_conflict FROM revision_proposals WHERE id=${conflictBaseProposal.id}`;
      for (const secret of fx.secrets) {
        expect(JSON.stringify(conflicted)).not.toContain(secret);
        expect(JSON.stringify(storedConflict)).not.toContain(secret);
      }

      const resolved = await repository.resolveConflict({
        workspaceId,
        proposalId: conflictBaseProposal.id,
        action: "preserve_both",
        selectedProposalBlockIds: [fx.visibleA.id],
        expectedCurrentRevisionNumber: 4,
        actorUserId: userId,
      });
      expect(resolved.proposal.status).toBe("accepted");
      expect(resolved.document?.currentRevisionNumber).toBe(5);
      expect(resolved.document?.blocks).toHaveLength(3);
      for (const secret of fx.secrets) {
        expect(JSON.stringify(resolved)).not.toContain(secret);
      }

      const trustedDoc = await fx.library.getDocument({ workspaceId, documentId: fx.doc.id, includeAnswerKeys: true });
      for (const hidden of [fx.leadAnswer, fx.midSolution, fx.midNestedRoleKey, fx.midNestedTypeSol, fx.midProvenance, fx.trailAnswer]) {
        expect(trustedDoc.blocks.find((b) => b.id === hidden.id)?.content).toEqual(hidden.content);
      }
      const [rev5Snap] = await sql`SELECT blocks FROM library_revisions WHERE document_id=${fx.doc.id} AND revision_number=5`;
      expect((rev5Snap!.blocks as Array<{ id: string }>).length).toBe(trustedDoc.blocks.length);
    });

    it("blocks republishing a removed historical answer from a legacy proposal and never resurrects deleted answers", async () => {
      const fx = await seedProtectedDocument();
      const deletedAnswerId = randomUUID();
      const deletedAnswerBlock = { id: deletedAnswerId, type: "answer_key", position: 0, content: { answer: "DELETED_LEGACY_ANSWER_SECRET" } };
      const untaggedCopyBlock = { id: deletedAnswerId.toUpperCase(), type: "paragraph", position: 0, content: { text: "DELETED_LEGACY_ANSWER_SECRET" } };
      const visibleBlock = { id: fx.visibleA.id, type: "paragraph", position: 1, content: { text: "RP_PUBLIC_A" } };
      const legacyCopyId = randomUUID();
      const legacyConflict = {
        currentRevisionNumber: 2,
        currentTitle: "Protected Lesson Note",
        currentBlocks: [visibleBlock],
        conflictedAt: new Date().toISOString(),
      };
      const legacyDiff = [
        { blockId: deletedAnswerId, kind: "changed", base: deletedAnswerBlock, proposed: untaggedCopyBlock },
        { blockId: fx.visibleA.id, kind: "unchanged", base: visibleBlock, proposed: visibleBlock },
      ];
      await fx.library.updateDocument({
        workspaceId,
        documentId: fx.doc.id,
        expectedRevisionNumber: 1,
        blocks: [
          { id: fx.visibleA.id, type: "paragraph", content: { text: "RP_PUBLIC_A_V2" } },
          { id: fx.visibleB.id, type: "paragraph", content: { text: "RP_PUBLIC_B" } },
        ],
      });

      // Legacy conflicted proposal: deletedAnswerId is absent from live library_blocks and live metadata.
      await sql`INSERT INTO revision_proposals(
        id,workspace_id,document_id,base_revision_number,base_title,base_blocks,proposed_title,proposed_blocks,diff,source,provenance,support_state,status,review_action,reviewer_user_id,reviewed_at,current_conflict
      ) VALUES (
        ${legacyCopyId},${workspaceId},${fx.doc.id},1,'Protected Lesson Note',${sql.json([deletedAnswerBlock, visibleBlock] as never)},'Republish',${sql.json([untaggedCopyBlock, visibleBlock] as never)},${sql.json(legacyDiff as never)},${sql.json(source as never)},${sql.json({ origin: "manual", actorUserId: userId, sourceDocumentId: null, sourceRevisionNumber: 1 } as never)},'supported','conflicted','accept',${userId},now(),${sql.json(legacyConflict as never)}
      )`;

      const fetched = await repository.get({ workspaceId, proposalId: legacyCopyId });
      expect(JSON.stringify(fetched)).not.toContain("DELETED_LEGACY_ANSWER_SECRET");
      await expect(repository.resolveConflict({
        workspaceId,
        proposalId: legacyCopyId,
        action: "preserve_both",
        selectedProposalBlockIds: [deletedAnswerId],
        expectedCurrentRevisionNumber: 2,
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION" });

      // Legacy pending proposal carrying the same untagged copy is also blocked on accept and partial_accept.
      const legacyPendingCopyId = randomUUID();
      await sql`INSERT INTO revision_proposals(
        id,workspace_id,document_id,base_revision_number,base_title,base_blocks,proposed_title,proposed_blocks,diff,source,provenance,support_state
      ) VALUES (
        ${legacyPendingCopyId},${workspaceId},${fx.doc.id},2,'Protected Lesson Note',${sql.json([deletedAnswerBlock, visibleBlock] as never)},'RepublishPending',${sql.json([untaggedCopyBlock, visibleBlock] as never)},${sql.json(legacyDiff as never)},${sql.json(source as never)},${sql.json({ origin: "manual", actorUserId: userId, sourceDocumentId: null, sourceRevisionNumber: 2 } as never)},'supported'
      )`;
      await expect(repository.review({
        workspaceId,
        proposalId: legacyPendingCopyId,
        action: "accept",
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(repository.review({
        workspaceId,
        proposalId: legacyPendingCopyId,
        action: "partial_accept",
        selectedProposalBlockIds: [fx.visibleA.id],
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION" });

      // Legacy pending proposal where deletedAnswerId only exists in base_blocks accepts cleanly without resurrecting it.
      const legacyCleanPendingId = randomUUID();
      const updatedVisibleA = { id: fx.visibleA.id, type: "paragraph", position: 0, content: { text: "RP_PUBLIC_A_V3" } };
      await sql`INSERT INTO revision_proposals(
        id,workspace_id,document_id,base_revision_number,base_title,base_blocks,proposed_title,proposed_blocks,diff,source,provenance,support_state
      ) VALUES (
        ${legacyCleanPendingId},${workspaceId},${fx.doc.id},2,'Protected Lesson Note',${sql.json([deletedAnswerBlock, visibleBlock] as never)},'CleanLegacy',${sql.json([updatedVisibleA] as never)},${sql.json([{ blockId: deletedAnswerId, kind: "removed", base: deletedAnswerBlock, proposed: null }, { blockId: fx.visibleA.id, kind: "changed", base: visibleBlock, proposed: updatedVisibleA }] as never)},${sql.json(source as never)},${sql.json({ origin: "manual", actorUserId: userId, sourceDocumentId: null, sourceRevisionNumber: 2 } as never)},'supported'
      )`;
      const accepted = await repository.review({
        workspaceId,
        proposalId: legacyCleanPendingId,
        action: "accept",
        actorUserId: userId,
      });
      expect(accepted.proposal.status).toBe("accepted");
      const liveIds = (await sql`SELECT id FROM library_blocks WHERE document_id=${fx.doc.id} ORDER BY position`).map((row) => row.id);
      expect(liveIds).not.toContain(deletedAnswerId);
      expect(liveIds).toContain(fx.leadAnswer.id);
      expect(liveIds).toContain(fx.visibleA.id);
    });

    it("handles uppercase visible UUIDs without PK collision and enforces non-empty visible blocks like library.ts", async () => {
      const library = createLibraryRepository(sql);
      const soleVisibleId = randomUUID();
      const hiddenAnswerId = randomUUID();
      const replacementId = randomUUID();
      const doc = await library.createDocument({
        workspaceId,
        title: "Single visible + hidden",
        lifecycle: "confirmed",
        blocks: [
          { id: hiddenAnswerId, type: "answer_key", content: { answer: "ONLY_HIDDEN_SECRET" } },
          { id: soleVisibleId, type: "paragraph", content: { text: "SOLE_VISIBLE" } },
        ],
      });

      // Removing the sole visible block via partial_accept matches library.ts (requires >= 1 visible block).
      const removalProposal = await repository.create({
        workspaceId,
        documentId: doc.id,
        baseRevisionNumber: 1,
        proposedBlocks: [{ id: replacementId, type: "paragraph", position: 0, content: { text: "REPLACEMENT" } }],
        source,
        supportState: "partial",
      });
      await expect(repository.review({
        workspaceId,
        proposalId: removalProposal.id,
        action: "partial_accept",
        selectedProposalBlockIds: [soleVisibleId],
        actorUserId: userId,
      })).rejects.toMatchObject({ code: "VALIDATION", message: "Document requires at least one block" });
      await expect(library.updateDocument({
        workspaceId,
        documentId: doc.id,
        expectedRevisionNumber: 1,
        blocks: [],
      })).rejects.toMatchObject({ code: "VALIDATION", message: "Document requires at least one block" });

      // Uppercase UUID matching a lowercase live visible block succeeds cleanly on partial_accept and preserve_both.
      const upperProposal = await repository.create({
        workspaceId,
        documentId: doc.id,
        baseRevisionNumber: 1,
        proposedBlocks: [{ id: soleVisibleId.toUpperCase(), type: "paragraph", position: 0, content: { text: "UPPER_EDITED" } }],
        source,
        supportState: "supported",
      });
      expect(upperProposal.diff).toMatchObject([{ blockId: soleVisibleId, kind: "changed" }]);
      const partialRes = await repository.review({
        workspaceId,
        proposalId: upperProposal.id,
        action: "partial_accept",
        selectedProposalBlockIds: [soleVisibleId.toUpperCase()],
        actorUserId: userId,
      });
      expect(partialRes.proposal.status).toBe("accepted");
      expect(partialRes.document?.blocks.map((b) => b.id)).toEqual([soleVisibleId]);

      const conflictUpper = await repository.create({
        workspaceId,
        documentId: doc.id,
        baseRevisionNumber: 2,
        proposedBlocks: [{ id: soleVisibleId.toUpperCase(), type: "paragraph", position: 0, content: { text: "UPPER_CONFLICT_COPY" } }],
        source,
        supportState: "supported",
      });
      await library.updateDocument({
        workspaceId,
        documentId: doc.id,
        expectedRevisionNumber: 2,
        blocks: [{ id: soleVisibleId, type: "paragraph", content: { text: "CONCURRENT_V3" } }],
      });
      const conflicted = await repository.review({
        workspaceId,
        proposalId: conflictUpper.id,
        action: "accept",
        actorUserId: userId,
      });
      expect(conflicted.proposal.status).toBe("conflicted");
      const resolved = await repository.resolveConflict({
        workspaceId,
        proposalId: conflictUpper.id,
        action: "preserve_both",
        selectedProposalBlockIds: [soleVisibleId.toUpperCase()],
        expectedCurrentRevisionNumber: 3,
        actorUserId: userId,
      });
      expect(resolved.proposal.status).toBe("accepted");
      expect(resolved.document?.blocks).toHaveLength(2);
      const trusted = await library.getDocument({ workspaceId, documentId: doc.id, includeAnswerKeys: true });
      expect(trusted.blocks.map((b) => b.id)).toContain(hiddenAnswerId);
    });
  });
});
