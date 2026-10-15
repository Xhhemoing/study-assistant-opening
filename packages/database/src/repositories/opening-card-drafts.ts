import type { Sql, TransactionSql } from "postgres";
import type { ObservationCardDraft, Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError } from "./opening-learning-facts";
import { qualifyObservationRevision } from "./opening-observation-revision-history";

/** A read-only prefill. The learner edits and explicitly confirms before creating a card. */
export async function readOpeningObservationCardDraft(sql: Sql, scope: Scope, id: string): Promise<ObservationCardDraft> {
  return sql.begin("isolation level repeatable read read only", async tx => (await captureOpeningObservationCardOrigin(tx, scope, id, false)).draft);
}

export async function captureOpeningObservationCardOrigin(tx: TransactionSql, scope: Scope, id: string, admit = true): Promise<{ draft: ObservationCardDraft; sourceIds: string[] }> {
    const [head] = await tx`SELECT head.* FROM opening_learning_observations o
      JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      JOIN opening_learning_observations head ON head.id=COALESCE(root.effective_head_id,root.id)
        AND head.workspace_id=o.workspace_id AND head.owner_user_id=o.owner_user_id
      JOIN workspaces w ON w.id=o.workspace_id AND w.owner_user_id=o.owner_user_id
      JOIN courses c ON c.id=head.course_id AND c.workspace_id=o.workspace_id AND c.archived_at IS NULL
      WHERE o.id=${id} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
    if (!head) throw learningError("NOT_FOUND", "observation not found");
    const observation = await qualifyObservationRevision(tx, scope, head);
    if (observation.outcome !== "incorrect" || observation.revisionKind === "retract") {
      throw learningError("CONFLICT", "only a current incorrect observation can become a card");
    }
    const [problem] = observation.itemVersionId
      ? await tx`SELECT stem_snapshot FROM opening_learning_item_versions WHERE id=${observation.itemVersionId}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`
      : observation.problemId ? await tx`SELECT stem_snapshot FROM opening_problem_refs WHERE problem_id=${observation.problemId}
          AND workspace_id=${scope.workspaceId} AND session_id=${observation.sessionId}` : [];
    const referenceVersion = observation.referenceSourceId ? observation.sourceVersions?.[observation.referenceSourceId] : undefined;
    const chunks = observation.referenceSourceId && referenceVersion != null ? await tx`SELECT text FROM opening_source_chunks c
      JOIN opening_sources s ON s.id=c.source_id AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
        AND c.source_version=${referenceVersion}
      WHERE c.source_id=${observation.referenceSourceId}
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=c.source_id)
      ORDER BY c.page NULLS LAST,c.start_ms NULLS LAST,c.id LIMIT 8` : [];
    const lineage = await tx`SELECT r.source_ids,r.source_versions,r.reference_source_id,r.reference_check FROM opening_learning_observations r
      WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}
        AND COALESCE(r.root_observation_id,r.id)=${observation.rootObservationId ?? observation.id}`;
    const sourceIds = [...new Set(lineage.flatMap(row => [
      ...row.source_ids as string[], ...Object.keys((row.source_versions ?? {}) as Record<string, unknown>),
      ...(row.reference_source_id ? [String(row.reference_source_id)] : []),
      ...((row.reference_check as { referenceId?: string } | null)?.referenceId ? [String((row.reference_check as { referenceId: string }).referenceId)] : []),
    ]))].sort();
    if (sourceIds.length > 32) throw learningError("VALIDATION", "卡片来源超过学习记录可保留的32份材料，不能丢弃来源后创建。");
    if (admit) await admitLearningSources(tx, scope, sourceIds);
    return { sourceIds, draft: {
      observationId: observation.id,
      front: String(problem?.stem_snapshot ?? observation.skillLabel).slice(0, 4000),
      // Never treat the incorrect student answer as the reference answer.
      back: chunks.map(row => String(row.text)).join("\n\n").slice(0, 4000),
      courseId: observation.courseId, skillLabel: observation.skillLabel,
    } };
}
