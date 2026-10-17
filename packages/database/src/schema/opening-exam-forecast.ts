import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./library";
import { courses } from "./courses";
import { openingSources } from "./opening-sources";
import { openingExamSprints } from "./opening-exam-sprint";

export const openingExamPapers = pgTable("opening_exam_papers", {
  id: uuid("id").primaryKey(),
  sprintId: uuid("sprint_id").notNull().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => openingSources.id, { onDelete: "cascade" }),
  sourceVersion: integer("source_version").notNull(), teacher: text("teacher").notNull(), year: integer("year").notNull(),
  label: text("label").notNull(), kind: text("kind").notNull(), skills: jsonb("skills").notNull(),
  clientKey: text("client_key").notNull(), intent: jsonb("intent").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("opening_exam_paper_command_unique").on(table.workspaceId, table.ownerUserId, table.clientKey),
  uniqueIndex("opening_exam_paper_source_unique").on(table.sprintId, table.sourceId, table.sourceVersion),
  index("opening_exam_paper_course_idx").on(table.workspaceId, table.ownerUserId, table.courseId)]);

export const openingExamReviews = pgTable("opening_exam_reviews", {
  id: uuid("id").primaryKey(),
  sprintId: uuid("sprint_id").notNull().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceItemId: text("source_item_id").notNull(),
  workSourceId: uuid("work_source_id").notNull().references(() => openingSources.id, { onDelete: "cascade" }),
  workSourceVersion: integer("work_source_version").notNull(),
  referenceSourceId: uuid("reference_source_id").notNull().references(() => openingSources.id, { onDelete: "cascade" }),
  referenceSourceVersion: integer("reference_source_version").notNull(), answerText: text("answer_text").notNull().default(""),
  clientKey: text("client_key").notNull(), intent: jsonb("intent").notNull(), status: text("status").notNull(), proposal: jsonb("proposal"),
  modelLabel: text("model_label"), privacyEpoch: bigint("privacy_epoch", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("opening_exam_review_command_unique").on(table.workspaceId, table.ownerUserId, table.clientKey),
  index("opening_exam_review_sprint_idx").on(table.sprintId, table.createdAt, table.id)]);
