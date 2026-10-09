import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { workspaces } from "./library";

/** Durable P04 accept/reject/superseded overlay — see migration 0052. */
export const openingActionDigestDecisions = pgTable(
  "opening_action_digest_decisions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    title: text("title").notNull(),
    minutes: integer("minutes").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    priority: doublePrecision("priority").notNull(),
    sourceIds: uuid("source_ids").array().notNull().default([]),
    needsConfirmation: boolean("needs_confirmation").notNull().default(false),
    status: text("status").notNull(),
    clientKey: text("client_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("opening_action_digest_decisions_scope_candidate_uidx").on(
      table.workspaceId,
      table.ownerUserId,
      table.candidateId,
    ),
    index("opening_action_digest_decisions_owner_idx").on(
      table.workspaceId,
      table.ownerUserId,
    ),
    index("opening_action_digest_decisions_dedupe_idx").on(
      table.workspaceId,
      table.ownerUserId,
      table.dedupeKey,
    ),
    uniqueIndex("opening_action_digest_decisions_client_key_uidx")
      .on(table.workspaceId, table.ownerUserId, table.clientKey)
      .where(sql`${table.clientKey} IS NOT NULL`),
  ],
);

export const openingActionDigestDecisionsSchema = { openingActionDigestDecisions };
