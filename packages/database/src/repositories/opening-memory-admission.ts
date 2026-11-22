import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import {
  assistantDirectSourcesVersioned, historicalUserTurnId, isLineageUuid, lineageUuid, memoryCourseAllows, pairedUserTurnId,
  parseContextMemoryDependencyIds, resolveMemoryDependencyStatus,
  turnDependencyWalk, turnHasOwnedSession, turnHasStandaloneSession, turnHasStandaloneSessions, turnLineageCourse, turnMaterialUse, turnMemoryOnlyBackingIds, turnPinnedSourceRefs,
  type FragmentFactory,
  type MemoryDependencyStatus,
} from "./opening-context-provenance";
import { OpeningMemoryError } from "./opening-memory-types";
import { historyAncestorMemoryIds, readTutorHistoryAncestorAuthority, resolveHistoryAncestorExpiry,
  type HistoryAncestorAuthority } from "./opening-tutor-history";

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

export async function lockActiveMemoryCourses(db: Db, scope: OpeningScope, courseIds: readonly string[]): Promise<boolean> {
  const ids = [...new Set(courseIds.map(id => id.toLowerCase()))].sort();
  if (!ids.length) return true;
  const rows = await db`SELECT id FROM courses WHERE id=ANY(${ids}::uuid[]) AND workspace_id=${scope.workspaceId}
    AND archived_at IS NULL ORDER BY id FOR SHARE`;
  return rows.length === ids.length;
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
export function turnMaterialRows(db: Db, includeUserContext = false, alias: "t" | "u" = "t"): ReturnType<Db> {
  const turn = () => alias === "u" ? db`u` : db`t`;
  return db`
    SELECT sid.id::text AS source_id, NULL::text AS version, false AS version_required, false AS memory_only
    FROM unnest(${turn()}.source_ids) sid(id)
    UNION ALL
    SELECT citation->>'sourceId', CASE WHEN jsonb_typeof(citation->'sourceVersion') = 'number' THEN citation->>'sourceVersion' END, true, false
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${turn()}.citations) = 'array' THEN ${turn()}.citations ELSE '[]'::jsonb END) citation
    UNION ALL
    SELECT ref->>'sourceId', CASE WHEN jsonb_typeof(ref->'sourceVersion') = 'number' THEN ref->>'sourceVersion' END,
      true, COALESCE(ref->'memoryOnly' = 'true'::jsonb, false)
    FROM jsonb_array_elements(CASE WHEN (${includeUserContext} OR ${turn()}.role = 'assistant')
      AND jsonb_typeof(${turn()}.context_source_refs) = 'array' THEN ${turn()}.context_source_refs ELSE '[]'::jsonb END) ref
    WHERE NOT (ref = jsonb_build_object('memoryDependencyIds', ref->'memoryDependencyIds')
      AND jsonb_typeof(ref->'memoryDependencyIds') = 'array'
      AND ref->'memoryDependencyIds' <> '[]'::jsonb)
    UNION ALL
    SELECT pin.source_id, CASE WHEN pin.source_version IS NULL THEN NULL
      WHEN jsonb_typeof(pin.source_version) = 'number' THEN pin.source_version #>> '{}' ELSE '' END, pin.version_required, false
    FROM (${turnPinnedSourceRefs(db, () => db`${turn()}.source_versions`, () => db`${turn()}.context_anchor`)}) pin
    UNION ALL
    SELECT k.source_id::text, k.source_version::text, true, false
    FROM (SELECT ${turn()}.chunk_id AS id WHERE ${turn()}.chunk_id IS NOT NULL) saved
    LEFT JOIN opening_source_chunks k ON k.id = saved.id`;
}

export function sourceMaterialsActive(
  db: Db, workspaceId: string, materials: FragmentFactory,
  options?: MemoryMaterialRules & {
    memoryCourse?: FragmentFactory;
    originUse?: FragmentFactory;
    standaloneOrigin?: FragmentFactory;
    directMaterialPolicy?: boolean;
    authorizeMemoryOnlySeparately?: boolean;
  },
): ReturnType<Db> {
  const memoryCourse = options?.memoryCourse;
  const standaloneOrigin = options?.allowClassifiedGlobal ? options.standaloneOrigin : undefined;
  const materialUse = options?.originUse ?? (() => db`${options?.materialUse === "practice" ? "practice" : "citation"}::text`);
  const purposeAllowed = () => options?.directMaterialPolicy
    ? db`cam.purpose = 'practice' OR (cam.purpose = 'reference' AND ${materialUse()} = 'citation')`
    : db`cam.purpose = CASE WHEN ${materialUse()} = 'practice' THEN 'practice' ELSE 'reference' END`;
  return db`${memoryCourse ? db`(${memoryCourse()} IS NULL OR EXISTS (
    SELECT 1 FROM courses material_course WHERE material_course.id = ${memoryCourse()}
      AND material_course.workspace_id = ${workspaceId} AND material_course.archived_at IS NULL
  )) AND` : db``} NOT EXISTS (
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
              ${standaloneOrigin ? db`AND NOT (${standaloneOrigin()})` : db``}
            ELSE NOT COALESCE(bool_or(cam.course_id = ${memoryCourse()}
              AND (cam.purpose IS NULL OR cam.purpose = 'teaching' OR ${purposeAllowed()})), false) END
        FROM course_asset_memberships cam
        WHERE cam.asset_id = s.id AND cam.workspace_id = s.workspace_id AND cam.asset_type = 'source'
          ${options?.directMaterialPolicy ? db`AND (ref.memory_only OR ${memoryCourse()} IS NULL OR cam.course_id = ${memoryCourse()})` : db``}
      )` : db``}
  )`;
}

export function turnSourceMaterialsActive(
  db: Db, workspaceId: string, options?: MemoryMaterialRules & {
    memoryCourse: FragmentFactory;
    originUse?: FragmentFactory;
    standaloneOrigin?: FragmentFactory;
  },
): ReturnType<Db> {
  return db`${sourceMaterialsActive(db, workspaceId, () => turnMaterialRows(db), options)}
    AND jsonb_typeof(t.source_versions) = 'object'
    AND jsonb_typeof(t.citations) = 'array'
    AND ${assistantDirectSourcesVersioned(db, "t")}
    AND (t.role <> 'assistant' OR t.context_source_refs IS NULL OR jsonb_typeof(t.context_source_refs) = 'array')`;
}

function turnOriginPolicies(db: Db, scope: OpeningScope, rules?: MemoryMaterialRules, destination?: FragmentFactory) {
  const ownCourse: FragmentFactory = () => db`course.id`;
  const userCourse = () => turnLineageCourse(db, "u", () => db`c.course_id`, () => db`c.owner_user_id`);
  const directPolicy = (memoryCourse: FragmentFactory, originUse: FragmentFactory, standaloneOrigin: FragmentFactory) => ({
    ...rules, memoryCourse, originUse, standaloneOrigin, allowClassifiedGlobal: true,
    directMaterialPolicy: true, authorizeMemoryOnlySeparately: true,
  });
  return db`${turnHasOwnedSession(db, () => db`t`, () => db`c.owner_user_id`)}
    AND ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db),
      directPolicy(ownCourse, () => turnMaterialUse(db, "t"), () => db`course.id IS NULL
        AND ${turnHasStandaloneSessions(db, () => db`c.owner_user_id`)}`))}
    AND (t.role <> 'assistant' OR NOT EXISTS (
      SELECT 1 FROM opening_turns u
      WHERE u.id=(${pairedUserTurnId(db, () => db`t`)}) AND u.workspace_id=t.workspace_id
        AND u.conversation_id=t.conversation_id AND u.role='user' AND u.status='complete'
        AND NOT (${turnHasOwnedSession(db, () => db`u`, () => db`c.owner_user_id`)}
          AND ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db, true, "u"),
            directPolicy(userCourse, () => turnMaterialUse(db, "u"),
              () => db`${userCourse()} IS NULL AND ${turnHasStandaloneSession(db, () => db`u`, () => db`c.owner_user_id`)}`))}
          ${destination ? db`AND (${userCourse()} IS NULL OR ${userCourse()} IS NOT DISTINCT FROM ${destination()} OR
            ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db, true, "u"), {
              ...rules, memoryCourse: destination, originUse: !rules?.materialUse || rules.materialUse === "origin"
                ? () => turnMaterialUse(db, "u") : undefined,
            })})` : db``}
          AND jsonb_typeof(u.source_versions)='object' AND jsonb_typeof(u.citations)='array')
    ))`;
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
  const rows = await db<{ id: string | { turnId: string } }[]>`
    SELECT t.id FROM opening_turns saved
    CROSS JOIN LATERAL (
    SELECT CASE WHEN t.role='assistant' OR (course.id IS NOT NULL AND course.id IS DISTINCT FROM ${targetCourseId}::uuid)
      THEN jsonb_build_object('turnId', t.id)
      ELSE to_jsonb(t.id) END AS id
    FROM (SELECT saved.*) t
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t", () => db`c.course_id`, () => db`c.owner_user_id`)} AS id) course
    WHERE t.workspace_id = ${scope.workspaceId} AND c.owner_user_id = ${scope.ownerUserId} AND t.status = 'complete'
      AND NOT COALESCE(t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb, false)
      AND ${turnSourceMaterialsActive(db, scope.workspaceId)}
      AND ${turnOriginPolicies(db, scope, undefined, () => db`${targetCourseId}::uuid`)}
      AND (course.id IS NULL OR course.id IS NOT DISTINCT FROM ${targetCourseId}::uuid OR
        ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db), {
          memoryCourse: () => db`${targetCourseId}::uuid`, originUse: () => turnMaterialUse(db, "t"),
        })})
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
      )
    ) t
    WHERE saved.id=ANY(${unique}::uuid[]) AND saved.workspace_id=${scope.workspaceId}`;
  const admitted = new Set(rows.map(row => typeof row.id === "string" ? row.id : row.id.turnId));
  const unresolved = rows.length === unique.length ? [] : unique.filter(id => !admitted.has(id));
  const assistantIds = rows.flatMap(row => typeof row.id === "string" ? [] : [row.id.turnId]);
  const validate = async (turnIds: string[]) => {
    if (!turnIds.length) return true;
    const origin = (await lockAndReadMemoryOrigins(db, scope, [{
      id: turnIds[0]!, course_id: targetCourseId?.toLowerCase() ?? null, turn_ids: turnIds,
      excludedId: excludeMemoryId?.toLowerCase(),
    }], { writeAdmission: true })).get(turnIds[0]!);
    return !!origin && origin.expiresAt > Date.now();
  };
  if (!unresolved.length && await validate(assistantIds)) return;
  const memoryOnly = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns t
    WHERE t.workspace_id = ${scope.workspaceId} AND t.id = ANY(${unresolved}::uuid[]) AND t.status = 'complete'
      AND (t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        OR t.context_source_refs @? '$[*].memoryDependencyIds[*]')`;
  if (unresolved.length && memoryOnly.length === unresolved.length
    && await validate([...assistantIds, ...unresolved])) return;
  throw new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
}

