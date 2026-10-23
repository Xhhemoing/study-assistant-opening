import { materialManifestSchema, materialManifestWriteSchema, materialPageRole, type MaterialManifest, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";
import { syncOpeningAutomaticErrorCard } from "./opening-auto-error-cards";

type DB = Sql | TransactionSql;
/** Malformed persisted classification must not silently become unrestricted. */
export function readMaterialManifest(raw: unknown): MaterialManifest | null {
  return raw == null ? null : materialManifestSchema.parse(raw);
}
/** SQL aliases are fixed internal identifiers. General retrieval never releases
 * answer pages globally just because one question on a page has been attempted. */
export function materialPageReadable(db: DB, source: string, version: string, page: string) {
  for (const value of [source,version,page]) if (!/^[a-z_]+\.[a-z_]+$/.test(value)) throw new Error("invalid internal material alias");
  return db.unsafe(`NOT EXISTS (SELECT 1 FROM opening_source_versions mv WHERE mv.source_id=${source} AND mv.version=${version}
    AND mv.material_manifest IS NOT NULL AND NOT (
      mv.material_manifest->>'role' IN ('lecture','exercise','exam_spec') OR
      (mv.material_manifest->>'role'='mixed' AND EXISTS (SELECT 1 FROM jsonb_array_elements(mv.material_manifest->'sections') sec
        WHERE (sec->>'startPage')::int<=${page} AND (sec->>'endPage')::int>=${page}
          AND sec->>'role' IN ('lecture','exercise','exam_spec')))))`);
}
export async function assertMaterialPageReadable(db: DB, scope: Scope, sourceId: string, version: number, page: number | null) {
  const [row] = await db`SELECT v.material_manifest FROM opening_source_versions v JOIN workspaces w ON w.id=v.workspace_id
    WHERE v.source_id=${sourceId} AND v.version=${version} AND w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
  const manifest = readMaterialManifest(row?.material_manifest);
  if (manifest && !["lecture","exercise","exam_spec"].includes(materialPageRole(manifest,page))) {
    throw learningError("CONFLICT", "答案、详解或未分类混合页已隔离；请先独立作答，再从对应题目核对答案。");
  }
}
export function createOpeningMaterialManifestRepository(sql: Sql) {
  return {
    async read(scope: Scope, sourceId: string) {
      const [row] = await sql`SELECT s.version,v.material_manifest,v.material_manifest_revision,v.material_reviewed_by,v.material_reviewed_at
        FROM opening_sources s JOIN workspaces w ON w.id=s.workspace_id
        LEFT JOIN opening_source_versions v ON v.source_id=s.id AND v.version=s.version
        WHERE s.id=${sourceId} AND w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!row) throw learningError("NOT_FOUND","source not found");
      return { sourceVersion: Number(row.version), revision: Number(row.material_manifest_revision ?? 0), manifest: readMaterialManifest(row.material_manifest),
        reviewedBy: row.material_reviewed_by ?? null, reviewedAt: row.material_reviewed_at ? new Date(row.material_reviewed_at).toISOString() : null };
    },
    async write(scope: Scope, sourceId: string, raw: unknown) {
      const input = materialManifestWriteSchema.parse(raw);
      await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx,scope);
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const [source] = await tx`SELECT s.* FROM opening_sources s JOIN workspaces w ON w.id=s.workspace_id
          WHERE s.id=${sourceId} AND w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
            AND s.version=${input.sourceVersion} AND s.upload_state='uploaded' AND s.parse_state='ready'
            AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=w.id AND e.source_id=s.id)
          FOR UPDATE OF s`;
        if (!source) throw learningError("CONFLICT","资料版本或可用状态已改变，请刷新");
        await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
          VALUES(${sourceId},${input.sourceVersion},${scope.workspaceId},${source.bytes},${source.sha256},'available') ON CONFLICT DO NOTHING`;
        const [old] = await tx`SELECT material_manifest,material_manifest_revision FROM opening_source_versions
          WHERE source_id=${sourceId} AND version=${input.sourceVersion} FOR UPDATE`;
        if (Number(old!.material_manifest_revision) !== input.expectedRevision) throw learningError("CONFLICT","资料分类已更新，请刷新后修改");
        const pages = await tx`SELECT DISTINCT page FROM opening_source_chunks WHERE source_id=${sourceId} AND source_version=${input.sourceVersion}`;
        const knownPages = new Set(pages.map(row => Number(row.page)));
        for (const item of [...input.manifest.questions,...input.manifest.answers]) if (!knownPages.has(item.page)) throw learningError("VALIDATION","题目或答案页不在已解析资料中");
        for (const section of input.manifest.sections) if (!knownPages.has(section.startPage) || !knownPages.has(section.endPage)) throw learningError("VALIDATION","页段边界不在已解析资料中");
        // Identity/stem remains immutable within a source version once classified.
        const before = readMaterialManifest(old!.material_manifest);
        for (const q of before?.questions ?? []) {
          const match = input.manifest.questions.find(n => n.family===q.family && n.number===q.number && n.subquestion===q.subquestion);
          if (!match || match.page!==q.page || match.stem!==q.stem) throw learningError("CONFLICT","已登记的题目身份或正文不能在同一资料版本内改写");
        }
        for (const answer of input.manifest.answers) {
          let target: MaterialManifest | null;
          if (answer.questionSourceId===sourceId && answer.questionSourceVersion===input.sourceVersion) target=input.manifest;
          else {
            const [other] = await tx`SELECT v.material_manifest FROM opening_source_versions v JOIN opening_sources s ON s.id=v.source_id
              WHERE v.workspace_id=${scope.workspaceId} AND v.source_id=${answer.questionSourceId} AND v.version=${answer.questionSourceVersion}
                AND s.upload_state='uploaded' AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=s.id)`;
            target=readMaterialManifest(other?.material_manifest);
          }
          if (!target?.questions.some(q => q.family===answer.question.family && q.number===answer.question.number && q.subquestion===answer.question.subquestion)) throw learningError("VALIDATION","答案必须关联已登记、同工作区的正文题目");
        }
        await tx`UPDATE opening_source_versions SET material_manifest=${tx.json(input.manifest)},material_manifest_revision=material_manifest_revision+1,
          material_reviewed_by=${scope.ownerUserId},material_reviewed_at=clock_timestamp() WHERE source_id=${sourceId} AND version=${input.sourceVersion}`;
        await nextWorkspaceLearningHistoryRevision(tx,scope);
        const affected=[sourceId,...input.manifest.answers.map(a=>a.questionSourceId),...(before?.answers ?? []).map(a=>a.questionSourceId)];
        await invalidateOpeningLearningEligibility(tx,scope,{sourceIds:[...new Set(affected)]});
        // Revoke in-flight model snapshots before newly restricted content can
        // publish; retained learner facts are not rewritten.
        await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
        await tx`UPDATE opening_course_knowledge SET node_definitions='{}'::jsonb
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND source_versions ?| ${affected}::text[]`;
        const heads=await tx`SELECT h.id FROM opening_learning_observations root
          JOIN opening_learning_observations h ON h.id=COALESCE(root.effective_head_id,root.id)
          WHERE root.workspace_id=${scope.workspaceId} AND root.owner_user_id=${scope.ownerUserId}
            AND (root.root_observation_id IS NULL OR root.root_observation_id=root.id) AND h.source_ids && ${affected}::uuid[]`;
        for (const head of heads) await syncOpeningAutomaticErrorCard(tx,scope,String(head.id));
      });
      return this.read(scope,sourceId);
    },
  };
}
