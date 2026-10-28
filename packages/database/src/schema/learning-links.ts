import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./library";
import { users } from "./identity";
import { courses } from "./courses";
import { courseGoals, courseRequirements } from "./goals";

export const courseRequirementEvidenceLinks = pgTable("course_requirement_evidence_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceRequirementId: uuid("source_requirement_id").notNull(), sourceRequirementRevision: integer("source_requirement_revision").notNull(),
  targetRequirementId: uuid("target_requirement_id").notNull(), targetRequirementRevision: integer("target_requirement_revision").notNull(),
  stableSkillId: uuid("stable_skill_id").notNull(), revision: integer("revision").notNull().default(1), active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("course_requirement_evidence_links_workspace_id_id_key").on(table.workspaceId, table.id),
  uniqueIndex("course_requirement_evidence_links_pair_key").on(table.workspaceId, table.sourceRequirementId, table.targetRequirementId),
  foreignKey({ columns: [table.workspaceId, table.sourceRequirementId], foreignColumns: [courseRequirements.workspaceId, courseRequirements.id] }).onDelete("cascade"),
  foreignKey({ columns: [table.workspaceId, table.targetRequirementId], foreignColumns: [courseRequirements.workspaceId, courseRequirements.id] }).onDelete("cascade"),
]);

export const openingLearningAssetLinks = pgTable("opening_learning_asset_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assetType: text("asset_type").notNull(), assetId: uuid("asset_id").notNull(), assetVersion: integer("asset_version"),
  courseId: uuid("course_id"), goalId: uuid("goal_id"), requirementId: uuid("requirement_id"), purpose: text("purpose").notNull(),
  originJson: jsonb("origin_json").notNull().default({}), sourceRefs: jsonb("source_refs").notNull().default([]),
  status: text("status").notNull().default("active"), revision: integer("revision").notNull().default(1),
  clientKey: text("client_key").notNull(), createIntent: jsonb("create_intent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("opening_learning_asset_links_workspace_id_id_key").on(table.workspaceId, table.id),
  uniqueIndex("opening_learning_asset_links_client_key").on(table.workspaceId, table.ownerUserId, table.clientKey),
  foreignKey({ columns: [table.workspaceId, table.courseId], foreignColumns: [courses.workspaceId, courses.id] }),
  foreignKey({ columns: [table.workspaceId, table.goalId], foreignColumns: [courseGoals.workspaceId, courseGoals.id] }),
  foreignKey({ columns: [table.workspaceId, table.requirementId], foreignColumns: [courseRequirements.workspaceId, courseRequirements.id] }),
  index("opening_learning_asset_links_asset_idx").on(table.workspaceId, table.ownerUserId, table.assetType, table.assetId, table.createdAt, table.id),
  index("opening_learning_asset_links_course_idx").on(table.workspaceId, table.courseId, table.createdAt, table.id),
]);