type MemoryOrigin = { id: string; course_id: string | null; turn_ids: string[]; excludedId?: string };
type MaterialUse = "citation" | "practice";
type MemoryMaterialRules = {
  excluded?: readonly string[];
  materialUse?: MaterialUse | "origin";
  collectSourceIds?: Set<string>;
  collectCourseIds?: Set<string>;
  lockedSourceIds?: readonly string[];
  allowClassifiedGlobal?: boolean;
  writeAdmission?: boolean;
};
type OriginBinding = {
  id: string; turn_course_id: string | null; ids: string[] | null; backings: string[][]; material_use: MaterialUse | null;
  ancestors: HistoryAncestorAuthority[];
};

async function readOriginBindings(
  db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules,
): Promise<Map<string, OriginBinding[]>> {
  const byMemory = new Map<string, OriginBinding[]>();
  const originIds: string[] = [];
  const courseIds: (string | null)[] = [];
  const turnIds: string[] = [];
  const ordinalities: number[] = [];
  for (const origin of origins) {
    origin.turn_ids.forEach((turnId, index) => {
      if (!isLineageUuid(turnId)) return;
      originIds.push(origin.id);
      courseIds.push(origin.course_id);
      turnIds.push(turnId);
      ordinalities.push(index);
    });
  }
  if (!turnIds.length) return byMemory;
  const originUse: FragmentFactory | undefined = rules?.materialUse === "origin" ? () => db`policy.material_use` : undefined;
  const rows = await db<(Omit<OriginBinding, "ids" | "ancestors"> & {
    refs: unknown; source_ids?: string[]; historical_user_turn_id?: string | null; user_course_id?: string | null;
  })[]>`
    SELECT m.id, course.id AS turn_course_id, t.context_source_refs AS refs,
      ${historicalUserTurnId(db)} AS historical_user_turn_id,
      ${turnLineageCourse(db, "u", () => db`CASE WHEN u.id IS NOT NULL THEN c.course_id END`, () => db`c.owner_user_id`)} AS user_course_id,
      CASE WHEN t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        THEN ${turnMemoryOnlyBackingIds(db, () => db`t.context_source_refs`, () => db`course.id`,
          () => turnHasStandaloneSessions(db, () => db`c.owner_user_id`), scope)} ELSE '[]'::jsonb END AS backings,
      ${originUse ? originUse() : db`NULL::text`} AS material_use
      ${rules?.collectSourceIds ? db`, ARRAY(
        SELECT DISTINCT ${lineageUuid(db, () => db`material.source_id`)}
        FROM (${turnMaterialRows(db)} UNION ALL
          SELECT paired.* FROM (${turnMaterialRows(db, true, "u")}) paired WHERE u.id IS NOT NULL
        ) material
      ) AS source_ids` : db``}
    FROM unnest(${originIds}::uuid[], ${courseIds}::uuid[], ${turnIds}::uuid[], ${ordinalities}::int[]) m(id, course_id, turn_id, ordinality)
    JOIN LATERAL (
      SELECT saved.* FROM opening_turns saved
      WHERE saved.id = m.turn_id AND saved.workspace_id = ${scope.workspaceId} AND saved.status = 'complete'
      OFFSET 0
    ) t ON true
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id AND c.owner_user_id = ${scope.ownerUserId}
    LEFT JOIN opening_turns u ON t.role='assistant' AND u.id=(${pairedUserTurnId(db, () => db`t`)})
      AND u.workspace_id=t.workspace_id AND u.conversation_id=t.conversation_id AND u.role='user' AND u.status='complete'
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t", () => db`c.course_id`, () => db`c.owner_user_id`)} AS id) course
    ${originUse ? db`CROSS JOIN LATERAL (SELECT ${turnMaterialUse(db, "t")} AS material_use) policy` : db``}
    WHERE ${turnSourceMaterialsActive(db, scope.workspaceId, rules && !rules.writeAdmission ? {
      ...rules, memoryCourse: () => db`m.course_id`, originUse,
      standaloneOrigin: () => db`course.id IS NULL AND ${turnHasStandaloneSessions(db, () => db`c.owner_user_id`)}`,
    } : undefined)}
      AND ${turnOriginPolicies(db, scope, rules, () => db`m.course_id`)}
      ${rules && !rules.writeAdmission ? db`` : db`AND (course.id IS NULL OR course.id IS NOT DISTINCT FROM m.course_id OR
        ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db), {
          memoryCourse: () => db`m.course_id`, originUse: () => turnMaterialUse(db, "t"),
        })})`}
      ${rules && !rules.writeAdmission ? db`AND (t.role <> 'assistant' OR t.context_source_refs IS NOT NULL)` : db``}
    ORDER BY m.id, m.ordinality`;
  const userTurnIds = [...new Set(rows.flatMap(row => row.historical_user_turn_id ? [row.historical_user_turn_id] : []))];
  const authorities = await readTutorHistoryAncestorAuthority(db, scope, userTurnIds, rules);
  for (const row of rows) {
    const ancestors = row.historical_user_turn_id ? authorities.get(row.historical_user_turn_id) : [];
    if (!ancestors) continue;
    for (const id of row.source_ids ?? []) if (id) rules?.collectSourceIds?.add(id);
    if (typeof row.turn_course_id === "string") rules?.collectCourseIds?.add(row.turn_course_id);
    if (typeof row.user_course_id === "string") rules?.collectCourseIds?.add(row.user_course_id);
    const binding = { ...row, ids: row.refs == null ? [] : parseContextMemoryDependencyIds(row.refs), ancestors };
    const group = byMemory.get(row.id);
    if (group) group.push(binding);
    else byMemory.set(row.id, [binding]);
  }
  return byMemory;
}

