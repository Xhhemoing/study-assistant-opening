import {
  WRITING_META_PROPERTY_KEY,
  WRITING_WORKSPACE_PROTOCOL,
  uuidSchema,
  writingActivityCheckpointSchema,
  writingVariantMetaSchema,
  type Scope,
  type WritingActivityCheckpoint,
  type WritingVariantMeta,
} from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { noteContextSourceRefs } from "./opening-context-provenance";
import { openingNoteReadable } from "./opening-note-provenance";

type Db = Sql | TransactionSql;

export type ParsedWritingActivityRow =
  | { kind: "not_writing" }
  | { kind: "invalid_writing" }
  | {
      kind: "writing";
      workGroupId: string;
      checkpoint: WritingActivityCheckpoint;
    };

export type AuthorizedWritingDocumentRead =
  | { status: "not_found" }
  | { status: "uninitialized"; documentId: string }
  | {
      status: "authorized";
      documentId: string;
      title: string;
      currentRevisionNumber: number;
      meta: WritingVariantMeta;
      focusStatus: "exact" | "block_missing" | "none";
    };

export type AuthorizedWritingGroupActivityRead =
  | { status: "not_found" }
  | {
      status: "found";
      activity: { id: string; courseId: string | null } | null;
    };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeUuid(value: string): string {
  return value.toLowerCase();
}

/**
 * Parse and cross-validate `create_intent` and `checkpoint_json.writingWorkspace`
 * for an activity row. Writing identity is determined strictly by persisted
 * protocol (`writing-workspace-v1`) or persisted `checkpoint_json.writingWorkspace`
 * — never by optional client-supplied `client_key` prefixes.
 */
export function parseAuthorizedWritingActivityCheckpoint(row: {
  create_intent?: unknown;
  checkpoint_json?: unknown;
}): ParsedWritingActivityRow {
  const intent = asObject(row.create_intent);
  const checkpointRoot = asObject(row.checkpoint_json);
  const hasWritingMarker =
    intent?.protocol === WRITING_WORKSPACE_PROTOCOL
    || Boolean(checkpointRoot && "writingWorkspace" in checkpointRoot);

  if (!hasWritingMarker) {
    return { kind: "not_writing" };
  }

  if (intent?.protocol !== WRITING_WORKSPACE_PROTOCOL) {
    return { kind: "invalid_writing" };
  }

  const parsedGroup = uuidSchema.safeParse(intent.workGroupId);
  const parsedCheckpoint = writingActivityCheckpointSchema.safeParse(
    checkpointRoot?.writingWorkspace,
  );
  if (
    !parsedGroup.success
    || !parsedCheckpoint.success
    || normalizeUuid(parsedCheckpoint.data.workGroupId) !== normalizeUuid(parsedGroup.data)
  ) {
    return { kind: "invalid_writing" };
  }

  const workGroupId = normalizeUuid(parsedGroup.data);
  return {
    kind: "writing",
    workGroupId,
    checkpoint: {
      ...parsedCheckpoint.data,
      workGroupId,
      activeDocumentId: normalizeUuid(parsedCheckpoint.data.activeDocumentId),
    },
  };
}

/**
 * Single-statement SQL predicate verifying that if an `opening_teaching_activities`
 * row carries a writing protocol or `writingWorkspace` checkpoint marker, its
 * checkpoint structure and target document metadata are well-formed, owned,
 * in-workspace, non-deleted, `openingNoteReadable`, and bound to the same workGroup.
 *
 * Note: provenance source readability uses `LEFT JOIN opening_sources` rather than
 * nesting `openingNoteReadable(...)` so unit-test SQL mocks on `assertOwnedActivity`
 * that forbid `FROM` queries against `opening_sources` remain compatible.
 */
