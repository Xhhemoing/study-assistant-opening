import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const libraryDocuments = pgTable("library_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  lifecycle: text("lifecycle").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  currentRevisionNumber: integer("current_revision_number").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const libraryBlocks = pgTable(
  "library_blocks",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    position: integer("position").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_blocks_document_position_uidx").on(
      table.documentId,
      table.position,
    ),
  ],
);

export const libraryRevisions = pgTable(
  "library_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    parentRevisionNumber: integer("parent_revision_number"),
    title: text("title").notNull(),
    lifecycle: text("lifecycle").notNull(),
    reason: text("reason").notNull().default("edit"),
    blocks: jsonb("blocks").$type<RevisionBlockSnapshot[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_revisions_document_number_uidx").on(
      table.documentId,
      table.revisionNumber,
    ),
  ],
);

export const libraryRelations = pgTable("library_relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  fromType: text("from_type").notNull(),
  fromId: uuid("from_id").notNull(),
  toType: text("to_type").notNull(),
  toId: uuid("to_id").notNull(),
  relationType: text("relation_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const libraryProperties = pgTable(
  "library_properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    key: text("key").notNull(),
    valueType: text("value_type").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_properties_subject_key_uidx").on(
      table.workspaceId,
      table.subjectType,
      table.subjectId,
      table.key,
    ),
  ],
);

export type RevisionBlockSnapshot = {
  id: string;
  type: string;
  position: number;
  content: Record<string, unknown>;
};

export const librarySchema = {
  workspaces,
  libraryDocuments,
  libraryBlocks,
  libraryRevisions,
  libraryRelations,
  libraryProperties,
};
