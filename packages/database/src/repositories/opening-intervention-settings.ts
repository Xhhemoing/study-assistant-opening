import {
  DEFAULT_OPENING_INTERVENTION_PREFS,
  interventionDecisionRecordSchema,
  interventionPrefsPatchSchema,
  interventionPrefsSchema,
  type InterventionDecisionRecord,
  type InterventionPrefs,
  type InterventionPrefsPatch,
  type Scope,
} from "@aistudy/contracts";
import {
  appendInterventionDecision,
  mergeSessionInterventionPrefs,
  readInterventionDecisions,
  readSessionInterventionPrefs,
  resolveInterventionPrefs,
} from "@aistudy/domain";
import type { Sql } from "postgres";
import { learningError, learningIso, lockLearningOwner } from "./opening-learning-facts";
import { WorkspacePreferencesError } from "./preferences";

function parseStoredPrefs(stored: unknown): {
  settings: InterventionPrefs;
  saved: boolean;
  invalidStoredSettings: boolean;
} {
  if (stored == null) {
    return {
      settings: DEFAULT_OPENING_INTERVENTION_PREFS,
      saved: false,
      invalidStoredSettings: false,
    };
  }
  const parsed = interventionPrefsSchema.safeParse(stored);
  if (parsed.success) {
    return { settings: parsed.data, saved: true, invalidStoredSettings: false };
  }
  return {
    settings: DEFAULT_OPENING_INTERVENTION_PREFS,
    saved: true,
    invalidStoredSettings: true,
  };
}

