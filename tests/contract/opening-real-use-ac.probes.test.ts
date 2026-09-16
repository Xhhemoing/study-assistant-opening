/**
 * Opening real-use AC protocol probes (post-F02).
 *
 * These exercise F02 contracts against AC01–12 scenario constraints.
 * They prove protocol honesty, not full product acceptance (no HTTP/DB/UI).
 * Semantic gold / live model / device flows remain human or later tasks.
 *
 * Map: docs/superpowers/plans/opening-release/traceability.md
 * Audit: docs/quality/opening-real-use-audit.md §5
 * Placeholders (still skipped hang points):
 *   tests/contract/opening-real-use-ac.placeholders.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ASSISTANCE_BLOCKS_INDEPENDENT,
  canBecomeObservedIndependent,
  conversationResumeSchema,
  conversationSummarySchema,
  memoryEffectiveScope,
  memoryItemSchema,
  memoryVisibleInCourseScope,
  observationAllowsIndependent,
  problemRefSchema,
  shouldCreateLearningSession,
  sourceChunkSchema,
  sourceCourseLinkInputSchema,
  sourceCourseUnlinkInputSchema,
  sourceRecordSchema,
  timeConfigSchema,
  timeConfigSupportsAbsoluteScheduling,
  turnInputSchema,
  uploadInputSchema,
} from "@aistudy/contracts";

const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);
const ISO = "2026-09-13T12:00:00.000Z";

describe("opening real-use AC protocol probes", () => {
  it("AC01 | tasks=T03,P02,U03,Q02 | upload name cannot invent path/calendar facts", () => {
    const base = { mime: "application/pdf" as const, sha256: SHA, bytes: 1024 };
    expect(
      uploadInputSchema.safeParse({ ...base, name: "syllabus.pdf" }).success,
    ).toBe(true);
    expect(
      uploadInputSchema.safeParse({ ...base, name: "../evil.pdf" }).success,
    ).toBe(false);
  });

  it("AC02 | tasks=I02,T02,Q02 | chunk text alone does not invent missing appendix pages", () => {
    const chunk = sourceChunkSchema.parse({
      id: U,
      sourceId: U2,
      sourceVersion: 1,
      page: 58,
      slideLabel: null,
      startMs: null,
      endMs: null,
      text: "Appendix of the notes",
      imageObjectKey: null,
    });
    expect(chunk.page).toBe(58);
    expect(chunk).not.toHaveProperty("inventedProblemCount");
  });

  it("AC03 | RU-01 | tasks=F01,F02,I01,U01,U03 | source has no courseId; link/unlink via membership input", () => {
    const record = sourceRecordSchema.parse({
      id: U,
      workspaceId: U2,
      name: "week1.pdf",
      mime: "application/pdf",
      bytes: 10,
      sha256: SHA,
      version: 0,
      uploadState: "uploaded",
      parseState: "ready",
      error: null,
      createdAt: ISO,
    });
    expect(record).not.toHaveProperty("courseId");
    expect(
      sourceRecordSchema.safeParse({ ...record, courseId: U }).success,
    ).toBe(false);

    expect(
      sourceCourseLinkInputSchema.parse({
        sourceId: U,
        courseId: U2,
        clientKey: "link-key-ac03",
      }),
    ).toEqual({
      sourceId: U,
      courseId: U2,
      clientKey: "link-key-ac03",
    });
    expect(
      sourceCourseUnlinkInputSchema.parse({
        sourceId: U,
        courseId: U2,
        clientKey: "unlink-key-ac03",
      }),
    ).toEqual({
      sourceId: U,
      courseId: U2,
      clientKey: "unlink-key-ac03",
    });
    expect(
      sourceCourseLinkInputSchema.safeParse({
        sourceId: U,
        courseId: U2,
        clientKey: "link-key-ac03",
        ownerUserId: U,
      }).success,
    ).toBe(false);
  });

  it("AC04 | RU-03 | tasks=I02,T02,U02,Q02 | file ids alone do not invent currentPage; page≠slideLabel", () => {
    const base = {
      conversationId: U,
      text: "this page second line",
      sourceIds: [U2],
      mode: "explain" as const,
      clientKey: "client-key-ac04",
      privacy: "saved" as const,
    };
    expect(turnInputSchema.parse(base).currentPage).toBeUndefined();
    expect(turnInputSchema.safeParse({ ...base, currentPage: 0 }).success).toBe(
      false,
    );
    expect(turnInputSchema.parse({ ...base, currentPage: 5 }).currentPage).toBe(
      5,
    );

    const chunk = sourceChunkSchema.parse({
      id: U,
      sourceId: U2,
      sourceVersion: 1,
      page: 4,
      slideLabel: "Slide 12",
      startMs: null,
      endMs: null,
      text: "same text different pixels",
      imageObjectKey: "ws/src/p4.png",
    });
    expect(chunk.page).toBe(4);
    expect(chunk.slideLabel).toBe("Slide 12");
  });

  it("AC05 | tasks=I02,T01,T02,L01,Q02 | problemRef keeps physicalPage without forcing skill blame", () => {
    const ref = problemRefSchema.parse({
      problemId: U,
      sourceId: U2,
      sourceVersion: 1,
      physicalPage: 2,
      chunkId: null,
      stemSnapshot: "blurry minus sign",
      artifactKind: "reference_item",
    });
    expect(ref.physicalPage).toBe(2);
    expect(ref).not.toHaveProperty("diagnosedSkillGap");
  });

  it("AC06 | RU-04 | tasks=T03,L01,L02,Q01 | hinted/revealed cannot wash into independent", () => {
    expect(ASSISTANCE_BLOCKS_INDEPENDENT).toEqual(
      expect.arrayContaining(["hinted", "revealed"]),
    );
    expect(canBecomeObservedIndependent("hinted", "correct")).toBe(false);
    expect(canBecomeObservedIndependent("independent", "correct")).toBe(true);
    expect(
      observationAllowsIndependent({
        problemId: null,
        assistance: "independent",
        outcome: "correct",
      }),
    ).toBe(false);
    expect(shouldCreateLearningSession("listen")).toBe(false);
    expect(shouldCreateLearningSession("explain")).toBe(true);
  });

  it("AC07 | RU-02 | tasks=T02,T03,U03,Q02 | resume requires historyTruncated; discovery has no clientSeededId", () => {
    expect(
      conversationSummarySchema.safeParse({
        id: U,
        title: "day 2",
        courseId: null,
        updatedAt: ISO,
        lastTurnPreview: "step 2",
        clientSeededId: "device-local",
      }).success,
    ).toBe(false);

    const resumed = conversationResumeSchema.parse({
      conversationId: U,
      courseId: null,
      sourceIds: [U2],
      boundedHistory: [{ role: "user", text: "continue step 2" }],
      currentPage: 4,
      chunkId: U,
      historyTruncated: true,
    });
    expect(resumed.historyTruncated).toBe(true);
    expect(resumed.boundedHistory).toEqual([
      { role: "user", text: "continue step 2" },
    ]);
    expect(
      conversationResumeSchema.safeParse({
        conversationId: U,
        courseId: null,
        sourceIds: [],
        boundedHistory: [],
      }).success,
    ).toBe(false);
  });

  it("AC08 | tasks=P01,P02,U03,Q01 | timeConfig is versioned; absolute schedule needs termStart+periods", () => {
    expect(
      timeConfigSchema.parse({
        version: 2,
        courseId: null,
        timeZone: "Asia/Shanghai",
        termStartDate: null,
        periodToClock: null,
      }).version,
    ).toBe(2);
    expect(
      timeConfigSupportsAbsoluteScheduling({
        termStartDate: null,
        periodToClock: { "1": { start: "08:00", end: "08:45" } },
      }),
    ).toBe(false);
    expect(
      timeConfigSupportsAbsoluteScheduling({
        termStartDate: "2026-09-01",
        periodToClock: { "1": { start: "08:00", end: "08:45" } },
      }),
    ).toBe(true);
  });

  it("AC09 | RU-06 | tasks=M01,M03,T02,P02,Q02 | course memory does not load into other course", () => {
    expect(memoryEffectiveScope({ courseId: U })).toBe("course");
    expect(memoryEffectiveScope({ courseId: null })).toBe("workspace");
    expect(memoryVisibleInCourseScope(U, U2)).toBe(false);
    expect(memoryVisibleInCourseScope(U, U)).toBe(true);
    expect(
      memoryItemSchema.safeParse({
        id: U,
        workspaceId: U2,
        courseId: null,
        kind: "temporary",
        text: "tired today",
        sourceTurnIds: [],
        version: 0,
        expiresAt: null,
        status: "active",
      }).success,
    ).toBe(false);
  });

  it("AC10 | tasks=L01,L02,Q02 | independent verdict requires problemId and non-blocking assistance", () => {
    expect(
      observationAllowsIndependent({
        problemId: U,
        assistance: "independent",
        outcome: "correct",
      }),
    ).toBe(true);
    expect(
      observationAllowsIndependent({
        problemId: U,
        assistance: "hinted",
        outcome: "correct",
      }),
    ).toBe(false);
  });

  it("AC11 | tasks=I01,I03,T01,T03,U02,U03 | upload rejects traversal and oversize (idempotent client surface)", () => {
    const base = { mime: "application/pdf" as const, sha256: SHA };
    expect(
      uploadInputSchema.safeParse({
        ...base,
        name: "ok.pdf",
        bytes: 51 * 1024 * 1024,
      }).success,
    ).toBe(false);
    expect(
      uploadInputSchema.safeParse({
        ...base,
        name: "ok.pdf",
        bytes: 1024,
      }).success,
    ).toBe(true);
  });

  it.todo(
    "AC12 | tasks=M02,P02,Q03,Q01 | hang=tests/e2e/native-backup.spec.ts — opening backup/delete/restore waits Q03",
  );
});
