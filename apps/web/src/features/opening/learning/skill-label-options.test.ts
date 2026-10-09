import { describe, expect, it } from "vitest";
import {
  collectSkillLabelOptions,
  findSkillLabelReuseHint,
  normalizeSkillLabelKey,
} from "./skill-label-options";

describe("skill-label-options", () => {
  it("normalizes full-width, case, and whitespace for comparison", () => {
    expect(normalizeSkillLabelKey("　分数　加法\n")).toBe("分数加法");
    expect(normalizeSkillLabelKey("Fractions")).toBe("fractions");
    expect(normalizeSkillLabelKey("ＦＲＡＣＴＩＯＮＳ")).toBe("fractions");
  });

  it("collects unique skill labels from summary rows and aggregate identities", () => {
    expect(
      collectSkillLabelOptions([
        { skillLabel: "分数加法" },
        { skillLabel: " 分数加法 " },
        { identity: { skillLabel: "代数" } },
        { skillLabel: "" },
        { skillLabel: null },
      ]),
    ).toEqual(["代数", "分数加法"]);
  });

  it("hints reuse when spelling differs only by space/case/width, without rewriting", () => {
    const options = ["分数加法", "Chain Rule"];
    expect(findSkillLabelReuseHint("分数 加法", options)).toBe("分数加法");
    expect(findSkillLabelReuseHint("chain  rule", options)).toBe("Chain Rule");
    expect(findSkillLabelReuseHint("分数加法", options)).toBeNull();
    expect(findSkillLabelReuseHint("全新技能", options)).toBeNull();
    expect(findSkillLabelReuseHint("  ", options)).toBeNull();
  });
});
