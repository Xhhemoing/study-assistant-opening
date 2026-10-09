import { randomUUID } from "node:crypto";
import {
  knowledgeSnapshotSchema,
  type KnowledgeSnapshot,
  type SourceChunk,
  type Scope,
} from "@aistudy/contracts";
import { validateKnowledgeSnapshot } from "@aistudy/domain";
import type { Sql } from "postgres";
import { mapChunk } from "./opening-source-chunks";

export type OpeningKnowledgeErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningKnowledgeError extends Error {
  readonly code: OpeningKnowledgeErrorCode;
  constructor(code: OpeningKnowledgeErrorCode, message: string) {
    super(message);
    this.name = "OpeningKnowledgeError";
    this.code = code;
  }
}

export type AuthorizedKnowledgeChunk = SourceChunk & { courseId: string };

export type OpeningKnowledgeRecord = {
  version: number;
  snapshot: KnowledgeSnapshot;
  sourceVersions: Record<string, number>;
};

export type ReplaceKnowledgeInput = {
  expectedVersion: number;
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

function parseSourceVersions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) out[key] = n;
  }
  return out;
}

function mapRecord(row: Record<string, unknown>): OpeningKnowledgeRecord {
  const snapshot = knowledgeSnapshotSchema.parse(row.snapshot);
  return {
    version: Number(row.version),
    snapshot: { ...snapshot, version: Number(row.version) },
    sourceVersions: parseSourceVersions(row.source_versions),
  };
}

async function assertOwnedCourse(sql: Sql, scope: Scope, courseId: string): Promise<void> {
  const rows = await sql`
    SELECT c.id FROM courses c
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ${courseId}
      AND c.workspace_id = ${scope.workspaceId}
      AND w.owner_user_id = ${scope.ownerUserId}
      AND c.archived_at IS NULL`;
  if (!rows.length) throw new OpeningKnowledgeError("NOT_FOUND", "course not found");
}

/** Evidence chunks must belong to course-linked, uploaded sources in this workspace. */
async function assertAuthorizedChunkRefs(
  tx: Sql,
  scope: Scope,
  courseId: string,
  snapshot: KnowledgeSnapshot,
  sourceVersions: Record<string, number>,
): Promise<void> {
  const chunkIds = [
    ...new Set([
      ...snapshot.nodes.flatMap((node) => node.evidenceChunkIds),
      ...snapshot.edges.flatMap((edge) => edge.evidenceChunkIds),
    ]),
  ].sort();
  if (!chunkIds.length) {
    if (Object.keys(sourceVersions).length) {
      throw new OpeningKnowledgeError("VALIDATION", "sourceVersions provided without evidence chunks");
    }
    return;
  }

  const rows = await tx`
    SELECT c.id, c.source_id, c.source_version
    FROM opening_source_chunks c
    JOIN opening_sources s ON s.id = c.source_id
    JOIN course_asset_memberships m
      ON m.workspace_id = s.workspace_id
      AND m.asset_type = 'source'
      AND m.asset_id = s.id
      AND m.course_id = ${courseId}
    WHERE s.workspace_id = ${scope.workspaceId}
      AND s.upload_state = 'uploaded'
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
}

export function createOpeningKnowledgeRepository(sql: Sql) {
  return {
    async get(scope: Scope, courseId: string): Promise<OpeningKnowledgeRecord | null> {
      await assertOwnedCourse(sql, scope, courseId);
      const rows = await sql`
        SELECT version, snapshot, source_versions
        FROM opening_course_knowledge
        WHERE workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND course_id = ${courseId}`;
      if (!rows.length) return null;
      return mapRecord(rows[0] as Record<string, unknown>);
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
        JOIN course_asset_memberships m
          ON m.workspace_id = s.workspace_id
          AND m.asset_type = 'source'
          AND m.asset_id = s.id
          AND m.course_id = ${courseId}
        WHERE s.workspace_id = ${scope.workspaceId}
          AND s.upload_state = 'uploaded'
          AND s.parse_state = 'ready'
          AND c.source_version = s.version
          AND (c.text ~ '[^[:space:]]' OR (c.image_object_key IS NOT NULL AND c.image_object_key <> ''))
        ORDER BY c.source_id, c.page NULLS LAST, c.created_at`;
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        return { ...mapChunk(record), courseId: String(record.course_id) };
      });
    },

    /**
     * CAS replace. Stores newVersion = expectedVersion + 1.
     * Snapshot.version from the caller is overwritten to newVersion.
     * Soft-idempotent: if row already at expectedVersion+1 with the same graph, returns it.
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

        const currentRows = await tx`
          SELECT version, snapshot, source_versions FROM opening_course_knowledge
          WHERE workspace_id = ${scope.workspaceId} AND course_id = ${courseId}
          FOR UPDATE`;
        const current = currentRows[0] as Record<string, unknown> | undefined;
        const currentVersion = current ? Number(current.version) : 0;

        if (current && currentVersion === newVersion) {
          const existing = mapRecord(current);
          if (sameGraph(existing.snapshot, draft)) return existing;
        }
        if (currentVersion !== input.expectedVersion) {
          throw new OpeningKnowledgeError("CONFLICT", "stale knowledge version");
        }

        await assertAuthorizedChunkRefs(tx, scope, courseId, draft, sourceVersions);

        const stored: KnowledgeSnapshot = { ...draft, version: newVersion };
        const rows = await tx`
          INSERT INTO opening_course_knowledge (
            workspace_id, owner_user_id, course_id, version, snapshot, source_versions, updated_at
          ) VALUES (
            ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId}, ${newVersion},
            ${tx.json(stored as never)}, ${tx.json(sourceVersions as never)}, now()
          )
          ON CONFLICT (workspace_id, course_id) DO UPDATE SET
            version = EXCLUDED.version,
            snapshot = EXCLUDED.snapshot,
            source_versions = EXCLUDED.source_versions,
            owner_user_id = EXCLUDED.owner_user_id,
            updated_at = now()
          WHERE opening_course_knowledge.version = ${input.expectedVersion}
          RETURNING version, snapshot, source_versions`;
        if (!rows.length) throw new OpeningKnowledgeError("CONFLICT", "knowledge replace raced");
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
        const privacyEpoch = Number((workspace as { privacy_epoch?: number }).privacy_epoch ?? 0);
        const jobId = randomUUID();
        const payload = { courseId };
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

    /**
     * Mark snapshot nodes/edges needs_check when listed sources change.
     * Returns courseIds whose source_versions listed any of the ids (even if already
     * needs_check / not dirty) so callers can enqueue full-course rebuilds.
     */
    async markNeedsCheckForSources(
      scope: Scope,
      sourceIds: readonly string[],
    ): Promise<{ updated: number; courseIds: string[] }> {
      const ids = [...new Set(sourceIds)].sort();
      if (!ids.length) return { updated: 0, courseIds: [] };
      return sql.begin(async (tx) => {
        const rows = await tx`
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
          if (!dirty) continue;
          const next: KnowledgeSnapshot = { ...snapshot, nodes, edges };
          await tx`
            UPDATE opening_course_knowledge
            SET snapshot = ${tx.json(next as never)}, updated_at = now()
            WHERE workspace_id = ${row.workspace_id as string}
              AND course_id = ${row.course_id as string}
              AND version = ${Number(row.version)}`;
          updated += 1;
        }
        return { updated, courseIds };
      });
    },
  };
}

export type OpeningKnowledgeRepository = ReturnType<typeof createOpeningKnowledgeRepository>;
