import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpeningScope } from "./opening-sources";
import { contextSourceRefsIncluded, mergeContextSourceRefs, parseContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";

export type EphemeralProvenanceRepository = {
  resolveHistory(scope: OpeningScope, history: readonly { provenanceId?: string }[], epoch: number): Promise<ContextSourceRef[] | null>;
  record(scope: OpeningScope, input: { requestId: string; privacyEpoch: number; contextSourceRefs: ContextSourceRef[] | null }): Promise<string | null>;
  recordQuery?(scope: OpeningScope, input: { requestId: string; privacyEpoch: number; contextSourceRefs: ContextSourceRef[] }): Promise<string>;
  purgeExpiredQueries?(): Promise<number>;
};
export class EphemeralProvenanceError extends Error {
  constructor(readonly code: "NOT_FOUND" | "PRIVACY_CHANGED", message: string) { super(message); }
}

export function createOpeningEphemeralProvenanceRepository(sql: Sql): EphemeralProvenanceRepository {
  return {
    async purgeExpiredQueries() {
      const rows = await sql`DELETE FROM opening_query_ephemeral_provenance WHERE id IN (
        SELECT id FROM opening_query_ephemeral_provenance WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 1000) RETURNING id`;
      return rows.length;
    },
    async resolveHistory(scope, history, epoch) {
      if (!history.length) return [];
      if (history.some(item => !item.provenanceId)) return null;
      const ids = [...new Set(history.map(item => item.provenanceId!))];
      const rows = await sql`SELECT p.id, p.context_source_refs FROM (
        SELECT id,workspace_id,owner_user_id,privacy_epoch,context_source_refs FROM opening_ephemeral_provenance
        UNION ALL SELECT id,workspace_id,owner_user_id,privacy_epoch,context_source_refs FROM opening_query_ephemeral_provenance WHERE expires_at>now()
        ) p
        JOIN workspaces w ON w.id=p.workspace_id
        WHERE p.id=ANY(${ids}::uuid[]) AND p.workspace_id=${scope.workspaceId}
          AND p.owner_user_id=${scope.ownerUserId} AND w.owner_user_id=${scope.ownerUserId}
          AND p.privacy_epoch=${epoch}
          AND ${contextSourceRefsIncluded(sql, scope.workspaceId, sql`p.context_source_refs`)}`;
      if (rows.length !== ids.length) return null;
      const groups = rows.map(row => parseContextSourceRefs(row.context_source_refs));
      return groups.some(refs => refs === null) ? null : mergeContextSourceRefs(...groups as ContextSourceRef[][]);
    },
    async recordQuery(scope, input) {
      const refs = parseContextSourceRefs(input.contextSourceRefs);
      if (refs === null || refs.length > 256) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query lineage unavailable");
      return sql.begin(async tx => {
        const [owner] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner) throw new EphemeralProvenanceError("NOT_FOUND", "workspace not found");
        if (Number(owner.privacy_epoch) !== input.privacyEpoch) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query privacy changed");
        const [admitted] = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(refs)}::jsonb`, true, true)} AS included`;
        if (!admitted?.included) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query material unavailable");
        const [created] = await tx`INSERT INTO opening_query_ephemeral_provenance(id,workspace_id,owner_user_id,request_id,privacy_epoch,context_source_refs)
          VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${input.requestId},${input.privacyEpoch},${tx.json(refs)})
          ON CONFLICT(workspace_id,owner_user_id,request_id) DO NOTHING RETURNING id`;
        if (created) return String(created.id);
        const [existing] = await tx`SELECT id,privacy_epoch,context_source_refs,expires_at FROM opening_query_ephemeral_provenance
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND request_id=${input.requestId}`;
        if (!existing || Number(existing.privacy_epoch) !== input.privacyEpoch || new Date(existing.expires_at).getTime()<=Date.now()
          || !isDeepStrictEqual(parseContextSourceRefs(existing.context_source_refs), refs)) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query provenance replay differs");
        return String(existing.id);
      });
    },
    async record(scope, input) {
      return sql.begin(async tx => {
        const owners = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw new EphemeralProvenanceError("NOT_FOUND", "workspace not found");
        if (Number(owners[0]!.privacy_epoch) !== input.privacyEpoch) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "privacy changed before reply delivery");
        const refs = input.contextSourceRefs === null ? null : parseContextSourceRefs(input.contextSourceRefs);
        if (refs !== null) {
          const admitted = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(refs)}::jsonb`)} AS included`;
          if (!admitted[0]!.included) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "material is no longer available");
        }
        const rows = await tx`INSERT INTO opening_ephemeral_provenance(id,workspace_id,owner_user_id,privacy_epoch,context_source_refs)
          SELECT id,workspace_id,${scope.ownerUserId},${input.privacyEpoch},${refs === null ? null : tx.json(refs)}
          FROM opening_budget_reservations WHERE request_id=${input.requestId} AND workspace_id=${scope.workspaceId} AND purpose='tutor'
          RETURNING id`;
        if (!rows.length) throw new EphemeralProvenanceError("NOT_FOUND", "call reservation not found");
        return refs === null ? null : String(rows[0]!.id);
      });
    },
  };
}
