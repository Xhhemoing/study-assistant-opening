import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { users } from "./identity";
import { workspaces } from "./library";

export const openingMeasurementTrials = pgTable("opening_measurement_trials", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  unitId: text("unit_id").notNull(), protocolVersion: text("protocol_version").notNull(),
  bankVersion: text("bank_version").notNull(), models: jsonb("models").notNull(), catalog: jsonb("catalog").notNull(),
  selectionPolicy: text("selection_policy").notNull(), status: text("status").notNull(),
  clientKey: text("client_key").notNull(), createIntent: jsonb("create_intent").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  practiceCompletedAt: timestamp("practice_completed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("opening_measurement_trial_client_key").on(t.workspaceId, t.ownerUserId, t.clientKey),
  uniqueIndex("opening_measurement_trial_unit").on(t.workspaceId, t.ownerUserId, t.unitId),
]);

export const openingMeasurementAttempts = pgTable("opening_measurement_attempts", {
  id: uuid("id").primaryKey(),
  trialId: uuid("trial_id").notNull().references(() => openingMeasurementTrials.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(), itemSnapshot: jsonb("item_snapshot").notNull(),
  firstAttempt: boolean("first_attempt").notNull(), predictions: jsonb("predictions").notNull(),
  presentedAt: timestamp("presented_at", { withTimezone: true }).notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }), helpEvents: jsonb("help_events").notNull().default([]),
  answer: text("answer"), outcome: text("outcome"), answeredAt: timestamp("answered_at", { withTimezone: true }),
  feedback: text("feedback"), retractedAt: timestamp("retracted_at", { withTimezone: true }),
  retractionReason: text("retraction_reason"),
}, (t) => [uniqueIndex("opening_measurement_attempt_ordinal").on(t.trialId, t.ordinal)]);

export const openingMeasurementCommands = pgTable("opening_measurement_commands", {
  id: uuid("id").primaryKey(),
  trialId: uuid("trial_id").notNull().references(() => openingMeasurementTrials.id, { onDelete: "cascade" }),
  attemptId: uuid("attempt_id").references(() => openingMeasurementAttempts.id, { onDelete: "cascade" }),
  clientKey: text("client_key").notNull(), intent: jsonb("intent").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("opening_measurement_command_key").on(t.trialId, t.clientKey)]);
