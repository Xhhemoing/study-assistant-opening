import type { Sql, TransactionSql } from "postgres";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpeningScope } from "./opening-sources";
import { openingCredentialMemoriesAvailable } from "./opening-memory-admission";
import { contextSourceRefsIncluded, mergeContextProvenanceRefs, parseContextProvenanceRefs, type ContextProvenanceRef } from "./opening-context-provenance";

export type EphemeralProvenanceRepository = {
  resolveHistory(scope: OpeningScope, history: readonly { provenanceId?: string }[], epoch: number): Promise<ContextProvenanceRef[] | null>;
  record(scope: OpeningScope, input: { reservationId?: string; requestId: string; privacyEpoch: number; contextSourceRefs: ContextProvenanceRef[] | null }): Promise<string | null>;
  recordQuery?(scope: OpeningScope, input: { requestId: string; privacyEpoch: number; contextSourceRefs: ContextProvenanceRef[] }): Promise<string>;
  purgeExpiredQueries?(): Promise<number>;
};
export class EphemeralProvenanceError extends Error {
  constructor(readonly code: "NOT_FOUND" | "PRIVACY_CHANGED", message: string) { super(message); }
}

async function memoriesAvailable(db: Sql | TransactionSql, scope: OpeningScope, refs: ContextProvenanceRef[]) {
  const dependency = refs.find(ref => "memoryDependencyIds" in ref);
  if (!dependency) return !refs.some(ref => "memoryOnly" in ref && ref.memoryOnly === true);
  return openingCredentialMemoriesAvailable(db, scope, dependency.memoryDependencyIds);
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
          AND p.privacy_epoch=${epoch} AND w.privacy_epoch=${epoch}
          AND ${contextSourceRefsIncluded(sql, scope.workspaceId, () => sql`p.context_source_refs`)}`;
      if (rows.length !== ids.length) return null;
      const groups = rows.map(row => parseContextProvenanceRefs(row.context_source_refs));
      if (groups.some(refs => refs === null)) return null;
      const refs = mergeContextProvenanceRefs(...groups as ContextProvenanceRef[][]);
      return await memoriesAvailable(sql, scope, refs) ? refs : null;
    },
    async recordQuery(scope, input) {
      const refs = parseContextProvenanceRefs(input.contextSourceRefs);
      if (refs === null || refs.length > 256) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query lineage unavailable");
      return sql.begin(async tx => {
        const [owner] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner) throw new EphemeralProvenanceError("NOT_FOUND", "workspace not found");
        if (Number(owner.privacy_epoch) !== input.privacyEpoch) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query privacy changed");
        const [admitted] = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, () => tx`${tx.json(refs)}::jsonb`, true, true)} AS included`;
        if (!admitted?.included || !await memoriesAvailable(tx, scope, refs)) {
          throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query material unavailable");
        }
        const [created] = await tx`INSERT INTO opening_query_ephemeral_provenance(id,workspace_id,owner_user_id,request_id,privacy_epoch,context_source_refs)
          VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${input.requestId},${input.privacyEpoch},${tx.json(refs)})
          ON CONFLICT(workspace_id,owner_user_id,request_id) DO NOTHING RETURNING id`;
        if (created) return String(created.id);
        const [existing] = await tx`SELECT id,privacy_epoch,context_source_refs,expires_at FROM opening_query_ephemeral_provenance
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND request_id=${input.requestId}`;
        if (!existing || Number(existing.privacy_epoch) !== input.privacyEpoch || new Date(existing.expires_at).getTime()<=Date.now()
          || !isDeepStrictEqual(parseContextProvenanceRefs(existing.context_source_refs), refs)) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "query provenance replay differs");
        return String(existing.id);
      });
    },
    async record(scope, input) {
      return sql.begin(async tx => {
        const owners = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw new EphemeralProvenanceError("NOT_FOUND", "workspace not found");
        if (Number(owners[0]!.privacy_epoch) !== input.privacyEpoch) throw new EphemeralProvenanceError("PRIVACY_CHANGED", "privacy changed before reply delivery");
        const refs = parseContextProvenanceRefs(input.contextSourceRefs);
        if (input.contextSourceRefs !== null && refs === null) {
          throw new EphemeralProvenanceError("PRIVACY_CHANGED", "reply lineage unavailable");
        }
        if (refs !== null) {
          const admitted = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, () => tx`${tx.json(refs)}::jsonb`)} AS included`;
          if (!admitted[0]!.included || !await memoriesAvailable(tx, scope, refs)) {
            throw new EphemeralProvenanceError("PRIVACY_CHANGED", "material is no longer available");
          }
        }
        const rows = await tx`INSERT INTO opening_ephemeral_provenance(id,workspace_id,owner_user_id,privacy_epoch,context_source_refs)
          SELECT id,workspace_id,${scope.ownerUserId},${input.privacyEpoch},${refs === null ? null : tx.json(refs)}
          FROM opening_budget_reservations WHERE request_id=${input.requestId} AND workspace_id=${scope.workspaceId} AND purpose='tutor'
            AND (${input.reservationId ?? null}::uuid IS NULL OR id=${input.reservationId ?? null}::uuid)
          RETURNING id`;
        if (!rows.length) throw new EphemeralProvenanceError("NOT_FOUND", "call reservation not found");
        return refs === null ? null : String(rows[0]!.id);
      });
    },
  };
}
