import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import {
  assistantDirectSourcesVersioned, historicalUserTurnId, isLineageUuid, isMemoryDependencyMetadata, lineageUuid, memoryCourseAllows, pairedUserTurnId,
  memoryOnlyRefSourceIds, parseContextMemoryDependencyIds, parseContextSourceRefs, resolveMemoryDependencyStatus,
  turnDependencyWalk, turnHasOwnedSession, turnHasStandaloneSession, turnHasStandaloneSessions, turnLineageCourse, turnMaterialRows, turnMaterialUse, turnMemoryOnlyBackingIds,
  type ContextSourceRef,
  type FragmentFactory,
  type MemoryDependencyStatus,
} from "./opening-context-provenance";
import { OpeningMemoryError } from "./opening-memory-types";
import { historyAncestorMemoryIds, readTutorHistoryAncestorAuthority, resolveHistoryAncestors,
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
export async function lockMemoryMaterialSources(db: Db, scope: OpeningScope, sourceIds: Set<string>): Promise<Map<string, number>> {
  if (!sourceIds.size) return new Map();
  const sources = await db<{ id: string; version: number }[]>`SELECT id, version FROM opening_sources WHERE workspace_id=${scope.workspaceId}
    AND id=ANY(${[...sourceIds].sort()}::uuid[]) ORDER BY id FOR SHARE`;
  const versions = new Map(sources.map(({ id, version }) => [id, version]));
  if (versions.size) {
    await db`SELECT id FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
      AND asset_type='source' AND asset_id=ANY(${[...versions.keys()]}::uuid[]) ORDER BY asset_id, course_id FOR SHARE`;
  }
  return versions;
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

function turnSourceMaterialsActive(
  db: Db, workspaceId: string, options?: MemoryMaterialRules & {
    memoryCourse: FragmentFactory;
    originUse?: FragmentFactory;
    standaloneOrigin?: FragmentFactory;
  },
): ReturnType<Db> {
  return db`${sourceMaterialsActive(db, workspaceId, () => turnMaterialRows(db, () => db`c.owner_user_id`), options)}
    AND jsonb_typeof(t.source_versions) = 'object'
    AND jsonb_typeof(t.citations) = 'array'
    AND ${assistantDirectSourcesVersioned(db, "t")}
    AND (t.context_source_refs IS NULL OR jsonb_typeof(t.context_source_refs) = 'array')`;
}

function turnOriginPolicies(db: Db, scope: OpeningScope, rules?: MemoryMaterialRules, destination?: FragmentFactory) {
  const ownCourse: FragmentFactory = () => db`course.id`;
  const userCourse = () => turnLineageCourse(db, "u", () => db`c.course_id`, () => db`c.owner_user_id`);
  const directPolicy = (memoryCourse: FragmentFactory, originUse: FragmentFactory, standaloneOrigin: FragmentFactory) => ({
    ...rules, memoryCourse, originUse, standaloneOrigin, allowClassifiedGlobal: true,
    directMaterialPolicy: true, authorizeMemoryOnlySeparately: true,
  });
  return db`${turnHasOwnedSession(db, () => db`t`, () => db`c.owner_user_id`)}
    AND ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db, () => db`c.owner_user_id`),
      directPolicy(ownCourse, () => turnMaterialUse(db, "t"), () => db`course.id IS NULL
        AND ${turnHasStandaloneSessions(db, () => db`c.owner_user_id`)}`))}
    AND (t.role <> 'assistant' OR NOT EXISTS (
      SELECT 1 FROM opening_turns u
      WHERE u.id=(${pairedUserTurnId(db, () => db`t`)}) AND u.workspace_id=t.workspace_id
        AND u.conversation_id=t.conversation_id AND u.role='user' AND u.status='complete'
        AND NOT (${turnHasOwnedSession(db, () => db`u`, () => db`c.owner_user_id`)}
          AND ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db, () => db`c.owner_user_id`, () => db`u`),
            directPolicy(userCourse, () => turnMaterialUse(db, "u"),
              () => db`${userCourse()} IS NULL AND ${turnHasStandaloneSession(db, () => db`u`, () => db`c.owner_user_id`)}`))}
          ${destination ? db`AND (${userCourse()} IS NULL OR ${userCourse()} IS NOT DISTINCT FROM ${destination()} OR
            ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db, () => db`c.owner_user_id`, () => db`u`), {
              ...rules, memoryCourse: destination, authorizeMemoryOnlySeparately: true,
              originUse: !rules?.materialUse || rules.materialUse === "origin"
                ? () => turnMaterialUse(db, "u") : undefined,
            })})` : db``}
          AND jsonb_typeof(u.source_versions)='object' AND jsonb_typeof(u.citations)='array')
    ))`;
}

