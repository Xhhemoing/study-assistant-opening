import type { TransactionSql } from "postgres";
import { openingAdaptivePrefsSchema, type Scope, type SystemQueryRequest } from "@aistudy/contracts";
import type { OpeningSystemQueryDraft } from "./opening-system-query";
import { cardReadable } from "./card-sources";
import { contextSourceRefsIncluded, parseContextSourceRefs } from "./opening-context-provenance";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";
import { readProjectedOpeningAdaptivePrefs } from "./opening-learning-goal-bridge";

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
/** Metadata only: never releases note bodies, card answers or exam solutions. */
export async function readSystemRecordQuery(tx: TransactionSql, scope: Scope,
  request: Extract<SystemQueryRequest, { name: "notes" | "cards" | "exam_sprint" }>, out: OpeningSystemQueryDraft) {
  if (request.name === "notes") {
    const a = request.arguments, pattern = `%${(a.query ?? "").replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await tx`SELECT d.id,d.title,d.current_revision_number,d.updated_at,np.context_source_refs
      FROM library_documents d LEFT JOIN opening_note_provenance np ON np.document_id=d.id
      WHERE d.workspace_id=${scope.workspaceId} AND d.deleted_at IS NULL AND d.title ILIKE ${pattern}
        AND (np.document_id IS NULL OR (np.workspace_id=${scope.workspaceId}
          AND ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`np.context_source_refs`, false)}))
      ORDER BY d.updated_at DESC,d.id LIMIT ${a.limit + 1} OFFSET ${a.offset}`;
    if (rows.length > a.limit) { out.status = "partial"; out.reason = "truncated"; out.nextOffset = a.offset + a.limit; }
    out.data = rows.slice(0, a.limit).map(row => {
      out.sourceRefs.push(...(parseContextSourceRefs(row.context_source_refs) ?? []));
      out.evidence.push({ id: `note:${row.id}`, kind: "note", title: String(row.title).slice(0, 200), recordId: String(row.id),
        href: `/opening/library/${row.id}`, revision: String(row.current_revision_number) });
      return { id: row.id, title: String(row.title).slice(0, 240), revision: Number(row.current_revision_number), updatedAt: iso(row.updated_at), contentWithheld: true,
        summary: `笔记 ${String(row.title).slice(0, 240)}；版本 ${row.current_revision_number}；更新时间 ${iso(row.updated_at)}；本轮仅查询元数据，正文未释放` };
    });
  } else if (request.name === "cards") {
    const a = request.arguments;
    const rows = await tx`SELECT c.id,c.content_version,c.course_id,c.source_ids,s.due_at,np.context_source_refs
      FROM cards c LEFT JOIN card_review_states s ON s.card_id=c.id AND s.workspace_id=c.workspace_id AND s.owner_user_id=${scope.ownerUserId}
      LEFT JOIN opening_note_provenance np ON np.document_id=c.source_document_id AND np.workspace_id=c.workspace_id
      WHERE c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} AND NOT c.archived
        AND ${a.courseId ? tx`c.course_id=${a.courseId}` : tx`TRUE`} AND ${cardReadable(tx, scope.workspaceId)}
        AND (np.document_id IS NULL OR ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`np.context_source_refs`, false)})
      ORDER BY s.due_at NULLS LAST,c.id LIMIT ${a.limit + 1} OFFSET ${a.offset}`;
    if (rows.length > a.limit) { out.status = "partial"; out.reason = "truncated"; out.nextOffset = a.offset + a.limit; }
    out.data = [];
    for (const row of rows.slice(0, a.limit)) {
      // Cards retain source identities; capture each current source version as consumed metadata.
      const refs = (row.source_ids as string[]).length ? await tx`SELECT id AS "sourceId",version AS "sourceVersion" FROM opening_sources
        WHERE workspace_id=${scope.workspaceId} AND id=ANY(${row.source_ids as string[]}::uuid[])` : [];
      out.sourceRefs.push(...refs.map(ref => ({ sourceId: String(ref.sourceId), sourceVersion: Number(ref.sourceVersion) })), ...(parseContextSourceRefs(row.context_source_refs) ?? []));
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
