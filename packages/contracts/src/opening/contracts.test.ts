import { describe, expect, it } from "vitest";
import {
  ASSISTANCE_BLOCKS_INDEPENDENT,
  DOCLING_PINNED_VERSION,
  acceptPlanInputSchema,
  canBecomeObservedIndependent,
  shouldCreateLearningSession,
  observationAllowsIndependent,
  problemRefSchema,
  helpExposureSchema,
  memoryDecisionSchema,
  memoryItemSchema,
  observationInputSchema,
  providerInputSchema,
  sourceChunkSchema,
  sourceRecordSchema,
  turnInputSchema,
  turnRecordSchema,
  uploadInputSchema,
  weekSessionSchema,
  sourceCourseLinkInputSchema,
  conversationSummarySchema,
  conversationResumeSchema,
  ephemeralTurnInputSchema,
  timeConfigSchema,
  timeConfigSaveInputSchema,
  timeConfigSupportsAbsoluteScheduling,
  memoryEffectiveScope,
  memoryVisibleInCourseScope,
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

  it("sourceRecord has no courseId; link via membership input (RU-01)", () => {
    const record = sourceRecordSchema.parse({
      id: U, workspaceId: U2, name: "week1.pdf", mime: "application/pdf", bytes: 10,
      sha256: SHA, version: 0, uploadState: "uploaded", parseState: "ready",
      error: null, createdAt: ISO,
    });
    expect(record).not.toHaveProperty("courseId");
    expect(sourceRecordSchema.safeParse({ ...record, courseId: U }).success).toBe(false);
  });

  it("sourceChunk keeps page vs slideLabel", () => {
    const chunk = sourceChunkSchema.parse({
      id: U, sourceId: U2, sourceVersion: 1, page: 3, slideLabel: "Slide 12",
      startMs: null, endMs: null, text: "body", imageObjectKey: "ws/src/p3.png",
    });
    expect(chunk.page).toBe(3);
    expect(chunk.slideLabel).toBe("Slide 12");
  });

  it("turn records preserve an unknown provider outcome as a distinct status", () => {
    const record = turnRecordSchema.parse({
      id: U,
      conversationId: U2,
      role: "assistant",
      text: "结果状态未知，请勿重复提交",
      citations: [],
      createdAt: ISO,
      mode: "explain",
      status: "outcome_unknown",
    });
    expect(record.status).toBe("outcome_unknown");
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
    expect(weekSessionSchema.parse({ ...base, startPeriod: 3, endPeriod: 5, courseId: null }).courseId).toBeNull();
    expect(weekSessionSchema.parse({ ...base, startPeriod: 3, endPeriod: 5 }).courseId).toBeUndefined();
  });

  it("acceptPlanInput is strict", () => {
    expect(acceptPlanInputSchema.safeParse({
      draftId: U, expectedBaseVersion: 0, clientKey: "accept-1",
    }).success).toBe(true);
    expect(acceptPlanInputSchema.safeParse({
      draftId: U, expectedBaseVersion: 0, clientKey: "accept-1", extra: true,
    }).success).toBe(false);
  });

  it("sourceCourseLink is strict (RU-01)", () => {
    expect(sourceCourseLinkInputSchema.safeParse({
      sourceId: U, courseId: U2, clientKey: "link-key-1",
    }).success).toBe(true);
    expect(sourceCourseLinkInputSchema.safeParse({
      sourceId: U, courseId: U2, clientKey: "link-key-1", ownerUserId: U,
    }).success).toBe(false);
  });

  it("conversation discovery + server resume history (RU-02)", () => {
    expect(conversationSummarySchema.parse({
      id: U, title: "inverse day 1", courseId: null, updatedAt: ISO, lastTurnPreview: "step 2",
    }).title).toBe("inverse day 1");
    expect(conversationSummarySchema.safeParse({
      id: U, title: "x", courseId: null, updatedAt: ISO, lastTurnPreview: null, clientSeededId: "nope",
    }).success).toBe(false);

    const resumed = conversationResumeSchema.parse({
      conversationId: U, courseId: null, sourceIds: [U2],
      boundedHistory: [{ role: "user", text: "continue step 2" }],
      currentPage: 4,
      chunkId: U,
      historyTruncated: false,
    });
    expect(resumed.boundedHistory).toHaveLength(1);
    expect(resumed.historyTruncated).toBe(false);
    expect(resumed.currentPage).toBe(4);

    // historyTruncated is required for AC07 honesty
    expect(conversationResumeSchema.safeParse({
      conversationId: U, courseId: null, sourceIds: [], boundedHistory: [],
    }).success).toBe(false);

    // boundedHistory max 40 — provider bound
    const tooLong = Array.from({ length: 41 }, () => ({ role: "user" as const, text: "x" }));
    expect(conversationResumeSchema.safeParse({
      conversationId: U, courseId: null, sourceIds: [], boundedHistory: tooLong, historyTruncated: true,
    }).success).toBe(false);
  });

  it("page selection is optional and positive; file ids alone do not invent a page (RU-03)", () => {
    const base = {
      conversationId: U, text: "this page second line", sourceIds: [U2],
      mode: "explain" as const, clientKey: "client-key-2", privacy: "saved" as const,
    };
    expect(turnInputSchema.parse(base).currentPage).toBeUndefined();
    expect(turnInputSchema.safeParse({ ...base, currentPage: 0 }).success).toBe(false);
    expect(turnInputSchema.safeParse({ ...base, currentPage: -1 }).success).toBe(false);
    expect(turnInputSchema.parse({ ...base, currentPage: 5, chunkId: U }).chunkId).toBe(U);

    expect(ephemeralTurnInputSchema.parse({
      text: "hint", sourceIds: [U2], mode: "hint", history: [], currentPage: 3, chunkId: null,
    }).currentPage).toBe(3);
  });

  it("timeConfig is versioned for cross-device conflict (RU-05)", () => {
    expect(timeConfigSchema.parse({
      version: 1, courseId: null, timeZone: "Asia/Shanghai",
      termStartDate: null, periodToClock: null,
    }).version).toBe(1);
    expect(timeConfigSaveInputSchema.safeParse({
      expectedVersion: 1, courseId: null, timeZone: "Asia/Shanghai",
      termStartDate: null, periodToClock: null, clientKey: "cfg-save-1",
    }).success).toBe(true);
  });

  it("no problemId blocks independent; mode gates session create (RU-04)", () => {
    expect(shouldCreateLearningSession("hint")).toBe(true);
    expect(shouldCreateLearningSession("explain")).toBe(true);
    expect(shouldCreateLearningSession("listen")).toBe(false);
    expect(shouldCreateLearningSession("think_together")).toBe(false);
    expect(observationAllowsIndependent({
      problemId: null, assistance: "independent", outcome: "correct",
    })).toBe(false);
    expect(observationAllowsIndependent({
      problemId: U, assistance: "independent", outcome: "correct",
    })).toBe(true);
    expect(observationAllowsIndependent({
      problemId: U, assistance: "hinted", outcome: "correct",
    })).toBe(false);
  });

  it("ProblemRef + delivered HelpExposure shapes (RU-04)", () => {
    expect(problemRefSchema.parse({
      problemId: U, sourceId: U2, sourceVersion: 1, physicalPage: 4, chunkId: null,
      stemSnapshot: "invert f(x)=2x", artifactKind: "reference_item",
    }).physicalPage).toBe(4);
    expect(helpExposureSchema.safeParse({
      id: U, sessionId: U2, problemId: U, turnId: U, level: "hinted",
      delivered: false, createdAt: ISO,
    }).success).toBe(false);
    expect(helpExposureSchema.parse({
      id: U, sessionId: U2, problemId: U, turnId: U, level: "revealed",
      delivered: true, createdAt: ISO,
    }).delivered).toBe(true);
  });

it("timeConfigSupportsAbsoluteScheduling requires termStart + non-empty period map (RU-05)", () => {
    expect(timeConfigSupportsAbsoluteScheduling({
      termStartDate: null, periodToClock: { "1": { start: "08:00", end: "08:45" } },
    })).toBe(false);
    expect(timeConfigSupportsAbsoluteScheduling({
      termStartDate: "2026-09-01", periodToClock: null,
    })).toBe(false);
    expect(timeConfigSupportsAbsoluteScheduling({
      termStartDate: "2026-09-01", periodToClock: {},
    })).toBe(false);
    expect(timeConfigSupportsAbsoluteScheduling({
      termStartDate: "2026-09-01",
      periodToClock: { "1": { start: "08:00", end: "08:45" } },
    })).toBe(true);
  });

  it("memoryEffectiveScope + visibility — no cross-course load (RU-06)", () => {
    expect(memoryEffectiveScope({ courseId: U })).toBe("course");
    expect(memoryEffectiveScope({ courseId: null })).toBe("workspace");
    expect(memoryVisibleInCourseScope(null, U)).toBe(true);
    expect(memoryVisibleInCourseScope(null, null)).toBe(true);
    expect(memoryVisibleInCourseScope(U, U)).toBe(true);
    expect(memoryVisibleInCourseScope(U, U2)).toBe(false);
    expect(memoryVisibleInCourseScope(U, null)).toBe(false);
  });

});