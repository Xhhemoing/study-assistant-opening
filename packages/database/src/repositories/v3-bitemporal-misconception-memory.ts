import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { LEARNER_CONTEXT_MAX_BYTES, type LearnerMisconceptionDisposition, type v3BitemporalMisconceptionEdges } from "../schema/v3-bitemporal-memory";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import {
  isLineageUuid, lineageUuid, memoryOnlyRefSourceIds, pairedUserTurnId, parseContextMemoryDependencyIds, resolveMemoryDependencyStatus,
  turnHasMemoryDependencies, turnHasStandaloneSession, turnHasStandaloneSessions, turnLineageCourse, turnMaterialUse, turnMemoryOnlyBackingIds,
  type FragmentFactory, type MemoryDependencyStatus,
} from "./opening-context-provenance";
import { readMemoryDependencyStatus } from "./opening-memory-admission";
import type { OpeningScope } from "./opening-sources";

type Edge = typeof v3BitemporalMisconceptionEdges.$inferSelect;
type ContextItem = Pick<Edge, "status" | "learnerDisposition" | "summary">;
type RenderedContextBlock = { renderedMarkdown: string; byteLength: number };
type ContextBlock = RenderedContextBlock & { revision: number };
type ContextRevision = ContextItem & Pick<Edge, "revisionId" | "courseId">;
export type TutorMisconceptionSnapshot = RenderedContextBlock & {
  courseId: string | null;
  effectiveCourseId?: string | null;
  privacyEpoch: number;
  revisionIds: readonly string[];
};
export type TutorMisconceptionLineage = {
  kind: "v3_misconception_lineage";
  courseId: string | null;
  revisionIds: readonly string[];
};

export function readSavedTutorMisconceptionLineage(encoded: unknown): TutorMisconceptionLineage | null {
  if (typeof encoded !== "string") return null;
  try { return parseTutorMisconceptionLineage(JSON.parse(encoded)); } catch { return null; }
}

export function parseTutorMisconceptionLineage(parsed: unknown): TutorMisconceptionLineage | null {
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length !== 3) return null;
  const { kind, courseId, revisionIds } = parsed as Record<string, unknown>;
  if (kind !== "v3_misconception_lineage" || !(courseId === null || isLineageUuid(courseId))
    || !Array.isArray(revisionIds) || !revisionIds.every(isLineageUuid)) return null;
  const ids = revisionIds.map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) return null;
  return { kind, courseId: courseId?.toLowerCase() ?? null, revisionIds: ids };
}

type Db = Sql | TransactionSql;
type TurnAlias = "t" | "a" | "dt";

function savedTurn(db: Db, alias: TurnAlias) {
  return alias === "t" ? db`t` : alias === "a" ? db`a` : db`dt`;
}

function savedTurnUsesInactiveMisconception(db: Db, alias: TurnAlias, allowedCourses: FragmentFactory[]) {
  const turn = () => savedTurn(db, alias);
  const encoded = () => db`(${turn()}).intent_hash`;
  const course = () => lineageUuid(db, () => db`payload.value->>'courseId'`);
  const revision = () => lineageUuid(db, () => db`entry.value #>> '{}'`);
  const coursePredicates = allowedCourses.reduce(
    (prior, allowed) => db`${prior} AND lineage.course_id = ${allowed()}`, db``,
  );
  return db`CASE WHEN (${turn()}).role = 'assistant' AND ${encoded()} IS NOT NULL THEN NOT EXISTS (
    SELECT 1 FROM opening_conversations conversation
    JOIN workspaces w ON w.id = conversation.workspace_id AND w.owner_user_id = conversation.owner_user_id
    CROSS JOIN LATERAL (SELECT pg_input_is_valid(${encoded()}, 'json')
      AND pg_input_is_valid(${encoded()}, 'jsonb') AS valid OFFSET 0) input
    CROSS JOIN LATERAL (SELECT CASE WHEN input.valid THEN ${encoded()}::json END AS raw_json,
      CASE WHEN input.valid THEN ${encoded()}::jsonb END AS value,
      clock_timestamp() AS at OFFSET 0) payload
    CROSS JOIN LATERAL (SELECT ${course()} AS course_id) lineage
    WHERE conversation.id = (${turn()}).conversation_id AND conversation.workspace_id = (${turn()}).workspace_id
      AND CASE WHEN json_typeof(payload.raw_json) = 'object' THEN (
        SELECT count(*) = count(DISTINCT key) FROM json_each(payload.raw_json)
      ) AND payload.value-ARRAY['kind','courseId','revisionIds'] = '{}'::jsonb ELSE false END
      AND payload.value->'kind' = '"v3_misconception_lineage"'::jsonb
      AND (payload.value->'courseId' = 'null'::jsonb OR (
        jsonb_typeof(payload.value->'courseId') = 'string'
        AND lineage.course_id = ${turnLineageCourse(db, alias, () => db`conversation.course_id`, () => db`conversation.owner_user_id`)}
        ${coursePredicates}
        AND EXISTS (SELECT 1 FROM courses c WHERE c.id = lineage.course_id AND c.workspace_id = w.id AND c.archived_at IS NULL)
      ))
      AND jsonb_typeof(payload.value->'revisionIds') = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY(SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(payload.value->'revisionIds') = 'array'
          THEN payload.value->'revisionIds' ELSE '[]'::jsonb END))) entry(value)
        CROSS JOIN LATERAL (SELECT ${revision()} AS id) revision
        LEFT JOIN v3_bitemporal_misconception_edges e ON e.revision_id = revision.id AND e.workspace_id = w.id
          AND e.owner_user_id = w.owner_user_id AND e.privacy_epoch = w.privacy_epoch
          AND (e.course_id IS NULL OR e.course_id = lineage.course_id)
          AND e.valid_range @> payload.at AND e.tx_range @> payload.at
          AND e.status IN ('candidate', 'verified', 'learner_reported')
        GROUP BY revision.id
        HAVING revision.id IS NULL OR count(*) <> 1 OR count(e.revision_id) <> 1
      )
  ) ELSE false END`;
}

/** Earlier answers may have been consumed when a restored answer has no exact lineage. */
function savedMisconceptionOrigins(db: Db, alias: TurnAlias) {
  const turn = () => savedTurn(db, alias);
  return db`SELECT (${turn()}).*
    UNION ALL
    SELECT prior_a.* FROM LATERAL (
      SELECT COALESCE(own_u.created_at, (${turn()}).created_at) AS created_at,
        COALESCE(own_u.id, (${turn()}).id) AS turn_id
      FROM (SELECT 1) one
      LEFT JOIN opening_tutor_jobs own_j ON (${turn()}).role = 'assistant'
        AND own_j.assistant_turn_id = (${turn()}).id AND own_j.workspace_id = (${turn()}).workspace_id
        AND own_j.conversation_id = (${turn()}).conversation_id
      LEFT JOIN opening_turns own_u ON own_u.id = own_j.user_turn_id
        AND own_u.workspace_id = (${turn()}).workspace_id AND own_u.conversation_id = (${turn()}).conversation_id
        AND own_u.role = 'user' AND own_u.status = 'complete'
      OFFSET 0
    ) own_pos
    JOIN opening_turns prior_a
      ON (${turn()}).role = 'assistant' AND (${turn()}).intent_hash IS NULL
      AND NOT (${turn()}).query_system AND (${turn()}).system_query IS NULL
      AND prior_a.workspace_id = (${turn()}).workspace_id AND prior_a.conversation_id = (${turn()}).conversation_id
      AND prior_a.role = 'assistant' AND prior_a.status = 'complete' AND NOT prior_a.query_system
      AND prior_a.system_query IS NULL
    LEFT JOIN opening_tutor_jobs prior_j ON prior_j.assistant_turn_id = prior_a.id
      AND prior_j.workspace_id = prior_a.workspace_id AND prior_j.conversation_id = prior_a.conversation_id
    LEFT JOIN opening_turns prior_u ON prior_u.id = prior_j.user_turn_id
      AND prior_u.workspace_id = prior_a.workspace_id AND prior_u.conversation_id = prior_a.conversation_id
      AND prior_u.role = 'user' AND prior_u.status = 'complete'
    WHERE CASE WHEN prior_u.id IS NOT NULL
      THEN (prior_u.created_at, prior_u.id) < (own_pos.created_at, own_pos.turn_id)
      ELSE (prior_a.created_at, prior_a.id) < (own_pos.created_at, own_pos.turn_id) END`;
}

