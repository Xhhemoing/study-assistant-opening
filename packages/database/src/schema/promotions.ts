import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { explorations } from "./explorations";
import { workspaces } from "./library";
export const promotionRecords = pgTable(
  "promotion_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id, { onDelete: "cascade" }),
    sourceTurnId: uuid("source_turn_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("promotion_records_workspace_id_id_uidx").on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex("promotion_records_target_uidx").on(
      table.targetType,
      table.targetId,
    ),
  ],
);
export const promotionTargets = pgTable(
  "promotion_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    promotionId: uuid("promotion_id")
      .notNull()
      .references(() => promotionRecords.id, { onDelete: "cascade" }),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id, { onDelete: "cascade" }),
    sourceTurnId: uuid("source_turn_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("promotion_targets_promotion_uidx").on(table.promotionId),
  ],
);
export const promotionSchema = { promotionRecords, promotionTargets };
