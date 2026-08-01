import { workspaceDefaultEntrySchema, type WorkspaceDefaultEntry } from "@aistudy/contracts";
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
  defaultEntry: WorkspaceDefaultEntry;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkspacePreferencesRepository = {
  getDefaultEntry(workspaceId: string): Promise<WorkspaceDefaultEntry | null>;
  setDefaultEntry(
    workspaceId: string,
    defaultEntry: WorkspaceDefaultEntry,
  ): Promise<WorkspacePreferenceRecord>;
};

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new WorkspacePreferencesError("VALIDATION", `Invalid UUID for ${field}`);
  }
}

function mapPreference(row: Record<string, unknown>): WorkspacePreferenceRecord {
  return {
    workspaceId: row.workspace_id as string,
    defaultEntry: workspaceDefaultEntrySchema.parse(row.default_entry),
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
      return rows.length
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
  };
}
