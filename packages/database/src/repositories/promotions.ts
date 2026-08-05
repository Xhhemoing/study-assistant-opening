import { randomUUID } from "node:crypto";
import {
  promotionCandidateKindSchema,
  type PromotionCandidateKind,
  type PromotionRecord,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
export type PromotionErrorCode =
  "NOT_FOUND" | "VALIDATION" | "WORKSPACE_MISMATCH" | "CONFLICT";
export class PromotionRepositoryError extends Error {
  constructor(
    readonly code: PromotionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromotionRepositoryError";
  }
}
export type PromotionRepository = {
  create(input: {
    workspaceId: string;
    explorationId: string;
    sourceTurnId?: string | null;
    kind: PromotionCandidateKind;
    title: string;
    body: string;
  }): Promise<PromotionRecord>;
  list(input: {
    workspaceId: string;
    explorationId: string;
  }): Promise<PromotionRecord[]>;
  get(input: {
    workspaceId: string;
    promotionId: string;
  }): Promise<PromotionRecord>;
  getByDocumentTarget(input: {
    workspaceId: string;
    documentId: string;
  }): Promise<PromotionRecord>;
  accept(input: {
    workspaceId: string;
    promotionId: string;
  }): Promise<PromotionRecord>;
  reject(input: {
    workspaceId: string;
    promotionId: string;
  }): Promise<PromotionRecord>;
};
type Row = Record<string, unknown>;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertUuid(value: string, field: string) {
  if (!uuid.test(value))
    throw new PromotionRepositoryError(
      "VALIDATION",
      `Invalid UUID for ${field}`,
    );
}
function clean(value: string, field: string, max: number) {
  const result = value?.normalize("NFKC").trim();
  if (!result || result.length > max)
    throw new PromotionRepositoryError(
      "VALIDATION",
      `${field} must be between 1 and ${max} characters`,
    );
  return result;
}
function map(row: Row): PromotionRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    explorationId: row.exploration_id as string,
    sourceTurnId: row.source_turn_id as string | null,
    kind: row.kind as PromotionCandidateKind,
    title: row.title as string,
    body: row.body as string,
    status: row.status as PromotionRecord["status"],
    targetType: row.target_type as PromotionRecord["targetType"],
    targetId: row.target_id as string | null,
    reviewedAt: row.reviewed_at
      ? new Date(row.reviewed_at as string | Date)
      : null,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}
