import { foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { courses } from "./courses";
import { openingJobs } from "./opening-jobs";
import { openingTasks } from "./opening-planning";
import { users } from "./identity";
import { workspaces } from "./library";

export const openingRetestActivities = pgTable("opening_retest_activities", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  skillLabel: text("skill_label").notNull(),
  requirementKey: text("requirement_key"),
  purpose: text("purpose").notNull().default("retest"),
  evidenceCycleId: uuid("evidence_cycle_id").notNull(),
  candidateId: uuid("candidate_id").references(() => openingJobs.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => openingTasks.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  result: text("result"),
  version: integer("version").notNull().default(1),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  proposedAt: timestamp("proposed_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  notBeforeAt: timestamp("not_before_at", { withTimezone: true }),
  recommendedAt: timestamp("recommended_at", { withTimezone: true }),
  scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  reason: text("reason"),
  reopenedFromActivityId: uuid("reopened_from_activity_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.reopenedFromActivityId],
    foreignColumns: [table.id],
    name: "opening_retest_activities_reopened_from_fk",
  }),
  uniqueIndex("opening_retest_activity_cycle_key").on(
    table.workspaceId,
    table.ownerUserId,
    table.courseId,
    table.skillLabel,
    sql`COALESCE(${table.requirementKey}, '')`,
    table.purpose,
    table.evidenceCycleId,
  ),
  uniqueIndex("opening_retest_activity_candidate_key")
    .on(table.workspaceId, table.candidateId)
    .where(sql`${table.candidateId} IS NOT NULL`),
  uniqueIndex("opening_retest_activity_task_key")
    .on(table.workspaceId, table.taskId)
    .where(sql`${table.taskId} IS NOT NULL`),
  uniqueIndex("opening_retest_activity_active_business_key")
    .on(table.workspaceId, table.ownerUserId, table.courseId, table.skillLabel, sql`COALESCE(${table.requirementKey}, '')`, table.purpose)
    .where(sql`${table.status} IN ('proposed', 'accepted', 'in_progress')`),
  index("opening_retest_activity_due_idx").on(
    table.workspaceId,
    table.ownerUserId,
    table.courseId,
    table.status,
    table.recommendedAt,
  ),
]);
