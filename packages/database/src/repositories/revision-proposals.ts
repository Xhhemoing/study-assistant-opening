import { randomUUID } from "node:crypto";
import {
  assertNonEmptyRevisionBlocks,
  diffRevisionBlocks,
  preserveBothBlocks,
  selectProposalBlocks,
} from "@aistudy/domain";
import {
  revisionProposalBlockSchema,
  revisionProposalProvenanceSchema,
  revisionProposalSourceSchema,
  revisionProposalSupportStateSchema,
  type RevisionProposalAction,
  type RevisionProposalBlock,
  type RevisionProposalRecord,
  type RevisionProposalReviewResult,
  type RevisionProposalSource,
  type RevisionProposalSupportState,
} from "@aistudy/contracts";
import type { Sql } from "postgres";

export type RevisionProposalErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "WORKSPACE_MISMATCH"
  | "CONFLICT"
  | "INVALID_TRANSITION";

export class RevisionProposalRepositoryError extends Error {
  constructor(readonly code: RevisionProposalErrorCode, message: string) {
    super(message);
    this.name = "RevisionProposalRepositoryError";
  }
}

export type RevisionProposalRepository = {
  create(input: {
    workspaceId: string;
    documentId: string;
    baseRevisionNumber: number;
    proposedTitle?: string | null;
    proposedBlocks: RevisionProposalBlock[];
    source: RevisionProposalSource;
    supportState: RevisionProposalSupportState;
    provenance?: {
      origin: "ai" | "manual" | "import";
      actorUserId: string | null;
      sourceDocumentId: string | null;
      sourceRevisionNumber: number | null;
    };
    proposalId?: string;
  }): Promise<RevisionProposalRecord>;
  list(input: { workspaceId: string; documentId: string }): Promise<RevisionProposalRecord[]>;
  get(input: { workspaceId: string; proposalId: string }): Promise<RevisionProposalRecord>;
  review(input: {
    workspaceId: string;
    proposalId: string;
    action: "accept" | "partial_accept" | "reject";
    selectedProposalBlockIds?: string[];
    actorUserId: string;
  }): Promise<RevisionProposalReviewResult>;
  resolveConflict(input: {
    workspaceId: string;
    proposalId: string;
    action: "preserve_both";
    selectedProposalBlockIds: string[];
    actorUserId: string;
    expectedCurrentRevisionNumber: number;
  }): Promise<RevisionProposalReviewResult>;
};

type Row = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertUuid(value: string, field: string): void {
  if (!uuid.test(value)) throw new RevisionProposalRepositoryError("VALIDATION", `Invalid UUID for ${field}`);
}
function rowDate(value: unknown): Date { return new Date(value as string | Date); }
function mapDocument(row: Row, blocks: RevisionProposalBlock[]): RevisionProposalReviewResult["document"] {
  return {
    id: row.id as string,
    currentRevisionNumber: row.current_revision_number as number,
    title: row.title as string,
    blocks,
  };
}
function map(row: Row): RevisionProposalRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    documentId: row.document_id as string,
    baseRevisionNumber: row.base_revision_number as number,
    baseTitle: row.base_title as string,
    baseBlocks: row.base_blocks as RevisionProposalBlock[],
    proposedTitle: row.proposed_title as string | null,
    proposedBlocks: row.proposed_blocks as RevisionProposalBlock[],
    diff: row.diff as RevisionProposalRecord["diff"],
    source: row.source as RevisionProposalRecord["source"],
    provenance: row.provenance as RevisionProposalRecord["provenance"],
    supportState: row.support_state as RevisionProposalSupportState,
    status: row.status as RevisionProposalRecord["status"],
    review: row.reviewed_at ? {
      action: row.review_action as RevisionProposalAction,
      actorUserId: row.reviewer_user_id as string,
      reviewedAt: rowDate(row.reviewed_at),
      resultingRevisionNumber: row.resulting_revision_number as number | null,
    } : null,
    conflict: row.current_conflict ? row.current_conflict as RevisionProposalRecord["conflict"] : null,
    createdAt: rowDate(row.created_at),
    updatedAt: rowDate(row.updated_at),
  };
}
function validateBlocks(blocks: RevisionProposalBlock[]): void {
  const parsed = blocks.map((block) => revisionProposalBlockSchema.parse(block));
  const ids = new Set<string>();
  for (const block of parsed) {
    if (ids.has(block.id)) throw new RevisionProposalRepositoryError("VALIDATION", `Duplicate block id: ${block.id}`);
    ids.add(block.id);
  }
}
function errorFromSql(error: unknown): never {
  if (error instanceof RevisionProposalRepositoryError) throw error;
  throw error;
}
function assertValidRevisionBlocks(blocks: RevisionProposalBlock[]): void {
  try {
    assertNonEmptyRevisionBlocks(blocks);
  } catch (error) {
    if (error instanceof Error) throw new RevisionProposalRepositoryError("VALIDATION", error.message);
    throw error;
  }
}

