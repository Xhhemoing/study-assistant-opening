import type { Sql, TransactionSql } from "postgres";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { createOpeningPrivacyRepository } from "./opening-privacy";

import {
  contextSourceRefsIncluded, isLineageUuid, lineageUuid, memoryOnlyRefSourceIds, mergeContextSourceRefs, resolveMemoryDependencyStatus,
  parseContextMemoryDependencyIds, parseContextSourceRefs, turnContextSourceRefs, turnDirectSourcesVersioned,
  turnHasOwnedSession, turnHasStandaloneSession, turnLineageCourse, turnMemoryOnlyBackingIds, turnSessionMaterialIds,
  type ContextSourceRef, type FragmentFactory, type MemoryDependencyStatus,
} from "./opening-context-provenance";
import { readMemoryDependencyStatus, sourceMaterialsActive } from "./opening-memory-admission";
import {
  hasSavedMemoryReferences, mergeTutorMisconceptionLineages, readActiveTutorMisconceptionLineages,
  readMemoryMisconceptionAuthorities, readSavedTutorMisconceptionLineage, readTurnMisconceptionMemoryOriginBatches,
  savedTurnUsesInactiveMisconception, upperBoundMemoryOriginPosition,
  type MemoryMisconceptionAuthority, type TurnMisconceptionMemoryOriginBatches, type TutorMisconceptionLineage,
} from "./v3-bitemporal-misconception-memory";

type HistoryTurn = { role: "user" | "assistant"; text: string };
type Db = Sql | TransactionSql;
type MaterialUse = "citation" | "practice";
export type HistoryCourseBinding = {
  courseId: string | null; materialUse: MaterialUse; sourceIds: string[]; sourceRefs: ContextSourceRef[];
  selectedDestinationSourceIds?: string[];
  memoryIds?: string[];
  memoryBackings?: string[][];
};
export type TutorHistoryPurpose = "model" | "record_referents";
export type TutorHistoryContext = {
  history: HistoryTurn[];
  sourceRefs: ContextSourceRef[];
  memoryIds?: string[];
  historyCourseBindings?: HistoryCourseBinding[];
  historyMisconceptionLineage?: TutorMisconceptionLineage;
  revokedDirectSourceIds?: string[];
  temporaryMemoryExpiresAt?: string;
};

function directSourceIds(sql: Db, ids: FragmentFactory, refs: FragmentFactory, citations: FragmentFactory) {
  const array = (value: FragmentFactory) => sql`CASE WHEN jsonb_typeof(${value()}) = 'array' THEN ${value()} ELSE '[]'::jsonb END`;
  return sql`ARRAY(
    SELECT DISTINCT ${lineageUuid(sql, () => sql`ref->>'sourceId'`)}
    FROM (
      SELECT ref FROM jsonb_array_elements(${array(refs)}) ref WHERE ref->'memoryOnly' IS DISTINCT FROM 'true'::jsonb
      UNION ALL
      SELECT citation FROM jsonb_array_elements(${array(citations)}) citation
    ) material(ref)
    WHERE ref ? 'sourceId'
  ) || ${ids()}`;
}

export function historyMaterialsActive(sql: Db, workspaceId: string, ids: FragmentFactory, course: FragmentFactory, use: FragmentFactory) {
  return sourceMaterialsActive(sql, workspaceId, () => sql`SELECT sid.id::text AS source_id,
    NULL::text AS version, false AS version_required, false AS memory_only FROM unnest(${ids()}) sid(id)`,
  { memoryCourse: course, originUse: use, directMaterialPolicy: true });
}

