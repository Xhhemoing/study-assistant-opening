import { randomUUID } from "node:crypto";
import {
  assetLifecycleSchema,
  assertLifecycleTransition,
  LifecycleTransitionError,
  type AssetLifecycle,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
import type { RevisionBlockSnapshot } from "../schema/library";

const LIFECYCLES = new Set(assetLifecycleSchema.options);
const RELATION_TYPES = new Set([
  "references",
  "supports",
  "embeds",
  "derived_from",
  "related",
] as const);
const SUBJECT_TYPES = new Set(["document", "block"] as const);
const VALUE_TYPES = new Set(["string", "number", "boolean", "json"] as const);

export type LibraryErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "WORKSPACE_MISMATCH"
  | "CROSS_WORKSPACE_REFERENCE"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "CONFLICT";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;

  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
  }
}

export type BlockInput = {
  id: string;
  type: string;
  content: Record<string, unknown>;
};

export type DocumentRecord = {
  id: string;
  workspaceId: string;
  title: string;
  lifecycle: AssetLifecycle;
  schemaVersion: number;
  currentRevisionNumber: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  blocks: Array<{
    id: string;
    type: string;
    position: number;
    content: Record<string, unknown>;
  }>;
};

export type RevisionRecord = {
  id: string;
  workspaceId: string;
  documentId: string;
  revisionNumber: number;
  parentRevisionNumber: number | null;
  title: string;
  lifecycle: AssetLifecycle;
  reason: string;
  blocks: RevisionBlockSnapshot[];
  createdAt: Date;
};

export type RelationRecord = {
  id: string;
  workspaceId: string;
  fromType: "document" | "block";
  fromId: string;
  toType: "document" | "block";
  toId: string;
  relationType: string;
  createdAt: Date;
};

export type PropertyRecord = {
  id: string;
  workspaceId: string;
  subjectType: "document" | "block";
  subjectId: string;
  key: string;
  valueType: "string" | "number" | "boolean" | "json";
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type LibraryRepository = {
  createWorkspace(input: {
    id: string;
    ownerUserId: string;
  }): Promise<void>;

  createDocument(input: {
    workspaceId: string;
    title: string;
    lifecycle?: AssetLifecycle;
    blocks: BlockInput[];
    documentId?: string;
  }): Promise<DocumentRecord>;

  getDocument(input: {
    workspaceId: string;
    documentId: string;
    includeDeleted?: boolean;
  }): Promise<DocumentRecord>;

  listDocuments(input: {
    workspaceId: string;
  }): Promise<DocumentRecord[]>;

  updateDocument(input: {
    workspaceId: string;
    documentId: string;
    title?: string;
    lifecycle?: AssetLifecycle;
    blocks: BlockInput[];
    reason?: string;
  }): Promise<DocumentRecord>;

  softDeleteDocument(input: {
    workspaceId: string;
    documentId: string;
  }): Promise<void>;

  restoreDocument(input: {
    workspaceId: string;
    documentId: string;
  }): Promise<DocumentRecord>;

  listRevisions(input: {
    workspaceId: string;
    documentId: string;
  }): Promise<RevisionRecord[]>;

  getRevision(input: {
    workspaceId: string;
    documentId: string;
    revisionNumber: number;
  }): Promise<RevisionRecord>;

  createRelation(input: {
    workspaceId: string;
    fromType: "document" | "block";
    fromId: string;
    toType: "document" | "block";
    toId: string;
    relationType: string;
  }): Promise<RelationRecord>;

  listRelations(input: {
    workspaceId: string;
    subjectType: "document" | "block";
    subjectId: string;
  }): Promise<RelationRecord[]>;

  setProperty(input: {
    workspaceId: string;
    subjectType: "document" | "block";
    subjectId: string;
    key: string;
    valueType: "string" | "number" | "boolean" | "json";
    value: unknown;
  }): Promise<PropertyRecord>;

  listProperties(input: {
    workspaceId: string;
    subjectType: "document" | "block";
    subjectId: string;
  }): Promise<PropertyRecord[]>;
};

type SqlClient = Sql;

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new LibraryError("VALIDATION", `Invalid UUID for ${field}`);
  }
}