export function createRevisionProposalRepository(sql: Sql): RevisionProposalRepository {
  async function ensureWorkspace(workspaceId: string, db: Sql = sql): Promise<void> {
    assertUuid(workspaceId, "workspaceId");
    const rows = await db`SELECT id FROM workspaces WHERE id=${workspaceId} LIMIT 1`;
    if (!rows.length) throw new RevisionProposalRepositoryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
  }
  async function findProposal(workspaceId: string, proposalId: string, db: Sql = sql, lock = false): Promise<Row> {
    assertUuid(workspaceId, "workspaceId"); assertUuid(proposalId, "proposalId");
    const rows = lock
      ? await db`SELECT * FROM revision_proposals WHERE id=${proposalId} FOR UPDATE`
      : await db`SELECT * FROM revision_proposals WHERE id=${proposalId}`;
    if (!rows.length) throw new RevisionProposalRepositoryError("NOT_FOUND", `Proposal not found: ${proposalId}`);
    if (rows[0]!.workspace_id !== workspaceId) throw new RevisionProposalRepositoryError("WORKSPACE_MISMATCH", `Proposal ${proposalId} is not in this workspace`);
    return rows[0] as Row;
  }
  async function documentBlocks(db: Sql, workspaceId: string, documentId: string): Promise<RevisionProposalBlock[]> {
    const rows = await db`SELECT id,type,position,content FROM library_blocks WHERE workspace_id=${workspaceId} AND document_id=${documentId} ORDER BY position`;
    return rows.map((row) => ({ id: row.id as string, type: row.type as string, position: row.position as number, content: row.content as Record<string, unknown> }));
  }
  async function documentRow(db: Sql, workspaceId: string, documentId: string, lock = false): Promise<Row> {
    const rows = lock
      ? await db`SELECT * FROM library_documents WHERE id=${documentId} AND workspace_id=${workspaceId} AND deleted_at IS NULL FOR UPDATE`
      : await db`SELECT * FROM library_documents WHERE id=${documentId} AND workspace_id=${workspaceId} AND deleted_at IS NULL`;
    if (!rows.length) {
      const any = await db`SELECT workspace_id FROM library_documents WHERE id=${documentId} LIMIT 1`;
      if (any.length && any[0]!.workspace_id !== workspaceId) throw new RevisionProposalRepositoryError("WORKSPACE_MISMATCH", `Document ${documentId} is not in this workspace`);
      throw new RevisionProposalRepositoryError("NOT_FOUND", `Document not found: ${documentId}`);
    }
    return rows[0] as Row;
  }
  async function mapResult(row: Row, db: Sql = sql): Promise<RevisionProposalReviewResult> {
    const proposal = map(row);
    if (proposal.status === "rejected") return { proposal, document: null };

    let documentRowValue: Row | null = null;
    try {
      documentRowValue = await documentRow(db, proposal.workspaceId, proposal.documentId);
    } catch (error) {
      if (!(error instanceof RevisionProposalRepositoryError) || error.code !== "NOT_FOUND") throw error;
      const target = await db`SELECT workspace_id FROM library_documents WHERE id=${proposal.documentId} LIMIT 1`;
      if (target.length && target[0]!.workspace_id !== proposal.workspaceId) {
        throw new RevisionProposalRepositoryError("WORKSPACE_MISMATCH", `Document ${proposal.documentId} is not in this workspace`);
      }
      return { proposal, document: null };
    }

    return { proposal, document: mapDocument(documentRowValue, await documentBlocks(db, proposal.workspaceId, proposal.documentId)) };
  }
  async function appendRevision(db: Sql, input: { workspaceId: string; documentId: string; document: Row; title: string; blocks: RevisionProposalBlock[]; reason: string }): Promise<number> {
    assertValidRevisionBlocks(input.blocks);
    const nextRevision = (input.document.current_revision_number as number) + 1;
    await db`UPDATE library_documents SET title=${input.title}, current_revision_number=${nextRevision}, updated_at=now() WHERE id=${input.documentId} AND workspace_id=${input.workspaceId}`;
    await db`DELETE FROM library_blocks WHERE workspace_id=${input.workspaceId} AND document_id=${input.documentId}`;
    for (const [position, block] of input.blocks.entries()) {
      await db`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content) VALUES(${block.id},${input.workspaceId},${input.documentId},${block.type},${position},${db.json(block.content as never)})`;
    }
    await db`INSERT INTO library_revisions(workspace_id,document_id,revision_number,parent_revision_number,title,lifecycle,reason,blocks) VALUES(${input.workspaceId},${input.documentId},${nextRevision},${input.document.current_revision_number as number},${input.title},${input.document.lifecycle as string},${input.reason},${db.json(input.blocks as never)})`;
    return nextRevision;
  }
  return {
    async create(input) {
      await ensureWorkspace(input.workspaceId);
      assertUuid(input.documentId, "documentId");
      const source = revisionProposalSourceSchema.parse(input.source);
      const supportState = revisionProposalSupportStateSchema.parse(input.supportState);
      const proposedBlocks = input.proposedBlocks.map((block) => revisionProposalBlockSchema.parse(block));
      validateBlocks(proposedBlocks);
      return sql.begin(async (tx) => {
        // Lock the document before reading blocks so the full base snapshot is coherent.
        const document = await documentRow(tx, input.workspaceId, input.documentId, true);
        const baseRevisionNumber = input.baseRevisionNumber;
        if (!Number.isInteger(baseRevisionNumber) || baseRevisionNumber <= 0) throw new RevisionProposalRepositoryError("VALIDATION", "baseRevisionNumber must be positive");
        if (baseRevisionNumber !== document.current_revision_number) throw new RevisionProposalRepositoryError("CONFLICT", "Proposal base revision must be current");
        const baseBlocks = await documentBlocks(tx, input.workspaceId, input.documentId);
        const provenance = revisionProposalProvenanceSchema.parse(input.provenance ?? { origin: source.kind === "ai" ? "ai" : "manual", actorUserId: null, sourceDocumentId: null, sourceRevisionNumber: baseRevisionNumber });
        const id = input.proposalId ?? randomUUID(); assertUuid(id, "proposalId");
        const diff = diffRevisionBlocks(baseBlocks, proposedBlocks);
        const rows = await tx`INSERT INTO revision_proposals(id,workspace_id,document_id,base_revision_number,base_title,base_blocks,proposed_title,proposed_blocks,diff,source,provenance,support_state) VALUES(${id},${input.workspaceId},${input.documentId},${baseRevisionNumber},${document.title as string},${tx.json(baseBlocks as never)},${input.proposedTitle ?? null},${tx.json(proposedBlocks as never)},${tx.json(diff as never)},${tx.json(source as never)},${tx.json(provenance as never)},${supportState}) RETURNING *`;
        return map(rows[0] as Row);
      }).catch(errorFromSql);
    },
    async list(input) {
      await ensureWorkspace(input.workspaceId); await documentRow(sql, input.workspaceId, input.documentId);
      const rows = await sql`SELECT * FROM revision_proposals WHERE workspace_id=${input.workspaceId} AND document_id=${input.documentId} ORDER BY created_at ASC,id ASC`;
      return rows.map((row) => map(row as Row));
    },
    async get(input) { return map(await findProposal(input.workspaceId, input.proposalId)); },
    async review(input) {
      assertUuid(input.actorUserId, "actorUserId");
      return sql.begin(async (tx) => {
        const current = await findProposal(input.workspaceId, input.proposalId, tx, true);
        if ((current.status as string) !== "pending") return mapResult(current, tx);
        const proposal = map(current);
        if (input.action === "reject") {
          const rows = await tx`UPDATE revision_proposals SET status='rejected',review_action='reject',reviewer_user_id=${input.actorUserId},reviewed_at=now(),resulting_revision_number=NULL,updated_at=now() WHERE id=${proposal.id} RETURNING *`;
          return mapResult(rows[0] as Row, tx);
        }
        const document = await documentRow(tx, input.workspaceId, proposal.documentId, true);
        let nextBlocks: RevisionProposalBlock[];
        if (input.action === "accept") {
          nextBlocks = proposal.proposedBlocks.map((block, position) => ({ ...block, position }));
        } else {
          const selected = input.selectedProposalBlockIds ?? [];
          nextBlocks = selectProposalBlocks(await documentBlocks(tx, input.workspaceId, proposal.documentId), proposal.proposedBlocks, selected, proposal.diff);
        }
        assertValidRevisionBlocks(nextBlocks);
        if (document.current_revision_number !== proposal.baseRevisionNumber) {
          const conflict = { currentRevisionNumber: document.current_revision_number as number, currentTitle: document.title as string, currentBlocks: await documentBlocks(tx, input.workspaceId, proposal.documentId), conflictedAt: new Date().toISOString() };
          const rows = await tx`UPDATE revision_proposals SET status='conflicted',review_action=${input.action},reviewer_user_id=${input.actorUserId},reviewed_at=now(),current_conflict=${tx.json(conflict as never)},updated_at=now() WHERE id=${proposal.id} RETURNING *`;
          return mapResult(rows[0] as Row, tx);
        }
        const revision = await appendRevision(tx, { workspaceId: input.workspaceId, documentId: proposal.documentId, document, title: proposal.proposedTitle ?? proposal.baseTitle, blocks: nextBlocks!, reason: `revision-proposal:${input.action}` });
        const rows = await tx`UPDATE revision_proposals SET status='accepted',review_action=${input.action},reviewer_user_id=${input.actorUserId},reviewed_at=now(),resulting_revision_number=${revision},updated_at=now() WHERE id=${proposal.id} RETURNING *`;
        return mapResult(rows[0] as Row, tx);
      }).catch(errorFromSql);
    },
    async resolveConflict(input) {
      assertUuid(input.actorUserId, "actorUserId");
      return sql.begin(async (tx) => {
        const current = await findProposal(input.workspaceId, input.proposalId, tx, true);
        const proposal = map(current);
        if (proposal.status !== "conflicted") {
          if (proposal.status !== "pending") return mapResult(current, tx);
          throw new RevisionProposalRepositoryError("INVALID_TRANSITION", "Only conflicted proposals can be resolved");
        }
        const document = await documentRow(tx, input.workspaceId, proposal.documentId, true);
        if (document.current_revision_number !== input.expectedCurrentRevisionNumber) throw new RevisionProposalRepositoryError("CONFLICT", "Current revision changed; reload before resolving");
        const blocks = preserveBothBlocks(await documentBlocks(tx, input.workspaceId, proposal.documentId), proposal.proposedBlocks, input.selectedProposalBlockIds, proposal.diff);
        assertValidRevisionBlocks(blocks);
        const revision = await appendRevision(tx, { workspaceId: input.workspaceId, documentId: proposal.documentId, document, title: proposal.proposedTitle ?? proposal.baseTitle, blocks, reason: "revision-proposal:preserve_both" });
        const rows = await tx`UPDATE revision_proposals SET status='accepted',review_action='preserve_both',reviewer_user_id=${input.actorUserId},reviewed_at=now(),resulting_revision_number=${revision},current_conflict=NULL,updated_at=now() WHERE id=${proposal.id} RETURNING *`;
        return mapResult(rows[0] as Row, tx);
      }).catch(errorFromSql);
    },
  };
}
