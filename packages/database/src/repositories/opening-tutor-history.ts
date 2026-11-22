import type { Sql, TransactionSql } from "postgres";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { createOpeningPrivacyRepository } from "./opening-privacy";

import {
  contextSourceRefsIncluded, isLineageUuid, lineageUuid, mergeContextSourceRefs, resolveMemoryDependencyStatus,
  parseContextMemoryDependencyIds, parseContextSourceRefs, turnContextSourceRefs, turnDirectSourcesVersioned,
  turnHasStandaloneSession, turnLineageCourse, turnMemoryOnlyBackingIds,
  type ContextSourceRef, type FragmentFactory,
} from "./opening-context-provenance";
import { readMemoryDependencyStatus, sourceMaterialsActive } from "./opening-memory-admission";

type HistoryTurn = { role: "user" | "assistant"; text: string };
type Db = Sql | TransactionSql;
type MaterialUse = "citation" | "practice";
export type HistoryCourseBinding = {
  courseId: string | null; materialUse: MaterialUse; sourceIds: string[]; sourceRefs: ContextSourceRef[];
};
export type TutorHistoryPurpose = "model" | "record_referents";
export type TutorHistoryContext = {
  history: HistoryTurn[];
  sourceRefs: ContextSourceRef[];
  memoryIds?: string[];
  historyCourseBindings?: HistoryCourseBinding[];
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

function readSavedExchanges(sql: Db, scope: OpeningScope, currentTurnId: string,
  purpose: TutorHistoryPurpose | "ancestors", excludedSourceIds: string[] = [],
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
  return sql`
    WITH prior AS MATERIALIZED (
      SELECT u.id, a.id AS assistant_id, u.created_at,
        a.query_system, a.system_query, w.privacy_epoch AS current_privacy_epoch,
        refs.user_refs AS user_source_refs, refs.assistant_refs AS assistant_source_refs, a.citations AS assistant_citations,
        ${priorCourse()} AS prior_course_id, ${currentCourse()} AS current_course_id,
        ${currentUse()} AS material_use, ${priorUse()} AS prior_material_use,
        ${recordReferents ? sql`true` : sql`cardinality(a.source_ids) = 0 OR (
          jsonb_typeof(refs.assistant_refs) = 'array' AND jsonb_typeof(a.citations) = 'array'
          AND ${turnDirectSourcesVersioned(sql, () => sql`a.source_ids`, () => sql`refs.assistant_refs`, () => sql`a.citations`)}
        )`} AS assistant_direct_versioned,
        ${recordReferents ? sql`` : sql`${assistantCourse()} AS assistant_course_id, ${assistantUse()} AS assistant_material_use,
          ${directSourceIds(sql, () => sql`u.source_ids`, () => sql`refs.user_refs`, () => sql`u.citations`)} AS user_direct_ids,
          ${directSourceIds(sql, () => sql`a.source_ids`, () => sql`refs.assistant_refs`, () => sql`a.citations`)} AS assistant_direct_ids,`}
        CASE WHEN a.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
          THEN ${turnMemoryOnlyBackingIds(sql, () => sql`a.context_source_refs`, priorCourse, standaloneSessions, scope)}
          ELSE '[]'::jsonb END AS memory_backing_ids,
        COALESCE(a.context_source_refs @? '$[*].memoryDependencyIds[*]' OR
          a.context_source_refs @> '[{"memoryOnly":true}]'::jsonb, false) AS memory_bearing,
        NOT (${contextSourceRefsIncluded(sql, scope.workspaceId, () => sql`refs.user_refs || refs.assistant_refs`,
          false, true, () => sql`u.source_ids || a.source_ids`, citations)}) AS invalid
      FROM opening_turns current
      JOIN opening_conversations c ON c.id=current.conversation_id
      JOIN workspaces w ON w.id=c.workspace_id
      JOIN opening_tutor_jobs j ON j.conversation_id=c.id AND j.workspace_id=c.workspace_id
      JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=c.workspace_id AND u.conversation_id=c.id AND u.role='user'
      JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=c.workspace_id AND a.conversation_id=c.id AND a.role='assistant'
      CROSS JOIN LATERAL (SELECT ${turnContextSourceRefs(sql, "u")} AS user_refs,
        ${turnContextSourceRefs(sql, "a")} AS assistant_refs) refs
      WHERE current.id=${currentTurnId} AND current.role='user'
        AND current.workspace_id=${scope.workspaceId} AND c.workspace_id=${scope.workspaceId}
        AND c.owner_user_id=${scope.ownerUserId}
        AND u.created_at < current.created_at AND u.status='complete' AND a.status='complete'
        -- Query snapshots are separate authority records, including legacy imported receipts.
        -- Never promote their text into a later ordinary model conversation.
        AND (${recordReferents} OR (NOT u.query_system AND NOT a.query_system AND a.system_query IS NULL))
        ${ancestors ? sql`` : sql`AND NOT (current.source_ids && ${excludedSourceIds}::uuid[])`}
    ), evaluated AS MATERIALIZED (
      SELECT prior.*,
        ${recordReferents ? sql`true` : sql`${allowed(() => sql`user_direct_ids`, () => sql`prior_course_id`, () => sql`prior_material_use`)}
          AND ${allowed(() => sql`assistant_direct_ids`, () => sql`assistant_course_id`, () => sql`assistant_material_use`)}`} AS origin_allowed,
        ${recordReferents || ancestors ? sql`true` : sql`${allowed(() => sql`user_direct_ids`, () => sql`current_course_id`, () => sql`material_use`)}
          AND ${allowed(() => sql`assistant_direct_ids`, () => sql`current_course_id`, () => sql`material_use`)}`} AS current_allowed
      FROM prior
    )
    ${ancestors ? sql`SELECT * FROM evaluated` : sql`,
    ranked AS (
      SELECT evaluated.*, count(*) FILTER (WHERE NOT memory_bearing) OVER exchange_order AS ordinary_rank
      FROM evaluated WHERE (current_allowed OR memory_bearing)
        -- Current scope can skip an exchange. Only lost origin authority cuts off its descendants.
        AND created_at < (SELECT COALESCE(min(p.created_at), 'infinity'::timestamptz)
          FROM evaluated p WHERE p.invalid IS TRUE OR p.assistant_direct_versioned IS NOT TRUE OR p.origin_allowed IS NOT TRUE)
      WINDOW exchange_order AS (ORDER BY created_at DESC, id DESC)
    )
    SELECT * FROM ranked WHERE (memory_bearing OR ordinary_rank <= 20)
      ${recordReferents ? sql`AND NOT EXISTS (SELECT 1 FROM evaluated WHERE invalid)` : sql``}
    ${recordReferents ? sql`` : sql`UNION ALL
      SELECT evaluated.*, NULL::bigint AS ordinary_rank FROM evaluated
      WHERE NOT origin_allowed AND NOT invalid AND cardinality(user_direct_ids || assistant_direct_ids) > 0`}
    ORDER BY created_at DESC, id DESC`}
  `;
}

type HistoryRows = readonly Awaited<ReturnType<typeof readSavedExchanges>>[number][];

function historyCourseBindings(row: HistoryRows[number]): HistoryCourseBinding[] {
  if (!row.user_direct_ids || !row.assistant_direct_ids) return [];
  const bindings: HistoryCourseBinding[] = [
    { courseId: row.prior_course_id, materialUse: row.prior_material_use, sourceIds: [...new Set<string>(row.user_direct_ids)].sort(),
      sourceRefs: (parseContextSourceRefs(row.user_source_refs) ?? []).filter(ref => ref.memoryOnly !== true) },
    { courseId: row.assistant_course_id, materialUse: row.assistant_material_use, sourceIds: [...new Set<string>(row.assistant_direct_ids)].sort(),
      sourceRefs: mergeContextSourceRefs((parseContextSourceRefs(row.assistant_source_refs) ?? []).filter(ref => ref.memoryOnly !== true),
        (row.assistant_citations as ContextSourceRef[]).map(({ sourceId, sourceVersion }) => ({ sourceId, sourceVersion }))) },
  ];
  return bindings.filter(binding => binding.courseId !== null || binding.sourceIds.length > 0);
}

async function resolveExchangeMemories(sql: Db, scope: OpeningScope, rows: HistoryRows,
  rules: { excluded?: string[]; collectSourceIds?: Set<string>; collectCourseIds?: Set<string>; lockedSourceIds?: readonly string[] },
  checkCurrentScope: boolean,
) {
  const lineage = rows.map(row => {
    const ids = row.assistant_source_refs === undefined ? [] : parseContextMemoryDependencyIds(row.assistant_source_refs);
    const backings = row.memory_backing_ids as string[][] | undefined;
    return { ids, backings, priorUse: row.prior_material_use === "practice" ? "practice" as const : "citation" as const };
  });
  if (lineage.some(row => row.ids === null)) return null;
  const materialUse = rows[0]?.material_use === "practice" ? "practice" : "citation";
  const graphs = await Promise.all((["citation", "practice"] as const).map(async use => {
    const roots = [...new Set(lineage.flatMap(row => row.backings && (row.priorUse === use || (checkCurrentScope && materialUse === use))
      ? [...row.ids!, ...row.backings.flat()] : []))];
    return readMemoryDependencyStatus(sql, scope, roots, { ...rules, materialUse: use });
  }));
  const graphFor = (use: "citation" | "practice") => graphs[use === "practice" ? 1 : 0]!;
  return lineage.map(({ ids, backings, priorUse }, index) => {
    const row = rows[index]!;
    const own = backings ? resolveMemoryDependencyStatus(graphFor(priorUse), ids!, backings, row.prior_course_id as string | null) : [];
    if (!own) return null;
    const inCourse = !checkCurrentScope || own.every(node => node.course_id === null || node.course_id === row.current_course_id);
    const current = checkCurrentScope && inCourse && backings && materialUse !== priorUse
      ? resolveMemoryDependencyStatus(graphFor(materialUse), ids!, backings, row.current_course_id as string | null) : own;
    return { ids: [...ids!, ...(current ?? []).map(node => node.dep_id)], inScope: inCourse && current !== null,
      ownExpirations: own.flatMap(node => node.expires_at === null ? [] : [node.expires_at]),
      expirations: (current ?? []).flatMap(node => node.expires_at === null ? [] : [node.expires_at]) };
  });
}

/** Validate model ancestors using the saved origins before metadata can consume an answer. */
export async function readTutorHistoryAncestors(sql: Db, scope: OpeningScope, currentTurnId: string, rules: {
  collectSourceIds: Set<string>; collectCourseIds: Set<string>; lockedSourceIds?: readonly string[];
}): Promise<boolean> {
  const rows = await readSavedExchanges(sql, scope, currentTurnId, "ancestors");
  if (rows.some(row => row.invalid || !row.assistant_direct_versioned || !row.origin_allowed)) return false;
  for (const row of rows) {
    for (const binding of historyCourseBindings(row)) {
      if (binding.courseId !== null) rules.collectCourseIds.add(binding.courseId);
      for (const id of binding.sourceIds) rules.collectSourceIds.add(id);
    }
    for (const ref of parseContextSourceRefs(row.assistant_source_refs) ?? []) rules.collectSourceIds.add(ref.sourceId);
  }
  const resolved = await resolveExchangeMemories(sql, scope, rows, rules, false);
  const now = Date.now();
  return resolved !== null && resolved.every(item => item !== null
    && item.ownExpirations.every(expiry => new Date(expiry).getTime() > now));
}

/** Keep the independent exchanges before the first invalid saved origin. */
export async function loadTutorHistoryContext(sql: Sql, scope: OpeningScope, currentTurnId: string, purpose: TutorHistoryPurpose = "model"): Promise<TutorHistoryContext> {
  const recordReferents = purpose === "record_referents";
  const excluded = await createOpeningPrivacyRepository(sql).listExcludedSourceIds(scope);
  const exchanges = await readSavedExchanges(sql, scope, currentTurnId, purpose, excluded);
  const revokedDirectSourceIds = [...new Set<string>(exchanges.flatMap(row => row.origin_allowed === false
    ? [...row.user_direct_ids, ...row.assistant_direct_ids].filter(isLineageUuid) : []))].sort();
  const rows = exchanges.filter(row => row.origin_allowed !== false);
  const empty = (): TutorHistoryContext => ({ history: [], sourceRefs: [],
    ...(revokedDirectSourceIds.length ? { revokedDirectSourceIds } : {}) });
  const resolved = await resolveExchangeMemories(sql, scope, rows, { excluded }, true);
  if (!resolved || resolved.some(item => item === null)) return empty();
  const selected = rows.flatMap((row, index) => row.current_allowed !== false && resolved[index]!.inScope
    ? [{ row, dependencies: resolved[index]! }] : []).slice(0, 20);
  const textIds = selected.flatMap(({ row }) => typeof row.id === "string"
    ? (recordReferents ? [row.id] : [row.id, String(row.assistant_id)]) : []);
  const texts = textIds.length ? await sql<{ id: string; text: string }[]>`
    SELECT id, left(text, 12001) AS text FROM opening_turns
    WHERE workspace_id=${scope.workspaceId} AND id=ANY(${textIds}::uuid[]) AND status='complete'` : [];
  const textById = new Map(texts.map(row => [row.id, row.text]));
  const nowMs = Date.now();
  if (resolved.some(item => item!.ownExpirations.some(expiry => !(new Date(expiry).getTime() > nowMs)))) {
    return empty();
  }
  const history: HistoryTurn[] = [];
  let characters = 0;
  const sourceRefs: ContextSourceRef[] = [];
  const courseBindings = new Map<string, HistoryCourseBinding>();
  const memoryIdSet = new Set<string>();
  let earliestTempExpiresAtMs: number | undefined;
  let earliestTempExpiresAtIso: string | undefined;
  for (const { row, dependencies } of selected) {
    if (dependencies.expirations.some(expiry => !(new Date(expiry).getTime() > nowMs))) continue;
    if (recordReferents && (row.query_system || row.system_query != null)) {
      const receipt = systemQueryReceiptSchema.safeParse(row.system_query);
      const lineage = parseContextSourceRefs(row.assistant_source_refs) ?? [];
      if (!receipt.success || receipt.data.authorization.purpose !== "system_record_lookup"
        || receipt.data.authorization.workspaceId !== scope.workspaceId
        || receipt.data.authorization.principalId !== scope.ownerUserId
        || receipt.data.privacyEpoch !== Number(row.current_privacy_epoch)
        || receipt.data.results.some(result => result.sourceRefs.some(ref =>
          !lineage.some(parent => parent.sourceId === ref.sourceId.toLowerCase() && parent.sourceVersion === ref.sourceVersion)))) {
        return empty();
      }
    }
    const question = row.question ?? textById.get(String(row.id));
    const answer = recordReferents ? "" : (row.answer ?? textById.get(String(row.assistant_id)));
    if (typeof question !== "string" || typeof answer !== "string") return empty();
    if (characters + question.length + answer.length > 12_000) break;
    const expirations = [...dependencies.expirations, ...(row.memory_temporary_expires_at == null
      ? [] : [row.memory_temporary_expires_at as Date | string])];
    for (const expiry of expirations) {
      const parsedDate = new Date(expiry);
      const parsedMs = parsedDate.getTime();
      if (Number.isNaN(parsedMs) || parsedMs <= nowMs) return empty();
      if (earliestTempExpiresAtMs === undefined || parsedMs < earliestTempExpiresAtMs) {
        earliestTempExpiresAtMs = parsedMs;
        earliestTempExpiresAtIso = parsedDate.toISOString();
      }
    }
    // Record follow-ups inherit the user's referent, never prior assistant claims.
    if (recordReferents) history.unshift({ role: "user", text: question });
    else history.unshift({ role: "user", text: question }, { role: "assistant", text: answer });
    // For model history, every assistant source ID is already covered by a direct pin, ref or citation.
    sourceRefs.push(...(parseContextSourceRefs(row.user_source_refs) ?? []), ...(parseContextSourceRefs(row.assistant_source_refs) ?? []));
    if (!recordReferents) {
      for (const binding of historyCourseBindings(row)) {
        const key = `${binding.courseId}:${binding.materialUse}`;
        const previous = courseBindings.get(key);
        if (previous) {
          previous.sourceIds = [...new Set([...previous.sourceIds, ...binding.sourceIds])].sort();
          previous.sourceRefs = mergeContextSourceRefs(previous.sourceRefs, binding.sourceRefs);
        } else courseBindings.set(key, binding);
      }
      // The SQL admission above requires each citation to name an available source and version.
      for (const { sourceId, sourceVersion } of (row.assistant_citations as ContextSourceRef[] | undefined) ?? []) {
        sourceRefs.push({ sourceId, sourceVersion });
      }
    }
    const ancestorMemoryIds = parseContextMemoryDependencyIds([{ memoryDependencyIds: row.memory_dependency_ids }]) ?? [];
    for (const memoryId of [...dependencies.ids, ...ancestorMemoryIds]) memoryIdSet.add(memoryId);
    characters += question.length + answer.length;
  }
  const memoryIds = [...memoryIdSet].sort();
  return {
    history,
    sourceRefs: mergeContextSourceRefs(sourceRefs),
    ...(courseBindings.size ? { historyCourseBindings: [...courseBindings.values()] } : {}),
    ...(revokedDirectSourceIds.length ? { revokedDirectSourceIds } : {}),
    ...(memoryIds.length ? { memoryIds } : {}),
    ...(earliestTempExpiresAtIso ? { temporaryMemoryExpiresAt: earliestTempExpiresAtIso } : {}),
  };
}

/** Compatibility projection for callers that do not send or persist model context. */
export async function loadTutorHistory(sql: Sql, scope: OpeningScope, currentTurnId: string): Promise<HistoryTurn[]> {
  return (await loadTutorHistoryContext(sql, scope, currentTurnId)).history;
}