function assertLifecycle(value: string): asserts value is AssetLifecycle {
  if (!LIFECYCLES.has(value as AssetLifecycle)) {
    throw new LibraryError("VALIDATION", `Invalid lifecycle: ${value}`);
  }
}

function normalizeBlocks(blocks: BlockInput[]): RevisionBlockSnapshot[] {
  if (!blocks.length) {
    throw new LibraryError("VALIDATION", "Document requires at least one block");
  }

  const seen = new Set<string>();
  return blocks.map((block, position) => {
    assertUuid(block.id, "block.id");
    if (seen.has(block.id)) {
      throw new LibraryError("VALIDATION", `Duplicate block id: ${block.id}`);
    }
    seen.add(block.id);
    if (!block.type || !block.type.trim()) {
      throw new LibraryError("VALIDATION", "Block type is required");
    }
    if (
      block.content === null ||
      typeof block.content !== "object" ||
      Array.isArray(block.content)
    ) {
      throw new LibraryError("VALIDATION", "Block content must be an object");
    }
    return {
      id: block.id,
      type: block.type,
      position,
      content: block.content,
    };
  });
}

function mapDocRow(
  row: {
    id: string;
    workspace_id: string;
    title: string;
    lifecycle: string;
    schema_version: number;
    current_revision_number: number;
    created_at: Date | string;
    updated_at: Date | string;
    deleted_at: Date | string | null;
  },
  blocks: RevisionBlockSnapshot[],
): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    lifecycle: row.lifecycle as AssetLifecycle,
    schemaVersion: row.schema_version,
    currentRevisionNumber: row.current_revision_number,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    blocks: blocks.map((b) => ({
      id: b.id,
      type: b.type,
      position: b.position,
      content: b.content,
    })),
  };
}

function mapRevisionRow(row: {
  id: string;
  workspace_id: string;
  document_id: string;
  revision_number: number;
  parent_revision_number: number | null;
  title: string;
  lifecycle: string;
  reason: string;
  blocks: RevisionBlockSnapshot[];
  created_at: Date | string;
}): RevisionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    revisionNumber: row.revision_number,
    parentRevisionNumber: row.parent_revision_number,
    title: row.title,
    lifecycle: row.lifecycle as AssetLifecycle,
    reason: row.reason,
    blocks: row.blocks,
    createdAt: new Date(row.created_at),
  };
}