function readSavedExchanges(sql: Db, scope: OpeningScope, currentTurnIds: readonly string[],
  purpose: TutorHistoryPurpose | "ancestors", excludedSourceIds: string[] = [],
  requireDestinationSessionMaterials = false, includeCurrentLineage = false,
) {
  const recordReferents = purpose === "record_referents";
  const ancestors = purpose === "ancestors";
  const priorCourse: FragmentFactory = () => turnLineageCourse(sql, "u", () => sql`c.course_id`, () => sql`c.owner_user_id`);
  const currentCourse: FragmentFactory = () => turnLineageCourse(sql, "current", () => sql`c.course_id`, () => sql`c.owner_user_id`);
  const citations: FragmentFactory = () => sql`CASE WHEN jsonb_typeof(u.citations) = 'array' AND jsonb_typeof(a.citations) = 'array'
    THEN u.citations || a.citations END`;
  const priorUse: FragmentFactory = () => sql`CASE WHEN u.attempt_id IS NOT NULL OR u.context_anchor->>'itemVersionId' IS NOT NULL
    THEN 'practice' ELSE 'citation' END`;
  const currentUse: FragmentFactory = () => sql`CASE WHEN current.attempt_id IS NOT NULL OR current.context_anchor->>'itemVersionId' IS NOT NULL
    THEN 'practice' ELSE 'citation' END`;
  const assistantCourse: FragmentFactory = () => turnLineageCourse(sql, "a", () => sql`c.course_id`, () => sql`c.owner_user_id`);
  const assistantUse: FragmentFactory = () => sql`CASE WHEN a.attempt_id IS NOT NULL OR a.context_anchor->>'itemVersionId' IS NOT NULL
    THEN 'practice' ELSE ${priorUse()} END`;
  const standaloneSessions: FragmentFactory = () => sql`${turnHasStandaloneSession(sql, () => sql`a`, () => sql`c.owner_user_id`)}
    AND ${turnHasStandaloneSession(sql, () => sql`u`, () => sql`c.owner_user_id`)}
    AND ${lineageUuid(sql, () => sql`a.context_anchor->>'courseId'`)} IS NULL`;
  const allowed = (ids: FragmentFactory, course: FragmentFactory, use: FragmentFactory) =>
    historyMaterialsActive(sql, scope.workspaceId, ids, course, use);
  const sessionIds = (alias: "u" | "a") =>
    turnSessionMaterialIds(sql, () => alias === "u" ? sql`u` : sql`a`, () => sql`c.owner_user_id`);
  return sql`
    WITH prior AS MATERIALIZED (
      SELECT c.id AS conversation_id, current.id AS current_id, u.id, a.id AS assistant_id, u.created_at,
        (extract(epoch FROM u.created_at) * 1000000)::bigint::text AS pos_us,
        a.query_system, a.system_query, w.privacy_epoch AS current_privacy_epoch, a.intent_hash AS assistant_intent_hash,
        ${recordReferents ? sql`false` : sql`(${hasSavedMemoryReferences(sql, () => sql`a.context_source_refs`)}
          OR ${hasSavedMemoryReferences(sql, () => sql`u.context_source_refs`)})`} AS own_has_memory,
        refs.user_refs AS user_source_refs, refs.assistant_refs AS assistant_source_refs, a.citations AS assistant_citations,
        ${priorCourse()} AS prior_course_id, ${currentCourse()} AS current_course_id,
        ${currentUse()} AS material_use, ${priorUse()} AS prior_material_use,
        ${assistantCourse()} AS assistant_course_id, ${assistantUse()} AS assistant_material_use,
        ${recordReferents ? sql`true` : sql`cardinality(a.source_ids) = 0 OR (
          jsonb_typeof(refs.assistant_refs) = 'array' AND jsonb_typeof(a.citations) = 'array'
          AND ${turnDirectSourcesVersioned(sql, () => sql`a.source_ids`, () => sql`refs.assistant_refs`, () => sql`a.citations`)}
        )`} AS assistant_direct_versioned,
        ${recordReferents ? sql`` : sql`${directSourceIds(sql, () => sql`u.source_ids`, () => sql`refs.user_refs`, () => sql`u.citations`)}
          || ${sessionIds("u")} AS user_direct_ids,
          ${directSourceIds(sql, () => sql`a.source_ids`, () => sql`refs.assistant_refs`, () => sql`a.citations`)}
          || ${sessionIds("a")} AS assistant_direct_ids,`}
        ${requireDestinationSessionMaterials ? sql`${sessionIds("u")} || ${sessionIds("a")} AS session_material_ids,` : sql``}
        CASE WHEN a.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnMemoryOnlyBackingIds(sql, () => sql`a.context_source_refs`, assistantCourse, standaloneSessions, scope)}
          ELSE '[]'::jsonb END AS memory_backing_ids,
        CASE WHEN u.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnMemoryOnlyBackingIds(sql, () => sql`u.context_source_refs`, priorCourse,
            () => turnHasStandaloneSession(sql, () => sql`u`, () => sql`c.owner_user_id`), scope)}
          ELSE '[]'::jsonb END AS user_memory_backing_ids,
        NOT (${recordReferents ? sql`true` : sql`${turnHasOwnedSession(sql, () => sql`u`, () => sql`c.owner_user_id`)}
          AND ${turnHasOwnedSession(sql, () => sql`a`, () => sql`c.owner_user_id`)}`}
          AND ${contextSourceRefsIncluded(sql, scope.workspaceId, () => sql`refs.user_refs || refs.assistant_refs`,
          false, true, () => sql`u.source_ids || a.source_ids`, citations)}) AS invalid
      FROM opening_turns current
      JOIN opening_conversations c ON c.id=current.conversation_id
      JOIN workspaces w ON w.id=c.workspace_id
      JOIN opening_tutor_jobs j ON j.conversation_id=c.id AND j.workspace_id=c.workspace_id
      JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=c.workspace_id AND u.conversation_id=c.id AND u.role='user'
      JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=c.workspace_id AND a.conversation_id=c.id AND a.role='assistant'
      CROSS JOIN LATERAL (SELECT CASE WHEN u.context_source_refs IS NULL OR jsonb_typeof(u.context_source_refs)='array'
        THEN ${turnContextSourceRefs(sql, "u", true)} || COALESCE(u.context_source_refs, '[]'::jsonb) END AS user_refs,
        ${turnContextSourceRefs(sql, "a", true)} AS assistant_refs) refs
      WHERE current.id=ANY(${currentTurnIds}::uuid[]) AND current.role='user'
        AND current.workspace_id=${scope.workspaceId} AND c.workspace_id=${scope.workspaceId}
        AND c.owner_user_id=${scope.ownerUserId}
        AND ((u.created_at, u.id) < (current.created_at, current.id)
          ${includeCurrentLineage ? sql`OR (u.id=current.id AND a.intent_hash IS NOT NULL)` : sql``})
        AND u.status='complete' AND a.status='complete'
        -- Query snapshots are separate authority records, including legacy imported receipts.
        -- Never promote their text into a later ordinary model conversation.
        AND (${recordReferents} OR (NOT u.query_system AND NOT a.query_system AND a.system_query IS NULL)
          ${includeCurrentLineage ? sql`OR u.id=current.id` : sql``})
        ${ancestors ? sql`` : sql`AND NOT (current.source_ids && ${excludedSourceIds}::uuid[])`}
    ), conv_hist AS MATERIALIZED (
      ${recordReferents ? sql`SELECT NULL::uuid AS conversation_id, '{}'::uuid[] AS invalid_assistant_ids,
        NULL::timestamptz AS first_invalid_at, NULL::uuid AS first_invalid_id,
        NULL::timestamptz AS first_scoped_at, NULL::uuid AS first_scoped_id, NULL::uuid AS first_scoped_course_id,
        NULL::timestamptz AS second_scoped_at, NULL::uuid AS second_scoped_id,
        NULL::timestamptz AS first_memory_at, NULL::uuid AS first_memory_id,
        '[]'::jsonb AS conv_hashes WHERE false` : sql`
      SELECT conv.conversation_id,
        summary.invalid_assistant_ids,
        summary.first_invalid_at, summary.first_invalid_id,
        summary.first_scoped_at, summary.first_scoped_id, summary.first_scoped_course_id,
        summary.second_scoped_at, summary.second_scoped_id,
        summary.first_memory_at, summary.first_memory_id,
        summary.conv_hashes
      FROM (SELECT DISTINCT conversation_id FROM prior) conv
      CROSS JOIN LATERAL (
        WITH conv_scan AS MATERIALIZED (
          SELECT dt.id AS assistant_id,
            (dt.query_system IS FALSE AND dt.system_query IS NULL) AS non_query,
            COALESCE(du.created_at, dt.created_at) AS pos_at,
            COALESCE(du.id, dt.id) AS pos_id,
            dt.intent_hash,
            COALESCE(dt_hash.is_invalid, false) AS is_invalid,
            dt_hash.valid_course_id,
            (${hasSavedMemoryReferences(sql, () => sql`dt.context_source_refs`)}
              OR (du.id IS NOT NULL AND ${hasSavedMemoryReferences(sql, () => sql`du.context_source_refs`)})) AS has_mem
          FROM opening_turns dt
          LEFT JOIN opening_tutor_jobs dj ON dj.assistant_turn_id = dt.id
            AND dj.workspace_id = dt.workspace_id AND dj.conversation_id = dt.conversation_id
          LEFT JOIN opening_turns du ON du.id = dj.user_turn_id
            AND du.workspace_id = dt.workspace_id AND du.conversation_id = dt.conversation_id
            AND du.role = 'user' AND du.status = 'complete'
          LEFT JOIN LATERAL (
            SELECT status.is_invalid,
              CASE WHEN NOT status.is_invalid AND input.valid AND jsonb_typeof(payload.value) = 'object'
                THEN ${lineageUuid(sql, () => sql`payload.value->>'courseId'`)} END AS valid_course_id
            FROM (SELECT pg_input_is_valid(dt.intent_hash, 'json')
              AND pg_input_is_valid(dt.intent_hash, 'jsonb') AS valid OFFSET 0) input
            CROSS JOIN LATERAL (SELECT CASE WHEN input.valid THEN dt.intent_hash::jsonb END AS value OFFSET 0) payload
            CROSS JOIN LATERAL (SELECT ${savedTurnUsesInactiveMisconception(sql, "dt", [])} AS is_invalid OFFSET 0) status
            OFFSET 0
          ) dt_hash ON dt.intent_hash IS NOT NULL
          WHERE dt.workspace_id = ${scope.workspaceId} AND dt.conversation_id = conv.conversation_id
            AND dt.role = 'assistant' AND dt.status = 'complete'
            AND (dt.intent_hash IS NOT NULL
              OR (dt.query_system IS FALSE AND dt.system_query IS NULL
                AND (${hasSavedMemoryReferences(sql, () => sql`dt.context_source_refs`)}
                  OR (du.id IS NOT NULL AND ${hasSavedMemoryReferences(sql, () => sql`du.context_source_refs`)}))))
        )
        SELECT COALESCE((SELECT array_agg(assistant_id) FROM conv_scan WHERE intent_hash IS NOT NULL AND is_invalid), '{}'::uuid[]) AS invalid_assistant_ids,
          first_inv.pos_at AS first_invalid_at, first_inv.pos_id AS first_invalid_id,
          first_sc.pos_at AS first_scoped_at, first_sc.pos_id AS first_scoped_id,
          first_sc.valid_course_id AS first_scoped_course_id,
          second_sc.pos_at AS second_scoped_at, second_sc.pos_id AS second_scoped_id,
          first_mem.pos_at AS first_memory_at, first_mem.pos_id AS first_memory_id,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'posUs', (extract(epoch FROM pos_at) * 1000000)::bigint::text,
              'posId', pos_id::text,
              'assistantId', assistant_id::text,
              'hash', intent_hash
            ) ORDER BY pos_at ASC, pos_id ASC)
            FROM conv_scan WHERE non_query AND intent_hash IS NOT NULL AND NOT is_invalid
          ), '[]'::jsonb) AS conv_hashes
        FROM (SELECT 1) one
        LEFT JOIN LATERAL (
          SELECT pos_at, pos_id FROM conv_scan WHERE non_query AND is_invalid ORDER BY pos_at ASC, pos_id ASC LIMIT 1
        ) first_inv ON true
        LEFT JOIN LATERAL (
          SELECT pos_at, pos_id, valid_course_id FROM conv_scan
          WHERE non_query AND valid_course_id IS NOT NULL ORDER BY pos_at ASC, pos_id ASC LIMIT 1
        ) first_sc ON true
        LEFT JOIN LATERAL (
          SELECT pos_at, pos_id FROM conv_scan
          WHERE non_query AND valid_course_id IS NOT NULL AND valid_course_id <> first_sc.valid_course_id
          ORDER BY pos_at ASC, pos_id ASC LIMIT 1
        ) second_sc ON first_sc.valid_course_id IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT pos_at, pos_id FROM conv_scan WHERE non_query AND has_mem ORDER BY pos_at ASC, pos_id ASC LIMIT 1
        ) first_mem ON true
        OFFSET 0
      ) summary`}
    ), evaluated AS MATERIALIZED (
      SELECT prior.*,
        ${recordReferents ? sql`false` : sql`CASE
          WHEN prior.assistant_intent_hash IS NOT NULL THEN prior.assistant_id = ANY(COALESCE(ch.invalid_assistant_ids, '{}'::uuid[]))
          WHEN prior.query_system IS FALSE AND prior.system_query IS NULL THEN
            (ch.first_invalid_id IS NOT NULL AND (ch.first_invalid_at, ch.first_invalid_id) < (prior.created_at, prior.id))
            OR (ch.second_scoped_id IS NOT NULL AND (ch.second_scoped_at, ch.second_scoped_id) < (prior.created_at, prior.id))
            OR (ch.first_scoped_id IS NOT NULL AND (ch.first_scoped_at, ch.first_scoped_id) < (prior.created_at, prior.id)
              AND prior.assistant_course_id IS DISTINCT FROM ch.first_scoped_course_id)
          ELSE false END`} AS assistant_misconception_invalid,
        ${recordReferents ? sql`false` : sql`(prior.assistant_intent_hash IS NULL AND (
          prior.own_has_memory
          OR (prior.query_system IS FALSE AND prior.system_query IS NULL
            AND ch.first_memory_id IS NOT NULL
            AND (ch.first_memory_at, ch.first_memory_id) < (prior.created_at, prior.id))
        ))`} AS inherits_memory,
        ${recordReferents ? sql`true` : sql`${allowed(() => sql`user_direct_ids`, () => sql`prior_course_id`, () => sql`prior_material_use`)}
          AND ${allowed(() => sql`assistant_direct_ids`, () => sql`assistant_course_id`, () => sql`assistant_material_use`)}`} AS origin_allowed,
        ${requireDestinationSessionMaterials
          ? sql`(cardinality(session_material_ids) = 0 OR
            ${allowed(() => sql`session_material_ids`, () => sql`current_course_id`, () => sql`material_use`)})`
          : recordReferents || ancestors ? sql`true` : sql`${allowed(() => sql`user_direct_ids`, () => sql`current_course_id`, () => sql`material_use`)}
          AND ${allowed(() => sql`assistant_direct_ids`, () => sql`current_course_id`, () => sql`material_use`)}`} AS current_allowed
      FROM prior
      ${recordReferents ? sql`` : sql`LEFT JOIN conv_hist ch ON ch.conversation_id = prior.conversation_id`}
    )
    ${ancestors ? sql`SELECT evaluated.*,
      CASE WHEN row_number() OVER (
        PARTITION BY evaluated.conversation_id, (evaluated.id = evaluated.current_id)
        ORDER BY evaluated.created_at DESC, evaluated.id DESC
      ) = 1 THEN ch.conv_hashes END AS conv_misconception_hashes
      FROM evaluated
      LEFT JOIN conv_hist ch ON ch.conversation_id = evaluated.conversation_id
      ORDER BY evaluated.created_at DESC, evaluated.id DESC` : sql`,
    cutoff AS (
      SELECT p.created_at, p.id FROM evaluated p
      WHERE p.invalid IS TRUE OR p.assistant_direct_versioned IS NOT TRUE OR p.origin_allowed IS NOT TRUE
      ORDER BY p.created_at, p.id LIMIT 1
    ), filtered AS (
      SELECT evaluated.* FROM evaluated
      WHERE NOT EXISTS (SELECT 1 FROM cutoff WHERE (evaluated.created_at, evaluated.id) >= (cutoff.created_at, cutoff.id))
      ${recordReferents ? sql`` : sql`UNION ALL
        SELECT evaluated.* FROM evaluated
        WHERE NOT origin_allowed AND NOT invalid AND cardinality(user_direct_ids || assistant_direct_ids) > 0`}
    )
    SELECT filtered.*,
      ${recordReferents ? sql`NULL::jsonb` : sql`CASE WHEN row_number() OVER (
        PARTITION BY filtered.conversation_id, (filtered.origin_allowed IS NOT FALSE)
        ORDER BY filtered.created_at DESC, filtered.id DESC
      ) = 1 THEN ch.conv_hashes END`} AS conv_misconception_hashes
    FROM filtered
    ${recordReferents ? sql`` : sql`LEFT JOIN conv_hist ch ON ch.conversation_id = filtered.conversation_id`}
    ORDER BY filtered.created_at DESC, filtered.id DESC`}
  `;
}