/** Every inherited origin must fit both its own course and the consuming turn's course. */
export function turnUsesInactiveMisconception(db: Db, alias: TurnAlias = "t", ...courses: FragmentFactory[]) {
  const turn = () => savedTurn(db, alias);
  return db`CASE WHEN (${turn()}).role = 'assistant' THEN EXISTS (
    SELECT 1 FROM LATERAL (SELECT ${turnLineageCourse(db, alias)} AS id OFFSET 0) own_course
    CROSS JOIN LATERAL (${savedMisconceptionOrigins(db, alias)}) dt
    WHERE ${savedTurnUsesInactiveMisconception(db, "dt", [() => db`own_course.id`, ...courses])}
  ) ELSE false END`;
}

function hasSavedMemoryReferences(db: Db, refs: FragmentFactory) {
  return db`(${turnHasMemoryDependencies(db, refs)} OR ${refs()} @? '$[*].memoryDependencyIds')`;
}

export function turnHasMisconceptionMemoryDependencies(db: Db, alias: TurnAlias = "t") {
  return db`EXISTS (SELECT 1 FROM LATERAL (${savedMisconceptionOrigins(db, alias)}) origin
    LEFT JOIN opening_turns tu ON origin.role = 'assistant'
      AND tu.id = (${pairedUserTurnId(db, () => db`origin`)})
      AND tu.workspace_id = origin.workspace_id AND tu.conversation_id = origin.conversation_id
      AND tu.role = 'user' AND tu.status = 'complete'
    WHERE ${hasSavedMemoryReferences(db, () => db`origin.context_source_refs`)}
      OR (tu.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`tu.context_source_refs`)}))`;
}

export function savedTutorMisconceptionHashes(db: Db, alias: TurnAlias) {
  return db`ARRAY(
    SELECT origin.intent_hash FROM LATERAL (${savedMisconceptionOrigins(db, alias)}) origin
    WHERE origin.role = 'assistant' AND NOT origin.query_system AND origin.system_query IS NULL AND origin.intent_hash IS NOT NULL
  )`;
}

type MaterialUse = "citation" | "practice";
type SavedMemoryOrigin = {
  id: string; assistantTurnId?: string; courseId: string | null; consumerCourseId: string | null; materialUse: MaterialUse;
  refs: unknown; standalone: boolean; historical?: boolean; jobBacked?: boolean; isPairedUser?: boolean;
};
type TurnMemoryOrigin = SavedMemoryOrigin & { ids: string[]; backings: string[][] };

function memoryOriginEvidence(db: Db, alias: "t" | "dt", course: FragmentFactory, owner: FragmentFactory) {
  const root = () => savedTurn(db, alias);
  return db`SELECT side.payload
    FROM LATERAL (${savedMisconceptionOrigins(db, alias)}) origin
    LEFT JOIN opening_turns tu ON origin.role = 'assistant'
      AND tu.id = (${pairedUserTurnId(db, () => db`origin`)})
      AND tu.workspace_id = origin.workspace_id AND tu.conversation_id = origin.conversation_id
      AND tu.role = 'user' AND tu.status = 'complete'
    CROSS JOIN LATERAL (
      SELECT jsonb_build_object('id', origin.id, 'assistantTurnId', origin.id,
        'courseId', (SELECT ${turnLineageCourse(db, "dt", undefined, owner)} FROM (SELECT origin.*) dt OFFSET 0),
        'consumerCourseId', ${course()},
        'materialUse', (SELECT ${turnMaterialUse(db, "t")} FROM (SELECT origin.*) t OFFSET 0),
        'refs', origin.context_source_refs, 'standalone', CASE
          WHEN origin.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnHasStandaloneSessions(db, owner, () => db`origin`)} ELSE false END,
        'historical', origin.id <> (${root()}).id,
        'jobBacked', tu.id IS NOT NULL,
        'isPairedUser', false) AS payload
      WHERE ${hasSavedMemoryReferences(db, () => db`origin.context_source_refs`)}
      UNION ALL
      SELECT jsonb_build_object('id', tu.id, 'assistantTurnId', origin.id,
        'courseId', (SELECT ${turnLineageCourse(db, "u", undefined, owner)} FROM (SELECT tu.*) u OFFSET 0),
        'consumerCourseId', ${course()},
        'materialUse', (SELECT ${turnMaterialUse(db, "u")} FROM (SELECT tu.*) u OFFSET 0),
        'refs', tu.context_source_refs, 'standalone', CASE
          WHEN tu.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnHasStandaloneSession(db, () => db`tu`, owner)} ELSE false END,
        'historical', origin.id <> (${root()}).id,
        'jobBacked', true,
        'isPairedUser', true) AS payload
      WHERE tu.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`tu.context_source_refs`)}
    ) side`;
}

async function resolveMemoryOriginRefs(db: Db, scope: OpeningScope, rows: SavedMemoryOrigin[]) {
  const legacy = [...new Map(rows.filter(row => memoryOnlyRefSourceIds(row.refs).length).map(row => [row.id, row])).values()];
  const backings = legacy.length ? await db<{ id: string; backings: string[][] }[]>`
    SELECT saved.id, ${turnMemoryOnlyBackingIds(db, () => db`saved.refs`, () => db`saved.course_id`,
      () => db`saved.standalone`, scope)} AS backings
    FROM jsonb_to_recordset(${db.json(legacy.map(row => ({ id: row.id, refs: row.refs,
      course_id: row.courseId, standalone: row.standalone })) as never)}::jsonb)
      saved(id uuid, refs jsonb, course_id uuid, standalone boolean)` : [];
  const byId = new Map(backings.map(row => [row.id, row.backings]));
  return rows.map((row): TurnMemoryOrigin | null => {
    const ids = parseContextMemoryDependencyIds(row.refs);
    const backingIds = byId.get(row.id) ?? [];
    return ids && backingIds.length === memoryOnlyRefSourceIds(row.refs).length ? { ...row, ids, backings: backingIds } : null;
  });
}

/** Read inherited memory-bearing turns independently of restored tutor jobs. */
export async function readTurnMisconceptionMemoryOrigins(
  db: Db, scope: OpeningScope, turnIds: readonly string[],
): Promise<Map<string, (TurnMemoryOrigin | null)[]>> {
  if (!turnIds.length) return new Map();
  const course: FragmentFactory = () => db`own_course.id`;
  const rows = await db<{ id: string; origins: SavedMemoryOrigin[] }[]>`
    SELECT t.id, ARRAY(${memoryOriginEvidence(db, "t", course, () => db`c.owner_user_id`)}) AS origins
    FROM opening_turns t
    JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t", () => db`c.course_id`, () => db`c.owner_user_id`)} AS id OFFSET 0) own_course
    WHERE t.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} AND t.id=ANY(${[...turnIds]}::uuid[])`;
  const resolved = await resolveMemoryOriginRefs(db, scope, rows.flatMap(row => row.origins));
  let offset = 0;
  return new Map(rows.map(row => {
    const end = offset + row.origins.length;
    const origins = resolved.slice(offset, end);
    offset = end;
    return [row.id, origins];
  }));
}

