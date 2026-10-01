import { DEFAULT_OPENING_AI_SETTINGS, openingAiSettingsSchema, type OpeningAiSettings, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { WorkspacePreferencesError } from "./preferences";

export function createOpeningAiSettingsRepository(sql: Sql) {
  return {
    async get(scope: Scope) {
      const rows = await sql`SELECT p.ai_settings FROM workspaces w
        LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
      const stored = rows[0]!.ai_settings;
      const parsed = openingAiSettingsSchema.safeParse(stored);
      return { settings: parsed.success ? parsed.data : DEFAULT_OPENING_AI_SETTINGS,
        saved: stored != null, invalidStoredSettings: stored != null && !parsed.success };
    },
    async set(scope: Scope, value: OpeningAiSettings | null) {
      const parsed = value === null ? null : openingAiSettingsSchema.parse(value);
      await sql.begin(async tx => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
        await tx`INSERT INTO workspace_preferences (workspace_id,ai_settings)
          VALUES (${scope.workspaceId},${parsed === null ? null : tx.json(parsed)})
          ON CONFLICT(workspace_id) DO UPDATE SET ai_settings=EXCLUDED.ai_settings,updated_at=now()`;
      });
    },
  };
}