type HistoryRows = readonly Awaited<ReturnType<typeof readSavedExchanges>>[number][];
type ConversationMisconceptionHashItem = {
  posUs: string;
  posId: string;
  assistantId: string;
  hash: string;
};

function mergeLineagesSafe(
  ...lineages: readonly (TutorMisconceptionLineage | undefined)[]
): TutorMisconceptionLineage | "conflict" | undefined {
  try {
    return mergeTutorMisconceptionLineages(...lineages);
  } catch {
    return "conflict";
  }
}

async function resolveExchangeMisconceptions(sql: Db, scope: OpeningScope, rows: HistoryRows) {
  const lineages: TutorMisconceptionLineage[] = [];
  const hashPositions = new Map<string, number | null>();
  const registerHash = (raw: unknown): number | null => {
    if (typeof raw !== "string") return null;
    if (hashPositions.has(raw)) return hashPositions.get(raw)!;
    const parsed = readSavedTutorMisconceptionLineage(raw);
    const position = parsed ? lineages.push(parsed) - 1 : null;
    hashPositions.set(raw, position);
    return position;
  };
  const convHashesById = new Map<string, ConversationMisconceptionHashItem[]>();
  for (const row of rows) {
    if (typeof row.conversation_id === "string" && Array.isArray(row.conv_misconception_hashes)) {
      convHashesById.set(row.conversation_id, row.conv_misconception_hashes as ConversationMisconceptionHashItem[]);
    }
  }
  const legacyPositions = rows.map(row => {
    if (row.assistant_intent_hash != null) return [registerHash(row.assistant_intent_hash)];
    if (typeof row.conversation_id === "string" && convHashesById.has(row.conversation_id)) return null;
    const fallback = (row as Record<string, unknown>).assistant_inherited_misconception_hashes;
    return Array.isArray(fallback) ? fallback.map(registerHash) : [];
  });
  for (const items of convHashesById.values()) for (const item of items) registerHash(item.hash);
  const active = await readActiveTutorMisconceptionLineages(sql, scope, lineages);
  const convWatermarks = new Map<string, {
    items: Array<{ posUs: bigint; posId: string }>;
    firstInactiveIdx: number;
    firstScopedIdx: number;
    firstScopedCourse: string | null;
    secondScopedIdx: number;
    prefixLineage: (TutorMisconceptionLineage | undefined)[];
  }>();
  for (const [convId, rawItems] of convHashesById) {
    const items = rawItems.map(item => ({ posUs: BigInt(item.posUs), posId: item.posId.toLowerCase() }));
    let firstInactiveIdx = Infinity;
    let firstScopedIdx = Infinity;
    let firstScopedCourse: string | null = null;
    let secondScopedIdx = Infinity;
    let runningCourse: string | null = null;
    const runningRevisions = new Set<string>();
    let currentLineage: TutorMisconceptionLineage | undefined;
    const prefixLineage = new Array<TutorMisconceptionLineage | undefined>(rawItems.length);
    for (let j = 0; j < rawItems.length; j++) {
      const pos = hashPositions.get(rawItems[j]!.hash) ?? null;
      if (pos === null || !active.has(pos)) {
        if (j < firstInactiveIdx) firstInactiveIdx = j;
      } else {
        const lineage = lineages[pos]!;
        let changed = false;
        if (lineage.courseId !== null) {
          if (firstScopedCourse === null) {
            firstScopedIdx = j;
            firstScopedCourse = lineage.courseId;
            runningCourse = lineage.courseId;
            changed = true;
          } else if (lineage.courseId !== firstScopedCourse && j < secondScopedIdx) {
            secondScopedIdx = j;
          }
        }
        for (const revId of lineage.revisionIds) {
          if (!runningRevisions.has(revId)) {
            runningRevisions.add(revId);
            changed = true;
          }
        }
        if (changed) {
          currentLineage = runningCourse || runningRevisions.size
            ? { kind: "v3_misconception_lineage", courseId: runningCourse, revisionIds: [...runningRevisions] }
            : undefined;
        }
      }
      prefixLineage[j] = currentLineage;
    }
    convWatermarks.set(convId, { items, firstInactiveIdx, firstScopedIdx, firstScopedCourse, secondScopedIdx, prefixLineage });
  }
  return rows.map((row, index) => {
    if (row.assistant_misconception_invalid === true) return null;
    const legacy = legacyPositions[index];
    if (legacy != null) {
      if (!legacy.every(position => position !== null && active.has(position))) return null;
      const inherited = legacy.map(position => lineages[position!]!);
      const inScope = inherited.every(lineage => historyCourseAllows(lineage.courseId, row.current_course_id ?? null));
      const merged = mergeLineagesSafe(...inherited);
      if (merged === "conflict") return null;
      return { lineage: inScope ? merged : undefined, inScope };
    }
    const wm = convWatermarks.get(row.conversation_id!);
    if (!wm || row.pos_us === undefined || row.id === undefined) return { lineage: undefined, inScope: true };
    const limit = upperBoundMemoryOriginPosition(wm.items, BigInt(row.pos_us), String(row.id).toLowerCase());
    if (limit <= 0) return { lineage: undefined, inScope: true };
    if (wm.firstInactiveIdx < limit || wm.secondScopedIdx < limit) return null;
    if (wm.firstScopedIdx < limit && row.assistant_course_id !== undefined
      && normalizeHistoryCourse(row.assistant_course_id) !== wm.firstScopedCourse) {
      return null;
    }
    const inScope = !(wm.firstScopedIdx < limit && normalizeHistoryCourse(row.current_course_id ?? null) !== wm.firstScopedCourse);
    return { lineage: inScope ? wm.prefixLineage[limit - 1] : undefined, inScope };
  });
}

async function readInheritedExchangeMemories(
  sql: Db, scope: OpeningScope, rows: HistoryRows, exchangeAssistantIds: ReadonlySet<string>,
): Promise<TurnMisconceptionMemoryOriginBatches> {
  const ids = [...new Set<string>(rows.filter(row => row.inherits_memory === true).map(row => String(row.assistant_id)))];
  return readTurnMisconceptionMemoryOriginBatches(sql, scope, ids, { excludeAssistantIds: exchangeAssistantIds });
}