type MemoryUse = MemoryMaterialRules["materialUse"];
type MemoryRoot = { id: string; use: MemoryUse };
type MemoryGraph = Map<string, MemoryDependencyStatus[]>;

function bindingRoots(bindings: OriginBinding[], use: MemoryUse): MemoryRoot[] {
  return bindings.flatMap(row => [
    ...[...(row.ids ?? []), ...row.backings.flat()].map(id => ({ id, use: row.material_use ?? use })),
    ...row.ancestors.flatMap(entry => historyAncestorMemoryIds(entry).map(id => ({ id, use: entry.materialUse }))),
  ]);
}

function resolveOrigins(
  graphFor: (use: MemoryUse) => MemoryGraph, origin: MemoryOrigin, group: OriginBinding[], use: MemoryUse,
) {
  if (group.length !== origin.turn_ids.length) return null;
  const dependencies: MemoryDependencyStatus[] = [];
  let expiresAt = Infinity;
  for (const row of group) {
    if (row.ids === null || (origin.course_id !== null && origin.course_id !== row.turn_course_id
      && (row.ids.length || row.backings.length))) return null;
    const nodes = resolveMemoryDependencyStatus(graphFor(row.material_use ?? use), row.ids, row.backings, origin.course_id, origin.excludedId);
    if (!nodes) return null;
    dependencies.push(...nodes);
    expiresAt = Math.min(expiresAt, resolveHistoryAncestorExpiry(row.ancestors, graphFor, origin.excludedId));
  }
  return expiresAt > Date.now() ? { dependencies, expiresAt } : null;
}

