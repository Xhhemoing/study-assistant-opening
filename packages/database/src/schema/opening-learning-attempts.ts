import { bigint, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { openingLearningSessions } from "./opening-learning";
export const openingLearningHistoryRevisions = pgTable("opening_learning_history_revisions", {
  workspaceId: uuid("workspace_id").notNull(), ownerUserId: uuid("owner_user_id").notNull(), courseId: uuid("course_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.ownerUserId, t.courseId] }) }));
export const openingLearningItemVersions = pgTable("opening_learning_item_versions", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull(), ownerUserId: uuid("owner_user_id").notNull(),
  courseId: uuid("course_id").notNull(), problemId: uuid("problem_id").notNull(), sourceId: uuid("source_id").notNull(), sourceVersion: integer("source_version").notNull(),
  physicalPage: integer("physical_page"), chunkId: uuid("chunk_id"), stemSnapshot: text("stem_snapshot").notNull(), artifactKind: text("artifact_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const openingLearningAttempts = pgTable("opening_learning_attempts", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull(), ownerUserId: uuid("owner_user_id").notNull(),
  sessionId: uuid("session_id").notNull().references(() => openingLearningSessions.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull(), skillLabel: text("skill_label").notNull(), requirementKey: text("requirement_key"),
  problemId: uuid("problem_id"), itemVersionId: uuid("item_version_id").references(() => openingLearningItemVersions.id),
  sourceIds: uuid("source_ids").array().notNull().default([]), sourceVersions: jsonb("source_versions").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(), submittedAt: timestamp("submitted_at", { withTimezone: true }),
  observationId: uuid("observation_id"), clientKey: text("client_key").notNull(), createIntent: jsonb("create_intent").notNull(), historyRevision: bigint("history_revision", { mode: "number" }).notNull(),
}, (t) => ({ key: uniqueIndex("opening_learning_attempts_workspace_owner_key").on(t.workspaceId, t.ownerUserId, t.clientKey) }));
export const openingSourceVersions = pgTable("opening_source_versions", {
  sourceId: uuid("source_id").notNull(), version: integer("version").notNull(), workspaceId: uuid("workspace_id").notNull(),
  bytes: bigint("bytes", { mode: "number" }), sha256: text("sha256"), availability: text("availability").notNull().default("unknown"),
}, (t) => ({ pk: primaryKey({ columns: [t.sourceId,t.version] }) }));