function directExchangeMemoryAuthority(
  row: HistoryRows[number], batches: TurnMisconceptionMemoryOriginBatches | undefined,
  exchangeAssistantIds: ReadonlySet<string>, recordReferents = false,
): HistoryAncestorAuthority[] | null {
  const target = recordReferents || !batches ? undefined : batches.targets.get(String(row.assistant_id));
  if (!recordReferents && batches) {
    if (row.inherits_memory === true && !target) return null;
    if (target?.direct.some(origin => !origin)) return null;
  }
  const userIds = row.user_source_refs === undefined ? [] : parseContextMemoryDependencyIds(row.user_source_refs);
  const assistantIds = row.assistant_source_refs === undefined ? [] : parseContextMemoryDependencyIds(row.assistant_source_refs);
  if (!userIds || !assistantIds) return null;
  const mockHistorical = target && batches && batches.byConversation.size === 0
    ? target.direct.flatMap(origin => origin && origin.historical
      && !exchangeAssistantIds.has(String(origin.assistantTurnId ?? origin.id)) ? [{
        courseId: origin.courseId, consumerCourseId: origin.consumerCourseId, materialUse: origin.materialUse,
        memoryIds: origin.ids, backings: origin.backings,
        backingSourceIds: origin.ids.length ? memoryOnlyRefSourceIds(origin.refs) : undefined,
        sourceIds: [], expiresAt: Infinity, historical: true,
      }] : [])
    : [];
  return [
    { courseId: row.prior_course_id ?? null, materialUse: row.prior_material_use ?? "citation",
      memoryIds: row.user_memory_backing_ids === undefined ? [] : userIds, backings: row.user_memory_backing_ids ?? [],
      backingSourceIds: userIds.length && row.user_memory_backing_ids !== undefined
        ? memoryOnlyRefSourceIds(row.user_source_refs) : undefined,
      sourceIds: [], expiresAt: Infinity },
    { courseId: row.assistant_course_id ?? null, materialUse: row.assistant_material_use ?? "citation",
      memoryIds: recordReferents || row.memory_backing_ids === undefined ? [] : assistantIds,
      backings: recordReferents ? [] : (row.memory_backing_ids ?? []),
      backingSourceIds: !recordReferents && assistantIds.length && row.memory_backing_ids !== undefined
        ? memoryOnlyRefSourceIds(row.assistant_source_refs) : undefined,
      sourceIds: [],
      expiresAt: recordReferents || row.memory_temporary_expires_at == null ? Infinity : new Date(row.memory_temporary_expires_at).getTime() },
    ...mockHistorical,
  ];
}

function historyCourseBindings(
  row: HistoryRows[number], authority: HistoryAncestorAuthority[],
  extraBindings: Array<{ courseId: string | null; materialUse: MaterialUse; memoryIds: string[] }> = [],
): HistoryCourseBinding[] {
  if (!row.user_direct_ids || !row.assistant_direct_ids) return [];
  const bindings: HistoryCourseBinding[] = [
    { courseId: row.prior_course_id, materialUse: row.prior_material_use, sourceIds: [...new Set<string>(row.user_direct_ids)].sort(),
      sourceRefs: (parseContextSourceRefs(row.user_source_refs) ?? []).filter(ref => ref.memoryOnly !== true) },
    { courseId: row.assistant_course_id, materialUse: row.assistant_material_use, sourceIds: [...new Set<string>(row.assistant_direct_ids)].sort(),
      sourceRefs: mergeContextSourceRefs((parseContextSourceRefs(row.assistant_source_refs) ?? []).filter(ref => ref.memoryOnly !== true),
        ((row.assistant_citations ?? []) as ContextSourceRef[]).map(({ sourceId, sourceVersion }) => ({ sourceId, sourceVersion }))) },
  ];
  for (const [index, entry] of authority.entries()) {
    const binding = bindings[index] ?? { courseId: entry.courseId, materialUse: entry.materialUse, sourceIds: [], sourceRefs: [] };
    if (index >= bindings.length) bindings.push(binding);
    if (entry.memoryIds.length) binding.memoryIds = entry.memoryIds;
    if (entry.backings.length) binding.memoryBackings = entry.backings;
  }
  for (const extra of extraBindings) {
    if (!extra.memoryIds.length) continue;
    const match = bindings.find(b => (b.courseId?.toLowerCase() ?? null) === (extra.courseId?.toLowerCase() ?? null)
      && b.materialUse === extra.materialUse);
    if (match) {
      match.memoryIds = [...new Set([...(match.memoryIds ?? []), ...extra.memoryIds])].sort();
    } else {
      bindings.push({ courseId: extra.courseId, materialUse: extra.materialUse, sourceIds: [], sourceRefs: [], memoryIds: [...extra.memoryIds].sort() });
    }
  }
  return bindings.filter(binding => binding.courseId !== null || binding.sourceIds.length > 0
    || binding.memoryIds?.length || binding.memoryBackings?.length);
}

const normalizeHistoryCourse = (course: string | null | undefined) => course == null ? null : course.toLowerCase();
const historyCourseAllows = (course: string | null, ...targets: (string | null)[]) => {
  const own = normalizeHistoryCourse(course);
  return own === null || targets.every(target => normalizeHistoryCourse(target) === own);
};

function mergeHistoryCourseBindingItem(map: Map<string, HistoryCourseBinding>, binding: HistoryCourseBinding) {
  const key = `${normalizeHistoryCourse(binding.courseId)}:${binding.materialUse}`;
  const previous = map.get(key);
  if (!previous) {
    map.set(key, {
      ...binding,
      sourceIds: [...binding.sourceIds],
      sourceRefs: [...binding.sourceRefs],
      ...(binding.memoryIds?.length ? { memoryIds: [...binding.memoryIds] } : {}),
      ...(binding.memoryBackings?.length ? { memoryBackings: binding.memoryBackings.map(group => [...group]) } : {}),
    });
    return;
  }
  previous.sourceIds = [...new Set([...previous.sourceIds, ...binding.sourceIds])].sort();
  previous.sourceRefs = mergeContextSourceRefs(previous.sourceRefs, binding.sourceRefs);
  if (binding.memoryIds?.length) previous.memoryIds = [...new Set([...(previous.memoryIds ?? []), ...binding.memoryIds])].sort();
  if (binding.memoryBackings?.length) previous.memoryBackings = [...(previous.memoryBackings ?? []), ...binding.memoryBackings];
}

