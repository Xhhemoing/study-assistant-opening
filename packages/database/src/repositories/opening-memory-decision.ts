import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { isLineageUuid, lineageUuid, memoryCourseAllows, memoryDependencyWalk, type FragmentFactory } from "./opening-context-provenance";
import { lockAndReadMemoryOrigins, lockOwnedWorkspace, readBareUserOrigins } from "./opening-memory-admission";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readMemoryMisconceptionAuthorities, sourceTurnsMisconceptionMemoryStatus } from "./v3-bitemporal-misconception-memory";
import { OpeningMemoryError, mapMemoryRow } from "./opening-memory-types";
import { advanceOpeningWorkspacePrivacyEpoch, withOpeningTutorStreamFenceCommit } from "./opening-tutor-stream-fence";

export function confirmOwnedMemory(
  sql: Sql,
  scope: OpeningScope,
  id: string,
  expectedVersion: number,
  clientKey: string,
  now: () => Date = () => new Date(),
): Promise<MemoryItem> {
  return sql.begin(async (tx) => {
    const owners = await tx`SELECT id FROM workspaces
      WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
    if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
    // Fence before business locks; retain the original locked ownership re-read.
    try {
      await lockWorkspaceLearningHistory(tx, scope);
    } catch (error) {
      if (error instanceof Error && "code" in error
        && error.code === "NOT_FOUND" && error.message === "workspace not found") {
        throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
      }
      throw error;
    }
    await lockOwnedWorkspace(tx, scope);
    const rows = await tx`
      SELECT * FROM opening_memories
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
        AND (course_id IS NULL OR EXISTS (
          SELECT 1 FROM courses c WHERE c.id = opening_memories.course_id
            AND c.workspace_id = opening_memories.workspace_id AND c.archived_at IS NULL FOR SHARE
        ))
      FOR UPDATE`;
    if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
    const row = rows[0] as Record<string, unknown>;
    const current = mapMemoryRow(row);
    if (
      current.status === "active"
      && current.kind === "confirmed"
      && row.last_decision_client_key === clientKey
    ) {
      return current;
    }
    if (current.version !== expectedVersion) {
      throw new OpeningMemoryError("CONFLICT", "stale memory version");
    }
    if (current.status !== "active" || current.kind === "confirmed") {
      throw new OpeningMemoryError("CONFLICT", "memory cannot be confirmed");
    }
    let expiryBeforeCommit: string | null = null;
    const bareOrigins = current.courseId === null && current.kind !== "temporary"
      && current.sourceTurnIds.length > 0 && current.sourceTurnIds.every(isLineageUuid)
      && (await readBareUserOrigins(tx, scope, current.sourceTurnIds)).size
        === new Set(current.sourceTurnIds.map(turnId => turnId.toLowerCase())).size;
    let originTurnIds: string[] = [];
    let ancestorMemoryIds: string[] = [];
    const assertMisconceptionOrigins = async () => {
      if (bareOrigins) return Infinity;
      const active = await readMemoryMisconceptionAuthorities(tx, scope, ancestorMemoryIds, current.courseId);
      const sourceStatus = await sourceTurnsMisconceptionMemoryStatus(tx, scope, originTurnIds, current.courseId);
      if (active.size !== ancestorMemoryIds.length || !sourceStatus.allowed) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency misconception is unavailable");
      }
      return Math.min(sourceStatus.earliestExpiresAtMs, ...[...active.values()].map(auth => auth.earliestExpiresAtMs));
    };
    if (!bareOrigins && (current.courseId !== null || current.kind === "temporary" || current.sourceTurnIds.length > 0)) {
      const memoryCourse: FragmentFactory = () => tx`m.course_id`;
      const workspace: FragmentFactory = () => tx`m.workspace_id`;
      const [admitted] = await tx<{ id: string; ancestor_temporary_expires_at: Date | null; origin_turn_ids: string[] }[]>`
        SELECT m.id, chain.temporary_expires_at AS ancestor_temporary_expires_at, m.source_turn_ids AS origin_turn_ids
        FROM opening_memories m
        CROSS JOIN LATERAL (
          WITH RECURSIVE mem_deps(dep_id) AS (${memoryDependencyWalk(tx)})
          SELECT min(dep_m.expires_at) FILTER (WHERE dep_m.kind = 'temporary') AS temporary_expires_at,
            COALESCE(bool_and(
              dep_m.id IS NOT NULL AND dep_m.id <> m.id AND dep_m.status = 'active'
              AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at > clock_timestamp())) IS TRUE
              AND ${memoryCourseAllows(tx, () => tx`dep_m.course_id`, memoryCourse, workspace)} IS TRUE
            ), true) AS all_active
          FROM mem_deps d
          LEFT JOIN opening_memories dep_m ON dep_m.id = ${lineageUuid(tx, () => tx`d.dep_id`)}
            AND dep_m.workspace_id = m.workspace_id
        ) chain
        WHERE m.id = ${id} AND m.workspace_id = ${scope.workspaceId} AND m.status = 'active'
          AND ${memoryCourseAllows(tx, memoryCourse, memoryCourse, workspace)}
          AND (m.kind <> 'temporary' OR m.expires_at > clock_timestamp()) AND chain.all_active`;
      if (!admitted) throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      originTurnIds = admitted.origin_turn_ids ?? [];
      const origin = originTurnIds.length ? (await lockAndReadMemoryOrigins(tx, scope, [{
        id: id.toLowerCase(), excludedId: id.toLowerCase(), course_id: current.courseId, turn_ids: originTurnIds,
      }], { writeAdmission: true })).get(id.toLowerCase()) : undefined;
      ancestorMemoryIds = [...(origin?.ids ?? [])];
      if (origin === null) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
      const misconceptionExpiry = await assertMisconceptionOrigins();
      const ancestorExpiry = admitted.ancestor_temporary_expires_at;
      const expiry = Math.min(
        current.kind === "temporary" ? Date.parse(current.expiresAt ?? "") : Infinity,
        ancestorExpiry == null ? Infinity : new Date(ancestorExpiry).getTime(),
        origin?.expiresAt ?? Infinity,
        misconceptionExpiry,
      );
      if (Number.isNaN(expiry) || expiry <= now().getTime()) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
      if (Number.isFinite(expiry)) expiryBeforeCommit = new Date(expiry).toISOString();
    }
    const updated = await tx`
      UPDATE opening_memories
      SET kind = 'confirmed', expires_at = NULL, version = ${current.version + 1},
          last_decision_client_key = ${clientKey}, updated_at = now()
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
        AND version = ${expectedVersion} AND status = 'active'
      RETURNING *`;
    if (!updated.length) throw new OpeningMemoryError("CONFLICT", "confirm raced");
    const postUpdateExpiry = await assertMisconceptionOrigins();
    if (Number.isFinite(postUpdateExpiry) && (expiryBeforeCommit === null || postUpdateExpiry < Date.parse(expiryBeforeCommit))) {
      expiryBeforeCommit = new Date(postUpdateExpiry).toISOString();
    }
    if (expiryBeforeCommit !== null) {
      const [expiry] = await tx`SELECT ${expiryBeforeCommit}::timestamptz > clock_timestamp() AS still_active`;
      if (!expiry?.still_active) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
    }
    return mapMemoryRow(updated[0] as Record<string, unknown>);
  });
}

export function rejectOwnedMemory(
  sql: Sql,
  scope: OpeningScope,
  id: string,
  expectedVersion: number,
  clientKey: string,
): Promise<MemoryItem> {
  return withOpeningTutorStreamFenceCommit(sql, async (tx) => {
    const owners = await tx`SELECT id FROM workspaces
      WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
    if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
    // Fence before business locks; retain the original locked ownership re-read.
    try {
      await lockWorkspaceLearningHistory(tx, scope);
    } catch (error) {
      if (error instanceof Error && "code" in error
        && error.code === "NOT_FOUND" && error.message === "workspace not found") {
        throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
      }
      throw error;
    }
    await lockOwnedWorkspace(tx, scope);
    const rows = await tx`
      SELECT * FROM opening_memories
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
    if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
    const row = rows[0] as Record<string, unknown>;
    const current = mapMemoryRow(row);
    if (current.status === "rejected" && row.last_decision_client_key === clientKey) {
      return current;
    }
    if (current.version !== expectedVersion) {
      throw new OpeningMemoryError("CONFLICT", "stale memory version");
    }
    if (current.status !== "active") {
      throw new OpeningMemoryError("CONFLICT", "memory cannot be rejected");
    }
    const updated = await tx`
      UPDATE opening_memories
      SET status = 'rejected', version = ${current.version + 1},
          last_decision_client_key = ${clientKey}, updated_at = now()
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
        AND version = ${expectedVersion}
      RETURNING *`;
    if (!updated.length) throw new OpeningMemoryError("CONFLICT", "reject raced");
    await advanceOpeningWorkspacePrivacyEpoch(tx, scope);
    return mapMemoryRow(updated[0] as Record<string, unknown>);
  });
}
