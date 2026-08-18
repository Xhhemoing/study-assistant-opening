import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./library";
import { users } from "./identity";

export const contentPackages = pgTable(
  "content_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("content_packages_workspace_id_id_uidx").on(table.workspaceId, table.id)],
);

export const syllabusNodes = pgTable(
  "syllabus_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packageId: uuid("package_id")
      .notNull()
      .references(() => contentPackages.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    code: text("code").notNull(),
    title: text("title").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [uniqueIndex("syllabus_nodes_workspace_id_id_uidx").on(table.workspaceId, table.id)],
);

export const practiceItems = pgTable(
  "practice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packageId: uuid("package_id")
      .notNull()
      .references(() => contentPackages.id, { onDelete: "cascade" }),
    currentVersion: integer("current_version").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("practice_items_workspace_id_id_uidx").on(table.workspaceId, table.id)],
);

export const practiceItemVersions = pgTable(
  "practice_item_versions",
  {
    practiceItemId: uuid("practice_item_id")
      .notNull()
      .references(() => practiceItems.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    syllabusPointId: uuid("syllabus_point_id")
      .notNull()
      .references(() => syllabusNodes.id),
    kind: text("kind").notNull(),
    stem: text("stem").notNull(),
    options: jsonb("options"),
    answerRule: jsonb("answer_rule").notNull(),
    answerDisplay: text("answer_display").notNull(),
    hints: jsonb("hints").notNull(),
    abilitySlice: text("ability_slice").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    source: jsonb("source").notNull(),
    reviewStatus: text("review_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.practiceItemId, table.version] })],
);

export const practiceSessions = pgTable(
  "practice_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    practiceItemId: uuid("practice_item_id")
      .notNull()
      .references(() => practiceItems.id),
    contentVersion: integer("content_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    hintCount: integer("hint_count").notNull().default(0),
    answerRevealedAt: timestamp("answer_revealed_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submissionIdempotencyKey: text("submission_idempotency_key"),
  },
  (table) => [uniqueIndex("practice_sessions_workspace_id_id_uidx").on(table.workspaceId, table.id)],
);

export const practiceContentSchema = {
  contentPackages,
  syllabusNodes,
  practiceItems,
  practiceItemVersions,
  practiceSessions,
};
