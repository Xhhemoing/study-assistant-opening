import type { TransactionSql } from "postgres";
import { openingAdaptivePrefsSchema, type Scope, type SystemQueryRequest } from "@aistudy/contracts";
import type { OpeningSystemQueryDraft } from "./opening-system-query";
import { cardReadable, notePublicationCardIds } from "./card-sources";

import { isVerifiedSnippetLineage, memoryOnlyRefSourceIds, noteContextSourceRefsIncluded, noteOriginTurnIds, openingSnippetOriginsAvailable, parseNoteContextProvenanceRefs } from "./opening-context-provenance";
import { openingCredentialMemoriesAvailable } from "./opening-memory-admission";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";
import { readProjectedOpeningAdaptivePrefs } from "./opening-learning-goal-bridge";

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
export type RecordNoteLineage = { memoryIds: string[]; originTurnIds: string[] };

type RecordSources = RecordNoteLineage & { refs: OpeningSystemQueryDraft["sourceRefs"] };

async function readRecordNoteSources(tx: TransactionSql, scope: Scope, row: Record<string, unknown>,
  canCollectLineage: boolean): Promise<RecordSources | null> {
  if (!row.has_note_provenance && row.snippet_origin === false) return { refs: [], memoryIds: [], originTurnIds: [] };
  if (!Array.isArray(row.context_source_refs)) return null;
  if (row.snippet_origin !== false && !row.context_source_refs.some(isVerifiedSnippetLineage)) return null;
  const refs = parseNoteContextProvenanceRefs(row.context_source_refs);
  if (!refs) return null;
  const memoryIds = refs.find(ref => "memoryDependencyIds" in ref)?.memoryDependencyIds ?? [];
  const originTurnIds = noteOriginTurnIds(row.context_source_refs);
  if ((memoryIds.length || originTurnIds.length) && !canCollectLineage) return null;
  if (!await openingSnippetOriginsAvailable(tx, scope, originTurnIds)
    || !await openingCredentialMemoriesAvailable(tx, scope, memoryIds, memoryOnlyRefSourceIds(refs))) return null;
  return { memoryIds, originTurnIds,
    refs: refs.flatMap(ref => "sourceId" in ref ? [{ sourceId: ref.sourceId, sourceVersion: ref.sourceVersion }] : []) };
}

const candidateBatchSize = (offset: number, limit: number) => Math.min(256, Math.max(32, offset + limit + 1));

export function publicSystemQueryOffset(offset: number): number | null {
  return offset <= 1000 ? offset : null;
}

async function readAdmittedPage<Row>(
  out: OpeningSystemQueryDraft, { offset, limit }: { offset: number; limit: number }, signal: AbortSignal,
  readBatch: (after: Row | undefined, batchSize: number) => PromiseLike<readonly Row[]>,
  prepareBatch: (batch: readonly Row[]) => Promise<(row: Row) => Promise<RecordSources | null>>,
) {
  const batchSize = candidateBatchSize(offset, limit);
  let after: Row | undefined;
  let admitted = 0;
  const page: { row: Row; sources: RecordSources }[] = [];
  for (;;) {
    if (signal.aborted) throw new Error("system query cancelled");
    const batch = await readBatch(after, batchSize);
    if (!batch.length) return page;
    const admit = await prepareBatch(batch);
    for (const row of batch) {
      if (signal.aborted) throw new Error("system query cancelled");
      const sources = await admit(row);
      if (!sources) continue;
      admitted += 1;
      if (admitted <= offset) continue;
      if (page.length === limit) {
        out.status = "partial";
        out.reason = "truncated";
        out.nextOffset = publicSystemQueryOffset(offset + limit);
        return page;
      }
      page.push({ row, sources });
    }
    if (batch.length < batchSize) return page;
    after = batch[batch.length - 1];
  }
}

function collectRecordSources(out: OpeningSystemQueryDraft, sources: RecordSources,
  collectLineage?: (lineage: RecordNoteLineage) => void) {
  const { refs, memoryIds, originTurnIds } = sources;
  out.sourceRefs.push(...refs);
  if (memoryIds.length || originTurnIds.length) collectLineage?.({ memoryIds, originTurnIds });
}

