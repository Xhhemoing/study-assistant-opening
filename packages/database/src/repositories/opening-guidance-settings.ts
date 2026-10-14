import type { Sql } from "postgres";
import { DEFAULT_OPENING_GUIDANCE_SETTINGS, openingGuidanceSettingsSchema, type Scope } from "@aistudy/contracts";
import { OpeningPlanError } from "./opening-plan-error";
export function createOpeningGuidanceSettingsRepository(sql: Sql) {
  return {
    async get(scope: Scope) {
      const rows = await sql`SELECT p.guidance_settings FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
      return openingGuidanceSettingsSchema.parse(rows[0]!.guidance_settings ?? DEFAULT_OPENING_GUIDANCE_SETTINGS);
    },
    async save(scope: Scope, raw: unknown) {
      const settings = openingGuidanceSettingsSchema.parse(raw);
      return sql.begin(async tx => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
        await tx`INSERT INTO workspace_preferences(workspace_id,guidance_settings) VALUES(${scope.workspaceId},${tx.json(settings)})
          ON CONFLICT(workspace_id) DO UPDATE SET guidance_settings=EXCLUDED.guidance_settings,updated_at=now()`;
        return settings;
      });
    },
  };
}
