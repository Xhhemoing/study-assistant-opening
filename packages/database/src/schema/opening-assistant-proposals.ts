import { pgTable, uuid, text, jsonb, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { workspaces } from "./library";
import { users } from "./identity";
import { openingTurns } from "./opening-conversations";
export const openingAssistantProposals = pgTable("opening_assistant_proposals", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id), sourceTurnId: uuid("source_turn_id").notNull().references(() => openingTurns.id, { onDelete: "cascade" }),
  clientKey: text("client_key").notNull(), intent: jsonb("intent").notNull(), prepared: jsonb("prepared"), contextSourceRefs: jsonb("context_source_refs").notNull(),
  basisVersion: text("basis_version").notNull(), privacyEpoch: integer("privacy_epoch").notNull(), status: text("status").notNull().default("draft"),
  version: integer("version").notNull().default(0), decisionClientKey: text("decision_client_key"), decisionAction: text("decision_action"), result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("opening_assistant_proposals_workspace_owner_key").on(table.workspaceId, table.ownerUserId, table.clientKey),
  index("opening_assistant_proposals_pending_idx").on(table.workspaceId, table.ownerUserId, table.status)]);
