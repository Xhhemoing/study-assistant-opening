import { describe, expect, it } from "vitest";
import {
  findRetestPrefill,
  formatRetestSubmitError,
  isDueRetestSelection,
  parseRetestCandidateId,
  retestPracticeHref,
  retestPrefillFromProjection,
  withRetestSubmit,
} from "./retest-attempt";

const candidateId = "11111111-1111-4111-8111-111111111111";
const activityId = "22222222-2222-4222-8222-222222222222";
const courseId = "33333333-3333-4333-8333-333333333333";
const projection = {
  candidateId,
  activityId,
  courseId,
  skillLabel: "分数加减",
  prompt: "隔天重做原题（先不看之前的答案）：1/2 + 1/3 = ?",
  recommendedAt: "2026-10-09T02:00:00.000Z",
};

describe("retest attempt helpers", () => {
  it("builds the course practice deep link with candidate id and hash", () => {
    expect(retestPracticeHref(courseId, candidateId)).toBe(
      `/opening/courses/${courseId}?retest=${candidateId}#course-practice`,
    );
  });

  it("accepts only uuid candidate ids from the query", () => {
    expect(parseRetestCandidateId(candidateId)).toBe(candidateId);
    expect(parseRetestCandidateId("not-a-uuid")).toBeNull();
    expect(parseRetestCandidateId(null)).toBeNull();
  });

  it("maps the task retest projection into form prefill", () => {
    expect(retestPrefillFromProjection(projection)).toEqual({
      retestId: candidateId,
      skillLabel: "分数加减",
      prompt: projection.prompt,
      recommendedAt: projection.recommendedAt,
    });
  });

  it("marks pending retests due when recommendedAt is past or missing", () => {
    const now = new Date("2026-10-09T04:00:00.000Z");
    expect(isDueRetestSelection({ status: "pending", retest: projection }, now)).toBe(true);
    expect(isDueRetestSelection({ status: "pending", retest: { ...projection, recommendedAt: null } }, now)).toBe(true);
    expect(isDueRetestSelection({ status: "pending", retest: { ...projection, recommendedAt: "2026-10-12T02:00:00.000Z" } }, now)).toBe(false);
    expect(isDueRetestSelection({ status: "done", retest: projection }, now)).toBe(false);
    expect(isDueRetestSelection({ status: "pending", retest: null }, now)).toBe(false);
  });

  it("attaches retestId on submit and leaves ordinary submits unchanged", () => {
    const base = { clientKey: "answer-key-01", answer: "5/6", outcome: "correct" as const, assistance: "independent" as const, verdictSource: "self_report" as const };
    expect(withRetestSubmit(base, candidateId)).toEqual({ ...base, retestId: candidateId });
    expect(withRetestSubmit(base, null)).toEqual(base);
    expect(withRetestSubmit(base, undefined)).toEqual(base);
  });

  it("finds prefill from the task list by candidate id", () => {
    expect(findRetestPrefill([{ retest: null }, { retest: projection }], candidateId)).toEqual({
      retestId: candidateId,
      skillLabel: "分数加减",
      prompt: projection.prompt,
      recommendedAt: projection.recommendedAt,
    });
    expect(findRetestPrefill([{ retest: projection }], activityId)).toBeNull();
  });
});

describe("formatRetestSubmitError", () => {
  it("preserves the Chinese too-early message from the server", () => {
    const message = "补测尚未到最早可作答时间，请稍后再提交。";
    expect(formatRetestSubmitError(Object.assign(new Error(message), { code: "VALIDATION" }))).toBe(message);
    expect(formatRetestSubmitError(Object.assign(new Error("x"), { businessCode: "RETEST_SUBMIT_TOO_EARLY" }))).toBe("x");
  });

  it("falls back for unknown failures", () => {
    expect(formatRetestSubmitError(new Error("network down"))).toBe("network down");
    expect(formatRetestSubmitError("weird")).toBe("保存失败，答案仍保留在此处");
  });
});