function memoryOriginTurns(db: Db) {
  return db`unnest(ARRAY(SELECT jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(m.source_turn_ids) = 'array' THEN m.source_turn_ids ELSE '[]'::jsonb END
  ))) origin_turn(turn_id)
  LEFT JOIN LATERAL (
    SELECT saved.* FROM opening_turns saved
    WHERE saved.id=${lineageUuid(db, () => db`origin_turn.turn_id`)}
      AND saved.workspace_id=m.workspace_id AND saved.status='complete'
    OFFSET 0
  ) dt ON true`;
}

export function mergeTutorMisconceptionLineages(
  ...lineages: readonly (TutorMisconceptionLineage | undefined)[]
): TutorMisconceptionLineage | undefined {
  let courseId: string | null = null;
  const revisionIds = new Set<string>();
  for (const lineage of lineages) {
    if (!lineage) continue;
    if (courseId && lineage.courseId && courseId !== lineage.courseId) {
      throw learningError("CONFLICT", "memory misconception course binding changed");
    }
    courseId ??= lineage.courseId;
    for (const id of lineage.revisionIds) revisionIds.add(id);
  }
  return courseId || revisionIds.size ? { kind: "v3_misconception_lineage", courseId, revisionIds: [...revisionIds] } : undefined;
}

type MemoryEvidence = {
  memoryId: string; hashes: string[]; courseId?: string | null; expiresAt?: string | Date | null;
  statusActive?: boolean; active?: boolean; origins?: SavedMemoryOrigin[];
};
type MemoryLineageNode = {
  memoryCourseId: string | null; courseId: string | null; statusActive: boolean; active: boolean;
  expiresAtMs: number; lineage: TutorMisconceptionLineage | undefined; origins: (TurnMemoryOrigin | null)[];
};
export type MemoryMisconceptionBinding = {
  courseId: string | null;
  materialUse: MaterialUse;
  memoryIds: string[];
};
export type MemoryMisconceptionAuthority = {
  courseId: string | null;
  lineage: TutorMisconceptionLineage | undefined;
  dependencyIds: string[];
  dependencies: Array<{ id: string; courseId: string | null }>;
  bindings: MemoryMisconceptionBinding[];
  earliestExpiresAtMs: number;
};

const normalizeCourse = (course: string | null | undefined) => course == null ? null : course.toLowerCase();
const courseAllows = (course: string | null, ...targets: (string | null)[]) => {
  const own = normalizeCourse(course);
  return own === null || targets.every(target => normalizeCourse(target) === own);
};

async function readMemoryLineageBatch(db: Db, scope: OpeningScope, ids: string[], asOf?: string) {
  const owner: FragmentFactory = () => db`request.owner_user_id`;
  const at = () => asOf === undefined ? db`clock_timestamp()` : db`${asOf}::timestamptz`;
  return db<{ id: string | MemoryEvidence }[]>`
    SELECT id FROM opening_memories AS m(memory_id)
    JOIN (SELECT ${scope.workspaceId}::uuid AS workspace_id, ${ids}::uuid[] AS ids, ${scope.ownerUserId}::uuid AS owner_user_id) request
      ON m.workspace_id=request.workspace_id AND m.memory_id=ANY(request.ids)
    CROSS JOIN LATERAL (
      WITH origins AS MATERIALIZED (
        SELECT ${savedTutorMisconceptionHashes(db, "dt")} AS origin_hashes,
          ARRAY(${memoryOriginEvidence(db, "dt", () => db`own_course.id`, owner)}) AS memory_origins
        FROM ${memoryOriginTurns(db)}
        CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "dt", undefined, owner)} AS id OFFSET 0) own_course
        WHERE dt.id IS NOT NULL AND NOT ${turnUsesInactiveMisconception(db, "dt", () => db`m.course_id`)}
          AND EXISTS (SELECT 1 FROM opening_conversations c WHERE c.id=dt.conversation_id
            AND c.workspace_id=dt.workspace_id AND c.owner_user_id=${owner()})
      )
      SELECT CASE WHEN m.course_id IS NULL AND cardinality(lineage.hashes)=0
          AND cardinality(lineage.memory_origins)=0 AND m.status='active' AND m.kind='confirmed'
        THEN to_jsonb(m.memory_id)
        ELSE jsonb_build_object('memoryId', m.memory_id, 'hashes', lineage.hashes, 'courseId', m.course_id,
          'expiresAt', CASE WHEN m.kind='temporary' THEN m.expires_at END,
          'statusActive', m.status='active',
          'active', m.status='active' AND (m.kind='confirmed' OR (m.kind='temporary' AND m.expires_at IS NOT NULL AND m.expires_at > ${at()})),
          'origins', lineage.memory_origins) END AS id
      FROM LATERAL (SELECT ARRAY(
        SELECT DISTINCT hash FROM origins CROSS JOIN LATERAL unnest(origin_hashes) hash
      ) AS hashes, ARRAY(SELECT ref FROM origins CROSS JOIN LATERAL unnest(memory_origins) ref) AS memory_origins) lineage
      WHERE CASE WHEN jsonb_typeof(m.source_turn_ids)='array'
        THEN (SELECT count(*) FROM origins) = jsonb_array_length(m.source_turn_ids)
        ELSE false END
    ) admitted`;
}

export type MemoryMisconceptionAuthorityOptions = boolean | {
  display?: boolean;
  asOf?: string;
  allowCandidateRoots?: boolean;
};

