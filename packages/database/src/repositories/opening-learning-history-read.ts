import type { Sql } from "postgres";
import { courseLearningHistoryInputSchema, type CourseLearningHistoryInput, type CourseLearningHistoryPage, type Scope } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { learningError, mapLearningObservation } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { decodeLearningHistoryCursor, encodeLearningHistoryCursor, type LearningHistoryCursor } from "./opening-learning-history-cursor";

/** Each request uses a short snapshot. Current privacy overrides the immutable fact watermark. */
export async function readOpeningCourseLearningHistory(sql: Sql, scope: Scope, raw: CourseLearningHistoryInput): Promise<CourseLearningHistoryPage> {
  const input = courseLearningHistoryInputSchema.parse(raw);
  const cursor = input.cursor ? decodeLearningHistoryCursor(input.cursor) : null;
  const requirement: LearningHistoryCursor["requirement"] = input.requirementKey === undefined
    ? { kind: "all" } : { kind: "key", value: input.requirementKey };
  if (cursor && (cursor.workspaceId !== scope.workspaceId || cursor.ownerUserId !== scope.ownerUserId
    || cursor.courseId !== input.courseId || JSON.stringify(cursor.requirement) !== JSON.stringify(requirement))) {
    throw learningError("VALIDATION", "learning history cursor scope or filter mismatch");
  }
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [owner] = await tx`SELECT c.id, w.privacy_epoch, COALESCE(h.revision,0) AS revision FROM courses c
      JOIN workspaces w ON w.id=c.workspace_id AND w.owner_user_id=${scope.ownerUserId}
      LEFT JOIN opening_workspace_history_revisions h ON h.workspace_id=w.id AND h.owner_user_id=w.owner_user_id
      WHERE c.id=${input.courseId} AND c.workspace_id=${scope.workspaceId} AND c.archived_at IS NULL`;
    if (!owner) throw learningError("NOT_FOUND", "course not found");
    const committedRevision = Number(owner.revision), snapshotRevision = cursor?.snapshotRevision ?? committedRevision;
    if (snapshotRevision > committedRevision) throw learningError("VALIDATION", "learning history cursor revision is in the future");
    // Select the chain head across every course before filtering attribution. The predecessor link
    // also orders pre-feature rows whose watermark is deliberately the same zero.
    const rows = await tx`WITH heads AS (
      SELECT o.*, root.id AS snapshot_root_id, root.occurred_at AS root_occurred_at
      FROM opening_learning_observations o
      JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
        AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
        AND o.workspace_history_revision<=${snapshotRevision} AND root.workspace_history_revision<=${snapshotRevision}
        AND NOT EXISTS (SELECT 1 FROM opening_learning_observations successor
          WHERE successor.revises_observation_id=o.id AND successor.workspace_id=o.workspace_id
            AND successor.owner_user_id=o.owner_user_id AND successor.workspace_history_revision<=${snapshotRevision})
    ) SELECT heads.*, to_char(root_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary_at
      FROM heads WHERE course_id=${input.courseId}
        AND (${requirement.kind === "all"} OR requirement_key IS NOT DISTINCT FROM ${input.requirementKey ?? null})
      ORDER BY root_occurred_at DESC,snapshot_root_id DESC`;
    const boundary = cursor ? rows.findIndex(row => row.snapshot_root_id === cursor.rootId && row.boundary_at === cursor.occurredAt) : -1;
    if (cursor && boundary < 0) throw learningError("VALIDATION", "learning history cursor boundary is not in this snapshot");
    const visible: Array<{ index: number; observation: CourseLearningHistoryPage["observations"][number]; rootId: string; occurredAt: string }> = [];
    const mapped = rows.map(row => mapLearningObservation({ ...row, effective_head_id: row.id }));
    const contexts = await readOpeningLearningEvidenceContexts(tx, scope, mapped);
    for (const [index, row] of rows.entries()) {
      // The mutable root pointer may already name a future revision; CAS must use this R-local head.
      const observation = mapped[index]!;
      const evidence = contexts[observation.id]!;
      if (evidence.context.version?.applicability === "privacy_excluded") continue;
      visible.push({ index, observation: { ...observation, eligibility: evaluateEvidenceEligibility(evidence.observation, evidence.context) },
        rootId: String(row.snapshot_root_id), occurredAt: String(row.boundary_at) });
    }
    // Reuse the whole-chain privacy owner before count and limit+1; SQL eligibility optimization is separate.
    const totalCount = visible.length, candidates = visible.filter(row => row.index > boundary).slice(0, input.limit + 1);
    const selected = candidates.slice(0, input.limit), last = selected.at(-1);
    const nextCursor = candidates.length > input.limit && last ? encodeLearningHistoryCursor({
      version: 1, workspaceId: scope.workspaceId, ownerUserId: scope.ownerUserId, courseId: input.courseId,
      requirement, snapshotRevision, rootId: last.rootId, occurredAt: last.occurredAt,
      initialTotalCount: cursor?.initialTotalCount ?? totalCount,
      initialPrivacyEpoch: cursor?.initialPrivacyEpoch ?? Number(owner.privacy_epoch),
    }) : null;
    return { observations: selected.map(row => row.observation), snapshotRevision, totalCount, nextCursor,
      visibilityChanged: cursor !== null && (cursor.initialTotalCount !== totalCount || cursor.initialPrivacyEpoch !== Number(owner.privacy_epoch)) };
  }) as Promise<CourseLearningHistoryPage>;
}
