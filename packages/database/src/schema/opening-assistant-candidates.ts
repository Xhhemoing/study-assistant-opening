import { jsonb, pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./library";
import { openingConversations, openingTurns } from "./opening-conversations";

export const openingAssistantCandidates = pgTable("opening_assistant_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => openingConversations.id, { onDelete: "cascade" }),
  sourceTurnId: uuid("source_turn_id").notNull().references(() => openingTurns.id, { onDelete: "cascade" }),
  sourceIds: jsonb("source_ids").notNull().default([]),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  taskAcceptClientKey: text("task_accept_client_key"),
  taskAcceptIntent: jsonb("task_accept_intent"),
  taskResultRef: jsonb("task_result_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("opening_assistant_candidates_workspace_status_idx").on(table.workspaceId, table.status),
  uniqueIndex("opening_assistant_task_accept_key_idx").on(table.workspaceId, table.taskAcceptClientKey)
    .where(sql`${table.taskAcceptClientKey} IS NOT NULL`)]);

export const openingAssistantCandidatesSchema = { openingAssistantCandidates };
