import { describe, expect, it } from "vitest";
import type { CourseRouteRequirementInput } from "@aistudy/contracts";
import { decideCourseRouteVerification, readCourseSpanBindingOptions, resolveCourseSpanExerciseKeys, readConfirmedCourseSpanExerciseKeys } from "./opening-course-route-verification-policy";
import { chooseSpanRepairTeaching, listSpanTeachingProblems, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { listGeneratedSpanItems } from "../../../domain/src/opening/span-generated-items";
import { getSpanItemIdentity, listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";

type Verification = CourseRouteRequirementInput["verification"];
const submitted = (kind: Verification["kind"], rubric: string | null = "标准"): Verification => ({
  kind, rubric, status: "ready", exerciseKeys: ["forged"], missingReasons: ["forged"],
});
describe("explicit canonical span content confirmation", () => {
  it("publishes only the finite public teaching metadata", () => {
    const options = readCourseSpanBindingOptions();
    expect(options.map(option => option.id)).toEqual(listSpanTeachingProblems().filter(problem => listSpanReservedProblems("validation")
      .some(candidate => candidate.familyId === problem.familyId && candidate.target.length === problem.target.length)).map(problem => problem.id));
    for (const option of options) expect(Object.keys(option).sort()).toEqual(["dimension", "familyId", "id", "supportedScope", "version"]);
  });
  it.each(listSpanTeachingProblems().filter(problem => readCourseSpanBindingOptions().some(option => option.id === problem.id)))("expands $id by family AND dimension, excluding other purposes", problem => {
    const keys = resolveCourseSpanExerciseKeys([problem.id]);
    expect(keys).toContain(problem.id);
    expect(keys.some(id => getSpanItemIdentity(id)?.purpose === "validation")).toBe(true);
    const all = [...listSpanTeachingProblems(), ...listGeneratedSpanItems("teaching"), ...listSpanReservedProblems("validation")];
    expect(keys).toEqual(all.filter(candidate => candidate.familyId === problem.familyId && candidate.target.length === problem.target.length).map(candidate => candidate.id).sort());
    for (const id of keys) expect(["retest", "research"]).not.toContain(getSpanItemIdentity(id)?.purpose);
    expect(readConfirmedCourseSpanExerciseKeys(SPAN_REQUIREMENT_KEY, { ...submitted("exact"), exerciseKeys: keys })).toEqual(keys);
  });
  it("retains exact legacy sets without granting newly confirmed teaching keys", () => {
    for (const option of readCourseSpanBindingOptions()) {
      const legacy = [...listSpanTeachingProblems(), ...listSpanReservedProblems("validation")]
        .filter(p => p.familyId === option.familyId && p.target.length === option.dimension).map(p => p.id).sort();
      const stored = { ...submitted("exact"), exerciseKeys: legacy };
      expect(readConfirmedCourseSpanExerciseKeys(SPAN_REQUIREMENT_KEY, stored)).toEqual(legacy);
      const expanded = resolveCourseSpanExerciseKeys([option.id]);
      expect(expanded.length).toBeGreaterThan(legacy.length);
      expect(stored.exerciseKeys).toEqual(legacy);
      for (const partial of [[...legacy, expanded.find(id => !legacy.includes(id))!], expanded.filter(id => id !== legacy[0])])
        expect(readConfirmedCourseSpanExerciseKeys(SPAN_REQUIREMENT_KEY, { ...stored, exerciseKeys: partial })).toBeNull();
    }
  });
  it("makes a real same-family/dimension distinct teaching pair available from new explicit confirmation", () => {
    const problem = listSpanTeachingProblems().find(p => p.id === "span-example-2d")!;
    const keys = resolveCourseSpanExerciseKeys([problem.id]);
    const candidates = [...listSpanTeachingProblems(), ...listGeneratedSpanItems("teaching")].filter(p => keys.includes(p.id));
    const pair = chooseSpanRepairTeaching(problem, { contentKeys: new Set(), unknownHistory: false }, candidates);
    expect(pair).not.toBeNull();
    for (const p of [pair!.teachingExample, pair!.practiceVariant]) {
      expect(p).toMatchObject({ version: "1", familyId: problem.familyId });
      expect(p.target).toHaveLength(problem.target.length);
      expect(keys).toContain(p.id);
    }
  });
  it("rejects hidden, generated, obsolete, arbitrary and duplicate confirmation identities", () => {
    for (const keys of [[], ["span-example-2d", "span-example-2d"], ["teaching-item:fake"], ["span-reserved-20261021-q01"],
      ["span-reserved-generated-teaching-1729-0"], ["span-example-2d:v2"], ["span-reserved-generated-research-1729-0"],
      ["span-contrast-dependent"], ["span-simulation-dependent"]])
      expect(() => resolveCourseSpanExerciseKeys(keys)).toThrow();
  });
  it("never reinterprets partial, augmented, duplicate or foreign stored sets as confirmed", () => {
    const keys = resolveCourseSpanExerciseKeys(["span-example-2d"]);
    for (const exerciseKeys of [["span-example-2d"], [...keys, "forged"], [...keys, keys[0]!], keys.slice(1)])
      expect(readConfirmedCourseSpanExerciseKeys(SPAN_REQUIREMENT_KEY, { ...submitted("exact"), exerciseKeys })).toBeNull();
    expect(readConfirmedCourseSpanExerciseKeys("foreign", { ...submitted("exact"), exerciseKeys: keys })).toBeNull();
    expect(readConfirmedCourseSpanExerciseKeys(SPAN_REQUIREMENT_KEY, { ...submitted("exact"), status: "missing", exerciseKeys: keys })).toBeNull();
  });
});

describe("server verification policy", () => {
  for (const available of [false, true]) for (const enabled of [false, true]) {
    it(`ignores client unavailable state (sources=${available}, exact=${enabled})`, () => {
      for (const old of [null, submitted("unavailable"), submitted("unavailable", "旧标准")]) {
        expect(decideCourseRouteVerification(submitted("unavailable"), old, available, enabled)).toEqual({
          kind: "unavailable", status: "missing", exerciseKeys: [], rubric: "标准", missingReasons: ["尚未确认本要求的题目与判定标准"],
        });
      }
    });
    for (const kind of ["rubric", "manual"] as const) {
      it(`preserves only matching confirmed ${kind} (sources=${available}, exact=${enabled})`, () => {
        const previous = { ...submitted(kind, "  标准\n  一 "), exerciseKeys: ["server"], missingReasons: [] };
        expect(decideCourseRouteVerification(submitted(kind, "标准 一"), previous, available, enabled)).toEqual(previous);
        for (const old of [null, { ...previous, status: "needs_check" as const }, { ...previous, kind: "exact" as const }, { ...previous, rubric: "旧标准" }]) {
          expect(decideCourseRouteVerification(submitted(kind, "标准 一"), old, available, enabled)).toMatchObject({
            kind, status: "needs_check", exerciseKeys: [], rubric: "标准 一",
          });
          expect(decideCourseRouteVerification(submitted(kind, "标准 一"), old, available, enabled).missingReasons).not.toEqual(["forged"]);
        }
      });
    }
    it(`derives exact readiness from capability and sources (sources=${available}, exact=${enabled})`, () => {
      for (const old of [null, submitted("exact"), submitted("exact", "旧标准"), submitted("rubric", "其他")]) {
        const result = decideCourseRouteVerification(submitted("exact"), old, available, enabled);
        expect(result).toMatchObject({ kind: "exact", status: enabled && available ? "ready" : "missing", exerciseKeys: [], rubric: "标准" });
        expect(result.missingReasons.length).toBe(enabled && available ? 0 : 1);
        expect(result.missingReasons).not.toContain("forged");
      }
    });
  }
});

describe("unchanged stored verification", () => {
  const oldReason = ["尚未提供验证题目或评分标准"];
  it.each([
    { kind: "unavailable" as const, status: "missing" as const, rubric: null, enabled: false },
    { kind: "rubric" as const, status: "needs_check" as const, rubric: "  标准  ", enabled: false },
    { kind: "manual" as const, status: "needs_check" as const, rubric: "  标准  ", enabled: false },
  ])("preserves old reason for $kind/$status", ({ kind, status, rubric, enabled }) => {
    const previous: Verification = { kind, status, rubric, exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted(kind, rubric?.trim() ?? null), previous, true, enabled)).toEqual(previous);
  });
  it("normalizes a non-ready row with exercise keys", () => {
    const previous: Verification = { kind: "rubric", status: "needs_check", rubric: "标准", exerciseKeys: ["forged"], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("rubric"), previous, true, false)).toEqual({
      kind: "rubric", status: "needs_check", rubric: "标准", exerciseKeys: [], missingReasons: ["请先确认本要求的题目与判定标准"],
    });
  });
  it("normalizes an incorrect status", () => {
    const previous: Verification = { kind: "rubric", status: "missing", rubric: "标准", exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("rubric"), previous, true, false)).toMatchObject({ status: "needs_check", exerciseKeys: [], missingReasons: ["请先确认本要求的题目与判定标准"] });
  });
  it("normalizes a changed rubric", () => {
    const previous: Verification = { kind: "rubric", status: "needs_check", rubric: "旧标准", exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("rubric"), previous, true, false)).toMatchObject({ status: "needs_check", rubric: "标准", exerciseKeys: [], missingReasons: ["请先确认本要求的题目与判定标准"] });
  });
  it("enables exact when capability and sources become available", () => {
    const previous: Verification = { kind: "exact", status: "missing", rubric: "标准", exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("exact"), previous, true, true)).toEqual({ kind: "exact", status: "ready", rubric: "标准", exerciseKeys: [], missingReasons: [] });
  });
  it("preserves ready when both rubrics are null, but not when only one is null", () => {
    const previous: Verification = { kind: "rubric", status: "ready", rubric: null, exerciseKeys: ["server"], missingReasons: [] };
    expect(decideCourseRouteVerification(submitted("rubric", null), previous, true, false)).toEqual(previous);
    expect(decideCourseRouteVerification(submitted("rubric", "标准"), previous, true, false)).toMatchObject({ status: "needs_check", exerciseKeys: [] });
    expect(decideCourseRouteVerification(submitted("rubric", null), { ...previous, rubric: "标准" }, true, false)).toMatchObject({ status: "needs_check", exerciseKeys: [] });
  });
  it("recomputes a stored exact reason when the switch turns on", () => {
    const previous: Verification = { kind: "exact", status: "missing", rubric: "标准", exerciseKeys: [], missingReasons: ["确定性判定能力尚未开启"] };
    expect(decideCourseRouteVerification(submitted("exact"), previous, false, true)).toEqual({ ...previous, missingReasons: ["本要求的来源材料不可用"] });
    expect(decideCourseRouteVerification(submitted("exact"), previous, true, true)).toEqual({ ...previous, status: "ready", missingReasons: [] });
  });
  it("rewrites an old exact reason but keeps an identical server reason deep-equal", () => {
    const server: Verification = { kind: "exact", status: "missing", rubric: "标准", exerciseKeys: [], missingReasons: ["确定性判定能力尚未开启"] };
    expect(decideCourseRouteVerification(submitted("exact"), { ...server, missingReasons: oldReason }, true, false)).toEqual(server);
    expect(decideCourseRouteVerification(submitted("exact"), server, true, false)).toStrictEqual(server);
  });
  it("does not keep a stored row of another kind", () => {
    const previous: Verification = { kind: "rubric", status: "needs_check", rubric: "标准", exerciseKeys: [], missingReasons: oldReason };
    expect(decideCourseRouteVerification(submitted("manual"), previous, true, false)).toEqual({
      kind: "manual", status: "needs_check", rubric: "标准", exerciseKeys: [], missingReasons: ["请先确认本要求的题目与判定标准"],
    });
  });
});
