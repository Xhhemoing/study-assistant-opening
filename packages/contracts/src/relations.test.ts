import { describe, expect, it } from "vitest";
import {
  createDocumentRelationRequestSchema,
  indexDocumentLinksRequestSchema,
  knowledgeLinkSchema,
  managedRelationSchema,
  relationEndpointSchema,
  relationTypeSchema,
  updateDocumentRelationRequestSchema,
} from "./relations";

const documentId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

const validLink = {
  id: "33333333-3333-4333-8333-333333333333",
  relationType: "references" as const,
  isIncoming: true,
  from: {
    type: "document" as const,
    id: documentId,
    documentId,
    title: "Source note",
    text: null,
    status: "available" as const,
  },
  to: {
    type: "document" as const,
    id: targetId,
    documentId: targetId,
    title: "Target note",
    text: null,
    status: "available" as const,
  },
  createdAt: "2026-08-03T12:00:00.000Z",
};

describe("knowledge link contracts", () => {
  it("parses an enriched document relation and endpoint", () => {
    expect(knowledgeLinkSchema.parse(validLink)).toEqual(validLink);
    expect(relationEndpointSchema.parse(validLink.from)).toEqual(validLink.from);
  });

  it("requires the server-computed incoming direction for document and block backlinks", () => {
    expect(knowledgeLinkSchema.parse(validLink)).toMatchObject({ isIncoming: true });
    expect(() => knowledgeLinkSchema.parse({
      ...validLink,
      isIncoming: undefined,
      to: { ...validLink.to, type: "block" },
    })).toThrow();
  });

  it("accepts every typed relation kind", () => {
    expect(relationTypeSchema.options).toEqual([
      "references",
      "supports",
      "embeds",
      "derived_from",
      "related",
    ]);
  });

  it("parses explicit document relation create and type-only update requests", () => {
    expect(createDocumentRelationRequestSchema.parse({
      to: { type: "block", id: targetId },
      relationType: "supports",
    })).toEqual({
      to: { type: "block", id: targetId },
      relationType: "supports",
    });
    expect(updateDocumentRelationRequestSchema.parse({ relationType: "related" })).toEqual({ relationType: "related" });
    expect(() => createDocumentRelationRequestSchema.parse({
      fromId: documentId,
      to: { type: "document", id: targetId },
      relationType: "references",
    })).toThrow();
  });

  it("parses managed outgoing relation responses", () => {
    expect(managedRelationSchema.parse({
      ...validLink,
      isIncoming: undefined,
    })).toMatchObject({
      id: validLink.id,
      relationType: "references",
      from: validLink.from,
      to: validLink.to,
    });
  });

  it("trims extracted titles at the request boundary", () => {
    expect(indexDocumentLinksRequestSchema.parse({
      targetTitles: ["  Target note  ", "Target note"],
    })).toEqual({ targetTitles: ["Target note", "Target note"] });
  });

  it("rejects unknown relation kinds and invalid endpoint IDs", () => {
    expect(() => relationTypeSchema.parse("mentions")).toThrow();
    expect(() => relationEndpointSchema.parse({
      ...validLink.from,
      id: "not-a-uuid",
    })).toThrow();
    expect(() => relationEndpointSchema.parse({
      ...validLink.from,
      documentId: "not-a-uuid",
    })).toThrow();
  });
});
