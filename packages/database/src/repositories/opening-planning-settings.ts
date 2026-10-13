import {
  openingPlanningSettingsSchema,
  type OpeningPlanningSettings,
  type Scope,
} from "@aistudy/contracts";
import { resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { Sql } from "postgres";
import { WorkspacePreferencesError } from "./preferences";

export function createOpeningPlanningSettingsRepository(sql: Sql) {
  return {
    async get(scope: Scope) {
      const rows = await sql`SELECT p.planning_settings FROM workspaces w
        LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
      const stored = rows[0]!.planning_settings;
      const parsed = openingPlanningSettingsSchema.safeParse(stored);
      return {
        settings: parsed.success ? parsed.data : null,
        saved: stored != null,
        invalidStoredSettings: stored != null && !parsed.success,
      };
    },
    async set(scope: Scope, value: OpeningPlanningSettings | null) {
      const parsed = value === null ? null : openingPlanningSettingsSchema.parse(value);
      // PR-B: reject an invalid IANA zone at write time so new bad values never reach storage.
      // Read path (get) is unchanged: stored values are surfaced as-is and fail loudly where used.
      if (parsed !== null) {
        try {
          resolveWorkspaceTimeZone(parsed.timeZone);
        } catch {
          throw new WorkspacePreferencesError("VALIDATION", `invalid timeZone: ${parsed.timeZone}`);
        }
      }
      await sql.begin(async tx => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
        await tx`INSERT INTO workspace_preferences (workspace_id,planning_settings)
          VALUES (${scope.workspaceId},${parsed === null ? null : tx.json(parsed)})
          ON CONFLICT(workspace_id) DO UPDATE SET planning_settings=EXCLUDED.planning_settings,updated_at=now()`;
      });
    },
  };
}
