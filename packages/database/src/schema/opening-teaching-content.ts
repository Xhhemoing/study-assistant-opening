import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { libraryDocuments, workspaces } from "./library";
import { openingTeachingActivities } from "./opening-teaching-activities";

/** V2-05 TeachingUnit metadata — body stays in library_* (ADR D2). */
export const openingTeachingUnits = pgTable(
  "opening_teaching_units",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => libraryDocuments.id),
    currentRevisionNumber: integer("current_revision_number").notNull().default(0),
    goalsJson: jsonb("goals_json").notNull().default([]),
    verificationStatus: text("verification_status").notNull().default("unchecked"),
    generationConfig: jsonb("generation_config").notNull().default({}),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("opening_teaching_units_workspace_id_uidx").on(table.workspaceId, table.id),
    index("opening_teaching_units_owner_idx").on(
      table.workspaceId,
      table.ownerUserId,
    ),
  ],
);

/**
 * Current ActivitySpec binding per activity (1:1).
 * M1: no history table — past body via library revision_number only.
 */
export const openingTeachingActivitySpecs = pgTable(
  "opening_teaching_activity_specs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => openingTeachingActivities.id, { onDelete: "cascade" }),
    teachingUnitId: uuid("teaching_unit_id")
      .notNull()
      .references(() => openingTeachingUnits.id),
    documentId: uuid("document_id")
      .notNull()
      .references(() => libraryDocuments.id),
    revisionNumber: integer("revision_number").notNull(),
    blockOrder: jsonb("block_order").notNull().default([]),
    sourceRefs: jsonb("source_refs").notNull().default([]),
    goalsJson: jsonb("goals_json").notNull().default([]),
    verificationStatus: text("verification_status").notNull().default("unchecked"),
    generationConfig: jsonb("generation_config").notNull().default({}),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("opening_teaching_activity_specs_activity_uidx").on(
      table.workspaceId,
      table.activityId,
    ),
    uniqueIndex("opening_teaching_activity_specs_workspace_id_uidx").on(
      table.workspaceId,
      table.id,
    ),
    index("opening_teaching_activity_specs_unit_idx").on(
      table.workspaceId,
      table.teachingUnitId,
    ),
  ],
);

export const openingTeachingContentSchema = {
  openingTeachingUnits,
  openingTeachingActivitySpecs,
};