/** Resolve exact IDs, transitive authority, bindings, and earliest temporary expiry in batches. */
export async function readMemoryMisconceptionAuthorities(
  db: Db, scope: OpeningScope, memoryIds: readonly string[], targetCourseId: string | null,
  options: MemoryMisconceptionAuthorityOptions = false,
): Promise<Map<string, MemoryMisconceptionAuthority>> {
  const display = typeof options === "boolean" ? options : options.display === true;
  const asOf = typeof options === "boolean" ? undefined : options.asOf;
  const allowCandidateRoots = typeof options === "boolean" ? false : options.allowCandidateRoots === true;
  const nodes = new Map<string, MemoryLineageNode>();
  const visited = new Set<string>();
  let frontier = [...new Set(memoryIds.map(id => id.toLowerCase()))];
  while (frontier.length) {
    for (const id of frontier) visited.add(id);
    const rows = await readMemoryLineageBatch(db, scope, frontier, asOf);
    const origins = await resolveMemoryOriginRefs(db, scope, rows.flatMap(({ id }) => typeof id === "string" ? [] : id.origins ?? []));
    let offset = 0;
    const next = new Set<string>();
    for (const { id } of rows) {
      if (typeof id === "string") {
        nodes.set(id.toLowerCase(), {
          memoryCourseId: null, courseId: null, statusActive: true, active: true,
          expiresAtMs: Infinity, lineage: undefined, origins: [],
        });
        continue;
      }
      const end = offset + (id.origins?.length ?? 0);
      const current = origins.slice(offset, end);
      offset = end;
      const hashes = id.hashes.map(readSavedTutorMisconceptionLineage);
      if (hashes.some(hash => !hash)) continue;
      const expiresAtMs = id.expiresAt == null ? Infinity : new Date(id.expiresAt).getTime();
      if (Number.isNaN(expiresAtMs)) continue;
      const lineage = mergeTutorMisconceptionLineages(...hashes.map(hash => hash ?? undefined));
      const memoryCourseId = normalizeCourse(id.courseId);
      const active = id.active ?? true;
      nodes.set(id.memoryId.toLowerCase(), {
        memoryCourseId, courseId: memoryCourseId ?? lineage?.courseId ?? null,
        statusActive: id.statusActive ?? active, active, expiresAtMs, lineage, origins: current,
      });
      for (const origin of current) {
        for (const dep of [...(origin?.ids ?? []), ...(origin?.backings.flat() ?? [])]) {
          const normalized = dep.toLowerCase();
          if (!visited.has(normalized)) next.add(normalized);
        }
      }
    }
    frontier = [...next];
  }
  const backingGraphs = new Map<MaterialUse, Map<string, MemoryDependencyStatus[]>>();
  if (!display) {
    for (const use of ["citation", "practice"] as const) {
      const legacyIds = [...new Set([...nodes.values()].flatMap(node => node.origins.flatMap(origin =>
        origin?.materialUse === use ? origin.backings.flat().map(dep => dep.toLowerCase()) : [])))];
      if (legacyIds.length) {
        backingGraphs.set(use, await readMemoryDependencyStatus(db, scope, legacyIds, { materialUse: use, includeSourceRefs: true }));
      }
    }
  }
  const resolved = new Map<string, MemoryMisconceptionAuthority>();
  const orderedNodes = [...nodes].sort(([a], [b]) => a.localeCompare(b));
  let progress = true;
  while (progress) {
    progress = false;
    for (const [id, node] of orderedNodes) {
      if (resolved.has(id)) continue;
      const lineages = [node.lineage];
      const depMap = new Map<string, string | null>();
      const bindingMap = new Map<string, { courseId: string | null; materialUse: MaterialUse; ids: Set<string> }>();
      let earliestExpiresAtMs = node.expiresAtMs;
      const addBinding = (courseId: string | null, materialUse: MaterialUse, ids: readonly string[]) => {
        if (!ids.length) return;
        const normalizedCourse = normalizeCourse(courseId);
        const key = `${normalizedCourse}|${materialUse}`;
        const existing = bindingMap.get(key) ?? { courseId: normalizedCourse, materialUse, ids: new Set<string>() };
        for (const item of ids) existing.ids.add(item.toLowerCase());
        bindingMap.set(key, existing);
      };
      const backingSourceIdsFor = (origin: TurnMemoryOrigin) => origin.ids.length ? memoryOnlyRefSourceIds(origin.refs) : undefined;
      const valid = node.origins.every(origin => {
        if (!origin) return false;
        const sourceIds = backingSourceIdsFor(origin);
        const admits = (rawDep: string, legacy: boolean, backingIndex?: number) => {
          const dep = rawDep.toLowerCase();
          const child = nodes.get(dep);
          const childAuth = resolved.get(dep);
          if (!child || !childAuth || !((display && !legacy) || child.active)) return false;
          if (legacy && backingGraphs.has(origin.materialUse)) {
            const requiredSource = sourceIds && backingIndex !== undefined ? [sourceIds[backingIndex]!] : undefined;
            if (!resolveMemoryDependencyStatus(backingGraphs.get(origin.materialUse)!, [], [[dep]],
              normalizeCourse(origin.courseId), id, requiredSource)) return false;
          }
          const memoryTargets = origin.historical
            ? [origin.courseId]
            : [node.memoryCourseId, origin.courseId, origin.isPairedUser ? origin.courseId : origin.consumerCourseId];
          return courseAllows(child.memoryCourseId, ...memoryTargets)
            && courseAllows(childAuth.lineage?.courseId ?? null, node.courseId, origin.courseId, origin.consumerCourseId);
        };
        const backings = (display && origin.ids.length ? [] : origin.backings).map((options, backingIndex) =>
          options.find(dep => admits(dep, true, backingIndex) && !resolved.get(dep.toLowerCase())?.lineage
            && resolved.get(dep.toLowerCase())!.earliestExpiresAtMs === Infinity)
          ?? options.find(dep => admits(dep, true, backingIndex) && !resolved.get(dep.toLowerCase())?.lineage)
          ?? options.find(dep => admits(dep, true, backingIndex)));
        if (!origin.ids.every(dep => admits(dep, false)) || backings.some(dep => dep === undefined)) return false;
        const chosen = [...origin.ids, ...(backings as string[])].map(dep => dep.toLowerCase());
        const joblessHistorical = Boolean(origin.historical && !origin.jobBacked);
        if (joblessHistorical) addBinding(origin.courseId, origin.materialUse, chosen);
        for (const dep of chosen) {
          const child = nodes.get(dep)!;
          const childAuth = resolved.get(dep)!;
          lineages.push(childAuth.lineage);
          if (joblessHistorical && dep !== id) depMap.set(dep, child.memoryCourseId);
          for (const sub of childAuth.dependencies) if (sub.id !== id) depMap.set(sub.id, sub.courseId);
          for (const binding of childAuth.bindings) addBinding(binding.courseId, binding.materialUse, binding.memoryIds);
          earliestExpiresAtMs = Math.min(earliestExpiresAtMs, childAuth.earliestExpiresAtMs);
        }
        return true;
      });
      if (!valid) continue;
      const mergedLineage = mergeTutorMisconceptionLineages(...lineages);
      const dependencies = [...depMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([depId, depCourseId]) => ({
        id: depId, courseId: depCourseId,
      }));
      resolved.set(id, {
        courseId: node.memoryCourseId ?? mergedLineage?.courseId ?? null,
        lineage: mergedLineage,
        dependencyIds: dependencies.map(dep => dep.id),
        dependencies,
        bindings: [...bindingMap.values()].map(b => ({
          courseId: b.courseId, materialUse: b.materialUse, memoryIds: [...b.ids].sort(),
        })),
        earliestExpiresAtMs,
      });
      progress = true;
    }
  }
  return new Map(memoryIds.flatMap(rawId => {
    const id = rawId.toLowerCase();
    const node = nodes.get(id);
    const auth = resolved.get(id);
    const rootActive = display || node?.active || (allowCandidateRoots && node?.statusActive);
    return node && rootActive && auth && courseAllows(node.memoryCourseId, targetCourseId)
      && courseAllows(auth.lineage?.courseId ?? null, targetCourseId) ? [[rawId, auth] as const] : [];
  }));
}

/** Resolve exact IDs and legacy alternative backings in batches, rejecting cycles without independent authority. */
export async function readMemoryMisconceptionLineages(
  db: Db, scope: OpeningScope, memoryIds: readonly string[], targetCourseId: string | null, display = false,
): Promise<Map<string, TutorMisconceptionLineage | undefined>> {
  const authorities = await readMemoryMisconceptionAuthorities(db, scope, memoryIds, targetCourseId, display);
  return new Map([...authorities].map(([id, auth]) => [id, auth.lineage]));
}

