import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import {
  lineageUuid, memoryCourseAllows, parseContextMemoryDependencyIds, readMemoryDependencyStatus, resolveMemoryDependencyStatus,
  turnDependencyWalk, turnLineageCourse, turnMemoryOnlyBackingIds, turnPinnedSourceRefs, type FragmentFactory,
} from "./opening-context-provenance";
import { OpeningMemoryError } from "./opening-memory-types";

type Db = Sql | TransactionSql;

/** Workspace row lock first. Callers must not touch memory rows before this. */
export async function lockOwnedWorkspace(db: Db, scope: OpeningScope): Promise<void> {
  const owners = await db`
    SELECT id FROM workspaces
    WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR UPDATE`;
  if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
}

/** Turn material rows retain version pins and document identity independent of context provenance. */
export function turnMaterialRows(db: Db): ReturnType<Db> {
  return db`
    SELECT sid.id::text AS source_id, NULL::text AS version, false AS version_required
    FROM unnest(t.source_ids) sid(id)
    UNION ALL
    SELECT ref->>'sourceId', ref->>'sourceVersion', true
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.citations) = 'array' THEN t.citations ELSE '[]'::jsonb END
      || CASE WHEN t.role = 'assistant' AND jsonb_typeof(t.context_source_refs) = 'array'
        THEN t.context_source_refs ELSE '[]'::jsonb END) ref
    WHERE NOT (ref = jsonb_build_object('memoryDependencyIds', ref->'memoryDependencyIds')
      AND jsonb_typeof(ref->'memoryDependencyIds') = 'array'
      AND ref->'memoryDependencyIds' <> '[]'::jsonb)
    UNION ALL
    SELECT pin.source_id, CASE WHEN pin.source_version IS NULL THEN NULL
      WHEN jsonb_typeof(pin.source_version) = 'number' THEN pin.source_version #>> '{}' ELSE '' END, pin.version_required
    FROM (${turnPinnedSourceRefs(db, () => db`t.source_versions`, () => db`t.context_anchor`)}) pin`;
}

export function turnSourceMaterialsActive(
  db: Db, workspaceId: string, options?: { memoryCourse: FragmentFactory; excluded?: readonly string[] },
): ReturnType<Db> {
  return db`NOT EXISTS (
    SELECT 1 FROM (${turnMaterialRows(db)}) ref
    LEFT JOIN opening_sources s ON s.id = ${lineageUuid(db, () => db`ref.source_id`)}
      AND s.workspace_id = ${workspaceId} AND s.upload_state = 'uploaded'
    LEFT JOIN opening_source_versions sv ON sv.workspace_id = s.workspace_id AND sv.source_id = s.id
      AND sv.version::text = COALESCE(ref.version, s.version::text) AND sv.availability = 'unavailable'
    LEFT JOIN opening_privacy_exclusions e ON e.workspace_id = s.workspace_id AND e.source_id = s.id
    WHERE s.id IS NULL OR sv.source_id IS NOT NULL OR e.source_id IS NOT NULL
      OR (ref.version_required AND ref.version IS NULL)
      OR (ref.version IS NOT NULL AND ref.version <> s.version::text)
      ${options ? db`OR s.id = ANY(${options.excluded ?? []}::uuid[]) OR (
        SELECT COALESCE(bool_or(cam.purpose = 'mock_exam'), false)
          OR CASE WHEN ${options.memoryCourse()} IS NULL THEN count(cam.purpose) > 0
            ELSE NOT COALESCE(bool_or(cam.course_id = ${options.memoryCourse()}
              AND cam.purpose IS DISTINCT FROM 'practice' AND cam.purpose IS DISTINCT FROM 'mock_exam'), false) END
        FROM course_asset_memberships cam
        WHERE cam.asset_id = s.id AND cam.workspace_id = s.workspace_id AND cam.asset_type = 'source'
      )` : db``}
  ) AND jsonb_typeof(t.source_versions) = 'object'
    AND jsonb_typeof(t.citations) = 'array'
    AND (t.role <> 'assistant' OR t.context_source_refs IS NULL OR jsonb_typeof(t.context_source_refs) = 'array')`;
}

/**
 * Require owned turns, currently allowed material, and usable memory ancestry.
 * Replacement excludes the memory that this transaction will supersede.
 */
