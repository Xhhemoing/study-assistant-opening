import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { LEARNER_CONTEXT_MAX_BYTES, type LearnerMisconceptionDisposition, type v3BitemporalMisconceptionEdges } from "../schema/v3-bitemporal-memory";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import {
  isLineageUuid, lineageUuid, memoryBacksSource, memoryDependencyRows, memoryOnlyRefSourceIds, pairedUserTurnId,
  parseContextMemoryDependencyIds, resolveMemoryDependencyStatus, turnHasMemoryDependencies, turnHasStandaloneSession,
  turnHasStandaloneSessions, turnLineageCourse, turnLearningSessionCourse, turnMaterialUse,
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

function savedTurn(db: Db, alias: TurnAlias): ReturnType<FragmentFactory> {
  return alias === "t" ? db`t` : alias === "a" ? db`a` : db`dt`;
}

export function savedTurnUsesInactiveMisconception(db: Db, alias: TurnAlias, allowedCourses: FragmentFactory[]) {
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

export function hasSavedMemoryReferences(db: Db, refs: FragmentFactory) {
  return db`(${turnHasMemoryDependencies(db, refs)} OR ${refs()} @? '$[*].memoryDependencyIds')`;
}

/** Earlier answers may have been consumed when a restored answer has no exact lineage. */
function savedMisconceptionOrigins(db: Db, alias: TurnAlias, filter: "hashed" | "memory") {
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
      ${filter === "hashed" ? db`AND prior_a.intent_hash IS NOT NULL` : db``}
    LEFT JOIN opening_tutor_jobs prior_j ON prior_j.assistant_turn_id = prior_a.id
      AND prior_j.workspace_id = prior_a.workspace_id AND prior_j.conversation_id = prior_a.conversation_id
    LEFT JOIN opening_turns prior_u ON prior_u.id = prior_j.user_turn_id
      AND prior_u.workspace_id = prior_a.workspace_id AND prior_u.conversation_id = prior_a.conversation_id
      AND prior_u.role = 'user' AND prior_u.status = 'complete'
    WHERE ${filter === "memory" ? db`(${hasSavedMemoryReferences(db, () => db`prior_a.context_source_refs`)}
        OR (prior_u.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`prior_u.context_source_refs`)})) AND ` : db``}CASE WHEN prior_u.id IS NOT NULL
      THEN (prior_u.created_at, prior_u.id) < (own_pos.created_at, own_pos.turn_id)
      ELSE (prior_a.created_at, prior_a.id) < (own_pos.created_at, own_pos.turn_id) END`;
}

function turnIsHashlessNonQueryAssistant(db: Db, turn: FragmentFactory) {
  return db`(${turn()}).role = 'assistant' AND (${turn()}).intent_hash IS NULL
    AND NOT (${turn()}).query_system AND (${turn()}).system_query IS NULL`;
}

function turnPosition(db: Db, turn: FragmentFactory) {
  return db`(
    SELECT COALESCE(pu.created_at, (${turn()}).created_at) AS pos_at,
      COALESCE(pu.id, (${turn()}).id) AS pos_id,
      pu.context_anchor AS u_anchor,
      pu.learning_session_id AS u_session_id,
      pu.workspace_id AS u_workspace_id,
      pu.id AS u_id
    FROM (SELECT 1) one
    LEFT JOIN opening_turns pu ON (${turn()}).role = 'assistant'
      AND pu.id = (${pairedUserTurnId(db, turn)})
      AND pu.workspace_id = (${turn()}).workspace_id AND pu.conversation_id = (${turn()}).conversation_id
      AND pu.role = 'user' AND pu.status = 'complete'
    OFFSET 0
  )`;
}

function latestHashlessMismatchBefore(db: Db, turn: FragmentFactory, ownCourse: FragmentFactory) {
  return db`SELECT (hm_pos.pos_at) AS pos_at, hm_pos.pos_id
    FROM opening_conversations hm_c
    CROSS JOIN LATERAL ${turnPosition(db, turn)} own_pos
    JOIN opening_turns hm_t ON hm_t.workspace_id = hm_c.workspace_id AND hm_t.conversation_id = hm_c.id
    CROSS JOIN LATERAL ${turnPosition(db, () => db`hm_t`)} hm_pos
    WHERE hm_c.id = (${turn()}).conversation_id AND hm_c.workspace_id = (${turn()}).workspace_id
      AND hm_c.course_id IS NULL
      AND hm_t.role = 'assistant' AND hm_t.status = 'complete'
      AND hm_t.intent_hash IS NULL AND NOT hm_t.query_system AND hm_t.system_query IS NULL
      AND (hm_pos.pos_at, hm_pos.pos_id) < (own_pos.pos_at, own_pos.pos_id)
      AND COALESCE(
        ${lineageUuid(db, () => db`hm_t.context_anchor->>'courseId'`)},
        ${turnLearningSessionCourse(db, () => db`hm_t`, () => db`hm_c.owner_user_id`)},
        CASE WHEN hm_pos.u_id IS NOT NULL THEN COALESCE(
          ${lineageUuid(db, () => db`hm_pos.u_anchor->>'courseId'`)},
          (SELECT ls.course_id FROM opening_learning_sessions ls
            WHERE ls.id = hm_pos.u_session_id AND ls.workspace_id = hm_pos.u_workspace_id
              AND ls.owner_user_id = hm_c.owner_user_id)
        ) END
      ) IS DISTINCT FROM ${ownCourse()}
    ORDER BY hm_pos.pos_at DESC, hm_pos.pos_id DESC
    LIMIT 1`;
}

function turnUsesInactiveMisconceptionWithMismatch(
  db: Db, alias: TurnAlias, ownCourse: FragmentFactory, latestHm: FragmentFactory, courses: FragmentFactory[],
) {
  const turn = () => savedTurn(db, alias);
  return db`EXISTS (
    SELECT 1 FROM (SELECT (${turn()}).id AS id) root_turn
    CROSS JOIN LATERAL (${savedMisconceptionOrigins(db, alias, "hashed")}) dt
    LEFT JOIN LATERAL ${turnPosition(db, () => db`dt`)} dt_pos
      ON ${latestHm()}.pos_id IS NOT NULL AND (dt).id <> root_turn.id
    WHERE ${savedTurnUsesInactiveMisconception(db, "dt", [ownCourse, ...courses])}
      OR (
        ${latestHm()}.pos_id IS NOT NULL
        AND (dt).id <> root_turn.id
        AND (dt).intent_hash IS NOT NULL
        AND CASE WHEN pg_input_is_valid((dt).intent_hash, 'jsonb')
          THEN ((dt).intent_hash::jsonb)->'courseId' IS DISTINCT FROM 'null'::jsonb
          ELSE false END
        AND (dt_pos.pos_at, dt_pos.pos_id) < (${latestHm()}.pos_at, ${latestHm()}.pos_id)
      )
  )`;
}

/** Every inherited origin must fit both its own course and the consuming turn's course. */
export function turnUsesInactiveMisconception(db: Db, alias: TurnAlias = "t", ...courses: FragmentFactory[]) {
  const turn = () => savedTurn(db, alias);
  return db`CASE WHEN (${turn()}).role = 'assistant' THEN EXISTS (
    SELECT 1 FROM LATERAL (SELECT ${turnLineageCourse(db, alias)} AS id OFFSET 0) own_course
    LEFT JOIN LATERAL (${latestHashlessMismatchBefore(db, turn, () => db`own_course.id`)}) latest_hm
      ON ${turnIsHashlessNonQueryAssistant(db, turn)} AND own_course.id IS NOT NULL
    WHERE ${turnUsesInactiveMisconceptionWithMismatch(db, alias, () => db`own_course.id`, () => db`latest_hm`, courses)}
  ) ELSE false END`;
}

export function turnHasMisconceptionMemoryDependencies(db: Db, alias: TurnAlias = "t") {
  return db`EXISTS (SELECT 1 FROM LATERAL (${savedMisconceptionOrigins(db, alias, "memory")}) origin
    LEFT JOIN opening_turns tu ON origin.role = 'assistant'
      AND tu.id = (${pairedUserTurnId(db, () => db`origin`)})
      AND tu.workspace_id = origin.workspace_id AND tu.conversation_id = origin.conversation_id
      AND tu.role = 'user' AND tu.status = 'complete'
    WHERE ${hasSavedMemoryReferences(db, () => db`origin.context_source_refs`)}
      OR (tu.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`tu.context_source_refs`)}))`;
}

/** Single-pass per-conversation lineage summary so multi-turn display queries avoid quadratic prefix rescans. */
export function conversationMisconceptionLineage(db: Db, workspaceId: string, conversationId: string) {
  return db`(
    WITH conv_scan AS MATERIALIZED (
      SELECT COALESCE(du.created_at, dt.created_at) AS pos_at,
        COALESCE(du.id, dt.id) AS pos_id,
        COALESCE(dt_hash.is_invalid, false) AS is_invalid,
        dt_hash.valid_course_id,
        (${hasSavedMemoryReferences(db, () => db`dt.context_source_refs`)}
          OR (du.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`du.context_source_refs`)})) AS has_mem
      FROM opening_turns dt
      LEFT JOIN opening_tutor_jobs dj ON dj.assistant_turn_id = dt.id
        AND dj.workspace_id = dt.workspace_id AND dj.conversation_id = dt.conversation_id
      LEFT JOIN opening_turns du ON du.id = dj.user_turn_id
        AND du.workspace_id = dt.workspace_id AND du.conversation_id = dt.conversation_id
        AND du.role = 'user' AND du.status = 'complete'
      LEFT JOIN LATERAL (
        SELECT status.is_invalid,
          CASE WHEN NOT status.is_invalid AND input.valid AND jsonb_typeof(payload.value) = 'object'
            THEN ${lineageUuid(db, () => db`payload.value->>'courseId'`)} END AS valid_course_id
        FROM (SELECT pg_input_is_valid(dt.intent_hash, 'json')
          AND pg_input_is_valid(dt.intent_hash, 'jsonb') AS valid OFFSET 0) input
        CROSS JOIN LATERAL (SELECT CASE WHEN input.valid THEN dt.intent_hash::jsonb END AS value OFFSET 0) payload
        CROSS JOIN LATERAL (SELECT ${savedTurnUsesInactiveMisconception(db, "dt", [])} AS is_invalid OFFSET 0) status
        OFFSET 0
      ) dt_hash ON dt.intent_hash IS NOT NULL
      WHERE dt.workspace_id = ${workspaceId} AND dt.conversation_id = ${conversationId}
        AND dt.role = 'assistant' AND dt.status = 'complete'
        AND NOT dt.query_system AND dt.system_query IS NULL
        AND (dt.intent_hash IS NOT NULL
          OR ${hasSavedMemoryReferences(db, () => db`dt.context_source_refs`)}
          OR (du.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`du.context_source_refs`)}))
    )
    SELECT first_inv.pos_at AS first_invalid_at, first_inv.pos_id AS first_invalid_id,
      first_sc.pos_at AS first_scoped_at, first_sc.pos_id AS first_scoped_id,
      first_sc.valid_course_id AS first_scoped_course_id,
      second_sc.pos_at AS second_scoped_at, second_sc.pos_id AS second_scoped_id,
      first_hm.pos_at AS first_hashless_mismatch_at, first_hm.pos_id AS first_hashless_mismatch_id,
      first_mem.pos_at AS first_memory_at, first_mem.pos_id AS first_memory_id
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT pos_at, pos_id FROM conv_scan WHERE is_invalid ORDER BY pos_at ASC, pos_id ASC LIMIT 1
    ) first_inv ON true
    LEFT JOIN LATERAL (
      SELECT pos_at, pos_id, valid_course_id FROM conv_scan
      WHERE valid_course_id IS NOT NULL ORDER BY pos_at ASC, pos_id ASC LIMIT 1
    ) first_sc ON true
    LEFT JOIN LATERAL (
      SELECT pos_at, pos_id FROM conv_scan
      WHERE valid_course_id IS NOT NULL AND valid_course_id <> first_sc.valid_course_id
      ORDER BY pos_at ASC, pos_id ASC LIMIT 1
    ) second_sc ON first_sc.valid_course_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT (CASE WHEN hm_tu.status = 'complete' THEN hm_tu.created_at ELSE hm_t.created_at END) AS pos_at,
        (CASE WHEN hm_tu.status = 'complete' THEN hm_tu.id ELSE hm_t.id END) AS pos_id
      FROM opening_conversations hm_c
      JOIN opening_turns hm_t ON hm_t.workspace_id = hm_c.workspace_id AND hm_t.conversation_id = hm_c.id
      LEFT JOIN opening_tutor_jobs hmj ON hmj.assistant_turn_id = hm_t.id
        AND hmj.workspace_id = hm_t.workspace_id AND hmj.conversation_id = hm_t.conversation_id
      LEFT JOIN opening_turns hm_tu ON hm_tu.id = hmj.user_turn_id
        AND hm_tu.workspace_id = hm_t.workspace_id AND hm_tu.conversation_id = hm_t.conversation_id
        AND hm_tu.role = 'user'
      WHERE hm_c.id = ${conversationId} AND hm_c.workspace_id = ${workspaceId}
        AND hm_c.course_id IS NULL
        AND hm_t.role = 'assistant' AND hm_t.status = 'complete'
        AND hm_t.intent_hash IS NULL AND NOT hm_t.query_system AND hm_t.system_query IS NULL
        AND (CASE WHEN hm_tu.status = 'complete' THEN hm_tu.created_at ELSE hm_t.created_at END,
             CASE WHEN hm_tu.status = 'complete' THEN hm_tu.id ELSE hm_t.id END) > (first_sc.pos_at, first_sc.pos_id)
        AND COALESCE(
          hm_c.course_id,
          ${lineageUuid(db, () => db`hm_t.context_anchor->>'courseId'`)},
          ${turnLearningSessionCourse(db, () => db`hm_t`, () => db`hm_c.owner_user_id`)},
          CASE WHEN hm_tu.id IS NOT NULL THEN COALESCE(
            ${lineageUuid(db, () => db`hm_tu.context_anchor->>'courseId'`)},
            ${turnLearningSessionCourse(db, () => db`hm_tu`, () => db`hm_c.owner_user_id`)}
          ) END
        ) IS DISTINCT FROM first_sc.valid_course_id
      ORDER BY CASE WHEN hm_tu.status = 'complete' THEN hm_tu.created_at ELSE hm_t.created_at END ASC,
        CASE WHEN hm_tu.status = 'complete' THEN hm_tu.id ELSE hm_t.id END ASC
      LIMIT 1
    ) first_hm ON first_sc.valid_course_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT pos_at, pos_id FROM conv_scan WHERE has_mem ORDER BY pos_at ASC, pos_id ASC LIMIT 1
    ) first_mem ON true
    OFFSET 0
  ) conv_lineage`;
}

export function conversationTurnInactiveMisconception(
  db: Db, conversationCourse?: FragmentFactory, ownerUserId?: FragmentFactory,
) {
  const ownCourse = () => turnLineageCourse(db, "t", conversationCourse, ownerUserId);
  const ownPosAt = () => db`COALESCE(paired_u.created_at, t.created_at)`;
  const ownPosId = () => db`COALESCE(paired_u.id, t.id)`;
  return db`CASE
    WHEN t.role <> 'assistant' THEN false
    WHEN t.intent_hash IS NULL AND NOT t.query_system AND t.system_query IS NULL THEN
      (conv_lineage.first_invalid_id IS NOT NULL
        AND (conv_lineage.first_invalid_at, conv_lineage.first_invalid_id) < (${ownPosAt()}, ${ownPosId()}))
      OR (conv_lineage.second_scoped_id IS NOT NULL
        AND (conv_lineage.second_scoped_at, conv_lineage.second_scoped_id) < (${ownPosAt()}, ${ownPosId()}))
      OR (conv_lineage.first_hashless_mismatch_id IS NOT NULL
        AND (conv_lineage.first_hashless_mismatch_at, conv_lineage.first_hashless_mismatch_id) < (${ownPosAt()}, ${ownPosId()}))
      OR (conv_lineage.first_scoped_id IS NOT NULL
        AND (conv_lineage.first_scoped_at, conv_lineage.first_scoped_id) < (${ownPosAt()}, ${ownPosId()})
        AND ${ownCourse()} IS DISTINCT FROM conv_lineage.first_scoped_course_id)
    WHEN t.intent_hash IS NOT NULL THEN EXISTS (
      SELECT 1 FROM (SELECT t.*) dt
      CROSS JOIN LATERAL (SELECT ${ownCourse()} AS id OFFSET 0) own_course
      WHERE ${savedTurnUsesInactiveMisconception(db, "dt", [() => db`own_course.id`])}
    )
    ELSE false END`;
}

export function conversationTurnHasMisconceptionMemories(db: Db) {
  const ownHasMem = () => db`(${hasSavedMemoryReferences(db, () => db`t.context_source_refs`)}
    OR (paired_u.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`paired_u.context_source_refs`)}))`;
  return db`CASE
    WHEN t.role <> 'assistant' THEN false
    WHEN t.intent_hash IS NULL AND NOT t.query_system AND t.system_query IS NULL THEN
      ${ownHasMem()}
      OR (conv_lineage.first_memory_id IS NOT NULL
        AND (conv_lineage.first_memory_at, conv_lineage.first_memory_id) < (COALESCE(paired_u.created_at, t.created_at), COALESCE(paired_u.id, t.id)))
    ELSE ${ownHasMem()} END`;
}

export function savedTutorMisconceptionHashes(db: Db, alias: TurnAlias) {
  return db`ARRAY(
    SELECT origin.intent_hash FROM LATERAL (${savedMisconceptionOrigins(db, alias, "hashed")}) origin
    WHERE origin.role = 'assistant' AND NOT origin.query_system AND origin.system_query IS NULL AND origin.intent_hash IS NOT NULL
  )`;
}

type MaterialUse = "citation" | "practice";
export type SavedMemoryOrigin = {
  id: string; assistantTurnId?: string; courseId: string | null; consumerCourseId: string | null;
  pairedAssistantCourseId?: string | null; materialUse: MaterialUse;
  refs: unknown; standalone: boolean; createdAt?: string | Date | null;
  historical?: boolean; jobBacked?: boolean; isPairedUser?: boolean;
};
export type TurnMemoryOrigin = SavedMemoryOrigin & { ids: string[]; backings: string[][] };

function directMemoryOriginSide(
  db: Db, origin: FragmentFactory, pairedUser: FragmentFactory, course: FragmentFactory,
  owner: FragmentFactory, historical: FragmentFactory, conversationCourse?: FragmentFactory,
  knownOriginCourse?: FragmentFactory,
) {
  const originHasMem = () => hasSavedMemoryReferences(db, () => db`${origin()}.context_source_refs`);
  const pairedHasMem = () => db`(${pairedUser()}.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`${pairedUser()}.context_source_refs`)})`;
  const computedOriginCourse = knownOriginCourse
    ?? (() => db`(SELECT ${turnLineageCourse(db, "dt", conversationCourse, owner)} FROM (SELECT ${origin()}.*) dt OFFSET 0)`);
  return db`SELECT side_row.payload
    FROM (
      SELECT ${computedOriginCourse()} AS id,
        ${originHasMem()} AS origin_has_mem,
        ${pairedHasMem()} AS paired_has_mem
      WHERE ${originHasMem()} OR ${pairedHasMem()}
      OFFSET 0
    ) origin_course
    CROSS JOIN LATERAL (
      SELECT jsonb_build_object('id', ${origin()}.id, 'assistantTurnId', ${origin()}.id,
        'courseId', origin_course.id,
        'consumerCourseId', ${course()},
        'materialUse', (SELECT ${turnMaterialUse(db, "a")} FROM (SELECT ${origin()}.*) a OFFSET 0),
        'refs', ${origin()}.context_source_refs, 'standalone', CASE
          WHEN ${origin()}.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnHasStandaloneSessions(db, owner, origin)} ELSE false END,
        'createdAt', ${origin()}.created_at,
        'historical', ${historical()},
        'jobBacked', ${pairedUser()}.id IS NOT NULL,
        'isPairedUser', false) AS payload
      WHERE origin_course.origin_has_mem
      UNION ALL
      SELECT jsonb_build_object('id', ${pairedUser()}.id, 'assistantTurnId', ${origin()}.id,
        'courseId', (SELECT ${turnLineageCourse(db, "u", conversationCourse, owner)} FROM (SELECT ${pairedUser()}.*) u OFFSET 0),
        'consumerCourseId', ${course()},
        'pairedAssistantCourseId', origin_course.id,
        'materialUse', (SELECT ${turnMaterialUse(db, "u")} FROM (SELECT ${pairedUser()}.*) u OFFSET 0),
        'refs', ${pairedUser()}.context_source_refs, 'standalone', CASE
          WHEN ${pairedUser()}.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnHasStandaloneSession(db, pairedUser, owner)} ELSE false END,
        'createdAt', ${pairedUser()}.created_at,
        'historical', ${historical()},
        'jobBacked', true,
        'isPairedUser', true) AS payload
      WHERE origin_course.paired_has_mem
    ) side_row`;
}

function memoryOriginEvidence(
  db: Db, alias: "t" | "dt", course: FragmentFactory, owner: FragmentFactory, latestHm: FragmentFactory,
) {
  const root = () => savedTurn(db, alias);
  const effectiveConsumerCourse: FragmentFactory = () => db`CASE
    WHEN ${latestHm()}.pos_id IS NOT NULL AND origin.id <> (${root()}).id
      AND (COALESCE(tu.created_at, origin.created_at), COALESCE(tu.id, origin.id))
        < (${latestHm()}.pos_at, ${latestHm()}.pos_id)
    THEN NULL::uuid ELSE ${course()} END`;
  return db`SELECT side.payload
    FROM LATERAL (${savedMisconceptionOrigins(db, alias, "memory")}) origin
    LEFT JOIN opening_turns tu ON origin.role = 'assistant'
      AND tu.id = (${pairedUserTurnId(db, () => db`origin`)})
      AND tu.workspace_id = origin.workspace_id AND tu.conversation_id = origin.conversation_id
      AND tu.role = 'user' AND tu.status = 'complete'
    CROSS JOIN LATERAL (
      ${directMemoryOriginSide(db, () => db`origin`, () => db`tu`, effectiveConsumerCourse, owner, () => db`origin.id <> (${root()}).id`)}
    ) side`;
}

function originMemoryOnlyBackingIds(
  db: Db, refs: FragmentFactory, ownCourse: FragmentFactory, standaloneSessions: FragmentFactory,
  createdAt: FragmentFactory, scope: { workspaceId: string; ownerUserId: string | FragmentFactory },
  includeExpiredBackings: boolean,
) {
  const attributed: FragmentFactory = () => db`${refs()} @? '$[*].memoryDependencyIds[*]'`;
  const temporaryAllowed = includeExpiredBackings
    ? db`m.expires_at IS NOT NULL AND (${attributed()} OR ${createdAt()} IS NULL OR m.expires_at > ${createdAt()})`
    : db`m.expires_at > clock_timestamp() AND (${attributed()} OR ${createdAt()} IS NULL OR m.expires_at > ${createdAt()})`;
  return db`(
    SELECT COALESCE(jsonb_agg(to_jsonb(ARRAY(
      SELECT m.id FROM opening_memories m
      WHERE m.workspace_id = ${scope.workspaceId}
        AND m.status = 'active'
        AND (m.kind = 'confirmed' OR (m.kind = 'temporary' AND ${temporaryAllowed}))
        AND (${attributed()} OR ${createdAt()} IS NULL OR m.created_at <= ${createdAt()})
        AND (m.course_id IS NULL OR m.course_id = ${ownCourse()})
        AND (${attributed()} AND m.id::text IN (SELECT lower(d.id) FROM ${memoryDependencyRows(db, refs)} d)
          OR NOT (${attributed()}) AND ${ownCourse()} IS NULL AND (${standaloneSessions()}) AND m.course_id IS NULL)
        AND (${attributed()} OR ${memoryBacksSource(db, () => db`m.source_turn_ids`,
          () => lineageUuid(db, () => db`mem_ref->>'sourceId'`), scope.workspaceId, scope.ownerUserId)})
      ORDER BY m.id
    )) ORDER BY memory_refs.ordinality), '[]'::jsonb)
    FROM unnest(ARRAY(
      SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(${refs()}) = 'array' THEN ${refs()} ELSE '[]'::jsonb END)
    )) WITH ORDINALITY AS memory_refs(mem_ref, ordinality)
    WHERE (mem_ref->>'memoryOnly') = 'true'
  )`;
}

async function resolveMemoryOriginRefs(db: Db, scope: OpeningScope, rows: SavedMemoryOrigin[], includeExpiredBackings = false) {
  const legacy = [...new Map(rows.filter(row => memoryOnlyRefSourceIds(row.refs).length).map(row => [row.id, row])).values()];
  const backings = legacy.length ? await db<{ id: string; backings: string[][] }[]>`
    SELECT saved.id, ${originMemoryOnlyBackingIds(db, () => db`saved.refs`, () => db`saved.course_id`,
      () => db`saved.standalone`, () => db`saved.created_at`, scope, includeExpiredBackings)} AS backings
    FROM (
      SELECT (r.val->>'id')::uuid AS id, r.val->'refs' AS refs,
        (r.val->>'course_id')::uuid AS course_id, (r.val->>'standalone')::boolean AS standalone,
        (r.val->>'created_at')::timestamptz AS created_at
      FROM unnest(ARRAY(
        SELECT jsonb_array_elements(${db.json(legacy.map(row => ({ id: row.id, refs: row.refs,
          course_id: row.courseId, standalone: row.standalone,
          created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? null) })) as never)}::jsonb)
      )) AS r(val)
      LIMIT ${legacy.length}
    ) saved` : [];
  const byId = new Map(backings.map(row => [row.id, row.backings]));
  return rows.map((row): TurnMemoryOrigin | null => {
    const ids = parseContextMemoryDependencyIds(row.refs);
    const backingIds = byId.get(row.id) ?? [];
    return ids && backingIds.length === memoryOnlyRefSourceIds(row.refs).length ? { ...row, ids, backings: backingIds } : null;
  });
}

type ConversationPrefixMemoryOrigin = {
  posUs: string;
  posId: string;
  origin: SavedMemoryOrigin;
};

type RawConversationHashlessConsumer = {
  posUs: string;
  posId: string;
  assistantTurnId: string;
  courseId: string | null;
};

export type ConversationResolvedMemoryOrigin = {
  posUs: bigint;
  posId: string;
  origin: SavedMemoryOrigin;
  resolved: TurnMemoryOrigin | null;
};

export type ConversationHashlessConsumer = {
  posUs: bigint;
  posId: string;
  assistantTurnId: string;
  courseId: string | null;
};

export type TurnMemoryOriginTarget = {
  id: string;
  direct: (TurnMemoryOrigin | null)[];
  conversationId?: string;
  consumerCourseId: string | null;
  posUs?: bigint;
  posId?: string;
  inheritsPrefix: boolean;
};

export type TurnMisconceptionMemoryOriginBatches = {
  targets: Map<string, TurnMemoryOriginTarget>;
  byConversation: Map<string, ConversationResolvedMemoryOrigin[]>;
  consumersByConversation: Map<string, ConversationHashlessConsumer[]>;
};

export function upperBoundMemoryOriginPosition(
  items: readonly { posUs: bigint; posId: string }[], ownPosUs: bigint, ownPosId: string,
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = items[mid]!;
    if (item.posUs < ownPosUs || (item.posUs === ownPosUs && item.posId < ownPosId)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Read direct and conversation-grouped memory-bearing origins without quadratic prefix copying. */
export async function readTurnMisconceptionMemoryOriginBatches(
  db: Db, scope: OpeningScope, turnIds: readonly string[],
  options?: { excludeAssistantIds?: ReadonlySet<string>; includeExpiredBackings?: boolean },
): Promise<TurnMisconceptionMemoryOriginBatches> {
  if (!turnIds.length) return { targets: new Map(), byConversation: new Map(), consumersByConversation: new Map() };
  const includeExpiredBackings = Boolean(options?.includeExpiredBackings);
  const owner: FragmentFactory = () => db`${scope.ownerUserId}::uuid`;
  const rows = await db<{
    id: string;
    origins: SavedMemoryOrigin[];
    conversation_id?: string;
    consumer_course_id?: string | null;
    pos_us?: string;
    pos_id?: string;
    inherits_prefix?: boolean;
    conv_origins?: ConversationPrefixMemoryOrigin[] | null;
    conv_consumers?: RawConversationHashlessConsumer[] | null;
  }[]>`
    SELECT t.id, ARRAY(
      ${directMemoryOriginSide(db, () => db`t`, () => db`own_u`, () => db`t.own_course_id`, owner, () => db`false`, () => db`t.conv_course_id`, () => db`t.own_course_id`)}
    ) AS origins,
      t.conversation_id,
      t.own_course_id AS consumer_course_id,
      t.pos_us,
      t.pos_id,
      t.inherits_prefix,
      t.conv_origins,
      t.conv_consumers
    FROM (
      WITH target_turns AS MATERIALIZED (
        SELECT base.*,
          row_number() OVER (PARTITION BY base.conversation_id ORDER BY base.id) AS conv_rn
        FROM (
          SELECT saved.*,
            c.course_id AS conv_course_id,
            ${turnLineageCourse(db, "t", () => db`c.course_id`, owner)} AS own_course_id,
            own_j.user_turn_id AS own_user_turn_id,
            (extract(epoch FROM COALESCE(own_u.created_at, saved.created_at)) * 1000000)::bigint::text AS pos_us,
            COALESCE(own_u.id, saved.id)::text AS pos_id,
            (saved.role = 'assistant' AND saved.intent_hash IS NULL
              AND NOT saved.query_system AND saved.system_query IS NULL) AS inherits_prefix
          FROM opening_turns saved
          JOIN opening_conversations c ON c.id = saved.conversation_id AND c.workspace_id = saved.workspace_id
          CROSS JOIN LATERAL (SELECT saved.*) t
          LEFT JOIN opening_tutor_jobs own_j ON saved.role = 'assistant'
            AND own_j.assistant_turn_id = saved.id AND own_j.workspace_id = saved.workspace_id
            AND own_j.conversation_id = saved.conversation_id
          LEFT JOIN opening_turns own_u ON own_u.id = own_j.user_turn_id
            AND own_u.workspace_id = saved.workspace_id AND own_u.conversation_id = saved.conversation_id
            AND own_u.role = 'user' AND own_u.status = 'complete'
          WHERE saved.workspace_id = ${scope.workspaceId} AND c.owner_user_id = ${scope.ownerUserId}
            AND saved.id = ANY(${[...turnIds]}::uuid[])
        ) base
      ), conv_mem AS MATERIALIZED (
        SELECT conv.conversation_id,
          COALESCE(mem_scan.origins, '[]'::jsonb) AS origins,
          COALESCE(mem_scan.consumers, '[]'::jsonb) AS consumers
        FROM (SELECT DISTINCT conversation_id FROM target_turns WHERE inherits_prefix) conv
        JOIN opening_conversations c_conv ON c_conv.id = conv.conversation_id AND c_conv.workspace_id = ${scope.workspaceId}
        LEFT JOIN LATERAL (
          SELECT
            jsonb_agg(jsonb_build_object(
              'posUs', (extract(epoch FROM COALESCE(prior_u.created_at, prior_a.created_at)) * 1000000)::bigint::text,
              'posId', COALESCE(prior_u.id, prior_a.id)::text,
              'origin', side.payload
            ) ORDER BY COALESCE(prior_u.created_at, prior_a.created_at) ASC, COALESCE(prior_u.id, prior_a.id) ASC)
              FILTER (WHERE side.payload IS NOT NULL) AS origins,
            CASE WHEN c_conv.course_id IS NULL THEN jsonb_agg(jsonb_build_object(
              'posUs', (extract(epoch FROM COALESCE(prior_u.created_at, prior_a.created_at)) * 1000000)::bigint::text,
              'posId', COALESCE(prior_u.id, prior_a.id)::text,
              'assistantTurnId', prior_a.id::text,
              'courseId', c_course.id
            ) ORDER BY COALESCE(prior_u.created_at, prior_a.created_at) ASC, COALESCE(prior_u.id, prior_a.id) ASC)
              FILTER (WHERE prior_a.intent_hash IS NULL AND COALESCE(side.rn, 1) = 1) END AS consumers
          FROM opening_turns prior_a
          LEFT JOIN opening_tutor_jobs prior_j ON prior_j.assistant_turn_id = prior_a.id
            AND prior_j.workspace_id = prior_a.workspace_id AND prior_j.conversation_id = prior_a.conversation_id
          LEFT JOIN opening_turns prior_u ON prior_u.id = prior_j.user_turn_id
            AND prior_u.workspace_id = prior_a.workspace_id AND prior_u.conversation_id = prior_a.conversation_id
            AND prior_u.role = 'user' AND prior_u.status = 'complete'
          LEFT JOIN LATERAL (
            SELECT COALESCE(
              ${lineageUuid(db, () => db`prior_a.context_anchor->>'courseId'`)},
              ${turnLearningSessionCourse(db, () => db`prior_a`, owner)},
              CASE WHEN prior_u.id IS NOT NULL THEN COALESCE(
                ${lineageUuid(db, () => db`prior_u.context_anchor->>'courseId'`)},
                ${turnLearningSessionCourse(db, () => db`prior_u`, owner)}
              ) END
            ) AS id
          ) c_course ON c_conv.course_id IS NULL AND prior_a.intent_hash IS NULL
          LEFT JOIN LATERAL (
            SELECT s.payload, row_number() OVER () AS rn
            FROM (${directMemoryOriginSide(db, () => db`prior_a`, () => db`prior_u`, () => db`NULL::uuid`, owner, () => db`true`, () => db`c_conv.course_id`)}) s
          ) side ON (${hasSavedMemoryReferences(db, () => db`prior_a.context_source_refs`)}
            OR (prior_u.id IS NOT NULL AND ${hasSavedMemoryReferences(db, () => db`prior_u.context_source_refs`)}))
          WHERE prior_a.workspace_id = ${scope.workspaceId} AND prior_a.conversation_id = conv.conversation_id
            AND prior_a.role = 'assistant' AND prior_a.status = 'complete'
            AND NOT prior_a.query_system AND prior_a.system_query IS NULL
            AND ((c_conv.course_id IS NULL AND prior_a.intent_hash IS NULL) OR side.payload IS NOT NULL)
        ) mem_scan ON true
      )
      SELECT tt.*, cm.origins AS conv_origins, cm.consumers AS conv_consumers
      FROM target_turns tt
      LEFT JOIN conv_mem cm ON tt.conv_rn = 1 AND cm.conversation_id = tt.conversation_id
      OFFSET 0
    ) t
    LEFT JOIN opening_turns own_u ON t.own_user_turn_id IS NOT NULL
      AND own_u.id = t.own_user_turn_id AND own_u.workspace_id = t.workspace_id
      AND own_u.conversation_id = t.conversation_id AND own_u.role = 'user' AND own_u.status = 'complete'`;
  if (rows.every(row => row.conv_origins === undefined && row.inherits_prefix === undefined)) {
    const resolved = await resolveMemoryOriginRefs(db, scope, rows.flatMap(row => row.origins), includeExpiredBackings);
    let offset = 0;
    const targets = new Map<string, TurnMemoryOriginTarget>();
    for (const row of rows) {
      const end = offset + row.origins.length;
      targets.set(row.id, {
        id: row.id,
        direct: resolved.slice(offset, end),
        consumerCourseId: row.consumer_course_id ?? null,
        inheritsPrefix: false,
      });
      offset = end;
    }
    return { targets, byConversation: new Map(), consumersByConversation: new Map() };
  }
  const excludedAssistants = options?.excludeAssistantIds;
  const convEntries = rows
    .filter((row): row is typeof row & { conversation_id: string; conv_origins: ConversationPrefixMemoryOrigin[] } =>
      typeof row.conversation_id === "string" && Array.isArray(row.conv_origins))
    .map(entry => ({
      conversationId: entry.conversation_id,
      items: excludedAssistants
        ? entry.conv_origins.filter(item => !excludedAssistants.has(String(item.origin.assistantTurnId ?? item.origin.id)))
        : entry.conv_origins,
      consumers: (Array.isArray(entry.conv_consumers) ? entry.conv_consumers : [])
        .filter(item => !excludedAssistants || !excludedAssistants.has(String(item.assistantTurnId))),
    }));
  const allToResolve: SavedMemoryOrigin[] = [
    ...rows.flatMap(row => row.origins),
    ...convEntries.flatMap(entry => entry.items.map(item => item.origin)),
  ];
  const allResolved = await resolveMemoryOriginRefs(db, scope, allToResolve, includeExpiredBackings);
  let offset = 0;
  const targets = new Map<string, TurnMemoryOriginTarget>();
  for (const row of rows) {
    const end = offset + row.origins.length;
    targets.set(row.id, {
      id: row.id,
      direct: allResolved.slice(offset, end),
      conversationId: row.conversation_id,
      consumerCourseId: row.consumer_course_id ?? null,
      posUs: row.pos_us === undefined ? undefined : BigInt(row.pos_us),
      posId: row.pos_id?.toLowerCase(),
      inheritsPrefix: Boolean(row.inherits_prefix),
    });
    offset = end;
  }
  const byConversation = new Map<string, ConversationResolvedMemoryOrigin[]>();
  const consumersByConversation = new Map<string, ConversationHashlessConsumer[]>();
  for (const entry of convEntries) {
    const end = offset + entry.items.length;
    const slice = allResolved.slice(offset, end);
    offset = end;
    byConversation.set(entry.conversationId, entry.items.map((item, idx) => ({
      posUs: BigInt(item.posUs),
      posId: item.posId.toLowerCase(),
      origin: item.origin,
      resolved: slice[idx]!,
    })));
    if (entry.consumers.length) {
      consumersByConversation.set(entry.conversationId, entry.consumers.map(item => ({
        posUs: BigInt(item.posUs),
        posId: item.posId.toLowerCase(),
        assistantTurnId: item.assistantTurnId,
        courseId: item.courseId ?? null,
      })));
    }
  }
  return { targets, byConversation, consumersByConversation };
}

/** Read inherited memory-bearing turns once per conversation independently of restored tutor jobs. */
export async function readTurnMisconceptionMemoryOrigins(
  db: Db, scope: OpeningScope, turnIds: readonly string[],
): Promise<Map<string, (TurnMemoryOrigin | null)[]>> {
  const { targets, byConversation, consumersByConversation } = await readTurnMisconceptionMemoryOriginBatches(db, scope, turnIds);
  return new Map([...targets.values()].map(target => {
    const out = [...target.direct];
    if (target.inheritsPrefix && target.conversationId && target.posUs !== undefined && target.posId !== undefined) {
      const prefix = byConversation.get(target.conversationId) ?? [];
      const limit = upperBoundMemoryOriginPosition(prefix, target.posUs, target.posId);
      const consumers = consumersByConversation.get(target.conversationId) ?? [];
      const targetCourse = normalizeCourse(target.consumerCourseId);
      let splitIdx = 0;
      if (targetCourse !== null && consumers.length > 0) {
        const cLimit = upperBoundMemoryOriginPosition(consumers, target.posUs, target.posId);
        for (let k = cLimit - 1; k >= 0; k--) {
          const c = consumers[k]!;
          if (c.assistantTurnId === target.id) continue;
          if (normalizeCourse(c.courseId) !== targetCourse) {
            splitIdx = Math.min(limit, upperBoundMemoryOriginPosition(prefix, c.posUs, c.posId));
            break;
          }
        }
      }
      for (let i = 0; i < limit; i++) {
        const item = prefix[i]!;
        if (item.origin.assistantTurnId === target.id) continue;
        out.push(item.resolved === null ? null : {
          ...item.resolved,
          consumerCourseId: i < splitIdx ? null : target.consumerCourseId,
          historical: true,
        });
      }
    }
    return [target.id, out];
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
  statusActive?: boolean; notCandidate?: boolean; unexpired?: boolean; active?: boolean; rootActive?: boolean; origins?: SavedMemoryOrigin[];
};
type MemoryLineageNode = {
  memoryCourseId: string | null; courseId: string | null; statusActive: boolean; notCandidate: boolean; unexpired: boolean; active: boolean; rootActive: boolean;
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
  unexpired: boolean;
  earliestExpiresAtMs: number;
};

const normalizeCourse = (course: string | null | undefined) => course == null ? null : course.toLowerCase();
const courseAllows = (course: string | null, ...targets: (string | null)[]) => {
  const own = normalizeCourse(course);
  return own === null || targets.every(target => normalizeCourse(target) === own);
};

async function readMemoryLineageBatch(db: Db, scope: OpeningScope, ids: string[], asOf?: string) {
  const owner: FragmentFactory = () => db`request.owner_user_id`;
  return db<{ id: string | MemoryEvidence }[]>`
    SELECT id FROM opening_memories AS m(memory_id)
    JOIN (SELECT ${scope.workspaceId}::uuid AS workspace_id, ${ids}::uuid[] AS ids, ${scope.ownerUserId}::uuid AS owner_user_id) request
      ON m.workspace_id=request.workspace_id AND m.memory_id=ANY(request.ids)
    CROSS JOIN LATERAL (
      WITH origins AS MATERIALIZED (
        SELECT ${savedTutorMisconceptionHashes(db, "dt")} AS origin_hashes,
          ARRAY(${memoryOriginEvidence(db, "dt", () => db`own_course.id`, owner, () => db`latest_hm`)}) AS memory_origins
        FROM ${memoryOriginTurns(db)}
        CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "dt", undefined, owner)} AS id OFFSET 0) own_course
        LEFT JOIN LATERAL (${latestHashlessMismatchBefore(db, () => db`dt`, () => db`own_course.id`)}) latest_hm
          ON ${turnIsHashlessNonQueryAssistant(db, () => db`dt`)} AND own_course.id IS NOT NULL
        WHERE dt.id IS NOT NULL
          AND NOT (CASE WHEN (dt).role = 'assistant'
            THEN ${turnUsesInactiveMisconceptionWithMismatch(db, "dt", () => db`own_course.id`, () => db`latest_hm`, [() => db`m.course_id`])}
            ELSE false END)
          AND EXISTS (SELECT 1 FROM opening_conversations c WHERE c.id=dt.conversation_id
            AND c.workspace_id=dt.workspace_id AND c.owner_user_id=${owner()})
      )
      SELECT CASE WHEN m.course_id IS NULL AND cardinality(lineage.hashes)=0
          AND cardinality(lineage.memory_origins)=0 AND m.status='active' AND m.kind='confirmed'
        THEN to_jsonb(m.memory_id)
        ELSE jsonb_build_object('memoryId', m.memory_id, 'hashes', lineage.hashes, 'courseId', m.course_id,
          'expiresAt', CASE WHEN m.kind='temporary' THEN m.expires_at END,
          'statusActive', m.status='active',
          'notCandidate', m.kind <> 'candidate',
          'unexpired', (m.kind <> 'temporary' OR (m.expires_at IS NOT NULL AND m.expires_at > clock_timestamp())),
          'active', m.status='active' AND (m.kind='confirmed' OR (m.kind='temporary' AND m.expires_at IS NOT NULL AND m.expires_at > clock_timestamp())),
          ${asOf === undefined ? db`` : db`'rootActive', m.status='active' AND (m.kind='confirmed' OR (m.kind='temporary' AND m.expires_at IS NOT NULL AND m.expires_at > ${asOf}::timestamptz)),`}
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
  asOfRootIds?: ReadonlySet<string>;
  allowCandidateRoots?: boolean;
};

