import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./library";
export const openingLearningExperienceEvents = pgTable("opening_learning_experience_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(), kind: text("kind").notNull(), targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(), localDay: date("local_day").notNull(), durationMs: integer("duration_ms"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  executionId: uuid("execution_id"),
  observedAt: timestamp("observed_at", { withTimezone: true }),
}, table => [uniqueIndex("opening_learning_experience_key_uidx").on(table.workspaceId, table.ownerUserId, table.eventKey)]);
