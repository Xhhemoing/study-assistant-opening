import { randomUUID } from "node:crypto";
import {
  WRITING_META_PROPERTY_KEY,
  WRITING_WORKSPACE_PROTOCOL,
  courselessActivityOutcomeSchema,
  scopeSchema,
  uuidSchema,
  writingActivityCheckpointSchema,
  writingCommandInputSchema,
  writingFocusRestoreSchema,
  writingStartInputSchema,
  writingVariantMetaSchema,
  writingWorkspaceViewSchema,
  type AssetLifecycle,
  type CourselessActivityOutcome,
  type Scope,
  type WritingActivityCheckpoint,
  type WritingAssistanceRecord,
  type WritingCommandInput,
  type WritingFocusRestore,
  type WritingStartInput,
  type WritingVariantMeta,
  type WritingVariantSummary,
  type WritingWorkspaceView,
} from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { LibraryError, createLibraryRepository } from "./library";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { openingNoteReadable } from "./opening-note-provenance";
import {
  parseAuthorizedWritingActivityCheckpoint,
  readAuthorizedWritingActivityForGroup,
  readAuthorizedWritingDocument,
} from "./opening-writing-read-target";

type Db = Sql | TransactionSql;

export type OpeningWritingErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "WORKSPACE_MISMATCH";

export class OpeningWritingError extends Error {
  readonly code: OpeningWritingErrorCode;

  constructor(code: OpeningWritingErrorCode, message: string) {
    super(message);
    this.name = "OpeningWritingError";
    this.code = code;
  }
}

export type WritingCommandResult = {
  workspace: WritingWorkspaceView;
  outcome?: CourselessActivityOutcome;
};

export type OpeningWritingWorkspaceRepository = {
  start(scope: Scope, rawInput: WritingStartInput): Promise<WritingWorkspaceView>;
  getView(
    scope: Scope,
    documentId: string,
    options?: { requestedFocusBlockId?: string | null; activityId?: string | null },
  ): Promise<WritingWorkspaceView | null>;
  command(
    scope: Scope,
    documentId: string,
    rawCommand: WritingCommandInput,
  ): Promise<WritingCommandResult>;
};

const BLOCK_MISSING_MESSAGE = "上次定位的段落已删除或合并，已打开当前服务器保存的内容。";

function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function assertValidScope(rawScope: Scope): Scope {
  const parsed = scopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    throw new OpeningWritingError("VALIDATION", "工作区或用户标识格式无效。");
  }
  return {
    workspaceId: parsed.data.workspaceId.toLowerCase(),
    ownerUserId: parsed.data.ownerUserId.toLowerCase(),
  };
}

function assertValidUuid(value: string, label: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new OpeningWritingError("VALIDATION", `${label}格式无效。`);
  }
  return parsed.data.toLowerCase();
}

function extractInlineText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractInlineText).join("");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if ("content" in obj) return extractInlineText(obj.content);
  }
  return "";
}

function extractBlockPlainText(content: unknown): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) return "";
  const record = content as Record<string, unknown>;
  if ("blockNoteContent" in record) {
    return extractInlineText(record.blockNoteContent).slice(0, 4000);
  }
  if (typeof record.text === "string") {
    return record.text.slice(0, 4000);
  }
  return extractInlineText(record).slice(0, 4000);
}

function cloneChildBlocks(children: unknown): unknown[] {
  if (!Array.isArray(children)) return [];
  return children.map((child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    const record = structuredClone(child) as Record<string, unknown>;
    if (typeof record.id === "string") record.id = randomUUID();
    if ("children" in record) record.children = cloneChildBlocks(record.children);
    return record;
  });
}

function cloneBlockContent(content: unknown): Record<string, unknown> {
  if (!content || typeof content !== "object" || Array.isArray(content)) return {};
  const cloned = structuredClone(content) as Record<string, unknown>;
  if ("children" in cloned) {
    cloned.children = cloneChildBlocks(cloned.children);
  }
  return cloned;
}

function replaceBlockText(content: unknown, replacementText: string): Record<string, unknown> {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    return {
      blockNoteContent: replacementText,
      props: record.props ?? null,
      children: Array.isArray(record.children) ? record.children : [],
    };
  }
  return {
    blockNoteContent: replacementText,
    props: null,
    children: [],
  };
}

function countAdoptedPolish(meta: WritingVariantMeta): number {
  return meta.assistanceRecords.filter((record) => record.adoptedAt !== null).length;
}

function mapLibraryError(error: unknown): never {
  if (error instanceof OpeningWritingError) throw error;
  if (error instanceof LibraryError) {
    if (error.code === "NOT_FOUND") {
      throw new OpeningWritingError("NOT_FOUND", error.message);
    }
    if (error.code === "CONFLICT" || error.code === "INVALID_LIFECYCLE_TRANSITION") {
      throw new OpeningWritingError("CONFLICT", error.message);
    }
    if (error.code === "WORKSPACE_MISMATCH" || error.code === "CROSS_WORKSPACE_REFERENCE") {
      throw new OpeningWritingError("WORKSPACE_MISMATCH", error.message);
    }
    throw new OpeningWritingError("VALIDATION", error.message);
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : "写作区操作失败。";
    if (code === "NOT_FOUND") throw new OpeningWritingError("NOT_FOUND", message);
    if (code === "CONFLICT") throw new OpeningWritingError("CONFLICT", message);
    if (code === "VALIDATION") throw new OpeningWritingError("VALIDATION", message);
  }
  throw error;
}

