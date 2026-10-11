import { describe, expect, it } from "vitest";
import {
  assertResumeIndependentOfSummary,
  deriveOpenProblems,
  extractThoughtTrain,
  listContinuableActions,
  mapGenerateStatusToJobGate,
  mergeCheckpointResumePatch,
  probeMaterialsAvailability,
  resumePatchPreservesCommandAndPrefsKeys,
  resumeSummarySkipped,
} from "./teaching-resume";

const blockA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const problemA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const problemB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const attemptA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const sourceA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const sourceB = "11111111-1111-4111-8111-111111111111";

describe("teaching-resume domain (V2-14)", () => {
  it("T9 mergeCheckpointResumePatch preserves prefs + commandLog", () => {
    const prev = {
      drafts: [{ blockId: blockA, contentVersion: 1 }],
      interventionPrefs: { quietMode: true },
      interventionDecisions: [{ id: "d1" }],
      commandLog: [{ clientKey: "long-enough-key", kind: "skip", at: "2026-10-11T04:00:00.000Z", result: "ok" }],
      branchStack: [{ frameId: blockB, fromBlockId: blockA, contentVersion: 1, pathVersion: 1, createdAt: "2026-10-11T04:00:00.000Z" }],
      currentBlockId: blockA,
      skippedBlockIds: [],
      custom: 42,
    };
    const patch = {
      interactionParams: { [blockA]: { mode: "hint" } },
      drafts: [{ blockId: blockB, contentVersion: 2, draftText: "new" }],
    };
    const next = mergeCheckpointResumePatch(prev, patch);
    expect(next.interventionPrefs).toEqual({ quietMode: true });
    expect(next.interventionDecisions).toEqual([{ id: "d1" }]);
    expect(next.commandLog).toEqual(prev.commandLog);
    expect(next.branchStack).toEqual(prev.branchStack);
    expect(next.custom).toBe(42);
    expect(next.interactionParams).toEqual({ [blockA]: { mode: "hint" } });
    expect(next.drafts).toEqual(patch.drafts);
    expect(
      resumePatchPreservesCommandAndPrefsKeys(prev, next, patch),
    ).toBe(true);
  });

  it("T10/T11 mapGenerateStatusToJobGate", () => {
    expect(mapGenerateStatusToJobGate("generating")).toBe("in_flight");
    expect(mapGenerateStatusToJobGate("queued")).toBe("in_flight");
    expect(mapGenerateStatusToJobGate("unknown")).toBe("unknown");
    expect(mapGenerateStatusToJobGate("stale")).toBe("stale");
    expect(mapGenerateStatusToJobGate("ready")).toBe("ready");
    expect(mapGenerateStatusToJobGate("failed")).toBe("ready");
  });

  it("T12 probeMaterialsAvailability fail-soft", () => {
    expect(probeMaterialsAvailability([], [])).toEqual({
      materials: "available",
      unavailableSourceIds: [],
    });
    expect(probeMaterialsAvailability([sourceA], [sourceA])).toEqual({
      materials: "available",
      unavailableSourceIds: [],
    });
    expect(probeMaterialsAvailability([sourceA, sourceB], [sourceA])).toEqual({
      materials: "partial",
      unavailableSourceIds: [sourceB],
    });
    expect(probeMaterialsAvailability([sourceA], [])).toEqual({
      materials: "unavailable",
      unavailableSourceIds: [sourceA],
    });
  });

  it("T13 open problems derived from incorrect/unverified/open attempts", () => {
    const open = deriveOpenProblems({
      attempts: [
        {
          attemptId: attemptA,
          problemId: problemA,
          itemVersionId: null,
          submittedAt: null,
        },
      ],
      observationHeads: [
        { problemId: problemB, itemVersionId: null, outcome: "incorrect" },
      ],
      checkpointOpenProblemIds: [problemA],
    });
    expect(open).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ problemId: problemA, reason: "attempt_open" }),
        expect.objectContaining({
          problemId: problemB,
          reason: "incorrect_unresolved",
        }),
      ]),
    );
    const closed = deriveOpenProblems({
      attempts: [],
      observationHeads: [
        { problemId: problemB, itemVersionId: null, outcome: "correct" },
      ],
      checkpointOpenProblemIds: [problemB],
    });
    expect(closed.find((p) => p.problemId === problemB)).toBeUndefined();
  });

  it("T14 command_return iff branchStack non-empty", () => {
    const withStack = listContinuableActions({
      jobGate: "ready",
      materials: "available",
      branchStack: [
        {
          frameId: blockB,
          fromBlockId: blockA,
          contentVersion: 1,
          pathVersion: 1,
          createdAt: "2026-10-11T04:00:00.000Z",
        },
      ],
      drafts: [],
      status: "active",
      hasClientInit: true,
    });
    expect(withStack).toContain("command_return");
    const empty = listContinuableActions({
      jobGate: "ready",
      materials: "available",
      branchStack: [],
      drafts: [],
      status: "active",
      hasClientInit: true,
    });
    expect(empty).not.toContain("command_return");
  });

  it("T6 summary independence seam", () => {
    assertResumeIndependentOfSummary();
    expect(resumeSummarySkipped()).toEqual({ status: "skipped" });
  });

  it("T4 extractThoughtTrain from checkpoint", () => {
    const train = extractThoughtTrain({
      currentBlockId: blockA,
      skippedBlockIds: [blockB],
      branchStack: [
        {
          frameId: blockB,
          fromBlockId: blockA,
          contentVersion: 1,
          pathVersion: 2,
          createdAt: "2026-10-11T04:00:00.000Z",
        },
      ],
      commandLog: [
        {
          clientKey: "long-enough-key",
          kind: "branch",
          blockId: blockA,
          at: "2026-10-11T04:00:00.000Z",
          result: "ok",
        },
      ],
    });
    expect(train.currentBlockId).toBe(blockA);
    expect(train.skippedBlockIds).toEqual([blockB]);
    expect(train.branchStack).toHaveLength(1);
    expect(train.commandLog).toHaveLength(1);
  });

  it("wait_job / resolve_material from gates", () => {
    const actions = listContinuableActions({
      jobGate: "unknown",
      materials: "unavailable",
      branchStack: [],
      drafts: [{ blockId: blockA }],
      status: "paused",
      hasClientInit: false,
    });
    expect(actions).toContain("wait_job");
    expect(actions).toContain("resolve_material");
    expect(actions).toContain("edit_draft");
    expect(actions).not.toContain("continue_block");
  });
});