export function createLibraryRepository(sql: SqlClient): LibraryRepository {
  async function ensureWorkspace(workspaceId: string): Promise<void> {
    assertUuid(workspaceId, "workspaceId");
    const rows = await sql`
      SELECT id FROM workspaces WHERE id = ${workspaceId} LIMIT 1
    `;
    if (!rows.length) {
      throw new LibraryError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
    }
  }

  async function loadBlocks(
    workspaceId: string,
    documentId: string,
  ): Promise<RevisionBlockSnapshot[]> {
    const rows = await sql<
      {
        id: string;
        type: string;
        position: number;
        content: Record<string, unknown>;
      }[]
    >`
      SELECT id, type, position, content
      FROM library_blocks
      WHERE workspace_id = ${workspaceId} AND document_id = ${documentId}
      ORDER BY position ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      position: r.position,
      content: r.content,
    }));
  }

  async function replaceProjectionBlocks(
    tx: SqlClient,
    workspaceId: string,
    documentId: string,
    blocks: RevisionBlockSnapshot[],
  ): Promise<void> {
    await tx`
      DELETE FROM library_blocks
      WHERE workspace_id = ${workspaceId} AND document_id = ${documentId}
    `;
    for (const block of blocks) {
      await tx`
        INSERT INTO library_blocks (
          id, workspace_id, document_id, type, position, content
        ) VALUES (
          ${block.id},
          ${workspaceId},
          ${documentId},
          ${block.type},
          ${block.position},
          ${sql.json(block.content as never)}
        )
      `;
    }
  }

  async function insertRevision(
    tx: SqlClient,
    input: {
      workspaceId: string;
      documentId: string;
      revisionNumber: number;
      parentRevisionNumber: number | null;
      title: string;
      lifecycle: AssetLifecycle;
      reason: string;
      blocks: RevisionBlockSnapshot[];
    },
  ): Promise<void> {
    await tx`
      INSERT INTO library_revisions (
        workspace_id,
        document_id,
        revision_number,
        parent_revision_number,
        title,
        lifecycle,
        reason,
        blocks
      ) VALUES (
        ${input.workspaceId},
        ${input.documentId},
        ${input.revisionNumber},
        ${input.parentRevisionNumber},
        ${input.title},
        ${input.lifecycle},
        ${input.reason},
        ${sql.json(input.blocks as never)}
      )
    `;
  }

  async function getDocumentRow(
    workspaceId: string,
    documentId: string,
    options: { includeDeleted?: boolean; forUpdate?: boolean } = {},
  ) {
    const includeDeleted = options.includeDeleted ?? false;
    const rows = options.forUpdate
      ? await sql`
          SELECT *
          FROM library_documents
          WHERE id = ${documentId} AND workspace_id = ${workspaceId}
          ${includeDeleted ? sql`` : sql`AND deleted_at IS NULL`}
          FOR UPDATE
        `
      : await sql`
          SELECT *
          FROM library_documents
          WHERE id = ${documentId} AND workspace_id = ${workspaceId}
          ${includeDeleted ? sql`` : sql`AND deleted_at IS NULL`}
        `;

    if (!rows.length) {
      // Distinguish missing vs workspace mismatch when the document exists elsewhere.
      const any = await sql`
        SELECT workspace_id, deleted_at FROM library_documents WHERE id = ${documentId} LIMIT 1
      `;
      if (any.length && any[0]!.workspace_id !== workspaceId) {
        throw new LibraryError(
          "WORKSPACE_MISMATCH",
          `Document ${documentId} is not in workspace ${workspaceId}`,
        );
      }
      throw new LibraryError("NOT_FOUND", `Document not found: ${documentId}`);
    }
    return rows[0]!;
  }

  async function resolveSubjectWorkspace(
    subjectType: "document" | "block",
    subjectId: string,
  ): Promise<string> {
    if (subjectType === "document") {
      const rows = await sql`
        SELECT workspace_id FROM library_documents WHERE id = ${subjectId} LIMIT 1
      `;
      if (!rows.length) {
        throw new LibraryError("NOT_FOUND", `Document not found: ${subjectId}`);
      }
      return rows[0]!.workspace_id as string;
    }

    const rows = await sql`
      SELECT workspace_id FROM library_blocks WHERE id = ${subjectId} LIMIT 1
    `;
    if (!rows.length) {
      throw new LibraryError("NOT_FOUND", `Block not found: ${subjectId}`);
    }
    return rows[0]!.workspace_id as string;
  }

  return {
    async createWorkspace(input) {
      assertUuid(input.id, "workspace.id");
      assertUuid(input.ownerUserId, "workspace.ownerUserId");
      await sql`
        INSERT INTO workspaces (id, owner_user_id)
        VALUES (${input.id}, ${input.ownerUserId})
        ON CONFLICT (id) DO NOTHING
      `;
    },

    async createDocument(input) {
      await ensureWorkspace(input.workspaceId);
      const lifecycle = input.lifecycle ?? "scratch";
      assertLifecycle(lifecycle);
      if (!input.title?.trim()) {
        throw new LibraryError("VALIDATION", "Document title is required");
      }
      const blocks = normalizeBlocks(input.blocks);
      const documentId = input.documentId ?? randomUUID();
      assertUuid(documentId, "documentId");

      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO library_documents (
            id, workspace_id, title, lifecycle, schema_version, current_revision_number
          ) VALUES (
            ${documentId},
            ${input.workspaceId},
            ${input.title},
            ${lifecycle},
            1,
            1
          )
        `;
        await replaceProjectionBlocks(tx, input.workspaceId, documentId, blocks);
        await insertRevision(tx, {
          workspaceId: input.workspaceId,
          documentId,
          revisionNumber: 1,
          parentRevisionNumber: null,
          title: input.title,
          lifecycle,
          reason: "create",
          blocks,
        });
      });

      return this.getDocument({
        workspaceId: input.workspaceId,
        documentId,
      });
    },

    async getDocument(input) {
      const row = await getDocumentRow(input.workspaceId, input.documentId, {
        includeDeleted: input.includeDeleted,
      });
      const blocks = await loadBlocks(input.workspaceId, input.documentId);
      return mapDocRow(
        row as {
          id: string;
          workspace_id: string;
          title: string;
          lifecycle: string;
          schema_version: number;
          current_revision_number: number;
          created_at: Date | string;
          updated_at: Date | string;
          deleted_at: Date | string | null;
        },
        blocks,
      );
    },

    async listDocuments(input) {
      await ensureWorkspace(input.workspaceId);
      const rows = await sql`
        SELECT *
        FROM library_documents
        WHERE workspace_id = ${input.workspaceId}
          AND deleted_at IS NULL
        ORDER BY updated_at DESC, id ASC
      `;
      return Promise.all(rows.map(async (row) => {
        const documentId = row.id as string;
        const blocks = await loadBlocks(input.workspaceId, documentId);
        return mapDocRow(
          row as {
            id: string;
            workspace_id: string;
            title: string;
            lifecycle: string;
            schema_version: number;
            current_revision_number: number;
            created_at: Date | string;
            updated_at: Date | string;
            deleted_at: Date | string | null;
          },
          blocks,
        );
      }));
    },

    async updateDocument(input) {
      await ensureWorkspace(input.workspaceId);
      const blocks = normalizeBlocks(input.blocks);

      await sql.begin(async (tx) => {
        const rows = await tx`
          SELECT *
          FROM library_documents
          WHERE id = ${input.documentId} AND workspace_id = ${input.workspaceId}
            AND deleted_at IS NULL
          FOR UPDATE
        `;
        if (!rows.length) {
          const any = await tx`
            SELECT workspace_id FROM library_documents WHERE id = ${input.documentId} LIMIT 1
          `;
          if (any.length && any[0]!.workspace_id !== input.workspaceId) {
            throw new LibraryError(
              "WORKSPACE_MISMATCH",
              `Document ${input.documentId} is not in workspace ${input.workspaceId}`,
            );
          }
          throw new LibraryError(
            "NOT_FOUND",
            `Document not found: ${input.documentId}`,
          );
        }

        const current = rows[0]!;
        const nextTitle = input.title ?? (current.title as string);
        const nextLifecycle = (input.lifecycle ??
          current.lifecycle) as AssetLifecycle;
        assertLifecycle(nextLifecycle);
        try {
          assertLifecycleTransition(current.lifecycle as AssetLifecycle, nextLifecycle);
        } catch (error) {
          if (error instanceof LifecycleTransitionError) {
            throw new LibraryError("INVALID_LIFECYCLE_TRANSITION", error.message);
          }
          throw error;
        }
        if (!nextTitle.trim()) {
          throw new LibraryError("VALIDATION", "Document title is required");
        }

        const nextRevision = (current.current_revision_number as number) + 1;

        await tx`
          UPDATE library_documents
          SET title = ${nextTitle},
              lifecycle = ${nextLifecycle},
              current_revision_number = ${nextRevision},
              updated_at = now()
          WHERE id = ${input.documentId} AND workspace_id = ${input.workspaceId}
        `;

        await replaceProjectionBlocks(
          tx,
          input.workspaceId,
          input.documentId,
          blocks,
        );
        await insertRevision(tx, {
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          revisionNumber: nextRevision,
          parentRevisionNumber: current.current_revision_number as number,
          title: nextTitle,
          lifecycle: nextLifecycle,
          reason: input.reason ?? "edit",
          blocks,
        });
      });

      return this.getDocument({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
      });
    },

    async softDeleteDocument(input) {
      const result = await sql`
        UPDATE library_documents
        SET deleted_at = now(), updated_at = now()
        WHERE id = ${input.documentId}
          AND workspace_id = ${input.workspaceId}
          AND deleted_at IS NULL
        RETURNING id
      `;
      if (!result.length) {
        await getDocumentRow(input.workspaceId, input.documentId, {
          includeDeleted: true,
        });
        throw new LibraryError(
          "NOT_FOUND",
          `Document already deleted or missing: ${input.documentId}`,
        );
      }
    },

    async restoreDocument(input) {
      const result = await sql`
        UPDATE library_documents
        SET deleted_at = NULL, updated_at = now()
        WHERE id = ${input.documentId}
          AND workspace_id = ${input.workspaceId}
          AND deleted_at IS NOT NULL
        RETURNING id
      `;
      if (!result.length) {
        await getDocumentRow(input.workspaceId, input.documentId, {
          includeDeleted: true,
        });
        throw new LibraryError(
          "NOT_FOUND",
          `Document is not soft-deleted: ${input.documentId}`,
        );
      }
      return this.getDocument({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
      });
    },

    async listRevisions(input) {
      // Ensure document is reachable in this workspace (including deleted).
      await getDocumentRow(input.workspaceId, input.documentId, {
        includeDeleted: true,
      });
      const rows = await sql`
        SELECT *
        FROM library_revisions
        WHERE document_id = ${input.documentId}
          AND workspace_id = ${input.workspaceId}
        ORDER BY revision_number ASC
      `;
      return rows.map((row) =>
        mapRevisionRow(
          row as {
            id: string;
            workspace_id: string;
            document_id: string;
            revision_number: number;
            parent_revision_number: number | null;
            title: string;
            lifecycle: string;
            reason: string;
            blocks: RevisionBlockSnapshot[];
            created_at: Date | string;
          },
        ),
      );
    },

    async getRevision(input) {
      const rows = await sql`
        SELECT *
        FROM library_revisions
        WHERE document_id = ${input.documentId}
          AND workspace_id = ${input.workspaceId}
          AND revision_number = ${input.revisionNumber}
        LIMIT 1
      `;
      if (!rows.length) {
        throw new LibraryError(
          "NOT_FOUND",
          `Revision ${input.revisionNumber} not found for document ${input.documentId}`,
        );
      }
      return mapRevisionRow(
        rows[0] as {
          id: string;
          workspace_id: string;
          document_id: string;
          revision_number: number;
          parent_revision_number: number | null;
          title: string;
          lifecycle: string;
          reason: string;
          blocks: RevisionBlockSnapshot[];
          created_at: Date | string;
        },
      );
    },

    async createRelation(input) {
      await ensureWorkspace(input.workspaceId);
      if (!SUBJECT_TYPES.has(input.fromType) || !SUBJECT_TYPES.has(input.toType)) {
        throw new LibraryError("VALIDATION", "Invalid relation subject type");
      }
      if (!RELATION_TYPES.has(input.relationType as never)) {
        throw new LibraryError(
          "VALIDATION",
          `Invalid relation type: ${input.relationType}`,
        );
      }
      assertUuid(input.fromId, "fromId");
      assertUuid(input.toId, "toId");

      const fromWs = await resolveSubjectWorkspace(input.fromType, input.fromId);
      const toWs = await resolveSubjectWorkspace(input.toType, input.toId);

      if (fromWs !== input.workspaceId || toWs !== input.workspaceId) {
        throw new LibraryError(
          "CROSS_WORKSPACE_REFERENCE",
          "Relations cannot cross workspace boundaries",
        );
      }
      if (fromWs !== toWs) {
        throw new LibraryError(
          "CROSS_WORKSPACE_REFERENCE",
          "Relation endpoints must share a workspace",
        );
      }

      const rows = await sql`
        INSERT INTO library_relations (
          workspace_id, from_type, from_id, to_type, to_id, relation_type
        ) VALUES (
          ${input.workspaceId},
          ${input.fromType},
          ${input.fromId},
          ${input.toType},
          ${input.toId},
          ${input.relationType}
        )
        ON CONFLICT (workspace_id, from_type, from_id, to_type, to_id, relation_type)
        DO UPDATE SET relation_type = EXCLUDED.relation_type
        RETURNING *
      `;

      const row = rows[0]!;
      return {
        id: row.id as string,
        workspaceId: row.workspace_id as string,
        fromType: row.from_type as "document" | "block",
        fromId: row.from_id as string,
        toType: row.to_type as "document" | "block",
        toId: row.to_id as string,
        relationType: row.relation_type as string,
        createdAt: new Date(row.created_at as string),
      };
    },

    async listRelations(input) {
      await ensureWorkspace(input.workspaceId);
      const rows = await sql`
        SELECT *
        FROM library_relations
        WHERE workspace_id = ${input.workspaceId}
          AND (
            (from_type = ${input.subjectType} AND from_id = ${input.subjectId})
            OR (to_type = ${input.subjectType} AND to_id = ${input.subjectId})
          )
        ORDER BY created_at ASC
      `;
      return rows.map((row) => ({
        id: row.id as string,
        workspaceId: row.workspace_id as string,
        fromType: row.from_type as "document" | "block",
        fromId: row.from_id as string,
        toType: row.to_type as "document" | "block",
        toId: row.to_id as string,
        relationType: row.relation_type as string,
        createdAt: new Date(row.created_at as string),
      }));
    },

    async setProperty(input) {
      await ensureWorkspace(input.workspaceId);
      if (!SUBJECT_TYPES.has(input.subjectType)) {
        throw new LibraryError("VALIDATION", "Invalid property subject type");
      }
      if (!VALUE_TYPES.has(input.valueType)) {
        throw new LibraryError(
          "VALIDATION",
          `Invalid property value type: ${input.valueType}`,
        );
      }
      if (!input.key?.trim()) {
        throw new LibraryError("VALIDATION", "Property key is required");
      }
      assertUuid(input.subjectId, "subjectId");

      const subjectWs = await resolveSubjectWorkspace(
        input.subjectType,
        input.subjectId,
      );
      if (subjectWs !== input.workspaceId) {
        throw new LibraryError(
          "WORKSPACE_MISMATCH",
          `Subject ${input.subjectId} is not in workspace ${input.workspaceId}`,
        );
      }

      // Light value-type enforcement.
      if (input.valueType === "string" && typeof input.value !== "string") {
        throw new LibraryError("VALIDATION", "string property requires string value");
      }
      if (input.valueType === "number" && typeof input.value !== "number") {
        throw new LibraryError("VALIDATION", "number property requires number value");
      }
      if (input.valueType === "boolean" && typeof input.value !== "boolean") {
        throw new LibraryError(
          "VALIDATION",
          "boolean property requires boolean value",
        );
      }

      const rows = await sql`
        INSERT INTO library_properties (
          workspace_id, subject_type, subject_id, key, value_type, value
        ) VALUES (
          ${input.workspaceId},
          ${input.subjectType},
          ${input.subjectId},
          ${input.key},
          ${input.valueType},
          ${sql.json(input.value as never)}
        )
        ON CONFLICT (workspace_id, subject_type, subject_id, key)
        DO UPDATE SET
          value_type = EXCLUDED.value_type,
          value = EXCLUDED.value,
          updated_at = now()
        RETURNING *
      `;

      const row = rows[0]!;
      return {
        id: row.id as string,
        workspaceId: row.workspace_id as string,
        subjectType: row.subject_type as "document" | "block",
        subjectId: row.subject_id as string,
        key: row.key as string,
        valueType: row.value_type as PropertyRecord["valueType"],
        value: row.value,
        createdAt: new Date(row.created_at as string),
        updatedAt: new Date(row.updated_at as string),
      };
    },

    async listProperties(input) {
      await ensureWorkspace(input.workspaceId);
      const rows = await sql`
        SELECT *
        FROM library_properties
        WHERE workspace_id = ${input.workspaceId}
          AND subject_type = ${input.subjectType}
          AND subject_id = ${input.subjectId}
        ORDER BY key ASC
      `;
      return rows.map((row) => ({
        id: row.id as string,
        workspaceId: row.workspace_id as string,
        subjectType: row.subject_type as "document" | "block",
        subjectId: row.subject_id as string,
        key: row.key as string,
        valueType: row.value_type as PropertyRecord["valueType"],
        value: row.value,
        createdAt: new Date(row.created_at as string),
        updatedAt: new Date(row.updated_at as string),
      }));
    },
  };
}
