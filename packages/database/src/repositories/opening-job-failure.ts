import type { Sql } from "postgres";

/** Commit the job failure and its source status together, under the privacy lock. */
export async function failOpeningJob(sql: Sql, id: string, value: unknown): Promise<boolean> {
  return sql.begin(async (tx) => {
    // Match privacy deletion's workspace-first lock order. Never lock a job first.
    const workspaces = await tx<{ id: string; owner_user_id: string; privacy_epoch: number }[]>`
      SELECT w.id, w.owner_user_id, w.privacy_epoch
      FROM workspaces w JOIN opening_jobs j ON j.workspace_id = w.id
      WHERE j.id = ${id} FOR UPDATE OF w`;
    const workspace = workspaces[0];
    if (!workspace) return false;
    const jobs = await tx<{
      kind: string; owner_user_id: string; payload: unknown; privacy_epoch: number;
    }[]>`
      UPDATE opening_jobs SET state = 'failed', result = ${tx.json(value as never)}, updated_at = now()
      WHERE id = ${id} AND workspace_id = ${workspace.id} AND state = 'running'
      RETURNING kind, owner_user_id, payload, privacy_epoch`;
    const job = jobs[0];
    if (!job) return false;
    if (job.kind !== "parse" || job.owner_user_id !== workspace.owner_user_id) return true;
    const sourceId = job.payload && typeof job.payload === "object" && "sourceId" in job.payload
      ? job.payload.sourceId : null;
    if (typeof sourceId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) return true;
    // The job epoch fences privacy changes; source version is independent.
    // Never replace ready/new-version/excluded state. Excluded rows receive a
    // terminal privacy error below so the inbox does not spin forever.
    const stale = Number(job.privacy_epoch) !== Number(workspace.privacy_epoch);
    const error = stale
      ? { code: "PARSE_STALE", message: "隐私设置已变化，解析结果已丢弃。", retryable: false }
      : { code: "PARSE_FAILED", message: "材料解析失败，原件仍已保存。", retryable: false };
    if (stale) {
      await tx`
        UPDATE opening_sources s SET parse_state = 'failed', error = ${tx.json(error)}, updated_at = now()
        WHERE s.id = ${sourceId} AND s.workspace_id = ${workspace.id}
          AND s.upload_state = 'uploaded'
          AND s.parse_state IN ('not_started', 'queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id)`;
      await tx`
        UPDATE opening_sources s SET parse_state = 'failed', error = ${tx.json({ code: "PRIVACY_EXCLUDED", message: "材料已从学习上下文中排除。", retryable: false })}, updated_at = now()
        WHERE s.id = ${sourceId} AND s.workspace_id = ${workspace.id}
          AND s.upload_state = 'uploaded'
          AND s.parse_state IN ('not_started', 'queued', 'running')
          AND EXISTS (SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id)`;
    } else {
      await tx`
        UPDATE opening_sources s SET parse_state = 'failed', error = ${tx.json(error)}, updated_at = now()
        WHERE s.id = ${sourceId} AND s.workspace_id = ${workspace.id}
          AND s.upload_state = 'uploaded'
          AND s.parse_state IN ('not_started', 'queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id)`;
    }
    return true;
  });
}
