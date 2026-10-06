import { integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { openingConnections } from "./opening-connections";
import { openingSources } from "./opening-sources";
import { workspaces } from "./library";

/** Durable import receipts and per-container cursors for authorized connections. */
export const openingImportReceipts = pgTable("opening_import_receipts", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => openingConnections.id, { onDelete: "cascade" }),
  connectionVersion: integer("connection_version").notNull(),
  identityKey: text("identity_key").notNull(),
  sourceId: uuid("source_id").notNull().references(() => openingSources.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("opening_import_identity_uidx").on(
  t.workspaceId, t.connectionId, t.identityKey,
)]);

export const openingImportCursors = pgTable("opening_import_cursors", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => openingConnections.id, { onDelete: "cascade" }),
  container: text("container").notNull(),
  generation: text("generation").notNull(),
  cursor: jsonb("cursor").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workspaceId, t.connectionId, t.container] })]);

export const openingImportsSchema = { openingImportReceipts, openingImportCursors };
