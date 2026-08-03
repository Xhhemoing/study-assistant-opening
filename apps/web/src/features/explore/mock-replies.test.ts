import { describe, expect, it } from "vitest";
import { AI_ROLE_OPTIONS, craftMockReply } from "../../lib/data/mock/mock-replies";

describe("exploration mock replies", () => {
  it("keeps the eight AI roles in the product order", () => {
    expect(AI_ROLE_OPTIONS.map((option) => option.role)).toEqual([
      "retriever",
      "explainer",
      "tutor",
      "challenger",
      "editor",
      "examiner",
      "collaborator",
      "silent",
    ]);
    expect(AI_ROLE_OPTIONS.map((option) => option.label)).toEqual([
      "检索",
      "讲解",
      "教练",
      "质疑",
      "编辑",
      "考官",
      "协作",
      "静默",
    ]);
  });

  it("uses two role-specific templates with a quoted topic and simulation marker", () => {
    const content = "请帮我比较熵和信息量在学习中的不同作用";
    const excerpt = content.slice(0, 24);

    for (const option of AI_ROLE_OPTIONS) {
      const first = craftMockReply(option.role, content, 0);
      const second = craftMockReply(option.role, content, 1);

      expect(first).toContain(`「${excerpt}」`);
      expect(first).toMatch(/（模拟回复）$/);
      expect(second).toMatch(/（模拟回复）$/);
      expect(second).toContain(`「${excerpt}」`);
      expect(first).not.toBe(second);
    }
  });
});
