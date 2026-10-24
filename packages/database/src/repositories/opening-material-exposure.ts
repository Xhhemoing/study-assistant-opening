import { materialManifestSchema, type MaterialManifest, type Scope } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { generateOpeningStudyExposure, releaseOpeningStudyExposure } from "./opening-study-exposure";
import { learningError } from "./opening-learning-facts";

/** Editorial answer entry/reveal is real exposure too, including before a
 * canonical attempt exists. Page-scoped receipts conservatively prevent a later
 * question on that page being called independently unseen. */
export async function recordMaterialAnswerExposure(tx: TransactionSql, scope: Scope,
  answers: MaterialManifest["answers"], releaseKey: string) {
  const targets = new Map<string, { sourceId: string; sourceVersion: number; page: number }>();
  for (const answer of answers) {
    const [row] = await tx`SELECT v.material_manifest FROM opening_source_versions v JOIN opening_sources s ON s.id=v.source_id
      WHERE v.source_id=${answer.questionSourceId} AND v.version=${answer.questionSourceVersion} AND v.workspace_id=${scope.workspaceId}
        AND s.upload_state='uploaded' AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=s.id)`;
    const question = (row?.material_manifest == null ? null : materialManifestSchema.parse(row.material_manifest))?.questions.find(q =>
      q.family===answer.question.family && q.number===answer.question.number && q.subquestion===answer.question.subquestion);
    if (!question) throw learningError("CONFLICT", "关联题目已不可用，答案未释放");
    const target = { sourceId: answer.questionSourceId, sourceVersion: answer.questionSourceVersion, page: question.page };
    targets.set(`${target.sourceId}:${target.sourceVersion}:${target.page}`,target);
  }
  for (const [key,target] of targets) {
    const receipt = await generateOpeningStudyExposure(tx,scope,{
      releaseKey:`${releaseKey}:${key}`,contextAnchor:{...target,purpose:"material_read"},
      origin:"material_excerpt",kind:"solution",level:"revealed",supportDomain:"math",
    });
    await releaseOpeningStudyExposure(tx,scope,receipt.id);
  }
}