/** Validate memory authority in the original turn, the consuming turn, and the requested destination. */
export async function readTurnMisconceptionMemoryStatus(
  db: Db, scope: OpeningScope, turnIds: readonly string[], options: { display?: boolean; targetCourseId?: string | null } = {},
): Promise<{ invalid: Set<string>; earliestExpiresAtMs: number }> {
  const originsByTurn = await readTurnMisconceptionMemoryOrigins(db, scope, turnIds);
  const byCourse = new Map<string | null, Set<string>>();
  const memoryCoursesFor = (origin: TurnMemoryOrigin) => {
    const courses: (string | null)[] = [normalizeCourse(origin.courseId)];
    if (!origin.historical && !origin.isPairedUser) courses.push(normalizeCourse(origin.consumerCourseId));
    if (!origin.historical && options.targetCourseId !== undefined) courses.push(normalizeCourse(options.targetCourseId));
    return [...new Set(courses)];
  };
  for (const origins of originsByTurn.values()) for (const origin of origins) {
    if (!origin) continue;
    for (const course of memoryCoursesFor(origin)) {
      const ids = byCourse.get(course) ?? new Set<string>();
      for (const id of [...origin.ids, ...origin.backings.flat()]) ids.add(id.toLowerCase());
      byCourse.set(course, ids);
    }
  }
  const authorities = new Map<string | null, Map<string, MemoryMisconceptionAuthority>>();
  for (const [course, ids] of byCourse) {
    authorities.set(course, await readMemoryMisconceptionAuthorities(db, scope, [...ids], course, options.display));
  }
  const graphs = new Map<MaterialUse, Map<string, MemoryDependencyStatus[]>>();
  if (!options.display) for (const use of ["citation", "practice"] as const) {
    const ids = [...originsByTurn.values()].flatMap(origins => origins.flatMap(origin => origin?.materialUse === use
      ? [...origin.ids, ...origin.backings.flat()].map(id => id.toLowerCase())
          .filter(id => authorities.get(normalizeCourse(origin.courseId))?.has(id)) : []));
    graphs.set(use, await readMemoryDependencyStatus(db, scope, ids, { materialUse: use }));
  }
  const invalid = new Set<string>();
  let earliestExpiresAtMs = Infinity;
  const nowMs = Date.now();
  for (const turnId of turnIds) {
    const origins = originsByTurn.get(turnId);
    let turnEarliest = Infinity;
    if (!origins || origins.some(origin => {
      if (!origin) return true;
      const memoryCourses = memoryCoursesFor(origin);
      const misconceptionCourses = [
        origin.courseId, origin.consumerCourseId,
        options.targetCourseId === undefined ? origin.consumerCourseId : options.targetCourseId,
      ];
      const active = (rawId: string) => {
        const id = rawId.toLowerCase();
        if (!memoryCourses.every(course => authorities.get(course)?.has(id))) return false;
        const auth = authorities.get(normalizeCourse(origin.courseId))?.get(id);
        return Boolean(auth && courseAllows(auth.lineage?.courseId ?? null, ...misconceptionCourses)
          && (options.display || auth.earliestExpiresAtMs > nowMs));
      };
      const backings = (options.display && origin.ids.length ? [] : origin.backings).map(ids => ids.filter(active));
      if (!origin.ids.every(active) || backings.some(ids => !ids.length)) return true;
      if (options.display) return false;
      for (const rawId of origin.ids) {
        const auth = authorities.get(normalizeCourse(origin.courseId))?.get(rawId.toLowerCase());
        if (auth) turnEarliest = Math.min(turnEarliest, auth.earliestExpiresAtMs);
      }
      for (const group of backings) {
        const groupExpiry = Math.max(-Infinity, ...group.map(rawId =>
          authorities.get(normalizeCourse(origin.courseId))?.get(rawId.toLowerCase())?.earliestExpiresAtMs ?? -Infinity));
        turnEarliest = Math.min(turnEarliest, groupExpiry);
      }
      return memoryCourses.some(course => {
        const nodes = resolveMemoryDependencyStatus(graphs.get(origin.materialUse)!, origin.ids, backings, course,
          undefined, origin.ids.length ? memoryOnlyRefSourceIds(origin.refs) : undefined);
        if (!nodes) return true;
        for (const node of nodes) {
          if (node.expires_at !== null) {
            const exp = new Date(node.expires_at).getTime();
            if (!(exp > nowMs)) return true;
            turnEarliest = Math.min(turnEarliest, exp);
          }
        }
        return false;
      });
    })) invalid.add(turnId);
    else earliestExpiresAtMs = Math.min(earliestExpiresAtMs, turnEarliest);
  }
  return { invalid, earliestExpiresAtMs };
}

export async function readTurnsWithInvalidMisconceptionMemories(
  db: Db, scope: OpeningScope, turnIds: readonly string[], options: { display?: boolean; targetCourseId?: string | null } = {},
) {
  return (await readTurnMisconceptionMemoryStatus(db, scope, turnIds, options)).invalid;
}

/** Validate source turns themselves, including restored answers without a job. */
export async function readMemoryBearingMisconceptionTurns(db: Db, scope: OpeningScope, ids: readonly string[]) {
  if (!ids.length) return [];
  const rows = await db<{ id: string; bearing: boolean }[]>`
    SELECT t.id, ${turnHasMisconceptionMemoryDependencies(db)} AS bearing FROM opening_turns t
    WHERE t.workspace_id=${scope.workspaceId} AND t.id=ANY(${[...ids]}::uuid[])`;
  return rows.filter(row => row.bearing === true).map(row => row.id);
}

export async function sourceTurnsMisconceptionMemoryStatus(
  db: Db, scope: OpeningScope, turnIds: readonly string[], memoryCourseId: string | null,
): Promise<{ allowed: boolean; earliestExpiresAtMs: number }> {
  const ids = [...new Set(turnIds.map(id => id.toLowerCase()))];
  if (!ids.length) return { allowed: true, earliestExpiresAtMs: Infinity };
  if (!ids.every(isLineageUuid)) return { allowed: false, earliestExpiresAtMs: -Infinity };
  const rows = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns t
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id
    WHERE t.id = ANY(${ids}::uuid[]) AND t.workspace_id = ${scope.workspaceId}
      AND c.owner_user_id = ${scope.ownerUserId} AND t.status = 'complete'
      AND NOT ${turnUsesInactiveMisconception(db, "t", () => db`${memoryCourseId}::uuid`)}`;
  if (rows.length !== ids.length) return { allowed: false, earliestExpiresAtMs: -Infinity };
  const bearing = await readMemoryBearingMisconceptionTurns(db, scope, ids);
  if (!bearing.length) return { allowed: true, earliestExpiresAtMs: Infinity };
  const status = await readTurnMisconceptionMemoryStatus(db, scope, bearing, { targetCourseId: memoryCourseId });
  return { allowed: status.invalid.size === 0, earliestExpiresAtMs: status.invalid.size === 0 ? status.earliestExpiresAtMs : -Infinity };
}

export async function sourceTurnsAllowMisconceptionMemory(
  db: Db, scope: OpeningScope, turnIds: readonly string[], memoryCourseId: string | null,
): Promise<boolean> {
  return (await sourceTurnsMisconceptionMemoryStatus(db, scope, turnIds, memoryCourseId)).allowed;
}

/** Check saved authority against the current privacy epoch and both live time ranges. */
export async function readActiveTutorMisconceptionLineages(
  db: Sql | TransactionSql, scope: OpeningScope, lineages: readonly TutorMisconceptionLineage[],
): Promise<Set<number>> {
  if (!lineages.length) return new Set();
  const rows = await db<{ position: number }[]>`
    WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT lineage.position
    FROM workspaces w CROSS JOIN tick
    CROSS JOIN jsonb_to_recordset(${db.json(lineages.map(({ courseId, revisionIds }, position) =>
      ({ position, course_id: courseId, revision_ids: [...revisionIds] })))}::jsonb)
      AS lineage(position integer, course_id uuid, revision_ids uuid[])
    WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId}
      AND (lineage.course_id IS NULL OR EXISTS (
        SELECT 1 FROM courses c WHERE c.id = lineage.course_id AND c.workspace_id = w.id AND c.archived_at IS NULL
      ))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(lineage.revision_ids) AS revision(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM v3_bitemporal_misconception_edges e
          WHERE e.revision_id = revision.id AND e.workspace_id = w.id AND e.owner_user_id = w.owner_user_id
            AND e.privacy_epoch = w.privacy_epoch AND (e.course_id IS NULL OR e.course_id = lineage.course_id)
            AND e.valid_range @> tick.at AND e.tx_range @> tick.at
            AND e.status IN ('candidate', 'verified', 'learner_reported')
        )
      )`;
  return new Set(rows.map(row => row.position));
}

type Revision = { edgeId: string; revisionId: string; txAt: string };
type TryHandoffClock = { readonly nowMs: number; readonly issueSeq: number };
type TryMisconceptionClaim = Pick<Edge, "conceptKey" | "misconceptionCode" | "summary"> & {
  receiptId: string;
  payloadSha256: string;
  issueSeq: number;
  expiresAt: number;
};

/** Use the same clock as redemption and the same sequence as backup restore. */
export async function readTryMisconceptionHandoffClock(sql: Sql | TransactionSql): Promise<TryHandoffClock> {
  const [clock] = await sql<{ nowMs: string; issueSeq: string }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS "nowMs",
      nextval('v3_try_misconception_handoff_seq')::text AS "issueSeq"`;
  const nowMs = Number(clock?.nowMs);
  const issueSeq = Number(clock?.issueSeq);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(issueSeq) || issueSeq <= 0) {
    throw new Error("Invalid PostgreSQL misconception handoff clock");
  }
  return { nowMs, issueSeq };
}
type LearnerCorrection = {
  edgeId: string;
  disposition: LearnerMisconceptionDisposition;
  summary: string;
};

