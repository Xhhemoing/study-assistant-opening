import { describe, expect, it } from "vitest";
import { defaultInlineAttemptSkill } from "./inline-attempt-skill";

describe("inline attempt skill context", () => {
  const knowledge = { nodes: [{ id: "rank", label: "Matrix Rank", kind: "concept" }] };
  it("prefers the matching knowledge node, then an existing skill, then the current outline title", () => {
    expect(defaultInlineAttemptSkill({ outlineTitle: "matrix rank", knowledge, skillOptions: ["MATRIXRANK"] })).toBe("Matrix Rank");
    expect(defaultInlineAttemptSkill({ outlineTitle: "matrix rank", skillOptions: ["MATRIXRANK"] })).toBe("MATRIXRANK");
    expect(defaultInlineAttemptSkill({ outlineTitle: "matrix rank" })).toBe("matrix rank");
    expect(defaultInlineAttemptSkill({})).toBe("课堂练习");
  });
  it("keeps an edited draft, and infers a missing label", () => {
    expect(defaultInlineAttemptSkill({ draftSkillLabel: "My skill", outlineTitle: "matrix rank", knowledge })).toBe("My skill");
    expect(defaultInlineAttemptSkill({ draftSkillLabel: "", learnerSkillLabel: "matrix rank", knowledge })).toBe("Matrix Rank");
  });
  it("records the question's own topic before the lesson default while preserving saved drafts", () => {
    expect(defaultInlineAttemptSkill({ questionSkillLabel: "矩阵秩", learnerSkillLabel: "行列式", outlineTitle: "模拟练习" })).toBe("矩阵秩");
    expect(defaultInlineAttemptSkill({ draftSkillLabel: "用户已选考点", questionSkillLabel: "矩阵秩" })).toBe("用户已选考点");
    expect(defaultInlineAttemptSkill({ draftSkillLabel: "", questionSkillLabel: "矩阵秩" })).toBe("矩阵秩");
  });
  it("keeps the selected learning skill ahead of generic outline and chapter labels", () => {
    expect(defaultInlineAttemptSkill({ learnerSkillLabel: "matrix rank", outlineTitle: "Check understanding", knowledge })).toBe("Matrix Rank");
    expect(defaultInlineAttemptSkill({ outlineTitle: "rank", knowledge: { nodes: [{ id: "chapter", label: "RANK", kind: "chapter" }] } })).toBe("rank");
  });
});