export function openingWritingActivityReadableSql(
  db: Db,
  scope: Scope,
  activityAlias: () => ReturnType<Db>,
) {
  return db`(
    (
      ${activityAlias()}.create_intent->>'protocol' IS DISTINCT FROM ${WRITING_WORKSPACE_PROTOCOL}
      AND NOT (
        CASE
          WHEN jsonb_typeof(COALESCE(${activityAlias()}.checkpoint_json, '{}'::jsonb)) = 'object'
            THEN (COALESCE(${activityAlias()}.checkpoint_json, '{}'::jsonb) ? 'writingWorkspace')
          ELSE false
        END
      )
    )
    OR (
      ${activityAlias()}.workspace_id = ${scope.workspaceId}
      AND ${activityAlias()}.owner_user_id = ${scope.ownerUserId}
      AND jsonb_typeof(${activityAlias()}.create_intent) = 'object'
      AND ${activityAlias()}.create_intent->>'protocol' = ${WRITING_WORKSPACE_PROTOCOL}
      AND ${activityAlias()}.create_intent->>'workGroupId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND jsonb_typeof(${activityAlias()}.checkpoint_json) = 'object'
      AND jsonb_typeof(${activityAlias()}.checkpoint_json->'writingWorkspace') = 'object'
      AND ${activityAlias()}.checkpoint_json->'writingWorkspace'->>'protocol' = ${WRITING_WORKSPACE_PROTOCOL}
      AND lower(${activityAlias()}.checkpoint_json->'writingWorkspace'->>'workGroupId') = lower(${activityAlias()}.create_intent->>'workGroupId')
      AND ${activityAlias()}.checkpoint_json->'writingWorkspace'->>'activeDocumentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND jsonb_typeof(${activityAlias()}.checkpoint_json->'writingWorkspace'->'activeVariantLabel') = 'string'
      AND char_length(btrim(${activityAlias()}.checkpoint_json->'writingWorkspace'->>'activeVariantLabel')) BETWEEN 1 AND 80
      AND jsonb_typeof(${activityAlias()}.checkpoint_json->'writingWorkspace'->'savedRevisionNumber') = 'number'
      AND (${activityAlias()}.checkpoint_json->'writingWorkspace'->>'savedRevisionNumber') ~ '^(0|[1-9][0-9]*)(\\.0+)?$'
      AND (${activityAlias()}.checkpoint_json->'writingWorkspace' ? 'focusBlockId')
      AND (
        jsonb_typeof(${activityAlias()}.checkpoint_json->'writingWorkspace'->'focusBlockId') = 'null'
        OR (
          jsonb_typeof(${activityAlias()}.checkpoint_json->'writingWorkspace'->'focusBlockId') = 'string'
          AND char_length(${activityAlias()}.checkpoint_json->'writingWorkspace'->>'focusBlockId') BETWEEN 1 AND 120
        )
      )
      AND jsonb_typeof(${activityAlias()}.checkpoint_json->'writingWorkspace'->'updatedAt') = 'string'
      AND EXISTS (
        SELECT 1
        FROM library_documents wd
        JOIN workspaces ww
          ON ww.id = wd.workspace_id
         AND ww.owner_user_id = ${scope.ownerUserId}
        JOIN library_properties wp
          ON wp.workspace_id = wd.workspace_id
         AND wp.subject_type = 'document'
         AND wp.subject_id = wd.id
         AND wp.key = ${WRITING_META_PROPERTY_KEY}
        WHERE wd.workspace_id = ${scope.workspaceId}
          AND wd.id::text = lower(${activityAlias()}.checkpoint_json->'writingWorkspace'->>'activeDocumentId')
          AND wd.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM opening_note_provenance np
            WHERE np.workspace_id = wd.workspace_id
              AND np.document_id = wd.id
              AND (
                np.context_source_refs IS NULL
                OR jsonb_typeof(np.context_source_refs) IS DISTINCT FROM 'array'
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    CASE
                      WHEN jsonb_typeof(np.context_source_refs) = 'array' THEN ${noteContextSourceRefs(db, () => db`np.context_source_refs`)}
                      ELSE '[]'::jsonb
                    END
                  ) ref
                  LEFT JOIN opening_sources s
                    ON s.workspace_id = np.workspace_id
                   AND s.id::text = lower(ref->>'sourceId')
                  LEFT JOIN opening_privacy_exclusions e
                    ON e.workspace_id = np.workspace_id
                   AND e.source_id::text = lower(ref->>'sourceId')
                   AND e.asset_deleted_at IS NOT NULL
                  WHERE s.id IS NULL OR e.source_id IS NOT NULL
                )
              )
          )
          AND jsonb_typeof(wp.value) = 'object'
          AND lower(wp.value->>'workGroupId') = lower(${activityAlias()}.create_intent->>'workGroupId')
          AND jsonb_typeof(wp.value->'variantLabel') = 'string'
          AND char_length(btrim(wp.value->>'variantLabel')) BETWEEN 1 AND 80
          AND (wp.value ? 'parentDocumentId')
          AND (
            jsonb_typeof(wp.value->'parentDocumentId') = 'null'
            OR wp.value->>'parentDocumentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
          AND (wp.value ? 'parentRevisionNumber')
          AND (
            jsonb_typeof(wp.value->'parentRevisionNumber') = 'null'
            OR (
              jsonb_typeof(wp.value->'parentRevisionNumber') = 'number'
              AND (wp.value->>'parentRevisionNumber') ~ '^(0|[1-9][0-9]*)(\\.0+)?$'
            )
          )
          AND jsonb_typeof(wp.value->'keptAsPreferred') = 'boolean'
          AND (wp.value ? 'focusBlockId')
          AND (
            jsonb_typeof(wp.value->'focusBlockId') = 'null'
            OR (
              jsonb_typeof(wp.value->'focusBlockId') = 'string'
              AND char_length(wp.value->>'focusBlockId') BETWEEN 1 AND 120
            )
          )
          AND jsonb_typeof(wp.value->'assistanceRecords') = 'array'
          AND jsonb_array_length(
            CASE
              WHEN jsonb_typeof(wp.value->'assistanceRecords') = 'array' THEN wp.value->'assistanceRecords'
              ELSE '[]'::jsonb
            END
          ) <= 100
      )
    )
  )`;
}

