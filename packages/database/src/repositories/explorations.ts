import { randomUUID } from "node:crypto";
import {
  explorationBlockKindSchema,
  explorationStatusSchema,
  type ExplorationBlockKind,
  type ExplorationStatus,
} from "@aistudy/contracts";
import type { Sql } from "postgres";

export type ExplorationErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "WORKSPACE_MISMATCH"
  | "INVALID_TRANSITION"
  | "CONFLICT";

export class ExplorationRepositoryError extends Error {
  readonly code: ExplorationErrorCode;
  constructor(code: ExplorationErrorCode, message: string) {
    super(message);
    this.name = "ExplorationRepositoryError";
    this.code = code;
  }
}

export type ExplorationRecord = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  courseId: string | null;
  goalId: string | null;
  title: string;
  status: ExplorationStatus;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  rootBranch: ExplorationBranchRecord;
};

export type ExplorationBranchRecord = {
  id: string;
  workspaceId: string;
  explorationId: string;
  parentBranchId: string | null;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ExplorationBlockRecord = {
  id: string;
  workspaceId: string;
  explorationId: string;
  branchId: string;
  kind: ExplorationBlockKind;
  content: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ExplorationDetailRecord = {
  exploration: ExplorationRecord;
  branches: ExplorationBranchRecord[];
  blocks: ExplorationBlockRecord[];
};

export type ExplorationRepository = {
  createExploration(input: {
    workspaceId: string;
    ownerUserId: string;
    title: string;
    courseId?: string | null;
    goalId?: string | null;
    explorationId?: string;
  }): Promise<ExplorationRecord>;
  listExplorations(input: { workspaceId: string }): Promise<ExplorationRecord[]>;
  getExploration(input: { workspaceId: string; explorationId: string }): Promise<ExplorationDetailRecord>;
  createBranch(input: {
    workspaceId: string;
    explorationId: string;
    parentBranchId?: string | null;
    title: string;
    branchId?: string;
  }): Promise<ExplorationBranchRecord>;
  createBlock(input: {
    workspaceId: string;
    explorationId: string;
    branchId: string;
    kind: ExplorationBlockKind;
    content: string;
    position?: number;
    blockId?: string;
  }): Promise<ExplorationBlockRecord>;
  setStatus(input: {
    workspaceId: string;
    explorationId: string;
    status: ExplorationStatus;
  }): Promise<ExplorationRecord>;
};

type Row = Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new ExplorationRepositoryError("VALIDATION", `Invalid UUID for ${field}`);
}

function assertText(value: string, field: string, max: number): string {
  const normalized = value?.normalize("NFKC").trim();
  if (!normalized || normalized.length > max) {
    throw new ExplorationRepositoryError("VALIDATION", `${field} must be between 1 and ${max} characters`);
  }
  return normalized;
}

function mapBranch(row: Row): ExplorationBranchRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    explorationId: row.exploration_id as string,
    parentBranchId: row.parent_branch_id as string | null,
    title: row.title as string,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

function mapBlock(row: Row): ExplorationBlockRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    explorationId: row.exploration_id as string,
    branchId: row.branch_id as string,
    kind: row.kind as ExplorationBlockKind,
    content: row.content as string,
    position: row.position as number,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

function mapExploration(row: Row, rootBranch: ExplorationBranchRecord): ExplorationRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    ownerUserId: row.owner_user_id as string,
    courseId: row.course_id as string | null,
    goalId: row.goal_id as string | null,
    title: row.title as string,
    status: row.status as ExplorationStatus,
    closedAt: row.closed_at ? new Date(row.closed_at as string | Date) : null,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
    rootBranch,
  };
}

