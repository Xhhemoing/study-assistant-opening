import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const workspacePreferences = pgTable("workspace_preferences", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  defaultEntry: text("default_entry"),
  aiSettings: jsonb("ai_settings"),
  planningSettings: jsonb("planning_settings"),
  /** 0061: autonomy mode, coach budget, course goals. */
  adaptivePlanning: jsonb("adaptive_planning"),
  interventionSettings: jsonb("intervention_settings").notNull().default({
    proactivity: "balanced",
    nodes: { allowOnTeach: true, allowOnPrompt: true, allowOnLowEvidence: false },
    depth: "hint_then_offer",
    quietMode: false,
  }),
  assessmentEnabled: boolean("assessment_enabled"),
  retestSuggestionsEnabled: boolean("retest_suggestions_enabled"),
  automaticRemindersEnabled: boolean("automatic_reminders_enabled"),
  retestSuggestionsEnabledAt: timestamp("retest_suggestions_enabled_at", { withTimezone: true }),
  automaticRemindersEnabledAt: timestamp("automatic_reminders_enabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const preferencesSchema = { workspacePreferences };
