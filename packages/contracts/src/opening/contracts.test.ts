import { describe, expect, it } from "vitest";
import {
  ASSISTANCE_BLOCKS_INDEPENDENT,
  DOCLING_PINNED_VERSION,
  acceptPlanInputSchema,
  canBecomeObservedIndependent,
  memoryDecisionSchema,
  memoryItemSchema,
  observationInputSchema,
  providerInputSchema,
  sourceChunkSchema,
  sourceRecordSchema,
  turnInputSchema,
  uploadInputSchema,
  weekSessionSchema,
} from "./index";

const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);
const ISO = "2026-09-13T12:00:00.000Z";

describe("F02 opening contracts", () => {
  it("pins Docling 2.126.0", () => {
    expect(DOCLING_PINNED_VERSION).toBe("2.126.0");
  });

  it("uploadInput rejects path traversal and oversize", () => {
    const base = { mime: "application/pdf" as const, sha256: SHA };
    expect(uploadInputSchema.safeParse({ ...base, name: "../evil.pdf", bytes: 100 }).success).toBe(false);
    expect(uploadInputSchema.safeParse({ ...base, name: "ok.pdf", bytes: 51 * 1024 * 1024 }).success).toBe(false);
    expect(uploadInputSchema.safeParse({ ...base, name: "ok.pdf", bytes: 1024 }).success).toBe(true);
  });

  it("sourceRecord carries courseId membership (RU-01)", () => {
    expect(sourceRecordSchema.parse({
      id: U, workspaceId: U2, name: "week1.pdf", mime: "application/pdf", bytes: 10,
      sha256: SHA, version: 0, uploadState: "uploaded", parseState: "ready",
      error: null, courseId: U, createdAt: ISO,
    }).courseId).toBe(U);
  });

  it("sourceChunk keeps page vs slideLabel", () => {
    const chunk = sourceChunkSchema.parse({
      id: U, sourceId: U2, sourceVersion: 1, page: 3, slideLabel: "Slide 12",
      startMs: null, endMs: null, text: "body", imageObjectKey: "ws/src/p3.png",
    });
    expect(chunk.page).toBe(3);
    expect(chunk.slideLabel).toBe("Slide 12");
  });

  it("turnInput requires conversationId; optional page/chunk (RU-02/03)", () => {
    expect(turnInputSchema.parse({
      conversationId: U, text: "explain this", sourceIds: [U2], mode: "explain",
      clientKey: "client-key-1", privacy: "saved", currentPage: 2, chunkId: U,
    }).currentPage).toBe(2);
    expect(turnInputSchema.safeParse({
      text: "x", sourceIds: [], mode: "hint", clientKey: "client-key-1", privacy: "ephemeral",
    }).success).toBe(false);
  });

  it("providerInput needs real imageParts for vision", () => {
    const base = {
      instruction: "i", text: "t", chunks: [], mode: "explain" as const,
      maxOutputTokens: 256, imageParts: [],
    };
    expect(providerInputSchema.safeParse({ ...base, mediaCapability: "text_plus_page_images" }).success).toBe(false);
    expect(providerInputSchema.safeParse({ ...base, mediaCapability: "text_only" }).success).toBe(true);
  });

  it("memory scopes by courseId; temporary needs expiresAt (RU-06)", () => {
    expect(memoryItemSchema.safeParse({
      id: U, workspaceId: U2, courseId: null, kind: "temporary", text: "tmp",
      sourceTurnIds: [], version: 0, expiresAt: null, status: "active",
    }).success).toBe(false);
    expect(memoryDecisionSchema.safeParse({
      id: U, expectedVersion: 0, action: "confirm", clientKey: "decision-1",
    }).success).toBe(true);
  });

  it("observation problemId; hinted/revealed block independent (RU-04)", () => {
    expect(observationInputSchema.parse({
      sessionId: U, courseId: U2, skillLabel: "chain rule", sourceIds: [],
      problemId: U, answer: "42", outcome: "correct", assistance: "hinted",
      clientKey: "obs-key-1",
    }).problemId).toBe(U);
    expect(ASSISTANCE_BLOCKS_INDEPENDENT).toEqual(expect.arrayContaining(["hinted", "revealed"]));
    expect(canBecomeObservedIndependent("hinted", "correct")).toBe(false);
    expect(canBecomeObservedIndependent("independent", "correct")).toBe(true);
  });

  it("weekSession enforces startPeriod <= endPeriod (RU-05)", () => {
    const base = { courseName: "Calc", weekday: 1, weeks: [1, 2] };
    expect(weekSessionSchema.safeParse({ ...base, startPeriod: 5, endPeriod: 3 }).success).toBe(false);
    expect(weekSessionSchema.safeParse({ ...base, startPeriod: 3, endPeriod: 5 }).success).toBe(true);
  });

  it("acceptPlanInput is strict", () => {
    expect(acceptPlanInputSchema.safeParse({
      draftId: U, expectedBaseVersion: 0, clientKey: "accept-1",
    }).success).toBe(true);
    expect(acceptPlanInputSchema.safeParse({
      draftId: U, expectedBaseVersion: 0, clientKey: "accept-1", extra: true,
    }).success).toBe(false);
  });
});