export function createExplorationRepository(sql: Sql): ExplorationRepository {
  async function ensureWorkspace(workspaceId: string): Promise<void> {
    assertUuid(workspaceId, "workspaceId");
    const rows = await sql`SELECT id FROM workspaces WHERE id = ${workspaceId} LIMIT 1`;
    if (!rows.length) throw new ExplorationRepositoryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
  }

  async function getExplorationRow(workspaceId: string, explorationId: string, forUpdate = false): Promise<Row> {
    await ensureWorkspace(workspaceId);
    assertUuid(explorationId, "explorationId");
    const rows = forUpdate
      ? await sql`SELECT * FROM explorations WHERE id = ${explorationId} AND workspace_id = ${workspaceId} FOR UPDATE`
      : await sql`SELECT * FROM explorations WHERE id = ${explorationId} AND workspace_id = ${workspaceId}`;
    if (rows.length) return rows[0] as Row;
    const any = await sql`SELECT workspace_id FROM explorations WHERE id = ${explorationId} LIMIT 1`;
    if (any.length && any[0]!.workspace_id !== workspaceId) {
      throw new ExplorationRepositoryError("WORKSPACE_MISMATCH", `Exploration ${explorationId} is not in workspace ${workspaceId}`);
    }
    throw new ExplorationRepositoryError("NOT_FOUND", `Exploration not found: ${explorationId}`);
  }

  async function getRootBranch(workspaceId: string, explorationId: string): Promise<ExplorationBranchRecord> {
    const rows = await sql`
      SELECT * FROM exploration_branches
      WHERE workspace_id = ${workspaceId} AND exploration_id = ${explorationId} AND parent_branch_id IS NULL
      ORDER BY created_at ASC LIMIT 1
    `;
    if (!rows.length) throw new ExplorationRepositoryError("CONFLICT", `Root branch missing for exploration ${explorationId}`);
    return mapBranch(rows[0] as Row);
  }

  async function record(workspaceId: string, row: Row): Promise<ExplorationRecord> {
    return mapExploration(row, await getRootBranch(workspaceId, row.id as string));
  }

  async function validateCourse(workspaceId: string, courseId: string | null | undefined): Promise<void> {
    if (!courseId) return;
    assertUuid(courseId, "courseId");
    const rows = await sql`SELECT workspace_id FROM courses WHERE id = ${courseId} LIMIT 1`;
    if (!rows.length) throw new ExplorationRepositoryError("NOT_FOUND", `Course not found: ${courseId}`);
    if (rows[0]!.workspace_id !== workspaceId) throw new ExplorationRepositoryError("WORKSPACE_MISMATCH", `Course ${courseId} is not in workspace ${workspaceId}`);
  }

  async function validateOwner(workspaceId: string, ownerUserId: string): Promise<void> {
    assertUuid(ownerUserId, "ownerUserId");
    const rows = await sql`SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId}`;
    if (!rows.length) throw new ExplorationRepositoryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
    if (rows[0]!.owner_user_id !== ownerUserId) throw new ExplorationRepositoryError("WORKSPACE_MISMATCH", `User ${ownerUserId} does not own workspace ${workspaceId}`);
  }

  function ensureOpen(row: Row): void {
    if (row.status !== "open") {
      throw new ExplorationRepositoryError("INVALID_TRANSITION", "Closed explorations cannot be modified");
    }
  }

  async function validateBranch(workspaceId: string, explorationId: string, branchId: string): Promise<Row> {
    assertUuid(branchId, "branchId");
    const rows = await sql`
      SELECT b.* FROM exploration_branches b
      WHERE b.id = ${branchId} AND b.workspace_id = ${workspaceId} AND b.exploration_id = ${explorationId}
      LIMIT 1
    `;
    if (rows.length) return rows[0] as Row;
    const any = await sql`SELECT workspace_id, exploration_id FROM exploration_branches WHERE id = ${branchId} LIMIT 1`;
    if (any.length && (any[0]!.workspace_id !== workspaceId || any[0]!.exploration_id !== explorationId)) {
      throw new ExplorationRepositoryError("WORKSPACE_MISMATCH", `Branch ${branchId} is not in the requested exploration workspace`);
    }
    throw new ExplorationRepositoryError("NOT_FOUND", `Branch not found: ${branchId}`);
  }

  return {
    async createExploration(input) {
      const title = assertText(input.title, "title", 120);
      await ensureWorkspace(input.workspaceId);
      await validateOwner(input.workspaceId, input.ownerUserId);
      await validateCourse(input.workspaceId, input.courseId);
      if (input.goalId) assertUuid(input.goalId, "goalId");
      if (input.explorationId) assertUuid(input.explorationId, "explorationId");
      const explorationId = input.explorationId ?? randomUUID();
      const rootBranchId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO explorations (id, workspace_id, owner_user_id, course_id, goal_id, title, status)
          VALUES (${explorationId}, ${input.workspaceId}, ${input.ownerUserId}, ${input.courseId ?? null}, ${input.goalId ?? null}, ${title}, 'open')
        `;
        await tx`
          INSERT INTO exploration_branches (id, workspace_id, exploration_id, parent_branch_id, title)
          VALUES (${rootBranchId}, ${input.workspaceId}, ${explorationId}, NULL, 'Root')
        `;
      });
      const row = await getExplorationRow(input.workspaceId, explorationId);
      return record(input.workspaceId, row);
    },

    async listExplorations(input) {
      await ensureWorkspace(input.workspaceId);
      const rows = await sql`SELECT * FROM explorations WHERE workspace_id = ${input.workspaceId} ORDER BY updated_at DESC, created_at DESC`;
      return Promise.all(rows.map((row) => record(input.workspaceId, row as Row)));
    },

    async getExploration(input) {
      const row = await getExplorationRow(input.workspaceId, input.explorationId);
      const branches = (await sql`SELECT * FROM exploration_branches WHERE workspace_id = ${input.workspaceId} AND exploration_id = ${input.explorationId} ORDER BY created_at ASC`).map((item) => mapBranch(item as Row));
      const blocks = (await sql`SELECT * FROM exploration_blocks WHERE workspace_id = ${input.workspaceId} AND exploration_id = ${input.explorationId} ORDER BY branch_id, position ASC, created_at ASC`).map((item) => mapBlock(item as Row));
      return { exploration: await record(input.workspaceId, row), branches, blocks };
    },

    async createBranch(input) {
      const title = assertText(input.title, "title", 120);
      const exploration = await getExplorationRow(input.workspaceId, input.explorationId);
      ensureOpen(exploration);
      if (!input.parentBranchId) throw new ExplorationRepositoryError("VALIDATION", "Child branches require a parentBranchId");
      await validateBranch(input.workspaceId, input.explorationId, input.parentBranchId);
      const branchId = input.branchId ?? randomUUID();
      assertUuid(branchId, "branchId");
      try {
        const rows = await sql`
          INSERT INTO exploration_branches (id, workspace_id, exploration_id, parent_branch_id, title)
          VALUES (${branchId}, ${input.workspaceId}, ${input.explorationId}, ${input.parentBranchId}, ${title})
          RETURNING *
        `;
        await sql`UPDATE explorations SET updated_at = now() WHERE id = ${input.explorationId} AND workspace_id = ${input.workspaceId}`;
        return mapBranch(rows[0] as Row);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new ExplorationRepositoryError("CONFLICT", "Branch already exists");
        throw error;
      }
    },

    async createBlock(input) {
      const content = assertText(input.content, "content", 20_000);
      const exploration = await getExplorationRow(input.workspaceId, input.explorationId);
      ensureOpen(exploration);
      await validateBranch(input.workspaceId, input.explorationId, input.branchId);
      const kind = explorationBlockKindSchema.safeParse(input.kind);
      if (!kind.success) throw new ExplorationRepositoryError("VALIDATION", "Invalid block kind");
      if (input.position !== undefined && (!Number.isInteger(input.position) || input.position < 0)) {
        throw new ExplorationRepositoryError("VALIDATION", "Position must be a non-negative integer");
      }
      const blockId = input.blockId ?? randomUUID();
      assertUuid(blockId, "blockId");
      const position = input.position ?? Number((await sql`SELECT COALESCE(MAX(position) + 1, 0) AS position FROM exploration_blocks WHERE branch_id = ${input.branchId}`)[0]!.position);
      try {
        const rows = await sql`
          INSERT INTO exploration_blocks (id, workspace_id, exploration_id, branch_id, kind, content, position)
          VALUES (${blockId}, ${input.workspaceId}, ${input.explorationId}, ${input.branchId}, ${kind.data}, ${content}, ${position})
          RETURNING *
        `;
        await sql`UPDATE explorations SET updated_at = now() WHERE id = ${input.explorationId} AND workspace_id = ${input.workspaceId}`;
        return mapBlock(rows[0] as Row);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new ExplorationRepositoryError("CONFLICT", "Block position already exists");
        throw error;
      }
    },

    async setStatus(input) {
      const parsed = explorationStatusSchema.safeParse(input.status);
      if (!parsed.success) throw new ExplorationRepositoryError("VALIDATION", "Invalid exploration status");
      const row = await getExplorationRow(input.workspaceId, input.explorationId);
      if (row.status === parsed.data) throw new ExplorationRepositoryError("INVALID_TRANSITION", `Exploration is already ${parsed.data}`);
      const rows = parsed.data === "closed"
        ? await sql`
            UPDATE explorations SET status = 'closed', closed_at = now(), updated_at = now()
            WHERE id = ${input.explorationId} AND workspace_id = ${input.workspaceId} AND status = 'open'
            RETURNING *
          `
        : await sql`
            UPDATE explorations SET status = 'open', closed_at = NULL, updated_at = now()
            WHERE id = ${input.explorationId} AND workspace_id = ${input.workspaceId} AND status = 'closed'
            RETURNING *
          `;
      return record(input.workspaceId, rows[0] as Row);
    },
  };
}
