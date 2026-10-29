import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ephemeralTurnInputSchema, studyContextAnchorSchema, studyExposureReceiptSchema, turnInputSchema } from "./tutor";

describe("Study context selection boundary", () => {
  it("accepts nullable historical help metadata and validates explicit delivery metadata", () => {
    const receipt = { id: randomUUID(), releaseKey: "release-test-key", contextAnchor: { purpose: "learning_help" },
      origin: "assistant", supportDomain: "unknown", generatedAt: "2026-10-28T10:00:00.000Z", releasedAt: null, acknowledgedAt: null, historyRevision: 0 };
    expect(studyExposureReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(studyExposureReceiptSchema.parse({ ...receipt, hintStage: null, initiatedBy: null })).toMatchObject({ hintStage: null, initiatedBy: null });
    for (const hintStage of [1, 2, 3, 4]) for (const initiatedBy of ["user", "assistant"]) {
      expect(studyExposureReceiptSchema.parse({ ...receipt, hintStage, initiatedBy })).toMatchObject({ hintStage, initiatedBy });
    }
    for (const metadata of [{ hintStage: 0 }, { hintStage: 5 }, { hintStage: 1.5 }, { hintStage: "1" }, { initiatedBy: "model" }, { initiatedBy: ["user"] }]) {
      expect(studyExposureReceiptSchema.safeParse({ ...receipt, ...metadata }).success).toBe(false);
    }
  });
  it("accepts automatic routing while still rejecting unknown explicit modes", () => {
    const shared = { text: "只给提示", sourceIds: [] };
    expect(turnInputSchema.parse({ ...shared, conversationId: randomUUID(), clientKey: randomUUID(), privacy: "saved" }).mode).toBeUndefined();
    expect(ephemeralTurnInputSchema.parse({ ...shared, history: [] }).mode).toBeUndefined();
    expect(ephemeralTurnInputSchema.safeParse({ ...shared, history: [], mode: "invented" }).success).toBe(false);
  });
  it("accepts a complete, version-pinned teaching selection in both tutor paths", () => {
    const contextAnchor = { purpose: "learning_help" as const, courseId: randomUUID(), activityId: randomUUID(), blockId: randomUUID(),
      contentVersion: 2, attemptId: randomUUID(), itemVersionId: randomUUID(), sourceId: randomUUID(), sourceVersion: 0,
      chunkId: randomUUID(), page: 1, kcMappingVersion: 3 };
    const shared = { text: "Explain this step", mode: "hint" as const, sourceIds: [contextAnchor.sourceId], contextAnchor };
    expect(turnInputSchema.parse({ ...shared, conversationId: randomUUID(), clientKey: randomUUID(), privacy: "saved" }).contextAnchor).toEqual(contextAnchor);
    expect(ephemeralTurnInputSchema.parse({ ...shared, history: [] }).contextAnchor).toEqual(contextAnchor);
  });
  it.each([
    { purpose: "learning_help", blockId: randomUUID() },
    { purpose: "learning_help", activityId: randomUUID(), blockId: randomUUID() },
    { purpose: "material_read", chunkId: randomUUID() },
    { purpose: "material_read", sourceVersion: 0 },
    { purpose: "material_read", sourceId: randomUUID(), sourceVersion: -1 },
    { purpose: "learning_help", supportDomain: "language" },
  ])("rejects an incomplete material identity or client support-domain claim %#", input => {
    expect(studyContextAnchorSchema.safeParse(input).success).toBe(false);
  });
});
