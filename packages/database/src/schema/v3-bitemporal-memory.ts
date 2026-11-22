import { sql } from "drizzle-orm";
import { check, customType, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { users } from "./identity";
import { workspaces } from "./library";

const tstzrange = customType<{ data: string }>({ dataType: () => "tstzrange" });
const statuses = ["candidate", "verified", "learner_reported", "retracted", "superseded"] as const;
const origins = ["public_try_handoff", "system_diagnosis", "learner_correction"] as const;
export const learnerMisconceptionDispositions = ["disputed", "clarified", "resolved_self_report"] as const;
export type LearnerMisconceptionDisposition = typeof learnerMisconceptionDispositions[number];
export const LEARNER_CONTEXT_MAX_BYTES = 2048;

// Migration 0113 owns the GiST exclusions and the close-only trigger.
export const v3BitemporalMisconceptionEdges = pgTable("v3_bitemporal_misconception_edges", {
  revisionId: uuid("revision_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  edgeId: uuid("edge_id").notNull(),
  courseId: uuid("course_id"),
  conceptKey: text("concept_key").notNull(),
  misconceptionCode: text("misconception_code").notNull(),
  summary: text("summary").notNull(),
  status: text("status", { enum: statuses }).notNull(),
  origin: text("origin", { enum: origins }).notNull(),
  learnerDisposition: text("learner_disposition", { enum: learnerMisconceptionDispositions }),
  evidenceAttemptIds: uuid("evidence_attempt_ids").array().notNull().default(sql`'{}'::uuid[]`),
  privacyEpoch: integer("privacy_epoch").notNull().default(0),
  validRange: tstzrange("valid_range").notNull(),
  txRange: tstzrange("tx_range").notNull(),
  priorRevisionId: uuid("prior_revision_id"),
}, t => [
  unique("v3_misconception_revision_scope").on(t.workspaceId, t.ownerUserId, t.edgeId, t.revisionId),
  foreignKey({ name: "v3_misconception_course_scope", columns: [t.workspaceId, t.courseId],
    foreignColumns: [courses.workspaceId, courses.id] }).onDelete("cascade"),
  foreignKey({ name: "v3_misconception_prior_scope", columns: [t.workspaceId, t.ownerUserId, t.edgeId, t.priorRevisionId],
    foreignColumns: [t.workspaceId, t.ownerUserId, t.edgeId, t.revisionId] }),
]);

export const v3LearnerContextBlocks = pgTable("v3_learner_context_blocks", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  renderedMarkdown: text("rendered_markdown").notNull(),
  byteLength: integer("byte_length").notNull(),
  revision: integer("revision").notNull(),
  privacyEpoch: integer("privacy_epoch").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, t => [
  primaryKey({ columns: [t.workspaceId, t.ownerUserId] }),
  check("v3_learner_context_blocks_rendered_markdown_check", sql`octet_length(${t.renderedMarkdown}) <= ${sql.raw(String(LEARNER_CONTEXT_MAX_BYTES))}`),
  check("v3_learner_context_blocks_byte_length_check",
    sql`${t.byteLength} BETWEEN 0 AND ${sql.raw(String(LEARNER_CONTEXT_MAX_BYTES))} AND ${t.byteLength} = octet_length(${t.renderedMarkdown})`),
]);

export const v3TryMisconceptionHandoffReceipts = pgTable("v3_try_misconception_handoff_receipts", {
  receiptId: uuid("receipt_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  payloadSha256: text("payload_sha256").notNull(),
  edgeId: uuid("edge_id").notNull(),
  initialRevisionId: uuid("initial_revision_id").notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull(),
}, t => [
  foreignKey({ name: "v3_try_misconception_initial_scope",
    columns: [t.workspaceId, t.ownerUserId, t.edgeId, t.initialRevisionId],
    foreignColumns: [v3BitemporalMisconceptionEdges.workspaceId, v3BitemporalMisconceptionEdges.ownerUserId,
      v3BitemporalMisconceptionEdges.edgeId, v3BitemporalMisconceptionEdges.revisionId] }),
]);
