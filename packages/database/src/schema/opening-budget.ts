import { integer, jsonb, pgTable, text, timestamp, unique, uuid, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { workspaces } from "./library";

export const openingParentInteractionBudgets = pgTable("opening_parent_interaction_budgets", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  budgetCents: integer("budget_cents").notNull(),
  maxProviderCalls: integer("max_provider_calls").notNull(),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  blockedReason: text("blocked_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.id] })]);

export const openingBudgetReservations = pgTable("opening_budget_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  parentInteractionId: text("parent_interaction_id"),
  settlementCostBasis: text("settlement_cost_basis"),
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
}, (t) => [foreignKey({ columns: [t.workspaceId, t.parentInteractionId], foreignColumns: [openingParentInteractionBudgets.workspaceId, openingParentInteractionBudgets.id] })]);

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

export const openingBudgetSchema = { openingParentInteractionBudgets, openingBudgetReservations, openingBudgetReconcileEvents };
