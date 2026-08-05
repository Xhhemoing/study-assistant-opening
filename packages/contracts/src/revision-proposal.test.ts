import { describe, expect, it } from "vitest";
import {
  createRevisionProposalRequestSchema,
  revisionProposalReviewRequestSchema,
  revisionProposalResolveRequestSchema,
  revisionProposalReviewResponseSchema,
  revisionProposalSchema,
} from "./revision-proposal";

const id = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const block = { id, type: "paragraph", position: 0, content: { text: "proposal" } };

describe("revision proposal contracts", () => {
  it("parses immutable proposal snapshots and structured provenance", () => {
    const parsed = revisionProposalSchema.parse({
      id,
      workspaceId,
      documentId,
      baseRevisionNumber: 2,
      baseTitle: "Base",
      baseBlocks: [block],
      proposedTitle: "Proposed",
      proposedBlocks: [block],
      diff: [{ blockId: id, kind: "unchanged", base: block, proposed: block }],
      source: { kind: "ai", provider: "luna", model: null, sourceId: null, metadata: {} },
      provenance: { origin: "manual", actorUserId: null, sourceDocumentId: null, sourceRevisionNumber: null },
      supportState: "supported",
      status: "pending",
      review: null,
      conflict: null,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    });
    expect(parsed.baseBlocks).toEqual([block]);
    expect(parsed.source.provider).toBe("luna");
  });

  it("keeps review and conflict actions as distinct strict requests", () => {
    expect(revisionProposalReviewRequestSchema.parse({ action: "partial_accept", selectedProposalBlockIds: [id] })).toMatchObject({ action: "partial_accept" });
    expect(revisionProposalResolveRequestSchema.parse({ action: "preserve_both", selectedProposalBlockIds: [id], expectedCurrentRevisionNumber: 3 })).toMatchObject({ action: "preserve_both" });
    expect(() => revisionProposalReviewRequestSchema.parse({ action: "preserve_both", selectedProposalBlockIds: [] })).toThrow();
  });

  it("parses a successful preserve-both review response", () => {
    const response = revisionProposalReviewResponseSchema.parse({
      proposal: {
        id,
        workspaceId,
        documentId,
        baseRevisionNumber: 2,
        baseTitle: "Base",
        baseBlocks: [block],
        proposedTitle: "Proposed",
        proposedBlocks: [block],
        diff: [{ blockId: id, kind: "unchanged", base: block, proposed: block }],
        source: { kind: "ai", provider: "luna", model: null, sourceId: null, metadata: {} },
        provenance: { origin: "manual", actorUserId: null, sourceDocumentId: null, sourceRevisionNumber: null },
        supportState: "supported",
        status: "accepted",
        review: { action: "preserve_both", actorUserId: workspaceId, reviewedAt: "2026-08-05T00:00:00.000Z", resultingRevisionNumber: 3 },
        conflict: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
      document: { id: documentId, currentRevisionNumber: 3, title: "Proposed", blocks: [block] },
    });
    expect(response.proposal.review?.action).toBe("preserve_both");
  });

  it("ignores no client identity in creation payload", () => {
    const parsed = createRevisionProposalRequestSchema.parse({
      documentId,
      baseRevisionNumber: 1,
      proposedTitle: null,
      proposedBlocks: [block],
      source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} },
      provenance: { origin: "manual", actorUserId: null, sourceDocumentId: null, sourceRevisionNumber: null },
      supportState: "inference",
      workspaceId,
      userId: workspaceId,
    });
    expect(parsed).not.toHaveProperty("workspaceId");
    expect(parsed).not.toHaveProperty("userId");
  });
});
