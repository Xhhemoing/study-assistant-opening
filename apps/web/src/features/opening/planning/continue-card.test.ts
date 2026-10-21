import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LearningResume } from "@aistudy/contracts";
import { ContinueCard, continuePosition } from "./continue-card";

const activity = { id: "activity", title: "线性组合", courseId: "course", contentVersion: 3 };
const resume = { activityId: "activity", contentVersion: 3, thoughtTrain: { currentBlockId: "b" }, clientInit: { contentVersion: 3, blockOrder: [
  { blockId: "a", position: 0, role: "teach", blockType: "text" },
  { blockId: "hidden", position: 1, role: "answer_key", blockType: "answer_key" },
  { blockId: "b", position: 2, role: "prompt", blockType: "question" },
] } } as unknown as LearningResume;

describe("ContinueCard", () => {
  it("uses the matching real reading checkpoint without treating it as mastery", () => {
    expect(continuePosition(activity, resume)).toEqual({ current: 2, total: 2 });
    const html = renderToStaticMarkup(createElement(ContinueCard, { activity, resume }));
    expect(html).toContain("第 2 / 2 步");
    expect(html).not.toContain("已掌握");
    expect(html).not.toContain("剩余");
  });
  it("does not project a checkpoint from another activity or content revision", () => {
    expect(continuePosition({ ...activity, id: "other" }, resume)).toBeNull();
    expect(continuePosition({ ...activity, contentVersion: 4 }, resume)).toBeNull();
    expect(continuePosition(activity, { ...resume, clientInit: null })).toBeNull();
  });
});