/** Resolve exact IDs, transitive authority, bindings, and earliest temporary expiry in batches. */
export async function readMemoryMisconceptionAuthorities(
  db: Db, scope: OpeningScope, memoryIds: readonly string[], targetCourseId: string | null,
  options: MemoryMisconceptionAuthorityOptions = false,
): Promise<Map<string, MemoryMisconceptionAuthority>> {
  const display = typeof options === "boolean" ? options : options.display === true;
  const asOf = typeof options === "boolean" ? undefined : options.asOf;
  const asOfRootIds = typeof options === "boolean" ? undefined : options.asOfRootIds;
  const allowCandidateRoots = typeof options === "boolean" ? false : options.allowCandidateRoots === true;
  const nodes = new Map<string, MemoryLineageNode>();
  const visited = new Set<string>();
  let frontier = [...new Set(memoryIds.map(id => id.toLowerCase()))];
  let depth = 0;
  while (frontier.length) {
    for (const id of frontier) visited.add(id);
    const rows = await readMemoryLineageBatch(db, scope, frontier, depth === 0 ? asOf : undefined);
    depth += 1;
    const origins = await resolveMemoryOriginRefs(
      db, scope, rows.flatMap(({ id }) => typeof id === "string" ? [] : id.origins ?? []), display,
    );
    let offset = 0;
    const next = new Set<string>();
    for (const { id } of rows) {
      if (typeof id === "string") {
        nodes.set(id.toLowerCase(), {
          memoryCourseId: null, courseId: null, statusActive: true, notCandidate: true, unexpired: true, active: true, rootActive: true,
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
      const unexpired = id.unexpired ?? active;
      const rootActive = id.rootActive ?? active;
      nodes.set(id.memoryId.toLowerCase(), {
        memoryCourseId, courseId: memoryCourseId ?? lineage?.courseId ?? null,
        statusActive: id.statusActive ?? active, notCandidate: id.notCandidate ?? true,
        unexpired, active, rootActive, expiresAtMs, lineage, origins: current,
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
  const usedNodes = new Map<string, ReadonlySet<string>>();
  const orderedNodes = [...nodes].sort(([a], [b]) => a.localeCompare(b));
  const nowMs = Date.now();
  const canonicalLineageKey = (lineage: TutorMisconceptionLineage | undefined) =>
    !lineage ? "" : `${lineage.courseId ?? ""}:${[...lineage.revisionIds].sort().join(",")}`;
  const canonicalBindingsKey = (bindings: readonly MemoryMisconceptionBinding[]) =>
    bindings.map(b => `${b.courseId ?? ""}|${b.materialUse}:${b.memoryIds.join(",")}`).join(";");
  const compareAuthority = (
    a: MemoryMisconceptionAuthority, aUsedSize: number,
    b: MemoryMisconceptionAuthority, bUsedSize: number,
  ): number => {
    const aUnexp = a.unexpired && a.earliestExpiresAtMs > nowMs ? 1 : 0;
    const bUnexp = b.unexpired && b.earliestExpiresAtMs > nowMs ? 1 : 0;
    if (aUnexp !== bUnexp) return aUnexp - bUnexp;
    const aNoLin = !a.lineage ? 1 : 0;
    const bNoLin = !b.lineage ? 1 : 0;
    if (aNoLin !== bNoLin) return aNoLin - bNoLin;
    const aDead = aUnexp ? a.earliestExpiresAtMs : -1;
    const bDead = bUnexp ? b.earliestExpiresAtMs : -1;
    if (aDead !== bDead) return aDead > bDead ? 1 : -1;
    if (a.lineage && b.lineage) {
      if (a.lineage.revisionIds.length !== b.lineage.revisionIds.length) {
        return b.lineage.revisionIds.length - a.lineage.revisionIds.length;
      }
      const aLin = canonicalLineageKey(a.lineage);
      const bLin = canonicalLineageKey(b.lineage);
      if (aLin !== bLin) return bLin.localeCompare(aLin);
    }
    if (a.dependencies.length !== b.dependencies.length) return b.dependencies.length - a.dependencies.length;
    const aDeps = a.dependencyIds.join(",");
    const bDeps = b.dependencyIds.join(",");
    if (aDeps !== bDeps) return bDeps.localeCompare(aDeps);
    if (aUsedSize !== bUsedSize) return bUsedSize - aUsedSize;
    const aBind = canonicalBindingsKey(a.bindings);
    const bBind = canonicalBindingsKey(b.bindings);
    return aBind === bBind ? 0 : bBind.localeCompare(aBind);
  };
  const evaluateNode = (
    id: string, node: MemoryLineageNode,
  ): { auth: MemoryMisconceptionAuthority; used: Set<string> } | null => {
    const lineages = [node.lineage];
    const depMap = new Map<string, string | null>();
    const bindingMap = new Map<string, { courseId: string | null; materialUse: MaterialUse; ids: Set<string> }>();
    const used = new Set<string>([id]);
    let unexpired = node.unexpired;
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
        if (dep === id || usedNodes.get(dep)?.has(id)) return false;
        const child = nodes.get(dep);
        const childAuth = resolved.get(dep);
        const childAllowed = display ? (legacy ? Boolean(child?.statusActive && child.notCandidate) : true) : Boolean(child?.active);
        if (!child || !childAuth || !childAllowed) return false;
        if (legacy && backingGraphs.has(origin.materialUse)) {
          const requiredSource = sourceIds && backingIndex !== undefined ? [sourceIds[backingIndex]!] : undefined;
          if (!resolveMemoryDependencyStatus(backingGraphs.get(origin.materialUse)!, [], [[dep]],
            normalizeCourse(origin.courseId), id, requiredSource)) return false;
        }
        const memoryTargets = origin.historical
          ? [origin.courseId]
          : [node.memoryCourseId, origin.courseId, origin.isPairedUser ? origin.courseId : origin.consumerCourseId];
        return courseAllows(child.memoryCourseId, ...memoryTargets)
          && courseAllows(
            childAuth.lineage?.courseId ?? null,
            node.courseId,
            origin.courseId,
            origin.consumerCourseId,
            ...(origin.isPairedUser && origin.pairedAssistantCourseId !== undefined ? [origin.pairedAssistantCourseId] : []),
          );
      };
      const selectBestBacking = (options: readonly string[], backingIndex: number): string | undefined => {
        let best: string | undefined;
        let bestNorm = "";
        let bestAuth: MemoryMisconceptionAuthority | undefined;
        let bestUsedSize = Infinity;
        for (const dep of options) {
          if (!admits(dep, true, backingIndex)) continue;
          const normDep = dep.toLowerCase();
          const auth = resolved.get(normDep)!;
          const depUsedSize = usedNodes.get(normDep)?.size ?? 1;
          const cmp = bestAuth === undefined ? 1 : compareAuthority(auth, depUsedSize, bestAuth, bestUsedSize);
          if (cmp > 0 || (cmp === 0 && normDep < bestNorm)) {
            best = dep;
            bestNorm = normDep;
            bestAuth = auth;
            bestUsedSize = depUsedSize;
          }
        }
        return best;
      };
      const backings = (display && origin.ids.length ? [] : origin.backings).map(selectBestBacking);
      if (!origin.ids.every(dep => admits(dep, false)) || backings.some(dep => dep === undefined)) return false;
      const chosen = [...origin.ids, ...(backings as string[])].map(dep => dep.toLowerCase());
      const joblessHistorical = Boolean(origin.historical && !origin.jobBacked);
      if (joblessHistorical) addBinding(origin.courseId, origin.materialUse, chosen);
      for (const dep of chosen) {
        const child = nodes.get(dep)!;
        const childAuth = resolved.get(dep)!;
        lineages.push(childAuth.lineage);
        for (const u of usedNodes.get(dep) ?? [dep]) used.add(u);
        if (joblessHistorical && dep !== id) depMap.set(dep, child.memoryCourseId);
        for (const sub of childAuth.dependencies) if (sub.id !== id) depMap.set(sub.id, sub.courseId);
        for (const binding of childAuth.bindings) addBinding(binding.courseId, binding.materialUse, binding.memoryIds);
        unexpired = unexpired && childAuth.unexpired;
        earliestExpiresAtMs = Math.min(earliestExpiresAtMs, childAuth.earliestExpiresAtMs);
      }
      return true;
    });
    if (!valid) return null;
    const mergedLineage = mergeTutorMisconceptionLineages(...lineages);
    const dependencies = [...depMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([depId, depCourseId]) => ({
      id: depId, courseId: depCourseId,
    }));
    const sortedBindings = [...bindingMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, b]) => ({ courseId: b.courseId, materialUse: b.materialUse, memoryIds: [...b.ids].sort() }));
    return {
      auth: {
        courseId: node.memoryCourseId ?? mergedLineage?.courseId ?? null,
        lineage: mergedLineage,
        dependencyIds: dependencies.map(dep => dep.id),
        dependencies,
        bindings: sortedBindings,
        unexpired,
        earliestExpiresAtMs,
      },
      used,
    };
  };

  // Decompose dependency graph into strongly connected components (dependency-first topological order)
  // so acyclic dependencies evaluate once and cycles converge via UUID-order-independent lattice relaxation.
  const adj = new Map<string, string[]>();
  for (const [id, node] of orderedNodes) {
    const deps = new Set<string>();
    for (const origin of node.origins) {
      if (!origin) continue;
      for (const rawDep of origin.ids) {
        const dep = rawDep.toLowerCase();
        if (dep !== id && nodes.has(dep)) deps.add(dep);
      }
      if (!(display && origin.ids.length)) {
        for (const options of origin.backings) {
          for (const rawDep of options) {
            const dep = rawDep.toLowerCase();
            if (dep !== id && nodes.has(dep)) deps.add(dep);
          }
        }
      }
    }
    adj.set(id, [...deps].sort());
  }
  const indexById = new Map<string, number>();
  const lowlinkById = new Map<string, number>();
  const onStack = new Set<string>();
  const tarjanStack: string[] = [];
  const callStack: Array<{ id: string; neighborIdx: number }> = [];
  const sccs: string[][] = [];
  let nextIndex = 0;
  for (const [startId] of orderedNodes) {
    if (indexById.has(startId)) continue;
    indexById.set(startId, nextIndex);
    lowlinkById.set(startId, nextIndex);
    nextIndex++;
    tarjanStack.push(startId);
    onStack.add(startId);
    callStack.push({ id: startId, neighborIdx: 0 });
    while (callStack.length) {
      const frame = callStack[callStack.length - 1]!;
      const neighbors = adj.get(frame.id) ?? [];
      if (frame.neighborIdx < neighbors.length) {
        const dep = neighbors[frame.neighborIdx++]!;
        if (!indexById.has(dep)) {
          indexById.set(dep, nextIndex);
          lowlinkById.set(dep, nextIndex);
          nextIndex++;
          tarjanStack.push(dep);
          onStack.add(dep);
          callStack.push({ id: dep, neighborIdx: 0 });
        } else if (onStack.has(dep)) {
          lowlinkById.set(frame.id, Math.min(lowlinkById.get(frame.id)!, indexById.get(dep)!));
        }
      } else {
        callStack.pop();
        if (callStack.length) {
          const parent = callStack[callStack.length - 1]!;
          lowlinkById.set(parent.id, Math.min(lowlinkById.get(parent.id)!, lowlinkById.get(frame.id)!));
        }
        if (lowlinkById.get(frame.id) === indexById.get(frame.id)) {
          const scc: string[] = [];
          while (true) {
            const member = tarjanStack.pop()!;
            onStack.delete(member);
            scc.push(member);
            if (member === frame.id) break;
          }
          sccs.push(scc);
        }
      }
    }
  }
  for (const scc of sccs) {
    if (scc.length === 1) {
      const id = scc[0]!;
      const candidate = evaluateNode(id, nodes.get(id)!);
      if (candidate) {
        resolved.set(id, candidate.auth);
        usedNodes.set(id, candidate.used);
      }
      continue;
    }
    scc.sort((a, b) => a.localeCompare(b));
    let improved = true;
    while (improved) {
      improved = false;
      for (const id of scc) {
        const candidate = evaluateNode(id, nodes.get(id)!);
        if (!candidate) continue;
        const prev = resolved.get(id);
        const prevUsed = usedNodes.get(id);
        if (!prev || !prevUsed || compareAuthority(candidate.auth, candidate.used.size, prev, prevUsed.size) > 0) {
          resolved.set(id, candidate.auth);
          usedNodes.set(id, candidate.used);
          improved = true;
        }
      }
    }
  }
  return new Map(memoryIds.flatMap(rawId => {
    const id = rawId.toLowerCase();
    const node = nodes.get(id);
    const auth = resolved.get(id);
    const usesAsOf = asOf !== undefined && (asOfRootIds === undefined || asOfRootIds.has(id));
    const rootActive = display || (usesAsOf ? node?.rootActive : node?.active) || (allowCandidateRoots && node?.statusActive);
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

function buildMinSegmentTree(values: readonly number[]) {
  const n = values.length;
  const tree = new Array<number>(2 * n);
  for (let i = 0; i < n; i++) tree[n + i] = values[i]!;
  for (let i = n - 1; i > 0; i--) tree[i] = Math.min(tree[i << 1]!, tree[(i << 1) | 1]!);
  return (left: number, right: number): number => {
    let res = Infinity;
    for (let l = left + n, r = right + n + 1; l < r; l >>>= 1, r >>>= 1) {
      if (l & 1) res = Math.min(res, tree[l++]!);
      if (r & 1) res = Math.min(res, tree[--r]!);
    }
    return res;
  };
}

function buildConversationPrefixEvaluator(
  items: readonly ConversationResolvedMemoryOrigin[],
  consumers: readonly ConversationHashlessConsumer[],
  evaluateHistorical: (resolved: TurnMemoryOrigin | null, consumerCourseId: string | null) => number,
) {
  const m = items.length;
  const otherVal = new Array<number>(m);
  const byCourse = new Map<string, { positions: number[]; sameVals: number[] }>();
  const byAssistant = new Map<string, number[]>();
  for (let j = 0; j < m; j++) {
    const item = items[j]!;
    if (item.origin.assistantTurnId) {
      const list = byAssistant.get(item.origin.assistantTurnId) ?? [];
      list.push(j);
      byAssistant.set(item.origin.assistantTurnId, list);
    }
    const originCourse = normalizeCourse(item.origin.courseId);
    const candidateCourse = originCourse ?? (
      item.origin.isPairedUser && item.origin.pairedAssistantCourseId !== undefined
        ? normalizeCourse(item.origin.pairedAssistantCourseId)
        : null
    );
    otherVal[j] = evaluateHistorical(item.resolved, null);
    if (candidateCourse !== null) {
      const sameVal = evaluateHistorical(item.resolved, candidateCourse);
      if (sameVal !== otherVal[j]) {
        const group = byCourse.get(candidateCourse) ?? { positions: [], sameVals: [] };
        group.positions.push(j);
        group.sameVals.push(sameVal);
        byCourse.set(candidateCourse, group);
      }
    }
  }
  const consumerCourses = consumers.map(c => normalizeCourse(c.courseId));
  const prevDiff = new Int32Array(consumers.length);
  for (let k = 0; k < consumers.length; k++) {
    prevDiff[k] = k === 0 ? -1 : (consumerCourses[k - 1] === consumerCourses[k] ? prevDiff[k - 1]! : k - 1);
  }
  const rangeMinOther = buildMinSegmentTree(otherVal);
  const courseTrees = new Map<string, { positions: number[]; rangeMinCourse: (l: number, r: number) => number }>();
  for (const [course, { positions, sameVals }] of byCourse) {
    const withGaps = positions.map((pos, r) => {
      const prevPos = r === 0 ? -1 : positions[r - 1]!;
      return Math.min(r === 0 ? Infinity : rangeMinOther(prevPos + 1, pos - 1), sameVals[r]!);
    });
    courseTrees.set(course, { positions, rangeMinCourse: buildMinSegmentTree(withGaps) });
  }
  const lowerBound = (arr: readonly number[], target: number) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const sameValueAtStart = (
    entry: { rangeMinCourse: (l: number, r: number) => number },
    sameVals: readonly number[],
    rStart: number,
    rEnd: number,
  ) => rStart === rEnd ? sameVals[rStart]! : Math.min(sameVals[rStart]!, entry.rangeMinCourse(rStart + 1, rEnd));
  const queryInterval = (left: number, right: number, consumerCourse: string | null): number => {
    if (left > right) return Infinity;
    const entry = consumerCourse === null ? undefined : courseTrees.get(consumerCourse);
    if (!entry) return rangeMinOther(left, right);
    const { positions } = entry;
    const rStart = lowerBound(positions, left);
    const rEnd = lowerBound(positions, right + 1) - 1;
    if (rStart > rEnd) return rangeMinOther(left, right);
    return Math.min(
      rangeMinOther(left, positions[rStart]! - 1),
      sameValueAtStart(entry, byCourse.get(consumerCourse!)!.sameVals, rStart, rEnd),
      rangeMinOther(positions[rEnd]! + 1, right),
    );
  };
  const querySubrange = (start: number, end: number, course: string | null, skipped: readonly number[]): number => {
    if (start > end) return Infinity;
    if (!skipped.length) return queryInterval(start, end, course);
    let res = Infinity;
    let cursor = start;
    for (const idx of skipped) {
      if (idx < cursor) continue;
      if (idx > end) break;
      res = Math.min(res, queryInterval(cursor, idx - 1, course));
      cursor = idx + 1;
    }
    return Math.min(res, queryInterval(cursor, end, course));
  };

  return (
    limit: number, turnId: string, consumerCourseId: string | null,
    targetPosUs?: bigint, targetPosId?: string,
  ): number => {
    if (limit <= 0) return Infinity;
    const consumerCourse = normalizeCourse(consumerCourseId);
    const skipped = (byAssistant.get(turnId) ?? []).filter(idx => idx < limit);
    let splitIdx = 0;
    if (consumerCourse !== null && consumers.length > 0 && targetPosUs !== undefined && targetPosId !== undefined) {
      let cIdx = upperBoundMemoryOriginPosition(consumers, targetPosUs, targetPosId) - 1;
      while (cIdx >= 0 && consumers[cIdx]!.assistantTurnId === turnId) cIdx--;
      if (cIdx >= 0 && consumerCourses[cIdx] === consumerCourse) {
        cIdx = prevDiff[cIdx]!;
        while (cIdx >= 0 && consumers[cIdx]!.assistantTurnId === turnId) {
          cIdx = cIdx > 0 && consumerCourses[cIdx - 1] === consumerCourse ? prevDiff[cIdx - 1]! : cIdx - 1;
        }
      }
      if (cIdx >= 0) {
        const mismatch = consumers[cIdx]!;
        splitIdx = Math.min(limit, upperBoundMemoryOriginPosition(items, mismatch.posUs, mismatch.posId));
      }
    }
    return Math.min(
      querySubrange(0, splitIdx - 1, null, skipped),
      querySubrange(splitIdx, limit - 1, consumerCourse, skipped),
    );
  };
}

export type TurnMisconceptionMemoryStatusOptions = {
  display?: boolean;
  targetCourseId?: string | null;
  firstDeliveryTurnIds?: ReadonlySet<string>;
};

/** Validate memory authority in the original turn, the consuming turn, and the requested destination. */
export async function readTurnMisconceptionMemoryStatus(
  db: Db, scope: OpeningScope, turnIds: readonly string[], options: TurnMisconceptionMemoryStatusOptions = {},
): Promise<{ invalid: Set<string>; earliestExpiresAtMs: number; deadlines: Map<string, number> }> {
  const { targets, byConversation, consumersByConversation } = await readTurnMisconceptionMemoryOriginBatches(
    db, scope, turnIds, { includeExpiredBackings: Boolean(options.display) },
  );
  const byCourse = new Map<string | null, Set<string>>();
  const memoryCoursesFor = (origin: TurnMemoryOrigin) => {
    const courses: (string | null)[] = [normalizeCourse(origin.courseId)];
    if (!origin.historical && !origin.isPairedUser) courses.push(normalizeCourse(origin.consumerCourseId));
    if (!origin.historical && options.targetCourseId !== undefined) courses.push(normalizeCourse(options.targetCourseId));
    return [...new Set(courses)];
  };
  const recordOriginCourses = (origin: TurnMemoryOrigin | null) => {
    if (!origin) return;
    for (const course of memoryCoursesFor(origin)) {
      const ids = byCourse.get(course) ?? new Set<string>();
      for (const id of [...origin.ids, ...origin.backings.flat()]) ids.add(id.toLowerCase());
      byCourse.set(course, ids);
    }
  };
  for (const target of targets.values()) for (const origin of target.direct) recordOriginCourses(origin);
  for (const items of byConversation.values()) for (const item of items) {
    if (item.resolved) recordOriginCourses({ ...item.resolved, historical: true });
  }
  const authorities = new Map<string | null, Map<string, MemoryMisconceptionAuthority>>();
  for (const [course, ids] of byCourse) {
    authorities.set(course, await readMemoryMisconceptionAuthorities(db, scope, [...ids], course, options.display));
  }
  const graphs = new Map<MaterialUse, Map<string, MemoryDependencyStatus[]>>();
  if (!options.display) for (const use of ["citation", "practice"] as const) {
    const useIds = new Set<string>();
    const collectForUse = (origin: TurnMemoryOrigin | null) => {
      if (!origin || origin.materialUse !== use) return;
      const originMap = authorities.get(normalizeCourse(origin.courseId));
      for (const rawId of [...origin.ids, ...origin.backings.flat()]) {
        const id = rawId.toLowerCase();
        if (originMap?.has(id)) useIds.add(id);
      }
    };
    for (const target of targets.values()) for (const origin of target.direct) collectForUse(origin);
    for (const items of byConversation.values()) for (const item of items) collectForUse(item.resolved);
    graphs.set(use, await readMemoryDependencyStatus(db, scope, [...useIds], { materialUse: use }));
  }
  const nowMs = Date.now();
  const authDeadline = (auth: MemoryMisconceptionAuthority) => auth.unexpired ? auth.earliestExpiresAtMs : 0;
  const evaluateSingleOrigin = (origin: TurnMemoryOrigin | null, consumerCourseId: string | null): number => {
    if (!origin) return -Infinity;
    const memoryCourses = memoryCoursesFor(origin);
    const misconceptionCourses = [
      origin.courseId, consumerCourseId,
      options.targetCourseId === undefined ? consumerCourseId : options.targetCourseId,
      ...(origin.isPairedUser && origin.pairedAssistantCourseId !== undefined ? [origin.pairedAssistantCourseId] : []),
    ];
    const active = (rawId: string) => {
      const id = rawId.toLowerCase();
      if (!memoryCourses.every(course => authorities.get(course)?.has(id))) return false;
      const auth = authorities.get(normalizeCourse(origin.courseId))?.get(id);
      return Boolean(auth && courseAllows(auth.lineage?.courseId ?? null, ...misconceptionCourses)
        && (options.display || (auth.unexpired && auth.earliestExpiresAtMs > nowMs)));
    };
    const backings = (options.display && origin.ids.length ? [] : origin.backings).map(ids => ids.filter(active));
    if (!origin.ids.every(active) || backings.some(ids => !ids.length)) return -Infinity;
    let earliest = Infinity;
    for (const rawId of origin.ids) {
      const auth = authorities.get(normalizeCourse(origin.courseId))?.get(rawId.toLowerCase());
      if (auth) earliest = Math.min(earliest, authDeadline(auth));
    }
    for (const group of backings) {
      const groupExpiry = Math.max(-Infinity, ...group.map(rawId => {
        const auth = authorities.get(normalizeCourse(origin.courseId))?.get(rawId.toLowerCase());
        return auth ? authDeadline(auth) : -Infinity;
      }));
      earliest = Math.min(earliest, groupExpiry);
    }
    if (options.display) return earliest;
    for (const course of memoryCourses) {
      const nodes = resolveMemoryDependencyStatus(graphs.get(origin.materialUse)!, origin.ids, backings, course,
        undefined, origin.ids.length ? memoryOnlyRefSourceIds(origin.refs) : undefined);
      if (!nodes) return -Infinity;
      for (const node of nodes) {
        if (node.expires_at !== null) {
          const exp = new Date(node.expires_at).getTime();
          if (!(exp > nowMs)) return -Infinity;
          earliest = Math.min(earliest, exp);
        }
      }
    }
    return earliest;
  };
  const convEvaluators = new Map<string, ReturnType<typeof buildConversationPrefixEvaluator>>();
  for (const [conversationId, items] of byConversation) {
    convEvaluators.set(conversationId, buildConversationPrefixEvaluator(
      items,
      consumersByConversation.get(conversationId) ?? [],
      (resolved, consumerCourseId) =>
        evaluateSingleOrigin(resolved === null ? null : { ...resolved, consumerCourseId, historical: true }, consumerCourseId),
    ));
  }
  const invalid = new Set<string>();
  const deadlines = new Map<string, number>();
  let earliestExpiresAtMs = Infinity;
  for (const turnId of turnIds) {
    const target = targets.get(turnId);
    if (!target) {
      invalid.add(turnId);
      continue;
    }
    let turnEarliest = Infinity;
    for (const origin of target.direct) {
      turnEarliest = Math.min(turnEarliest, evaluateSingleOrigin(origin, origin?.consumerCourseId ?? target.consumerCourseId));
      if (turnEarliest === -Infinity) break;
    }
    if (turnEarliest !== -Infinity && target.inheritsPrefix && target.conversationId
      && target.posUs !== undefined && target.posId !== undefined) {
      const prefix = byConversation.get(target.conversationId) ?? [];
      const limit = upperBoundMemoryOriginPosition(prefix, target.posUs, target.posId);
      const evalPrefix = convEvaluators.get(target.conversationId);
      if (evalPrefix) {
        turnEarliest = Math.min(turnEarliest, evalPrefix(limit, turnId, target.consumerCourseId, target.posUs, target.posId));
      }
    }
    const enforceExpiry = !options.display || Boolean(options.firstDeliveryTurnIds?.has(turnId));
    if (turnEarliest === -Infinity || (enforceExpiry && !(turnEarliest > nowMs))) invalid.add(turnId);
    else {
      earliestExpiresAtMs = Math.min(earliestExpiresAtMs, turnEarliest);
      if (Number.isFinite(turnEarliest) && turnEarliest > 0) deadlines.set(turnId, turnEarliest);
    }
  }
  return { invalid, earliestExpiresAtMs, deadlines };
}

export async function readTurnsWithInvalidMisconceptionMemories(
  db: Db, scope: OpeningScope, turnIds: readonly string[], options: TurnMisconceptionMemoryStatusOptions = {},
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
