import type { Scope, TeachingSourceRef } from "@aistudy/contracts";
import { materialPageRole } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { readMaterialManifest } from "./opening-material-manifest";
import { learningError } from "./opening-learning-facts";

/** Saved teaching is derived content too. Reclassification cannot expose its
 * old answer-bearing body merely because the original source version is stable. */
export async function assertTeachingMaterialsReadable(db: Sql | TransactionSql, scope: Scope, references: readonly TeachingSourceRef[]) {
  if (!references.length) return;
  const ids=[...new Set(references.map(ref=>ref.sourceId))];
  const rows=await db`SELECT v.source_id,v.version,v.material_manifest FROM opening_source_versions v
    JOIN workspaces w ON w.id=v.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    WHERE v.workspace_id=${scope.workspaceId} AND v.source_id=ANY(${ids}::uuid[]) AND v.material_manifest IS NOT NULL`;
  for (const ref of references) {
    const candidates=rows.filter(row=>row.source_id===ref.sourceId);
    if(!candidates.length) continue;
    const version=ref.version==null ? NaN : Number(ref.version);
    if(!Number.isSafeInteger(version)||version<0) throw learningError("CONFLICT","旧教学缺少明确资料版本，分类后须重新生成，原作答保留。");
    const row=candidates.find(row=>Number(row.version)===version);
    if(!row) continue;
    const manifest=readMaterialManifest(row.material_manifest)!;
    if(!["lecture","exercise","exam_spec"].includes(materialPageRole(manifest,ref.page??null))) {
      throw learningError("CONFLICT","旧教学引用了答案、详解或未分类页，须重新生成，原作答保留。");
    }
  }
}