function parsePatch(stored: unknown): InterventionPrefsPatch | null {
  if (stored == null) return null;
  const parsed = interventionPrefsPatchSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export function createOpeningInterventionSettingsRepository(sql: Sql) {
  return {
    async getGlobal(scope: Scope) {
      const rows = await sql`SELECT p.intervention_settings FROM workspaces w
        LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
      return parseStoredPrefs(rows[0]!.intervention_settings);
    },

    async setGlobal(scope: Scope, value: InterventionPrefs | null) {
      const parsed =
        value === null
          ? DEFAULT_OPENING_INTERVENTION_PREFS
          : interventionPrefsSchema.parse(value);
      await sql.begin(async (tx) => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
        await tx`INSERT INTO workspace_preferences (workspace_id, intervention_settings)
          VALUES (${scope.workspaceId}, ${tx.json(parsed)})
          ON CONFLICT(workspace_id) DO UPDATE SET
            intervention_settings=EXCLUDED.intervention_settings, updated_at=now()`;
      });
    },

    async getCourseOverlay(scope: Scope, courseId: string): Promise<InterventionPrefsPatch | null> {
      const rows = await sql`
        SELECT c.intervention_settings FROM courses c
        JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.id = ${courseId}
          AND c.workspace_id = ${scope.workspaceId}
          AND w.owner_user_id = ${scope.ownerUserId}`;
      if (!rows.length) throw learningError("NOT_FOUND", "course not found");
      return parsePatch(rows[0]!.intervention_settings);
    },

    /** Temp must NOT write-through — this only updates courses.intervention_settings. */
    async setCourseOverlay(
      scope: Scope,
      courseId: string,
      patch: InterventionPrefsPatch | null,
    ): Promise<InterventionPrefsPatch | null> {
      const parsed = patch === null ? null : interventionPrefsPatchSchema.parse(patch);
      return sql.begin(async (tx) => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        if (!owner.length) throw learningError("NOT_FOUND", "workspace not found");
        const updated = await tx`
          UPDATE courses SET intervention_settings = ${
            parsed === null ? null : tx.json(parsed)
          }, updated_at = now()
          WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId}
          RETURNING intervention_settings`;
        if (!updated.length) throw learningError("NOT_FOUND", "course not found");
        return parsePatch(updated[0]!.intervention_settings);
      });
    },

    /**
     * Resolve effective prefs: session (checkpoint) > course > global.
     * Session overlay is read-only here — never mutates durable rows.
     */
    async resolve(
      scope: Scope,
      options?: { courseId?: string | null; activityId?: string | null },
    ) {
      const global = await this.getGlobal(scope);
      const courseOverride = options?.courseId
        ? await this.getCourseOverlay(scope, options.courseId)
        : null;
      let sessionOverride: InterventionPrefsPatch | null = null;
      if (options?.activityId) {
        const activity = await sql`
          SELECT a.checkpoint_json FROM opening_teaching_activities a
          JOIN workspaces w ON w.id = a.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
          WHERE a.id = ${options.activityId}
            AND a.workspace_id = ${scope.workspaceId}
            AND a.owner_user_id = ${scope.ownerUserId}`;
        if (!activity.length) throw learningError("NOT_FOUND", "teaching activity not found");
        const cp = (activity[0]!.checkpoint_json ?? {}) as Record<string, unknown>;
        const raw = readSessionInterventionPrefs(cp);
        sessionOverride = raw == null ? null : interventionPrefsPatchSchema.parse(raw);
      }
      const effective = resolveInterventionPrefs(
        global.settings,
        courseOverride,
        sessionOverride,
      );
      return {
        settings: global.settings,
        courseOverride,
        sessionOverride,
        effective,
        saved: global.saved,
        invalidStoredSettings: global.invalidStoredSettings,
      };
    },

    /**
     * Write session overlay into checkpoint_json.interventionPrefs only.
     * Does NOT mutate workspace_preferences or courses (T12).
     */
    async setSessionOverlay(
      scope: Scope,
      activityId: string,
      patch: InterventionPrefsPatch | null,
      options?: { expectedUpdatedAt?: string },
    ) {
      const parsed = patch === null ? null : interventionPrefsPatchSchema.parse(patch);
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const rows = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!rows.length) throw learningError("NOT_FOUND", "teaching activity not found");
        const current = rows[0] as Record<string, unknown>;
        if (options?.expectedUpdatedAt) {
          const currentUpdated = learningIso(current.updated_at);
          if (currentUpdated !== options.expectedUpdatedAt) {
            throw learningError("CONFLICT", "teaching activity updated_at mismatch");
          }
        }
        const prev = (current.checkpoint_json ?? {}) as Record<string, unknown>;
        const nextCheckpoint = mergeSessionInterventionPrefs(prev, parsed);
        const updated = await tx`
          UPDATE opening_teaching_activities
          SET checkpoint_json = ${tx.json(nextCheckpoint as never)}, updated_at = now()
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          RETURNING checkpoint_json, updated_at`;
        return {
          checkpointJson: (updated[0] as Record<string, unknown>).checkpoint_json as Record<
            string,
            unknown
          >,
          updatedAt: learningIso((updated[0] as Record<string, unknown>).updated_at)!,
        };
      });
    },

    /** Append decision to checkpoint ring (max 20). Fail-soft callers should catch. */
    async appendDecision(
      scope: Scope,
      activityId: string,
      record: InterventionDecisionRecord,
      options?: { expectedUpdatedAt?: string },
    ) {
      const parsed = interventionDecisionRecordSchema.parse(record);
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const rows = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!rows.length) throw learningError("NOT_FOUND", "teaching activity not found");
        const current = rows[0] as Record<string, unknown>;
        if (options?.expectedUpdatedAt) {
          const currentUpdated = learningIso(current.updated_at);
          if (currentUpdated !== options.expectedUpdatedAt) {
            throw learningError("CONFLICT", "teaching activity updated_at mismatch");
          }
        }
        const prev = (current.checkpoint_json ?? {}) as Record<string, unknown>;
        const nextCheckpoint = appendInterventionDecision(prev, parsed);
        const updated = await tx`
          UPDATE opening_teaching_activities
          SET checkpoint_json = ${tx.json(nextCheckpoint as never)}, updated_at = now()
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          RETURNING checkpoint_json, updated_at`;
        const cp = (updated[0] as Record<string, unknown>).checkpoint_json as Record<
          string,
          unknown
        >;
        return {
          checkpointJson: cp,
          decisions: readInterventionDecisions(cp),
          updatedAt: learningIso((updated[0] as Record<string, unknown>).updated_at)!,
        };
      });
    },
  };
}

export type OpeningInterventionSettingsRepository = ReturnType<
  typeof createOpeningInterventionSettingsRepository
>;