export async function assertSourceTurnsOwned(
  db: Db,
  scope: OpeningScope,
  sourceTurnIds: readonly string[],
  excludeMemoryId: string | null = null,
  targetCourseId: string | null = null,
): Promise<void> {
  if (!sourceTurnIds.length) return;
  const unique = [...new Set(sourceTurnIds.map(id => id.toLowerCase()))];
  const ownCourseId: FragmentFactory = () => db`course.id`;
  const workspace: FragmentFactory = () => db`t.workspace_id`;
  const dependencyCourse: FragmentFactory = () => db`dep_m.course_id`;
  const rows = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns t
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t", () => db`c.course_id`)} AS id) course
    WHERE t.workspace_id = ${scope.workspaceId} AND c.owner_user_id = ${scope.ownerUserId}
      AND t.id = ANY(${unique}::uuid[])
      AND NOT COALESCE(t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb, false)
      AND ${turnSourceMaterialsActive(db, scope.workspaceId)}
      AND NOT EXISTS (
        WITH RECURSIVE mem_deps(dep_id) AS (${turnDependencyWalk(db, "t")})
        SELECT 1 FROM mem_deps d
        WHERE d.dep_id = ${excludeMemoryId}::uuid::text OR NOT EXISTS (
          SELECT 1 FROM opening_memories dep_m
          WHERE dep_m.id = ${lineageUuid(db, () => db`d.dep_id`)} AND dep_m.workspace_id = t.workspace_id
            AND dep_m.status = 'active'
            AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at > clock_timestamp()))
            AND ${memoryCourseAllows(db, dependencyCourse, () => db`${targetCourseId}::uuid`, workspace)}
            AND (dep_m.course_id IS NULL OR dep_m.course_id = ${ownCourseId()})
        )
      )`;
  if (rows.length === unique.length) return;

  const admitted = new Set(rows.map(row => row.id));
  const unresolved = unique.filter(id => !admitted.has(id));
  const memoryOnly = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns t
    WHERE t.workspace_id = ${scope.workspaceId} AND t.id = ANY(${unresolved}::uuid[])
      AND t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb`;
  if (memoryOnly.length === unresolved.length) {
    const origins = await readMemoryOrigins(db, scope, memoryOnly.map(({ id }) => ({
      id, course_id: targetCourseId?.toLowerCase() ?? null, turn_ids: [id], excludedId: excludeMemoryId?.toLowerCase(),
    })));
    if (unresolved.every(id => origins.get(id) != null)) return;
  }
  throw new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
}

type MemoryOrigin = { id: string; course_id: string | null; turn_ids: string[]; excludedId?: string };

/** Check the small set of source turns selected by the memory read. */
export async function readMemoryOrigins(
  db: Db, scope: OpeningScope, origins: MemoryOrigin[], context?: { excluded?: readonly string[] },
) {
  const result = new Map<string, { ids: Set<string>; expiresAt: number } | null>();
  if (!origins.length) return result;
  const rows = await db<{ id: string; turn_course_id: string | null; refs: unknown; backings: string[][] }[]>`
    SELECT m.id, course.id AS turn_course_id, t.context_source_refs AS refs,
      ${turnMemoryOnlyBackingIds(db, () => db`t.context_source_refs`, () => db`course.id`, scope)} AS backings
    FROM jsonb_to_recordset(${db.json(origins)}::jsonb) m(id uuid, course_id uuid, turn_ids uuid[])
    CROSS JOIN LATERAL unnest(m.turn_ids) ref(turn_id)
    JOIN opening_turns t ON t.id = ref.turn_id AND t.workspace_id = ${scope.workspaceId}
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id AND c.owner_user_id = ${scope.ownerUserId}
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t", () => db`c.course_id`)} AS id) course
    WHERE ${turnSourceMaterialsActive(db, scope.workspaceId, context && { memoryCourse: () => db`m.course_id`, ...context })}
      ${context ? db`AND (t.role <> 'assistant' OR t.context_source_refs IS NOT NULL)` : db``}`;
  const bindings = rows.map(row => ({ ...row, ids: row.refs == null ? [] : parseContextMemoryDependencyIds(row.refs) }));
  const roots = [...new Set(bindings.flatMap(row => [...(row.ids ?? []), ...row.backings.flat()]))];
  const graph = await readMemoryDependencyStatus(db, scope.workspaceId, roots);
  const byMemory = new Map<string, typeof bindings>();
  for (const row of bindings) {
    const group = byMemory.get(row.id);
    if (group) group.push(row);
    else byMemory.set(row.id, [row]);
  }
  for (const origin of origins) {
    const group = byMemory.get(origin.id) ?? [];
    const nodes = group.map(row => row.ids === null ? null
      : resolveMemoryDependencyStatus(graph, row.ids, row.backings, row.turn_course_id, origin.excludedId));
    const dependencies = nodes.flatMap(node => node ?? []);
    if (group.length !== origin.turn_ids.length || nodes.some(node => node === null)
      || dependencies.some(node => node.course_id !== null && node.course_id !== origin.course_id)) {
      result.set(origin.id, null);
      continue;
    }
    result.set(origin.id, {
      ids: new Set(dependencies.map(node => node.dep_id)),
      expiresAt: dependencies.reduce((expiresAt, node) => node.expires_at === null ? expiresAt
        : Math.min(expiresAt, new Date(node.expires_at).getTime()), Infinity),
    });
  }
  return result;
}

/** courses has workspace_id only; ownership is the already-locked workspace owner. */
export async function assertCourseInWorkspace(
  db: Db,
  scope: OpeningScope,
  courseId: string | null | undefined,
  requireActive = false,
): Promise<void> {
  if (courseId == null) return;
  const rows = await db`
    SELECT id FROM courses
    WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId}
      AND (${!requireActive} OR archived_at IS NULL)
    LIMIT 1`;
  if (!rows.length) {
    throw new OpeningMemoryError("VALIDATION", "course is not in this workspace");
  }
}