async function resolveExchangeMemories(sql: Db, scope: OpeningScope, rows: HistoryRows,
  excluded: string[], recordReferents = false,
) {
  const exchangeAssistantIds = new Set(rows.flatMap(row => row.assistant_id ? [String(row.assistant_id)] : []));
  const batches = recordReferents ? undefined : await readInheritedExchangeMemories(sql, scope, rows, exchangeAssistantIds);
  const lineage = rows.map(row => directExchangeMemoryAuthority(row, batches, exchangeAssistantIds, recordReferents));
  const convId = rows.find(row => typeof row.conversation_id === "string")?.conversation_id;
  const nonExchangeRaw = !recordReferents && convId && batches ? (batches.byConversation.get(convId) ?? []) : [];
  const nonExchangeEntries = nonExchangeRaw.map(item => ({
    posUs: item.posUs,
    posId: item.posId,
    assistantTurnId: item.origin.assistantTurnId ? String(item.origin.assistantTurnId) : undefined,
    entry: item.resolved === null ? null : {
      courseId: item.resolved.courseId,
      materialUse: item.resolved.materialUse,
      memoryIds: item.resolved.ids,
      backings: item.resolved.backings,
      backingSourceIds: item.resolved.ids.length ? memoryOnlyRefSourceIds(item.resolved.refs) : undefined,
      sourceIds: [],
      expiresAt: Infinity,
      historical: true,
    } satisfies HistoryAncestorAuthority,
  }));
  const materialUse = rows[0]?.material_use === "practice" ? "practice" : "citation";
  const allRootEntries = [
    ...lineage.flatMap(entries => entries ?? []),
    ...nonExchangeEntries.flatMap(item => item.entry ? [item.entry] : []),
  ];
  const graphs = await Promise.all((["citation", "practice"] as const).map(async use => {
    const roots = [...new Set(allRootEntries
      .filter(entry => entry.materialUse === use || materialUse === use).flatMap(historyAncestorMemoryIds))];
    return readMemoryDependencyStatus(sql, scope, roots, { excluded, materialUse: use });
  }));
  const graphFor = (use: MaterialUse) => graphs[use === "practice" ? 1 : 0]!;
  const byCourse = new Map<string | null, Set<string>>();
  for (const [index, entries] of lineage.entries()) for (const entry of entries ?? []) {
    const courses = entry.historical
      ? [normalizeHistoryCourse(entry.courseId)]
      : [normalizeHistoryCourse(entry.courseId), normalizeHistoryCourse(rows[index]!.current_course_id ?? null),
          normalizeHistoryCourse(entry.consumerCourseId === undefined ? entry.courseId : entry.consumerCourseId)];
    for (const course of new Set(courses)) {
      const ids = byCourse.get(course) ?? new Set<string>();
      for (const id of historyAncestorMemoryIds(entry)) ids.add(id.toLowerCase());
      byCourse.set(course, ids);
    }
  }
  for (const item of nonExchangeEntries) {
    if (!item.entry) continue;
    const course = normalizeHistoryCourse(item.entry.courseId);
    const ids = byCourse.get(course) ?? new Set<string>();
    for (const id of historyAncestorMemoryIds(item.entry)) ids.add(id.toLowerCase());
    byCourse.set(course, ids);
  }
  const active = new Map(await Promise.all([...byCourse].map(async ([course, ids]) => {
    const expanded = [...new Set([...ids, ...[...ids].flatMap(id =>
      graphs.flatMap(graph => graph.get(id)?.map(node => node.dep_id.toLowerCase()) ?? []))])];
    return [course, await readMemoryMisconceptionAuthorities(sql, scope, expanded, course)] as const;
  })));
  const getActive = (course: string | null | undefined) => active.get(normalizeHistoryCourse(course));
  const authorityFor = (entry: HistoryAncestorAuthority, depId: string, target: string | null) =>
    getActive(entry.historical ? entry.courseId : target)?.get(depId.toLowerCase());
  const collectExpirations = (
    entries: readonly HistoryAncestorAuthority[],
    groups: readonly (MemoryDependencyStatus[] | null)[],
    target: string | null | undefined,
  ) => groups.flatMap((group, i) => (group ?? []).flatMap(node => {
    const list: string[] = [];
    if (node.expires_at !== null) list.push(node.expires_at instanceof Date ? node.expires_at.toISOString() : String(node.expires_at));
    const auth = authorityFor(entries[i]!, node.dep_id, target === undefined ? entries[i]!.courseId : target);
    if (auth && Number.isFinite(auth.earliestExpiresAtMs)) list.push(new Date(auth.earliestExpiresAtMs).toISOString());
    return list;
  }));

  const targetCourseId = rows[0]?.current_course_id ?? null;
  const targetCourseNorm = normalizeHistoryCourse(targetCourseId);

  const directResolved = lineage.map((entries, index) => {
    if (!entries) return null;
    const courseId = rows[index]!.current_course_id ?? null;
    const own = entries.map(entry => resolveExchangeMemoryEntry(entry, graphFor(entry.materialUse), active, entry.courseId, false));
    if (own.some(nodes => nodes === null)) return null;
    const ownMisconceptionLineage = mergeLineagesSafe(
      ...own.flatMap((nodes, i) => (nodes ?? []).map(node => authorityFor(entries[i]!, node.dep_id, entries[i]!.courseId)?.lineage)),
    );
    if (ownMisconceptionLineage === "conflict") return null;
    const ownScopedMemoryCourses = [...new Set(own.flatMap((nodes, i) => (nodes ?? []).flatMap(node => {
      const auth = authorityFor(entries[i]!, node.dep_id, entries[i]!.courseId);
      const courses = [
        normalizeHistoryCourse(node.course_id),
        ...(auth?.dependencies ?? []).map(dep => normalizeHistoryCourse(dep.courseId)),
      ];
      return courses.filter((c): c is string => c !== null);
    })))];
    const current = entries.map(entry => resolveExchangeMemoryEntry(entry, graphFor(materialUse), active, courseId, true));
    const currentMisconception = current.every(nodes => nodes !== null)
      ? mergeLineagesSafe(
        ...current.flatMap((nodes, i) => (nodes ?? []).map(node => authorityFor(entries[i]!, node.dep_id, courseId)?.lineage)),
      )
      : undefined;
    const inScope = current.every(nodes => nodes !== null) && currentMisconception !== "conflict";
    const extraBindings = entries.flatMap((entry, i) => (own[i] ?? []).flatMap(node =>
      authorityFor(entry, node.dep_id, entry.courseId)?.bindings ?? []));
    const transitiveCurrentIds = current.flatMap((nodes, i) => (nodes ?? []).flatMap(node => {
      const auth = authorityFor(entries[i]!, node.dep_id, courseId);
      const selfAllowed = historyCourseAllows(node.course_id, courseId);
      const depsAllowed = (auth?.dependencies ?? []).filter(dep => historyCourseAllows(dep.courseId, courseId)).map(dep => dep.id);
      return [...(selfAllowed ? [node.dep_id] : []), ...depsAllowed];
    }));
    return {
      ids: [...new Set([
        ...(recordReferents ? [] : (parseContextMemoryDependencyIds(rows[index]!.assistant_source_refs) ?? [])),
        ...transitiveCurrentIds,
      ])],
      inScope,
      ownExpirations: collectExpirations(entries, own, undefined),
      expirations: collectExpirations(entries, current, courseId),
      bindings: historyCourseBindings(rows[index]!, entries.map((entry, i) => ({
        ...entry, backings: entry.backings.map(ids => ids.filter(id => own[i]!.some(node => node.dep_id === id))),
      })), extraBindings),
      misconceptionLineage: inScope ? currentMisconception : undefined,
      ownMisconceptionLineage,
      ownScopedMemoryCourses,
    };
  });

  if (recordReferents || rows.length === 0) return directResolved;

  const evaluatedNonExchange = nonExchangeEntries.map(item => {
    if (!item.entry) return { posUs: item.posUs, posId: item.posId, validOwn: false as const };
    const ownNodes = resolveExchangeMemoryEntry(item.entry, graphFor(item.entry.materialUse), active, item.entry.courseId, false);
    if (!ownNodes) return { posUs: item.posUs, posId: item.posId, validOwn: false as const };
    const ownLineage = mergeLineagesSafe(
      ...ownNodes.map(node => authorityFor(item.entry!, node.dep_id, item.entry!.courseId)?.lineage),
    );
    if (ownLineage === "conflict") return { posUs: item.posUs, posId: item.posId, validOwn: false as const };
    const currentNodes = resolveExchangeMemoryEntry(item.entry, graphFor(materialUse), active, targetCourseId, true);
    const currentLineage = currentNodes
      ? mergeLineagesSafe(...currentNodes.map(node => authorityFor(item.entry!, node.dep_id, targetCourseId)?.lineage))
      : undefined;
    const inScopeCurrent = currentNodes !== null && currentLineage !== "conflict";
    const transitiveIds = (currentNodes ?? []).flatMap(node => {
      const auth = authorityFor(item.entry!, node.dep_id, targetCourseId);
      const selfAllowed = historyCourseAllows(node.course_id, targetCourseId);
      const depsAllowed = (auth?.dependencies ?? []).filter(dep => historyCourseAllows(dep.courseId, targetCourseId)).map(dep => dep.id);
      return [...(selfAllowed ? [node.dep_id] : []), ...depsAllowed];
    });
    const filteredBackings = item.entry.backings.map(ids => ids.filter(id => ownNodes.some(node => node.dep_id === id)));
    const extraBindings = ownNodes.flatMap(node => authorityFor(item.entry!, node.dep_id, item.entry!.courseId)?.bindings ?? []);
    const itemBindings: HistoryCourseBinding[] = [];
    if (item.entry.courseId !== null || item.entry.memoryIds.length || filteredBackings.some(b => b.length)) {
      itemBindings.push({
        courseId: item.entry.courseId,
        materialUse: item.entry.materialUse,
        sourceIds: [],
        sourceRefs: [],
        ...(item.entry.memoryIds.length ? { memoryIds: item.entry.memoryIds } : {}),
        ...(filteredBackings.length ? { memoryBackings: filteredBackings } : {}),
      });
    }
    for (const extra of extraBindings) {
      if (extra.memoryIds.length) {
        itemBindings.push({ courseId: extra.courseId, materialUse: extra.materialUse, sourceIds: [], sourceRefs: [], memoryIds: [...extra.memoryIds].sort() });
      }
    }
    return {
      posUs: item.posUs,
      posId: item.posId,
      validOwn: true as const,
      ownExpirations: collectExpirations([item.entry], [ownNodes], undefined),
      ownLineage,
      inScopeCurrent,
      currentIds: transitiveIds,
      currentExpirations: collectExpirations([item.entry], [currentNodes], targetCourseId),
      bindings: itemBindings,
    };
  });

  // Sweep chronologically (oldest = rows.length - 1 -> newest = 0) in O(N + M).
  const out = new Array<typeof directResolved[number]>(rows.length);
  let p = 0;
  let prefixOwnInvalid = false;
  const prefixOwnExpirations = new Set<string>();
  let prefixMisconceptionCourse: string | null | "conflict" = null;
  const prefixRevisionSet = new Set<string>();
  let cachedPrefixLineage: TutorMisconceptionLineage | undefined;
  let prefixNonExchangeOutOfScope = false;
  let prefixCitationOnlyOutOfScope = false;
  const prefixOutOfScopeMemoryCourses = new Set<string>();
  const prefixNonExchangeIds = new Set<string>();
  const prefixCurrentExpirations = new Set<string>();
  const prefixNonExchangeBindings = new Map<string, HistoryCourseBinding>();
  const foldLineage = (lineage: TutorMisconceptionLineage | undefined) => {
    if (!lineage) return;
    let changed = false;
    if (lineage.courseId !== null && prefixMisconceptionCourse !== "conflict") {
      const normalized = normalizeHistoryCourse(lineage.courseId)!;
      if (prefixMisconceptionCourse === null) {
        prefixMisconceptionCourse = normalized;
        changed = true;
      } else if (prefixMisconceptionCourse !== normalized) {
        prefixMisconceptionCourse = "conflict";
        changed = true;
      }
    }
    for (const revId of lineage.revisionIds) {
      if (!prefixRevisionSet.has(revId)) {
        prefixRevisionSet.add(revId);
        changed = true;
      }
    }
    if (changed && prefixMisconceptionCourse !== "conflict") {
      cachedPrefixLineage = prefixMisconceptionCourse || prefixRevisionSet.size
        ? { kind: "v3_misconception_lineage", courseId: prefixMisconceptionCourse, revisionIds: [...prefixRevisionSet] }
        : undefined;
    }
  };

  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.pos_us !== undefined && row.id !== undefined) {
      const rowPosUs = BigInt(row.pos_us);
      const rowPosId = String(row.id).toLowerCase();
      while (p < evaluatedNonExchange.length) {
        const item = evaluatedNonExchange[p]!;
        if (!(item.posUs < rowPosUs || (item.posUs === rowPosUs && item.posId < rowPosId))) break;
        p++;
        if (!item.validOwn) {
          prefixOwnInvalid = true;
          continue;
        }
        for (const exp of item.ownExpirations) prefixOwnExpirations.add(exp);
        foldLineage(item.ownLineage);
        for (const binding of item.bindings) mergeHistoryCourseBindingItem(prefixNonExchangeBindings, binding);
        if (!item.inScopeCurrent) prefixNonExchangeOutOfScope = true;
        else {
          for (const id of item.currentIds) prefixNonExchangeIds.add(id);
          for (const exp of item.currentExpirations) prefixCurrentExpirations.add(exp);
        }
      }
    }

    const direct = directResolved[index];
    if (!direct) {
      out[index] = null;
      prefixOwnInvalid = true;
      continue;
    }

    if (row.assistant_intent_hash == null) {
      const assistantCourse = row.assistant_course_id === undefined ? undefined : normalizeHistoryCourse(row.assistant_course_id);
      if (prefixOwnInvalid || prefixMisconceptionCourse === "conflict"
        || (prefixMisconceptionCourse !== null && assistantCourse !== undefined && assistantCourse !== prefixMisconceptionCourse)) {
        out[index] = null;
        prefixOwnInvalid = true;
        continue;
      }
      let effectiveInScope = direct.inScope && !prefixNonExchangeOutOfScope;
      if (prefixMisconceptionCourse !== null && prefixMisconceptionCourse !== targetCourseNorm) {
        effectiveInScope = false;
      }
      if (prefixCitationOnlyOutOfScope && (row.assistant_material_use ?? "citation") !== "practice") {
        effectiveInScope = false;
      }
      if (prefixOutOfScopeMemoryCourses.size > 0) {
        const isolatedInTarget = targetCourseNorm !== null && assistantCourse === targetCourseNorm
          && !prefixOutOfScopeMemoryCourses.has(assistantCourse);
        if (!isolatedInTarget) effectiveInScope = false;
      }
      const mergedLineage = effectiveInScope ? mergeLineagesSafe(cachedPrefixLineage, direct.misconceptionLineage) : undefined;
      if (mergedLineage === "conflict") effectiveInScope = false;
      let mergedBindings = direct.bindings;
      if (prefixNonExchangeBindings.size > 0 && row.user_direct_ids && row.assistant_direct_ids) {
        const map = new Map<string, HistoryCourseBinding>();
        for (const b of direct.bindings) mergeHistoryCourseBindingItem(map, b);
        for (const b of prefixNonExchangeBindings.values()) mergeHistoryCourseBindingItem(map, b);
        mergedBindings = [...map.values()];
      }
      out[index] = {
        ...direct,
        inScope: effectiveInScope,
        ownExpirations: prefixOwnExpirations.size ? [...new Set([...direct.ownExpirations, ...prefixOwnExpirations])] : direct.ownExpirations,
        ids: effectiveInScope && prefixNonExchangeIds.size ? [...new Set([...direct.ids, ...prefixNonExchangeIds])] : direct.ids,
        expirations: effectiveInScope && prefixCurrentExpirations.size
          ? [...new Set([...direct.expirations, ...prefixCurrentExpirations])]
          : direct.expirations,
        bindings: mergedBindings,
        misconceptionLineage: effectiveInScope && mergedLineage !== "conflict" ? mergedLineage : undefined,
      };
    } else {
      out[index] = direct;
    }

    // Advance running prefix with this exchange's own authority for chronologically newer exchanges.
    for (const exp of direct.ownExpirations) prefixOwnExpirations.add(exp);
    if (row.memory_temporary_expires_at != null) prefixOwnExpirations.add(String(row.memory_temporary_expires_at));
    foldLineage(direct.ownMisconceptionLineage);
    if (!direct.inScope) {
      const mismatchedCourses = direct.ownScopedMemoryCourses.filter(c => c !== targetCourseNorm);
      for (const c of mismatchedCourses) prefixOutOfScopeMemoryCourses.add(c);
      if (mismatchedCourses.length === 0) prefixCitationOnlyOutOfScope = true;
    } else {
      for (const exp of direct.expirations) prefixCurrentExpirations.add(exp);
    }
  }
  return out;
}

