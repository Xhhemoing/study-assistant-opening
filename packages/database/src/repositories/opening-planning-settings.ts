import {
  openingPlanningSettingsSchema,
  type OpeningPlanningSettings,
  type Scope,
} from "@aistudy/contracts";
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
