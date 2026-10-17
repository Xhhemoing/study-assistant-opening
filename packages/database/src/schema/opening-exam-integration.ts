import { bigint, boolean, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { openingExamSprints } from "./opening-exam-sprint";
import { courses } from "./courses";
import { openingLearningAttempts } from "./opening-learning-attempts";
import { openingLearningObservations } from "./opening-learning";

export const openingExamBindings = pgTable("opening_exam_bindings", {
  sprintId: uuid("sprint_id").primaryKey().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "no action" }),
  binding: jsonb("binding").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const openingExamIntegrationCommands = pgTable("opening_exam_integration_commands", {
  id: uuid("id").primaryKey(), sprintId: uuid("sprint_id").notNull().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  clientKey: text("client_key").notNull(), intent: jsonb("intent").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("opening_exam_integration_command_key").on(table.sprintId, table.clientKey)]);
export const openingExamSourceMappings = pgTable("opening_exam_source_mappings", {
  sprintId: uuid("sprint_id").notNull().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  sourceItemId: text("source_item_id").notNull(), skillIds: text("skill_ids").array().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.sprintId, table.sourceItemId] })]);
export const openingExamAttemptLinks = pgTable("opening_exam_attempt_links", {
  id: uuid("id").primaryKey(), sprintId: uuid("sprint_id").notNull().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  examAttemptId: text("exam_attempt_id").notNull(),
  learningAttemptId: uuid("learning_attempt_id").notNull().references(() => openingLearningAttempts.id, { onDelete: "no action" }),
  nodeId: uuid("node_id").notNull(), requirementKey: text("requirement_key").notNull(), firstFamilyExposure: boolean("first_family_exposure").notNull(),
  delayedEarliestAt: timestamp("delayed_earliest_at", { withTimezone: true }), submittedAnswer: text("submitted_answer"),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  observationId: uuid("observation_id").references(() => openingLearningObservations.id, { onDelete: "no action" }),
  publication: text("publication").notNull(), prediction: jsonb("prediction"),
}, table => [uniqueIndex("opening_exam_attempt_link_identity").on(table.sprintId, table.examAttemptId),
  uniqueIndex("opening_exam_attempt_link_canonical").on(table.learningAttemptId), uniqueIndex("opening_exam_attempt_link_observation").on(table.observationId)]);
export const openingExamHelpReceipts = pgTable("opening_exam_help_receipts", {
  id: uuid("id").primaryKey(), attemptLinkId: uuid("attempt_link_id").notNull().references(() => openingExamAttemptLinks.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull(),
  historyRevision: bigint("history_revision", { mode: "number" }).notNull(),
  workspaceHistoryRevision: bigint("workspace_history_revision", { mode: "number" }).notNull(), contentSnapshot: text("content_snapshot"),
}, table => [uniqueIndex("opening_exam_help_receipt_kind").on(table.attemptLinkId, table.kind)]);
export const openingExamSourceObservations = pgTable("opening_exam_source_observations", {
  sprintId: uuid("sprint_id").notNull().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  sourceRecordId: text("source_record_id").notNull(),
  skillIds: text("skill_ids").array().notNull(),
  observationId: uuid("observation_id").notNull().references(() => openingLearningObservations.id, { onDelete: "no action" }),
}, table => [primaryKey({ columns: [table.sprintId, table.sourceRecordId] }), uniqueIndex("opening_exam_source_observation_unique").on(table.observationId)]);
