import { integer, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { users } from "./identity";
import { workspaces } from "./library";

export const openingCourseKnowledge = pgTable(
  "opening_course_knowledge",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(0),
    snapshot: jsonb("snapshot").notNull(),
    sourceVersions: jsonb("source_versions").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.courseId] }),
    uniqueIndex("opening_course_knowledge_course_uidx").on(table.courseId),
  ],
);

export const openingKnowledgeSchema = { openingCourseKnowledge };
