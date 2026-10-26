import type { Sql } from "postgres";
import { loopMetricsQuerySchema, suggestedTaskSchema, type LoopMetricsReport, type Scope } from "@aistudy/contracts";
import { addLocalDays, buildLoopMetricsReport, evaluateEvidenceEligibility, localDateKeyInZone, resolveLocalDayBounds,
  resolveWorkspaceTimeZone, type LoopMetricsInput } from "@aistudy/domain";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { mapLearningObservation } from "./opening-learning-facts";
import { OpeningPlanError } from "./opening-plan-error";
import { readOpeningPlanFeedbackSummary } from "./opening-plan-feedback";

const MAX_METRIC_ROWS = 2_000;

/** Pure reads in one snapshot: never invokes summary repair, budget reconciliation, models or writes. */
export async function readOpeningLoopMetrics(sql: Sql, scope: Scope, options: { days?: unknown; now?: Date } = {}): Promise<LoopMetricsReport> {
  const { days } = loopMetricsQuerySchema.parse({ days: options.days });
  const now = options.now ?? new Date();
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [workspace] = await tx`SELECT p.planning_settings FROM workspaces w
      LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
      WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
    if (!workspace) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
    const settings = workspace.planning_settings as { timeZone?: unknown } | null;
    const storedZone = settings?.timeZone;
    if (storedZone != null && typeof storedZone !== "string") throw new OpeningPlanError("VALIDATION", "invalid workspace time zone");
    const timeZone = resolveWorkspaceTimeZone(storedZone);
    const today = localDateKeyInZone(now, timeZone);
    const from = resolveLocalDayBounds(addLocalDays(today, 1 - days), timeZone).dayStart;
    const jobs = await tx`SELECT kind,state,count(*)::int AS n FROM opening_jobs
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND created_at>=${from} AND created_at<${now} GROUP BY kind,state`;
    // A zero-cost TTL record is still provisional until a late receipt exists.
    const budget = await tx`SELECT category,count(*)::int AS n,COALESCE(sum(amount_cents),0)::bigint AS cents FROM (
      SELECT b.amount_cents,CASE
        WHEN b.state='released' THEN 'released'
        WHEN b.state='reserved' AND b.outcome_unknown_at IS NOT NULL THEN 'unknown_reserved'
        WHEN b.state='reserved' THEN 'active_reserved'
        WHEN b.state='completed' AND b.reconciled_at IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM opening_budget_reconcile_events e WHERE e.reservation_id=b.id
            AND e.workspace_id=b.workspace_id AND e.kind='late_receipt') THEN 'ttl_provisional'
        ELSE 'settled' END AS category
      FROM opening_budget_reservations b WHERE b.workspace_id=${scope.workspaceId}
        AND b.created_at>=${from} AND b.created_at<${now}) ledger GROUP BY category`;
    // Evaluation facts are immutable work records. Later head replacement/retraction
    // must not erase an actual evaluator invocation, or duplicate an inherited fact.
    const [evaluations] = await tx`SELECT count(*)::int AS recorded,
      count(*) FILTER(WHERE server_evaluation->>'decision'='abstain')::int AS abstained
      FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND server_evaluation->>'observationId'=id::text
        AND server_evaluation->>'decision' IN ('correct','incorrect','abstain')
        AND recorded_at>=${from} AND recorded_at<${now}`;
    const heads = await tx`SELECT o.*,COALESCE(root.submitted_at,root.occurred_at) AS cohort_at
      FROM opening_learning_observations o
      JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
        AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
        AND COALESCE(root.effective_head_id,root.id)=o.id
      LEFT JOIN courses c ON c.id=o.course_id AND c.workspace_id=o.workspace_id
      WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
        AND (o.course_id IS NULL OR (c.id IS NOT NULL AND c.archived_at IS NULL))
        AND COALESCE(o.revision_kind,'original')<>'retract'
        AND COALESCE(root.submitted_at,root.occurred_at)>=${from}
        AND COALESCE(root.submitted_at,root.occurred_at)<${now}
      ORDER BY COALESCE(root.submitted_at,root.occurred_at),root.id LIMIT ${MAX_METRIC_ROWS + 1}`;
    const learningComplete = heads.length <= MAX_METRIC_ROWS;
    const observations: LoopMetricsInput["observations"][number][] = [];
    let privacyExcludedCount = 0;
    if (learningComplete) {
      const mapped = heads.map(mapLearningObservation);
      const contexts = await readOpeningLearningEvidenceContexts(tx, scope, mapped);
      for (let index = 0; index < mapped.length; index++) {
        const observation = mapped[index]!, input = contexts[observation.id]!;
        if (input.context.version?.applicability === "privacy_excluded") { privacyExcludedCount++; continue; }
        observations.push({
          identity: JSON.stringify([observation.courseId, observation.requirementKey ?? null, observation.skillLabel]),
          occurredAt: new Date(heads[index]!.cohort_at as string | Date).toISOString(),
          verificationSource: observation.verdictSource,
          eligibility: evaluateEvidenceEligibility(input.observation, input.context),
        });
      }
    }
    const feedback = await readOpeningPlanFeedbackSummary(tx as unknown as Sql, scope, from, now);
    const suggestionFeedback = await tx`SELECT reason,count(*)::int AS n FROM opening_suggestion_feedback
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND recorded_at>=${from} AND recorded_at<${now} GROUP BY reason`;
    const [coach] = await tx`SELECT count(*)::int AS accepted,
      count(*) FILTER(WHERE undone_at IS NOT NULL AND undone_at<=${now})::int AS undone
      FROM opening_plan_acceptances WHERE workspace_id=${scope.workspaceId} AND source='coach'
        AND created_at>=${from} AND created_at<${now}`;
    const [replans] = await tx`SELECT count(*)::int AS created,
      count(*) FILTER(WHERE status='accepted')::int AS accepted,count(*) FILTER(WHERE status='rejected')::int AS rejected
      FROM opening_plan_drafts WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND strategy_version='local-replan-v1' AND origin<>'agent' AND created_at>=${from} AND created_at<${now}`;
    const drafts = await tx`SELECT suggested_tasks FROM opening_plan_drafts
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND origin<>'agent' AND created_at>=${from} AND created_at<${now}
      ORDER BY created_at,id LIMIT ${MAX_METRIC_ROWS + 1}`;
    let suggestionsComplete = drafts.length <= MAX_METRIC_ROWS;
    const generated = new Map<string, number>();
    for (const draft of drafts.slice(0, MAX_METRIC_ROWS)) {
      const parsed = suggestedTaskSchema.array().safeParse(draft.suggested_tasks);
      if (!parsed.success) { suggestionsComplete = false; continue; }
      for (const suggestion of parsed.data) if (!generated.has(suggestion.key)) generated.set(suggestion.key, suggestion.minutes);
    }
    const accepted = generated.size ? await tx`SELECT DISTINCT client_key FROM opening_tasks
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND origin='planner'
        AND client_key=ANY(${[...generated.keys()]}::text[]) AND created_at<${now}` : [];
    const [timing] = await tx`SELECT count(*)::int AS samples,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) AS median,
      percentile_cont(0.9) WITHIN GROUP(ORDER BY duration_ms) AS p90
      FROM opening_learning_experience_events WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND kind='first_text' AND recorded_at>=${from} AND recorded_at<${now}`;
    const [stages] = await tx`WITH executions AS (
      SELECT e.target_id, e.execution_id,
        max(e.observed_at) FILTER(WHERE e.kind='tutor_claimed') AS claimed_at,
        max(e.duration_ms) FILTER(WHERE e.kind='tutor_first_text') AS model_ms,
        max(e.duration_ms) FILTER(WHERE e.kind='tutor_first_chunk') AS redis_ms
      FROM opening_learning_experience_events e
      WHERE e.workspace_id=${scope.workspaceId} AND e.owner_user_id=${scope.ownerUserId}
        AND e.execution_id IS NOT NULL AND e.recorded_at>=${from} AND e.recorded_at<${now}
        AND e.kind IN ('tutor_claimed','tutor_first_text','tutor_first_chunk')
      GROUP BY e.target_id,e.execution_id
    ), durations AS (
      SELECT extract(epoch FROM (e.claimed_at-j.created_at))*1000 AS queue_ms,e.model_ms,e.redis_ms
      FROM executions e JOIN opening_tutor_jobs j ON j.id=e.target_id AND j.workspace_id=${scope.workspaceId}
    ) SELECT
      count(queue_ms) FILTER(WHERE queue_ms>=0)::int AS queue_samples,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY queue_ms) FILTER(WHERE queue_ms>=0) AS queue_p50,
      percentile_cont(0.9) WITHIN GROUP(ORDER BY queue_ms) FILTER(WHERE queue_ms>=0) AS queue_p90,
      count(model_ms)::int AS model_samples,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY model_ms) AS model_p50,
      percentile_cont(0.9) WITHIN GROUP(ORDER BY model_ms) AS model_p90,
      count(redis_ms)::int AS redis_samples,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY redis_ms) AS redis_p50,
      percentile_cont(0.9) WITHIN GROUP(ORDER BY redis_ms) AS redis_p90 FROM durations`;
    const distribution = (key: "queue" | "model" | "redis") => ({ samples: Number(stages?.[`${key}_samples`] ?? 0),
      p50Ms: stages?.[`${key}_p50`] == null ? null : Number(stages[`${key}_p50`]),
      p90Ms: stages?.[`${key}_p90`] == null ? null : Number(stages[`${key}_p90`]) });
    const [experience] = await tx`SELECT count(*)::int AS shown,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM opening_learning_experience_events accepted
        WHERE accepted.workspace_id=shown.workspace_id AND accepted.owner_user_id=shown.owner_user_id
          AND accepted.kind='next_step_started' AND accepted.target_type=shown.target_type AND accepted.target_id=shown.target_id
          AND accepted.local_day=shown.local_day AND accepted.recorded_at>=shown.recorded_at AND accepted.recorded_at<${now}))::int AS started
      FROM opening_learning_experience_events shown WHERE shown.workspace_id=${scope.workspaceId} AND shown.owner_user_id=${scope.ownerUserId}
        AND shown.kind='next_step_shown' AND shown.recorded_at>=${from} AND shown.recorded_at<${now}`;
    return buildLoopMetricsReport({ asOf: now.toISOString(), windowStart: from.toISOString(), windowDays: days, timeZone,
      jobs: jobs.map(row => ({ kind: String(row.kind), state: String(row.state), count: Number(row.n) })),
      budget: budget.map(row => ({ category: row.category as LoopMetricsInput["budget"][number]["category"], count: Number(row.n), cents: Number(row.cents) })),
      observations, learningComplete, privacyExcludedCount, feedback,
      experience: { firstTextSamples: Number(timing?.samples ?? 0), firstTextMedianMs: timing?.median == null ? null : Number(timing.median),
        firstTextP90Ms: timing?.p90 == null ? null : Number(timing.p90),
        shown: Number(experience?.shown ?? 0), started: Number(experience?.started ?? 0) },
      tutorTiming: { queue: distribution("queue"), model: distribution("model"), redis: distribution("redis") },
      suggestions: { complete: suggestionsComplete, generated: generated.size, accepted: accepted.length,
        minutes: [...generated.values()].reduce((sum, n) => sum + n, 0) },
      suggestionFeedback: suggestionFeedback.map(row => ({ reason: row.reason == null ? "missing" : String(row.reason), count: Number(row.n) })),
      coach: { accepted: Number(coach?.accepted ?? 0), undone: Number(coach?.undone ?? 0) },
      replans: { created: Number(replans?.created ?? 0), accepted: Number(replans?.accepted ?? 0), rejected: Number(replans?.rejected ?? 0) },
      evaluations: { recorded: Number(evaluations?.recorded ?? 0), abstained: Number(evaluations?.abstained ?? 0) },
    });
  });
}
