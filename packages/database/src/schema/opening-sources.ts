import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./library";

/** Opening source identity — workspace-owned; course links are membership-only. */
export const openingSources = pgTable(
  "opening_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    version: integer("version").notNull().default(0),
    uploadState: text("upload_state").notNull(),
    parseState: text("parse_state").notNull(),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("opening_sources_workspace_id_id_uidx").on(
      table.workspaceId,
      table.id,
    ),
  ],
);

export const openingSourcesSchema = { openingSources };