/** Read each visited memory and its origins once, including unattributed backing at every depth. */
export async function readMemoryDependencyStatus(
  db: Db, scope: OpeningScope, rootIds: string[], rules?: MemoryMaterialRules,
): Promise<MemoryGraph> {
  const graphFor = await readMemoryDependencyGraphs(db, scope, rootIds.map(id => ({ id, use: rules?.materialUse })), rules);
  return graphFor(rules?.materialUse);
}

async function readMemoryDependencyGraphs(db: Db, scope: OpeningScope, roots: MemoryRoot[], rules?: MemoryMaterialRules) {
  type MemoryNode = MemoryOrigin & { expires_at: Date | null; bindings: OriginBinding[]; use: MemoryUse };
  const graphs = new Map<MemoryUse, MemoryGraph>();
  const graphFor = (use: MemoryUse) => {
    let graph = graphs.get(use);
    if (!graph) {
      graph = new Map();
      graphs.set(use, graph);
    }
    return graph;
  };
  const keyOf = ({ id, use }: MemoryRoot) => `${use ?? ""}:${id}`;
  const pending = new Map<string, MemoryNode>();
  const visited = new Set<string>();
  const groupRoots = (items: MemoryRoot[]) => {
    const groups = new Map<MemoryUse, string[]>();
    for (const root of items) {
      const key = keyOf(root);
      if (visited.has(key)) continue;
      visited.add(key);
      const ids = groups.get(root.use);
      if (ids) ids.push(root.id);
      else groups.set(root.use, [root.id]);
    }
    return groups;
  };
  let frontier = groupRoots(roots);
  while (frontier.size) {
    const next: MemoryRoot[] = [];
    for (const [use, ids] of frontier) {
    const memories = await db<{ id: string; course_id: string | null; source_turn_ids: string[]; expires_at: Date | null }[]>`
      SELECT dep_m.id, dep_m.course_id, dep_m.source_turn_ids,
        CASE WHEN dep_m.kind = 'temporary' THEN dep_m.expires_at END AS expires_at
      FROM opening_memories dep_m
      LEFT JOIN courses c ON c.id = dep_m.course_id AND c.workspace_id = dep_m.workspace_id AND c.archived_at IS NULL
      WHERE dep_m.workspace_id = ${scope.workspaceId} AND dep_m.id = ANY(${ids}::uuid[])
        AND dep_m.status = 'active' AND jsonb_typeof(dep_m.source_turn_ids) = 'array'
        AND (dep_m.course_id IS NULL OR c.id IS NOT NULL)
        AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at > clock_timestamp()))`;
    const origins = memories.map(row => ({ ...row, turn_ids: row.source_turn_ids, excludedId: row.id }));
    const bindings = await readOriginBindings(db, scope, origins,
      rules || use ? { ...rules, materialUse: use, allowClassifiedGlobal: true, writeAdmission: false } : undefined);
    for (const memory of origins) {
      if (memory.course_id !== null) rules?.collectCourseIds?.add(memory.course_id);
      const originBindings = bindings.get(memory.id) ?? [];
      pending.set(keyOf({ id: memory.id, use }), { ...memory, bindings: originBindings, use });
      next.push(...bindingRoots(originBindings, use));
    }
    }
    frontier = groupRoots(next);
  }

  // Wake parents only when a dependency becomes usable. Unresolved cycles have no independent authority.
  const parents = new Map<string, Set<string>>();
  const orderedIds = [...pending.keys()].sort();
  for (const key of orderedIds) {
    const node = pending.get(key)!;
    for (const root of bindingRoots(node.bindings, node.use)) {
      const rootKey = keyOf(root);
      const consumers = parents.get(rootKey);
      if (consumers) consumers.add(key);
      else parents.set(rootKey, new Set([key]));
    }
  }
  function resolveNode(node: MemoryNode) {
    const ancestry = resolveOrigins(graphFor, node, node.bindings, node.use);
    if (!ancestry) return;
    const dependencies = new Map(ancestry.dependencies.map(dep => [dep.dep_id, dep]));
    // Historical memories were consumed in the ancestor's scope. Carry their earliest expiry without
    // imposing that old course's visibility on the already-authorized derivative.
    const ownExpiry = node.expires_at === null ? Infinity : new Date(node.expires_at).getTime();
    const expiresAt = ancestry.expiresAt < ownExpiry ? new Date(ancestry.expiresAt) : node.expires_at;
    dependencies.set(node.id, { dep_id: node.id, course_id: node.course_id,
      expires_at: expiresAt, usable: true });
    return [...dependencies.values()];
  }
  const ready = new Set(orderedIds);
  for (const key of ready) {
    ready.delete(key);
    const node = pending.get(key)!;
    const resolved = resolveNode(node);
    if (!resolved) continue;
    graphFor(node.use).set(node.id, resolved);
    for (const parentKey of parents.get(key) ?? []) {
      const parent = pending.get(parentKey)!;
      if (!graphFor(parent.use).has(parent.id)) ready.add(parentKey);
    }
  }
  // An early pass can prove usability via a later UUID while a preferred backing
  // is still resolving. Revisit those choices and propagate the resulting ancestry.
  const usableIds = orderedIds.filter(key => {
    const node = pending.get(key)!;
    return graphFor(node.use).has(node.id);
  });
  for (let pass = 0; pass < usableIds.length; pass++) {
    let changed = false;
    for (const key of usableIds) {
      const node = pending.get(key)!;
      const graph = graphFor(node.use);
      const resolved = resolveNode(node);
      if (!resolved) continue;
      const previous = graph.get(node.id)!;
      if (previous.length === resolved.length && previous.every((dep, index) => dep.dep_id === resolved[index]?.dep_id
        && Number(dep.expires_at) === Number(resolved[index]?.expires_at))) continue;
      graph.set(node.id, resolved);
      changed = true;
    }
    if (!changed) break;
  }
  return graphFor;
}