/** Metadata only: never releases note bodies, card answers or exam solutions. */
export async function readSystemRecordQuery(tx: TransactionSql, scope: Scope,
  request: Extract<SystemQueryRequest, { name: "notes" | "cards" | "exam_sprint" }>, out: OpeningSystemQueryDraft, signal: AbortSignal,
  collectLineage?: (lineage: RecordNoteLineage) => void) {
  if (request.name === "notes") {
    const a = request.arguments, pattern = `%${(a.query ?? "").replace(/[\\%_]/g, "\\$&")}%`;
    const page = await readAdmittedPage(out, a, signal, (after: Record<string, unknown> | undefined, batchSize) => tx`SELECT
        d.id,d.title,d.current_revision_number,d.updated_at,d.updated_at::text AS cursor_updated_at,np.context_source_refs,
        np.document_id IS NOT NULL AS has_note_provenance,
        CASE WHEN origin.document_id IS NOT NULL THEN origin.reason IS NOT DISTINCT FROM 'save-opening-snippet' END AS snippet_origin
      FROM library_documents d LEFT JOIN opening_note_provenance np ON np.document_id=d.id
      LEFT JOIN library_revisions origin ON origin.document_id=d.id AND origin.workspace_id=d.workspace_id AND origin.revision_number=1
      WHERE d.workspace_id=${scope.workspaceId} AND d.deleted_at IS NULL AND d.title ILIKE ${pattern}
        AND (np.document_id IS NULL OR (np.workspace_id=${scope.workspaceId}
          AND ${noteContextSourceRefsIncluded(tx, scope.workspaceId, () => tx`np.context_source_refs`, false)}))
        ${after ? tx`AND (d.updated_at < ${String(after.cursor_updated_at)}::timestamptz
          OR (d.updated_at = ${String(after.cursor_updated_at)}::timestamptz AND d.id > ${String(after.id)}::uuid))` : tx``}
      ORDER BY d.updated_at DESC,d.id LIMIT ${batchSize}`,
    async () => row => readRecordNoteSources(tx, scope, row, Boolean(collectLineage)));
    for (const { row, sources } of page) {
      collectRecordSources(out, sources, collectLineage);
      out.evidence.push({ id: `note:${row.id}`, kind: "note", title: String(row.title).slice(0, 200), recordId: String(row.id),
        href: `/opening/library/${row.id}`, revision: String(row.current_revision_number) });
      out.data.push({ id: row.id, title: String(row.title).slice(0, 240), revision: Number(row.current_revision_number), updatedAt: iso(row.updated_at), contentWithheld: true,
        summary: `笔记 ${String(row.title).slice(0, 240)}；版本 ${row.current_revision_number}；更新时间 ${iso(row.updated_at)}；本轮仅查询元数据，正文未释放` });
    }
  } else if (request.name === "cards") {
    const a = request.arguments;
    const page = await readAdmittedPage(out, a, signal, (after: Record<string, unknown> | undefined, batchSize) => tx`SELECT
        c.id,c.content_version,c.course_id,c.source_ids,s.due_at,s.due_at::text AS cursor_due_at
      FROM cards c LEFT JOIN card_review_states s ON s.card_id=c.id AND s.workspace_id=c.workspace_id AND s.owner_user_id=${scope.ownerUserId}
      WHERE c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} AND NOT c.archived
        AND ${a.courseId ? tx`c.course_id=${a.courseId}` : tx`TRUE`} AND ${cardReadable(tx, scope.workspaceId)}
        ${!after ? tx`` : after.cursor_due_at == null ? tx`AND s.due_at IS NULL AND c.id > ${String(after.id)}::uuid`
          : tx`AND (s.due_at IS NULL OR (s.due_at,c.id) > (${String(after.cursor_due_at)}::timestamptz,${String(after.id)}::uuid))`}
      ORDER BY s.due_at NULLS LAST,c.id LIMIT ${batchSize}`, async batch => {
      const batchIds = batch.map(row => String(row.id));
      const documents = await tx`WITH pub_links AS MATERIALIZED (
          SELECT np.document_id, pub.card_id
          FROM (
            SELECT np.document_id, np.context_source_refs
            FROM opening_note_provenance np
            WHERE np.workspace_id=${scope.workspaceId} AND np.context_source_refs IS NOT NULL
              AND COALESCE(jsonb_path_exists(np.context_source_refs, '$.**.publicationCardIds'), false)
          ) np
          CROSS JOIN LATERAL ${notePublicationCardIds(tx, () => tx`np.context_source_refs`)} AS pub(card_id)
        ),
        card_doc_links AS MATERIALIZED (
          SELECT DISTINCT c.id AS card_id, linked.id AS document_id
          FROM cards c
          CROSS JOIN LATERAL (
            SELECT c.source_document_id AS id WHERE c.source_document_id IS NOT NULL
            UNION SELECT pl.document_id FROM pub_links pl WHERE pl.card_id=c.id::text
            UNION SELECT linked.id FROM opening_learning_observations o
              LEFT JOIN opening_teaching_activity_specs spec ON spec.activity_id=o.activity_id AND spec.workspace_id=o.workspace_id
              LEFT JOIN opening_teaching_units unit ON unit.id=spec.teaching_unit_id AND unit.workspace_id=o.workspace_id
              LEFT JOIN opening_learning_item_versions item ON item.id=o.item_version_id AND item.workspace_id=o.workspace_id
              LEFT JOIN library_revisions revision ON revision.id=item.teaching_revision_id AND revision.workspace_id=o.workspace_id
              CROSS JOIN LATERAL unnest(ARRAY[spec.document_id,unit.document_id,revision.document_id]) linked(id)
              WHERE o.id=c.origin_observation_root_id AND o.workspace_id=c.workspace_id AND o.owner_user_id=c.owner_user_id
                AND linked.id IS NOT NULL
          ) linked
          WHERE c.id=ANY(${batchIds}::uuid[]) AND c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
        ),
        admitted_docs AS MATERIALIZED (
          SELECT doc.document_id,
            d.id IS NOT NULL AND d.deleted_at IS NULL AND (np.document_id IS NULL OR
              (np.workspace_id=${scope.workspaceId} AND ${noteContextSourceRefsIncluded(tx, scope.workspaceId,
                () => tx`np.context_source_refs`, false)})) AS admitted,
            np.context_source_refs, np.document_id IS NOT NULL AS has_note_provenance,
            CASE WHEN origin.document_id IS NOT NULL THEN origin.reason IS NOT DISTINCT FROM 'save-opening-snippet' END AS snippet_origin
          FROM (SELECT DISTINCT document_id FROM card_doc_links) doc
          LEFT JOIN library_documents d ON d.id=doc.document_id AND d.workspace_id=${scope.workspaceId}
          LEFT JOIN opening_note_provenance np ON np.document_id=doc.document_id
          LEFT JOIN library_revisions origin ON origin.document_id=doc.document_id AND origin.workspace_id=${scope.workspaceId} AND origin.revision_number=1
        )
        SELECT l.card_id, l.document_id, a.admitted, a.context_source_refs, a.has_note_provenance, a.snippet_origin
        FROM card_doc_links l
        JOIN admitted_docs a ON a.document_id=l.document_id
        ORDER BY l.card_id, l.document_id`;
      const byCardId = new Map<string, Record<string, unknown>[]>();
      for (const document of documents) {
        const cardId = String(document.card_id);
        const group = byCardId.get(cardId);
        if (group) group.push(document);
        else byCardId.set(cardId, [document]);
      }
      const documentCache = new Map<string, RecordSources | null>();
      return async row => {
        const sources: RecordSources = { refs: [], memoryIds: [], originTurnIds: [] };
        for (const document of byCardId.get(String(row.id)) ?? []) {
          if (!document.admitted) return null;
          const docKey = String(document.document_id);
          let group = documentCache.get(docKey);
          if (group === undefined && !documentCache.has(docKey)) {
            group = await readRecordNoteSources(tx, scope, document, Boolean(collectLineage));
            documentCache.set(docKey, group);
          }
          if (!group) return null;
          sources.refs.push(...group.refs);
          sources.memoryIds.push(...group.memoryIds);
          sources.originTurnIds.push(...group.originTurnIds);
        }
        return sources;
      };
    });
    const allSourceIds = [...new Set(page.flatMap(({ row }) => row.source_ids as string[]))];
    const sourceVersions = new Map((allSourceIds.length ? await tx`SELECT id AS "sourceId",version AS "sourceVersion" FROM opening_sources
      WHERE workspace_id=${scope.workspaceId} AND id=ANY(${allSourceIds}::uuid[])` : [])
      .map(ref => [String(ref.sourceId), Number(ref.sourceVersion)]));
    for (const { row, sources } of page) {
      // Cards retain source identities; capture each current source version as consumed metadata.
      for (const sourceId of row.source_ids as string[]) {
        const sourceVersion = sourceVersions.get(sourceId);
        if (sourceVersion !== undefined) out.sourceRefs.push({ sourceId, sourceVersion });
      }
      collectRecordSources(out, sources, collectLineage);
      out.evidence.push({ id: `card:${row.id}`, kind: "card", title: "复习卡片", recordId: String(row.id), href: "/opening/cards", revision: String(row.content_version) });
      out.data.push({ id: row.id, contentVersion: Number(row.content_version), courseId: row.course_id, dueAt: row.due_at ? iso(row.due_at) : null, answerWithheld: true,
        summary: `卡片 ${row.id}；内容版本 ${row.content_version}；复习到期 ${row.due_at ? iso(row.due_at) : "未知"}；复习安排不是掌握证明，答案未释放` });
    }
  } else {
    const courses = await tx`SELECT s.id,s.course_id,s.updated_at,c.title,p.adaptive_planning,
      (SELECT count(*) FROM opening_learning_attempts attempt JOIN opening_teaching_activities activity ON activity.id=attempt.activity_id
        WHERE activity.workspace_id=s.workspace_id AND activity.owner_user_id=s.owner_user_id AND activity.course_id=s.course_id
          AND activity.create_intent->>'kind'='course_exam'
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions exclusion WHERE exclusion.workspace_id=s.workspace_id AND exclusion.source_id=ANY(activity.source_ids))) AS attempt_count,
      (SELECT count(*) FROM opening_learning_attempts attempt JOIN opening_teaching_activities activity ON activity.id=attempt.activity_id
        WHERE activity.workspace_id=s.workspace_id AND activity.owner_user_id=s.owner_user_id AND activity.course_id=s.course_id
          AND activity.create_intent->>'kind'='course_exam' AND attempt.submitted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions exclusion WHERE exclusion.workspace_id=s.workspace_id AND exclusion.source_id=ANY(activity.source_ids))) AS completed_count
      FROM opening_exam_sprints s JOIN courses c ON c.id=s.course_id AND c.workspace_id=s.workspace_id AND c.archived_at IS NULL
      LEFT JOIN workspace_preferences p ON p.workspace_id=s.workspace_id
      WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
      ORDER BY s.updated_at DESC,s.id LIMIT 10`;
    if (courses.length > 9) { out.status = "partial"; out.reason = "truncated"; }
    const prefs = openingAdaptivePrefsSchema.safeParse(await readProjectedOpeningAdaptivePrefs(tx, scope));
    for (const item of courses.slice(0, 9)) {
      const examDate = prefs.success ? prefs.data.courseGoals[String(item.course_id)]?.examDate ?? null : null;
      out.data.push({ id: item.id, updatedAt: iso(item.updated_at), examDate, attemptCount: Number(item.attempt_count),
        completedCount: Number(item.completed_count), basis: "stored_snapshot",
        summary: `${String(item.title).slice(0, 240)}考前练习；目标日期 ${examDate ?? "未设置"}；已开始 ${item.attempt_count} 次作答，已提交 ${item.completed_count} 次。成绩与错因可在课程练习中查看。` });
      out.evidence.push({ id: `exam_sprint:${item.id}`, kind: "exam_sprint", title: "课程考前练习", recordId: String(item.id),
        href: `/opening/courses/${item.course_id}/exam`, revision: iso(item.updated_at) });
    }
    const [row] = await tx`SELECT id,pack_snapshot,state,updated_at FROM opening_exam_sprints WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id IS NULL`;
    if (!row) return;
    const { state } = parseExamSprintSnapshot(row.pack_snapshot, row.state);
    // The snapshot can contain source-dependent answers. Only counts and dates are released here.
    out.status = "partial"; out.reason = "not_available";
    out.data.push({ id: row.id, updatedAt: iso(row.updated_at), examDate: state.examDate, attemptCount: state.attempts.length,
      completedCount: state.attempts.filter(attempt => attempt.answeredAt !== null).length, basis: "stored_snapshot",
      summary: `冲刺记录更新于 ${iso(row.updated_at)}；考试日期 ${state.examDate ?? "未设置"}；共呈现 ${state.attempts.length} 次作答，其中 ${state.attempts.filter(attempt => attempt.answeredAt !== null).length} 次已提交；这是已保存快照计数，未重验各题学习资格，不代表已掌握` });
    out.evidence.push({ id: `exam_sprint:${row.id}`, kind: "exam_sprint", title: "考前冲刺记录", recordId: String(row.id), href: "/opening/sprint", revision: iso(row.updated_at) });
  }
}
