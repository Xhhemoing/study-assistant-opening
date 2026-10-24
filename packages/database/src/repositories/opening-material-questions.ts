import { materialQuestionIdentitySchema, type MaterialQuestionIdentity, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError } from "./opening-learning-facts";
import { readMaterialManifest } from "./opening-material-manifest";

type DB = Sql | TransactionSql;
export const materialQuestionSpec = (identity: MaterialQuestionIdentity) => ({ kind: "material_question" as const, ...identity });
export async function readMaterialQuestion(db: DB, scope: Scope, identity: MaterialQuestionIdentity) {
  const [row] = await db`SELECT v.material_manifest FROM opening_source_versions v JOIN opening_sources s ON s.id=v.source_id
    JOIN workspaces w ON w.id=s.workspace_id
    WHERE v.source_id=${identity.sourceId} AND v.version=${identity.sourceVersion}
      AND w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND s.upload_state='uploaded'
      AND s.version=${identity.sourceVersion}
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=w.id AND e.source_id=s.id)`;
  const manifest=readMaterialManifest(row?.material_manifest);
  const q=manifest?.questions.find(q=>q.family===identity.family && q.number===identity.number && q.subquestion===identity.subquestion);
  if (!q) throw learningError("CONFLICT","资料题目身份已失效或未登记，请重新选择正文题目");
  return q;
}
export function materialQuestionDisputed(db: DB, alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("invalid internal item alias");
  return db.unsafe(`EXISTS(SELECT 1 FROM opening_source_versions mv
    JOIN opening_sources ms ON ms.id=mv.source_id AND ms.workspace_id=mv.workspace_id AND ms.version=mv.version
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mv.material_manifest->'answers','[]'::jsonb)) ma
    WHERE mv.workspace_id=${alias}.workspace_id AND ma->>'status'='disputed'
      AND ${alias}.evaluation_spec->>'kind'='material_question'
      AND ma->>'questionSourceId'=${alias}.source_id::text AND (ma->>'questionSourceVersion')::int=${alias}.source_version
      AND ma->'question'->>'family'=${alias}.evaluation_spec->>'family'
      AND ma->'question'->>'number'=${alias}.evaluation_spec->>'number'
      AND ma->'question'->>'subquestion'=${alias}.evaluation_spec->>'subquestion')`);
}
export async function isMaterialItemDisputed(db: DB, scope: Scope, itemId: string | null | undefined): Promise<boolean> {
  if (!itemId) return false;
  const [row]=await db`SELECT ${materialQuestionDisputed(db,"v")} AS disputed FROM opening_learning_item_versions v
    WHERE v.id=${itemId} AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}`;
  return row?.disputed===true;
}
/** Only answer links to THIS submitted canonical problem are returned. The page
 * body is deliberately not returned: it can contain solutions to unseen items. */
export async function readMaterialAnswers(db: DB, scope: Scope, attemptId: string) {
  const [attempt]=await db`SELECT a.submitted_at,v.evaluation_spec FROM opening_learning_attempts a
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    WHERE a.id=${attemptId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  if (!attempt?.submitted_at) throw learningError("CONFLICT","请先保存独立作答，再核对答案关联");
  const spec=attempt.evaluation_spec as Record<string,unknown> | null;
  if (!spec || spec.kind!=="material_question") throw learningError("VALIDATION","这次作答没有资料题身份");
  const {kind: _kind,...raw}=spec;
  const identity=materialQuestionIdentitySchema.parse(raw);
  await readMaterialQuestion(db,scope,identity);
  const rows=await db`SELECT v.source_id,v.version,v.material_manifest,v.material_reviewed_by,v.material_reviewed_at
    FROM opening_source_versions v JOIN opening_sources s ON s.id=v.source_id AND s.workspace_id=v.workspace_id AND s.version=v.version
    WHERE v.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded' AND v.material_manifest IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=s.id)`;
  return rows.flatMap(row=>(readMaterialManifest(row.material_manifest)?.answers ?? []).filter(a=>a.questionSourceId===identity.sourceId && a.questionSourceVersion===identity.sourceVersion
    && a.question.family===identity.family && a.question.number===identity.number && a.question.subquestion===identity.subquestion)
    .map(a=>({ ...a, sourceId:String(row.source_id), sourceVersion:Number(row.version), reviewedBy:a.reviewedBy ?? row.material_reviewed_by,
      reviewedAt:a.reviewedAt ?? (row.material_reviewed_at ? new Date(row.material_reviewed_at).toISOString() : null) })));
}