const dispositionLabels: Record<LearnerMisconceptionDisposition, string> = {
  disputed: "学习者提出异议",
  clarified: "学习者补充说明",
  resolved_self_report: "学习者自述已解决",
};

export function renderLearnerContextBlock(items: readonly ContextItem[]) {
  const block = { renderedMarkdown: "", byteLength: 0 };
  appendLearnerContextItems(block, items);
  return block;
}

/** Return false once the renderer has reached the byte limit. */
function appendLearnerContextItems<T extends ContextItem>(
  block: RenderedContextBlock, items: readonly T[], onIncluded?: (item: T) => void,
): boolean {
  for (const item of items) {
    if (item.status === "retracted" || item.status === "superseded") continue;
    const text = item.summary.replace(/[\s\p{Cc}]+/gu, " ").trim()
      .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
    if (!text) continue;
    const label = item.learnerDisposition ? dispositionLabels[item.learnerDisposition]
      : item.status === "verified" ? "已确认" : "待确认";
    const prefix = (block.renderedMarkdown ? "\n- " : "- ") + label + "：";
    const prefixBytes = Buffer.byteLength(prefix);
    const characters: string[] = [];
    let lineBytes = prefixBytes;
    let truncated = false;
    for (const character of text) {
      const literal = "\\`*_{}[]<>()#+-.!|&~".includes(character) ? "\\" + character : character;
      const bytes = Buffer.byteLength(literal);
      if (block.byteLength + lineBytes + bytes > LEARNER_CONTEXT_MAX_BYTES) {
        truncated = true;
        break;
      }
      characters.push(literal);
      lineBytes += bytes;
    }
    if (characters.length) {
      block.renderedMarkdown += prefix + characters.join("");
      block.byteLength += lineBytes;
      onIncluded?.(item);
    }
    if (truncated || block.byteLength === LEARNER_CONTEXT_MAX_BYTES) return false;
  }
  return true;
}

/** Acquire the workspace lock before any course or revision row locks. */
export async function lockMisconceptionWorkspaceForWrite(tx: TransactionSql, scope: OpeningScope): Promise<number> {
  await lockWorkspaceLearningHistory(tx, scope);
  // Serialize writers and context rebuilds while allowing foreign-key key shares.
  const [workspace] = await tx<{ privacy_epoch: number }[]>`
    SELECT privacy_epoch FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR NO KEY UPDATE`;
  if (!workspace) throw learningError("NOT_FOUND", "学习空间不存在。");
  return workspace.privacy_epoch;
}

export async function lockMisconceptionContext(tx: TransactionSql, workspaceId: string) {
  // The migration's revision trigger holds this same lock when invalidating the cache.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('v3:learner-context:' || ${workspaceId}::uuid::text, 0))`;
}

/** Call after the final revision mutation, with the workspace lock still held. */
export async function refreshLearnerMisconceptionContextBlock(
  tx: TransactionSql, scope: OpeningScope, privacyEpoch: number, at: string, restoreCutoffSeq?: number,
): Promise<ContextBlock> {
  await lockMisconceptionContext(tx, scope.workspaceId);
  await tx`SET CONSTRAINTS v3_invalidate_misconception_context IMMEDIATE`;
  await tx`SET CONSTRAINTS v3_invalidate_misconception_context DEFERRED`;
  return writeLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, at, restoreCutoffSeq);
}

function misconceptionContextPages(tx: TransactionSql, scope: OpeningScope, at: string, courseId?: string | null) {
  // Exclude ASCII blanks and controls in SQL. The renderer handles Unicode whitespace across pages.
  const blankSummary = "^[ \u0001-\u001f\u007f-\u009f]*$";
  return tx<ContextRevision[]>`
    SELECT e.status, e.learner_disposition AS "learnerDisposition", e.summary, e.revision_id AS "revisionId", e.course_id AS "courseId"
    FROM v3_bitemporal_misconception_edges e
    JOIN workspaces w ON w.id = e.workspace_id AND w.owner_user_id = e.owner_user_id
    WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
      AND e.privacy_epoch = w.privacy_epoch
      AND (${courseId === undefined} OR e.course_id IS NULL OR e.course_id = ${courseId ?? null}::uuid)
      AND e.valid_range @> ${at}::text::timestamptz AND e.tx_range @> ${at}::text::timestamptz
      AND e.status IN ('candidate', 'verified', 'learner_reported')
      AND e.summary COLLATE "C" !~ ${blankSummary}
    ORDER BY (e.status = 'learner_reported') DESC, lower(e.tx_range) DESC, e.edge_id, e.revision_id`.cursor(64);
}

async function writeLearnerMisconceptionContextBlock(
  tx: TransactionSql, scope: OpeningScope, privacyEpoch: number, at: string, restoreCutoffSeq?: number,
): Promise<ContextBlock> {
  const rendered = { renderedMarkdown: "", byteLength: 0 };
  for await (const items of misconceptionContextPages(tx, scope, at)) {
    if (!appendLearnerContextItems(rendered, items)) break;
  }
  const { renderedMarkdown, byteLength } = rendered;
  const [block] = await tx<ContextBlock[]>`
    INSERT INTO v3_learner_context_blocks
      (workspace_id, owner_user_id, rendered_markdown, byte_length, revision, privacy_epoch, updated_at, restore_cutoff_seq)
    VALUES (${scope.workspaceId}, ${scope.ownerUserId}, ${renderedMarkdown}, ${byteLength}, 1, ${privacyEpoch},
      ${at}::text::timestamptz, ${restoreCutoffSeq ?? null}::bigint)
    ON CONFLICT (workspace_id, owner_user_id) DO UPDATE
    SET rendered_markdown = EXCLUDED.rendered_markdown, byte_length = EXCLUDED.byte_length, invalidated = false,
      revision = v3_learner_context_blocks.revision + 1, privacy_epoch = EXCLUDED.privacy_epoch, updated_at = EXCLUDED.updated_at,
      restore_cutoff_seq = GREATEST(EXCLUDED.restore_cutoff_seq, v3_learner_context_blocks.restore_cutoff_seq)
    RETURNING rendered_markdown AS "renderedMarkdown", byte_length AS "byteLength", revision`;
  return block!;
}

