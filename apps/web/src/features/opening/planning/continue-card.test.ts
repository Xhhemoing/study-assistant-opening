import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LearningResume } from "@aistudy/contracts";
import { ContinueCard, continuePosition } from "./continue-card";
import { continueMathObject } from "./continue-math-preview";

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
  it("shows an authoritative course title without borrowing an unrelated chat course", () => {
    const html = renderToStaticMarkup(createElement(ContinueCard, { activity, courseTitle: "线性代数", resume }));
    expect(html).toContain("线性代数");
    const unbound = renderToStaticMarkup(createElement(ContinueCard, { activity: { ...activity, courseId: null },
      courseTitle: "不应借用", item: { conversationId: "chat", title: "其他对话", courseId: "other" } }));
    expect(unbound).not.toContain("不应借用");
    expect(unbound).not.toContain('href="/opening/courses/other"');
    expect(unbound).not.toContain("分钟");
  });

  it("previews actual matrix inputs only from the matching visible current block", () => {
    const content = { matrixA: [[2, 0], [0, 3]], vectorX: [4, 5] };
    const block = { blockId: "b", blockType: "matrix_transform", role: "teach", position: 2, content };
    const actual = { ...resume, clientInit: { ...resume.clientInit!, activityId: activity.id, blocks: [block] } } as LearningResume;
    expect(continueMathObject(activity, actual)).toMatchObject(content);
    const html = renderToStaticMarkup(createElement(ContinueCard, { activity, resume: actual }));
    expect(html).toContain("当前数学对象缩略图");
    expect(html).toContain("输入向量");
    for (const replacement of [{ ...block, role: "answer_key" }, { ...block, blockId: "future" }, { ...block, content: { matrixA: [[2]], vectorX: [4, 5] } }]) {
      expect(continueMathObject(activity, { ...actual, clientInit: { ...actual.clientInit!, blocks: [replacement] } } as LearningResume)).toBeNull();
    }
    expect(continueMathObject({ ...activity, contentVersion: 4 }, actual)).toBeNull();
    expect(continueMathObject(activity, { ...actual, clientInit: { ...actual.clientInit!, activityId: "other" } })).toBeNull();
  });
});
