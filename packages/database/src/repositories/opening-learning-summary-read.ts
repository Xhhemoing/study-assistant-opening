import type { Sql, TransactionSql } from "postgres";
import { courseLearningSummaryInputSchema, courseLearningSummaryPageSchema, type CourseLearningSummaryInput, type CourseLearningSummaryPage, type LearningSummaryAggregate, type Scope } from "@aistudy/contracts";
import { learningError } from "./opening-learning-facts";
import { openingEligibilityPolicyVersion, openingEligibilityStateQuery, repairOpeningLearningEligibility } from "./opening-learning-eligibility";
import { decodeLearningSummaryCursor, encodeLearningSummaryCursor, type LearningSummaryCursor } from "./opening-learning-summary-cursor";

type GroupKey = { skillLabel: string; requirementKey: string | null };
const groupKey = (row: GroupKey) => JSON.stringify([row.skillLabel, row.requirementKey]);

/** Native open activities only. Source exclusions also cover their complete evidence ancestry. */
function activitiesQuery(tx: TransactionSql, scope: Scope, courseId: string, evaluatedAt: string) {
  return tx`SELECT a.skill_label,a.requirement_key,a.status,
      (COALESCE(a.scheduled_start_at,a.recommended_at) IS NOT NULL AND COALESCE(a.scheduled_start_at,a.recommended_at)<=${evaluatedAt}::timestamptz
        AND (a.not_before_at IS NULL OR a.not_before_at<=${evaluatedAt}::timestamptz)
        AND (a.snoozed_until IS NULL OR a.snoozed_until<=${evaluatedAt}::timestamptz)) AS due
    FROM opening_retest_activities a JOIN opening_tasks t ON t.id=a.task_id AND t.workspace_id=a.workspace_id AND t.owner_user_id=a.owner_user_id AND t.status='pending'
    LEFT JOIN opening_jobs j ON j.id=a.candidate_id AND j.workspace_id=a.workspace_id AND j.owner_user_id=a.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
      AND a.status IN ('accepted','in_progress') AND (a.candidate_id IS NULL OR j.id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.payload->'sourceIds')='array' THEN j.payload->'sourceIds' ELSE '[]'::jsonb END) s(id)
        JOIN opening_privacy_exclusions e ON e.workspace_id=a.workspace_id AND e.source_id::text=lower(s.id))
      AND NOT EXISTS(SELECT 1 FROM opening_learning_observations chain
        CROSS JOIN LATERAL (SELECT unnest(chain.source_ids)::text AS source_id
          UNION SELECT jsonb_object_keys(COALESCE(chain.source_versions,'{}'::jsonb))
          UNION SELECT chain.reference_source_id::text UNION SELECT chain.reference_check->>'referenceId') refs
        JOIN opening_privacy_exclusions e ON e.workspace_id=chain.workspace_id AND e.source_id::text=refs.source_id
        WHERE chain.workspace_id=a.workspace_id AND chain.owner_user_id=a.owner_user_id AND (
          COALESCE(chain.root_observation_id,chain.id)::text IN (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.payload->'evidenceRootIds')='array' THEN j.payload->'evidenceRootIds' ELSE '[]'::jsonb END))
          OR COALESCE(chain.root_observation_id,chain.id) IN (SELECT COALESCE(original.root_observation_id,original.id) FROM opening_learning_observations original
            WHERE original.workspace_id=a.workspace_id AND original.owner_user_id=a.owner_user_id AND original.id::text IN (
              SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.payload->'evidenceObservationIds')='array' THEN j.payload->'evidenceObservationIds' ELSE '[]'::jsonb END)))))`;
}

