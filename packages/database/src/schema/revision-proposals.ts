import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { libraryDocuments, workspaces } from "./library";

export const revisionProposals = pgTable(
  "revision_proposals",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => libraryDocuments.id, { onDelete: "cascade" }),
    baseRevisionNumber: integer("base_revision_number").notNull(),
    baseTitle: text("base_title").notNull(),
    baseBlocks: jsonb("base_blocks").$type<RevisionProposalJsonBlock[]>().notNull(),
    proposedTitle: text("proposed_title"),
    proposedBlocks: jsonb("proposed_blocks").$type<RevisionProposalJsonBlock[]>().notNull(),
    diff: jsonb("diff").$type<RevisionProposalJsonDiff[]>().notNull(),
    source: jsonb("source").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    supportState: text("support_state").notNull(),
    status: text("status").notNull().default("pending"),
    reviewAction: text("review_action"),
    reviewerUserId: uuid("reviewer_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    resultingRevisionNumber: integer("resulting_revision_number"),
    currentConflict: jsonb("current_conflict").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("revision_proposals_workspace_id_uidx").on(table.workspaceId, table.id),
    uniqueIndex("revision_proposals_document_revision_uidx")
      .on(table.workspaceId, table.documentId, table.resultingRevisionNumber)
      .where(sql`${table.resultingRevisionNumber} IS NOT NULL`),
  ],
);

export type RevisionProposalJsonBlock = {
  id: string;
  type: string;
  position: number;
  content: Record<string, unknown>;
};
export type RevisionProposalJsonDiff = {
  blockId: string;
  kind: string;
  base: RevisionProposalJsonBlock | null;
  proposed: RevisionProposalJsonBlock | null;
};
export const revisionProposalSchema = { revisionProposals };
