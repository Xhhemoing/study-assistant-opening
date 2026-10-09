import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { courses } from "./courses";
import { users } from "./identity";
import { workspaces } from "./library";
import { openingLearningObservations } from "./opening-learning";

/** K02 SkillEvidence projection — links observations to knowledge node ids (no nodes table FK). */
export const openingSkillEvidence = pgTable(
  "opening_skill_evidence",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull(),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => openingLearningObservations.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("opening_skill_evidence_link_uidx").on(
      table.workspaceId,
      table.observationId,
      table.nodeId,
      table.dimension,
    ),
  ],
);

export const openingSkillEvidenceSchema = { openingSkillEvidence };
