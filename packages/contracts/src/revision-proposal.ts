import { z } from "zod";

const uuidSchema = z.uuid();
const recordSchema = z.record(z.string(), z.unknown());

export const revisionProposalStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "conflicted",
]);
export const revisionProposalSupportStateSchema = z.enum([
  "supported",
  "partial",
  "insufficient",
  "conflicting",
  "inference",
]);
export type RevisionProposalSupportState = z.infer<typeof revisionProposalSupportStateSchema>;
export const revisionProposalDiffKindSchema = z.enum([
  "added",
  "removed",
  "changed",
  "unchanged",
]);
export const revisionProposalActionSchema = z.enum([
  "accept",
  "partial_accept",
  "reject",
  "preserve_both",
]);
export type RevisionProposalAction = z.infer<typeof revisionProposalActionSchema>;

export const revisionProposalBlockSchema = z.object({
  id: uuidSchema,
  type: z.string().trim().min(1).max(120),
  position: z.number().int().nonnegative(),
  content: recordSchema,
});

export type RevisionProposalBlock = z.infer<typeof revisionProposalBlockSchema>;

export const revisionProposalDiffEntrySchema = z.object({
  blockId: uuidSchema,
  kind: revisionProposalDiffKindSchema,
  base: revisionProposalBlockSchema.nullable(),
  proposed: revisionProposalBlockSchema.nullable(),
});

export type RevisionProposalDiffEntry = z.infer<typeof revisionProposalDiffEntrySchema>;

export const revisionProposalSourceSchema = z.object({
  kind: z.enum(["ai", "user"]),
  provider: z.string().trim().min(1).max(120).nullable(),
  model: z.string().trim().min(1).max(200).nullable(),
  sourceId: uuidSchema.nullable(),
  metadata: recordSchema,
});
export type RevisionProposalSource = z.infer<typeof revisionProposalSourceSchema>;

export const revisionProposalProvenanceSchema = z.object({
  origin: z.enum(["ai", "manual", "import"]),
  actorUserId: uuidSchema.nullable(),
  sourceDocumentId: uuidSchema.nullable(),
  sourceRevisionNumber: z.number().int().positive().nullable(),
});
export type RevisionProposalProvenance = z.infer<typeof revisionProposalProvenanceSchema>;

export const revisionProposalReviewSchema = z.object({
  action: revisionProposalActionSchema,
  actorUserId: uuidSchema,
  reviewedAt: z.coerce.date(),
  resultingRevisionNumber: z.number().int().positive().nullable(),
});
export type RevisionProposalReview = z.infer<typeof revisionProposalReviewSchema>;

export const revisionProposalConflictSchema = z.object({
  currentRevisionNumber: z.number().int().positive(),
  currentTitle: z.string(),
  currentBlocks: z.array(revisionProposalBlockSchema),
  conflictedAt: z.coerce.date(),
});
export type RevisionProposalConflict = z.infer<typeof revisionProposalConflictSchema>;

export const revisionProposalSchema = z.object({
  id: uuidSchema,
  workspaceId: uuidSchema,
  documentId: uuidSchema,
  baseRevisionNumber: z.number().int().positive(),
  baseTitle: z.string(),
  baseBlocks: z.array(revisionProposalBlockSchema),
  proposedTitle: z.string().nullable(),
  proposedBlocks: z.array(revisionProposalBlockSchema),
  diff: z.array(revisionProposalDiffEntrySchema),
  source: revisionProposalSourceSchema,
  provenance: revisionProposalProvenanceSchema,
  supportState: revisionProposalSupportStateSchema,
  status: revisionProposalStatusSchema,
  review: revisionProposalReviewSchema.nullable(),
  conflict: revisionProposalConflictSchema.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type RevisionProposalRecord = z.infer<typeof revisionProposalSchema>;

export const createRevisionProposalRequestSchema = z.object({
  documentId: uuidSchema.optional(),
  baseRevisionNumber: z.number().int().positive().optional(),
  proposedTitle: z.string().trim().min(1).max(500).nullable().optional(),
  proposedBlocks: z.array(revisionProposalBlockSchema).min(1),
  source: revisionProposalSourceSchema,
  provenance: revisionProposalProvenanceSchema,
  supportState: revisionProposalSupportStateSchema,
});
export type CreateRevisionProposalRequest = z.infer<typeof createRevisionProposalRequestSchema>;

export const revisionProposalReviewRequestSchema = z.object({
  action: z.enum(["accept", "partial_accept", "reject"]),
  selectedProposalBlockIds: z.array(uuidSchema).optional(),
});
export type ReviewRevisionProposalRequest = z.infer<typeof revisionProposalReviewRequestSchema>;

export const revisionProposalResolveRequestSchema = z.object({
  action: z.literal("preserve_both"),
  selectedProposalBlockIds: z.array(uuidSchema).min(1),
  expectedCurrentRevisionNumber: z.number().int().positive(),
});
export type ResolveRevisionProposalRequest = z.infer<typeof revisionProposalResolveRequestSchema>;

export const revisionProposalResponseSchema = z.object({ proposal: revisionProposalSchema });
export const revisionProposalsResponseSchema = z.object({ proposals: z.array(revisionProposalSchema) });
export const revisionProposalReviewResponseSchema = z.object({
  proposal: revisionProposalSchema,
  document: z.object({
    id: uuidSchema,
    currentRevisionNumber: z.number().int().positive(),
    title: z.string(),
    blocks: z.array(revisionProposalBlockSchema),
  }).nullable(),
});
export type RevisionProposalReviewResult = z.infer<typeof revisionProposalReviewResponseSchema>;