/** Validate source turns and resolve their named and legacy ancestry against the destination course. */
export async function readMemoryOrigins(db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules) {
  const result = new Map<string, { ids: Set<string>; expiresAt: number } | null>();
  const bindings = await readOriginBindings(db, scope, origins, rules);
  const graphFor = await readMemoryDependencyGraphs(db, scope, bindingRoots([...bindings.values()].flat(), rules?.materialUse), rules);
  for (const origin of origins) {
    const lineage = resolveOrigins(graphFor, origin, bindings.get(origin.id) ?? [], rules?.materialUse);
    if (!lineage) {
      result.set(origin.id, null);
      continue;
    }
    result.set(origin.id, {
      ids: new Set(lineage.dependencies.map(node => node.dep_id)),
      expiresAt: lineage.dependencies.reduce((expiresAt, node) => node.expires_at === null ? expiresAt
        : Math.min(expiresAt, new Date(node.expires_at).getTime()), lineage.expiresAt),
    });
  }
  return result;
}

/** Discover material first, then repeat admission under sorted course and source locks. */
export async function lockAndReadMemoryOrigins(db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules,
  activeCourseId?: string | null,
) {
  const collectCourseIds = new Set(origins.flatMap(origin => origin.course_id === null ? [] : [origin.course_id]));
  if (activeCourseId) collectCourseIds.add(activeCourseId.toLowerCase());
  const collectSourceIds = new Set<string>();
  await readMemoryOrigins(db, scope, origins, { ...rules, collectCourseIds, collectSourceIds });
  if (!await lockActiveMemoryCourses(db, scope, [...collectCourseIds])) return new Map(origins.map(origin => [origin.id, null]));
  const lockedSourceIds = await lockMemoryMaterialSources(db, scope, collectSourceIds);
  const currentCourses = new Set<string>();
  const results = await readMemoryOrigins(db, scope, origins, { ...rules, collectCourseIds: currentCourses, lockedSourceIds });
  return [...currentCourses].every(id => collectCourseIds.has(id))
    ? results : new Map(origins.map(origin => [origin.id, null]));
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
