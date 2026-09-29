import { learningPreferencesSchema, workspaceDefaultEntrySchema, type LearningPreferences, type Scope, type WorkspaceDefaultEntry } from "@aistudy/contracts";
import type { Sql } from "postgres";

export type WorkspacePreferencesErrorCode = "NOT_FOUND" | "VALIDATION";

export class WorkspacePreferencesError extends Error {
  constructor(readonly code: WorkspacePreferencesErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePreferencesError";
  }
}

export type WorkspacePreferenceRecord = {
  workspaceId: string;
  defaultEntry: WorkspaceDefaultEntry | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkspacePreferencesRepository = {
  getDefaultEntry(workspaceId: string): Promise<WorkspaceDefaultEntry | null>;
  setDefaultEntry(
    workspaceId: string,
    defaultEntry: WorkspaceDefaultEntry,
  ): Promise<WorkspacePreferenceRecord>;
  getLearningPreferences(scope: Scope): Promise<LearningPreferences>;
  setLearningPreferences(scope: Scope, value: LearningPreferences): Promise<LearningPreferences>;
};

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new WorkspacePreferencesError("VALIDATION", `Invalid UUID for ${field}`);
  }
}

function mapPreference(row: Record<string, unknown>): WorkspacePreferenceRecord {
  return {
    workspaceId: row.workspace_id as string,
    defaultEntry: row.default_entry == null ? null : workspaceDefaultEntrySchema.parse(row.default_entry),
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

export function createWorkspacePreferencesRepository(sql: Sql): WorkspacePreferencesRepository {
  async function ensureWorkspace(workspaceId: string): Promise<void> {
    assertUuid(workspaceId, "workspaceId");
    const rows = await sql`SELECT id FROM workspaces WHERE id = ${workspaceId} LIMIT 1`;
    if (!rows.length) {
      throw new WorkspacePreferencesError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
    }
  }

  return {
    async getDefaultEntry(workspaceId) {
      await ensureWorkspace(workspaceId);
      const rows = await sql`
        SELECT default_entry FROM workspace_preferences
        WHERE workspace_id = ${workspaceId}
        LIMIT 1
      `;
      return rows.length && rows[0]!.default_entry != null
        ? workspaceDefaultEntrySchema.parse(rows[0]!.default_entry)
        : null;
    },

    async setDefaultEntry(workspaceId, defaultEntry) {
      await ensureWorkspace(workspaceId);
      const entry = workspaceDefaultEntrySchema.safeParse(defaultEntry);
      if (!entry.success) {
        throw new WorkspacePreferencesError("VALIDATION", "Invalid workspace default entry");
      }
      const rows = await sql`
        INSERT INTO workspace_preferences (workspace_id, default_entry)
        VALUES (${workspaceId}, ${entry.data})
        ON CONFLICT (workspace_id) DO UPDATE SET
          default_entry = EXCLUDED.default_entry,
          updated_at = now()
        RETURNING *
      `;
      return mapPreference(rows[0] as Record<string, unknown>);
    },

    async getLearningPreferences(scope) {
      const rows = await sql`SELECT p.assessment_enabled,p.retest_suggestions_enabled,p.automatic_reminders_enabled
        FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
      return learningPreferencesSchema.parse({
        assessmentEnabled: rows[0]!.assessment_enabled ?? false,
        retestSuggestionsEnabled: rows[0]!.retest_suggestions_enabled ?? false,
        automaticRemindersEnabled: rows[0]!.automatic_reminders_enabled ?? false,
      });
    },

    async setLearningPreferences(scope, value) {
      const parsed = learningPreferencesSchema.parse(value);
      return sql.begin(async (tx) => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
        await tx`INSERT INTO workspace_preferences
          (workspace_id,assessment_enabled,retest_suggestions_enabled,automatic_reminders_enabled)
          VALUES (${scope.workspaceId},${parsed.assessmentEnabled},${parsed.retestSuggestionsEnabled},${parsed.automaticRemindersEnabled})
          ON CONFLICT(workspace_id) DO UPDATE SET
            assessment_enabled=EXCLUDED.assessment_enabled,
            retest_suggestions_enabled=EXCLUDED.retest_suggestions_enabled,
            automatic_reminders_enabled=EXCLUDED.automatic_reminders_enabled,
            updated_at=now()`;
        return parsed;
      });
    },
  };
}
