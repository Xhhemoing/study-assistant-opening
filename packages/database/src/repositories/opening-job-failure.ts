import type { Sql } from "postgres";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";

/**
 * claim() marks a parse source `running` (G7). When the job ends without
 * projecting a result (cancelled, or a failure the fences refuse), drop that
 * marker unless a parse job for the source is still running, so the inbox
 * never spins on a job that no longer exists. Only `running` → `not_started`
 * (no result, no error) is written, so it is keyed on the source alone: a job
 * whose workspace changed after the claim still clears the original marker.
 */
export async function releaseOpeningParseClaim(tx: Sql, payload: unknown): Promise<void> {
  const sourceId = payload && typeof payload === "object" && "sourceId" in payload ? payload.sourceId : null;
  if (typeof sourceId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) return;
  await tx`
    UPDATE opening_sources s SET parse_state = 'not_started', updated_at = now()
    WHERE s.id = ${sourceId} AND s.parse_state = 'running'
      AND NOT EXISTS (SELECT 1 FROM opening_jobs j
        WHERE j.state = 'running' AND j.kind IN ('parse', 'parse-media') AND j.payload->>'sourceId' = ${sourceId})`;
}

/** Commit a terminal job error and its source status together, under the privacy lock. */
export async function failOpeningJob(sql: Sql, id: string, value: unknown,
  state: "failed" | "outcome_unknown" = "failed",
  options: { claimToken?: string | null; staleBefore?: Date; expectedState?: "queued" | "running" } = {}): Promise<boolean> {
  // Only this local signal maps identity drift to false; SQL/lock errors propagate.
  const identityChanged = Symbol("job failure workspace identity changed");
  return sql.begin(async (tx) => {
    // Canonical owner is coordination identity, not the job/payload's authority.
    // Ordinary discovery must precede history, then the original graph locks.
    const [candidate] = await tx<{ id: string; owner_user_id: string }[]>`
      SELECT w.id, w.owner_user_id FROM workspaces w JOIN opening_jobs j ON j.workspace_id = w.id
      WHERE j.id = ${id}`;
    if (!candidate) return false;
    try {
      await lockWorkspaceLearningHistory(tx, { workspaceId: candidate.id, ownerUserId: candidate.owner_user_id });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND" && error.message === "workspace not found") {
        const [current] = await tx`SELECT id FROM workspaces
          WHERE id = ${candidate.id} AND owner_user_id = ${candidate.owner_user_id}`;
        if (!current) throw identityChanged;
      }
      throw error;
    }
    // Match privacy deletion's workspace-first graph lock order, after history.
    const workspaces = await tx<{ id: string; owner_user_id: string; privacy_epoch: number }[]>`
      SELECT w.id, w.owner_user_id, w.privacy_epoch
      FROM workspaces w JOIN opening_jobs j ON j.workspace_id = w.id
      WHERE j.id = ${id} AND w.id = ${candidate.id} FOR UPDATE OF w`;
    const workspace = workspaces[0];
    if (!workspace || workspace.id !== candidate.id || workspace.owner_user_id !== candidate.owner_user_id) throw identityChanged;
    // Conservative same-scope cleanup only. Hold the source lock through commit
    // so it cannot move after the check and before the shared helper writes.
    const releaseClaim = async (payload: unknown): Promise<void> => {
      const sourceId = payload && typeof payload === "object" && "sourceId" in payload ? payload.sourceId : null;
      if (typeof sourceId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) return;
      const [source] = await tx`SELECT id FROM opening_sources
        WHERE id = ${sourceId} AND workspace_id = ${workspace.id} FOR UPDATE`;
      if (source) await releaseOpeningParseClaim(tx, payload);
    };
    const jobs = await tx<{
      kind: string; owner_user_id: string; payload: unknown; privacy_epoch: number;
    }[]>`
      UPDATE opening_jobs SET state = ${state}, result = ${tx.json(value as never)}, updated_at = now()
      WHERE id = ${id} AND workspace_id = ${workspace.id} AND state = ${options.expectedState ?? "running"}
        AND (${!Object.hasOwn(options, "claimToken")} OR claim_token IS NOT DISTINCT FROM ${options.claimToken ?? null}::uuid)
        AND (${options.staleBefore ?? null}::timestamptz IS NULL OR updated_at < ${options.staleBefore ?? null}::timestamptz)
      RETURNING kind, owner_user_id, payload, privacy_epoch`;
    const job = jobs[0];
    if (!job) {
      // Lost the CAS (e.g. cancelled mid-run): never project, but drop our claim marker.
      const [ended] = await tx<{ kind: string; payload: unknown }[]>`
        SELECT kind, payload FROM opening_jobs WHERE id = ${id} AND workspace_id = ${workspace.id}`;
      if (ended && (ended.kind === "parse" || ended.kind === "parse-media")) {
        await releaseClaim(ended.payload);
      }
      return false;
    }
    if (job.kind === "compile-teaching-unit" && job.payload && typeof job.payload === "object") {
      const payload = job.payload as Record<string, unknown>;
      if (typeof payload.activityId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.activityId)
        && typeof payload.expectedContentVersion === "number" && Number.isInteger(payload.expectedContentVersion)) {
        await tx`UPDATE opening_teaching_activities SET generate_status = 'failed', updated_at = now()
          WHERE id = ${payload.activityId} AND workspace_id = ${workspace.id} AND owner_user_id = ${job.owner_user_id}
            AND content_version = ${payload.expectedContentVersion} AND generate_status IN ('queued', 'generating')`;
      }
    }
    if (job.kind !== "parse" && job.kind !== "parse-media") return true;
    if (job.owner_user_id !== workspace.owner_user_id) {
      await releaseClaim(job.payload);
      return true;
    }
    const sourceId = job.payload && typeof job.payload === "object" && "sourceId" in job.payload
      ? job.payload.sourceId : null;
    if (typeof sourceId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) return true;
    // Parse jobs carry the source version they target (payload.sourceVersion). A failure
    // for an older version must never overwrite a newer version's state. Jobs without the
    // field (created before it existed) stay unfenced, as before.
    const rawVersion = job.payload && typeof job.payload === "object" && "sourceVersion" in job.payload
      ? job.payload.sourceVersion : null;
    const sourceVersion = typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0 ? rawVersion : null;
    // The job epoch fences privacy changes; source version is independent.
    // Never replace ready/new-version/excluded state. Excluded rows receive a
    // terminal privacy error below so the inbox does not spin forever.
    const stale = Number(job.privacy_epoch) !== Number(workspace.privacy_epoch);
    const retryable = value !== null && typeof value === "object" && "retryable" in value && value.retryable === true;
    const error = stale
      ? { code: "PARSE_STALE", message: "隐私设置已变化，解析结果已丢弃。", retryable: false }
      : state === "outcome_unknown"
        ? { code: "PARSE_OUTCOME_UNKNOWN", message: "转写结果尚未确认，为避免重复计费未重发；原件仍已保存。", retryable: false }
        : { code: "PARSE_FAILED", message: "材料解析失败，原件仍已保存。", retryable };
    if (stale) {
      await tx`
        UPDATE opening_sources s SET parse_state = 'failed', error = ${tx.json(error)}, updated_at = now()
        WHERE s.id = ${sourceId} AND s.workspace_id = ${workspace.id}
          AND s.upload_state = 'uploaded'
          AND (${sourceVersion}::integer IS NULL OR s.version = ${sourceVersion}::integer)
          AND s.parse_state IN ('not_started', 'queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id)`;
      await tx`
        UPDATE opening_sources s SET parse_state = 'failed', error = ${tx.json({ code: "PRIVACY_EXCLUDED", message: "材料已从学习上下文中排除。", retryable: false })}, updated_at = now()
        WHERE s.id = ${sourceId} AND s.workspace_id = ${workspace.id}
          AND s.upload_state = 'uploaded'
          AND (${sourceVersion}::integer IS NULL OR s.version = ${sourceVersion}::integer)
          AND s.parse_state IN ('not_started', 'queued', 'running')
          AND EXISTS (SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id)`;
    } else {
      await tx`
        UPDATE opening_sources s SET parse_state = 'failed', error = ${tx.json(error)}, updated_at = now()
        WHERE s.id = ${sourceId} AND s.workspace_id = ${workspace.id}
          AND s.upload_state = 'uploaded'
          AND (${sourceVersion}::integer IS NULL OR s.version = ${sourceVersion}::integer)
          AND s.parse_state IN ('not_started', 'queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id)`;
    }
    // Fenced-out failures (new version, exclusion) leave the claim marker behind.
    await releaseClaim(job.payload);
    return true;
  }).catch((error: unknown) => {
    if (error === identityChanged) return false;
    throw error;
  });
}
