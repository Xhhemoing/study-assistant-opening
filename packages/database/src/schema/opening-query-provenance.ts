import { bigint, index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./library";
import { sql } from "drizzle-orm";
export const openingQueryEphemeralProvenance = pgTable("opening_query_ephemeral_provenance", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull(), requestId: text("request_id").notNull(),
  privacyEpoch: bigint("privacy_epoch", { mode: "number" }).notNull(), contextSourceRefs: jsonb("context_source_refs").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now()+interval '24 hours'`),
}, table => [uniqueIndex("opening_query_ephemeral_provenance_scope_request_uidx").on(table.workspaceId, table.ownerUserId, table.requestId), index("opening_query_ephemeral_provenance_expiry_idx").on(table.expiresAt)]);
