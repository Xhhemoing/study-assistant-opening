import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Paper learning session ownership + source binding (L01). */
export const openingLearningSessions = pgTable("opening_learning_sessions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerUserId: uuid("owner_user_id").notNull(),
  courseId: uuid("course_id").notNull(),
  skillLabel: text("skill_label").notNull(),
  sourceIds: uuid("source_ids").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Problem identity snapshot; upserted when binding observations/help. */
export const openingProblemRefs = pgTable("opening_problem_refs", {
  problemId: uuid("problem_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => openingLearningSessions.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  physicalPage: integer("physical_page"),
  chunkId: uuid("chunk_id"),
  stemSnapshot: text("stem_snapshot").notNull(),
  artifactKind: text("artifact_kind").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Server-confirmed help only (delivered = true). */
export const openingHelpExposures = pgTable("opening_help_exposures", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => openingLearningSessions.id, { onDelete: "cascade" }),
  problemId: uuid("problem_id"),
  turnId: uuid("turn_id").notNull(),
  level: text("level").notNull(),
  delivered: boolean("delivered").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingLearningObservations = pgTable(
  "opening_learning_observations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => openingLearningSessions.id, { onDelete: "cascade" }),
    courseId: uuid("course_id").notNull(),
    skillLabel: text("skill_label").notNull(),
    sourceIds: uuid("source_ids").array().notNull().default([]),
    problemId: uuid("problem_id"),
    retestId: uuid("retest_id"),
    answer: text("answer").notNull(),
    outcome: text("outcome").notNull(),
    assistance: text("assistance").notNull(),
    clientKey: text("client_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceTurnIds: uuid("source_turn_ids").array().notNull().default([]),
    verdictSource: text("verdict_source").notNull(),
    referenceSourceId: uuid("reference_source_id"),
    evidenceVerdict: text("evidence_verdict")
      .notNull()
      .default("MASTERY_NOT_ESTABLISHED"),
  },
  (t) => ({
    clientKeyUnique: uniqueIndex("opening_learning_observations_workspace_client_key").on(
      t.workspaceId,
      t.clientKey,
    ),
  }),
);
