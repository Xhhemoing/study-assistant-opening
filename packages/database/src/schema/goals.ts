import {
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { workspaces } from "./library";

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
    uniqueIndex("course_goals_workspace_course_kind_uidx").on(
      table.workspaceId,
      table.courseId,
      table.kind,
    ),
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

export const goalsSchema = { courseGoals, goalTimeWindows };
