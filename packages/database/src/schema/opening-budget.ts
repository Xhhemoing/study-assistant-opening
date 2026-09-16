import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const openingBudgetReservations = pgTable("opening_budget_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  amountCents: integer("amount_cents").notNull(),
  requestId: text("request_id").notNull().unique(),
  state: text("state").notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingBudgetSchema = { openingBudgetReservations };
