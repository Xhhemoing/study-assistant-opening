import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  date,
} from "drizzle-orm/pg-core";

export const openingTasks = pgTable("opening_tasks", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  title: text("title").notNull(),
  minutes: integer("minutes").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  dueText: text("due_text"),
  priority: doublePrecision("priority").notNull().default(1),
  status: text("status").notNull().default("pending"),
  version: integer("version").notNull().default(1),
  candidateId: uuid("candidate_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingTimetableSessions = pgTable("opening_timetable_sessions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  courseName: text("course_name").notNull(),
  courseId: uuid("course_id"),
  weekday: integer("weekday").notNull(),
  weeks: integer("weeks").array().notNull(),
  startPeriod: integer("start_period").notNull(),
  endPeriod: integer("end_period").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingHardBlocks = pgTable("opening_hard_blocks", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  day: date("day").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  kind: text("kind").notNull(),
  source: text("source").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingPlanState = pgTable(
  "opening_plan_state",
  {
    workspaceId: uuid("workspace_id").notNull(),
    day: date("day").notNull(),
    acceptedVersion: integer("accepted_version").notNull().default(0),
    acceptedBlocks: jsonb("accepted_blocks").notNull().default([]),
    hardBlocksFingerprint: text("hard_blocks_fingerprint").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.day] }) }),
);

export const openingPlanDrafts = pgTable("opening_plan_drafts", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  day: date("day").notNull(),
  version: integer("version").notNull().default(0),
  baseVersion: integer("base_version").notNull(),
  status: text("status").notNull().default("draft"),
  blocks: jsonb("blocks").notNull().default([]),
  unscheduledTaskIds: jsonb("unscheduled_task_ids").notNull().default([]),
  inputSnapshot: jsonb("input_snapshot").notNull(),
  hardBlocksFingerprint: text("hard_blocks_fingerprint").notNull(),
  proposeClientKey: text("propose_client_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingPlanAcceptances = pgTable(
  "opening_plan_acceptances",
  {
    workspaceId: uuid("workspace_id").notNull(),
    clientKey: text("client_key").notNull(),
    draftId: uuid("draft_id").notNull(),
    day: date("day").notNull(),
    acceptedVersion: integer("accepted_version").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.clientKey] }) }),
);
