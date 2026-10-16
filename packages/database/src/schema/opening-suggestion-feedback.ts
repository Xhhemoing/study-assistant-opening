import { date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { openingPlanDrafts } from "./opening-planning";
import { users } from "./identity";
import { workspaces } from "./library";
import { courses } from "./courses";

export const openingSuggestionFeedback = pgTable("opening_suggestion_feedback", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  draftId: uuid("draft_id").notNull().references(() => openingPlanDrafts.id, { onDelete: "cascade" }),
  day: date("day").notNull(), suggestionKey: text("suggestion_key").notNull(), identity: text("identity").notNull(),
  suggestionKind: text("suggestion_kind").notNull(), courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
  requirementKey: text("requirement_key"), reason: text("reason"), recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  clientKey: text("client_key").notNull(), intent: jsonb("intent").notNull(),
}, table => [uniqueIndex("opening_suggestion_feedback_client_idx").on(table.workspaceId, table.ownerUserId, table.clientKey),
  uniqueIndex("opening_suggestion_feedback_identity_idx").on(table.workspaceId, table.ownerUserId, table.day, table.identity),
  index("opening_suggestion_feedback_scope_recorded_idx").on(table.workspaceId, table.ownerUserId, table.recordedAt)]);
