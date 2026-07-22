import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("courses_workspace_slug_uidx").on(table.workspaceId, table.slug),
  ],
);

/**
 * Course-local membership metadata for a shared workspace asset.
 * Never stores document/block content — only role, order, visibility.
 */
export const courseAssetMemberships = pgTable(
  "course_asset_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    assetType: text("asset_type").notNull(),
    assetId: uuid("asset_id").notNull(),
    role: text("role").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    visibility: text("visibility").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("course_asset_memberships_unique_uidx").on(
      table.courseId,
      table.assetType,
      table.assetId,
    ),
  ],
);

export const courseSchema = {
  courses,
  courseAssetMemberships,
};
