import type { Sql, TransactionSql } from "postgres";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { createOpeningPrivacyRepository } from "./opening-privacy";

import {
  contextSourceRefsIncluded, isLineageUuid, lineageUuid, mergeContextSourceRefs, resolveMemoryDependencyStatus,
  parseContextMemoryDependencyIds, parseContextSourceRefs, turnContextSourceRefs, turnDirectSourcesVersioned,
  turnHasOwnedSession, turnHasStandaloneSession, turnLineageCourse, turnMemoryOnlyBackingIds,
  type ContextSourceRef, type FragmentFactory, type MemoryDependencyStatus,
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

function readSavedExchanges(sql: Db, scope: OpeningScope, currentTurnIds: readonly string[],
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
      SELECT current.id AS current_id, u.id, a.id AS assistant_id, u.created_at,
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
      CROSS JOIN LATERAL (SELECT ${turnContextSourceRefs(sql, "u")} AS user_refs,
        ${turnContextSourceRefs(sql, "a")} AS assistant_refs) refs
      WHERE current.id=ANY(${currentTurnIds}::uuid[]) AND current.role='user'
        AND current.workspace_id=${scope.workspaceId} AND c.workspace_id=${scope.workspaceId}
        AND c.owner_user_id=${scope.ownerUserId}
        AND (u.created_at, u.id) < (current.created_at, current.id) AND u.status='complete' AND a.status='complete'
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
    cutoff AS (
      SELECT p.created_at, p.id FROM evaluated p
      WHERE p.invalid IS TRUE OR p.assistant_direct_versioned IS NOT TRUE OR p.origin_allowed IS NOT TRUE
      ORDER BY p.created_at, p.id LIMIT 1
    )
    SELECT evaluated.* FROM evaluated
    WHERE NOT EXISTS (SELECT 1 FROM cutoff WHERE (evaluated.created_at, evaluated.id) >= (cutoff.created_at, cutoff.id))
    ${recordReferents ? sql`` : sql`UNION ALL
      SELECT evaluated.* FROM evaluated
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
  excluded: string[],
) {
  const lineage = rows.map(row => {
    const ids = row.assistant_source_refs === undefined ? [] : parseContextMemoryDependencyIds(row.assistant_source_refs);
    const backings = row.memory_backing_ids as string[][] | undefined;
    return { ids, backings, priorUse: row.prior_material_use === "practice" ? "practice" as const : "citation" as const };
  });
  const materialUse = rows[0]?.material_use === "practice" ? "practice" : "citation";
  const graphs = await Promise.all((["citation", "practice"] as const).map(async use => {
    const roots = [...new Set(lineage.flatMap(row => row.ids && row.backings && (row.priorUse === use || materialUse === use)
      ? [...row.ids, ...row.backings.flat()] : []))];
    return readMemoryDependencyStatus(sql, scope, roots, { excluded, materialUse: use });
  }));
  const graphFor = (use: "citation" | "practice") => graphs[use === "practice" ? 1 : 0]!;
  return lineage.map(({ ids, backings, priorUse }, index) => {
    const row = rows[index]!;
    if (ids === null || (row.user_source_refs !== undefined && parseContextSourceRefs(row.user_source_refs) === null)) return null;
    const own = backings ? resolveMemoryDependencyStatus(graphFor(priorUse), ids, backings, row.prior_course_id as string | null) : [];
    if (!own) return null;
    const inCourse = own.every(node => node.course_id === null || node.course_id === row.current_course_id);
    const current = inCourse && backings && materialUse !== priorUse
      ? resolveMemoryDependencyStatus(graphFor(materialUse), ids, backings, row.current_course_id as string | null) : own;
    return { ids: [...ids, ...(current ?? []).map(node => node.dep_id)], inScope: inCourse && current !== null,
      ownExpirations: own.flatMap(node => node.expires_at === null ? [] : [node.expires_at]),
      expirations: (current ?? []).flatMap(node => node.expires_at === null ? [] : [node.expires_at]) };
  });
}

export type HistoryAncestorAuthority = {
  courseId: string | null; materialUse: MaterialUse; memoryIds: string[]; backings: string[][]; expiresAt: number;
};

/** Collect direct ancestor authority without resolving memory edges yet. */
export async function readTutorHistoryAncestorAuthority(sql: Db, scope: OpeningScope, userTurnIds: readonly string[], rules?: {
  collectSourceIds?: Set<string>; collectCourseIds?: Set<string>; lockedSourceIds?: readonly string[];
}) {
  const authority = new Map<string, HistoryAncestorAuthority[] | null>(userTurnIds.map(id => [id, []]));
  if (!userTurnIds.length) return authority;
  const locked = rules?.lockedSourceIds && new Set(rules.lockedSourceIds);
  const rows = await readSavedExchanges(sql, scope, userTurnIds, "ancestors");
  for (const row of rows) {
    const entries = authority.get(row.current_id);
    if (!entries) continue;
    const assistantRefs = parseContextSourceRefs(row.assistant_source_refs);
    const userRefs = parseContextSourceRefs(row.user_source_refs);
    const memoryIds = parseContextMemoryDependencyIds(row.assistant_source_refs);
    const expiresAt = row.memory_temporary_expires_at == null ? Infinity : new Date(row.memory_temporary_expires_at).getTime();
    if (row.invalid || !row.assistant_direct_versioned || !row.origin_allowed || !memoryIds || !assistantRefs || !userRefs
      || !(expiresAt > Date.now())) {
      authority.set(row.current_id, null);
      continue;
    }
    const sources = new Set([...assistantRefs, ...userRefs].map(ref => ref.sourceId));
    for (const binding of historyCourseBindings(row)) {
      if (binding.courseId !== null) rules?.collectCourseIds?.add(binding.courseId);
      for (const id of binding.sourceIds) sources.add(id);
    }
    if (locked && [...sources].some(id => !locked.has(id))) {
      authority.set(row.current_id, null);
      continue;
    }
    for (const id of sources) rules?.collectSourceIds?.add(id);
    entries.push({ courseId: row.prior_course_id, materialUse: row.prior_material_use,
      memoryIds, backings: row.memory_backing_ids as string[][], expiresAt });
  }
  return authority;
}

export function historyAncestorMemoryIds(authority: HistoryAncestorAuthority) {
  return [...authority.memoryIds, ...authority.backings.flat()];
}

export function resolveHistoryAncestorExpiry(authority: HistoryAncestorAuthority[],
  graphFor: (materialUse: MaterialUse) => ReadonlyMap<string, MemoryDependencyStatus[]>,
  excludedId?: string,
) {
  let expiry = Infinity;
  for (const entry of authority) {
    const dependencies = resolveMemoryDependencyStatus(graphFor(entry.materialUse), entry.memoryIds, entry.backings, entry.courseId, excludedId);
    if (!dependencies) return -Infinity;
    expiry = Math.min(expiry, entry.expiresAt, ...dependencies.map(node =>
      node.expires_at === null ? Infinity : new Date(node.expires_at).getTime()));
  }
  return expiry;
}

/** Revalidate the saved conversation prefix before reusing its derivative. */
export async function readTutorHistoryAncestorStatus(sql: Db, scope: OpeningScope, currentTurnId: string, rules?: {
  collectSourceIds?: Set<string>; collectCourseIds?: Set<string>; lockedSourceIds?: readonly string[];
}) {
  const authority = (await readTutorHistoryAncestorAuthority(sql, scope, [currentTurnId], rules)).get(currentTurnId);
  if (!authority) return { valid: false, hasAncestors: true };
  const graph = new Map<MaterialUse, Map<string, MemoryDependencyStatus[]>>();
  for (const use of ["citation", "practice"] as const) {
    const ids = authority.filter(entry => entry.materialUse === use).flatMap(historyAncestorMemoryIds);
    graph.set(use, await readMemoryDependencyStatus(sql, scope, ids, { ...rules, materialUse: use }));
  }
  return { valid: resolveHistoryAncestorExpiry(authority, use => graph.get(use)!) > Date.now(),
    hasAncestors: authority.length > 0 };
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
  const resolved = await resolveExchangeMemories(sql, scope, rows, excluded);
  const nowMs = Date.now();
  let firstValid = 0;
  const expirations = rows.map((row, index) => {
    const ownExpirations = resolved[index]?.ownExpirations ?? [];
    const own = row.memory_temporary_expires_at == null ? ownExpirations : [...ownExpirations, row.memory_temporary_expires_at];
    const times = own.map(expiry => new Date(expiry).getTime());
    if (resolved[index] === null || times.some(time => !(time > nowMs))
      || (recordReferents && !recordReceiptValid(row, scope))) firstValid = index + 1;
    return times;
  });
  const selected = rows.flatMap((row, index) => index >= firstValid && row.current_allowed !== false && resolved[index]?.inScope
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
  const courseBindings = new Map<string, HistoryCourseBinding>();
  const memoryIdSet = new Set<string>();
  let newestRetained = rows.length;
  let earliestExpiry = Infinity;
  for (const { row, index, dependencies } of selected) {
    if (dependencies.expirations.some(expiry => !(new Date(expiry).getTime() > nowMs))) continue;
    const question = row.question ?? textById.get(String(row.id));
    const answer = recordReferents ? "" : (row.answer ?? textById.get(String(row.assistant_id)));
    if (typeof question !== "string" || typeof answer !== "string") {
      return { history: [], sourceRefs: [], ...(revokedDirectSourceIds.length ? { revokedDirectSourceIds } : {}) };
    }
    if (characters + question.length + answer.length > 12_000) break;
    newestRetained = Math.min(newestRetained, index);
    for (const expiry of expirations[index]!) earliestExpiry = Math.min(earliestExpiry, expiry);
    for (const expiry of dependencies.expirations) earliestExpiry = Math.min(earliestExpiry, new Date(expiry).getTime());
    // Record follow-ups inherit the user's referent, never prior assistant claims.
    if (recordReferents) history.unshift({ role: "user", text: question });
    else history.unshift({ role: "user", text: question }, { role: "assistant", text: answer });
    // For model history, every assistant source ID is already covered by a direct pin, ref or citation.
    sourceRefs.push(...(parseContextSourceRefs(row.user_source_refs) ?? []), ...(parseContextSourceRefs(row.assistant_source_refs) ?? []));
    if (!recordReferents) {
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
    for (const binding of historyCourseBindings(rows[index]!)) {
      const key = `${binding.courseId}:${binding.materialUse}`;
      const previous = courseBindings.get(key);
      if (previous) {
        previous.sourceIds = [...new Set([...previous.sourceIds, ...binding.sourceIds])].sort();
        previous.sourceRefs = mergeContextSourceRefs(previous.sourceRefs, binding.sourceRefs);
      } else courseBindings.set(key, binding);
    }
  }
  const memoryIds = [...memoryIdSet].sort();
  return {
    history,
    sourceRefs: mergeContextSourceRefs(sourceRefs),
    ...(courseBindings.size ? { historyCourseBindings: [...courseBindings.values()] } : {}),
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