function resolveExchangeMemoryEntry(
  entry: HistoryAncestorAuthority, graph: ReadonlyMap<string, MemoryDependencyStatus[]>,
  active: ReadonlyMap<string | null, Map<string, MemoryMisconceptionAuthority>>, target: string | null,
  checkTargetScope = true,
) {
  const getActive = (course: string | null | undefined) => active.get(normalizeHistoryCourse(course));
  const courses = entry.historical
    ? [entry.courseId]
    : [entry.courseId, target, entry.consumerCourseId === undefined ? entry.courseId : entry.consumerCourseId];
  const misconceptionTargets = entry.historical
    ? [
        entry.courseId,
        ...(entry.consumerCourseId === undefined ? [] : [entry.consumerCourseId]),
        ...(entry.extraMisconceptionCourses ?? []),
        ...(checkTargetScope ? [target] : []),
      ]
    : courses;
  const allowed = (rawId: string) => {
    const id = rawId.toLowerCase();
    if (!courses.every(course => getActive(course)?.has(id))) return false;
    const auth = getActive(entry.courseId)?.get(id);
    return Boolean(auth && historyCourseAllows(auth.lineage?.courseId ?? null, ...misconceptionTargets));
  };
  const usable = new Map<string, MemoryDependencyStatus[]>();
  for (const id of historyAncestorMemoryIds(entry)) {
    const nodes = graph.get(id);
    if (nodes?.every(node => allowed(node.dep_id)) && allowed(id)) usable.set(id, nodes);
  }
  const targetAuthorities = getActive(entry.historical ? entry.courseId : target);
  const backings = entry.backings.map(ids => ids.filter(id => usable.has(id)).sort((a, b) =>
    Number(Boolean(targetAuthorities?.get(a.toLowerCase())?.lineage))
      - Number(Boolean(targetAuthorities?.get(b.toLowerCase())?.lineage)) || a.localeCompare(b)));
  return resolveMemoryDependencyStatus(usable, entry.memoryIds, backings,
    entry.historical ? entry.courseId : target, undefined, entry.backingSourceIds);
}

export type HistoryAncestorAuthority = {
  courseId: string | null; consumerCourseId?: string | null; extraMisconceptionCourses?: readonly (string | null)[];
  materialUse: MaterialUse; memoryIds: string[]; backings: string[][]; expiresAt: number;
  sourceIds: string[]; backingSourceIds?: string[]; historical?: boolean;
};

type HistoryAncestorRules = {
  collectSourceIds?: Set<string>; collectCourseIds?: Set<string>; lockedSourceIds?: readonly string[];
  requireDestinationSessionMaterials?: boolean;
  checkCurrentMisconceptions?: boolean;
  skipPriorMisconceptions?: boolean;
};

