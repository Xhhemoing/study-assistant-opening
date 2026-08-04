import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { users } from "./identity";
import { workspaces } from "./library";

export const explorations = pgTable(
  "explorations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
    goalId: uuid("goal_id"),
    title: text("title").notNull(),
    status: text("status").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("explorations_workspace_id_id_uidx").on(table.workspaceId, table.id),
  ],
);

export const explorationBranches = pgTable(
  "exploration_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    explorationId: uuid("exploration_id").notNull().references(() => explorations.id, { onDelete: "cascade" }),
    parentBranchId: uuid("parent_branch_id"),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("exploration_branches_workspace_id_id_uidx").on(table.workspaceId, table.id),
    uniqueIndex("exploration_branches_workspace_exploration_id_uidx").on(table.workspaceId, table.explorationId, table.id),
  ],
);

export const explorationBlocks = pgTable(
  "exploration_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    explorationId: uuid("exploration_id").notNull().references(() => explorations.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("exploration_blocks_branch_position_uidx").on(table.branchId, table.position),
  ],
);

export const explorationSchema = { explorations, explorationBranches, explorationBlocks };
