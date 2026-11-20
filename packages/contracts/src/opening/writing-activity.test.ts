import { describe, expect, it } from "vitest";
import {
  WRITING_META_PROPERTY_KEY,
  WRITING_WORKSPACE_PROTOCOL,
  courselessActivityOutcomeSchema,
  writingActivityCheckpointSchema,
  writingAssistanceKindSchema,
  writingAssistanceRecordSchema,
  writingCommandInputSchema,
  writingDimensionSchema,
  writingFocusRestoreSchema,
  writingStartInputSchema,
  writingVariantMetaSchema,
  writingVariantSummarySchema,
  writingWorkspaceResponseSchema,
  writingWorkspaceViewSchema,
  type CourselessActivityOutcome,
  type WritingActivityCheckpoint,
  type WritingAssistanceRecord,
  type WritingCommandInput,
  type WritingFocusRestore,
  type WritingStartInput,
  type WritingVariantMeta,
  type WritingVariantSummary,
  type WritingWorkspaceResponse,
  type WritingWorkspaceView,
} from "./writing-activity";
import {
  WRITING_META_PROPERTY_KEY as openingMetaKey,
  WRITING_WORKSPACE_PROTOCOL as openingProtocol,
  courselessActivityOutcomeSchema as openingOutcomeSchema,
  writingWorkspaceResponseSchema as openingWorkspaceResponseSchema,
} from "./index";
import {
  WRITING_META_PROPERTY_KEY as barrelMetaKey,
  WRITING_WORKSPACE_PROTOCOL as barrelProtocol,
  courselessActivityOutcomeSchema as barrelOutcomeSchema,
  writingCommandInputSchema as barrelCommandInputSchema,
  writingWorkspaceResponseSchema as barrelWorkspaceResponseSchema,
} from "../index";

const uuid1 = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";
const uuid3 = "33333333-3333-4333-8333-333333333333";
const uuid4 = "44444444-4444-4444-8444-444444444444";
const iso1 = "2026-11-18T10:00:00.000Z";
const iso2 = "2026-11-18T10:05:00.000Z";

