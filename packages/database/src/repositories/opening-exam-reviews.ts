import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import {
  examWorkReviewInputSchema, examWorkReviewProposalSchema,
  type ExamWorkReview, type ExamWorkReviewInput, type ExamWorkReviewProposal, type Scope,
} from "@aistudy/contracts";
import { learningError } from "./opening-learning-facts";
import { assertExamMaterialAvailable } from "./opening-exam-integration-binding";
import { parseExamBinding } from "./opening-exam-integration-facts";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";

type Row = Record<string, unknown>;
export type ExamReviewContext = {
  review: ExamWorkReview; input: ExamWorkReviewInput; privacyEpoch: number;
  referencePage: number; questionLabel: string;
};
function view(row: Row): ExamWorkReview {
  return { id: String(row.id), sourceItemId: String(row.source_item_id), workSourceId: String(row.work_source_id),
    referenceSourceId: String(row.reference_source_id), createdAt: new Date(row.created_at as Date).toISOString(),
    workSourceVersion: Number(row.work_source_version), referenceSourceVersion: Number(row.reference_source_version), answerText: String(row.answer_text),
    status: row.status as ExamWorkReview["status"], modelLabel: row.model_label as string | null,
    proposal: row.proposal == null ? null : examWorkReviewProposalSchema.parse(row.proposal) };
}

/** Images stay in object storage. Only a proposal is retained; it cannot grade an observation. */
export function createOpeningExamReviewsRepository(sql: Sql) {
  async function validate(tx: TransactionSql, scope: Scope, input: ExamWorkReviewInput, expectedEpoch?: number) {
    const [workspace] = await tx`SELECT id,privacy_epoch FROM workspaces
      WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!workspace) throw learningError("NOT_FOUND", "工作区不存在");
    const privacyEpoch = Number(workspace.privacy_epoch);
    if (expectedEpoch !== undefined && expectedEpoch !== privacyEpoch) throw learningError("CONFLICT", "材料隐私设置已变化，请重新选择材料");
    const [row] = await tx`SELECT s.id,s.pack_snapshot,s.state,b.binding FROM opening_exam_sprints s
      JOIN opening_exam_bindings b ON b.sprint_id=s.id
      WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId} FOR SHARE OF s,b`;
    if (!row) throw learningError("CONFLICT", "请先将冲刺绑定课程和原材料");
    const snapshot = parseExamSprintSnapshot(row.pack_snapshot, row.state), binding = parseExamBinding(row.binding);
    const courses = await tx`SELECT id FROM courses WHERE id=${binding.courseId} AND workspace_id=${scope.workspaceId}
      AND archived_at IS NULL FOR SHARE`;
    if (!courses.length) throw learningError("CONFLICT", "课程已归档，请先恢复课程再评阅");
    const item = snapshot.pack.sourceItems.find(item => item.id === input.sourceItemId);
    const reference = item && binding.materials.find(material => material.sourceTitle === item.sourceTitle);
    if (!item || !item.sourcePage || !reference || reference.sourceId !== input.referenceSourceId
      || reference.sourceVersion !== input.referenceSourceVersion) throw learningError("CONFLICT", "请先绑定这道原题的真实材料及页码");
    if (input.workSourceId === input.referenceSourceId || binding.materials.some(material => material.sourceId === input.workSourceId)
      || binding.packSourceId === input.workSourceId) throw learningError("VALIDATION", "请选择自己的作答照片作为作答材料");
    for (const [id, version] of [[input.workSourceId, input.workSourceVersion], [input.referenceSourceId, input.referenceSourceVersion]] as const) {
      await assertExamMaterialAvailable(tx, scope, id, version);
      const [current] = await tx`SELECT version FROM opening_sources WHERE id=${id}`;
      if (Number(current?.version) !== version) throw learningError("CONFLICT", "材料已更新，请刷新到当前版本");
    }
    const [work] = await tx`SELECT mime FROM opening_sources WHERE id=${input.workSourceId}`;
    if (!["image/jpeg", "image/png", "image/webp"].includes(String(work?.mime))) throw learningError("VALIDATION", "作答材料请选择已上传的 JPG、PNG 或 WebP 照片");
    const pages = await tx`SELECT 1 FROM opening_source_chunks WHERE source_id=${reference.sourceId}
      AND source_version=${reference.sourceVersion} AND page=${item.sourcePage}
      AND (text ~ '[^[:space:]]' OR (image_object_key IS NOT NULL AND image_object_key<>'')) LIMIT 1`;
    if (!pages.length) throw learningError("CONFLICT", "原材料中找不到这道题对应的物理页");
    return { sprintId: String(row.id), privacyEpoch, referencePage: item.sourcePage,
      questionLabel: `${item.sourceTitle}，物理页 ${item.sourcePage}，${item.label}` };
  }
  async function readContext(tx: TransactionSql, scope: Scope, id: string): Promise<ExamReviewContext> {
    const [row] = await tx`SELECT * FROM opening_exam_reviews WHERE id=${id}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!row) throw learningError("NOT_FOUND", "评阅记录不存在");
    const input = examWorkReviewInputSchema.parse(row.intent);
    const checked = await validate(tx, scope, input, Number(row.privacy_epoch));
    return { review: view(row), input, ...checked };
  }
  return {
    async begin(scope: Scope, raw: ExamWorkReviewInput): Promise<ExamReviewContext> {
      const input = examWorkReviewInputSchema.parse(raw);
      return sql.begin(async tx => {
        // Serializes logical operation creation. No learning-history mutation occurs here.
        const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw learningError("NOT_FOUND", "工作区不存在");
        const [existing] = await tx`SELECT * FROM opening_exam_reviews WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
        if (existing) {
          if (!isDeepStrictEqual(existing.intent, input)) throw learningError("CONFLICT", "同一评阅标识不能提交不同作答");
          return readContext(tx, scope, String(existing.id));
        }
        const checked = await validate(tx, scope, input), id = randomUUID();
        await tx`INSERT INTO opening_exam_reviews(id,sprint_id,workspace_id,owner_user_id,source_item_id,
          work_source_id,work_source_version,reference_source_id,reference_source_version,answer_text,
          client_key,intent,status,privacy_epoch)
          VALUES(${id},${checked.sprintId},${scope.workspaceId},${scope.ownerUserId},${input.sourceItemId},
          ${input.workSourceId},${input.workSourceVersion},${input.referenceSourceId},${input.referenceSourceVersion},
          ${input.answerText},${input.clientKey},${tx.json(input)},'pending',${checked.privacyEpoch})`;
        return readContext(tx, scope, id);
      });
    },
    async read(scope: Scope, id: string): Promise<ExamWorkReview> {
      return sql.begin(async tx => (await readContext(tx, scope, id)).review);
    },
    async assertCurrent(scope: Scope, id: string): Promise<void> {
      await sql.begin(async tx => { await readContext(tx, scope, id); });
    },
    async complete(scope: Scope, id: string, raw: ExamWorkReviewProposal, modelLabel: string | null): Promise<void> {
      const proposal = examWorkReviewProposalSchema.parse(raw);
      await sql.begin(async tx => {
        await readContext(tx, scope, id);
        await tx`UPDATE opening_exam_reviews SET status='ready',proposal=${tx.json(proposal)},model_label=${modelLabel},updated_at=now()
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status<>'ready'`;
      });
    },
    async fail(scope: Scope, id: string, status: "unknown" | "failed"): Promise<void> {
      await sql`UPDATE opening_exam_reviews SET status=${status},updated_at=now() WHERE id=${id}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status<>'ready'`;
    },
  };
}
