import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./library";

export const openingJobs = pgTable(
  "opening_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    result: jsonb("result"),
    state: text("state").notNull().default("queued"),
    privacyEpoch: integer("privacy_epoch").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opening_jobs_workspace_key_uidx").on(t.workspaceId, t.key)],
);

export const openingOutbox = pgTable("opening_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => openingJobs.id, { onDelete: "cascade" }),
  topic: text("topic").notNull(),
  payload: jsonb("payload").notNull(),
  state: text("state").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const openingJobsSchema = { openingJobs, openingOutbox };
