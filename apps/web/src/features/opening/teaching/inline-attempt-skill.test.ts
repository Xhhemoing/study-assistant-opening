import { describe, expect, it } from "vitest";
import { defaultInlineAttemptSkill } from "./inline-attempt-skill";

describe("inline attempt skill context", () => {
  const knowledge = { nodes: [{ id: "rank", label: "Matrix Rank", kind: "concept" }] };
  it("prefers the matching knowledge node, then an existing skill, then the current outline title", () => {
    expect(defaultInlineAttemptSkill({ outlineTitle: "matrix rank", knowledge, skillOptions: ["MATRIXRANK"] })).toBe("Matrix Rank");
    expect(defaultInlineAttemptSkill({ outlineTitle: "matrix rank", skillOptions: ["MATRIXRANK"] })).toBe("MATRIXRANK");
    expect(defaultInlineAttemptSkill({ outlineTitle: "matrix rank" })).toBe("matrix rank");
    expect(defaultInlineAttemptSkill({})).toBe("");
  });
  it("keeps an edited draft, including a deliberately cleared value", () => {
    expect(defaultInlineAttemptSkill({ draftSkillLabel: "My skill", outlineTitle: "matrix rank", knowledge })).toBe("My skill");
    expect(defaultInlineAttemptSkill({ draftSkillLabel: "", learnerSkillLabel: "matrix rank", knowledge })).toBe("");
  });
  it("keeps the selected learning skill ahead of generic outline and chapter labels", () => {
    expect(defaultInlineAttemptSkill({ learnerSkillLabel: "matrix rank", outlineTitle: "Check understanding", knowledge })).toBe("Matrix Rank");
    expect(defaultInlineAttemptSkill({ outlineTitle: "rank", knowledge: { nodes: [{ id: "chapter", label: "RANK", kind: "chapter" }] } })).toBe("rank");
  });
});
