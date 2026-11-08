import { expect, it } from "vitest";
import {
  activitySpecAtVersionM1Note,
  activitySpecClientInitSchema,
  activitySpecPublishInputSchema,
  activitySpecSchema,
  teachingDraftAnchorSchema,
  teachingUnitCreateInputSchema,
  teachingUnitSchema,
  teachingBlindSolveReceiptSchema,
} from "./teaching-content";

const uuid = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-11T03:00:00.000Z";

it("validates private blind-solve receipts without upgrading missing/forged identity", () => {
  const receipt = { protocol: "teaching-blind-solve-1", identity: { activityId: uuid, teachingRevisionId: uuid2,
    blockId: uuid, answerBlockId: uuid2, questionText: "2+2", keyText: "4", contentVersion: 1, sourceVersions: { [uuid2]: 2 }, generatorModelIdentity: { providerId: "g", modelName: "g", family: "a" } },
    operationId: "teaching-solve:job:block", modelSnapshot: { id: "s", providerId: "s", modelName: "s", inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
    family: "b", decision: "match", solverAnswer: "4", reasonCodes: ["pinned_key_match"], costLedgerRef: "ledger" };
  expect(teachingBlindSolveReceiptSchema.safeParse(receipt).success).toBe(true);
  for (const patch of [{ family: "A" }, { costLedgerRef: null }, { modelSnapshot: null }, { solverAnswer: null }, { identity: { ...receipt.identity, answerBlockId: undefined } }, { identity: { ...receipt.identity, keyText: undefined } }, { unexpected: true }]) {
    expect(teachingBlindSolveReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false);
  }
  expect(teachingBlindSolveReceiptSchema.safeParse(undefined).success).toBe(false);
  expect(teachingBlindSolveReceiptSchema.safeParse({ ...receipt, decision: "unknown", family: null, modelSnapshot: null, costLedgerRef: null }).success).toBe(true);
});

it("parses TeachingUnit and rejects unknown keys", () => {
  const parsed = teachingUnitSchema.parse({
    id: uuid,
    workspaceId: uuid,
    ownerUserId: uuid2,
    title: "Rank-nullspace lecture",
    documentId: uuid,
    currentRevisionNumber: 1,
    goals: [{ goalId: "g1", statement: "State the rank-nullity theorem" }],
    verificationStatus: "unchecked",
    generationConfig: {},
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
  expect(parsed.title).toBe("Rank-nullspace lecture");
  expect(
    teachingUnitSchema.safeParse({ ...parsed, extra: true }).success,
  ).toBe(false);
});

it("parses ActivitySpec and rejects unknown keys", () => {
  const parsed = activitySpecSchema.parse({
    id: uuid,
    activityId: uuid,
    teachingUnitId: uuid,
    documentId: uuid,
    revisionNumber: 1,
    blockOrder: [
      { blockId: uuid, position: 0, blockType: "prompt", role: "prompt" },
    ],
    sourceRefs: [],
    goals: [],
    verificationStatus: "structure_ok",
    generationConfig: { locale: "zh-CN" },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  expect(parsed.version).toBe(1);
  expect(activitySpecSchema.safeParse({ ...parsed, leak: "x" }).success).toBe(false);
});

it("clientInit forbids answer_key plaintext when hidden", () => {
  const base = {
    id: uuid,
    activityId: uuid,
    teachingUnitId: uuid,
    documentId: uuid,
    revisionNumber: 1,
    blockOrder: [
      { blockId: uuid, position: 0, blockType: "answer_key", role: "answer_key" as const },
    ],
    sourceRefs: [],
    goals: [],
    verificationStatus: "unchecked" as const,
    generationConfig: {},
    version: 1,
    createdAt: now,
    updatedAt: now,
    contentVersion: 1,
    blocks: [
      {
        blockId: uuid,
        position: 0,
        blockType: "answer_key",
        role: "answer_key" as const,
        content: null,
        answerRef: { refId: uuid, revealState: "hidden" as const },
      },
    ],
  };
  expect(activitySpecClientInitSchema.parse(base).blocks[0]?.content).toBeNull();
  expect(
    activitySpecClientInitSchema.safeParse({
      ...base,
      blocks: [
        {
          ...base.blocks[0],
          content: { solutionZh: "secret" },
        },
      ],
    }).success,
  ).toBe(false);
});

it("publish input requires expectedVersion and teachingUnitId", () => {
  expect(
    activitySpecPublishInputSchema.safeParse({
      activityId: uuid,
      expectedVersion: 0,
      revisionNumber: 1,
      blockOrder: [],
    }).success,
  ).toBe(false);
  expect(
    activitySpecPublishInputSchema.parse({
      activityId: uuid,
      teachingUnitId: uuid,
      expectedVersion: 0,
      revisionNumber: 1,
      blockOrder: [
        { blockId: uuid, position: 0, blockType: "text", role: "teach" },
      ],
    }).expectedVersion,
  ).toBe(0);
});

it("accepts unit create and draft anchors", () => {
  expect(
    teachingUnitCreateInputSchema.parse({
      title: "Unit A",
      lifecycle: "candidate",
      blocks: [{ id: uuid, type: "text", content: { text: "hello" } }],
    }).lifecycle,
  ).toBe("candidate");
  expect(
    teachingDraftAnchorSchema.parse({
      blockId: uuid,
      contentVersion: 1,
      draftText: "my attempt",
    }).draftText,
  ).toBe("my attempt");
});

it("documents M1 getActivitySpecAtVersion contract", () => {
  expect(activitySpecAtVersionM1Note).toContain("current ActivitySpec row only");
  expect(activitySpecAtVersionM1Note).toContain("library revision_number");
});
