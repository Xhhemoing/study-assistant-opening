import { describe, expect, it, vi } from "vitest";
import { createRetestCloseHandler } from "./retest-close";

const scope = {
  workspaceId: "00000000-0000-4000-8000-0000000000w1",
  ownerUserId: "00000000-0000-4000-8000-0000000000u1",
};
const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OBS = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const RETEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const COURSE = "00000000-0000-4000-8000-0000000000c1";

describe("createRetestCloseHandler", () => {
  it("clears due and links SkillEvidence on independent correct retest", async () => {
    const link = vi.fn(async () => ({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      nodeId: NODE,
      observationId: OBS,
      dimension: "transfer" as const,
    }));
    const ensureDueCleared = vi.fn(async () => ({ dueCleared: true }));
    const getSnapshot = vi.fn(async () => ({
      nodes: [{ id: NODE, label: "chain rule" }],
    }));
    const close = createRetestCloseHandler({ link, ensureDueCleared, getSnapshot });

    const result = await close(scope, {
      observationId: OBS,
      courseId: COURSE,
      skillLabel: "chain rule",
      retestId: RETEST,
      assistance: "independent",
      outcome: "correct",
    });

    expect(ensureDueCleared).toHaveBeenCalledWith(scope, RETEST);
    expect(link).toHaveBeenCalledWith(scope, {
      nodeId: NODE,
      observationId: OBS,
      dimension: "transfer",
      courseId: COURSE,
    });
    expect(result).toMatchObject({
      dueCleared: true,
      nextKind: "independent_variant",
      linked: { nodeId: NODE, dimension: "transfer" },
    });
  });

  it("clears due but does not link after assisted success", async () => {
    const link = vi.fn();
    const close = createRetestCloseHandler({
      link,
      ensureDueCleared: async () => ({ dueCleared: true }),
      getSnapshot: async () => ({ nodes: [{ id: NODE, label: "chain rule" }] }),
    });

    const result = await close(scope, {
      observationId: OBS,
      courseId: COURSE,
      skillLabel: "chain rule",
      retestId: RETEST,
      assistance: "revealed",
      outcome: "correct",
    });

    expect(link).not.toHaveBeenCalled();
    expect(result).toEqual({
      linked: null,
      dueCleared: true,
      skippedReason: "assisted_or_unverified",
      nextKind: null,
    });
  });

  it("skips link when observation already has SkillEvidence", async () => {
    const link = vi.fn();
    const close = createRetestCloseHandler({
      link,
      ensureDueCleared: async () => ({ dueCleared: true }),
      getSnapshot: async () => null,
      listByObservation: async () => [{ id: "e1", nodeId: NODE }],
    });

    const result = await close(scope, {
      observationId: OBS,
      courseId: COURSE,
      skillLabel: "chain rule",
      retestId: RETEST,
      assistance: "independent",
      outcome: "correct",
    });

    expect(link).not.toHaveBeenCalled();
    expect(result.skippedReason).toBe("already_linked");
    expect(result.nextKind).toBe("independent_variant");
  });

  it("skips link when knowledge has no matching node", async () => {
    const link = vi.fn();
    const close = createRetestCloseHandler({
      link,
      ensureDueCleared: async () => ({ dueCleared: true }),
      getSnapshot: async () => ({ nodes: [{ id: NODE, label: "limits" }] }),
    });

    const result = await close(scope, {
      observationId: OBS,
      courseId: COURSE,
      skillLabel: "chain rule",
      retestId: RETEST,
      assistance: "independent",
      outcome: "correct",
    });

    expect(link).not.toHaveBeenCalled();
    expect(result.skippedReason).toBe("no_node");
  });
});
