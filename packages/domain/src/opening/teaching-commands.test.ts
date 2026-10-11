import { describe, expect, it } from "vitest";
import {
  TEACHING_BRANCH_STACK_MAX,
  TEACHING_COMMAND_LOG_MAX,
} from "@aistudy/contracts";
import {
  appendCommandLog,
  assertCommandAllowed,
  buildStructuredRewriteBlocks,
  buildWhyAssist,
  classifySkipSideEffects,
  createBranchFrame,
  draftsSurvivingBlockIds,
  findCommandLogByClientKey,
  fingerprintCommandIntent,
  mergeCheckpointPreservingPrefs,
  nextBlockIdAfter,
  popBranch,
  pushBranch,
  readBranchStack,
} from "./teaching-commands";

const blockA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const blockC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("teaching-commands domain", () => {
  it("T15 mergeCheckpointPreservingPrefs keeps interventionPrefs/Decisions/drafts", () => {
    const prev = {
      drafts: [{ blockId: blockA, contentVersion: 1, draftText: "x" }],
      interventionPrefs: { quietMode: true },
      interventionDecisions: [{ id: "d1" }],
      custom: 1,
    };
    const next = mergeCheckpointPreservingPrefs(prev, {
      currentBlockId: blockB,
      skippedBlockIds: [blockA],
      branchStack: [],
      commandLog: [],
    });
    expect(next.interventionPrefs).toEqual({ quietMode: true });
    expect(next.interventionDecisions).toEqual([{ id: "d1" }]);
    expect(next.drafts).toEqual(prev.drafts);
    expect(next.custom).toBe(1);
    expect(next.currentBlockId).toBe(blockB);
    expect(next.skippedBlockIds).toEqual([blockA]);
    expect(prev).not.toHaveProperty("currentBlockId");
  });

  it("T8 classifySkipSideEffects forbids observation writes", () => {
    expect(classifySkipSideEffects()).toEqual({ writesObservation: false });
  });

  it("T10/T11 branch push/pop and cap 16", () => {
    let stack = readBranchStack({});
    for (let i = 0; i < TEACHING_BRANCH_STACK_MAX + 3; i += 1) {
      stack = pushBranch(
        stack,
        createBranchFrame({
          fromBlockId: blockA,
          contentVersion: i,
          pathVersion: i + 1,
          label: `f${i}`,
          createdAt: "2026-10-11T04:00:00.000Z",
        }),
      );
    }
    expect(stack.length).toBe(TEACHING_BRANCH_STACK_MAX);
    expect(stack[0]?.label).toBe("f3");
    const popped = popBranch(stack);
    expect("empty" in popped).toBe(false);
    if (!("empty" in popped)) {
      expect(popped.frame.label).toBe(`f${TEACHING_BRANCH_STACK_MAX + 2}`);
      expect(popped.nextStack.length).toBe(TEACHING_BRANCH_STACK_MAX - 1);
    }
    expect(popBranch([])).toEqual({ empty: true });
  });

  it("T13 generate_in_flight for rewrite; skip still allowed", () => {
    const activity = {
      generateStatus: "generating",
      contentVersion: 1,
      pathVersion: 1,
    };
    const rewrite = assertCommandAllowed({
      activity,
      kind: "rephrase",
      blockId: blockA,
      blockIdsInSpec: [blockA],
      branchStack: [],
    });
    expect(rewrite).toMatchObject({ ok: false, conflict: "generate_in_flight" });
    const skip = assertCommandAllowed({
      activity,
      kind: "skip",
      blockId: blockA,
      blockIdsInSpec: [blockA],
      branchStack: [],
    });
    expect(skip).toEqual({ ok: true });
  });

  it("T14 block_not_in_spec and T10 empty return", () => {
    expect(
      assertCommandAllowed({
        activity: { generateStatus: "ready", contentVersion: 1, pathVersion: 1 },
        kind: "why",
        blockId: blockB,
        blockIdsInSpec: [blockA],
        branchStack: [],
      }),
    ).toMatchObject({ ok: false, conflict: "block_not_in_spec" });
    expect(
      assertCommandAllowed({
        activity: { generateStatus: "ready", contentVersion: 1, pathVersion: 1 },
        kind: "return",
        blockId: undefined,
        blockIdsInSpec: [blockA],
        branchStack: [],
      }),
    ).toMatchObject({ ok: false, conflict: "branch_stack_empty" });
  });

  it("T3 soft-idempotent clientKey intent match / mismatch", () => {
    const intent = fingerprintCommandIntent({
      kind: "skip",
      blockId: blockA,
      expectedVersion: 1,
    });
    const other = fingerprintCommandIntent({
      kind: "skip",
      blockId: blockA,
      expectedVersion: 1,
      targetBlockId: blockB,
    });
    expect(intent).not.toBe(other);
    const log = appendCommandLog(
      [],
      {
        clientKey: "client-key-1",
        kind: "skip",
        blockId: blockA,
        at: "2026-10-11T04:00:00.000Z",
        result: "ok",
        pathVersionAfter: 2,
        intentFingerprint: intent,
      },
      TEACHING_COMMAND_LOG_MAX,
    );
    expect(findCommandLogByClientKey(log, "client-key-1", intent).hit).toBe("replay");
    expect(findCommandLogByClientKey(log, "client-key-1", other).hit).toBe("mismatch");
    expect(findCommandLogByClientKey(log, "other-key-xx", intent).hit).toBe("none");
  });

  it("T6/T7 draft survival vs lost anchors", () => {
    const present = new Set([blockA, blockB]);
    const drafts = [
      { blockId: blockA, contentVersion: 1, draftText: "keep" },
      { blockId: blockC, contentVersion: 1, draftText: "gone" },
    ];
    const { kept, lostBlockIds } = draftsSurvivingBlockIds(drafts, present);
    expect(kept).toHaveLength(1);
    expect(lostBlockIds).toEqual([blockC]);
  });

  it("T16 why assist does not rewrite blocks; structured rewrite annotates target only", () => {
    const assist = buildWhyAssist({ blockId: blockA, prompt: "rank", blockType: "teach" });
    expect(assist.kind).toBe("why");
    expect(assist.summary).toContain(blockA);
    const prior = [
      { id: blockA, type: "text", content: { text: "hello" } },
      { id: blockB, type: "text", content: { text: "other" } },
    ];
    const rewritten = buildStructuredRewriteBlocks(prior, {
      kind: "rephrase",
      blockId: blockA,
      prompt: "simpler",
    });
    expect(rewritten[0]?.content).toMatchObject({
      text: "hello",
      rewriteOf: { kind: "rephrase" },
    });
    expect(rewritten[1]?.content).toEqual({ text: "other" });
    expect(prior[0]?.content).toEqual({ text: "hello" });
  });

  it("nextBlockIdAfter advances or uses target", () => {
    const order = [{ blockId: blockA }, { blockId: blockB }, { blockId: blockC }];
    expect(nextBlockIdAfter(order, blockA)).toBe(blockB);
    expect(nextBlockIdAfter(order, blockC)).toBeNull();
    expect(nextBlockIdAfter(order, blockA, blockC)).toBe(blockC);
  });
});