describe("writing-activity contracts", () => {
  it("exports protocol constants and re-exports through index barrels", () => {
    expect(WRITING_WORKSPACE_PROTOCOL).toBe("writing-workspace-v1");
    expect(WRITING_META_PROPERTY_KEY).toBe("opening.writing.meta");
    expect(openingProtocol).toBe(WRITING_WORKSPACE_PROTOCOL);
    expect(openingMetaKey).toBe(WRITING_META_PROPERTY_KEY);
    expect(barrelProtocol).toBe(WRITING_WORKSPACE_PROTOCOL);
    expect(barrelMetaKey).toBe(WRITING_META_PROPERTY_KEY);
  });

  it("validates dimensions, assistance kinds, and assistance records strictly", () => {
    for (const dimension of ["argument", "language", "structure", "evidence"] as const) {
      expect(writingDimensionSchema.parse(dimension)).toBe(dimension);
    }
    expect(writingDimensionSchema.safeParse("style").success).toBe(false);

    for (const kind of ["feedback", "polish_suggestion"] as const) {
      expect(writingAssistanceKindSchema.parse(kind)).toBe(kind);
    }
    expect(writingAssistanceKindSchema.safeParse("rewrite").success).toBe(false);

    const record: WritingAssistanceRecord = {
      id: uuid1,
      documentId: uuid2,
      baseRevisionNumber: 0,
      targetBlockId: "block-1",
      targetBlockTextSnapshot: "The evidence shows a clear trend.",
      dimension: "evidence",
      kind: "polish_suggestion",
      suggestionText: "Cite the specific experiment metrics to strengthen the claim.",
      adoptedAt: iso2,
      adoptedRevisionNumber: 2,
      createdAt: iso1,
    };
    expect(writingAssistanceRecordSchema.parse(record)).toEqual(record);

    const unanchoredFeedback: WritingAssistanceRecord = {
      ...record,
      targetBlockId: null,
      targetBlockTextSnapshot: "",
      kind: "feedback",
      adoptedAt: null,
      adoptedRevisionNumber: null,
    };
    expect(writingAssistanceRecordSchema.parse(unanchoredFeedback)).toEqual(unanchoredFeedback);

    expect(
      writingAssistanceRecordSchema.safeParse({ ...record, extra: true }).success,
    ).toBe(false);
    expect(
      writingAssistanceRecordSchema.safeParse({ ...record, baseRevisionNumber: -1 }).success,
    ).toBe(false);
    expect(
      writingAssistanceRecordSchema.safeParse({ ...record, targetBlockId: "" }).success,
    ).toBe(false);
    expect(
      writingAssistanceRecordSchema.safeParse({ ...record, suggestionText: "" }).success,
    ).toBe(false);
    expect(
      writingAssistanceRecordSchema.safeParse({ ...record, createdAt: "not-iso" }).success,
    ).toBe(false);
  });

  it("validates variant metadata, checkpoint, and focus restore unions", () => {
    const assistanceRecord: WritingAssistanceRecord = {
      id: uuid1,
      documentId: uuid2,
      baseRevisionNumber: 1,
      targetBlockId: "b-2",
      targetBlockTextSnapshot: "Original sentence.",
      dimension: "language",
      kind: "polish_suggestion",
      suggestionText: "Refined sentence.",
      adoptedAt: null,
      adoptedRevisionNumber: null,
      createdAt: iso1,
    };

    const meta: WritingVariantMeta = {
      workGroupId: uuid3,
      variantLabel: "  Draft B  ",
      parentDocumentId: uuid4,
      parentRevisionNumber: 3,
      keptAsPreferred: true,
      focusBlockId: "b-2",
      assistanceRecords: [assistanceRecord],
    };
    expect(writingVariantMetaSchema.parse(meta).variantLabel).toBe("Draft B");
    expect(
      writingVariantMetaSchema.safeParse({ ...meta, variantLabel: "   " }).success,
    ).toBe(false);
    expect(
      writingVariantMetaSchema.safeParse({ ...meta, extra: 1 }).success,
    ).toBe(false);

    const checkpoint: WritingActivityCheckpoint = {
      protocol: WRITING_WORKSPACE_PROTOCOL,
      workGroupId: uuid3,
      activeDocumentId: uuid2,
      activeVariantLabel: "  Draft B ",
      savedRevisionNumber: 4,
      focusBlockId: null,
      updatedAt: iso2,
    };
    expect(writingActivityCheckpointSchema.parse(checkpoint).activeVariantLabel).toBe("Draft B");
    expect(
      writingActivityCheckpointSchema.safeParse({
        ...checkpoint,
        protocol: "writing-workspace-v2",
      }).success,
    ).toBe(false);
    expect(
      writingActivityCheckpointSchema.safeParse({
        ...checkpoint,
        extra: "forbidden",
      }).success,
    ).toBe(false);

    const restores: WritingFocusRestore[] = [
      { status: "none" },
      { status: "exact", blockId: "block-9" },
      {
        status: "block_missing",
        requestedBlockId: "block-9",
        message: "Target block was deleted; restored draft top.",
      },
    ];
    for (const restore of restores) {
      expect(writingFocusRestoreSchema.parse(restore)).toEqual(restore);
    }
    expect(
      writingFocusRestoreSchema.safeParse({ status: "none", blockId: "x" }).success,
    ).toBe(false);
    expect(
      writingFocusRestoreSchema.safeParse({ status: "exact", blockId: "" }).success,
    ).toBe(false);
    expect(
      writingFocusRestoreSchema.safeParse({
        status: "block_missing",
        requestedBlockId: "b1",
        message: "ok",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("validates writingStartInputSchema and writingCommandInputSchema variants", () => {
    const startInput: WritingStartInput = {
      clientKey: "writing-start-01",
      title: "  Argumentative Essay  ",
      initialText: "",
      variantLabel: "  Variant A  ",
      courseId: null,
    };
    expect(writingStartInputSchema.parse(startInput)).toEqual({
      ...startInput,
      title: "Argumentative Essay",
      variantLabel: "Variant A",
    });
    expect(
      writingStartInputSchema.parse({
        clientKey: "writing-start-02",
        title: "Course Writing",
        courseId: uuid1,
      }),
    ).toMatchObject({ courseId: uuid1 });
    expect(
      writingStartInputSchema.safeParse({
        clientKey: "short",
        title: "Valid",
      }).success,
    ).toBe(false);
    expect(
      writingStartInputSchema.safeParse({
        clientKey: "writing-start-03",
        title: "   ",
      }).success,
    ).toBe(false);
    expect(
      writingStartInputSchema.safeParse({
        clientKey: "writing-start-03",
        title: "Valid",
        extra: true,
      }).success,
    ).toBe(false);

    const commands: WritingCommandInput[] = [
      {
        action: "derive_variant",
        expectedRevisionNumber: 2,
        variantLabel: "  Draft B  ",
        focusBlockId: "block-3",
        activityId: uuid1,
      },
      {
        action: "record_feedback",
        expectedRevisionNumber: 2,
        targetBlockId: null,
        dimension: "argument",
        kind: "feedback",
        suggestionText: "  Tighten the thesis statement.  ",
      },
      {
        action: "adopt_suggestion",
        expectedRevisionNumber: 3,
        assistanceId: uuid2,
        targetBlockId: "block-3",
        replacementText: "  Improved paragraph text.  ",
        activityId: uuid1,
      },
      {
        action: "set_preferred_variant",
        keptAsPreferred: true,
        activityId: uuid1,
      },
      {
        action: "set_preferred_variant",
        keptAsPreferred: false,
      },
      {
        action: "save_checkpoint",
        activityId: uuid1,
        focusBlockId: "block-3",
      },
      {
        action: "save_checkpoint",
        activityId: uuid1,
        focusBlockId: null,
        keptAsPreferred: true,
      },
    ];

    expect(writingCommandInputSchema.parse(commands[0])).toEqual({
      ...commands[0],
      variantLabel: "Draft B",
    });
    expect(writingCommandInputSchema.parse(commands[1])).toEqual({
      ...commands[1],
      suggestionText: "Tighten the thesis statement.",
    });
    expect(barrelCommandInputSchema.parse(commands[2])).toEqual({
      ...commands[2],
      replacementText: "Improved paragraph text.",
    });
    expect(barrelCommandInputSchema.parse(commands[3])).toEqual(commands[3]);
    expect(writingCommandInputSchema.parse(commands[4])).toEqual(commands[4]);
    expect(writingCommandInputSchema.parse(commands[5])).toEqual(commands[5]);
    expect(writingCommandInputSchema.parse(commands[6])).toEqual(commands[6]);

    expect(
      writingCommandInputSchema.safeParse({
        action: "set_preferred_variant",
        keptAsPreferred: true,
        focusBlockId: null,
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "set_preferred_variant",
        keptAsPreferred: true,
        expectedRevisionNumber: 1,
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "set_preferred_variant",
        keptAsPreferred: true,
        extra: "forbidden",
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "set_preferred_variant",
        activityId: uuid1,
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "set_preferred_variant",
        keptAsPreferred: "yes",
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "derive_variant",
        expectedRevisionNumber: -1,
        variantLabel: "B",
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "record_feedback",
        expectedRevisionNumber: 0,
        targetBlockId: null,
        dimension: "structure",
        kind: "feedback",
        suggestionText: "   ",
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "adopt_suggestion",
        expectedRevisionNumber: 0,
        assistanceId: uuid2,
        targetBlockId: "b1",
        replacementText: "   ",
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "save_checkpoint",
        focusBlockId: null,
        expectedRevisionNumber: 1,
      }).success,
    ).toBe(false);
    expect(
      writingCommandInputSchema.safeParse({
        action: "delete_variant",
      }).success,
    ).toBe(false);
  });

  it("validates workspace views, responses, and courselessActivityOutcomeSchema", () => {
    const summary: WritingVariantSummary = {
      documentId: uuid1,
      title: "Essay Draft",
      variantLabel: "Original",
      currentRevisionNumber: 3,
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: true,
      focusBlockId: "block-1",
      assistanceCount: 2,
      adoptedPolishCount: 1,
      updatedAt: iso1,
    };
    expect(writingVariantSummarySchema.parse(summary)).toEqual(summary);
    expect(
      writingVariantSummarySchema.safeParse({ ...summary, adoptedPolishCount: -1 }).success,
    ).toBe(false);

    const view: WritingWorkspaceView = {
      workGroupId: uuid2,
      activityId: uuid3,
      courseId: null,
      currentDocumentId: uuid1,
      currentVariant: {
        workGroupId: uuid2,
        variantLabel: "Original",
        parentDocumentId: null,
        parentRevisionNumber: null,
        keptAsPreferred: true,
        focusBlockId: "block-1",
        assistanceRecords: [],
      },
      variants: [summary],
      focusRestore: { status: "exact", blockId: "block-1" },
    };
    expect(writingWorkspaceViewSchema.parse(view)).toEqual(view);
    expect(
      writingWorkspaceViewSchema.safeParse({ ...view, variants: [] }).success,
    ).toBe(false);

    const uninitializedResponse: WritingWorkspaceResponse = {
      initialized: false,
      documentId: uuid1,
    };
    const initializedResponse: WritingWorkspaceResponse = {
      initialized: true,
      workspace: view,
    };
    expect(writingWorkspaceResponseSchema.parse(uninitializedResponse)).toEqual(
      uninitializedResponse,
    );
    expect(openingWorkspaceResponseSchema.parse(initializedResponse)).toEqual(
      initializedResponse,
    );
    expect(barrelWorkspaceResponseSchema.parse(initializedResponse)).toEqual(
      initializedResponse,
    );
    expect(
      writingWorkspaceResponseSchema.safeParse({
        initialized: false,
        documentId: uuid1,
        workspace: view,
      }).success,
    ).toBe(false);

    const outcome: CourselessActivityOutcome = {
      activityId: uuid3,
      courseId: null,
      documentId: uuid1,
      revisionNumber: 3,
      assistance: "hinted",
      adoptedPolishCount: 1,
      keptAsPreferred: true,
      evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    };
    expect(courselessActivityOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(openingOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(barrelOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(
      courselessActivityOutcomeSchema.safeParse({
        ...outcome,
        revisionNumber: 0,
      }).success,
    ).toBe(false);
    expect(
      courselessActivityOutcomeSchema.safeParse({
        ...outcome,
        evidenceVerdict: "FLOW_VERIFIED",
      }).success,
    ).toBe(false);
    expect(
      courselessActivityOutcomeSchema.safeParse({
        ...outcome,
        extra: "forbidden",
      }).success,
    ).toBe(false);
  });
});
