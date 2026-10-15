import { describe, expect, it } from "vitest";
import { conversationResumeSchema } from "./conversations";
import {
  learningResumeSchema,
  teachingActivityStatusUpdateInputSchema,
  teachingCheckpointSaveInputSchema,
  teachingContinuableActionSchema,
  teachingResumeJobGateSchema,
  teachingResumeMaterialsGateSchema,
} from "./teaching-resume";

const activityId = "11111111-1111-4111-8111-111111111111";
const blockId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const problemId = "44444444-4444-4444-8444-444444444444";
const helpId = "55555555-5555-4555-8555-555555555555";
const unitId = "66666666-6666-4666-8666-666666666666";
const docId = "77777777-7777-4777-8777-777777777777";
const specId = "88888888-8888-4888-8888-888888888888";

function minimalClientInit() {
  return {
    id: specId,
    activityId,
    teachingUnitId: unitId,
    documentId: docId,
    revisionNumber: 1,
    blockOrder: [
      {
        blockId,
        position: 0,
        blockType: "paragraph",
        role: "teach" as const,
      },
    ],
    sourceRefs: [],
    goals: [],
    verificationStatus: "unchecked" as const,
    generationConfig: {},
    version: 1,
    createdAt: "2026-10-11T04:00:00.000Z",
    updatedAt: "2026-10-11T04:00:00.000Z",
    blocks: [
      {
        blockId,
        position: 0,
        blockType: "paragraph",
        role: "teach" as const,
        content: { text: "hi" },
      },
    ],
    contentVersion: 1,
    checkpointJson: { currentBlockId: blockId, drafts: [] },
  };
}

function minimalResume(overrides: Record<string, unknown> = {}) {
  return {
    activityId,
    status: "paused",
    generateStatus: "ready",
    contentVersion: 1,
    pathVersion: 1,
    clientInit: minimalClientInit(),
    thoughtTrain: {
      currentBlockId: blockId,
      skippedBlockIds: [],
      branchStack: [],
      commandLog: [],
    },
    drafts: [{ blockId, contentVersion: 1, draftText: "wip" }],
    interactionParams: {},
    actualAttempts: [
      {
        attemptId,
        problemId,
        itemVersionId: null,
        outcome: "incorrect",
        assistance: "independent",
        submittedAt: "2026-10-11T04:01:00.000Z",
      },
    ],
    helpDelivered: [
      {
        id: helpId,
        kind: "hint",
        level: "hinted",
        problemId,
        deliveredAt: "2026-10-11T04:02:00.000Z",
      },
    ],
    openProblems: [
      {
        problemId,
        itemVersionId: null,
        reason: "incorrect_unresolved",
      },
    ],
    gates: {
      permission: "owned",
      materials: "available",
      unavailableSourceIds: [],
      job: "ready",
    },
    continuableActions: ["continue_block", "edit_draft", "command_why"],
    ...overrides,
  };
}

describe("teaching-resume contracts (V2-14 T1/T16)", () => {
  it("T1 LearningResume parse; rejects missing activityId/contentVersion", () => {
    const parsed = learningResumeSchema.parse(minimalResume());
    expect(parsed.activityId).toBe(activityId);
    expect(parsed.contentVersion).toBe(1);
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.gates.permission).toBe("owned");

    expect(
      learningResumeSchema.safeParse({
        ...minimalResume(),
        activityId: undefined,
      }).success,
    ).toBe(false);
    expect(
      learningResumeSchema.safeParse({
        ...minimalResume(),
        contentVersion: undefined,
      }).success,
    ).toBe(false);
  });

  it("accepts nullable clientInit for mid-generate", () => {
    const parsed = learningResumeSchema.parse(
      minimalResume({ clientInit: null, generateStatus: "generating" }),
    );
    expect(parsed.clientInit).toBeNull();
    expect(parsed.generateStatus).toBe("generating");
  });

  it("job and materials gate enums", () => {
    for (const g of ["ready", "in_flight", "unknown", "stale"] as const) {
      expect(teachingResumeJobGateSchema.parse(g)).toBe(g);
    }
    for (const g of ["available", "partial", "unavailable"] as const) {
      expect(teachingResumeMaterialsGateSchema.parse(g)).toBe(g);
    }
    expect(teachingContinuableActionSchema.parse("wait_job")).toBe("wait_job");
    expect(teachingContinuableActionSchema.safeParse("open_chat").success).toBe(
      false,
    );
  });

  it("checkpoint save input requires expectedVersion; status permits session completion", () => {
    expect(
      teachingCheckpointSaveInputSchema.parse({
        expectedVersion: 2,
        drafts: [{ blockId, contentVersion: 2, draftText: "x" }],
        interactionParams: { [blockId]: { mode: "hint" } },
      }).expectedVersion,
    ).toBe(2);
    expect(
      teachingCheckpointSaveInputSchema.safeParse({ drafts: [] }).success,
    ).toBe(false);
    expect(
      teachingActivityStatusUpdateInputSchema.parse({ status: "paused" }).status,
    ).toBe("paused");
    expect(
      teachingActivityStatusUpdateInputSchema.safeParse({
        status: "completed",
      }).success,
    ).toBe(true);
  });

  it("T16 LearningResume ≠ ConversationResume shape", () => {
    const resume = learningResumeSchema.parse(minimalResume());
    expect(resume).toHaveProperty("activityId");
    expect(resume).toHaveProperty("thoughtTrain");
    expect(resume).toHaveProperty("continuableActions");
    expect(resume).not.toHaveProperty("conversationId");
    expect(resume).not.toHaveProperty("boundedHistory");

    const chat = conversationResumeSchema.parse({
      conversationId: activityId,
      courseId: null,
      sourceIds: [],
      boundedHistory: [],
      historyTruncated: false,
    });
    expect(chat).toHaveProperty("conversationId");
    expect(chat).not.toHaveProperty("thoughtTrain");
    expect(learningResumeSchema.safeParse(chat).success).toBe(false);
    expect(conversationResumeSchema.safeParse(resume).success).toBe(false);
  });
});
