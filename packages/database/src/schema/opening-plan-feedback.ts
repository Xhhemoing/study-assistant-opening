import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { openingTasks } from "./opening-planning";
import { users } from "./identity";
import { workspaces } from "./library";

export const openingPlanFeedback = pgTable("opening_plan_feedback", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => openingTasks.id, { onDelete: "cascade" }),
  taskVersion: integer("task_version").notNull(),
  action: text("action").notNull(),
  reason: text("reason"),
  origin: text("origin").notNull(),
  requirementKey: text("requirement_key"),
  suggestionKind: text("suggestion_kind"),
  notBefore: timestamp("not_before", { withTimezone: true }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("opening_plan_feedback_task_version_action_uidx").on(t.taskId, t.taskVersion, t.action),
  index("opening_plan_feedback_scope_recorded_idx").on(t.workspaceId, t.ownerUserId, t.recordedAt),
]);