export function bareUserOrigin(db: Db) {
  return db`t.role='user' AND c.course_id IS NULL AND t.learning_session_id IS NULL
    AND t.context_anchor IS NULL AND t.chunk_id IS NULL AND cardinality(t.source_ids)=0
    AND t.citations='[]'::jsonb AND t.source_versions='{}'::jsonb
    AND (t.context_source_refs IS NULL OR t.context_source_refs='[]'::jsonb)`;
}

export async function readBareUserOrigins(db: Db, scope: OpeningScope, turnIds: readonly string[]) {
  if (!turnIds.length) return new Set<string>();
  const rows = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns AS t
    JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
    WHERE t.id=ANY(${turnIds.map(id => id.toLowerCase())}::uuid[]) AND t.workspace_id=${scope.workspaceId}
      AND t.status='complete' AND c.owner_user_id=${scope.ownerUserId} AND ${bareUserOrigin(db)}`;
  return new Set(rows.map(row => row.id));
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
  const bare = targetCourseId === null && excludeMemoryId === null
    ? await readBareUserOrigins(db, scope, unique) : new Set<string>();
  const remaining = unique.filter(id => !bare.has(id));
  if (!remaining.length) return;
  const ownCourseId: FragmentFactory = () => db`course.id`;
  const workspace: FragmentFactory = () => db`t.workspace_id`;
  const dependencyCourse: FragmentFactory = () => db`dep_m.course_id`;
  const rows = await db<{ id: string | { turnId: string } }[]>`
    SELECT t.id FROM opening_turns saved
    CROSS JOIN LATERAL (
    SELECT CASE WHEN ${targetCourseId}::uuid IS NULL AND (${bareUserOrigin(db)})
      THEN to_jsonb(t.id) ELSE jsonb_build_object('turnId', t.id) END AS id
    FROM (SELECT saved.*) t
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t", () => db`c.course_id`, () => db`c.owner_user_id`)} AS id) course
    WHERE t.workspace_id = ${scope.workspaceId} AND c.owner_user_id = ${scope.ownerUserId} AND t.status = 'complete'
      AND NOT COALESCE(t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb, false)
      AND ${turnSourceMaterialsActive(db, scope.workspaceId)}
      AND ${turnOriginPolicies(db, scope, undefined, () => db`${targetCourseId}::uuid`)}
      AND (course.id IS NULL OR course.id IS NOT DISTINCT FROM ${targetCourseId}::uuid OR
        ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db, () => db`c.owner_user_id`), {
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
    WHERE saved.id=ANY(${remaining}::uuid[]) AND saved.workspace_id=${scope.workspaceId}`;
  const admitted = new Set(rows.map(row => typeof row.id === "string" ? row.id : row.id.turnId));
  const unresolved = rows.length === remaining.length ? [] : remaining.filter(id => !admitted.has(id));
  const lockedOriginIds = rows.flatMap(row => typeof row.id === "string" ? [] : [row.id.turnId]);
  const validate = async (turnIds: string[]) => {
    if (!turnIds.length) return true;
    const origin = (await lockAndReadMemoryOrigins(db, scope, [{
      id: turnIds[0]!, course_id: targetCourseId?.toLowerCase() ?? null, turn_ids: turnIds,
      excludedId: excludeMemoryId?.toLowerCase(),
    }], { writeAdmission: true })).get(turnIds[0]!);
    return !!origin && origin.expiresAt > Date.now();
  };
  if (!unresolved.length) {
    if (await validate(lockedOriginIds)) return;
    throw new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
  }
  const memoryOnly = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns t
    WHERE t.workspace_id = ${scope.workspaceId} AND t.id = ANY(${unresolved}::uuid[]) AND t.status = 'complete'
      AND (t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        OR t.context_source_refs @? '$[*].memoryDependencyIds[*]')`;
  if (memoryOnly.length === unresolved.length && await validate([...lockedOriginIds, ...unresolved])) return;
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
  includeSourceRefs?: boolean;
  allowClassifiedGlobal?: boolean;
  writeAdmission?: boolean;
};
type OriginBinding = {
  id: string; turn_course_id: string | null; ids: string[] | null; backings: string[][]; material_use: MaterialUse | null;
  ancestors: HistoryAncestorAuthority[]; source_ids?: string[]; backingSourceIds?: string[];
  user?: {
    courseId: string | null; materialUse: MaterialUse; destinationUse: MaterialUse;
    ids: string[] | null; backings: string[][]; backingSourceIds?: string[];
    memoryOnlyRefs?: ContextSourceRef[];
  };
};

async function readOriginBindings(
  db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules, savedSnippet = false,
): Promise<Map<string, OriginBinding[]>> {
  const byMemory = new Map<string, OriginBinding[]>();
  const originIds: string[] = [];
  const courseIds: (string | null)[] = [];
  const turnIds: string[] = [];
  const ordinalities: number[] = [];
  const bare = savedSnippet ? new Set<string>() : await readBareUserOrigins(db, scope,
    [...new Set(origins.flatMap(origin => origin.course_id === null ? origin.turn_ids.filter(isLineageUuid) : []))]);
  for (const origin of origins) {
    origin.turn_ids.forEach((turnId, index) => {
      if (!isLineageUuid(turnId)) return;
      if (origin.course_id === null && bare.has(turnId.toLowerCase())) {
        const binding: OriginBinding = { id: origin.id, turn_course_id: null, ids: [], backings: [], material_use: null, ancestors: [] };
        const group = byMemory.get(origin.id);
        if (group) group.push(binding);
        else byMemory.set(origin.id, [binding]);
        return;
      }
      originIds.push(origin.id);
      courseIds.push(origin.course_id);
      turnIds.push(turnId);
      ordinalities.push(index);
    });
  }
  if (!turnIds.length) return byMemory;
  const originUse: FragmentFactory | undefined = rules?.materialUse === "origin" ? () => db`policy.material_use` : undefined;
  const userCourse = () => turnLineageCourse(db, "u", () => db`c.course_id`, () => db`c.owner_user_id`);
  const rows = await db<(Omit<OriginBinding, "ids" | "ancestors"> & {
    refs: unknown; historical_user_turn_id?: string | null; user_course_id?: string | null;
    user_refs: unknown; user_backings?: string[][]; user_material_use?: MaterialUse | null; paired_destination_use?: MaterialUse;
  })[]>`
    SELECT m.id, course.id AS turn_course_id, t.context_source_refs AS refs,
      ${historicalUserTurnId(db)} AS historical_user_turn_id,
      u.context_source_refs AS user_refs, CASE WHEN u.id IS NOT NULL THEN ${userCourse()} END AS user_course_id,
      CASE WHEN u.id IS NOT NULL THEN ${turnMaterialUse(db, "u")} END AS user_material_use,
      CASE WHEN u.id IS NOT NULL THEN ${originUse ? originUse() : turnMaterialUse(db, "t")} END AS paired_destination_use,
      CASE WHEN u.id IS NOT NULL AND u.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        THEN ${turnMemoryOnlyBackingIds(db, () => db`u.context_source_refs`, userCourse,
          () => turnHasStandaloneSession(db, () => db`u`, () => db`c.owner_user_id`), scope)} ELSE '[]'::jsonb END AS user_backings,
      CASE WHEN t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        THEN ${turnMemoryOnlyBackingIds(db, () => db`t.context_source_refs`, () => db`course.id`,
          () => turnHasStandaloneSessions(db, () => db`c.owner_user_id`), scope)} ELSE '[]'::jsonb END AS backings,
      ${originUse ? originUse() : db`NULL::text`} AS material_use
      ${rules?.collectSourceIds || rules?.includeSourceRefs ? db`, ARRAY(
        SELECT DISTINCT ${lineageUuid(db, () => db`material.source_id`)}
        FROM (${turnMaterialRows(db, () => db`c.owner_user_id`)} UNION ALL
          SELECT paired.* FROM (${turnMaterialRows(db, () => db`c.owner_user_id`, () => db`u`)}) paired WHERE u.id IS NOT NULL
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
    WHERE ${savedSnippet ? db`t.role = 'assistant'` : db`${turnSourceMaterialsActive(db, scope.workspaceId, rules && !rules.writeAdmission ? {
      ...rules, memoryCourse: () => db`m.course_id`, originUse,
      standaloneOrigin: () => db`course.id IS NULL AND ${turnHasStandaloneSessions(db, () => db`c.owner_user_id`)}`,
    } : undefined)}
      AND ${turnOriginPolicies(db, scope, rules, () => db`m.course_id`)}
      ${rules && !rules.writeAdmission ? db`` : db`AND (course.id IS NULL OR course.id IS NOT DISTINCT FROM m.course_id OR
        ${sourceMaterialsActive(db, scope.workspaceId, () => turnMaterialRows(db, () => db`c.owner_user_id`), {
          memoryCourse: () => db`m.course_id`, originUse: () => turnMaterialUse(db, "t"),
        })})`}
      ${rules && !rules.writeAdmission ? db`AND (t.role <> 'assistant' OR t.context_source_refs IS NOT NULL)` : db``}`}
    ORDER BY m.id, m.ordinality`;
  const userTurnIds = [...new Set(rows.flatMap(row => row.historical_user_turn_id ? [row.historical_user_turn_id] : []))];
  const authorities = userTurnIds.length ? await readTutorHistoryAncestorAuthority(db, scope, userTurnIds, rules) : undefined;
  for (const row of rows) {
    const ancestors = row.historical_user_turn_id ? authorities?.get(row.historical_user_turn_id) : [];
    if (!ancestors) continue;
    for (const id of row.source_ids ?? []) if (id) rules?.collectSourceIds?.add(id);
    if (typeof row.turn_course_id === "string") rules?.collectCourseIds?.add(row.turn_course_id);
    if (typeof row.user_course_id === "string") rules?.collectCourseIds?.add(row.user_course_id);
    const ids = row.refs == null ? [] : parseContextMemoryDependencyIds(row.refs);
    const binding: OriginBinding = { ...row, ids, ancestors,
      backingSourceIds: ids?.length ? memoryOnlyRefSourceIds(row.refs) : undefined };
    if (row.user_material_use) {
      const userIds = row.user_refs == null ? [] : parseContextMemoryDependencyIds(row.user_refs);
      binding.user = { courseId: row.user_course_id ?? null, materialUse: row.user_material_use,
        destinationUse: row.paired_destination_use ?? row.user_material_use,
        ids: userIds, backings: row.user_backings ?? [],
        backingSourceIds: userIds?.length ? memoryOnlyRefSourceIds(row.user_refs) : undefined,
        ...(savedSnippet ? { memoryOnlyRefs: parseContextSourceRefs(row.user_refs)?.filter(ref => ref.memoryOnly) } : {}),
      };
    }
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
  return bindings.flatMap(row => {
    const { user } = row;
    return [
      ...[...(row.ids ?? []), ...row.backings.flat()].map(id => ({ id, use: row.material_use ?? use })),
      ...(user ? [...(user.ids ?? []), ...user.backings.flat()].flatMap(id => [
        { id, use: user.materialUse }, { id, use: pairedDestinationUse(user, use) },
      ]) : []),
      ...row.ancestors.flatMap(entry => historyAncestorMemoryIds(entry).map(id => ({ id, use: entry.materialUse }))),
    ];
  });
}

function pairedDestinationUse(user: { destinationUse: MaterialUse }, use: MemoryUse): MaterialUse {
  return use && use !== "origin" ? use : user.destinationUse;
}

function resolveOrigins(
  graphFor: (use: MemoryUse) => MemoryGraph, origin: MemoryOrigin, group: OriginBinding[], use: MemoryUse,
) {
  if (group.length !== origin.turn_ids.length) return null;
  const dependencies: MemoryDependencyStatus[] = [];
  const sourceIds = new Set<string>();
  let expiresAt = Infinity;
  for (const row of group) {
    if (row.ids === null || (origin.course_id !== null && origin.course_id !== row.turn_course_id
      && (row.ids.length || row.backings.length))) return null;
    const nodes = resolveMemoryDependencyStatus(graphFor(row.material_use ?? use), row.ids, row.backings,
      origin.course_id, origin.excludedId, row.backingSourceIds);
    if (!nodes) return null;
    dependencies.push(...nodes);
    if (row.user) {
      const user = row.user;
      if (user.ids === null) return null;
      if (user.ids.length || user.backings.length) {
        const ownGraph = graphFor(user.materialUse);
        const destinationGraph = graphFor(pairedDestinationUse(user, use));
        const shared = new Map<string, MemoryDependencyStatus[]>();
        for (const id of [...user.ids, ...user.backings.flat()]) {
          const own = resolveMemoryDependencyStatus(ownGraph, [id], [], user.courseId, origin.excludedId);
          const destination = destinationGraph === ownGraph ? own : destinationGraph.get(id);
          if (own && destination) shared.set(id, destination === own ? own : [...own, ...destination]);
        }
        const backings = user.backingSourceIds ? user.backings.map((candidates, index) => candidates.filter(id =>
          [ownGraph, destinationGraph].every(graph =>
            graph.get(id)?.some(node => node.sourceIds?.includes(user.backingSourceIds![index]!))))) : user.backings;
        const paired = resolveMemoryDependencyStatus(shared, user.ids, backings, origin.course_id,
          origin.excludedId, user.backingSourceIds);
        if (!paired) return null;
        dependencies.push(...paired);
      }
    }
    const history = resolveHistoryAncestors(row.ancestors, graphFor, origin.excludedId);
    if (!history) return null;
    expiresAt = Math.min(expiresAt, history.expiresAt);
    for (const id of [...(row.source_ids ?? []), ...history.sourceIds]) sourceIds.add(id);
  }
  for (const dep of dependencies) {
    if (dep.expires_at !== null) expiresAt = Math.min(expiresAt, new Date(dep.expires_at).getTime());
    for (const id of dep.sourceIds ?? []) sourceIds.add(id);
  }
  return expiresAt > Date.now() ? { dependencies, expiresAt, sourceIds: [...sourceIds].sort() } : null;
}

/** Read each visited memory and its origins once, including unattributed backing at every depth. */
export async function readMemoryDependencyStatus(
  db: Db, scope: OpeningScope, rootIds: string[], rules?: MemoryMaterialRules,
): Promise<MemoryGraph> {
  if (!rootIds.length) return new Map();
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
      { ...rules, materialUse: use, allowClassifiedGlobal: true, writeAdmission: false, includeSourceRefs: true });
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
    dependencies.set(node.id, { dep_id: node.id, course_id: node.course_id, expires_at: expiresAt, usable: true,
      sourceIds: ancestry.sourceIds,
    });
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
        && Number(dep.expires_at) === Number(resolved[index]?.expires_at)
        && dep.sourceIds?.length === resolved[index]?.sourceIds?.length
        && dep.sourceIds?.every((id, sourceIndex) => id === resolved[index]?.sourceIds?.[sourceIndex]))) continue;
      graph.set(node.id, resolved);
      changed = true;
    }
    if (!changed) break;
  }
  return graphFor;
}

/** Validate source turns and resolve their named and legacy ancestry against the destination course. */
type AdmittedMemoryOrigin = { ids: Set<string>; expiresAt: number; sourceRefs?: ContextSourceRef[] };

async function readOriginLineages(db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules) {
  const bindings = await readOriginBindings(db, scope, origins, rules);
  const roots = bindingRoots([...bindings.values()].flat(), rules?.materialUse);
  const emptyGraph: MemoryGraph = new Map();
  const graphFor = roots.length ? await readMemoryDependencyGraphs(db, scope, roots, rules) : () => emptyGraph;
  return new Map(origins.map(origin => [origin.id, resolveOrigins(graphFor, origin, bindings.get(origin.id) ?? [], rules?.materialUse)]));
}

function readMemoryDeletionTurns(db: Db, scope: OpeningScope, turnIds: string[]) {
  const owner: FragmentFactory = () => db`c.owner_user_id`;
  return db<{ refs: unknown; source_ids: (string | null)[] }[]>`
    WITH origins AS (
      SELECT t.id, t.conversation_id, paired.id AS user_id, paired.created_at AS user_created_at,
        NOT t.query_system AND t.system_query IS NULL AND NOT paired.query_system AS include_history
      FROM opening_turns t
      JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
        AND c.owner_user_id=${scope.ownerUserId}
      LEFT JOIN opening_turns paired ON t.role='assistant' AND paired.id=(${pairedUserTurnId(db, () => db`t`)})
        AND paired.workspace_id=t.workspace_id AND paired.conversation_id=t.conversation_id
        AND paired.role='user' AND paired.status='complete'
      WHERE t.workspace_id=${scope.workspaceId} AND t.id=ANY(${turnIds}::uuid[])
    ), lineage_turns AS (
      SELECT id FROM origins
      UNION SELECT user_id FROM origins WHERE user_id IS NOT NULL
      UNION
      SELECT side.id FROM origins o
      JOIN opening_tutor_jobs j ON j.conversation_id=o.conversation_id AND j.workspace_id=${scope.workspaceId}
      JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=j.workspace_id AND u.conversation_id=j.conversation_id
        AND u.role='user' AND u.status='complete' AND NOT u.query_system
      JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=j.workspace_id AND a.conversation_id=j.conversation_id
        AND a.role='assistant' AND a.status='complete' AND NOT a.query_system AND a.system_query IS NULL
      CROSS JOIN LATERAL (VALUES (u.id), (a.id)) side(id)
      WHERE o.include_history AND (u.created_at, u.id) < (o.user_created_at, o.user_id)
    )
    SELECT t.context_source_refs AS refs,
      ARRAY(SELECT DISTINCT ${lineageUuid(db, () => db`material.source_id`)}
        FROM (${turnMaterialRows(db, owner)}) material) AS source_ids
    FROM lineage_turns lineage JOIN opening_turns t ON t.id=lineage.id
    JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id`;
}

/** Privacy deletion follows saved lineage even after a dependency stops being usable. */
export async function readMemoryDeletionSourceIds(db: Db, scope: OpeningScope, originTurnIds: string[]): Promise<string[]> {
  const sourceIds = new Set<string>();
  const visitedTurns = new Set<string>();
  const visitedMemories = new Set<string>();
  let frontier = originTurnIds;
  while (frontier.length) {
    const turnIds: string[] = [];
    for (const id of frontier.filter(isLineageUuid).map(id => id.toLowerCase())) {
      if (visitedTurns.has(id)) continue;
      visitedTurns.add(id);
      turnIds.push(id);
    }
    if (!turnIds.length) break;
    const memoryIds: string[] = [];
    for (const turn of await readMemoryDeletionTurns(db, scope, turnIds)) {
      for (const id of turn.source_ids) if (id) sourceIds.add(id);
      const exactIds = Array.isArray(turn.refs) ? turn.refs.filter(isMemoryDependencyMetadata).flatMap(ref => ref.memoryDependencyIds) : [];
      for (const rawId of exactIds) {
        const id = rawId.toLowerCase();
        if (visitedMemories.has(id)) continue;
        visitedMemories.add(id);
        memoryIds.push(id);
      }
    }
    if (!memoryIds.length) break;
    const memories = await db<{ source_turn_ids: string[] }[]>`
      SELECT source_turn_ids FROM opening_memories
      WHERE workspace_id=${scope.workspaceId} AND id=ANY(${memoryIds}::uuid[])
        AND jsonb_typeof(source_turn_ids)='array'`;
    frontier = memories.flatMap(memory => memory.source_turn_ids);
  }
  return [...sourceIds].sort();
}

async function readMemoryOrigins(db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules,
  lockedSourceVersions?: ReadonlyMap<string, number>,
) {
  const result = new Map<string, AdmittedMemoryOrigin | null>();
  for (const [id, lineage] of await readOriginLineages(db, scope, origins, rules)) {
    if (!lineage) {
      result.set(id, null);
      continue;
    }
    const sourceRefs = lockedSourceVersions && rules?.includeSourceRefs
      ? lockedMemorySourceRefs(lockedSourceVersions, lineage.sourceIds) : undefined;
    if (sourceRefs === null) {
      result.set(id, null);
      continue;
    }
    result.set(id, {
      ids: new Set(lineage.dependencies.map(node => node.dep_id)),
      expiresAt: lineage.expiresAt,
      sourceRefs,
    });
  }
  return result;
}

function lockedMemorySourceRefs(versions: ReadonlyMap<string, number>, sourceIds: string[]): ContextSourceRef[] | null {
  const refs: ContextSourceRef[] = [];
  for (const sourceId of [...new Set(sourceIds)].sort()) {
    const sourceVersion = versions.get(sourceId);
    if (sourceVersion === undefined || !Number.isSafeInteger(sourceVersion) || sourceVersion < 0) return null;
    refs.push({ sourceId, sourceVersion });
  }
  return refs;
}

/** After history and workspace locks, resolve the snippet's exact memories and backing material. */
export async function lockAndReadSnippetMemoryRefs(tx: TransactionSql, scope: OpeningScope,
  input: { turnId: string } | { dependencyIds: string[] },
): Promise<{ sourceRefs: ContextSourceRef[]; dependencyIds: string[] } | null> {
  const courseIds = new Set<string>();
  let roots: MemoryRoot[];
  let userRefs: ContextSourceRef[] = [];
  const sourceIds = new Set<string>();
  let refreshBinding: ((versions: ReadonlyMap<string, number>) => Promise<boolean>) | undefined;
  let resolve: (graphFor: (use: MemoryUse) => MemoryGraph) => { dependencies: MemoryDependencyStatus[]; sourceIds: string[] } | null;
  if ("turnId" in input) {
    const origin: MemoryOrigin = { id: input.turnId, course_id: null, turn_ids: [input.turnId] };
    // The note repository separately checks the assistant's recorded refs and citations.
    const readBinding = async (rules: MemoryMaterialRules) => (await readOriginBindings(tx, scope, [origin], rules, true))
      .get(input.turnId)?.[0];
    const initial = await readBinding({
      materialUse: "origin", collectCourseIds: courseIds,
    });
    if (!initial || initial.ids === null || initial.user?.ids === null) return null;
    let binding = initial;
    const user = binding.user;
    roots = bindingRoots([binding], "origin");
    if (!roots.length && !binding.ancestors.length) return { sourceRefs: [], dependencyIds: [] };
    for (const ancestor of binding.ancestors) for (const id of ancestor.sourceIds) sourceIds.add(id);
    origin.course_id = binding.turn_course_id;
    userRefs = user?.memoryOnlyRefs ?? [];
    if (binding.ancestors.length) refreshBinding = async versions => {
      const currentCourses = new Set<string>();
      const current = await readBinding({
        materialUse: "origin", collectCourseIds: currentCourses, lockedSourceIds: [...versions.keys()],
      });
      if (!current || [...currentCourses].some(id => !courseIds.has(id))) return false;
      binding = current;
      return true;
    };
    resolve = graphFor => {
      const resolved = resolveOrigins(graphFor, origin, [binding], "origin");
      if (!resolved) return null;
      // resolveOrigins has already validated these historical exchanges and locked their material.
      const historyDependencies = binding.ancestors.flatMap(entry => resolveMemoryDependencyStatus(
        graphFor(entry.materialUse), entry.memoryIds, entry.backings, entry.courseId, undefined, entry.backingSourceIds,
      ) ?? []);
      const dependencies = [...resolved.dependencies, ...historyDependencies];
      return { sourceIds: dependencies.flatMap(memory => memory.sourceIds ?? []), dependencies };
    };
  } else {
    roots = input.dependencyIds.map(id => ({ id, use: "origin" }));
    resolve = graphFor => {
      const dependencies = resolveMemoryDependencyStatus(graphFor("origin"), input.dependencyIds, [], null);
      return dependencies && { dependencies, sourceIds: dependencies.flatMap(memory => memory.sourceIds ?? []) };
    };
  }
  await readMemoryDependencyGraphs(tx, scope, roots, { collectCourseIds: courseIds, collectSourceIds: sourceIds });
  if (!await lockActiveMemoryCourses(tx, scope, [...courseIds])) return null;
  const versions = await lockMemoryMaterialSources(tx, scope, sourceIds);
  if (refreshBinding && !await refreshBinding(versions)) return null;
  const currentCourseIds = new Set<string>();
  const graphFor = await readMemoryDependencyGraphs(tx, scope, roots, {
    collectCourseIds: currentCourseIds, lockedSourceIds: [...versions.keys()],
  });
  const resolved = resolve(graphFor);
  if (!resolved || [...currentCourseIds].some(id => !courseIds.has(id))) return null;
  const refs = lockedMemorySourceRefs(versions, resolved.sourceIds);
  if (!refs) return null;

  const dependencyIds = [...new Set(resolved.dependencies.map(memory => memory.dep_id.toLowerCase()))].sort();
  const active = await tx`SELECT id FROM opening_memories
    WHERE workspace_id=${scope.workspaceId} AND id=ANY(${dependencyIds}::uuid[]) AND status='active'
      AND (kind='confirmed' OR (kind='temporary' AND expires_at > clock_timestamp()))
    ORDER BY id FOR SHARE`;
  if (active.length !== dependencyIds.length) return null;
  return { dependencyIds, sourceRefs: [...userRefs, ...refs.map(ref => ({ ...ref, memoryOnly: true }))] };
}

/** Discover material first, then repeat admission under sorted course and source locks. */
export async function lockAndReadMemoryOrigins(db: Db, scope: OpeningScope, origins: MemoryOrigin[], rules?: MemoryMaterialRules,
  activeCourseId?: string | null,
): Promise<Map<string, AdmittedMemoryOrigin | null>> {
  const collectCourseIds = new Set(origins.flatMap(origin => origin.course_id === null ? [] : [origin.course_id]));
  if (activeCourseId) collectCourseIds.add(activeCourseId.toLowerCase());
  if (origins.every(origin => origin.turn_ids.length === 0)) {
    const active = await lockActiveMemoryCourses(db, scope, [...collectCourseIds]);
    return new Map(origins.map(origin => [origin.id, active ? { ids: new Set<string>(), expiresAt: Infinity } : null]));
  }
  const collectSourceIds = new Set<string>();
  const initial = await readMemoryOrigins(db, scope, origins, { ...rules, collectCourseIds, collectSourceIds });
  if (!collectCourseIds.size && !collectSourceIds.size) return initial;
  if (!await lockActiveMemoryCourses(db, scope, [...collectCourseIds])) return new Map(origins.map(origin => [origin.id, null]));
  const versions = await lockMemoryMaterialSources(db, scope, collectSourceIds);
  const currentCourses = new Set<string>();
  const results = await readMemoryOrigins(db, scope, origins,
    { ...rules, collectCourseIds: currentCourses, lockedSourceIds: [...versions.keys()] }, versions);
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
