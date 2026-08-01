import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const workspacePreferences = pgTable("workspace_preferences", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  defaultEntry: text("default_entry").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const preferencesSchema = { workspacePreferences };