/** Collect direct ancestor authority without resolving memory edges yet. */
export async function readTutorHistoryAncestorAuthority(sql: Db, scope: OpeningScope, userTurnIds: readonly string[], rules?: HistoryAncestorRules) {
  const authority = new Map<string, HistoryAncestorAuthority[] | null>(userTurnIds.map(id => [id, []]));
  if (!userTurnIds.length) return authority;
  const locked = rules?.lockedSourceIds && new Set(rules.lockedSourceIds);
  const rows = await readSavedExchanges(sql, scope, userTurnIds, "ancestors", [],
    rules?.requireDestinationSessionMaterials, rules?.checkCurrentMisconceptions !== false);
  // A completed answer records exactly the revisions it used, including any inherited revisions.
  const currentRows = rows.filter(row => row.id === row.current_id && row.assistant_intent_hash != null);
  const currentMisconceptions = await resolveExchangeMisconceptions(sql, scope, currentRows);
  const explicitCurrentIds = new Set<string>();
  for (const [index, row] of currentRows.entries()) {
    const current = currentMisconceptions[index];
    if (!current?.inScope) authority.set(row.current_id, null);
    else {
      explicitCurrentIds.add(row.current_id);
      if (current.lineage?.courseId) rules?.collectCourseIds?.add(current.lineage.courseId);
    }
  }
  const priors = rows.filter(row => row.id !== row.current_id);
  const exchangeAssistantIds = new Set(priors.flatMap(row => row.assistant_id ? [String(row.assistant_id)] : []));
  const batches = await readInheritedExchangeMemories(sql, scope, priors, exchangeAssistantIds);
  const checkedRows = rules?.skipPriorMisconceptions ? [] : priors.filter(row =>
    authority.get(row.current_id) !== null && !explicitCurrentIds.has(row.current_id));
  const checkedLineages = await resolveExchangeMisconceptions(sql, scope, checkedRows);
  const misconceptions = new Map(checkedRows.map((row, index) => [row, checkedLineages[index]]));

  // Track later hashless courses per current_id (rows are newest-first) and deduplicate non-exchange prefix items.
  const hashlessCoursesByCurrent = new Map<string, Set<string | null>>();
  const emittedConvOriginsByCurrent = new Map<string, Map<string, HistoryAncestorAuthority>>();

  for (const row of priors) {
    const entries = authority.get(row.current_id);
    if (!entries) continue;
    const checkPriorScope = !explicitCurrentIds.has(row.current_id) && !rules?.skipPriorMisconceptions;
    let requiredCourses = hashlessCoursesByCurrent.get(row.current_id);
    if (!requiredCourses) {
      requiredCourses = new Set<string | null>();
      if (checkPriorScope) requiredCourses.add(normalizeHistoryCourse(row.current_course_id ?? null));
      hashlessCoursesByCurrent.set(row.current_id, requiredCourses);
    }
    const misconception = misconceptions.get(row);
    const assistantRefs = parseContextSourceRefs(row.assistant_source_refs);
    const userRefs = parseContextSourceRefs(row.user_source_refs);
    const memoryAuthority = directExchangeMemoryAuthority(row, batches, exchangeAssistantIds);
    if (row.invalid || !row.assistant_direct_versioned || !row.origin_allowed || row.current_allowed === false
      || (misconception !== undefined && (!misconception || !misconception.inScope)) || !memoryAuthority || !assistantRefs || !userRefs
      || memoryAuthority.some(entry => !(entry.expiresAt > Date.now()))) {
      authority.set(row.current_id, null);
      continue;
    }
    if (row.inherits_memory === true && row.conversation_id && row.pos_us !== undefined && row.id !== undefined) {
      const convItems = batches.byConversation.get(row.conversation_id) ?? [];
      const limit = upperBoundMemoryOriginPosition(convItems, BigInt(row.pos_us), String(row.id).toLowerCase());
      const assistantCourse = normalizeHistoryCourse(row.assistant_course_id ?? null);
      let emitted = emittedConvOriginsByCurrent.get(row.current_id);
      if (!emitted) {
        emitted = new Map();
        emittedConvOriginsByCurrent.set(row.current_id, emitted);
      }
      let prefixInvalid = false;
      for (let j = 0; j < limit; j++) {
        const item = convItems[j]!;
        if (!item.resolved) {
          prefixInvalid = true;
          break;
        }
        const existing = emitted.get(item.resolved.id);
        const extra = [...new Set([assistantCourse, ...requiredCourses])].slice(0, 2);
        if (existing) {
          existing.extraMisconceptionCourses = [...new Set([...(existing.extraMisconceptionCourses ?? []), ...extra])].slice(0, 2);
        } else {
          const histEntry: HistoryAncestorAuthority = {
            courseId: item.resolved.courseId,
            consumerCourseId: checkPriorScope ? (row.current_course_id ?? null) : assistantCourse,
            extraMisconceptionCourses: extra,
            materialUse: item.resolved.materialUse,
            memoryIds: item.resolved.ids,
            backings: item.resolved.backings,
            backingSourceIds: item.resolved.ids.length ? memoryOnlyRefSourceIds(item.resolved.refs) : undefined,
            sourceIds: [],
            expiresAt: Infinity,
            historical: true,
          };
          emitted.set(item.resolved.id, histEntry);
          if (histEntry.courseId !== null) rules?.collectCourseIds?.add(histEntry.courseId);
          entries.push(histEntry);
        }
      }
      if (prefixInvalid) {
        authority.set(row.current_id, null);
        continue;
      }
    }
    const [userAuthority, assistantAuthority] = memoryAuthority;
    userAuthority!.sourceIds = [...(row.user_direct_ids ?? []), ...userRefs.map(ref => ref.sourceId)];
    assistantAuthority!.sourceIds = [...(row.assistant_direct_ids ?? []), ...assistantRefs.map(ref => ref.sourceId)];
    const extraCourses = requiredCourses.size ? [...requiredCourses].slice(0, 2) : undefined;
    for (const entry of [userAuthority!, assistantAuthority!]) {
      entry.historical = true;
      if (checkPriorScope) entry.consumerCourseId = row.current_course_id ?? null;
      if (extraCourses) entry.extraMisconceptionCourses = extraCourses;
    }
    const sources = memoryAuthority.flatMap(entry => entry.sourceIds);
    if (locked && sources.some(id => !locked.has(id))) {
      authority.set(row.current_id, null);
      continue;
    }
    for (const entry of memoryAuthority) if (entry.courseId !== null) rules?.collectCourseIds?.add(entry.courseId);
    if (misconception?.inScope && misconception.lineage?.courseId) rules?.collectCourseIds?.add(misconception.lineage.courseId);
    for (const id of sources) rules?.collectSourceIds?.add(id);
    entries.push(...memoryAuthority);
    if (checkPriorScope && row.assistant_intent_hash == null && requiredCourses.size < 2) {
      requiredCourses.add(normalizeHistoryCourse(row.assistant_course_id ?? null));
    }
  }
  return authority;
}

export function historyAncestorMemoryIds(authority: HistoryAncestorAuthority) {
  return [...authority.memoryIds, ...authority.backings.flat()];
}

export function resolveHistoryAncestors(authority: HistoryAncestorAuthority[],
  graphFor: (materialUse: MaterialUse) => ReadonlyMap<string, MemoryDependencyStatus[]>,
  excludedId?: string,
) {
  let expiry = Infinity;
  const sourceIds = new Set<string>();
  for (const entry of authority) {
    const dependencies = resolveMemoryDependencyStatus(graphFor(entry.materialUse), entry.memoryIds, entry.backings,
      entry.courseId, excludedId, entry.backingSourceIds);
    if (!dependencies) return null;
    for (const sourceId of [...entry.sourceIds, ...dependencies.flatMap(node => node.sourceIds ?? [])]) sourceIds.add(sourceId);
    expiry = Math.min(expiry, entry.expiresAt, ...dependencies.map(node =>
      node.expires_at === null ? Infinity : new Date(node.expires_at).getTime()));
  }
  return { expiresAt: expiry, sourceIds };
}

/** Revalidate the saved conversation prefix before reusing its derivative. */
export async function readTutorHistoryAncestorStatus(sql: Db, scope: OpeningScope, currentTurnId: string, rules?: HistoryAncestorRules) {
  const authority = (await readTutorHistoryAncestorAuthority(sql, scope, [currentTurnId], rules)).get(currentTurnId);
  if (!authority) return { valid: false, hasAncestors: true, earliestExpiresAtMs: -Infinity };
  const graph = new Map<MaterialUse, Map<string, MemoryDependencyStatus[]>>();
  for (const use of ["citation", "practice"] as const) {
    const ids = authority.filter(entry => entry.materialUse === use).flatMap(historyAncestorMemoryIds);
    graph.set(use, await readMemoryDependencyStatus(sql, scope, ids, { ...rules, materialUse: use }));
  }
  const byCourse = new Map<string | null, Set<string>>();
  for (const entry of authority) {
    const roots = historyAncestorMemoryIds(entry);
    if (!roots.length) continue;
    const courses = entry.historical
      ? [normalizeHistoryCourse(entry.courseId)]
      : [normalizeHistoryCourse(entry.courseId), normalizeHistoryCourse(entry.consumerCourseId === undefined ? entry.courseId : entry.consumerCourseId)];
    for (const course of new Set(courses)) {
      const ids = byCourse.get(course) ?? new Set<string>();
      for (const id of roots) {
        ids.add(id.toLowerCase());
        for (const node of graph.get(entry.materialUse)?.get(id) ?? []) ids.add(node.dep_id.toLowerCase());
      }
      byCourse.set(course, ids);
    }
  }
  const active = new Map<string | null, Map<string, MemoryMisconceptionAuthority>>();
  for (const [course, ids] of byCourse) {
    active.set(course, await readMemoryMisconceptionAuthorities(sql, scope, [...ids], course));
  }
  let earliestExpiresAtMs = Infinity;
  for (const entry of authority) {
    const nodes = resolveExchangeMemoryEntry(entry, graph.get(entry.materialUse)!, active, entry.courseId, false);
    if (!nodes) return { valid: false, hasAncestors: true, earliestExpiresAtMs: -Infinity };
    const authMap = active.get(normalizeHistoryCourse(entry.courseId));
    for (const node of nodes) {
      if (node.course_id !== null) rules?.collectCourseIds?.add(node.course_id);
      const auth = authMap?.get(node.dep_id.toLowerCase());
      if (auth?.lineage?.courseId) rules?.collectCourseIds?.add(auth.lineage.courseId);
      for (const binding of auth?.bindings ?? []) {
        if (binding.courseId !== null) rules?.collectCourseIds?.add(binding.courseId);
      }
    }
    earliestExpiresAtMs = Math.min(
      earliestExpiresAtMs, entry.expiresAt,
      ...nodes.map(node => Math.min(
        node.expires_at === null ? Infinity : new Date(node.expires_at).getTime(),
        authMap?.get(node.dep_id.toLowerCase())?.earliestExpiresAtMs ?? Infinity,
      )),
    );
  }
  return { valid: earliestExpiresAtMs > Date.now(), hasAncestors: authority.length > 0, earliestExpiresAtMs };
}

export async function readTutorHistoryAncestors(...args: Parameters<typeof readTutorHistoryAncestorStatus>) {
  return (await readTutorHistoryAncestorStatus(...args)).valid;
}

