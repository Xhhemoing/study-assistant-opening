import { lockOpeningJobExecution } from "./opening-job-execution";
import { createHash, randomUUID } from "node:crypto";
import {
  knowledgeSnapshotSchema,
  type CourseKnowledgeFailedJob,
  type CourseKnowledgeRecordResponse,
  type CourseKnowledgeRequestedJob,
  type CourseKnowledgeSync,
  type CourseKnowledgeSyncStatus,
  type KnowledgeSnapshot,
  type SourceChunk,
  type Scope,
} from "@aistudy/contracts";
import { knowledgeNodeDefinition, sameKnowledgeNodeIdentity, validateKnowledgeSnapshot } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { mapChunk } from "./opening-source-chunks";

export type OpeningKnowledgeErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningKnowledgeError extends Error {
  readonly code: OpeningKnowledgeErrorCode;
  readonly reason?: string;
  constructor(code: OpeningKnowledgeErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "OpeningKnowledgeError";
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

export type AuthorizedKnowledgeChunk = SourceChunk & { courseId: string };

export type OpeningKnowledgeRecord = {
  version: number;
  snapshot: KnowledgeSnapshot;
  sourceVersions: Record<string, number>;
};

export type ReadKnowledgeSyncOptions = {
  includeDetails?: boolean;
  requestedJobId?: string;
};

export type ReplaceKnowledgeInput = {
  expectedVersion: number;
  /** Automatic rebuilds pin references observed before reconciliation; manual edits omit this. */
  expectedReferencedNodeIds?: readonly string[];
  /** Worker rebuilds pass the source versions actually included in this extraction batch. */
  extractedSourceVersions?: Record<string, number>;
  snapshot: KnowledgeSnapshot;
  sourceVersions: Record<string, number>;
};

function sameGraph(left: KnowledgeSnapshot, right: KnowledgeSnapshot): boolean {
  const strip = (snapshot: KnowledgeSnapshot) =>
    JSON.stringify({
      courseId: snapshot.courseId,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    });
  return strip(left) === strip(right);
}

/** Status-only worker classification is not a new graph; every semantic edit is. */
function sameConfirmationGraph(left: KnowledgeSnapshot, right: KnowledgeSnapshot): boolean {
  const content = (snapshot: KnowledgeSnapshot) => JSON.stringify({
    nodes: snapshot.nodes.map(({ status: _status, ...node }) => node),
    edges: snapshot.edges.map(({ status: _status, ...edge }) => edge),
  });
  return content(left) === content(right);
}

function parseSourceVersions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) out[key] = n;
  }
  return out;
}

function sameVersions(left: Record<string, number>, right: Record<string, number>): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([id, version]) => right[id] === version);
}

