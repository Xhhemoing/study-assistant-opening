import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./library";
import { users } from "./identity";

export const learningEvents = pgTable(
  "learning_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    contentId: uuid("content_id"),
    contentVersion: integer("content_version"),
    syllabusPointId: uuid("syllabus_point_id"),
    correctsEventId: uuid("corrects_event_id"),
    payload: jsonb("payload").notNull(),
  },
  (table) => [
    uniqueIndex("learning_events_workspace_id_id_uidx").on(table.workspaceId, table.id),
    uniqueIndex("learning_events_workspace_owner_idempotency_uidx").on(
      table.workspaceId,
      table.ownerUserId,
      table.idempotencyKey,
    ),
  ],
);

export const learningEventsSchema = { learningEvents };