/** Keep the independent exchanges before the first invalid saved origin. */
export async function loadTutorHistoryContext(sql: Sql, scope: OpeningScope, currentTurnId: string, purpose: TutorHistoryPurpose = "model"): Promise<TutorHistoryContext> {
  const recordReferents = purpose === "record_referents";
  const excluded = await createOpeningPrivacyRepository(sql).listExcludedSourceIds(scope);
  const exchanges = await readSavedExchanges(sql, scope, [currentTurnId], purpose, excluded);
  const revokedDirectSourceIds = [...new Set<string>(exchanges.flatMap(row => row.origin_allowed === false
    ? [...row.user_direct_ids, ...row.assistant_direct_ids].filter(isLineageUuid) : []))].sort();
  const rows = exchanges.filter(row => row.origin_allowed !== false);
  const resolved = await resolveExchangeMemories(sql, scope, rows, excluded, recordReferents);
  const misconceptions = recordReferents ? [] : await resolveExchangeMisconceptions(sql, scope, rows);
  const nowMs = Date.now();
  let firstValid = 0;
  const expirations = rows.map((row, index) => {
    const ownExpirations = resolved[index]?.ownExpirations ?? [];
    const own = row.memory_temporary_expires_at == null ? ownExpirations : [...ownExpirations, row.memory_temporary_expires_at];
    const times = own.map(expiry => new Date(expiry).getTime());
    if (resolved[index] === null || misconceptions[index] === null || times.some(time => !(time > nowMs))
      || (recordReferents && !recordReceiptValid(row, scope))) firstValid = index + 1;
    return times;
  });
  const selected = rows.flatMap((row, index) => index >= firstValid && row.current_allowed !== false
    && resolved[index]?.inScope && (recordReferents || misconceptions[index]?.inScope)
    ? [{ row, index, dependencies: resolved[index]! }] : []).slice(0, 20);
  const textIds = selected.flatMap(({ row }) => typeof row.id === "string"
    ? (recordReferents ? [row.id] : [row.id, String(row.assistant_id)]) : []);
  const texts = textIds.length ? await sql<{ id: string; text: string }[]>`
    SELECT id, left(text, 12001) AS text FROM opening_turns
    WHERE workspace_id=${scope.workspaceId} AND id=ANY(${textIds}::uuid[]) AND status='complete'` : [];
  const textById = new Map(texts.map(row => [row.id, row.text]));
  const history: HistoryTurn[] = [];
  let characters = 0;
  const sourceRefs: ContextSourceRef[] = [];
  const selectedDestinationSourceIds = new Set<string>();
  const courseBindings = new Map<string, HistoryCourseBinding>();
  const mergeBinding = (binding: HistoryCourseBinding) => {
    const key = `${binding.courseId}:${binding.materialUse}`;
    const previous = courseBindings.get(key);
    if (!previous) {
      courseBindings.set(key, binding);
      return;
    }
    previous.sourceIds = [...new Set([...previous.sourceIds, ...binding.sourceIds])].sort();
    previous.sourceRefs = mergeContextSourceRefs(previous.sourceRefs, binding.sourceRefs);
    if (binding.memoryIds?.length) previous.memoryIds = [...new Set([...(previous.memoryIds ?? []), ...binding.memoryIds])].sort();
    if (binding.memoryBackings?.length) previous.memoryBackings = [...(previous.memoryBackings ?? []), ...binding.memoryBackings];
  };
  const memoryIdSet = new Set<string>();
  let misconceptionCourseId: string | null = null;
  const misconceptionRevisionIds = new Set<string>();
  let newestRetained = rows.length;
  let newestRetainedHashless = rows.length;
  let earliestExpiry = Infinity;
  const retainedIndices = new Set<number>();
  for (const { row, index, dependencies } of selected) {
    if (dependencies.expirations.some(expiry => !(new Date(expiry).getTime() > nowMs))) continue;
    const question = row.question ?? textById.get(String(row.id));
    const answer = recordReferents ? "" : (row.answer ?? textById.get(String(row.assistant_id)));
    if (typeof question !== "string" || typeof answer !== "string") {
      return { history: [], sourceRefs: [], ...(revokedDirectSourceIds.length ? { revokedDirectSourceIds } : {}) };
    }
    if (characters + question.length + answer.length > 12_000) break;
    retainedIndices.add(index);
    newestRetained = Math.min(newestRetained, index);
    if (row.assistant_intent_hash == null) newestRetainedHashless = Math.min(newestRetainedHashless, index);
    for (const expiry of expirations[index]!) earliestExpiry = Math.min(earliestExpiry, expiry);
    for (const expiry of dependencies.expirations) earliestExpiry = Math.min(earliestExpiry, new Date(expiry).getTime());
    // Record follow-ups inherit the user's referent, never prior assistant claims.
    if (recordReferents) history.unshift({ role: "user", text: question });
    else history.unshift({ role: "user", text: question }, { role: "assistant", text: answer });
    // For model history, every assistant source ID is already covered by a direct pin, ref or citation.
    sourceRefs.push(...(parseContextSourceRefs(row.user_source_refs) ?? []),
      ...(parseContextSourceRefs(row.assistant_source_refs) ?? []));
    if (!recordReferents) {
      const lineage = mergeTutorMisconceptionLineages(
        misconceptions[index]?.lineage ?? undefined, dependencies.misconceptionLineage,
      );
      if (lineage) {
        for (const id of lineage.revisionIds) misconceptionRevisionIds.add(id);
        if (lineage.courseId) {
          misconceptionCourseId = lineage.courseId;
          mergeBinding({ courseId: lineage.courseId, materialUse: row.material_use ?? "citation", sourceIds: [], sourceRefs: [] });
        }
      }
      const sourceIds = [...new Set<string>([...(row.user_direct_ids ?? []), ...(row.assistant_direct_ids ?? [])].filter(isLineageUuid))].sort();
      for (const id of sourceIds) selectedDestinationSourceIds.add(id);
      if (sourceIds.length) mergeBinding({ courseId: row.current_course_id ?? null, materialUse: row.material_use ?? "citation",
        sourceIds, sourceRefs: [], memoryIds: [], memoryBackings: [] });
      // The SQL admission above requires each citation to name an available source and version.
      for (const { sourceId, sourceVersion } of (row.assistant_citations as ContextSourceRef[] | undefined) ?? []) {
        sourceRefs.push({ sourceId, sourceVersion });
      }
    }
    const ancestorMemoryIds = parseContextMemoryDependencyIds([{ memoryDependencyIds: row.memory_dependency_ids }]) ?? [];
    for (const memoryId of [...dependencies.ids, ...ancestorMemoryIds]) memoryIdSet.add(memoryId);
    characters += question.length + answer.length;
  }
  if (!recordReferents) for (let index = newestRetained; index < rows.length; index++) {
    for (const expiry of expirations[index]!) earliestExpiry = Math.min(earliestExpiry, expiry);
    for (const binding of resolved[index]?.bindings ?? []) mergeBinding(binding);
    if (index > newestRetainedHashless && !retainedIndices.has(index)) {
      const omitted = resolved[index];
      if (omitted?.inScope) {
        for (const expiry of omitted.expirations) earliestExpiry = Math.min(earliestExpiry, new Date(expiry).getTime());
      }
      const omittedLineage = mergeLineagesSafe(
        misconceptions[index]?.inScope ? misconceptions[index]?.lineage : undefined,
        omitted?.inScope ? omitted.misconceptionLineage : undefined,
      );
      if (omittedLineage && omittedLineage !== "conflict") {
        for (const id of omittedLineage.revisionIds) misconceptionRevisionIds.add(id);
        if (omittedLineage.courseId) {
          misconceptionCourseId = omittedLineage.courseId;
          mergeBinding({ courseId: omittedLineage.courseId, materialUse: rows[index]!.material_use ?? "citation", sourceIds: [], sourceRefs: [] });
        }
      }
    }
  }
  const mergedRefs = mergeContextSourceRefs(sourceRefs);
  const destination = courseBindings.get(`${rows[0]?.current_course_id ?? null}:${rows[0]?.material_use ?? "citation"}`);
  if (destination) {
    const versionedDirect = new Set(mergedRefs.filter(ref => ref.memoryOnly !== true).map(ref => ref.sourceId));
    if (destination.sourceIds.some(id => !versionedDirect.has(id))) {
      // Origin bindings also contain omitted history. Persist only sources from selected text.
      destination.selectedDestinationSourceIds = [...selectedDestinationSourceIds].sort();
    }
  }
  const memoryIds = [...memoryIdSet].sort();
  const historyMisconceptionLineage: TutorMisconceptionLineage | undefined = misconceptionCourseId || misconceptionRevisionIds.size
    ? { kind: "v3_misconception_lineage", courseId: misconceptionCourseId, revisionIds: [...misconceptionRevisionIds] } : undefined;
  return {
    history,
    sourceRefs: mergedRefs,
    ...(courseBindings.size ? { historyCourseBindings: [...courseBindings.values()] } : {}),
    ...(historyMisconceptionLineage ? { historyMisconceptionLineage } : {}),
    ...(revokedDirectSourceIds.length ? { revokedDirectSourceIds } : {}),
    ...(memoryIds.length ? { memoryIds } : {}),
    ...(Number.isFinite(earliestExpiry) ? { temporaryMemoryExpiresAt: new Date(earliestExpiry).toISOString() } : {}),
  };
}

function recordReceiptValid(row: HistoryRows[number], scope: OpeningScope) {
  if (!row.query_system && row.system_query == null) return true;
  const receipt = systemQueryReceiptSchema.safeParse(row.system_query);
  const lineage = parseContextSourceRefs(row.assistant_source_refs) ?? [];
  return receipt.success && receipt.data.authorization.purpose === "system_record_lookup"
    && receipt.data.authorization.workspaceId === scope.workspaceId
    && receipt.data.authorization.principalId === scope.ownerUserId
    && receipt.data.privacyEpoch === Number(row.current_privacy_epoch)
    && receipt.data.results.every(result => result.sourceRefs.every(ref =>
      lineage.some(parent => parent.sourceId === ref.sourceId.toLowerCase() && parent.sourceVersion === ref.sourceVersion)));
}

/** Compatibility projection for callers that do not send or persist model context. */
export async function loadTutorHistory(sql: Sql, scope: OpeningScope, currentTurnId: string): Promise<HistoryTurn[]> {
  return (await loadTutorHistoryContext(sql, scope, currentTurnId)).history;
}