function sourceVersionsHash(versions: Record<string, number>): string {
  const canonical = JSON.stringify(
    Object.keys(versions)
      .sort()
      .map((id) => [id, versions[id]]),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Evidence is compared and stored as a set: sorted unique chunk ids. */
function evidenceSet(chunkIds: readonly string[]): string[] {
  return [...new Set(chunkIds)].sort();
}

function nodeSourceVersions(chunkIds: readonly string[], chunks: readonly SourceChunk[]): Record<string, number> {
  const ids = new Set(chunkIds);
  return Object.fromEntries(chunks.filter(chunk => ids.has(chunk.id)).map(chunk => [chunk.sourceId, chunk.sourceVersion]));
}

function mapRecord(row: Record<string, unknown>): OpeningKnowledgeRecord {
  const snapshot = knowledgeSnapshotSchema.parse(row.snapshot);
  return {
    version: Number(row.version),
    snapshot: { ...snapshot, version: Number(row.version) },
    sourceVersions: parseSourceVersions(row.source_versions),
  };
}

async function assertOwnedCourse(sql: Sql | TransactionSql, scope: Scope, courseId: string): Promise<void> {
  const rows = await sql`
    SELECT c.id FROM courses c
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ${courseId}
      AND c.workspace_id = ${scope.workspaceId}
      AND w.owner_user_id = ${scope.ownerUserId}
      AND c.archived_at IS NULL`;
  if (!rows.length) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");
}

/** Includes historical links: deletion must never make a referenced UUID reusable. */
async function referencedNodeIds(db: Sql | TransactionSql, scope: Scope, courseId: string): Promise<string[]> {
  const rows = await db`SELECT node_id FROM opening_skill_evidence
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
    UNION SELECT (skill->>'nodeId')::uuid AS node_id FROM opening_exam_bindings b
    JOIN opening_exam_sprints s ON s.id=b.sprint_id,
    LATERAL jsonb_array_elements(b.binding->'skills') skill
    WHERE b.course_id=${courseId} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
    UNION SELECT l.node_id FROM opening_exam_attempt_links l
    JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id
    WHERE a.course_id=${courseId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  return rows.map(row => String(row.node_id));
}

/** Evidence chunks must belong to course-linked, uploaded sources in this workspace. */
async function assertAuthorizedChunks(
  tx: TransactionSql,
  scope: Scope,
  courseId: string,
  chunkIds: string[],
  sourceVersions: Record<string, number>,
): Promise<SourceChunk[]> {
  if (!chunkIds.length) {
    if (Object.keys(sourceVersions).length) {
      throw new OpeningKnowledgeError("VALIDATION", "sourceVersions provided without evidence chunks");
    }
    return [];
  }

  const rows = await tx`
    SELECT c.*
    FROM opening_source_chunks c
    JOIN opening_sources s ON s.id = c.source_id
    JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=c.source_version
    JOIN course_asset_memberships m
      ON m.workspace_id = s.workspace_id
      AND m.asset_type = 'source'
      AND m.asset_id = s.id
      AND m.course_id = ${courseId}
      AND (m.purpose IS NULL OR m.purpose = 'teaching')
    WHERE s.workspace_id = ${scope.workspaceId}
      AND s.upload_state = 'uploaded'
      AND s.parse_state = 'ready'
      AND c.source_version = s.version
      AND v.availability = 'available'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      AND c.id IN ${tx(chunkIds)}
    FOR SHARE`;

  if (rows.length !== chunkIds.length) {
    throw new OpeningKnowledgeError("VALIDATION", "illegal or unauthorized evidence chunk refs");
  }

  const expected: Record<string, number> = {};
  for (const row of rows as Array<Record<string, unknown>>) {
    const sourceId = String(row.source_id);
    const version = Number(row.source_version);
    if (sourceId in expected && expected[sourceId] !== version) {
      throw new OpeningKnowledgeError("VALIDATION", "evidence chunks span multiple versions of one source");
    }
    expected[sourceId] = version;
    const declared = sourceVersions[sourceId];
    if (declared === undefined) {
      throw new OpeningKnowledgeError("VALIDATION", `missing sourceVersions entry for ${sourceId}`);
    }
    if (declared !== version) {
      throw new OpeningKnowledgeError("VALIDATION", `sourceVersions mismatch for ${sourceId}`);
    }
  }
  for (const sourceId of Object.keys(sourceVersions)) {
    if (!(sourceId in expected)) {
      throw new OpeningKnowledgeError("VALIDATION", `sourceVersions includes unused source ${sourceId}`);
    }
  }
  return rows.map(row => mapChunk(row));
}

/** Purpose changes hide stale source-derived context without mutating confirmations/history. */
async function hasTeachingPurposes(sql: Sql, scope: Scope, courseId: string, versions: Record<string, number>): Promise<boolean> {
  const ids = Object.keys(versions);
  if (!ids.length) return true;
  const admitted = await sql`SELECT m.asset_id FROM course_asset_memberships m
    WHERE m.workspace_id=${scope.workspaceId} AND m.course_id=${courseId} AND m.asset_type='source'
      AND m.asset_id IN ${sql(ids)} AND (m.purpose IS NULL OR m.purpose='teaching')`;
  return admitted.length === ids.length;
}

const REQUESTED_JOB_STATES = new Set<CourseKnowledgeRequestedJob["state"]>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "outcome_unknown",
  "cancelled",
]);

function parseRequestedJobState(raw: unknown): CourseKnowledgeRequestedJob["state"] | null {
  return typeof raw === "string" && REQUESTED_JOB_STATES.has(raw as CourseKnowledgeRequestedJob["state"])
    ? (raw as CourseKnowledgeRequestedJob["state"])
    : null;
}

function hasInvalidatedGraphSource(
  graphSourceVersions: Record<string, number>,
  eligibleSourceVersions: Record<string, number>,
): boolean {
  return Object.entries(graphSourceVersions).some(
    ([sourceId, builtVersion]) => eligibleSourceVersions[sourceId] !== builtVersion,
  );
}

function missingGraphSourceIds(
  graphSourceVersions: Record<string, number>,
  eligibleSourceVersions: Record<string, number>,
): string[] {
  return Object.keys(graphSourceVersions).filter(
    (sourceId) => !(sourceId in eligibleSourceVersions),
  );
}

function hasMaterialDrift(
  coveredSourceVersions: Record<string, number>,
  graphSourceVersions: Record<string, number>,
  eligibleSourceVersions: Record<string, number>,
): boolean {
  return !sameVersions(coveredSourceVersions, eligibleSourceVersions)
    || hasInvalidatedGraphSource(graphSourceVersions, eligibleSourceVersions);
}

function blockedRebuildMessage(parsingSourceCount: number, unreadableSourceCount: number): string {
  if (parsingSourceCount > 0 && unreadableSourceCount > 0) {
    return "当前有资料仍在解析，且有资料无法读取文字。已保留原有知识点，请先等待解析完成并在资料页处理无法读取的资料后再重新整理。";
  }
  if (unreadableSourceCount > 0) {
    return "当前有资料无法读取文字。已保留原有知识点，请先在资料页重试解析、替换或移除无法读取的资料后再重新整理。";
  }
  return "当前有资料仍在解析中。已保留原有知识点，请等待解析完成后再重新整理。";
}

async function readEligibleAndParsingMaterials(
  db: Sql | TransactionSql,
  scope: Scope,
  courseId: string,
): Promise<{ eligibleSourceVersions: Record<string, number>; parsingSourceCount: number }> {
  const eligibleRows = await db`
    SELECT s.id, s.version
    FROM opening_sources s
    JOIN opening_source_versions v
      ON v.source_id = s.id AND v.workspace_id = s.workspace_id AND v.version = s.version
    JOIN course_asset_memberships m
      ON m.workspace_id = s.workspace_id
      AND m.asset_type = 'source'
      AND m.asset_id = s.id
      AND m.course_id = ${courseId}
      AND (m.purpose IS NULL OR m.purpose = 'teaching')
    WHERE s.workspace_id = ${scope.workspaceId}
      AND s.upload_state = 'uploaded'
      AND s.parse_state = 'ready'
      AND v.availability = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
      )
      AND EXISTS (
        SELECT 1 FROM opening_source_chunks c
        WHERE c.source_id = s.id
          AND c.source_version = s.version
          AND c.text ~ '[^[:space:]]'
      )
    ORDER BY s.id`;
  const eligibleSourceVersions: Record<string, number> = {};
  for (const row of eligibleRows as Array<Record<string, unknown>>) {
    eligibleSourceVersions[String(row.id)] = Number(row.version);
  }

  const parsingRows = await db`
    SELECT count(DISTINCT s.id)::int AS count
    FROM opening_sources s
    JOIN course_asset_memberships m
      ON m.workspace_id = s.workspace_id
      AND m.asset_type = 'source'
      AND m.asset_id = s.id
      AND m.course_id = ${courseId}
      AND (m.purpose IS NULL OR m.purpose = 'teaching')
    WHERE s.workspace_id = ${scope.workspaceId}
      AND s.upload_state IN ('pending', 'uploaded')
      AND s.parse_state IN ('not_started', 'queued', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
      )`;
  const parsingSourceCount = Number((parsingRows[0] as Record<string, unknown> | undefined)?.count ?? 0);
  return { eligibleSourceVersions, parsingSourceCount };
}

async function readUnreadableSourceCount(
  db: Sql | TransactionSql,
  scope: Scope,
  courseId: string,
): Promise<number> {
  const rows = await db`
    SELECT count(DISTINCT s.id)::int AS count
    FROM opening_sources s
    JOIN opening_source_versions v
      ON v.source_id = s.id AND v.workspace_id = s.workspace_id AND v.version = s.version
    JOIN course_asset_memberships m
      ON m.workspace_id = s.workspace_id
      AND m.asset_type = 'source'
      AND m.asset_id = s.id
      AND m.course_id = ${courseId}
      AND (m.purpose IS NULL OR m.purpose = 'teaching')
    WHERE s.workspace_id = ${scope.workspaceId}
      AND s.upload_state = 'uploaded'
      AND v.availability = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
      )
      AND (
        s.parse_state = 'failed'
        OR (
          s.parse_state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM opening_source_chunks c
            WHERE c.source_id = s.id
              AND c.source_version = s.version
              AND c.text ~ '[^[:space:]]'
          )
        )
      )`;
  return Number((rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
}

async function readMandatoryCleanupSourceIds(
  db: Sql | TransactionSql,
  scope: Scope,
  courseId: string,
  graphSourceIds: readonly string[],
): Promise<Set<string>> {
  if (!graphSourceIds.length) return new Set();
  const ids = [...graphSourceIds];
  const rows = await db`
    SELECT
      src.id AS source_id,
      EXISTS (
        SELECT 1 FROM opening_sources s
        WHERE s.workspace_id = ${scope.workspaceId} AND s.id = src.id
      ) AS source_exists,
      EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = ${scope.workspaceId} AND e.source_id = src.id
      ) AS excluded,
      EXISTS (
        SELECT 1 FROM course_asset_memberships m
        WHERE m.workspace_id = ${scope.workspaceId}
          AND m.course_id = ${courseId}
          AND m.asset_type = 'source'
          AND m.asset_id = src.id
          AND m.purpose IN ('practice', 'reference', 'mock_exam')
      ) AS restricted_purpose
    FROM unnest(${ids}::uuid[]) AS src(id)`;
  const cleanupIds = new Set<string>();
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!row.source_exists || Boolean(row.excluded) || Boolean(row.restricted_purpose)) {
      cleanupIds.add(String(row.source_id));
    }
  }
  return cleanupIds;
}

async function readSyncStatusInternal(
  db: Sql | TransactionSql,
  scope: Scope,
  courseId: string,
  options?: ReadKnowledgeSyncOptions & { computeProtection?: boolean },
): Promise<{
  sync: CourseKnowledgeSync;
  record: OpeningKnowledgeRecord | null;
  unreadableSourceCount: number;
  rebuildBlockedByMaterials: boolean;
}> {
  await assertOwnedCourse(db, scope, courseId);
  const knowledgeRows = await db`
    SELECT version, snapshot, source_versions
    FROM opening_course_knowledge
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND course_id = ${courseId}`;
  const record = knowledgeRows.length ? mapRecord(knowledgeRows[0] as Record<string, unknown>) : null;

  const { eligibleSourceVersions, parsingSourceCount } = await readEligibleAndParsingMaterials(db, scope, courseId);

  const includeDetails = Boolean(options?.includeDetails);
  const needProtection = includeDetails || Boolean(options?.computeProtection);
  const unreadableSourceCount = needProtection ? await readUnreadableSourceCount(db, scope, courseId) : 0;

  const graphSources = record?.sourceVersions ?? {};
  const missingEvidenceIds = missingGraphSourceIds(graphSources, eligibleSourceVersions);
  let rebuildBlockedByMaterials = false;
  if (needProtection && missingEvidenceIds.length > 0 && (parsingSourceCount > 0 || unreadableSourceCount > 0)) {
    const mandatoryCleanupIds = await readMandatoryCleanupSourceIds(db, scope, courseId, missingEvidenceIds);
    const protectedMissingIds = missingEvidenceIds.filter((id) => !mandatoryCleanupIds.has(id));
    rebuildBlockedByMaterials = protectedMissingIds.length > 0;
  }

  const activeJobRows = await db`
    SELECT id
    FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND kind = 'build-course-knowledge'
      AND payload->>'courseId' = ${courseId}
      AND state IN ('queued', 'running')
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT 1`;
  const activeJobId = activeJobRows.length ? String((activeJobRows[0] as Record<string, unknown>).id) : null;

  const succeededRows = await db`
    SELECT id, result
    FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND kind = 'build-course-knowledge'
      AND payload->>'courseId' = ${courseId}
      AND state = 'succeeded'
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT 1`;
  const latestSucceeded = succeededRows[0] as Record<string, unknown> | undefined;
  const resultObj =
    latestSucceeded?.result && typeof latestSucceeded.result === "object" && !Array.isArray(latestSucceeded.result)
      ? (latestSucceeded.result as Record<string, unknown>)
      : null;
  const resultVersion =
    resultObj && typeof resultObj.version === "number" && Number.isInteger(resultObj.version) && resultObj.version >= 0
      ? resultObj.version
      : null;
  const hasResultCovered = Boolean(
    resultObj
      && "coveredSourceVersions" in resultObj
      && resultObj.coveredSourceVersions !== null
      && typeof resultObj.coveredSourceVersions === "object"
      && !Array.isArray(resultObj.coveredSourceVersions),
  );
  const lastBuiltVersion = latestSucceeded ? resultVersion : null;
  const coveredSourceVersions = hasResultCovered
    ? parseSourceVersions(resultObj!.coveredSourceVersions)
    : (record?.sourceVersions ?? {});

  let status: CourseKnowledgeSyncStatus;
  if (activeJobId !== null) {
    status = "pending";
  } else if (
    Object.keys(eligibleSourceVersions).length === 0
    && (!record || (record.snapshot.nodes.length === 0 && Object.keys(record.sourceVersions).length === 0))
  ) {
    status = "empty";
  } else if (hasMaterialDrift(coveredSourceVersions, graphSources, eligibleSourceVersions)) {
    status = "needs_rebuild";
  } else {
    status = "up_to_date";
  }

  const baseSync: CourseKnowledgeSync = {
    status,
    activeJobId,
    lastBuiltVersion,
    coveredSourceVersions,
    eligibleSourceVersions,
    parsingSourceCount,
  };

  if (!includeDetails) {
    return {
      sync: baseSync,
      record,
      unreadableSourceCount,
      rebuildBlockedByMaterials,
    };
  }

  const terminalRows = await db`
    SELECT id, state
    FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND kind = 'build-course-knowledge'
      AND payload->>'courseId' = ${courseId}
      AND state IN ('succeeded', 'failed', 'outcome_unknown', 'cancelled')
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT 1`;
  const latestTerminal = terminalRows[0] as Record<string, unknown> | undefined;
  const lastFailedJob: CourseKnowledgeFailedJob | null =
    latestTerminal && (latestTerminal.state === "failed" || latestTerminal.state === "outcome_unknown")
      ? { jobId: String(latestTerminal.id), state: latestTerminal.state }
      : null;

  let requestedJob: CourseKnowledgeRequestedJob | null = null;
  if (options?.requestedJobId) {
    const requestedRows = await db`
      SELECT id, state
      FROM opening_jobs
      WHERE id = ${options.requestedJobId}
        AND workspace_id = ${scope.workspaceId}
        AND owner_user_id = ${scope.ownerUserId}
        AND kind = 'build-course-knowledge'
        AND payload->>'courseId' = ${courseId}
      LIMIT 1`;
    const reqRow = requestedRows[0] as Record<string, unknown> | undefined;
    const reqState = reqRow ? parseRequestedJobState(reqRow.state) : null;
    if (reqRow && reqState) {
      requestedJob = { jobId: String(reqRow.id), state: reqState };
    }
  }

  return {
    sync: {
      ...baseSync,
      unreadableSourceCount,
      rebuildBlockedByMaterials,
      lastFailedJob,
      requestedJob,
    },
    record,
    unreadableSourceCount,
    rebuildBlockedByMaterials,
  };
}

async function readSyncStatusInSnapshot(
  sql: Sql,
  scope: Scope,
  courseId: string,
  options?: ReadKnowledgeSyncOptions & { computeProtection?: boolean },
) {
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    return readSyncStatusInternal(tx, scope, courseId, options);
  });
}

export function createOpeningKnowledgeRepository(sql: Sql) {
  return {
    /** Definitions contain source text and are only available to the rebuild worker. */
    async getForRebuild(scope: Scope, courseId: string): Promise<(OpeningKnowledgeRecord & { nodeDefinitions: Record<string, string> }) | null> {
      await assertOwnedCourse(sql, scope, courseId);
      const [row] = await sql`SELECT version,snapshot,source_versions,node_definitions FROM opening_course_knowledge
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
      if (!row) return null;
      const current = mapRecord(row);
      if (await hasTeachingPurposes(sql, scope, courseId, current.sourceVersions)) {
        return { ...current, nodeDefinitions: row.node_definitions as Record<string, string> };
      }
      // A restricted graph still exists: keep its real CAS version, but never
      // return its restricted labels/definitions to reconciliation or the model.
      // Retain only complete, currently authorized evidence so legal identities
      // survive the rebuild instead of being recreated under a false version 0.
      const chunks = await this.listAuthorizedChunks(scope, courseId);
      const allowed = new Set(chunks.map(chunk => chunk.id));
      const nodes = current.snapshot.nodes.filter(node => node.evidenceChunkIds.length > 0
        && node.evidenceChunkIds.every(id => allowed.has(id)));
      const ids = new Set(nodes.map(node => node.id));
      const edges = current.snapshot.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)
        && edge.evidenceChunkIds.every(id => allowed.has(id)));
      const definitions = row.node_definitions as Record<string, string>;
      return { version: current.version, snapshot: { ...current.snapshot, nodes, edges },
        sourceVersions: Object.fromEntries(chunks.map(chunk => [chunk.sourceId, chunk.sourceVersion])),
        nodeDefinitions: Object.fromEntries(Object.entries(definitions).filter(([id]) => ids.has(id))) };
    },
    async assertExtractionBatch(scope: Scope, courseId: string, chunks: readonly SourceChunk[]): Promise<void> {
      await sql.begin(async tx => {
        await lockOpeningJobExecution(tx, scope);
        await assertOwnedCourse(tx, scope, courseId);
        const ids = [...new Set(chunks.map(chunk => chunk.id))];
        const versions = Object.fromEntries(chunks.map(chunk => [chunk.sourceId, chunk.sourceVersion]));
        await assertAuthorizedChunks(tx, scope, courseId, ids, versions);
      });
    },
    async listReferencedNodeIds(scope: Scope, courseId: string): Promise<string[]> {
      await assertOwnedCourse(sql, scope, courseId);
      return referencedNodeIds(sql, scope, courseId);
    },
    async get(scope: Scope, courseId: string): Promise<OpeningKnowledgeRecord | null> {
      await assertOwnedCourse(sql, scope, courseId);
      const rows = await sql`
        SELECT version, snapshot, source_versions
        FROM opening_course_knowledge
        WHERE workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND course_id = ${courseId}`;
      if (!rows.length) return null;
      const sourceIds = Object.keys(parseSourceVersions(rows[0]!.source_versions));
      // Preserve the existing historical read after unlink; only explicit purpose
      // restrictions hide this graph here. Rebuild admission above stays strict.
      const restricted = sourceIds.length ? await sql`SELECT id FROM course_asset_memberships
        WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId} AND asset_type='source'
          AND asset_id=ANY(${sourceIds}::uuid[]) AND purpose IN ('practice','reference','mock_exam')` : [];
      if (restricted.length) return null;
      return mapRecord(rows[0] as Record<string, unknown>);
    },

    async readSyncStatus(scope: Scope, courseId: string, options?: ReadKnowledgeSyncOptions): Promise<CourseKnowledgeSync> {
      const { sync } = await readSyncStatusInSnapshot(sql, scope, courseId, options);
      return sync;
    },

    async getWithSync(scope: Scope, courseId: string, options?: ReadKnowledgeSyncOptions): Promise<CourseKnowledgeRecordResponse> {
      return sql.begin(async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        const { sync, record } = await readSyncStatusInternal(tx, scope, courseId, options);
        if (!record) {
          return {
            version: 0,
            snapshot: { courseId, version: 0, nodes: [], edges: [] },
            sourceVersions: {},
            sync,
          };
        }
        const sourceIds = Object.keys(record.sourceVersions);
        const restricted = sourceIds.length
          ? await tx`SELECT id FROM course_asset_memberships
              WHERE workspace_id = ${scope.workspaceId}
                AND course_id = ${courseId}
                AND asset_type = 'source'
                AND asset_id = ANY(${sourceIds}::uuid[])
                AND purpose IN ('practice', 'reference', 'mock_exam')`
          : [];
        if (restricted.length) {
          return {
            version: record.version,
            snapshot: { courseId, version: record.version, nodes: [], edges: [] },
            sourceVersions: {},
            sync,
          };
        }
        return {
          version: record.version,
          snapshot: record.snapshot,
          sourceVersions: record.sourceVersions,
          sync,
        };
      });
    },

    /** A strict transition, not an idempotent replay: stale/duplicate submissions conflict. */
    async confirmNode(scope: Scope, courseId: string, nodeId: string, input: {
      expectedVersion: number; sourceVersions: Record<string, number>;
    }): Promise<OpeningKnowledgeRecord> {
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0
        || Object.values(input.sourceVersions).some(version => !Number.isInteger(version) || version < 0)) {
        throw new OpeningKnowledgeError("VALIDATION", "invalid confirmation versions");
      }
      return sql.begin(async tx => {
        // Match replace/source actions' workspace-first lock order, serializing permission changes.
        const owner = await tx`SELECT w.id FROM workspaces w JOIN courses c ON c.workspace_id=w.id
          WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
            AND c.id=${courseId} AND c.archived_at IS NULL FOR UPDATE`;
        if (!owner.length) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");
        const [row] = await tx`SELECT version,snapshot,source_versions FROM opening_course_knowledge
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR UPDATE`;
        if (!row) throw new OpeningKnowledgeError("NOT_FOUND", "knowledge not found");
        const current = mapRecord(row);
        const node = current.snapshot.nodes.find(item => item.id === nodeId);
        if (!node) throw new OpeningKnowledgeError("NOT_FOUND", "node not found");
        if (current.version !== input.expectedVersion || node.status !== "needs_check"
          || !sameVersions(current.sourceVersions, input.sourceVersions)) {
          throw new OpeningKnowledgeError("CONFLICT", "课程知识已变化，请重新读取并核对材料。");
        }
        if (!node.evidenceChunkIds.length) throw new OpeningKnowledgeError("CONFLICT", "尚无材料依据，请先补充材料。");
        const evidenceIds = evidenceSet(node.evidenceChunkIds);
        // Live source rows are locked until commit; maintenance also advances the graph CAS fence.
        // Validate the complete observed source set as well as the selected node's evidence.
        const sourceIds = Object.keys(input.sourceVersions).sort();
        const sources = sourceIds.length ? await tx`SELECT s.id,s.version FROM opening_sources s
          JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=s.version
          JOIN course_asset_memberships m ON m.workspace_id=s.workspace_id AND m.asset_type='source'
            AND m.asset_id=s.id AND m.course_id=${courseId}
            AND (m.purpose IS NULL OR m.purpose='teaching')
          WHERE s.workspace_id=${scope.workspaceId} AND s.id IN ${tx(sourceIds)}
            AND s.upload_state='uploaded' AND s.parse_state='ready' AND v.availability='available'
            AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
          ORDER BY s.id FOR SHARE` : [];
        if (!sameVersions(input.sourceVersions, Object.fromEntries(sources.map(source => [String(source.id), Number(source.version)])))) {
          throw new OpeningKnowledgeError("CONFLICT", "课程材料已变化（有材料更新了版本、移出了课程或被排除），课程知识需要按当前材料重新整理后才能确认；已有知识点保留。");
        }
        let chunks: SourceChunk[];
        try {
          const rows = await tx`SELECT c.* FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
            WHERE s.workspace_id=${scope.workspaceId} AND c.id IN ${tx(evidenceIds)} FOR SHARE`;
          const versions = Object.fromEntries(rows.map(chunk => [String(chunk.source_id), Number(chunk.source_version)]));
          chunks = await assertAuthorizedChunks(tx, scope, courseId, evidenceIds, versions);
          if (Object.entries(versions).some(([id, version]) => input.sourceVersions[id] !== version)) {
            throw new OpeningKnowledgeError("VALIDATION", "stale evidence");
          }
        } catch (error) {
          if (error instanceof OpeningKnowledgeError && error.code === "VALIDATION") {
            throw new OpeningKnowledgeError("CONFLICT", "材料依据已变化，请重新读取并核对材料。");
          }
          throw error;
        }
        const version = current.version + 1;
        const snapshot: KnowledgeSnapshot = { ...current.snapshot, version,
          nodes: current.snapshot.nodes.map(item => item.id === nodeId ? { ...item, status: "supported" } : item) };
        await tx`UPDATE opening_course_knowledge SET version=${version},snapshot=${tx.json(snapshot as never)},updated_at=now()
          WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId}`;
        await tx`INSERT INTO opening_knowledge_confirmations
          (id,workspace_id,owner_user_id,course_id,node_id,node_label,node_kind,graph_version_before,graph_version_after,source_versions,evidence_chunk_ids)
          VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${courseId},${nodeId},${node.label},${node.kind},${current.version},${version},
            ${tx.json(nodeSourceVersions(evidenceIds, chunks))},${tx.json(evidenceIds)})`;
        return { ...current, version, snapshot };
      });
    },

    async getVersion(scope: Scope, courseId: string): Promise<number | null> {
      await assertOwnedCourse(sql, scope, courseId);
      const rows = await sql`
        SELECT version FROM opening_course_knowledge
        WHERE workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND course_id = ${courseId}`;
      if (!rows.length) return null;
      return Number((rows[0] as Record<string, unknown>).version);
    },

    async listAuthorizedChunks(scope: Scope, courseId: string): Promise<AuthorizedKnowledgeChunk[]> {
      await assertOwnedCourse(sql, scope, courseId);
      const rows = await sql`
        SELECT c.*, m.course_id
        FROM opening_source_chunks c
        JOIN opening_sources s ON s.id = c.source_id
        JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=c.source_version
        JOIN course_asset_memberships m
          ON m.workspace_id = s.workspace_id
          AND m.asset_type = 'source'
          AND m.asset_id = s.id
          AND m.course_id = ${courseId}
          AND (m.purpose IS NULL OR m.purpose = 'teaching')
        WHERE s.workspace_id = ${scope.workspaceId}
          AND s.upload_state = 'uploaded'
          AND s.parse_state = 'ready'
          AND c.source_version = s.version
          AND v.availability = 'available'
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
          AND c.text ~ '[^[:space:]]'
        ORDER BY c.source_id, c.page NULLS LAST, c.created_at`;
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        return { ...mapChunk(record), courseId: String(record.course_id) };
      });
    },

    /**
     * CAS replace. Stores newVersion = expectedVersion + 1.
     * Snapshot.version from the caller is overwritten to newVersion.
     * Soft-idempotent only for nonempty, fully reviewed graphs at expectedVersion+1.
     * Pending graphs require a fresh CAS: maintenance may have advanced the same-looking graph.
     */
    async replace(
      scope: Scope,
      courseId: string,
      input: ReplaceKnowledgeInput,
    ): Promise<OpeningKnowledgeRecord> {
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
        throw new OpeningKnowledgeError("VALIDATION", "expectedVersion must be a non-negative integer");
      }
      if (input.snapshot.courseId !== courseId) {
        throw new OpeningKnowledgeError("VALIDATION", "snapshot.courseId must match courseId");
      }
      const sourceVersions = input.sourceVersions ?? {};
      const newVersion = input.expectedVersion + 1;
      let draft: KnowledgeSnapshot;
      try {
        draft = validateKnowledgeSnapshot({
          ...input.snapshot,
          courseId,
          version: newVersion,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid knowledge snapshot";
        throw new OpeningKnowledgeError("VALIDATION", message);
      }

      return sql.begin(async (tx) => {
        const owner = await tx`
          SELECT w.id FROM workspaces w
          JOIN courses c ON c.workspace_id = w.id AND c.id = ${courseId} AND c.archived_at IS NULL
          WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!owner.length) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");
        await lockOpeningJobExecution(tx, scope);

        const currentRows = await tx`
          SELECT version, snapshot, source_versions, node_definitions FROM opening_course_knowledge
          WHERE workspace_id = ${scope.workspaceId} AND course_id = ${courseId}
          FOR UPDATE`;
        const current = currentRows[0] as Record<string, unknown> | undefined;
        const currentVersion = current ? Number(current.version) : 0;

        if (current && currentVersion === newVersion) {
          const existing = mapRecord(current);
          const replayable = existing.snapshot.nodes.length > 0
            && [...existing.snapshot.nodes, ...existing.snapshot.edges].every(item => item.status !== "needs_check");
          if (replayable && sameGraph(existing.snapshot, draft) && sameVersions(existing.sourceVersions, sourceVersions)) return existing;
        }
        if (currentVersion !== input.expectedVersion) {
          throw new OpeningKnowledgeError("CONFLICT", "stale knowledge version");
        }

        const previous = current ? mapRecord(current) : null;
        if (
          input.extractedSourceVersions !== undefined
          && previous !== null
          && Object.keys(previous.sourceVersions).length > 0
        ) {
          const previousSourceIds = Object.keys(previous.sourceVersions);
          const removesOldSourceEvidence = previousSourceIds.some(
            (sourceId) => sourceVersions[sourceId] !== previous.sourceVersions[sourceId],
          );
          if (removesOldSourceEvidence) {
            const { eligibleSourceVersions, parsingSourceCount } = await readEligibleAndParsingMaterials(tx, scope, courseId);
            const missingIds = missingGraphSourceIds(previous.sourceVersions, eligibleSourceVersions);
            const uncoveredEligibleIds = previousSourceIds.filter(
              (sourceId) =>
                sourceId in eligibleSourceVersions
                && sourceVersions[sourceId] !== previous.sourceVersions[sourceId]
                && input.extractedSourceVersions![sourceId] !== eligibleSourceVersions[sourceId],
            );
            const candidateProtectedIds = [...new Set([...missingIds, ...uncoveredEligibleIds])];
            if (candidateProtectedIds.length > 0) {
              const mandatoryCleanupIds = await readMandatoryCleanupSourceIds(tx, scope, courseId, candidateProtectedIds);
              const protectedMissingIds = missingIds.filter((id) => !mandatoryCleanupIds.has(id));
              const protectedUncoveredIds = uncoveredEligibleIds.filter((id) => !mandatoryCleanupIds.has(id));
              if (protectedMissingIds.length > 0) {
                const unreadableSourceCount = await readUnreadableSourceCount(tx, scope, courseId);
                if (parsingSourceCount > 0 || unreadableSourceCount > 0) {
                  throw new OpeningKnowledgeError(
                    "CONFLICT",
                    blockedRebuildMessage(parsingSourceCount, unreadableSourceCount),
                    "MATERIAL_REPLACEMENT_BLOCKED",
                  );
                }
                const missedEligibleSource = Object.entries(eligibleSourceVersions).some(
                  ([sourceId, version]) => input.extractedSourceVersions![sourceId] !== version,
                );
                if (missedEligibleSource) {
                  throw new OpeningKnowledgeError(
                    "CONFLICT",
                    "课程中已有新的可读资料未纳入本次整理，已保留原有知识点，请按最新资料重新整理。",
                    "MATERIAL_REPLACEMENT_BLOCKED",
                  );
                }
              }
              if (protectedUncoveredIds.length > 0) {
                throw new OpeningKnowledgeError(
                  "CONFLICT",
                  "课程中已有新的可读资料未纳入本次整理，已保留原有知识点，请按最新资料重新整理。",
                  "MATERIAL_REPLACEMENT_BLOCKED",
                );
              }
            }
          }
        }
        const evidence = await assertAuthorizedChunks(tx, scope, courseId,
          [...new Set([...draft.nodes, ...draft.edges].flatMap(item => item.evidenceChunkIds))].sort(), sourceVersions);
        const definitions = Object.fromEntries(draft.nodes.flatMap(node => {
          const definition = knowledgeNodeDefinition(node, evidence);
          return definition ? [[node.id, definition]] : [];
        }));
        const previousDefinitions = (current?.node_definitions ?? {}) as Record<string, string>;
        const referenced = new Set(await referencedNodeIds(tx, scope, courseId));
        if (input.expectedReferencedNodeIds && (referenced.size !== new Set(input.expectedReferencedNodeIds).size
          || input.expectedReferencedNodeIds.some(id => !referenced.has(id)))) {
          throw new OpeningKnowledgeError("CONFLICT", "课程技能引用已变化，请重新生成知识图谱");
        }
        for (const node of draft.nodes) {
          const existing = previous?.snapshot.nodes.find(item => item.id === node.id);
          const sameDefinition = Boolean(definitions[node.id] && definitions[node.id] === previousDefinitions[node.id]);
          if ((!existing && referenced.has(node.id)) || (existing && !sameKnowledgeNodeIdentity(existing, node) && !sameDefinition)) {
            throw new OpeningKnowledgeError("CONFLICT", "知识节点身份已退役或内容已变化，请创建新节点身份；历史学习证据不会转给新技能。");
          }
        }

        // A confirmation belongs to the whole observed graph/source set. Once either changes,
        // delete the receipt in this transaction: changing back must not resurrect approval.
        const confirmationContextUnchanged = previous !== null
          && sameConfirmationGraph(previous.snapshot, draft)
          && sameVersions(previous.sourceVersions, sourceVersions);
        // Restore only this exact confirmed evidence/version set, after normal worker classification.
        // UUID/definition guards above still apply. A changed source is never a permanent exemption.
        const confirmations = await tx`SELECT DISTINCT ON (node_id) node_id,node_label,node_kind,source_versions,evidence_chunk_ids
          FROM opening_knowledge_confirmations WHERE workspace_id=${scope.workspaceId}
            AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
          ORDER BY node_id,graph_version_after DESC`;
        const nodes = draft.nodes.map(node => {
          const existing = previous?.snapshot.nodes.find(item => item.id === node.id);
          const confirmation = confirmations.find(item => item.node_id === node.id);
          const confirmed = confirmationContextUnchanged && existing && confirmation
            && definitions[node.id] === previousDefinitions[node.id]
            && node.label === confirmation.node_label && node.kind === confirmation.node_kind
            && node.evidenceChunkIds.length > 0
            && JSON.stringify(evidenceSet(node.evidenceChunkIds)) === JSON.stringify(confirmation.evidence_chunk_ids)
            && sameVersions(nodeSourceVersions(node.evidenceChunkIds, evidence), parseSourceVersions(confirmation.source_versions));
          if (confirmation && !confirmed) return { ...node, status: "needs_check" as const };
          // Worker status classification cannot revoke a still-valid explicit confirmation.
          // Manual edits omit expectedReferencedNodeIds and retain the withdrawal path below.
          if (input.expectedReferencedNodeIds && confirmed) {
            return { ...node, status: "supported" as const };
          }
          if (existing?.status === "needs_check" && node.status !== "needs_check") {
            if (input.expectedReferencedNodeIds) return { ...node, status: "needs_check" as const };
            throw new OpeningKnowledgeError("CONFLICT", "需要先核对材料并确认此知识点。");
          }
          return node;
        });
        const stored: KnowledgeSnapshot = { ...draft, nodes, version: newVersion };
        const rows = await tx`
          INSERT INTO opening_course_knowledge (
            workspace_id, owner_user_id, course_id, version, snapshot, source_versions, node_definitions, updated_at
          ) VALUES (
            ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId}, ${newVersion},
            ${tx.json(stored as never)}, ${tx.json(sourceVersions as never)}, ${tx.json(definitions)}, now()
          )
          ON CONFLICT (workspace_id, course_id) DO UPDATE SET
            version = EXCLUDED.version,
            snapshot = EXCLUDED.snapshot,
            source_versions = EXCLUDED.source_versions,
            node_definitions = EXCLUDED.node_definitions,
            owner_user_id = EXCLUDED.owner_user_id,
            updated_at = now()
          WHERE opening_course_knowledge.version = ${input.expectedVersion}
          RETURNING version, snapshot, source_versions`;
        if (!rows.length) throw new OpeningKnowledgeError("CONFLICT", "knowledge replace raced");
        // All invalidated receipts are removed, including receipts for nodes no longer present.
        const nextStatus = new Map(nodes.map(node => [node.id, node.status]));
        const revoked = confirmations.filter(confirmation => !confirmationContextUnchanged
          || !nextStatus.has(String(confirmation.node_id))
          || nextStatus.get(String(confirmation.node_id)) !== "supported")
          .map(confirmation => String(confirmation.node_id)).sort();
        if (revoked.length) {
          await tx`DELETE FROM opening_knowledge_confirmations WHERE workspace_id=${scope.workspaceId}
            AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} AND node_id IN ${tx(revoked)}`;
        }
        return mapRecord(rows[0] as Record<string, unknown>);
      });
    },

    /** Enqueue rebuild. Payload is { courseId } only; worker loads expectedVersion via get/getVersion. */
    async enqueueRebuild(
      scope: Scope,
      courseId: string,
      input: { clientKey: string },
    ): Promise<{ jobId: string; kind: "build-course-knowledge"; created: boolean }> {
      if (input.clientKey.length < 8) {
        throw new OpeningKnowledgeError("VALIDATION", "clientKey is too short");
      }
      await assertOwnedCourse(sql, scope, courseId);
      const key = `build-course-knowledge:${courseId}:${input.clientKey}`;
      return sql.begin(async (tx) => {
        const [workspace] = await tx`
          SELECT privacy_epoch FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
        if (!workspace) throw new OpeningKnowledgeError("NOT_FOUND", "workspace not found");
        const [course] = await tx`
          SELECT id FROM courses
          WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId} AND archived_at IS NULL FOR UPDATE`;
        if (!course) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");

        const payload = { courseId };
        const existingBefore = await tx`
          SELECT id, payload FROM opening_jobs
          WHERE workspace_id = ${scope.workspaceId} AND key = ${key}`;
        const existingRow = existingBefore[0] as Record<string, unknown> | undefined;
        if (existingRow) {
          if (JSON.stringify(existingRow.payload) !== JSON.stringify(payload)) {
            throw new OpeningKnowledgeError("CONFLICT", "idempotency payload differs for the same key");
          }
          return { jobId: String(existingRow.id), kind: "build-course-knowledge" as const, created: false };
        }

        const currentSync = await readSyncStatusInternal(tx, scope, courseId, { computeProtection: true });
        if (currentSync.rebuildBlockedByMaterials) {
          throw new OpeningKnowledgeError(
            "CONFLICT",
            blockedRebuildMessage(currentSync.sync.parsingSourceCount, currentSync.unreadableSourceCount),
            "MATERIAL_REPLACEMENT_BLOCKED",
          );
        }

        const privacyEpoch = Number((workspace as { privacy_epoch?: number }).privacy_epoch ?? 0);
        const jobId = randomUUID();
        const inserted = await tx`
          INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
          VALUES (
            ${jobId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${key},
            ${"build-course-knowledge"}, ${tx.json(payload as never)}, ${privacyEpoch}
          )
          ON CONFLICT (workspace_id, key) DO NOTHING
          RETURNING id`;
        if (inserted.length) {
          await tx`
            INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
            VALUES (
              ${scope.workspaceId}, ${jobId}, ${"opening.job.enqueue"},
              ${tx.json({ jobId, kind: "build-course-knowledge", courseId } as never)}
            )`;
          return { jobId, kind: "build-course-knowledge" as const, created: true };
        }
        const existing = await tx`
          SELECT id, payload FROM opening_jobs
          WHERE workspace_id = ${scope.workspaceId} AND key = ${key}`;
        const row = existing[0] as Record<string, unknown> | undefined;
        if (!row) throw new OpeningKnowledgeError("NOT_FOUND", "rebuild job disappeared after conflict");
        if (JSON.stringify(row.payload) !== JSON.stringify(payload)) {
          throw new OpeningKnowledgeError("CONFLICT", "idempotency payload differs for the same key");
        }
        return { jobId: String(row.id), kind: "build-course-knowledge" as const, created: false };
      });
    },

    async enqueueCoalescedRebuild(
      scope: Scope,
      courseId: string,
      reasonKey: string,
    ): Promise<{ jobId: string; kind: "build-course-knowledge"; created: boolean }> {
      if (!reasonKey.trim()) {
        throw new OpeningKnowledgeError("VALIDATION", "reasonKey must not be empty");
      }
      await assertOwnedCourse(sql, scope, courseId);
      return sql.begin(async (tx) => {
        const [workspace] = await tx`
          SELECT privacy_epoch FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
        if (!workspace) throw new OpeningKnowledgeError("NOT_FOUND", "workspace not found");
        const [course] = await tx`
          SELECT id FROM courses
          WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId} AND archived_at IS NULL FOR UPDATE`;
        if (!course) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");

        const queuedRows = await tx`
          SELECT id FROM opening_jobs
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND kind = 'build-course-knowledge'
            AND payload->>'courseId' = ${courseId}
            AND state = 'queued'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`;
        if (queuedRows.length) {
          return { jobId: String(queuedRows[0]!.id), kind: "build-course-knowledge" as const, created: false };
        }

        const runningRows = await tx`
          SELECT id FROM opening_jobs
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND kind = 'build-course-knowledge'
            AND payload->>'courseId' = ${courseId}
            AND state = 'running'
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT 1`;
        const runningJobId = runningRows.length ? String(runningRows[0]!.id) : null;
        const privacyEpoch = Number((workspace as { privacy_epoch?: number }).privacy_epoch ?? 0);
        const payload = { courseId };
        const baseKey = `build-course-knowledge:${courseId}:sync:${reasonKey}:${runningJobId ?? "idle"}`;

        const tryInsert = async (jobKey: string) => {
          const id = randomUUID();
          const inserted = await tx`
            INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
            VALUES (
              ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${jobKey},
              ${"build-course-knowledge"}, ${tx.json(payload as never)}, ${privacyEpoch}
            )
            ON CONFLICT (workspace_id, key) DO NOTHING
            RETURNING id`;
          if (inserted.length) {
            await tx`
              INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
              VALUES (
                ${scope.workspaceId}, ${id}, ${"opening.job.enqueue"},
                ${tx.json({ jobId: id, kind: "build-course-knowledge", courseId } as never)}
              )`;
            return { jobId: id, kind: "build-course-knowledge" as const, created: true };
          }
          return null;
        };

        const created = await tryInsert(baseKey);
        if (created) return created;

        const existing = await tx`
          SELECT id, state, payload FROM opening_jobs
          WHERE workspace_id = ${scope.workspaceId} AND key = ${baseKey}`;
        const row = existing[0] as Record<string, unknown> | undefined;
        if (!row) throw new OpeningKnowledgeError("NOT_FOUND", "rebuild job disappeared after conflict");
        if (JSON.stringify(row.payload) !== JSON.stringify(payload)) {
          throw new OpeningKnowledgeError("CONFLICT", "idempotency payload differs for the same key");
        }
        const existingState = typeof row.state === "string" ? row.state : undefined;
        if (
          existingState !== undefined
          && existingState !== "queued"
          && existingState !== "running"
        ) {
          // A previous completed job held this historical key; under the course lock, enqueue a fresh job.
          const fresh = await tryInsert(`${baseKey}:${randomUUID()}`);
          if (fresh) return fresh;
        }
        return { jobId: String(row.id), kind: "build-course-knowledge" as const, created: false };
      });
    },

    /**
     * Mark snapshot nodes/edges needs_check when listed sources change.
     * Returns courseIds whose source_versions listed any of the ids (even if already
     * needs_check / not dirty) so callers can enqueue full-course rebuilds.
     */
    async markNeedsCheckForSources(
      scope: Scope,
      sourceIds: readonly string[],
      options?: { courseId?: string },
    ): Promise<{ updated: number; courseIds: string[] }> {
      const ids = [...new Set(sourceIds)].sort();
      if (!ids.length) return { updated: 0, courseIds: [] };
      return sql.begin(async (tx) => {
        // Same workspace -> graph order as confirm/replace; maintenance cannot race a receipt insert.
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningKnowledgeError("NOT_FOUND", "workspace not found");
        const rows = options?.courseId
          ? await tx`
              SELECT workspace_id, course_id, version, snapshot, source_versions
              FROM opening_course_knowledge
              WHERE workspace_id = ${scope.workspaceId}
                AND owner_user_id = ${scope.ownerUserId}
                AND course_id = ${options.courseId}
              FOR UPDATE`
          : await tx`
              SELECT workspace_id, course_id, version, snapshot, source_versions
              FROM opening_course_knowledge
              WHERE workspace_id = ${scope.workspaceId}
                AND owner_user_id = ${scope.ownerUserId}
              FOR UPDATE`;
        let updated = 0;
        const courseIds: string[] = [];
        for (const row of rows as Array<Record<string, unknown>>) {
          const sourceVersions = parseSourceVersions(row.source_versions);
          if (!ids.some((id) => id in sourceVersions)) continue;
          const courseId = String(row.course_id);
          courseIds.push(courseId);
          // Revoke even if the graph was already needs_check; the CAS fence advances below.
          await tx`DELETE FROM opening_knowledge_confirmations WHERE workspace_id=${scope.workspaceId}
            AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
          const snapshot = knowledgeSnapshotSchema.parse(row.snapshot);
          let dirty = false;
          const nodes = snapshot.nodes.map((node) => {
            if (node.status === "needs_check") return node;
            dirty = true;
            return { ...node, status: "needs_check" as const };
          });
          const edges = snapshot.edges.map((edge) => {
            if (edge.status === "needs_check") return edge;
            dirty = true;
            return { ...edge, status: "needs_check" as const };
          });
          // Even an already-pending graph needs a new CAS fence: a confirmation submitted before
          // this maintenance must conflict after it, rather than approve the invalidated view.
          const version = Number(row.version) + 1;
          const next: KnowledgeSnapshot = { ...snapshot, version, nodes, edges };
          await tx`
            UPDATE opening_course_knowledge
            SET version = ${version}, snapshot = ${tx.json(next as never)}, updated_at = now()
            WHERE workspace_id = ${row.workspace_id as string}
              AND course_id = ${row.course_id as string}
              AND version = ${Number(row.version)}`;
          if (dirty) updated += 1;
        }
        return { updated, courseIds };
      });
    },

    async reconcileCourseMaterials(
      scope: Scope,
      courseId: string,
      options?: {
        invalidatedSourceIds?: readonly string[];
        coveredSourceVersions?: Record<string, number>;
      },
    ): Promise<{
      sync: CourseKnowledgeSync;
      enqueued: { jobId: string; kind: "build-course-knowledge"; created: boolean } | null;
    }> {
      await assertOwnedCourse(sql, scope, courseId);
      const knowledgeRows = await sql`
        SELECT version, snapshot, source_versions
        FROM opening_course_knowledge
        WHERE workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND course_id = ${courseId}`;
      const existingRecord = knowledgeRows.length ? mapRecord(knowledgeRows[0] as Record<string, unknown>) : null;
      const attachedRows = await sql`
        SELECT m.asset_id AS source_id, s.version,
          EXISTS (
            SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = m.workspace_id AND e.source_id = m.asset_id
          ) AS excluded
        FROM course_asset_memberships m
        LEFT JOIN opening_sources s
          ON s.id = m.asset_id AND s.workspace_id = m.workspace_id
        WHERE m.workspace_id = ${scope.workspaceId}
          AND m.course_id = ${courseId}
          AND m.asset_type = 'source'
          AND (m.purpose IS NULL OR m.purpose = 'teaching')`;
      const attachedById = new Map(
        (attachedRows as Array<Record<string, unknown>>).map((row) => [
          String(row.source_id),
          {
            version: row.version == null ? null : Number(row.version),
            excluded: Boolean(row.excluded),
          },
        ]),
      );
      const invalidated = new Set<string>(options?.invalidatedSourceIds ?? []);
      if (existingRecord) {
        for (const [sourceId, builtVersion] of Object.entries(existingRecord.sourceVersions)) {
          const attached = attachedById.get(sourceId);
          if (!attached || attached.excluded || attached.version === null || attached.version !== builtVersion) {
            invalidated.add(sourceId);
          }
        }
        if ([...invalidated].some((id) => id in existingRecord.sourceVersions)) {
          await this.markNeedsCheckForSources(scope, [...invalidated], { courseId });
        }
      }

      const initial = await readSyncStatusInSnapshot(sql, scope, courseId, { computeProtection: true });
      if (initial.rebuildBlockedByMaterials) {
        return { sync: initial.sync, enqueued: null };
      }
      const effectiveCovered = options?.coveredSourceVersions ?? initial.sync.coveredSourceVersions;
      const graphSources = initial.record?.sourceVersions ?? {};
      const hasGraphOrStaleSources = Boolean(
        initial.record
          && (initial.record.snapshot.nodes.length > 0 || Object.keys(graphSources).length > 0),
      );
      const shouldRebuild =
        hasMaterialDrift(effectiveCovered, graphSources, initial.sync.eligibleSourceVersions)
        && (Object.keys(initial.sync.eligibleSourceVersions).length > 0 || hasGraphOrStaleSources);
      if (!shouldRebuild) {
        return { sync: initial.sync, enqueued: null };
      }
      const enqueued = await this.enqueueCoalescedRebuild(
        scope,
        courseId,
        sourceVersionsHash(initial.sync.eligibleSourceVersions),
      );
      const sync = enqueued.created
        ? (await readSyncStatusInSnapshot(sql, scope, courseId)).sync
        : initial.sync;
      return { sync, enqueued };
    },

    async reconcileCoursesForSource(
      scope: Scope,
      input: { sourceId: string; markInvalidated?: boolean },
    ): Promise<{
      courseIds: string[];
      results: Array<{
        courseId: string;
        sync: CourseKnowledgeSync;
        enqueued: { jobId: string; kind: "build-course-knowledge"; created: boolean } | null;
      }>;
    }> {
      const courseRows = await sql`
        SELECT DISTINCT c.id AS course_id
        FROM courses c
        JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.workspace_id = ${scope.workspaceId}
          AND w.owner_user_id = ${scope.ownerUserId}
          AND c.archived_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM course_asset_memberships m
              WHERE m.workspace_id = c.workspace_id
                AND m.course_id = c.id
                AND m.asset_type = 'source'
                AND m.asset_id = ${input.sourceId}
                AND (m.purpose IS NULL OR m.purpose = 'teaching')
            )
            OR EXISTS (
              SELECT 1 FROM opening_course_knowledge k
              WHERE k.workspace_id = c.workspace_id
                AND k.owner_user_id = ${scope.ownerUserId}
                AND k.course_id = c.id
                AND k.source_versions ? ${input.sourceId}
            )
            OR EXISTS (
              SELECT 1 FROM opening_jobs j
              WHERE j.workspace_id = c.workspace_id
                AND j.owner_user_id = ${scope.ownerUserId}
                AND j.kind = 'build-course-knowledge'
                AND j.state = 'succeeded'
                AND j.payload->>'courseId' = c.id::text
                AND (j.result->'coveredSourceVersions') ? ${input.sourceId}
            )
          )
        ORDER BY c.id`;
      const courseIds = (courseRows as Array<Record<string, unknown>>).map((row) => String(row.course_id));
      const results: Array<{
        courseId: string;
        sync: CourseKnowledgeSync;
        enqueued: { jobId: string; kind: "build-course-knowledge"; created: boolean } | null;
      }> = [];
      for (const courseId of courseIds) {
        const reconciled = await this.reconcileCourseMaterials(
          scope,
          courseId,
          input.markInvalidated ? { invalidatedSourceIds: [input.sourceId] } : undefined,
        );
        results.push({ courseId, ...reconciled });
      }
      return { courseIds, results };
    },
  };
}

export type OpeningKnowledgeRepository = ReturnType<typeof createOpeningKnowledgeRepository>;