async function readTutorMisconceptionSnapshotInTx(
  tx: TransactionSql, scope: OpeningScope, { courseId, expectedPrivacyEpoch }: {
    courseId: string | null;
    expectedPrivacyEpoch?: number;
  },
): Promise<TutorMisconceptionSnapshot | null> {
  const [workspace] = await tx<{ privacy_epoch: number }[]>`
    SELECT privacy_epoch FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
  if (!workspace) return null;
  const privacyEpoch = workspace.privacy_epoch;
  if (expectedPrivacyEpoch !== undefined && privacyEpoch !== expectedPrivacyEpoch) {
    throw Object.assign(new Error("learner misconception privacy epoch changed"), { code: "PRIVACY_EPOCH_MISMATCH" });
  }
  await lockMisconceptionContext(tx, scope.workspaceId);
  const [clock] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
  const rendered = { renderedMarkdown: "", byteLength: 0 };
  const revisionIds: string[] = [];
  let effectiveCourseId: string | null = null;
  for await (const items of misconceptionContextPages(tx, scope, clock!.at, courseId)) {
    if (!appendLearnerContextItems(rendered, items, item => {
      revisionIds.push(item.revisionId);
      if (item.courseId != null) effectiveCourseId = item.courseId.toLowerCase();
    })) break;
  }
  return { courseId: courseId?.toLowerCase() ?? null, effectiveCourseId, privacyEpoch, revisionIds, ...rendered };
}

export async function readTutorLearnerMisconceptionContext(
  sql: Sql, scope: OpeningScope, input: { courseId: string | null; expectedPrivacyEpoch?: number },
): Promise<TutorMisconceptionSnapshot | null> {
  return sql.begin(tx => readTutorMisconceptionSnapshotInTx(tx, scope, input));
}

export async function assertTutorLearnerMisconceptionSnapshotInTx(
  tx: TransactionSql, scope: OpeningScope, snapshot: TutorMisconceptionSnapshot,
): Promise<void> {
  const current = await readTutorMisconceptionSnapshotInTx(tx, scope, {
    courseId: snapshot.courseId, expectedPrivacyEpoch: snapshot.privacyEpoch,
  });
  if (!current || current.renderedMarkdown !== snapshot.renderedMarkdown
    || (snapshot.effectiveCourseId !== undefined && (snapshot.effectiveCourseId?.toLowerCase() ?? null) !== current.effectiveCourseId)
    || current.revisionIds.length !== snapshot.revisionIds.length
    || current.revisionIds.some((id, index) => id !== snapshot.revisionIds[index])) {
    throw learningError("CONFLICT", "learner misconception context changed");
  }
}

export async function assertTutorLearnerMisconceptionSnapshot(
  sql: Sql, scope: OpeningScope, snapshot: TutorMisconceptionSnapshot,
): Promise<void> {
  await sql.begin(tx => assertTutorLearnerMisconceptionSnapshotInTx(tx, scope, snapshot));
}

export async function readLearnerMisconceptionContextBlock(sql: Sql, scope: OpeningScope): Promise<ContextBlock | null> {
  return sql.begin(async tx => {
    const [workspace] = await tx<{ privacy_epoch: number }[]>`
      SELECT privacy_epoch FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
    if (!workspace) return null;
    // Read revision snapshots without row locks while holding the invalidation lock.
    await lockMisconceptionContext(tx, scope.workspaceId);
    const [clock] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
    const at = clock!.at;
    const [cached] = await tx<ContextBlock[]>`
      SELECT b.rendered_markdown AS "renderedMarkdown", b.byte_length AS "byteLength", b.revision
      FROM v3_learner_context_blocks b
      WHERE b.workspace_id = ${scope.workspaceId} AND b.owner_user_id = ${scope.ownerUserId}
        AND b.privacy_epoch = ${workspace.privacy_epoch}
        AND NOT b.invalidated
        AND b.updated_at <= ${at}::text::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM v3_bitemporal_misconception_edges e
          WHERE e.workspace_id = b.workspace_id AND e.owner_user_id = b.owner_user_id AND e.privacy_epoch = b.privacy_epoch
            AND (e.valid_range @> b.updated_at AND e.tx_range @> b.updated_at) IS DISTINCT FROM
                (e.valid_range @> ${at}::text::timestamptz AND e.tx_range @> ${at}::text::timestamptz)
        )`;
    if (cached) return cached;
    return writeLearnerMisconceptionContextBlock(tx, scope, workspace.privacy_epoch, at);
  });
}

// Bind timestamp text before casting so postgres.js preserves microseconds.
export async function queryMisconceptionEdgesAsOf(
  sql: Sql | TransactionSql,
  scope: OpeningScope,
  { validAt, txAt, courseId, expectedPrivacyEpoch }: {
    validAt: string | Date;
    txAt: string | Date;
    courseId?: string;
    expectedPrivacyEpoch?: number;
  },
): Promise<Edge[]> {
  return sql<Edge[]>`
    SELECT e.revision_id AS "revisionId", e.workspace_id AS "workspaceId", e.owner_user_id AS "ownerUserId",
      e.edge_id AS "edgeId", e.course_id AS "courseId", e.concept_key AS "conceptKey", e.misconception_code AS "misconceptionCode",
      e.summary, e.status, e.origin, e.learner_disposition AS "learnerDisposition", e.evidence_attempt_ids AS "evidenceAttemptIds",
      e.privacy_epoch AS "privacyEpoch", e.valid_range::text AS "validRange", e.tx_range::text AS "txRange",
      CASE WHEN p.privacy_epoch = w.privacy_epoch THEN p.revision_id ELSE NULL END AS "priorRevisionId"
    FROM v3_bitemporal_misconception_edges e
    JOIN workspaces w ON w.id = e.workspace_id AND w.owner_user_id = e.owner_user_id
    LEFT JOIN v3_bitemporal_misconception_edges p ON p.workspace_id = e.workspace_id AND p.owner_user_id = e.owner_user_id
      AND p.edge_id = e.edge_id AND p.revision_id = e.prior_revision_id
    WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
      AND e.valid_range @> ${validAt instanceof Date ? validAt.toISOString() : validAt}::text::timestamptz
      AND e.tx_range @> ${txAt instanceof Date ? txAt.toISOString() : txAt}::text::timestamptz
      AND (${courseId ?? null}::uuid IS NULL OR e.course_id = ${courseId ?? null}::uuid)
      AND e.privacy_epoch = w.privacy_epoch
      AND (${expectedPrivacyEpoch ?? null}::integer IS NULL
        OR w.privacy_epoch = ${expectedPrivacyEpoch ?? null}::integer)
    ORDER BY e.edge_id`;
}

export async function applyLearnerMisconceptionCorrection(sql: Sql, scope: OpeningScope, input: LearnerCorrection) {
  return sql.begin(async tx => {
    const privacyEpoch = await lockMisconceptionWorkspaceForWrite(tx, scope);
    // Protect the successor's course FK before locking any revision rows.
    const [course] = await tx<{ id: string }[]>`
      SELECT c.id FROM courses c
      WHERE c.workspace_id = ${scope.workspaceId} AND c.id IN (
        SELECT e.course_id FROM v3_bitemporal_misconception_edges e
        WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
          AND e.edge_id = ${input.edgeId} AND e.course_id IS NOT NULL
      )
      ORDER BY c.id FOR KEY SHARE OF c`;
    // A direct insert between statements must not introduce a course we did not lock.
    const lockedCourseId = course?.id ?? null;
    // Lock open transaction slices before sampling time while allowing predecessor FK key shares.
    await tx`
      SELECT revision_id FROM v3_bitemporal_misconception_edges
      WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        AND edge_id = ${input.edgeId} AND privacy_epoch = ${privacyEpoch} AND upper_inf(tx_range)
        AND (course_id IS NULL OR course_id = ${lockedCourseId}::uuid)
      ORDER BY revision_id FOR NO KEY UPDATE`;
    const [revision] = await tx<Revision[]>`
      WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at),
      closed AS (
        UPDATE v3_bitemporal_misconception_edges e
        SET tx_range = tstzrange(lower(e.tx_range), GREATEST(tick.at, lower(e.tx_range) + interval '1 microsecond'), '[)')
        FROM tick
        WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
          AND e.edge_id = ${input.edgeId} AND e.privacy_epoch = ${privacyEpoch} AND upper_inf(e.tx_range)
          AND (e.course_id IS NULL OR e.course_id = ${lockedCourseId}::uuid)
          AND e.valid_range @> tick.at
        RETURNING e.*
      )
      INSERT INTO v3_bitemporal_misconception_edges
        (revision_id, workspace_id, owner_user_id, edge_id, course_id, concept_key, misconception_code,
         summary, status, origin, learner_disposition, evidence_attempt_ids, privacy_epoch, valid_range, tx_range, prior_revision_id)
      SELECT ${randomUUID()}, workspace_id, owner_user_id, edge_id, course_id, concept_key, misconception_code,
        ${input.summary}, 'learner_reported', 'learner_correction', ${input.disposition}, evidence_attempt_ids, privacy_epoch,
        valid_range, tstzrange(upper(tx_range), NULL, '[)'), revision_id
      FROM closed
      RETURNING edge_id AS "edgeId", revision_id AS "revisionId", lower(tx_range)::text AS "txAt"`;
    if (!revision) throw learningError("NOT_FOUND", "找不到这条待纠偏的学习记录。");
    const contextBlock = await refreshLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, revision.txAt);
    return { ...revision, status: "learner_reported" as const, disposition: input.disposition, contextBlock };
  });
}

