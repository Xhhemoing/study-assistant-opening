import { jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("opening_assistant_candidates_workspace_status_idx").on(table.workspaceId, table.status)]);

export const openingAssistantCandidatesSchema = { openingAssistantCandidates };
