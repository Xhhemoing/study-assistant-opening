import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXAM_LESSONS } from "./lessons";
import { EXAM_SPRINT_PACK } from "./catalog";
import { examLessonContentFingerprint, validExamLessonExposure } from "./lesson-exposure-mapping";

const lesson = (id: string) => structuredClone(EXAM_LESSONS.find(item => item.id === id)!);

describe("reviewed Sprint content exposure mapping", () => {
  it("binds all 11 complete lessons to their exact UTF-8 content with standard SHA-256", () => {
    const families = new Set(EXAM_SPRINT_PACK.questions.map(question => question.familyId));
    for (const item of EXAM_LESSONS) {
      const canonical = JSON.stringify([item.id,item.topicId,item.title,item.summary,item.steps,item.workedExample,item.pitfalls]);
      expect(examLessonContentFingerprint(item)).toBe(createHash("sha256").update(canonical).digest("hex"));
      const mapping = validExamLessonExposure(item)!;
      expect(mapping).not.toBeNull();
      expect(mapping.displayedFamilyIds.every(id => families.has(id))).toBe(true);
      expect((mapping.partialFamilyIds ?? []).every(id => families.has(id) && !mapping.displayedFamilyIds.includes(id))).toBe(true);
    }
  });
  it.each([
    ["complex-arithmetic", "workedExample", "分子 (3 + i)(1 + i)", ["complex-quotient", "complex-product"]],
    ["complex-roots", "workedExample", "求 z³ = −8 的全部复根", ["complex-nth-roots"]],
    ["sequence-limits", "workedExample", "极限为 3", ["radical-rationalization"]],
    ["sequence-properties", "workedExample", "单调且上有界，所以收敛", ["monotone-bounds"]],
    ["sequence-properties", "pitfalls", "有界但振荡，例如 (−1)ⁿ，可以不收敛", ["subsequence-divergence"]],
    ["derivative-taylor", "steps", "eˣ = 1 + x + x²/2", ["taylor-second-order"]],
    ["derivative-taylor", "workedExample", "极限为 −1/6", ["taylor-third-order"]],
    ["curve-analysis", "workedExample", "局部最大点", ["critical-point-extremum"]],
    ["curve-analysis", "pitfalls", "例如 x³ 在 0", ["stationary-non-extremum"]],
    ["integration-parts", "workedExample", "求 ∫x e^(2x) dx", ["parts-exponential"]],
    ["integration-partial-fractions", "workedExample", "A = 2、B = 1", ["partial-fractions-coefficients"]],
    ["integral-ftc-applications", "workedExample", "总面积 = 2", ["area-sign-change"]],
    ["integral-ftc-applications", "workedExample", "G′(x) = 2x e^(x²)", ["ftc-upper-chain"]],
    ["series-tests", "workedExample", "收敛区间为 [−1,1)", ["power-series-endpoints", "alternating-absolute"]],
    ["uniform-convergence", "workedExample", "最大误差 eₙ(1/n) = 1/2", ["uniform-moving-peak"]],
  ] as const)("records the explicit %s %s source of %s", (id, section, source, familyIds) => {
    const item = lesson(id);
    expect([item[section]].flat().join("\n")).toContain(source);
    expect(validExamLessonExposure(item)!.displayedFamilyIds).toEqual(expect.arrayContaining([...familyIds]));
  });
  it("distinguishes partial closed-interval answers from complete solved families", () => {
    const mapping = validExamLessonExposure(lesson("curve-analysis"))!;
    expect(mapping.partialFamilyIds).toEqual(["closed-interval-extrema"]);
    expect(mapping.displayedFamilyIds).not.toContain("closed-interval-extrema");
  });
  it.each([
    ["complex-arithmetic", "modulus-power"], ["sequence-properties", "affine-recursion"],
    ["integration-partial-fractions", "partial-fractions-identity"],
    ["uniform-convergence", "uniform-monotone-error"], ["uniform-convergence", "uniform-domain-restriction"],
    ["series-tests", "p-series"],
  ])("does not turn general principles or a different method example into permanent %s / %s exposure", (id, familyId) => {
    const mapping = validExamLessonExposure(lesson(id))!;
    expect([...mapping.displayedFamilyIds, ...(mapping.partialFamilyIds ?? [])]).not.toContain(familyId);
  });
  it.each(["title", "summary", "steps", "workedExample", "pitfalls"] as const)("invalidates the mapping after any %s prose changes", field => {
    const item = lesson("complex-arithmetic");
    item.exposure = validExamLessonExposure(item)!;
    if (Array.isArray(item[field])) (item[field] as string[]).push("changed");
    else (item as unknown as Record<string, unknown>)[field] = `${item[field]} changed`;
    expect(validExamLessonExposure(item)).toBeNull();
  });
  it("cannot launder the map with a self-hash or erased family list", () => {
    const item = lesson("complex-arithmetic");
    item.exposure = { ...validExamLessonExposure(item)!, displayedFamilyIds: [] };
    expect(validExamLessonExposure(item)).toBeNull();
    item.workedExample = "unreviewed";
    item.exposure.contentFingerprint = examLessonContentFingerprint(item);
    expect(validExamLessonExposure(item)).toBeNull();
  });
  it("resolves an exactly matching legacy snapshot without adding metadata to it", () => {
    const item = lesson("complex-arithmetic");
    delete item.exposure;
    const before = structuredClone(item);
    expect(validExamLessonExposure(item)).not.toBeNull();
    expect(item).toEqual(before);
  });
});
