import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ExamPack, ExamSprintCommand, ExamSprintState } from "@aistudy/contracts";
import { users } from "./identity";
import { workspaces } from "./library";

export const openingExamSprints = pgTable("opening_exam_sprints", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  packSnapshot: jsonb("pack_snapshot").$type<ExamPack>().notNull(),
  state: jsonb("state").$type<ExamSprintState>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("opening_exam_sprint_scope_unique").on(table.workspaceId, table.ownerUserId)]);

export const openingExamSprintCommands = pgTable("opening_exam_sprint_commands", {
  id: uuid("id").primaryKey(),
  sprintId: uuid("sprint_id").notNull().references(() => openingExamSprints.id, { onDelete: "cascade" }),
  clientKey: text("client_key").notNull(),
  intent: jsonb("intent").$type<ExamSprintCommand>().notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("opening_exam_sprint_command_key_unique").on(table.sprintId, table.clientKey),
  index("opening_exam_sprint_command_recorded_idx").on(table.sprintId, table.recordedAt, table.id),
]);
