import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const openingConversations = pgTable("opening_conversations", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull(),
  title: text("title").notNull(),
  courseId: uuid("course_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const openingTurns = pgTable("opening_turns", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => openingConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  text: text("text").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  clientKey: text("client_key"),
  learningSessionId: uuid("learning_session_id"),
  currentPage: integer("current_page"),
  chunkId: uuid("chunk_id"),
  sourceIds: uuid("source_ids").array().notNull().default([]),
  citations: text("citations").notNull().default("[]"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const openingConversationsSchema = { openingConversations, openingTurns };
