import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
export const openingStudyIntentEvents = pgTable("opening_study_intent_events", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull(), ownerUserId: uuid("owner_user_id").notNull(),
  sessionId: uuid("session_id").notNull(), activityId: uuid("activity_id").notNull(), attemptId: uuid("attempt_id"),
  clientKey: text("client_key").notNull(), version: integer("version").notNull(), eventKind: text("event_kind").notNull(),
  payload: jsonb("payload").notNull(), resultingIntent: jsonb("resulting_intent").notNull(), action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("opening_study_intent_events_replay").on(table.workspaceId, table.ownerUserId, table.clientKey),
  uniqueIndex("opening_study_intent_events_order").on(table.sessionId, table.version)]);