async function readPage(sql: Sql, scope: Scope, input: CourseLearningSummaryInput, cursor: LearningSummaryCursor | null, evaluatedAt: string) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [owner] = await tx`SELECT w.privacy_epoch,COALESCE(r.revision,0) AS revision FROM workspaces w
      JOIN courses c ON c.workspace_id=w.id AND c.id=${input.courseId} AND c.archived_at IS NULL
      LEFT JOIN opening_workspace_history_revisions r ON r.workspace_id=w.id AND r.owner_user_id=w.owner_user_id
      WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
    if (!owner) throw learningError("NOT_FOUND", "course not found");
    const stamp: LearningSummaryCursor = { version: 1, ...scope, courseId: input.courseId, snapshotRevision: Number(owner.revision),
      privacyEpoch: Number(owner.privacy_epoch), policyVersion: openingEligibilityPolicyVersion(), evaluatedAt, limit: input.limit,
      after: cursor?.after ?? null };
    if (cursor && (cursor.snapshotRevision !== stamp.snapshotRevision || cursor.privacyEpoch !== stamp.privacyEpoch || cursor.policyVersion !== stamp.policyVersion)) {
      throw learningError("CONFLICT", "learning summary changed; restart group pagination");
    }
    const allGroups = tx`SELECT DISTINCT skill_label,requirement_key FROM (
      SELECT skill_label,requirement_key FROM (${openingEligibilityStateQuery(tx, scope, { courseId: input.courseId })}) facts WHERE NOT privacy_excluded
      UNION ALL SELECT skill_label,requirement_key FROM (${activitiesQuery(tx, scope, input.courseId, evaluatedAt)}) activities) grouped`;
    if (cursor?.after) {
      const boundary = await tx`SELECT 1 FROM (${allGroups}) g WHERE g.skill_label=${cursor.after.skillLabel} AND g.requirement_key IS NOT DISTINCT FROM ${cursor.after.requirementKey}`;
      if (!boundary.length) throw learningError("VALIDATION", "learning summary cursor boundary is not visible");
    }
    const keys = await tx`SELECT * FROM (${allGroups}) g
      WHERE ${cursor?.after ? tx`(g.skill_label COLLATE "C",CASE WHEN g.requirement_key IS NULL THEN 0 ELSE 1 END,COALESCE(g.requirement_key,'') COLLATE "C")
        > (${cursor.after.skillLabel}::text COLLATE "C",${cursor.after.requirementKey === null ? 0 : 1},${cursor.after.requirementKey ?? ""}::text COLLATE "C")` : tx`TRUE`}
      ORDER BY g.skill_label COLLATE "C",g.requirement_key COLLATE "C" NULLS FIRST LIMIT ${input.limit + 1}`;
    const selected: GroupKey[] = keys.slice(0, input.limit).map(row => ({ skillLabel: String(row.skill_label), requirementKey: row.requirement_key == null ? null : String(row.requirement_key) }));
    const state = openingEligibilityStateQuery(tx, scope, { courseId: input.courseId, groups: selected });
    const [pending] = await tx`SELECT count(*) FILTER(WHERE NOT fresh AND NOT privacy_excluded) AS count FROM (${state}) facts`;
    const pendingProjectionCount = Number(pending?.count ?? 0);
    const continuing = encodeLearningSummaryCursor(stamp);
    if (pendingProjectionCount) return { selected, stamp, page: { status: "updating", groups: [], snapshotRevision: stamp.snapshotRevision,
      nextCursor: continuing, evaluatedAt, pendingProjectionCount } satisfies CourseLearningSummaryPage };
    const rows = selected.length ? await tx`WITH ranked AS (
      SELECT q.*,floor(extract(epoch FROM COALESCE(submitted_at,occurred_at))*1000)::bigint AS attempt_at,
        max(floor(extract(epoch FROM COALESCE(submitted_at,occurred_at))*1000)::bigint) OVER(PARTITION BY skill_label,requirement_key) AS latest_attempt,
        row_number() OVER(PARTITION BY skill_label,requirement_key ORDER BY COALESCE(submitted_at,occurred_at) DESC,id DESC) AS display_rank
      FROM (${state}) q WHERE fresh AND NOT privacy_excluded
    ) SELECT skill_label,requirement_key,count(*) AS sample_count,max(occurred_at) AS last_observed_at,max(latest_attempt) AS latest_attempt_at,
      count(*) FILTER(WHERE attempt_at=latest_attempt) AS latest_attempt_count,
      count(*) FILTER(WHERE independent_attempt='yes' AND verified_correct='yes' AND usable_for_current_version='yes') AS independent_count,
      count(*) FILTER(WHERE attempt_at=latest_attempt AND independent_attempt='yes' AND verified_correct='yes' AND usable_for_current_version='yes') AS latest_independent_count,
      count(*) FILTER(WHERE attempt_at<latest_attempt AND verified_correct='no') AS historical_incorrect_count,
      count(*) FILTER(WHERE attempt_at<latest_attempt AND independent_attempt='yes' AND verified_correct='yes') AS historical_success_count,
      count(*) FILTER(WHERE version_applicability='exact') AS exact_count,
      count(*) FILTER(WHERE version_applicability='equivalent_confirmed') AS equivalent_count,
      count(*) FILTER(WHERE version_applicability='changed_needs_check') AS changed_count,
      count(*) FILTER(WHERE version_applicability='version_unknown') AS version_unknown_count,
      count(*) FILTER(WHERE version_applicability='unavailable') AS unavailable_count,
      count(*) FILTER(WHERE verified_correct='unknown') AS unverified_count,array_agg(DISTINCT verdict_source) AS evidence_sources,
      jsonb_agg(jsonb_build_object('observationId',id,'rootId',current_root_id,'attemptAt',attempt_at,'versionApplicability',version_applicability,
        'eligibility',jsonb_build_object('independentAttempt',independent_attempt,'verifiedCorrect',verified_correct,'usableForCurrentVersion',usable_for_current_version,
          'usableForDelayedCheck',usable_for_delayed_check,'reasonCodes',reason_codes,'policyVersion',${stamp.policyVersion}::text)) ORDER BY display_rank)
        FILTER(WHERE display_rank<=20) AS representatives
      FROM ranked GROUP BY skill_label,requirement_key` : [];
    const activityRows = selected.length ? await tx`SELECT a.skill_label,a.requirement_key,count(*) FILTER(WHERE status='accepted') AS accepted_count,
      count(*) FILTER(WHERE status='in_progress') AS in_progress_count,count(*) FILTER(WHERE due) AS due_count
      FROM (${activitiesQuery(tx, scope, input.courseId, evaluatedAt)}) a
      WHERE EXISTS(SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(selected)}::text::jsonb) AS g("skillLabel" text,"requirementKey" text)
        WHERE g."skillLabel"=a.skill_label AND g."requirementKey" IS NOT DISTINCT FROM a.requirement_key) GROUP BY a.skill_label,a.requirement_key` : [];
    const index = (items: typeof rows) => new Map(items.map(row => [groupKey({ skillLabel: String(row.skill_label), requirementKey: row.requirement_key == null ? null : String(row.requirement_key) }), row]));
    const metrics = index(rows), activities = index(activityRows);
    const groups: LearningSummaryAggregate[] = selected.map(key => {
      const row = metrics.get(groupKey(key)), activity = activities.get(groupKey(key));
      return { identity: { courseId: input.courseId, ...key }, sampleCount: Number(row?.sample_count ?? 0),
        lastObservedAt: row?.last_observed_at ? new Date(row.last_observed_at as string | Date).toISOString() : null,
        latestAttemptAt: row?.latest_attempt_at == null ? null : Number(row.latest_attempt_at), latestAttemptCount: Number(row?.latest_attempt_count ?? 0),
        independentVerifiedCurrentCount: Number(row?.independent_count ?? 0), latestIndependentVerifiedCurrentCount: Number(row?.latest_independent_count ?? 0),
        historicalSuccessCount: Number(row?.historical_success_count ?? 0),
        applicabilityCounts: { exact: Number(row?.exact_count ?? 0), equivalent_confirmed: Number(row?.equivalent_count ?? 0),
          changed_needs_check: Number(row?.changed_count ?? 0), version_unknown: Number(row?.version_unknown_count ?? 0), unavailable: Number(row?.unavailable_count ?? 0) },
        historicalIncorrectCount: Number(row?.historical_incorrect_count ?? 0), unverifiedCount: Number(row?.unverified_count ?? 0),
        evidenceSources: (row?.evidence_sources ?? []) as LearningSummaryAggregate["evidenceSources"],
        representatives: (row?.representatives ?? []) as LearningSummaryAggregate["representatives"],
        openChecks: { acceptedCount: Number(activity?.accepted_count ?? 0), inProgressCount: Number(activity?.in_progress_count ?? 0), dueCount: Number(activity?.due_count ?? 0) } };
    });
    const nextCursor = keys.length > input.limit ? encodeLearningSummaryCursor({ ...stamp, after: selected.at(-1)! }) : null;
    return { selected, stamp, page: { status: "ready", groups, snapshotRevision: stamp.snapshotRevision, nextCursor, evaluatedAt, pendingProjectionCount: 0 } satisfies CourseLearningSummaryPage };
  });
}

/** Complete groups are aggregated before representative limits; bounded repairs progress during this awaited request. */
export async function readOpeningCourseLearningSummary(sql: Sql, scope: Scope, raw: CourseLearningSummaryInput): Promise<CourseLearningSummaryPage> {
  const input = courseLearningSummaryInputSchema.parse(raw), cursor = input.groupCursor ? decodeLearningSummaryCursor(input.groupCursor) : null;
  if (cursor && (cursor.workspaceId !== scope.workspaceId || cursor.ownerUserId !== scope.ownerUserId || cursor.courseId !== input.courseId || cursor.limit !== input.limit)) {
    throw learningError("VALIDATION", "learning summary cursor scope or page size mismatch");
  }
  const evaluatedAt = cursor?.evaluatedAt ?? new Date().toISOString();
  let result = await readPage(sql, scope, input, cursor, evaluatedAt);
  if (result.page.pendingProjectionCount) {
    await repairOpeningLearningEligibility(sql, scope, { courseId: input.courseId, groups: result.selected });
    result = await readPage(sql, scope, input, result.stamp, evaluatedAt);
  }
  // Observe any committed privacy change after the short snapshot; never claim network-time atomicity.
  const [owner] = await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!owner || Number(owner.privacy_epoch) !== result.stamp.privacyEpoch) throw learningError("CONFLICT", "learning summary privacy changed; restart group pagination");
  return courseLearningSummaryPageSchema.parse(result.page);
}
