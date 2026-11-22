import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import {
  lineageUuid, memoryCourseAllows, parseContextMemoryDependencyIds, resolveMemoryDependencyStatus,
  turnDependencyWalk, turnLineageCourse, turnMaterialUse, turnMemoryOnlyBackingIds, turnPinnedSourceRefs, type FragmentFactory,
  type MemoryDependencyStatus,
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

export async function lockActiveMemoryCourse(db: Db, scope: OpeningScope, courseId: string): Promise<boolean> {
  const rows = await db`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}
    AND archived_at IS NULL ORDER BY id FOR SHARE`;
  return rows.length > 0;
}

/** Lock sources before memberships to serialize both first classification and removal. */
export async function lockMemoryMaterialSources(db: Db, scope: OpeningScope, sourceIds: Set<string>): Promise<string[]> {
  if (!sourceIds.size) return [];
  const sources = await db<{ id: string }[]>`SELECT id FROM opening_sources WHERE workspace_id=${scope.workspaceId}
    AND id=ANY(${[...sourceIds].sort()}::uuid[]) ORDER BY id FOR SHARE`;
  const lockedIds = sources.map(source => source.id);
  if (lockedIds.length) {
    await db`SELECT id FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
      AND asset_type='source' AND asset_id=ANY(${lockedIds}::uuid[]) ORDER BY asset_id, course_id FOR SHARE`;
  }
  return lockedIds;
}

/** Turn material rows retain version pins and document identity independent of context provenance. */
export function turnMaterialRows(db: Db, includeUserContext = false): ReturnType<Db> {
  return db`
    SELECT sid.id::text AS source_id, NULL::text AS version, false AS version_required, false AS memory_only
    FROM unnest(t.source_ids) sid(id)
    UNION ALL
    SELECT citation->>'sourceId', CASE WHEN jsonb_typeof(citation->'sourceVersion') = 'number' THEN citation->>'sourceVersion' END, true, false
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.citations) = 'array' THEN t.citations ELSE '[]'::jsonb END) citation
    UNION ALL
    SELECT ref->>'sourceId', CASE WHEN jsonb_typeof(ref->'sourceVersion') = 'number' THEN ref->>'sourceVersion' END,
      true, COALESCE(ref->'memoryOnly' = 'true'::jsonb, false)
    FROM jsonb_array_elements(CASE WHEN (${includeUserContext} OR t.role = 'assistant')
      AND jsonb_typeof(t.context_source_refs) = 'array' THEN t.context_source_refs ELSE '[]'::jsonb END) ref
    WHERE NOT (ref = jsonb_build_object('memoryDependencyIds', ref->'memoryDependencyIds')
      AND jsonb_typeof(ref->'memoryDependencyIds') = 'array'
      AND ref->'memoryDependencyIds' <> '[]'::jsonb)
    UNION ALL
    SELECT pin.source_id, CASE WHEN pin.source_version IS NULL THEN NULL
      WHEN jsonb_typeof(pin.source_version) = 'number' THEN pin.source_version #>> '{}' ELSE '' END, pin.version_required, false
    FROM (${turnPinnedSourceRefs(db, () => db`t.source_versions`, () => db`t.context_anchor`)}) pin
    UNION ALL
    SELECT k.source_id::text, k.source_version::text, true, false
    FROM (SELECT t.chunk_id AS id WHERE t.chunk_id IS NOT NULL) saved
    LEFT JOIN opening_source_chunks k ON k.id = saved.id`;
}

export function sourceMaterialsActive(
  db: Db, workspaceId: string, materials: FragmentFactory,
  options?: MemoryMaterialRules & { memoryCourse?: FragmentFactory; originUse?: FragmentFactory; authorizeMemoryOnlySeparately?: boolean },
): ReturnType<Db> {
  const memoryCourse = options?.memoryCourse;
  return db`NOT EXISTS (
    SELECT 1 FROM (${materials()}) ref
    LEFT JOIN opening_sources s ON s.id = ${lineageUuid(db, () => db`ref.source_id`)}
      AND s.workspace_id = ${workspaceId} AND s.upload_state = 'uploaded'
    LEFT JOIN opening_source_versions sv ON sv.workspace_id = s.workspace_id AND sv.source_id = s.id
      AND sv.version::text = COALESCE(ref.version, s.version::text) AND sv.availability = 'unavailable'
    LEFT JOIN opening_privacy_exclusions e ON e.workspace_id = s.workspace_id AND e.source_id = s.id
    WHERE s.id IS NULL OR sv.source_id IS NOT NULL OR e.source_id IS NOT NULL
      OR (ref.version_required AND ref.version IS NULL)
      OR (ref.version IS NOT NULL AND ref.version <> s.version::text)
      ${options?.lockedSourceIds ? db`OR NOT (s.id = ANY(${options.lockedSourceIds}::uuid[]))` : db``}
      ${options?.excluded ? db`OR s.id = ANY(${options.excluded}::uuid[])` : db``}
      ${memoryCourse ? db`OR (
        SELECT COALESCE(bool_or(cam.purpose = 'mock_exam'), false)
          OR CASE ${options?.authorizeMemoryOnlySeparately ? db`WHEN ref.memory_only THEN false` : db``}
            WHEN ${memoryCourse()} IS NULL THEN count(cam.purpose) > 0
            ELSE NOT COALESCE(bool_or(cam.course_id = ${memoryCourse()}
              AND (cam.purpose IS NULL OR cam.purpose = 'teaching'
                OR cam.purpose = ${options?.originUse
                  ? db`CASE WHEN ${options.originUse()} = 'practice' THEN 'practice' ELSE 'reference' END`
                  : db`${options?.materialUse === "practice" ? "practice" : "reference"}::text`})), false) END
        FROM course_asset_memberships cam
        WHERE cam.asset_id = s.id AND cam.workspace_id = s.workspace_id AND cam.asset_type = 'source'
      )` : db``}
  )`;
}

export function turnSourceMaterialsActive(
  db: Db, workspaceId: string, options?: MemoryMaterialRules & { memoryCourse: FragmentFactory; originUse?: FragmentFactory },
): ReturnType<Db> {
  return db`${sourceMaterialsActive(db, workspaceId, () => turnMaterialRows(db), options)}
    AND jsonb_typeof(t.source_versions) = 'object'
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
    WHERE t.workspace_id = ${scope.workspaceId} AND c.owner_user_id = ${scope.ownerUserId} AND t.status = 'complete'
      AND t.id = ANY(${unique}::uuid[])
      AND NOT COALESCE(t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb, false)
      AND ${turnSourceMaterialsActive(db, scope.workspaceId)}
      AND NOT EXISTS (
        WITH RECURSIVE mem_deps(dep_id) AS (${turnDependencyWalk(db, "t", true)})
        SELECT 1 FROM mem_deps d
        WHERE d.dep_id = ${excludeMemoryId}::uuid::text OR NOT EXISTS (
          SELECT 1 FROM opening_memories dep_m
          WHERE dep_m.id = ${lineageUuid(db, () => db`d.dep_id`)} AND dep_m.workspace_id = t.workspace_id
            AND dep_m.status = 'active'
            AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at > clock_timestamp()))
            AND ${memoryCourseAllows(db, dependencyCourse, () => db`${targetCourseId}::uuid`, workspace)}
            AND (dep_m.course_id IS NULL OR dep_m.course_id = ${ownCourseId()})
            AND (${targetCourseId}::uuid IS NULL OR ${targetCourseId}::uuid = ${ownCourseId()})
            AND dep_m.source_turn_ids = '[]'::jsonb
        )
      )`;
  if (rows.length === unique.length) return;

  const admitted = new Set(rows.map(row => row.id));
  const unresolved = unique.filter(id => !admitted.has(id));
  const memoryOnly = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns t
    WHERE t.workspace_id = ${scope.workspaceId} AND t.id = ANY(${unresolved}::uuid[]) AND t.status = 'complete'
      AND (t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        OR t.context_source_refs @? '$[*].memoryDependencyIds[*]')`;
  if (memoryOnly.length === unresolved.length) {
    const origins = await readMemoryOrigins(db, scope, memoryOnly.map(({ id }) => ({
      id, course_id: targetCourseId?.toLowerCase() ?? null, turn_ids: [id], excludedId: excludeMemoryId?.toLowerCase(),
    })));
    const now = Date.now();
    if (unresolved.every(id => (origins.get(id)?.expiresAt ?? -Infinity) > now)) return;
  }
  throw new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
}

type MemoryOrigin = { id: string; course_id: string | null; turn_ids: string[]; excludedId?: string };
type MaterialUse = "citation" | "practice";
type MemoryMaterialRules = {
  excluded?: readonly string[];
  materialUse?: MaterialUse | "origin";
  collectSourceIds?: Set<string>;
  lockedSourceIds?: readonly string[];
};
type OriginBinding = {
  id: string; turn_course_id: string | null; ids: string[] | null; backings: string[][]; material_use: MaterialUse | null;
};

async function readOriginBindings(
  db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules,
): Promise<Map<string, OriginBinding[]>> {
  const byMemory = new Map<string, OriginBinding[]>();
  if (!origins.some(origin => origin.turn_ids.length)) return byMemory;
  const originUse: FragmentFactory | undefined = rules?.materialUse === "origin" ? () => db`policy.material_use` : undefined;
  const rows = await db<(Omit<OriginBinding, "ids"> & { refs: unknown; source_ids?: string[] })[]>`
    SELECT m.id, course.id AS turn_course_id, t.context_source_refs AS refs,
      CASE WHEN t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        THEN ${turnMemoryOnlyBackingIds(db, () => db`t.context_source_refs`, () => db`course.id`, scope)} ELSE '[]'::jsonb END AS backings,
      ${originUse ? originUse() : db`NULL::text`} AS material_use
      ${rules?.collectSourceIds ? db`, ARRAY(
        SELECT DISTINCT ${lineageUuid(db, () => db`material.source_id`)}
        FROM (${turnMaterialRows(db)}) material
      ) AS source_ids` : db``}
    FROM jsonb_to_recordset(${db.json(origins)}::jsonb) m(id uuid, course_id uuid, turn_ids uuid[])
    CROSS JOIN LATERAL unnest(m.turn_ids) WITH ORDINALITY ref(turn_id, ordinality)
    JOIN opening_turns t ON t.id = ref.turn_id AND t.workspace_id = ${scope.workspaceId} AND t.status = 'complete'
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id AND c.owner_user_id = ${scope.ownerUserId}
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t", () => db`c.course_id`)} AS id) course
    ${originUse ? db`CROSS JOIN LATERAL (SELECT ${turnMaterialUse(db, "t")} AS material_use) policy` : db``}
    WHERE ${turnSourceMaterialsActive(db, scope.workspaceId, rules && { memoryCourse: () => db`m.course_id`, ...rules, originUse })}
      ${rules ? db`AND (t.role <> 'assistant' OR t.context_source_refs IS NOT NULL)` : db``}
    ORDER BY m.id, ref.ordinality`;
  for (const row of rows) {
    for (const id of row.source_ids ?? []) if (id) rules?.collectSourceIds?.add(id);
    const binding = { ...row, ids: row.refs == null ? [] : parseContextMemoryDependencyIds(row.refs) };
    const group = byMemory.get(row.id);
    if (group) group.push(binding);
    else byMemory.set(row.id, [binding]);
  }
  return byMemory;
}

function bindingRoots(rows: Iterable<OriginBinding[]>) {
  return [...rows].flatMap(group => group.flatMap(row => [...(row.ids ?? []), ...row.backings.flat()]));
}

function resolveOrigins(
  graphFor: (row: OriginBinding) => ReadonlyMap<string, MemoryDependencyStatus[]>, origin: MemoryOrigin, group: OriginBinding[],
): MemoryDependencyStatus[] | null {
  if (group.length !== origin.turn_ids.length) return null;
  const nodes = group.map(row => {
    if (row.ids === null || (origin.course_id !== null && origin.course_id !== row.turn_course_id
      && (row.ids.length || row.backings.length))) return null;
    return resolveMemoryDependencyStatus(graphFor(row), row.ids, row.backings, origin.course_id, origin.excludedId);
  });
  return nodes.some(node => node === null) ? null : nodes.flatMap(node => node ?? []);
}

/** Read each visited memory and its origins once, including unattributed backing at every depth. */
export async function readMemoryDependencyStatus(
  db: Db, scope: OpeningScope, rootIds: string[], rules?: MemoryMaterialRules,
): Promise<Map<string, MemoryDependencyStatus[]>> {
  type MemoryNode = MemoryOrigin & { expires_at: Date | null; bindings: OriginBinding[] };
  const graph = new Map<string, MemoryDependencyStatus[]>();
  const pending = new Map<string, MemoryNode>();
  const visited = new Set(rootIds);
  let frontier = [...visited];
  while (frontier.length) {
    const memories = await db<{ id: string; course_id: string | null; source_turn_ids: string[]; expires_at: Date | null }[]>`
      SELECT dep_m.id, dep_m.course_id, dep_m.source_turn_ids,
        CASE WHEN dep_m.kind = 'temporary' THEN dep_m.expires_at END AS expires_at
      FROM opening_memories dep_m
      LEFT JOIN courses c ON c.id = dep_m.course_id AND c.workspace_id = dep_m.workspace_id AND c.archived_at IS NULL
      WHERE dep_m.workspace_id = ${scope.workspaceId} AND dep_m.id = ANY(${frontier}::uuid[])
        AND dep_m.status = 'active' AND jsonb_typeof(dep_m.source_turn_ids) = 'array'
        AND (dep_m.course_id IS NULL OR c.id IS NOT NULL)
        AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at > clock_timestamp()))`;
    const origins = memories.map(row => ({ ...row, turn_ids: row.source_turn_ids, excludedId: row.id }));
    const bindings = await readOriginBindings(db, scope, origins, rules);
    for (const memory of origins) {
      pending.set(memory.id, { ...memory, bindings: bindings.get(memory.id) ?? [] });
    }
    frontier = [];
    for (const id of bindingRoots(bindings.values())) {
      if (visited.has(id)) continue;
      visited.add(id);
      frontier.push(id);
    }
  }

  // Wake parents only when a dependency becomes usable. Unresolved cycles have no independent authority.
  const parents = new Map<string, Set<string>>();
  const orderedIds = [...pending.keys()].sort();
  for (const id of orderedIds) {
    const node = pending.get(id)!;
    for (const root of bindingRoots([node.bindings])) {
      const consumers = parents.get(root);
      if (consumers) consumers.add(id);
      else parents.set(root, new Set([id]));
    }
  }
  const ready = new Set(orderedIds);
  for (const id of ready) {
    ready.delete(id);
    const node = pending.get(id);
    if (!node) continue;
    const ancestry = resolveOrigins(() => graph, node, node.bindings);
    if (!ancestry) continue;
    const dependencies = new Map(ancestry.map(dep => [dep.dep_id, dep]));
    dependencies.set(id, { dep_id: id, course_id: node.course_id, expires_at: node.expires_at, usable: true });
    graph.set(id, [...dependencies.values()]);
    for (const parent of parents.get(id) ?? []) {
      if (!graph.has(parent)) ready.add(parent);
    }
  }
  // An early pass can prove usability via a later UUID while a preferred backing
  // is still resolving. Revisit those choices and propagate the resulting ancestry.
  const usableIds = orderedIds.filter(id => graph.has(id));
  for (let pass = 0; pass < usableIds.length; pass++) {
    let changed = false;
    for (const id of usableIds) {
      const node = pending.get(id)!;
      const ancestry = resolveOrigins(() => graph, node, node.bindings);
      if (!ancestry) continue;
      const next = new Map(ancestry.map(dep => [dep.dep_id, dep]));
      next.set(id, { dep_id: id, course_id: node.course_id, expires_at: node.expires_at, usable: true });
      const previous = graph.get(id)!;
      const resolved = [...next.values()];
      if (previous.length === resolved.length && previous.every((dep, index) => dep.dep_id === resolved[index]?.dep_id)) continue;
      graph.set(id, resolved);
      changed = true;
    }
    if (!changed) break;
  }
  return graph;
}

/** Validate source turns and resolve their named and legacy ancestry against the destination course. */
export async function readMemoryOrigins(db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules) {
  const result = new Map<string, { ids: Set<string>; expiresAt: number } | null>();
  const bindings = await readOriginBindings(db, scope, origins, rules);
  const graphFor = new Map<MaterialUse | undefined, Map<string, MemoryDependencyStatus[]>>();
  if (rules?.materialUse === "origin") {
    const allBindings = [...bindings.values()].flat();
    for (const materialUse of ["citation", "practice"] as const) {
      const roots = bindingRoots([allBindings.filter(row => row.material_use === materialUse)]);
      graphFor.set(materialUse, await readMemoryDependencyStatus(db, scope, roots, { ...rules, materialUse }));
    }
  } else {
    graphFor.set(undefined, await readMemoryDependencyStatus(db, scope, bindingRoots(bindings.values()), rules));
  }
  const emptyGraph = new Map<string, MemoryDependencyStatus[]>();
  for (const origin of origins) {
    const dependencies = resolveOrigins(row => graphFor.get(row.material_use ?? undefined) ?? emptyGraph,
      origin, bindings.get(origin.id) ?? []);
    if (!dependencies) {
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