function deriveTryHandoffUuid(kind: "edge" | "initial-revision", identity: string): string {
  const bytes = createHash("sha256").update(`opening:try-misconception:v1:${kind}:${identity.toLowerCase()}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function redeemTryMisconceptionHandoff(sql: Sql, scope: OpeningScope, claim: TryMisconceptionClaim) {
  const edgeId = deriveTryHandoffUuid("edge", claim.receiptId);
  const initialRevisionId = deriveTryHandoffUuid("initial-revision", `${claim.receiptId}:${claim.payloadSha256}`);
  return sql.begin(async tx => {
    const privacyEpoch = await lockMisconceptionWorkspaceForWrite(tx, scope);
    // A receipt can race across independently locked workspaces.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('v3:try-misconception:' || ${claim.receiptId}::uuid::text, 0))`;
    const [clock] = await tx<{ at: string; expired: boolean }[]>`
      WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT at::text, floor(extract(epoch FROM at) * 1000)::bigint >= ${claim.expiresAt}::bigint AS expired FROM tick`;
    if (clock!.expired) throw learningError("CONFLICT", "体验记录已过期。");
    const [prior] = await tx<{
      workspaceId: string | null; edgeId: string | null; revisionId: string | null; claimMatches: boolean; matches: boolean | null;
    }[]>`
      SELECT r.workspace_id AS "workspaceId", r.edge_id AS "edgeId", r.initial_revision_id AS "revisionId",
        (r.original_workspace_id = ${scope.workspaceId} AND r.original_owner_user_id = ${scope.ownerUserId}
          AND r.original_edge_id = ${edgeId} AND r.original_initial_revision_id = ${initialRevisionId}
          AND r.redeemed_privacy_epoch = ${privacyEpoch} AND r.payload_sha256 = ${claim.payloadSha256}) AS "claimMatches",
        (e.privacy_epoch = ${privacyEpoch} AND e.prior_revision_id IS NULL AND e.course_id IS NULL
          AND cardinality(e.evidence_attempt_ids) = 0 AND e.origin = 'public_try_handoff' AND e.status = 'candidate'
          AND e.concept_key = ${claim.conceptKey} AND e.misconception_code = ${claim.misconceptionCode}
          AND e.summary = ${claim.summary}) AS matches
      FROM v3_try_misconception_handoff_receipts r
      LEFT JOIN v3_bitemporal_misconception_edges e ON e.workspace_id = r.workspace_id AND e.owner_user_id = r.owner_user_id
        AND e.edge_id = r.edge_id AND e.revision_id = r.initial_revision_id
      WHERE r.receipt_id = ${claim.receiptId}`;
    if (prior) {
      if (!prior.claimMatches) throw learningError("CONFLICT", "体验记录已被使用。");
      if (prior.workspaceId !== null) {
        if (!prior.matches || prior.edgeId !== edgeId || prior.revisionId !== initialRevisionId) {
          throw learningError("CONFLICT", "体验记录已被使用。");
        }
        return { edgeId, revisionId: initialRevisionId, replayed: true };
      }
    }

    // Look up both identities globally to detect restored revision or edge collisions.
    const [root] = await tx<{ revisionId: string; matches: boolean }[]>`
      SELECT revision_id AS "revisionId",
        (edge_id = ${edgeId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND privacy_epoch = ${privacyEpoch}
          AND prior_revision_id IS NULL AND course_id IS NULL AND cardinality(evidence_attempt_ids) = 0
          AND origin = 'public_try_handoff' AND status = 'candidate' AND concept_key = ${claim.conceptKey}
          AND misconception_code = ${claim.misconceptionCode} AND summary = ${claim.summary}) AS matches
      FROM v3_bitemporal_misconception_edges
      WHERE revision_id = ${initialRevisionId} OR (edge_id = ${edgeId} AND prior_revision_id IS NULL)
      ORDER BY (revision_id = ${initialRevisionId}) DESC, revision_id LIMIT 1`;
    const at = clock!.at;
    if (prior) {
      if (!root?.matches || root.revisionId.toLowerCase() !== initialRevisionId) {
        throw learningError("CONFLICT", "体验记录已被使用。");
      }
      // Hold the existing revision before taking a receipt row lock.
      const [locked] = await tx`
        SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE revision_id = ${initialRevisionId} FOR KEY SHARE`;
      if (!locked) throw learningError("CONFLICT", "体验记录已被使用。");
      const [reattached] = await tx`
        UPDATE v3_try_misconception_handoff_receipts
        SET workspace_id = ${scope.workspaceId}, owner_user_id = ${scope.ownerUserId},
          edge_id = ${edgeId}, initial_revision_id = ${initialRevisionId}, redeemed_at = ${at}::text::timestamptz
        WHERE receipt_id = ${claim.receiptId} AND workspace_id IS NULL
          AND original_workspace_id = ${scope.workspaceId} AND original_owner_user_id = ${scope.ownerUserId}
          AND original_edge_id = ${edgeId} AND original_initial_revision_id = ${initialRevisionId}
          AND redeemed_privacy_epoch = ${privacyEpoch} AND payload_sha256 = ${claim.payloadSha256}
        RETURNING receipt_id`;
      if (!reattached) throw learningError("CONFLICT", "体验记录已被使用。");
      return { edgeId, revisionId: initialRevisionId, replayed: true };
    }

    // An archive root alone cannot establish a server receipt claim.
    if (root) throw learningError("CONFLICT", "体验记录已被使用。");
    // Restore and redemption serialize on the workspace lock, without locking the cache row here.
    const [cutoff] = await tx<{ blocked: boolean }[]>`
      SELECT true AS blocked FROM v3_learner_context_blocks
      WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        AND ${claim.issueSeq}::bigint <= restore_cutoff_seq`;
    if (cutoff?.blocked) throw learningError("CONFLICT", "体验记录已被使用。");
    const [inserted] = await tx`
      INSERT INTO v3_bitemporal_misconception_edges
        (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code, summary, status, origin,
         privacy_epoch, valid_range, tx_range)
      VALUES (${initialRevisionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, ${claim.conceptKey},
        ${claim.misconceptionCode}, ${claim.summary}, 'candidate', 'public_try_handoff', ${privacyEpoch},
        tstzrange(${at}::text::timestamptz, NULL, '[)'), tstzrange(${at}::text::timestamptz, NULL, '[)'))
      ON CONFLICT DO NOTHING RETURNING revision_id`;
    if (!inserted) throw learningError("CONFLICT", "体验记录已被使用。");
    const [claimed] = await tx`
      INSERT INTO v3_try_misconception_handoff_receipts
        (receipt_id, original_workspace_id, original_owner_user_id, original_edge_id, original_initial_revision_id, redeemed_privacy_epoch,
         workspace_id, owner_user_id, payload_sha256, edge_id, initial_revision_id, redeemed_at)
      VALUES (${claim.receiptId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, ${initialRevisionId}, ${privacyEpoch},
        ${scope.workspaceId}, ${scope.ownerUserId}, ${claim.payloadSha256}, ${edgeId}, ${initialRevisionId}, ${at}::text::timestamptz)
      ON CONFLICT (receipt_id) DO NOTHING
      RETURNING receipt_id`;
    if (!claimed) throw learningError("CONFLICT", "体验记录已被使用。");
    await refreshLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, at);
    return { edgeId, revisionId: initialRevisionId, replayed: false };
  });
}
