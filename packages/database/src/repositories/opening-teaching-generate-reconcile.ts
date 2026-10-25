import type { Sql, TransactionSql } from "postgres";
import type { Scope, TeachingActivity } from "@aistudy/contracts";
import { failOpeningJob } from "./opening-job-failure";
import { lockLearningOwner } from "./opening-learning-facts";

type GenerateStatus = TeachingActivity["generateStatus"];
type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";

export type TeachingGenerateReconcileInput = {
  generateStatus: GenerateStatus;
  contentVersion: number;
  /** Latest compile-teaching-unit job for the activity; null when there is none. */
  job: { state: JobState; updatedAtMs: number; expectedContentVersion: number | null } | null;
  nowMs: number;
  staleMs: number;
};

export type TeachingGenerateReconcileDecision =
  | { action: "none" }
  /** The job never ran or stopped heart-beating: end it (activity follows). */
  | { action: "expire_job"; jobState: "queued" | "running" }
  /** The job is gone or already over but the activity still says in flight. */
  | { action: "mark_activity"; generateStatus: Extract<GenerateStatus, "failed" | "cancelled" | "needs_check">; reason: string };

/**
 * Pure: should an in-flight lesson (generate_status queued|generating) be ended?
 * The UI shows 正在准备讲解 for as long as the status says in flight, and only
 * offers 重新生成 once it is terminal, so a dead job must never leave it in flight.
 */
export function decideTeachingGenerateReconcile(input: TeachingGenerateReconcileInput): TeachingGenerateReconcileDecision {
  if (input.generateStatus !== "queued" && input.generateStatus !== "generating") return { action: "none" };
  const { job } = input;
  if (!job) return { action: "mark_activity", generateStatus: "failed", reason: "job_missing" };
  if (job.state === "queued" || job.state === "running") {
    // updated_at is the claim/heartbeat time for a running job, the enqueue time for a queued one.
    return input.nowMs - job.updatedAtMs >= input.staleMs ? { action: "expire_job", jobState: job.state } : { action: "none" };
  }
  if (job.state === "cancelled") return { action: "mark_activity", generateStatus: "cancelled", reason: "job_cancelled" };
  if (job.state === "succeeded") {
    // Success that lost its status fence (or a replay): content published -> readable.
    const published = job.expectedContentVersion !== null && input.contentVersion > job.expectedContentVersion;
    return published
      ? { action: "mark_activity", generateStatus: "needs_check", reason: "job_succeeded" }
      : { action: "mark_activity", generateStatus: "failed", reason: "job_succeeded_without_content" };
  }
  return { action: "mark_activity", generateStatus: "failed", reason: `job_${job.state}` };
}

type ActivityRow = { generate_status: GenerateStatus; content_version: number };
type JobRow = { id: string; state: JobState; updated_at: Date | string; expected_content_version: string | null; now: Date | string };

async function latestCompileJob(db: Sql | TransactionSql, scope: Scope, activityId: string): Promise<JobRow | undefined> {
  const [job] = await db<JobRow[]>`
    SELECT j.id, j.state, j.updated_at, j.payload->>'expectedContentVersion' AS expected_content_version, now() AS now
    FROM opening_jobs j
    WHERE j.workspace_id = ${scope.workspaceId} AND j.owner_user_id = ${scope.ownerUserId}
      AND j.kind = 'compile-teaching-unit' AND j.payload->>'activityId' = ${activityId}
    ORDER BY j.created_at DESC, j.id DESC LIMIT 1`;
  return job;
}

function decisionInput(activity: ActivityRow, job: JobRow | undefined, nowMs: number, staleMs: number): TeachingGenerateReconcileInput {
  const expected = job?.expected_content_version == null ? NaN : Number(job.expected_content_version);
  return {
    generateStatus: activity.generate_status,
    contentVersion: Number(activity.content_version),
    job: job ? {
      state: job.state,
      updatedAtMs: new Date(job.updated_at).getTime(),
      expectedContentVersion: Number.isInteger(expected) ? expected : null,
    } : null,
    nowMs,
    staleMs,
  };
}

export type TeachingGenerateReconcileResult = {
  changed: boolean;
  generateStatus: GenerateStatus | null;
  reason?: string;
};

/**
 * Server-side reconciliation of one activity's in-flight generation. Safe to call on
 * every read: it only writes when the latest compile job is missing, over, or stale,
 * and every write is fenced (job CAS on state/updated_at, activity row lock + status).
 */
