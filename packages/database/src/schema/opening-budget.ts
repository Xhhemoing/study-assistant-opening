import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const openingBudgetReservations = pgTable("opening_budget_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  modelSnapshot: jsonb("model_snapshot"),
  amountCents: integer("amount_cents").notNull(),
  requestId: text("request_id").notNull().unique(),
  state: text("state").notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // 0058 (PR-D): execution claim + observable reconcile.
  executionClaimedAt: timestamp("execution_claimed_at", { withTimezone: true }),
  outcomeUnknownAt: timestamp("outcome_unknown_at", { withTimezone: true }),
  releaseReason: text("release_reason"),
  resultRef: text("result_ref"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  reservedAmountCents: integer("reserved_amount_cents"),
  pendingReconcileCents: integer("pending_reconcile_cents").notNull().default(0),
});

export const openingBudgetReconcileEvents = pgTable("opening_budget_reconcile_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  reservationId: uuid("reservation_id").notNull().references(() => openingBudgetReservations.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  amountBeforeCents: integer("amount_before_cents").notNull(),
  amountAfterCents: integer("amount_after_cents").notNull(),
  reportedActualCents: integer("reported_actual_cents"),
  stateBefore: text("state_before").notNull(),
  capCents: integer("cap_cents"),
  usageAfterCents: integer("usage_after_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.reservationId, t.kind)]);

export const openingBudgetSchema = { openingBudgetReservations, openingBudgetReconcileEvents };
