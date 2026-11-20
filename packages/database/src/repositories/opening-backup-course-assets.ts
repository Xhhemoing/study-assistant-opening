import type { TransactionSql } from "postgres";
import { COURSE_BACKUP_TABLES } from "../../../contracts/src/opening/backup-inventory";
import { backupAssetAdmission, examSourcesIncluded } from "../../../domain/src/opening/backup-workspace-assets";
import type { OpeningBackupRecordSnapshot } from "./opening-backup-records";
import { exportSprintPack } from "./opening-backup-exam-pack";
import { resolvedKnowledgeCoverage } from "./opening-knowledge-legacy-coverage";
import { asObject } from "./backup-map";

export async function readBackupCourseAssets(tx: TransactionSql, workspace: string, owner: string,
  tables: OpeningBackupRecordSnapshot["tables"]) {
  tables.opening_course_knowledge = [...await tx`SELECT r.workspace_id,r.owner_user_id,r.course_id,r.version,r.snapshot,r.source_versions,r.updated_at
    FROM opening_course_knowledge r
    WHERE r.workspace_id=${workspace} AND r.owner_user_id=${owner} ORDER BY r.course_id`];
  const legacyGraphs = tables.opening_course_knowledge.flatMap(row => {
    const snapshot = asObject(row.snapshot);
    return snapshot && !Object.hasOwn(snapshot, "coveredSourceVersions") && asObject(snapshot.coveredSourceChunkDigests)
      ? [{ row, snapshot }] : [];
  });
  if (legacyGraphs.length) {
    // Persist just the legacy coverage in the archive since build jobs are never exported.
    const coverage = await tx`SELECT graph.course_id,${resolvedKnowledgeCoverage(tx)} AS versions
      FROM opening_course_knowledge graph WHERE graph.workspace_id=${workspace} AND graph.owner_user_id=${owner}
        AND graph.course_id=ANY(${legacyGraphs.map(({ row }) => String(row.course_id))}::uuid[])`;
    const byCourse = new Map(coverage.map(row => [row.course_id, row.versions]));
    for (const { row, snapshot } of legacyGraphs) {
      row.snapshot = { ...snapshot, coveredSourceVersions: byCourse.get(row.course_id) };
    }
  }
  tables.opening_knowledge_confirmations = [...await tx`SELECT r.id,r.workspace_id,r.owner_user_id,r.course_id,r.node_id,r.node_label,r.node_kind,r.confirmed_at,r.graph_version_before,r.graph_version_after,r.source_versions,r.evidence_chunk_ids
    FROM opening_knowledge_confirmations r
    WHERE r.workspace_id=${workspace} AND r.owner_user_id=${owner} ORDER BY r.id`];
  tables.opening_exam_sprints = [...await tx`SELECT r.id,r.workspace_id,r.owner_user_id,r.course_id,r.pack_snapshot,r.state,r.created_at,r.updated_at
    FROM opening_exam_sprints r
    WHERE r.workspace_id=${workspace} AND r.owner_user_id=${owner} ORDER BY r.id`];
  tables.opening_exam_bindings = [...await tx`SELECT r.sprint_id,r.course_id,r.binding,r.updated_at,s.workspace_id,s.owner_user_id
    FROM opening_exam_bindings r JOIN opening_exam_sprints s ON s.id=r.sprint_id
    WHERE s.workspace_id=${workspace} AND s.owner_user_id=${owner} ORDER BY r.sprint_id`];
  tables.opening_exam_papers = [...await tx`SELECT r.id,r.sprint_id,r.workspace_id,r.owner_user_id,r.course_id,r.source_id,r.source_version,r.teacher,r.year,r.label,r.kind,r.skills,r.client_key,r.intent,r.recorded_at
    FROM opening_exam_papers r JOIN opening_exam_sprints s ON s.id=r.sprint_id
    WHERE s.workspace_id=${workspace} AND s.owner_user_id=${owner} AND r.workspace_id=s.workspace_id AND r.owner_user_id=s.owner_user_id ORDER BY r.id`];
  tables.opening_exam_reviews = [...await tx`SELECT r.id,r.sprint_id,r.workspace_id,r.owner_user_id,r.source_item_id,r.work_source_id,r.work_source_version,r.reference_source_id,r.reference_source_version,r.answer_text,r.client_key,r.intent,r.status,r.proposal,r.model_label,r.privacy_epoch,r.created_at,r.updated_at
    FROM opening_exam_reviews r JOIN opening_exam_sprints s ON s.id=r.sprint_id
    WHERE s.workspace_id=${workspace} AND s.owner_user_id=${owner} AND r.workspace_id=s.workspace_id AND r.owner_user_id=s.owner_user_id ORDER BY r.id`];
  tables.opening_exam_attempt_links = [...await tx`SELECT r.id,r.sprint_id,r.exam_attempt_id,r.learning_attempt_id,r.node_id,r.requirement_key,r.first_family_exposure,r.delayed_earliest_at,r.submitted_answer,r.captured_at,r.observation_id,r.publication,r.prediction,s.workspace_id,s.owner_user_id
    FROM opening_exam_attempt_links r JOIN opening_exam_sprints s ON s.id=r.sprint_id
    WHERE s.workspace_id=${workspace} AND s.owner_user_id=${owner} ORDER BY r.id`];
  tables.opening_exam_source_observations = [...await tx`SELECT r.sprint_id,r.source_record_id,r.skill_ids,r.observation_id,s.workspace_id,s.owner_user_id
    FROM opening_exam_source_observations r JOIN opening_exam_sprints s ON s.id=r.sprint_id
    WHERE s.workspace_id=${workspace} AND s.owner_user_id=${owner} ORDER BY r.sprint_id,r.source_record_id`];
  tables.opening_exam_source_mappings = [...await tx`SELECT r.sprint_id,r.source_item_id,r.skill_ids,r.updated_at,s.workspace_id,s.owner_user_id
    FROM opening_exam_source_mappings r JOIN opening_exam_sprints s ON s.id=r.sprint_id
    WHERE s.workspace_id=${workspace} AND s.owner_user_id=${owner} ORDER BY r.sprint_id,r.source_item_id`];
  tables.opening_exam_help_receipts = [...await tx`SELECT r.id,r.attempt_link_id,r.kind,r.delivered_at,r.history_revision,r.workspace_history_revision,NULL::text AS content_snapshot,s.workspace_id,s.owner_user_id
    FROM opening_exam_help_receipts r JOIN opening_exam_attempt_links link ON link.id=r.attempt_link_id JOIN opening_exam_sprints s ON s.id=link.sprint_id
    WHERE s.workspace_id=${workspace} AND s.owner_user_id=${owner} ORDER BY r.id`];
  // A binding describes the material consumed by the sprint. Dropping only the
  // binding would detach derived answers and receipts from their privacy lineage.
  const admitted = backupAssetAdmission(tables);
  const blocked = new Set(tables.opening_exam_bindings.filter(row => !admitted("opening_exam_bindings", row)).map(row => row.sprint_id));
  for (const name of ["opening_exam_attempt_links", "opening_exam_source_observations"] as const) {
    for (const row of tables[name]) if (!admitted(name, row)) blocked.add(row.sprint_id);
  }
  const sources = new Set(tables.opening_sources.map(row => row.id));
  tables.opening_exam_sprints = tables.opening_exam_sprints.filter(row =>
    !blocked.has(row.id) && examSourcesIncluded(row, sources)).map(exportSprintPack);
  // Rebuild parent indexes after each filter so grandchildren cannot follow an excluded parent.
  for (const name of COURSE_BACKUP_TABLES) {
    const accept = backupAssetAdmission(tables);
    tables[name] = tables[name].filter(row => accept(name, row));
  }
}
