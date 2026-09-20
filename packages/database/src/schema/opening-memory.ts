import { integer, jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const openingMemories = pgTable("opening_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  courseId: uuid("course_id"),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  sourceTurnIds: jsonb("source_turn_ids").notNull().default([]),
  version: integer("version").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  lastDecisionClientKey: text("last_decision_client_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("opening_memories_workspace_status_idx").on(table.workspaceId, table.status),
  index("opening_memories_workspace_course_idx").on(table.workspaceId, table.courseId),
]);

export const openingMemorySchema = { openingMemories };
