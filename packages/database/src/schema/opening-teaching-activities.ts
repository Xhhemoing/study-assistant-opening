import {
  bigint,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { courses } from "./courses";
import { users } from "./identity";
import { workspaces } from "./library";

/** V2-04 teaching activity metadata — body stays in library_* (ADR D2). */
export const openingTeachingActivities = pgTable(
  "opening_teaching_activities",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    generateStatus: text("generate_status").notNull().default("ready"),
    intentKind: text("intent_kind").notNull(),
    intentSummary: text("intent_summary").notNull(),
    sourceIds: uuid("source_ids").array().notNull().default([]),
    goalJson: jsonb("goal_json").notNull().default({}),
    pathVersion: integer("path_version").notNull().default(1),
    contentVersion: integer("content_version").notNull().default(0),
    checkpointJson: jsonb("checkpoint_json").notNull().default({}),
    clientKey: text("client_key").notNull(),
    createIntent: jsonb("create_intent").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("opening_teaching_activities_client_key_uidx").on(
      table.workspaceId,
      table.ownerUserId,
      table.clientKey,
    ),
    index("opening_teaching_activities_owner_status_idx").on(
      table.workspaceId,
      table.ownerUserId,
      table.status,
    ),
    index("opening_teaching_activities_course_idx")
      .on(table.workspaceId, table.courseId)
      .where(sql`${table.courseId} IS NOT NULL`),
  ],
);

/** Option A activity-scoped history counter (course counter unchanged). */
export const openingLearningActivityHistoryRevisions = pgTable(
  "opening_learning_activity_history_revisions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => openingTeachingActivities.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.ownerUserId, t.activityId] }),
  }),
);

export const openingTeachingActivitiesSchema = {
  openingTeachingActivities,
  openingLearningActivityHistoryRevisions,
};