export async function reconcileTeachingGenerate(
  sql: Sql,
  scope: Scope,
  activityId: string,
  options: { staleMs: number },
): Promise<TeachingGenerateReconcileResult> {
  let reason: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [activity] = await sql<ActivityRow[]>`
      SELECT generate_status, content_version FROM opening_teaching_activities
      WHERE id = ${activityId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
    if (!activity) return { changed: false, generateStatus: null };
    if (activity.generate_status !== "queued" && activity.generate_status !== "generating") {
      return { changed: reason !== undefined, generateStatus: activity.generate_status, ...(reason ? { reason } : {}) };
    }
    const job = await latestCompileJob(sql, scope, activityId);
    const nowMs = job ? new Date(job.now).getTime() : Date.now();
    const decision = decideTeachingGenerateReconcile(decisionInput(activity, job, nowMs, options.staleMs));
    if (decision.action === "none") return { changed: false, generateStatus: activity.generate_status };
    if (decision.action === "expire_job" && job) {
      reason = `job_${decision.jobState}_stale`;
      // Same terminal path as worker crash recovery: fails the job and, under its own
      // fence, the activity. A queued job is failed (it never ran, nothing was spent);
      // a running job without heartbeat becomes outcome_unknown (never re-executed).
      await failOpeningJob(sql, job.id, decision.jobState === "queued"
        ? { error: "compile job was never started; marked failed after the stale timeout", code: "TEACHING_GENERATE_STALE", retryable: false }
        : { error: "worker execution interrupted; outcome requires reconciliation", code: "TEACHING_GENERATE_STALE", retryable: false },
      decision.jobState === "queued" ? "failed" : "outcome_unknown",
      { expectedState: decision.jobState, staleBefore: new Date(nowMs - options.staleMs + 1) });
      continue; // re-read: the job is now terminal, fence the activity if it is still in flight
    }
    if (decision.action !== "mark_activity") return { changed: false, generateStatus: activity.generate_status };
    const updated = await sql.begin(async (tx) => {
      await lockLearningOwner(tx, scope);
      const [locked] = await tx<ActivityRow[]>`
        SELECT generate_status, content_version FROM opening_teaching_activities
        WHERE id = ${activityId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        FOR UPDATE`;
      if (!locked) return null;
      // Re-decide under the lock: a new compile request may have enqueued a fresh job.
      const current = await latestCompileJob(tx, scope, activityId);
      const again = decideTeachingGenerateReconcile(decisionInput(locked, current, current ? new Date(current.now).getTime() : nowMs, options.staleMs));
      if (again.action !== "mark_activity" || (current?.id ?? null) !== (job?.id ?? null)) return null;
      const [row] = await tx<{ generate_status: GenerateStatus }[]>`
        UPDATE opening_teaching_activities SET generate_status = ${again.generateStatus}, updated_at = now()
        WHERE id = ${activityId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND generate_status IN ('queued', 'generating')
        RETURNING generate_status`;
      return row ? { status: row.generate_status, reason: again.reason } : null;
    });
    if (updated) return { changed: true, generateStatus: updated.status, reason: reason ?? updated.reason };
    break; // lost the race to a newer compile request; leave it alone
  }
  const [final] = await sql<ActivityRow[]>`
    SELECT generate_status, content_version FROM opening_teaching_activities
    WHERE id = ${activityId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
  return { changed: reason !== undefined, generateStatus: final?.generate_status ?? null, ...(reason ? { reason } : {}) };
}

/**
 * Worker sweep: reconcile in-flight lessons untouched for at least staleMs. Read-time
 * reconciliation covers the learner who is looking; this covers everyone else and a
 * web tier that never reads the activity again.
 */
export async function reconcileStaleTeachingGenerations(
  sql: Sql,
  options: { staleMs: number; limit?: number },
): Promise<number> {
  const staleSeconds = Math.floor(options.staleMs / 1000);
  const rows = await sql<{ id: string; workspace_id: string; owner_user_id: string }[]>`
    SELECT id, workspace_id, owner_user_id FROM opening_teaching_activities
    WHERE generate_status IN ('queued', 'generating')
      AND updated_at < now() - make_interval(secs => ${staleSeconds})
    ORDER BY updated_at LIMIT ${options.limit ?? 50}`;
  let reconciled = 0;
  for (const row of rows) {
    const result = await reconcileTeachingGenerate(sql, { workspaceId: row.workspace_id, ownerUserId: row.owner_user_id }, row.id, options);
    if (result.changed) reconciled += 1;
  }
  return reconciled;
}
