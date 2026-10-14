import {
  DEFAULT_OPENING_ADAPTIVE_PREFS,
  openingAdaptivePrefsPatchSchema,
  openingAdaptivePrefsSchema,
  type OpeningAdaptivePrefs,
  type OpeningAdaptivePrefsPatch,
  type OpeningAdaptivePrefsResponse,
  type Scope,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
import { WorkspacePreferencesError } from "./preferences";

function readStored(stored: unknown): OpeningAdaptivePrefsResponse {
  if (stored == null) return { prefs: DEFAULT_OPENING_ADAPTIVE_PREFS, saved: false, invalidStoredPrefs: false };
  const parsed = openingAdaptivePrefsSchema.safeParse(stored);
  return parsed.success
    ? { prefs: parsed.data, saved: true, invalidStoredPrefs: false }
    : { prefs: DEFAULT_OPENING_ADAPTIVE_PREFS, saved: true, invalidStoredPrefs: true };
}

/** workspace_preferences.adaptive_planning (0061): autonomy mode, coach budget, course goals. */
export function createOpeningAdaptivePrefsRepository(sql: Sql) {
  return {
    async get(scope: Scope): Promise<OpeningAdaptivePrefsResponse> {
      const rows = await sql`SELECT p.adaptive_planning FROM workspaces w
        LEFT JOIN workspace_preferences p ON p.workspace_id = w.id
        WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId}`;
      if (!rows.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
      return readStored(rows[0]!.adaptive_planning);
    },

    /** Merges under the workspace row lock; an unreadable stored value restarts from defaults. */
    async patch(scope: Scope, raw: OpeningAdaptivePrefsPatch): Promise<OpeningAdaptivePrefsResponse> {
      const patch = openingAdaptivePrefsPatchSchema.parse(raw);
      return sql.begin(async (tx) => {
        const owner = await tx`SELECT id FROM workspaces WHERE id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
        const rows = await tx`SELECT adaptive_planning FROM workspace_preferences
          WHERE workspace_id = ${scope.workspaceId}`;
        const current = readStored(rows[0]?.adaptive_planning).prefs;
        const next: OpeningAdaptivePrefs = {
          autonomy: patch.autonomy ?? current.autonomy,
          coachBudgetMinutes: patch.coachBudgetMinutes ?? current.coachBudgetMinutes,
          courseGoals: { ...current.courseGoals },
        };
        if (patch.courseGoal) {
          const { courseId, goal } = patch.courseGoal;
          if (goal === null) {
            delete next.courseGoals[courseId];
          } else {
            const course = await tx`SELECT 1 FROM courses
              WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId} AND archived_at IS NULL`;
            if (!course.length) throw new WorkspacePreferencesError("NOT_FOUND", "Course not found");
            next.courseGoals[courseId] = goal;
          }
        }
        const value = openingAdaptivePrefsSchema.parse(next);
        await tx`INSERT INTO workspace_preferences (workspace_id, adaptive_planning)
          VALUES (${scope.workspaceId}, ${tx.json(value as never)})
          ON CONFLICT (workspace_id) DO UPDATE SET adaptive_planning = EXCLUDED.adaptive_planning, updated_at = now()`;
        return { prefs: value, saved: true, invalidStoredPrefs: false };
      });
    },
  };
}

export type OpeningAdaptivePrefsRepository = ReturnType<typeof createOpeningAdaptivePrefsRepository>;
