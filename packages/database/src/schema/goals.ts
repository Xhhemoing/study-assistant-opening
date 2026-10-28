import {
  boolean,
  date,
  doublePrecision,
  integer,
  index,
  jsonb,
  primaryKey,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { workspaces } from "./library";
import { users } from "./identity";

/**
 * Course-level goals. A single course can carry several goals
 * (final exam, entrance exam, interest, maintenance, custom) that
 * merge deterministically into one effective requirement profile.
 */
export const courseGoals = pgTable(
  "course_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    priority: integer("priority").notNull().default(0),
    intensity: doublePrecision("intensity").notNull().default(0.5),
    abilities: jsonb("abilities").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    active: boolean("active").notNull().default(true),
    examDate: date("exam_date"),
    targetDate: date("target_date"),
    revision: integer("revision").notNull().default(1),
    weeklyMinutes: integer("weekly_minutes").notNull().default(0),
    learningMode: text("learning_mode").notNull().default("auto"),
    successCriteria: text("success_criteria").notNull().default(""),
    lifecycle: text("lifecycle").notNull().default("active"),
    maintenanceIntervalDays: integer("maintenance_interval_days"),
    milestones: jsonb("milestones").notNull().default([]),
    definitionHistory: jsonb("definition_history").notNull().default([]),
    clientKey: text("client_key"),
    createIntent: jsonb("create_intent"),
    userOverride: jsonb("user_override"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("course_goals_workspace_id_id_uidx").on(table.workspaceId, table.id),
    uniqueIndex("course_goals_workspace_client_key_uidx").on(table.workspaceId, table.clientKey),
  ],
);

export const goalTimeWindows = pgTable(
  "goal_time_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => courseGoals.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    modifier: jsonb("modifier").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("goal_time_windows_workspace_id_id_uidx").on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex("goal_time_windows_workspace_goal_phase_uidx").on(
      table.workspaceId,
      table.goalId,
      table.phase,
    ),
  ],
);

export const courseGoalLinks = pgTable("course_goal_links", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  goalId: uuid("goal_id").notNull(), courseId: uuid("course_id").notNull(),
}, table => [primaryKey({ columns: [table.workspaceId, table.goalId, table.courseId] }),
  foreignKey({ columns: [table.workspaceId, table.goalId], foreignColumns: [courseGoals.workspaceId, courseGoals.id] }).onDelete("cascade"),
  foreignKey({ columns: [table.workspaceId, table.courseId], foreignColumns: [courses.workspaceId, courses.id] }).onDelete("cascade"),
]);

export const courseRequirements = pgTable("course_requirements", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull(), stableSkillId: uuid("stable_skill_id").notNull(), knowledgeNodeId: uuid("knowledge_node_id"),
  requirementKey: text("requirement_key").notNull(), title: text("title").notNull(), position: integer("position").notNull().default(0),
  mandatory: boolean("mandatory").notNull().default(true), goalIds: uuid("goal_ids").array().notNull().default([]),
  prerequisiteIds: uuid("prerequisite_ids").array().notNull().default([]), sourceRefs: jsonb("source_refs").notNull().default([]),
  verification: jsonb("verification").notNull(), evidenceConditions: jsonb("evidence_conditions"), revision: integer("revision").notNull().default(1),
  lifecycle: text("lifecycle").notNull().default("active"), origin: text("origin").notNull().default("extracted"),
  approvedAt: timestamp("approved_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [foreignKey({ columns: [table.workspaceId, table.courseId], foreignColumns: [courses.workspaceId, courses.id] }).onDelete("cascade"),
  uniqueIndex("course_requirements_workspace_id_id_key").on(table.workspaceId, table.id),
  uniqueIndex("course_requirements_workspace_id_course_id_requirement_key_key").on(table.workspaceId, table.courseId, table.requirementKey),
  index("course_requirements_course_position_idx").on(table.workspaceId, table.courseId, table.position, table.id),
]);
export const goalsSchema = { courseGoals, goalTimeWindows, courseGoalLinks, courseRequirements };
