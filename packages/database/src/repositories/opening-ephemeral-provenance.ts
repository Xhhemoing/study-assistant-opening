import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { contextSourceRefsIncluded, mergeContextSourceRefs, parseContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";

export type EphemeralProvenanceRepository = {
  resolveHistory(scope: OpeningScope, history: readonly { provenanceId?: string }[], epoch: number): Promise<ContextSourceRef[] | null>;
  record(scope: OpeningScope, input: { requestId: string; privacyEpoch: number; contextSourceRefs: ContextSourceRef[] | null }): Promise<string | null>;
};
export class EphemeralProvenanceError extends Error {
  constructor(readonly code: "NOT_FOUND" | "PRIVACY_CHANGED", message: string) { super(message); }
}

export function createOpeningEphemeralProvenanceRepository(sql: Sql): EphemeralProvenanceRepository {
  return {
    async resolveHistory(scope, history, epoch) {
      if (!history.length) return [];
      if (history.some(item => !item.provenanceId)) return null;
      const ids = [...new Set(history.map(item => item.provenanceId!))];
      const rows = await sql`SELECT p.id, p.context_source_refs FROM opening_ephemeral_provenance p
        JOIN workspaces w ON w.id=p.workspace_id
        WHERE p.id=ANY(${ids}::uuid[]) AND p.workspace_id=${scope.workspaceId}
          AND p.owner_user_id=${scope.ownerUserId} AND w.owner_user_id=${scope.ownerUserId}
          AND p.privacy_epoch=${epoch}
          AND ${contextSourceRefsIncluded(sql, scope.workspaceId, sql`p.context_source_refs`)}`;
      if (rows.length !== ids.length) return null;
      const groups = rows.map(row => parseContextSourceRefs(row.context_source_refs));
      return groups.some(refs => refs === null) ? null : mergeContextSourceRefs(...groups as ContextSourceRef[][]);
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
