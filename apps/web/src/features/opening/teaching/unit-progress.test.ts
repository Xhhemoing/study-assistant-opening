import { describe, expect, it } from "vitest";
import type { ActivitySpecClientInit } from "@aistudy/contracts";
import { unitProgress } from "./unit-progress";

const activity = { id: "lesson", contentVersion: 3 };
const blocks: ActivitySpecClientInit["blocks"] = [
  { blockId: "intro", position: 0, blockType: "text", role: "teach", content: null },
  { blockId: "formula", position: 1, blockType: "math", role: "teach", content: null },
  { blockId: "question", position: 2, blockType: "question", role: "prompt", content: null },
  { blockId: "answer", position: 3, blockType: "answer_key", role: "answer_key", content: null },
  { blockId: "draft", position: 4, blockType: "draft", role: "teach", content: null },
  { blockId: "next", position: 5, blockType: "text", role: "teach", content: null },
];
const resume = {
  activityId: activity.id, contentVersion: 3,
  clientInit: { activityId: activity.id, contentVersion: 3, blocks: [...blocks].reverse(), checkpointJson: { currentBlockId: "formula" } },
  thoughtTrain: { currentBlockId: "formula" },
};

describe("unitProgress", () => {
  it("groups sorted lesson content and question attachments exactly like the workspace", () => {
    expect(unitProgress(activity, resume)).toEqual({ current: 1, total: 3 });
    for (const currentBlockId of ["question", "answer", "draft"]) {
      expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, checkpointJson: { currentBlockId } } })).toEqual({ current: 2, total: 3 });
    }
    expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, checkpointJson: { currentBlockId: "next" } } })).toEqual({ current: 3, total: 3 });
  });
  it("does not borrow a position from another activity or content revision", () => {
    expect(unitProgress({ ...activity, id: "other" }, resume)).toBeNull();
    expect(unitProgress({ ...activity, contentVersion: 4 }, resume)).toBeNull();
    expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, activityId: "other" } })).toBeNull();
    expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, contentVersion: 4 } })).toBeNull();
    expect(unitProgress(activity, { ...resume, clientInit: null })).toBeNull();
  });
  it("uses the checkpoint bundled with the rendered content when an earlier read disagrees", () => {
    const concurrentRead = { ...resume, clientInit: { ...resume.clientInit, checkpointJson: { currentBlockId: "question" } } };
    expect(concurrentRead.thoughtTrain.currentBlockId).toBe("formula");
    expect(unitProgress(activity, concurrentRead)).toEqual({ current: 2, total: 3 });
  });
  it("matches the workspace's restored location when a saved cursor is skipped", () => {
    expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, checkpointJson: { currentBlockId: "question", skippedBlockIds: ["question"] } } })).toEqual({ current: 1, total: 3 });
  });
  it("starts at the first unit without a checkpoint but rejects unknown blocks and empty lessons", () => {
    expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, checkpointJson: { currentBlockId: "missing" } } })).toBeNull();
    expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, checkpointJson: {} } })).toEqual({ current: 1, total: 3 });
    expect(unitProgress(activity, { ...resume, clientInit: { ...resume.clientInit, blocks: [] } })).toBeNull();
  });
});
