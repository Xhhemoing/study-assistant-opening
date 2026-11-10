import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./library";
import { openingLearningObservations } from "./opening-learning";
import { openingJobs } from "./opening-jobs";

export const openingExplicitRegradeRequests = pgTable("opening_explicit_regrade_requests", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  rootObservationId: uuid("root_observation_id").notNull().references(() => openingLearningObservations.id, { onDelete: "cascade" }),
  expectedHeadId: uuid("expected_head_id").notNull().references(() => openingLearningObservations.id, { onDelete: "cascade" }),
  answerRevision: integer("answer_revision").notNull(),
  privacyEpoch: integer("privacy_epoch").notNull(),
  previousGradingVersion: integer("previous_grading_version").notNull(),
  gradingVersion: integer("grading_version").notNull(),
  previousOperationId: text("previous_operation_id").notNull(),
  operationId: text("operation_id").notNull(),
  clientKey: text("client_key").notNull(),
  confirmationVersion: text("confirmation_version").notNull(),
  workSource: jsonb("work_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  jobId: uuid("job_id").references(() => openingJobs.id),
  resultObservationId: uuid("result_observation_id").references(() => openingLearningObservations.id),
}, t => [
  uniqueIndex("opening_explicit_regrade_client_unique").on(t.workspaceId, t.ownerUserId, t.clientKey),
  uniqueIndex("opening_explicit_regrade_operation_unique").on(t.workspaceId, t.operationId),
  uniqueIndex("opening_explicit_regrade_single_successor").on(t.workspaceId, t.ownerUserId, t.rootObservationId, t.answerRevision, t.previousGradingVersion).where(sql`${t.confirmedAt} IS NOT NULL`),
  index("opening_explicit_regrade_current").on(t.workspaceId, t.ownerUserId, t.rootObservationId, t.answerRevision, t.gradingVersion.desc()).where(sql`${t.confirmedAt} IS NOT NULL`),
  check("opening_explicit_regrade_answer_revision", sql`${t.answerRevision} > 0`),
  check("opening_explicit_regrade_epoch", sql`${t.privacyEpoch} >= 0`),
  check("opening_explicit_regrade_version", sql`${t.previousGradingVersion} >= 0 AND ${t.gradingVersion} = ${t.previousGradingVersion} + 1`),
  check("opening_explicit_regrade_confirmation", sql`${t.confirmationVersion} = 'double-charge-v1'`),
  check("opening_explicit_regrade_operation", sql`${t.operationId} = 'ai-regrade:' || ${t.workspaceId}::text || ':' || ${t.id}::text`),
  check("opening_explicit_regrade_job_confirmation", sql`${t.jobId} IS NULL OR ${t.confirmedAt} IS NOT NULL`),
  check("opening_explicit_regrade_result_job", sql`${t.resultObservationId} IS NULL OR ${t.jobId} IS NOT NULL`),
]);