/**
 * Authorize and read a writing target document in one SQL snapshot:
 * verifies workspace ownership, document workspace membership, non-deleted state,
 * `openingNoteReadable` provenance admission, and writing metadata / workGroup match.
 */
export async function readAuthorizedWritingDocument(
  db: Db,
  scope: Scope,
  options: {
    documentId: string;
    expectedWorkGroupId?: string | null;
    focusBlockId?: string | null;
    forShare?: boolean;
  },
): Promise<AuthorizedWritingDocumentRead> {
  const normalizedDocId = normalizeUuid(options.documentId);
  const focusCandidate = options.focusBlockId ?? null;
  const rows = await db`
    SELECT
      d.id,
      d.title,
      d.current_revision_number,
      p.value AS meta,
      (p.subject_id IS NOT NULL) AS has_meta,
      EXISTS (
        SELECT 1 FROM library_blocks b
        WHERE b.workspace_id = d.workspace_id
          AND b.document_id = d.id
          AND b.id::text = lower(${focusCandidate ?? ""})
      ) AS focus_exists
    FROM library_documents d
    JOIN workspaces w
      ON w.id = d.workspace_id
     AND w.owner_user_id = ${scope.ownerUserId}
    LEFT JOIN library_properties p
      ON p.workspace_id = d.workspace_id
     AND p.subject_type = 'document'
     AND p.subject_id = d.id
     AND p.key = ${WRITING_META_PROPERTY_KEY}
    WHERE d.id = ${normalizedDocId}
      AND d.workspace_id = ${scope.workspaceId}
      AND d.deleted_at IS NULL
      AND ${openingNoteReadable(db, scope.workspaceId, db`d.id`)}
    ${options.forShare ? db`FOR SHARE OF d` : db``}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return { status: "not_found" };
  }

  const canonicalDocumentId = normalizeUuid(String(row.id));
  const hasMeta = row.has_meta !== undefined ? Boolean(row.has_meta) : row.meta !== undefined && row.meta !== null;
  if (!hasMeta) {
    if (options.expectedWorkGroupId != null) {
      return { status: "not_found" };
    }
    return { status: "uninitialized", documentId: canonicalDocumentId };
  }

  const parsedMeta = writingVariantMetaSchema.safeParse(row.meta);
  if (!parsedMeta.success) {
    return { status: "not_found" };
  }
  if (
    options.expectedWorkGroupId != null
    && normalizeUuid(parsedMeta.data.workGroupId) !== normalizeUuid(options.expectedWorkGroupId)
  ) {
    return { status: "not_found" };
  }

  const focusStatus = focusCandidate == null
    ? "none"
    : row.focus_exists
      ? "exact"
      : "block_missing";

  return {
    status: "authorized",
    documentId: canonicalDocumentId,
    title: String(row.title ?? ""),
    currentRevisionNumber: Number(row.current_revision_number ?? 1),
    meta: {
      ...parsedMeta.data,
      workGroupId: normalizeUuid(parsedMeta.data.workGroupId),
      parentDocumentId: parsedMeta.data.parentDocumentId == null
        ? null
        : normalizeUuid(parsedMeta.data.parentDocumentId),
    },
    focusStatus,
  };
}

/**
 * Read-layer authorization gate aligned 1:1 with workspace recovery:
 * ordinary non-writing activities pass with zero extra queries; writing-marked
 * activities must satisfy strict `parseAuthorizedWritingActivityCheckpoint` and
 * `readAuthorizedWritingDocument` (`writingVariantMetaSchema` + provenance + non-deleted).
 */
export async function isAuthorizedWritingActivityRow(
  db: Db,
  scope: Scope,
  row: {
    create_intent?: unknown;
    checkpoint_json?: unknown;
  },
  options?: { forShare?: boolean },
): Promise<boolean> {
  const parsed = parseAuthorizedWritingActivityCheckpoint(row);
  if (parsed.kind === "not_writing") {
    return true;
  }
  if (parsed.kind !== "writing") {
    return false;
  }
  const target = await readAuthorizedWritingDocument(db, scope, {
    documentId: parsed.checkpoint.activeDocumentId,
    expectedWorkGroupId: parsed.workGroupId,
    focusBlockId: parsed.checkpoint.focusBlockId,
    forShare: options?.forShare,
  });
  return target.status === "authorized";
}

/**
 * Resolve the writing activity for a workGroup.
 * When `requestedActivityId` is explicitly supplied, missing, unowned, non-writing,
 * malformed-checkpoint, cross-workGroup, or unreadable-target activities return
 * `{ status: "not_found" }` instead of falling back to a group-level view.
 * When omitted, unreadable activities are skipped so surviving manuscripts remain readable.
 */
export async function readAuthorizedWritingActivityForGroup(
  db: Db,
  scope: Scope,
  workGroupId: string,
  requestedActivityId?: string | null,
): Promise<AuthorizedWritingGroupActivityRead> {
  const normalizedGroup = normalizeUuid(workGroupId);
  if (requestedActivityId != null) {
    const normalizedActivityId = normalizeUuid(requestedActivityId);
    const rows = await db`
      SELECT a.id, a.course_id, a.create_intent, a.checkpoint_json
      FROM opening_teaching_activities a
      JOIN workspaces w
        ON w.id = a.workspace_id
       AND w.owner_user_id = ${scope.ownerUserId}
      WHERE a.id = ${normalizedActivityId}
        AND a.workspace_id = ${scope.workspaceId}
        AND a.owner_user_id = ${scope.ownerUserId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return { status: "not_found" };
    }
    const parsed = parseAuthorizedWritingActivityCheckpoint(row);
    if (
      parsed.kind !== "writing"
      || parsed.workGroupId !== normalizedGroup
    ) {
      return { status: "not_found" };
    }
    const target = await readAuthorizedWritingDocument(db, scope, {
      documentId: parsed.checkpoint.activeDocumentId,
      expectedWorkGroupId: parsed.workGroupId,
      focusBlockId: parsed.checkpoint.focusBlockId,
    });
    if (target.status !== "authorized") {
      return { status: "not_found" };
    }
    return {
      status: "found",
      activity: {
        id: normalizeUuid(String(row.id)),
        courseId: row.course_id == null ? null : normalizeUuid(String(row.course_id)),
      },
    };
  }

  const rows = await db`
    SELECT a.id, a.course_id, a.create_intent, a.checkpoint_json
    FROM opening_teaching_activities a
    JOIN workspaces w
      ON w.id = a.workspace_id
     AND w.owner_user_id = ${scope.ownerUserId}
    WHERE a.workspace_id = ${scope.workspaceId}
      AND a.owner_user_id = ${scope.ownerUserId}
      AND a.create_intent->>'protocol' = ${WRITING_WORKSPACE_PROTOCOL}
      AND lower(a.create_intent->>'workGroupId') = ${normalizedGroup}
    ORDER BY a.updated_at DESC, a.id DESC
  `;
  for (const row of rows) {
    const parsed = parseAuthorizedWritingActivityCheckpoint(row);
    if (parsed.kind !== "writing" || parsed.workGroupId !== normalizedGroup) {
      continue;
    }
    const target = await readAuthorizedWritingDocument(db, scope, {
      documentId: parsed.checkpoint.activeDocumentId,
      expectedWorkGroupId: parsed.workGroupId,
      focusBlockId: parsed.checkpoint.focusBlockId,
    });
    if (target.status === "authorized") {
      return {
        status: "found",
        activity: {
          id: normalizeUuid(String(row.id)),
          courseId: row.course_id == null ? null : normalizeUuid(String(row.course_id)),
        },
      };
    }
  }
  return { status: "found", activity: null };
}
