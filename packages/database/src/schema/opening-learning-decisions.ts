import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
export const openingLearningDecisions = pgTable("opening_learning_decisions", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull(), ownerUserId: uuid("owner_user_id").notNull(),
  layer: text("layer").notNull(), targetId: uuid("target_id").notNull(), parentDecisionId: uuid("parent_decision_id"),
  clientKey: text("client_key").notNull(), receipt: jsonb("receipt").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("opening_learning_decisions_workspace_owner_client_key_key").on(table.workspaceId, table.ownerUserId, table.clientKey)]);