export function createOpeningWritingWorkspaceRepository(
  sql: Sql,
): OpeningWritingWorkspaceRepository {
  const library = createLibraryRepository(sql);

  async function lockWriteBoundary(tx: TransactionSql, scope: Scope): Promise<void> {
    try {
      await lockWorkspaceLearningHistory(tx, scope);
    } catch (error) {
      mapLibraryError(error);
    }
    const owners = await tx`
      SELECT id FROM workspaces
      WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      FOR SHARE
    `;
    if (!owners.length) {
      throw new OpeningWritingError("NOT_FOUND", "工作区不存在。");
    }
  }

  async function upsertWritingMeta(
    db: Db,
    workspaceId: string,
    documentId: string,
    meta: WritingVariantMeta,
  ): Promise<void> {
    const validated = writingVariantMetaSchema.parse(meta);
    await db`
      INSERT INTO library_properties (
        workspace_id, subject_type, subject_id, key, value_type, value
      ) VALUES (
        ${workspaceId},
        'document',
        ${documentId},
        ${WRITING_META_PROPERTY_KEY},
        'json',
        ${db.json(validated as never)}
      )
      ON CONFLICT (workspace_id, subject_type, subject_id, key)
      DO UPDATE SET
        value_type = 'json',
        value = EXCLUDED.value,
        updated_at = now()
    `;
  }

  async function resolveActivityForView(
    db: Db,
    scope: Scope,
    workGroupId: string,
    requestedActivityId?: string | null,
  ): Promise<{ id: string; courseId: string | null } | null> {
    const validActivityId =
      requestedActivityId !== undefined && requestedActivityId !== null
        ? assertValidUuid(requestedActivityId, "活动编号")
        : null;
    const resolved = await readAuthorizedWritingActivityForGroup(
      db,
      scope,
      workGroupId,
      validActivityId,
    );
    if (resolved.status === "not_found") {
      throw new OpeningWritingError("NOT_FOUND", "写作活动不存在。");
    }
    return resolved.activity;
  }

  async function resolveOwnedActivityForWrite(
    tx: TransactionSql,
    scope: Scope,
    workGroupId: string,
    requestedActivityId?: string,
  ): Promise<{
    id: string;
    courseId: string | null;
    checkpointJson: Record<string, unknown>;
  }> {
    if (requestedActivityId) {
      const rows = await tx`
        SELECT id, course_id, create_intent, checkpoint_json
        FROM opening_teaching_activities
        WHERE id = ${requestedActivityId}
          AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) {
        throw new OpeningWritingError("NOT_FOUND", "写作活动不存在。");
      }
      if (
        row.create_intent?.protocol !== WRITING_WORKSPACE_PROTOCOL
        || typeof row.create_intent?.workGroupId !== "string"
        || row.create_intent.workGroupId.toLowerCase() !== workGroupId.toLowerCase()
      ) {
        throw new OpeningWritingError("CONFLICT", "写作活动与当前文稿组不匹配。");
      }
      return {
        id: String(row.id).toLowerCase(),
        courseId: row.course_id == null ? null : String(row.course_id).toLowerCase(),
        checkpointJson:
          row.checkpoint_json && typeof row.checkpoint_json === "object"
            ? (row.checkpoint_json as Record<string, unknown>)
            : {},
      };
    }

    const rows = await tx`
      SELECT id, course_id, checkpoint_json
      FROM opening_teaching_activities
      WHERE workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
        AND create_intent->>'protocol' = ${WRITING_WORKSPACE_PROTOCOL}
        AND lower(create_intent->>'workGroupId') = lower(${workGroupId})
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `;
    if (!rows.length) {
      throw new OpeningWritingError("NOT_FOUND", "未找到关联的写作活动。");
    }
    return {
      id: String(rows[0]!.id).toLowerCase(),
      courseId: rows[0]!.course_id == null ? null : String(rows[0]!.course_id).toLowerCase(),
      checkpointJson:
        rows[0]!.checkpoint_json && typeof rows[0]!.checkpoint_json === "object"
          ? (rows[0]!.checkpoint_json as Record<string, unknown>)
          : {},
    };
  }

  async function buildView(
    db: Db,
    scope: Scope,
    documentId: string,
    currentMeta: WritingVariantMeta,
    options: { requestedFocusBlockId?: string | null; activityId?: string | null } = {},
  ): Promise<WritingWorkspaceView> {
    const canonicalDocumentId = documentId.toLowerCase();
    const activity = await resolveActivityForView(
      db,
      scope,
      currentMeta.workGroupId,
      options.activityId,
    );

    const groupRows = await db`
      SELECT d.id, d.title, d.current_revision_number, d.created_at, d.updated_at, p.value AS meta
      FROM library_documents d
      JOIN library_properties p
        ON p.workspace_id = d.workspace_id
       AND p.subject_type = 'document'
       AND p.subject_id = d.id
       AND p.key = ${WRITING_META_PROPERTY_KEY}
      JOIN workspaces w
        ON w.id = d.workspace_id
       AND w.owner_user_id = ${scope.ownerUserId}
      WHERE d.workspace_id = ${scope.workspaceId}
        AND d.deleted_at IS NULL
        AND ${openingNoteReadable(db, scope.workspaceId, db`d.id`)}
        AND lower(p.value->>'workGroupId') = lower(${currentMeta.workGroupId})
      ORDER BY d.created_at ASC, d.id ASC
    `;

    let snapshotCurrentMeta: WritingVariantMeta | null = null;
    const variants: WritingVariantSummary[] = [];
    for (const row of groupRows) {
      const rowId = String(row.id).toLowerCase();
      const parsedMeta = writingVariantMetaSchema.safeParse(row.meta);
      if (!parsedMeta.success) {
        if (rowId === canonicalDocumentId) {
          throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
        }
        continue;
      }
      const meta: WritingVariantMeta = {
        ...parsedMeta.data,
        workGroupId: parsedMeta.data.workGroupId.toLowerCase(),
        parentDocumentId: parsedMeta.data.parentDocumentId == null
          ? null
          : parsedMeta.data.parentDocumentId.toLowerCase(),
      };
      if (rowId === canonicalDocumentId) {
        snapshotCurrentMeta = meta;
      }
      variants.push({
        documentId: rowId,
        title: String(row.title),
        variantLabel: meta.variantLabel,
        currentRevisionNumber: Number(row.current_revision_number),
        parentDocumentId: meta.parentDocumentId,
        parentRevisionNumber: meta.parentRevisionNumber,
        keptAsPreferred: meta.keptAsPreferred,
        focusBlockId: meta.focusBlockId,
        assistanceCount: meta.assistanceRecords.length,
        adoptedPolishCount: countAdoptedPolish(meta),
        updatedAt: toIso(row.updated_at),
      });
    }

    if (!snapshotCurrentMeta) {
      throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
    }
    const preferredCount = variants.filter((variant) => variant.keptAsPreferred).length;
    const normalizedVariants: WritingVariantSummary[] = preferredCount > 1
      ? variants.map((variant) => ({ ...variant, keptAsPreferred: false }))
      : variants;
    const resolvedCurrentMeta: WritingVariantMeta = preferredCount > 1
      ? { ...snapshotCurrentMeta, keptAsPreferred: false }
      : snapshotCurrentMeta;

    const rawRequested = options.requestedFocusBlockId?.trim() || null;
    const requested = rawRequested && uuidSchema.safeParse(rawRequested).success
      ? rawRequested.toLowerCase()
      : rawRequested;
    const candidateFocus = requested ?? resolvedCurrentMeta.focusBlockId;
    let focusRestore: WritingFocusRestore;
    if (candidateFocus == null) {
      focusRestore = { status: "none" };
    } else {
      const matchingBlocks = await db`
        SELECT id FROM library_blocks
        WHERE workspace_id = ${scope.workspaceId}
          AND document_id = ${canonicalDocumentId}
          AND id::text = lower(${candidateFocus})
        LIMIT 1
      `;
      focusRestore = matchingBlocks.length
        ? {
            status: "exact",
            blockId: String(matchingBlocks[0]!.id).toLowerCase(),
          }
        : {
            status: "block_missing",
            requestedBlockId: candidateFocus,
            message: BLOCK_MISSING_MESSAGE,
          };
    }

    return writingWorkspaceViewSchema.parse({
      workGroupId: resolvedCurrentMeta.workGroupId.toLowerCase(),
      activityId: activity?.id ?? null,
      courseId: activity?.courseId ?? null,
      currentDocumentId: canonicalDocumentId,
      currentVariant: resolvedCurrentMeta,
      variants: normalizedVariants,
      focusRestore: writingFocusRestoreSchema.parse(focusRestore),
    });
  }

  async function updateCheckpointInTx(
    tx: TransactionSql,
    scope: Scope,
    activityId: string,
    checkpoint: WritingActivityCheckpoint,
  ): Promise<void> {
    const validated = writingActivityCheckpointSchema.parse(checkpoint);
    await tx`
      UPDATE opening_teaching_activities
      SET checkpoint_json = jsonb_set(
            COALESCE(checkpoint_json, '{}'::jsonb),
            '{writingWorkspace}',
            ${tx.json(validated as never)}::jsonb,
            true
          ),
          updated_at = now()
      WHERE id = ${activityId}
        AND workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
    `;
  }

  async function ensureBootstrapWorkgroupActivity(
    tx: TransactionSql,
    scope: Scope,
    doc: Record<string, unknown>,
    focusBlockId: string | null,
    nowIso: string,
  ): Promise<void> {
    const documentId = String(doc.id).toLowerCase();
    const clientKey = `writing-workgroup:${documentId}`;
    const existing = await tx`
      SELECT id, create_intent
      FROM opening_teaching_activities
      WHERE workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
        AND client_key = ${clientKey}
      FOR UPDATE
    `;
    if (existing.length) {
      if (
        existing[0]!.create_intent?.protocol !== WRITING_WORKSPACE_PROTOCOL
        || typeof existing[0]!.create_intent?.workGroupId !== "string"
        || existing[0]!.create_intent.workGroupId.toLowerCase() !== documentId
      ) {
        throw new OpeningWritingError("CONFLICT", "写作活动标识冲突。");
      }
      return;
    }

    const summary = String(doc.title ?? "").trim().slice(0, 2000) || "写作草稿";
    const createIntent = {
      protocol: WRITING_WORKSPACE_PROTOCOL,
      workGroupId: documentId,
    };
    const checkpoint: WritingActivityCheckpoint = {
      protocol: WRITING_WORKSPACE_PROTOCOL,
      workGroupId: documentId,
      activeDocumentId: documentId,
      activeVariantLabel: "初稿",
      savedRevisionNumber: Number(doc.current_revision_number),
      focusBlockId,
      updatedAt: nowIso,
    };

    await tx`
      INSERT INTO opening_teaching_activities (
        id, workspace_id, owner_user_id, course_id, status, generate_status,
        intent_kind, intent_summary, source_ids, goal_json, path_version, content_version,
        checkpoint_json, client_key, create_intent
      ) VALUES (
        ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${null},
        'active', 'ready', 'topic', ${summary}, ${[] as string[]}, ${tx.json({})},
        1, 0, ${tx.json({ writingWorkspace: checkpoint } as never)}, ${clientKey},
        ${tx.json(createIntent as never)}
      )
      ON CONFLICT (workspace_id, owner_user_id, client_key) DO NOTHING
    `;
  }

  return {
    async start(rawScope, rawInput) {
      const scope = assertValidScope(rawScope);
      const parsedInput = writingStartInputSchema.safeParse(rawInput);
      if (!parsedInput.success) {
        throw new OpeningWritingError("VALIDATION", "创建写作工作区参数格式不正确。");
      }
      const input = parsedInput.data;
      const variantLabel = input.variantLabel ?? "初稿";
      const initialText = input.initialText ?? "";
      const requestedCourseId = input.courseId == null ? null : input.courseId.toLowerCase();

      return sql.begin(async (tx) => {
        await lockWriteBoundary(tx, scope);

        const existingRows = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND client_key = ${input.clientKey}
          FOR UPDATE
        `;
        if (existingRows.length) {
          const existing = existingRows[0]!;
          const parsedExisting = parseAuthorizedWritingActivityCheckpoint(existing);
          if (parsedExisting.kind === "not_writing") {
            throw new OpeningWritingError("CONFLICT", "请求标识已被其他活动占用。");
          }
          if (parsedExisting.kind !== "writing") {
            throw new OpeningWritingError("NOT_FOUND", "写作目标不存在或不可用。");
          }

          const { workGroupId, checkpoint } = parsedExisting;
          const targetDocumentId = checkpoint.activeDocumentId;
          const docReads = new Map<string, Awaited<ReturnType<typeof readAuthorizedWritingDocument>>>();
          for (const docIdToRead of [...new Set([workGroupId, targetDocumentId])].sort()) {
            docReads.set(
              docIdToRead,
              await readAuthorizedWritingDocument(tx, scope, {
                documentId: docIdToRead,
                expectedWorkGroupId: workGroupId,
                forShare: true,
              }),
            );
          }
          const rootRead = docReads.get(workGroupId)!;
          const targetRead = docReads.get(targetDocumentId)!;
          if (rootRead.status !== "authorized" || targetRead.status !== "authorized") {
            throw new OpeningWritingError("NOT_FOUND", "写作目标不存在或不可用。");
          }

          const existingCourseId = existing.course_id == null ? null : String(existing.course_id).toLowerCase();
          if (existingCourseId !== requestedCourseId) {
            throw new OpeningWritingError("CONFLICT", "同一请求标识对应的写作参数不一致。");
          }
          const [rev1] = await tx`
            SELECT title, blocks FROM library_revisions
            WHERE workspace_id = ${scope.workspaceId}
              AND document_id = ${workGroupId}
              AND revision_number = 1
            LIMIT 1
          `;
          const rev1Blocks = Array.isArray(rev1?.blocks) ? rev1.blocks : [];
          const rev1InitialText = rev1Blocks[0]
            ? extractBlockPlainText((rev1Blocks[0] as { content?: unknown }).content)
            : "";
          if (
            !rev1
            || String(rev1.title) !== input.title
            || rev1InitialText !== initialText
            || rootRead.meta.variantLabel !== variantLabel
          ) {
            throw new OpeningWritingError("CONFLICT", "同一请求标识对应的写作参数不一致。");
          }

          return buildView(tx, scope, targetRead.documentId, targetRead.meta, {
            activityId: String(existing.id).toLowerCase(),
          });
        }

        if (requestedCourseId) {
          const courseRows = await tx`
            SELECT id FROM courses
            WHERE id = ${requestedCourseId}
              AND workspace_id = ${scope.workspaceId}
              AND archived_at IS NULL
            FOR SHARE
          `;
          if (!courseRows.length) {
            throw new OpeningWritingError("NOT_FOUND", "课程不存在或已归档。");
          }
        }

        const docId = randomUUID();
        const initialBlockId = randomUUID();
        const activityId = randomUUID();
        const [timeRow] = await tx`SELECT now() AS now_ts`;
        const nowIso = toIso(timeRow?.now_ts ?? new Date());
        const initialBlockContent = {
          blockNoteContent: initialText,
          props: null,
          children: [],
        };
        const blocksSnapshot = [
          {
            id: initialBlockId,
            type: "paragraph",
            position: 0,
            content: initialBlockContent,
          },
        ];

        await tx`
          INSERT INTO library_documents (
            id, workspace_id, title, lifecycle, schema_version, current_revision_number
          ) VALUES (
            ${docId}, ${scope.workspaceId}, ${input.title}, 'scratch', 1, 1
          )
        `;
        await tx`
          INSERT INTO library_blocks (
            id, workspace_id, document_id, type, position, content
          ) VALUES (
            ${initialBlockId}, ${scope.workspaceId}, ${docId}, 'paragraph', 0,
            ${tx.json(initialBlockContent as never)}
          )
        `;
        await tx`
          INSERT INTO library_revisions (
            id, workspace_id, document_id, revision_number, parent_revision_number,
            title, lifecycle, reason, blocks
          ) VALUES (
            ${randomUUID()}, ${scope.workspaceId}, ${docId}, 1, ${null},
            ${input.title}, 'scratch', 'create', ${tx.json(blocksSnapshot as never)}
          )
        `;

        const meta: WritingVariantMeta = {
          workGroupId: docId,
          variantLabel,
          parentDocumentId: null,
          parentRevisionNumber: null,
          keptAsPreferred: false,
          focusBlockId: initialBlockId,
          assistanceRecords: [],
        };
        await upsertWritingMeta(tx, scope.workspaceId, docId, meta);

        const checkpoint: WritingActivityCheckpoint = {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId: docId,
          activeDocumentId: docId,
          activeVariantLabel: variantLabel,
          savedRevisionNumber: 1,
          focusBlockId: initialBlockId,
          updatedAt: nowIso,
        };
        const createIntent = {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId: docId,
        };
        await tx`
          INSERT INTO opening_teaching_activities (
            id, workspace_id, owner_user_id, course_id, status, generate_status,
            intent_kind, intent_summary, source_ids, goal_json, path_version, content_version,
            checkpoint_json, client_key, create_intent
          ) VALUES (
            ${activityId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${requestedCourseId},
            'active', 'ready', 'topic', ${input.title}, ${[] as string[]}, ${tx.json({})},
            1, 0, ${tx.json({ writingWorkspace: checkpoint } as never)},
            ${input.clientKey}, ${tx.json(createIntent as never)}
          )
        `;

        return buildView(tx, scope, docId, meta, { activityId });
      });
    },

    async getView(rawScope, rawDocumentId, options = {}) {
      const scope = assertValidScope(rawScope);
      const documentId = assertValidUuid(rawDocumentId, "笔记编号");
      const hasExplicitActivity =
        options.activityId !== undefined && options.activityId !== null;
      const validActivityId = hasExplicitActivity
        ? assertValidUuid(options.activityId!, "活动编号")
        : null;

      const docRead = await readAuthorizedWritingDocument(sql, scope, {
        documentId,
      });
      if (docRead.status === "not_found") {
        throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
      }
      if (docRead.status === "uninitialized") {
        if (hasExplicitActivity) {
          throw new OpeningWritingError("NOT_FOUND", "写作活动不存在。");
        }
        return null;
      }

      return buildView(sql, scope, docRead.documentId, docRead.meta, {
        requestedFocusBlockId: options.requestedFocusBlockId,
        activityId: validActivityId,
      });
    },

    async command(rawScope, rawDocumentId, rawCommand) {
      const scope = assertValidScope(rawScope);
      const documentId = assertValidUuid(rawDocumentId, "笔记编号");
      const parsedCommand = writingCommandInputSchema.safeParse(rawCommand);
      if (!parsedCommand.success) {
        throw new OpeningWritingError("VALIDATION", "写作区指令格式不正确。");
      }
      const cmd = parsedCommand.data;

      return sql.begin(async (tx) => {
        await lockWriteBoundary(tx, scope);

        const docRows = await tx`
          SELECT * FROM library_documents
          WHERE id = ${documentId}
            AND workspace_id = ${scope.workspaceId}
            AND deleted_at IS NULL
            AND ${openingNoteReadable(tx, scope.workspaceId, tx`library_documents.id`)}
          FOR UPDATE
        `;
        if (!docRows.length) {
          throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
        }
        const doc = docRows[0]!;
        const currentRevision = Number(doc.current_revision_number);

        const preferredIntent =
          cmd.action === "set_preferred_variant"
            ? { keptAsPreferred: cmd.keptAsPreferred, activityId: cmd.activityId }
            : cmd.action === "save_checkpoint" && typeof cmd.keptAsPreferred === "boolean"
              ? { keptAsPreferred: cmd.keptAsPreferred, activityId: cmd.activityId }
              : null;

        if (preferredIntent !== null) {
          const targetPropRows = preferredIntent.keptAsPreferred
            ? await tx`
                SELECT value FROM library_properties
                WHERE workspace_id = ${scope.workspaceId}
                  AND subject_type = 'document'
                  AND subject_id = ${documentId}
                  AND key = ${WRITING_META_PROPERTY_KEY}
              `
            : await tx`
                SELECT value FROM library_properties
                WHERE workspace_id = ${scope.workspaceId}
                  AND subject_type = 'document'
                  AND subject_id = ${documentId}
                  AND key = ${WRITING_META_PROPERTY_KEY}
                FOR UPDATE
              `;
          if (!targetPropRows.length) {
            throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
          }
          const parsedTargetMeta = writingVariantMetaSchema.safeParse(targetPropRows[0]!.value);
          if (!parsedTargetMeta.success) {
            throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
          }
          const targetWorkGroupId = parsedTargetMeta.data.workGroupId.toLowerCase();

          if (preferredIntent.activityId !== undefined) {
            await resolveActivityForView(
              tx,
              scope,
              targetWorkGroupId,
              preferredIntent.activityId,
            );
          }

          let updatedMeta: WritingVariantMeta;
          if (preferredIntent.keptAsPreferred) {
            const groupPropRows = await tx`
              SELECT d.id, p.value AS meta
              FROM library_documents d
              JOIN library_properties p
                ON p.workspace_id = d.workspace_id
               AND p.subject_type = 'document'
               AND p.subject_id = d.id
               AND p.key = ${WRITING_META_PROPERTY_KEY}
              JOIN workspaces w
                ON w.id = d.workspace_id
               AND w.owner_user_id = ${scope.ownerUserId}
              WHERE d.workspace_id = ${scope.workspaceId}
                AND d.deleted_at IS NULL
                AND ${openingNoteReadable(tx, scope.workspaceId, tx`d.id`)}
                AND lower(p.value->>'workGroupId') = lower(${targetWorkGroupId})
              ORDER BY d.id ASC
              FOR UPDATE OF p
            `;

            let lockedCurrentMeta: WritingVariantMeta | null = null;
            for (const row of groupPropRows) {
              const rowId = String(row.id).toLowerCase();
              const parsedRowMeta = writingVariantMetaSchema.safeParse(row.meta);
              if (!parsedRowMeta.success) {
                if (rowId === documentId) {
                  throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
                }
                continue;
              }
              if (rowId === documentId) {
                lockedCurrentMeta = parsedRowMeta.data;
              } else if (parsedRowMeta.data.keptAsPreferred) {
                await upsertWritingMeta(tx, scope.workspaceId, rowId, {
                  ...parsedRowMeta.data,
                  keptAsPreferred: false,
                });
              }
            }
            if (!lockedCurrentMeta) {
              throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
            }
            updatedMeta = {
              ...lockedCurrentMeta,
              keptAsPreferred: true,
            };
            if (!lockedCurrentMeta.keptAsPreferred) {
              await upsertWritingMeta(tx, scope.workspaceId, documentId, updatedMeta);
            }
          } else {
            updatedMeta = {
              ...parsedTargetMeta.data,
              keptAsPreferred: false,
            };
            if (parsedTargetMeta.data.keptAsPreferred) {
              await upsertWritingMeta(tx, scope.workspaceId, documentId, updatedMeta);
            }
          }

          return {
            workspace: await buildView(tx, scope, documentId, updatedMeta, {
              activityId: preferredIntent.activityId,
            }),
          };
        }

        const [timeRow] = await tx`SELECT now() AS now_ts`;
        const nowIso = toIso(timeRow?.now_ts ?? new Date());

        const blockRows = await tx`
          SELECT id, type, position, content
          FROM library_blocks
          WHERE workspace_id = ${scope.workspaceId}
            AND document_id = ${documentId}
          ORDER BY position ASC
        `;

        const propRows = await tx`
          SELECT value FROM library_properties
          WHERE workspace_id = ${scope.workspaceId}
            AND subject_type = 'document'
            AND subject_id = ${documentId}
            AND key = ${WRITING_META_PROPERTY_KEY}
          FOR UPDATE
        `;

        let currentMeta: WritingVariantMeta;
        if (!propRows.length) {
          const initialFocusBlockId = blockRows[0]?.id ? String(blockRows[0].id) : null;
          currentMeta = {
            workGroupId: documentId,
            variantLabel: "初稿",
            parentDocumentId: null,
            parentRevisionNumber: null,
            keptAsPreferred: false,
            focusBlockId: initialFocusBlockId,
            assistanceRecords: [],
          };
          await upsertWritingMeta(tx, scope.workspaceId, documentId, currentMeta);
          await ensureBootstrapWorkgroupActivity(tx, scope, doc, initialFocusBlockId, nowIso);
        } else {
          const parsedMeta = writingVariantMetaSchema.safeParse(propRows[0]!.value);
          if (!parsedMeta.success) {
            throw new OpeningWritingError("NOT_FOUND", "笔记不存在或不可用。");
          }
          currentMeta = parsedMeta.data;
        }

        if (cmd.action === "derive_variant") {
          if (currentRevision !== cmd.expectedRevisionNumber) {
            throw new OpeningWritingError("CONFLICT", "笔记版本已变化，请刷新后再创建分支稿。");
          }
          const activity = await resolveOwnedActivityForWrite(
            tx,
            scope,
            currentMeta.workGroupId,
            cmd.activityId,
          );
          if (
            cmd.focusBlockId != null
            && !blockRows.some((block) => String(block.id) === cmd.focusBlockId)
          ) {
            throw new OpeningWritingError("NOT_FOUND", "指定的定位段落不存在。");
          }

          const idMap = new Map<string, string>();
          const clonedBlocks = blockRows.map((block, index) => {
            const oldId = String(block.id);
            const newBlockId = randomUUID();
            idMap.set(oldId, newBlockId);
            return {
              id: newBlockId,
              type: String(block.type),
              position: Number.isInteger(block.position) ? Number(block.position) : index,
              content: cloneBlockContent(block.content),
            };
          });

          const sourceFocusId = cmd.focusBlockId !== undefined
            ? cmd.focusBlockId
            : currentMeta.focusBlockId;
          const newFocusBlockId = sourceFocusId != null ? (idMap.get(sourceFocusId) ?? null) : null;

          const newDocId = randomUUID();
          await tx`
            INSERT INTO library_documents (
              id, workspace_id, title, lifecycle, schema_version, current_revision_number
            ) VALUES (
              ${newDocId}, ${scope.workspaceId}, ${String(doc.title)}, 'scratch', 1, 1
            )
          `;
          for (const block of clonedBlocks) {
            await tx`
              INSERT INTO library_blocks (
                id, workspace_id, document_id, type, position, content
              ) VALUES (
                ${block.id}, ${scope.workspaceId}, ${newDocId}, ${block.type}, ${block.position},
                ${tx.json(block.content as never)}
              )
            `;
          }
          await tx`
            INSERT INTO library_revisions (
              id, workspace_id, document_id, revision_number, parent_revision_number,
              title, lifecycle, reason, blocks
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${newDocId}, 1, ${null},
              ${String(doc.title)}, 'scratch', 'derived-variant', ${tx.json(clonedBlocks as never)}
            )
          `;
          await tx`
            INSERT INTO library_relations (
              workspace_id, from_type, from_id, to_type, to_id, relation_type, source
            ) VALUES (
              ${scope.workspaceId}, 'document', ${newDocId}, 'document', ${documentId},
              'derived_from', 'manual'
            )
            ON CONFLICT (workspace_id, from_type, from_id, to_type, to_id, relation_type) DO NOTHING
          `;

          const derivedMeta: WritingVariantMeta = {
            workGroupId: currentMeta.workGroupId,
            variantLabel: cmd.variantLabel,
            parentDocumentId: documentId,
            parentRevisionNumber: cmd.expectedRevisionNumber,
            keptAsPreferred: false,
            focusBlockId: newFocusBlockId,
            assistanceRecords: [],
          };
          await upsertWritingMeta(tx, scope.workspaceId, newDocId, derivedMeta);

          await updateCheckpointInTx(tx, scope, activity.id, {
            protocol: WRITING_WORKSPACE_PROTOCOL,
            workGroupId: currentMeta.workGroupId,
            activeDocumentId: newDocId,
            activeVariantLabel: cmd.variantLabel,
            savedRevisionNumber: 1,
            focusBlockId: newFocusBlockId,
            updatedAt: nowIso,
          });

          return {
            workspace: await buildView(tx, scope, newDocId, derivedMeta, {
              activityId: activity.id,
            }),
          };
        }

        if (cmd.action === "record_feedback") {
          if (currentRevision !== cmd.expectedRevisionNumber) {
            throw new OpeningWritingError("CONFLICT", "笔记版本已变化，请刷新后再记录写作反馈。");
          }
          let targetBlockTextSnapshot = "";
          if (cmd.targetBlockId !== null) {
            const targetBlock = blockRows.find((block) => String(block.id) === cmd.targetBlockId);
            if (!targetBlock) {
              throw new OpeningWritingError("NOT_FOUND", "目标段落不存在或已删除。");
            }
            targetBlockTextSnapshot = extractBlockPlainText(targetBlock.content);
          }
          if (currentMeta.assistanceRecords.length >= 100) {
            throw new OpeningWritingError("CONFLICT", "单稿写作辅助记录已达到上限，请派生新稿后再试。");
          }

          const record: WritingAssistanceRecord = {
            id: randomUUID(),
            documentId,
            baseRevisionNumber: cmd.expectedRevisionNumber,
            targetBlockId: cmd.targetBlockId,
            targetBlockTextSnapshot,
            dimension: cmd.dimension,
            kind: cmd.kind,
            suggestionText: cmd.suggestionText,
            adoptedAt: null,
            adoptedRevisionNumber: null,
            createdAt: nowIso,
          };
          const updatedMeta: WritingVariantMeta = {
            ...currentMeta,
            assistanceRecords: [...currentMeta.assistanceRecords, record],
          };
          await upsertWritingMeta(tx, scope.workspaceId, documentId, updatedMeta);

          return {
            workspace: await buildView(tx, scope, documentId, updatedMeta),
          };
        }

        if (cmd.action === "adopt_suggestion") {
          if (currentRevision !== cmd.expectedRevisionNumber) {
            throw new OpeningWritingError("CONFLICT", "笔记版本已变化，请刷新后再采纳润色建议。");
          }
          if (cmd.expectedRevisionNumber <= 0) {
            throw new OpeningWritingError("VALIDATION", "文档尚无有效版本，请先保存一次后再采纳润色。");
          }
          const activity = await resolveOwnedActivityForWrite(
            tx,
            scope,
            currentMeta.workGroupId,
            cmd.activityId,
          );
          const recordIndex = currentMeta.assistanceRecords.findIndex(
            (record) => record.id.toLowerCase() === cmd.assistanceId.toLowerCase(),
          );
          if (recordIndex === -1) {
            throw new OpeningWritingError("NOT_FOUND", "未找到对应的写作辅助记录。");
          }
          const targetRecord = currentMeta.assistanceRecords[recordIndex]!;
          if (targetRecord.adoptedAt !== null) {
            throw new OpeningWritingError("CONFLICT", "该条润色建议已被采纳。");
          }
          if (targetRecord.targetBlockId !== cmd.targetBlockId) {
            throw new OpeningWritingError("CONFLICT", "目标段落与原辅助建议不一致。");
          }

          const targetBlockIndex = blockRows.findIndex(
            (block) => String(block.id) === cmd.targetBlockId,
          );
          if (targetBlockIndex === -1) {
            throw new OpeningWritingError("NOT_FOUND", "目标段落不存在或已删除，无法采纳润色。");
          }

          const updatedBlocks = blockRows.map((block, index) => ({
            id: String(block.id),
            type: String(block.type),
            content: index === targetBlockIndex
              ? replaceBlockText(block.content, cmd.replacementText)
              : ((block.content ?? {}) as Record<string, unknown>),
          }));

          try {
            await library.updateDocumentInTx(tx, {
              workspaceId: scope.workspaceId,
              documentId,
              expectedRevisionNumber: cmd.expectedRevisionNumber,
              title: String(doc.title),
              lifecycle: doc.lifecycle as AssetLifecycle,
              blocks: updatedBlocks,
              reason: "writing-adopt-polish",
            });
          } catch (error) {
            mapLibraryError(error);
          }

          const nextRevisionNumber = cmd.expectedRevisionNumber + 1;
          const nextRecords = currentMeta.assistanceRecords.map((record, index) =>
            index === recordIndex
              ? {
                  ...record,
                  adoptedAt: nowIso,
                  adoptedRevisionNumber: nextRevisionNumber,
                }
              : record,
          );
          const updatedMeta: WritingVariantMeta = {
            ...currentMeta,
            assistanceRecords: nextRecords,
          };
          await upsertWritingMeta(tx, scope.workspaceId, documentId, updatedMeta);

          const existingCheckpoint = writingActivityCheckpointSchema.safeParse(
            activity.checkpointJson.writingWorkspace,
          );
          if (
            existingCheckpoint.success
            && existingCheckpoint.data.activeDocumentId.toLowerCase() === documentId.toLowerCase()
          ) {
            await updateCheckpointInTx(tx, scope, activity.id, {
              ...existingCheckpoint.data,
              savedRevisionNumber: nextRevisionNumber,
              updatedAt: nowIso,
            });
          }

          const workspace = await buildView(tx, scope, documentId, updatedMeta, {
            activityId: activity.id,
          });
          const outcome = courselessActivityOutcomeSchema.parse({
            activityId: activity.id,
            courseId: activity.courseId,
            documentId,
            revisionNumber: nextRevisionNumber,
            assistance: "revealed",
            adoptedPolishCount: countAdoptedPolish(updatedMeta),
            keptAsPreferred: workspace.currentVariant.keptAsPreferred,
            evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
          });

          return { workspace, outcome };
        }

        if (cmd.action !== "save_checkpoint") {
          throw new OpeningWritingError("VALIDATION", "写作区指令格式不正确。");
        }

        // save_checkpoint (focus + activity resume breakpoint only; preferred flag untouched)
        if (
          cmd.focusBlockId !== null
          && !blockRows.some((block) => String(block.id) === cmd.focusBlockId)
        ) {
          throw new OpeningWritingError("NOT_FOUND", "指定的定位段落不存在。");
        }
        const activity = await resolveOwnedActivityForWrite(
          tx,
          scope,
          currentMeta.workGroupId,
          cmd.activityId,
        );

        const updatedMeta: WritingVariantMeta = {
          ...currentMeta,
          focusBlockId: cmd.focusBlockId,
        };
        await upsertWritingMeta(tx, scope.workspaceId, documentId, updatedMeta);

        await updateCheckpointInTx(tx, scope, activity.id, {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId: currentMeta.workGroupId,
          activeDocumentId: documentId,
          activeVariantLabel: updatedMeta.variantLabel,
          savedRevisionNumber: currentRevision,
          focusBlockId: cmd.focusBlockId,
          updatedAt: nowIso,
        });

        return {
          workspace: await buildView(tx, scope, documentId, updatedMeta, {
            activityId: activity.id,
          }),
        };
      });
    },
  };
}
