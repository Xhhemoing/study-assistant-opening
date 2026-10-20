import { localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { systemQueryAuthorizationSchema, type Scope, type SystemQueryAuthorization } from "@aistudy/contracts";
import { contextSourceRefsIncluded, mergeContextSourceRefs, parseContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";
import { withSystemQueryReadDeadline } from "./opening-system-query-deadline";

export class SystemQueryPermissionError extends Error {
  constructor() { super("没有当前工作区记录的读取权限。"); this.name = "SystemQueryPermissionError"; }
}

export function systemQueryOwnerGrant(scope: Scope, epoch: number, purpose: SystemQueryAuthorization["purpose"]): SystemQueryAuthorization {
  return systemQueryAuthorizationSchema.parse({ workspaceId: scope.workspaceId, principalId: scope.ownerUserId,
    role: "workspace_owner", purpose, permissionRevision: `owner:${scope.ownerUserId}:privacy:${epoch}` });
}
export async function readOpeningSystemQueryAuthorization(sql: Sql, scope: Scope, purpose: SystemQueryAuthorization["purpose"] = "system_record_lookup", outerSignal = new AbortController().signal) {
  return withSystemQueryReadDeadline(outerSignal, async signal => {
  const [owner] = await sql.begin("read only", async tx => {
    await tx`SET LOCAL statement_timeout='2000ms'`;
    return tx`SELECT w.privacy_epoch,p.planning_settings FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
  });
  if (signal.aborted) throw new Error("system query cancelled");
  if (!owner) throw new SystemQueryPermissionError();
  const timeZone = resolveWorkspaceTimeZone(owner.planning_settings?.timeZone);
  const localDate = localDateKeyInZone(new Date(), timeZone);
  return { authorization: systemQueryOwnerGrant(scope, Number(owner.privacy_epoch), purpose), privacyEpoch: Number(owner.privacy_epoch), localDate, clock: { timeZone, today: localDate } };
  });
}

/** Complete ancestry only; an omitted/unknown captured version can never be replaced with today's version. */
export async function readSystemQueryAncestry(tx: TransactionSql, scope: Scope, rootIds: string[]) {
  if (!rootIds.length) return { complete: true, admitted: new Map<string, ContextSourceRef[]>() };
  const rows = await tx`SELECT COALESCE(root_observation_id,id) AS root_id,source_ids,source_versions,reference_source_id,reference_check
    FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND COALESCE(root_observation_id,id)=ANY(${rootIds}::uuid[]) ORDER BY COALESCE(root_observation_id,id),id LIMIT 1001`;
  if (rows.length > 1000) return { complete: false, admitted: new Map<string, ContextSourceRef[]>() };
  const refs = new Map<string, ContextSourceRef[] | null>();
  for (const row of rows) {
    const rootId = String(row.root_id);
    const versions = row.source_versions && typeof row.source_versions === "object" ? row.source_versions as Record<string, unknown> : {};
    const ids = [...new Set([...(row.source_ids ?? []) as string[], ...Object.keys(versions),
      ...[row.reference_source_id, row.reference_check?.referenceId].filter((id): id is string => typeof id === "string")])];
    const parsed = parseContextSourceRefs(ids.map(sourceId => ({ sourceId, sourceVersion: versions[sourceId] })));
    const previous = refs.get(rootId);
    refs.set(rootId, previous === null || parsed === null ? null : mergeContextSourceRefs(previous ?? [], parsed));
  }
  const batch = [...refs].filter((entry): entry is [string, ContextSourceRef[]] => entry[1] !== null && entry[1].length <= 64)
    .map(([rootId, sourceRefs]) => ({ rootId, refs: sourceRefs }));
  const checked = batch.length ? await tx`SELECT batch."rootId",batch.refs,${contextSourceRefsIncluded(tx, scope.workspaceId, tx`batch.refs`)} AS admitted
    FROM jsonb_to_recordset(${JSON.stringify(batch)}::text::jsonb) AS batch("rootId" uuid,refs jsonb)` : [];
  return { complete: true, admitted: new Map(checked.filter(row => row.admitted).map(row => [String(row.rootId), parseContextSourceRefs(row.refs)!])) };
}
