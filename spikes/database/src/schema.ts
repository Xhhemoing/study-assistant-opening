import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const spikeEvents = pgTable("spike_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
