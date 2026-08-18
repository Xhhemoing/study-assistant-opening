import {
  boolean,
  date,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./library";
import { users } from "./identity";

export const cards = pgTable(
  "cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    front: text("front").notNull(),
    back: text("back").notNull(),
    sourceDocumentId: uuid("source_document_id"),
    syllabusPointId: uuid("syllabus_point_id"),
    tags: text("tags").array().notNull().default([]),
    archived: boolean("archived").notNull().default(false),
    contentVersion: integer("content_version").notNull().default(1),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    maintainUntil: date("maintain_until"),
    excludeFromAssessment: boolean("exclude_from_assessment").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("cards_workspace_id_id_uidx").on(table.workspaceId, table.id)],
);

export const cardReviewStates = pgTable(
  "card_review_states",
  {
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ease: doublePrecision("ease").notNull(),
    intervalDays: integer("interval_days").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    lastGrade: text("last_grade"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.cardId] }),
    uniqueIndex("card_review_states_workspace_owner_card_uidx").on(
      table.workspaceId,
      table.ownerUserId,
      table.cardId,
    ),
  ],
);

export const cardsSchema = { cards, cardReviewStates };
