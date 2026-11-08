import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { courseRequirements } from "./goals";
import { users } from "./identity";
import { workspaces } from "./library";
import { openingLearningItemVersions } from "./opening-learning-attempts";
import { openingTeachingActivities } from "./opening-teaching-activities";

/** Server-only exposure ledger. Nullable exact content is unknown, never unseen.
 * Historical versions remain pinned; SQL scope/immutability triggers own write invariants.
 */
export const openingCourseQuestionExposures = pgTable("opening_course_question_exposures", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceKey: text("surface_key").notNull(),
  kind: text("kind").notNull(),
  identityRefId: uuid("identity_ref_id"),
  exactContent: jsonb("exact_content"),
  familyId: text("family_id"),
  sourceVersions: jsonb("source_versions").notNull(),
  itemVersionId: uuid("item_version_id").references(() => openingLearningItemVersions.id),
  historyRevision: bigint("history_revision", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique().on(t.workspaceId, t.ownerUserId, t.surfaceKey),
  index("opening_course_question_exposures_history_idx").on(t.workspaceId, t.ownerUserId, t.historyRevision),
  check("opening_course_question_exposures_surface", sql`char_length(${t.surfaceKey}) BETWEEN 1 AND 240`),
  check("opening_course_question_exposures_kind", sql`${t.kind} IN ('teaching','example','hint','presented')`),
  check("opening_course_question_exposures_exact", sql`${t.exactContent} IS NULL OR jsonb_typeof(${t.exactContent}) = 'object'`),
  check("opening_course_question_exposures_sources", sql`jsonb_typeof(${t.sourceVersions}) = 'object'`),
  check("opening_course_question_exposures_history", sql`${t.historyRevision} >= 0`),
]);

/** A persistence slot, NOT authority supplied by a caller. Only new workspaces get an incomplete genesis.
 * Phase 2 must establish completeness and compare the live workspace history watermark.
 */
export const openingCourseQuestionExposureCoverage = pgTable("opening_course_question_exposure_coverage", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  protocol: text("protocol").notNull(),
  historyRevision: bigint("history_revision", { mode: "number" }).notNull(),
  complete: boolean("complete").notNull().default(false),
  invalidated: boolean("invalidated").notNull().default(false),
  coveredSurfaceCount: bigint("covered_surface_count", { mode: "number" }).notNull(),
}, t => [
  primaryKey({ columns: [t.workspaceId, t.ownerUserId] }),
  check("opening_course_question_exposure_coverage_protocol", sql`${t.protocol} = 'course-question-exposure-1'`),
  check("opening_course_question_exposure_coverage_history", sql`${t.historyRevision} >= 0`),
  check("opening_course_question_exposure_coverage_count", sql`${t.coveredSurfaceCount} >= 0`),
]);

/** Private supply only. Never project these JSON bodies into public blocks or backup responses.
 * Immutable bodies are owned exclusively by opening-course-reserved-selection.
 * Neither an available row nor an empty help ledger establishes unseen eligibility.
 */
export const openingCourseReservedQuestions = pgTable("opening_course_reserved_questions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull(),
  requirementId: uuid("requirement_id").notNull(),
  requirementRevision: integer("requirement_revision").notNull(),
  sourceVersions: jsonb("source_versions").notNull(),
  identityRefId: uuid("identity_ref_id").notNull(),
  identityJson: jsonb("identity_json").notNull(),
  familyId: text("family_id").notNull(),
  contentRefId: uuid("content_ref_id").notNull(),
  keyRefId: uuid("key_ref_id").notNull(),
  questionJson: jsonb("question_json").notNull(),
  interactionJson: jsonb("interaction_json").notNull(),
  keyJson: jsonb("key_json").notNull(),
  state: text("state").notNull().default("available"),
  reservationKey: text("reservation_key"),
  reservedActivityId: uuid("reserved_activity_id").references(() => openingTeachingActivities.id),
  reservedAt: timestamp("reserved_at", { withTimezone: true }),
  issuedItemVersionId: uuid("issued_item_version_id").references(() => openingLearningItemVersions.id),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.workspaceId, t.courseId], foreignColumns: [courses.workspaceId, courses.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.workspaceId, t.requirementId], foreignColumns: [courseRequirements.workspaceId, courseRequirements.id] }).onDelete("cascade"),
  unique().on(t.workspaceId, t.ownerUserId, t.identityRefId),
  unique().on(t.workspaceId, t.ownerUserId, t.contentRefId),
  unique().on(t.workspaceId, t.ownerUserId, t.keyRefId),
  unique().on(t.workspaceId, t.ownerUserId, t.reservationKey),
  unique().on(t.issuedItemVersionId),
  index("opening_course_reserved_questions_supply_idx").on(t.workspaceId, t.ownerUserId, t.courseId, t.requirementId, t.requirementRevision, t.state),
  check("opening_course_reserved_questions_revision", sql`${t.requirementRevision} > 0`),
  check("opening_course_reserved_questions_sources", sql`jsonb_typeof(${t.sourceVersions}) = 'object' AND ${t.sourceVersions} <> '{}'::jsonb`),
  check("opening_course_reserved_questions_family", sql`char_length(${t.familyId}) BETWEEN 1 AND 100`),
  check("opening_course_reserved_questions_json", sql`jsonb_typeof(${t.identityJson}) = 'object' AND jsonb_typeof(${t.questionJson}) = 'object'
    AND jsonb_typeof(${t.interactionJson}) = 'object' AND jsonb_typeof(${t.keyJson}) = 'object'`),
  check("opening_course_reserved_questions_reservation_key", sql`char_length(${t.reservationKey}) BETWEEN 8 AND 200`),
  check("opening_course_reserved_questions_reservation", sql`(${t.reservationKey} IS NULL AND ${t.reservedActivityId} IS NULL AND ${t.reservedAt} IS NULL)
    OR (${t.reservationKey} IS NOT NULL AND ${t.reservedActivityId} IS NOT NULL AND ${t.reservedAt} IS NOT NULL)`),
  check("opening_course_reserved_questions_issuance", sql`(${t.issuedItemVersionId} IS NULL) = (${t.issuedAt} IS NULL)
    AND (${t.issuedAt} IS NULL OR (${t.reservedAt} IS NOT NULL AND ${t.issuedAt} >= ${t.reservedAt}))`),
  check("opening_course_reserved_questions_state", sql`(${t.state} = 'available' AND ${t.reservedAt} IS NULL AND ${t.issuedAt} IS NULL AND ${t.revokedAt} IS NULL)
    OR (${t.state} = 'reserved' AND ${t.reservedAt} IS NOT NULL AND ${t.issuedAt} IS NULL AND ${t.revokedAt} IS NULL)
    OR (${t.state} = 'issued' AND ${t.reservedAt} IS NOT NULL AND ${t.issuedAt} IS NOT NULL AND ${t.revokedAt} IS NULL)
    OR (${t.state} = 'revoked' AND ${t.revokedAt} IS NOT NULL)`),
  check("opening_course_reserved_questions_identity", sql`${t.identityJson}->>'identityRefId' IS NOT NULL AND ${t.identityJson}->>'identityRefId' = ${t.identityRefId}::text
    AND ${t.keyJson}->>'keyRefId' IS NOT NULL AND ${t.keyJson}->>'keyRefId' = ${t.keyRefId}::text
    AND ${t.keyJson}->'identity' IS NOT NULL AND ${t.keyJson}->'identity' = ${t.identityJson}`),
]);