export function createPromotionRepository(sql: Sql): PromotionRepository {
  async function ensureExploration(
    workspaceId: string,
    explorationId: string,
    db: Sql = sql,
  ) {
    assertUuid(workspaceId, "workspaceId");
    assertUuid(explorationId, "explorationId");
    const rows =
      await db`SELECT workspace_id FROM explorations WHERE id=${explorationId} LIMIT 1`;
    if (!rows.length)
      throw new PromotionRepositoryError(
        "NOT_FOUND",
        `Exploration not found: ${explorationId}`,
      );
    if (rows[0]!.workspace_id !== workspaceId)
      throw new PromotionRepositoryError(
        "WORKSPACE_MISMATCH",
        `Exploration ${explorationId} is not in workspace ${workspaceId}`,
      );
  }
  async function find(
    workspaceId: string,
    promotionId: string,
    db: Sql = sql,
    lock = false,
  ) {
    assertUuid(workspaceId, "workspaceId");
    assertUuid(promotionId, "promotionId");
    const rows = lock
      ? await db`SELECT * FROM promotion_records WHERE id=${promotionId} FOR UPDATE`
      : await db`SELECT * FROM promotion_records WHERE id=${promotionId}`;
    if (!rows.length)
      throw new PromotionRepositoryError(
        "NOT_FOUND",
        `Promotion not found: ${promotionId}`,
      );
    if (rows[0]!.workspace_id !== workspaceId)
      throw new PromotionRepositoryError(
        "WORKSPACE_MISMATCH",
        `Promotion ${promotionId} is not in workspace ${workspaceId}`,
      );
    return rows[0] as Row;
  }
  return {
    async create(input) {
      await ensureExploration(input.workspaceId, input.explorationId);
      const kind = promotionCandidateKindSchema.safeParse(input.kind);
      if (!kind.success)
        throw new PromotionRepositoryError(
          "VALIDATION",
          "Invalid promotion kind",
        );
      if (input.sourceTurnId) assertUuid(input.sourceTurnId, "sourceTurnId");
      const rows =
        await sql`INSERT INTO promotion_records(workspace_id,exploration_id,source_turn_id,kind,title,body) VALUES(${input.workspaceId},${input.explorationId},${input.sourceTurnId ?? null},${kind.data},${clean(input.title, "title", 200)},${clean(input.body, "body", 20000)}) RETURNING *`;
      return map(rows[0] as Row);
    },
    async list(input) {
      await ensureExploration(input.workspaceId, input.explorationId);
      return (
        await sql`SELECT * FROM promotion_records WHERE workspace_id=${input.workspaceId} AND exploration_id=${input.explorationId} ORDER BY created_at`
      ).map((r) => map(r as Row));
    },
    async get(input) {
      return map(await find(input.workspaceId, input.promotionId));
    },
    async getByDocumentTarget(input) {
      assertUuid(input.workspaceId, "workspaceId");
      assertUuid(input.documentId, "documentId");
      const rows =
        await sql`SELECT * FROM promotion_records WHERE target_type='document' AND target_id=${input.documentId} LIMIT 1`;
      if (!rows.length)
        throw new PromotionRepositoryError(
          "NOT_FOUND",
          `Promotion source not found for document: ${input.documentId}`,
        );
      if (rows[0]!.workspace_id !== input.workspaceId)
        throw new PromotionRepositoryError(
          "WORKSPACE_MISMATCH",
          `Document ${input.documentId} is not in workspace ${input.workspaceId}`,
        );
      return map(rows[0] as Row);
    },
    async accept(input) {
      return sql.begin(async (tx) => {
        const current = await find(
          input.workspaceId,
          input.promotionId,
          tx,
          true,
        );
        if (current.status !== "pending") return map(current);
        await ensureExploration(
          input.workspaceId,
          current.exploration_id as string,
          tx,
        );
        const targetId = randomUUID();
        let targetType = current.kind as string;
        if (current.kind === "note") {
          targetType = "document";
          const blockId = randomUUID();
          const content = { text: current.body as string };
          const blocks = [
            { id: blockId, type: "paragraph", position: 0, content },
          ];
          await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle,current_revision_number) VALUES(${targetId},${input.workspaceId},${current.title as string},'confirmed',1)`;
          await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content) VALUES(${blockId},${input.workspaceId},${targetId},'paragraph',0,${tx.json(content)})`;
          await tx`INSERT INTO library_revisions(workspace_id,document_id,revision_number,title,lifecycle,reason,blocks) VALUES(${input.workspaceId},${targetId},1,${current.title as string},'confirmed','promotion',${tx.json(blocks)})`;
        } else {
          await tx`INSERT INTO promotion_targets(id,workspace_id,promotion_id,exploration_id,source_turn_id,kind,title,body) VALUES(${targetId},${input.workspaceId},${current.id as string},${current.exploration_id as string},${current.source_turn_id as string | null},${current.kind as string},${current.title as string},${current.body as string})`;
        }
        const rows =
          await tx`UPDATE promotion_records SET status='accepted',target_type=${targetType},target_id=${targetId},reviewed_at=now(),updated_at=now() WHERE id=${current.id as string} AND workspace_id=${input.workspaceId} RETURNING *`;
        return map(rows[0] as Row);
      });
    },
    async reject(input) {
      return sql.begin(async (tx) => {
        const current = await find(
          input.workspaceId,
          input.promotionId,
          tx,
          true,
        );
        if (current.status !== "pending") return map(current);
        const rows =
          await tx`UPDATE promotion_records SET status='rejected',reviewed_at=now(),updated_at=now() WHERE id=${input.promotionId} AND workspace_id=${input.workspaceId} RETURNING *`;
        return map(rows[0] as Row);
      });
    },
  };
}
