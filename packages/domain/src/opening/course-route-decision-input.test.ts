import { describe, expect, it } from "vitest";
import { courseRouteLearningDecision } from "./course-route";
import { buildDecisionInput } from "./adaptive/decision-input";
import { nextLearningStep } from "./adaptive/next-learning-step";
import type { SnapshotObservation } from "./adaptive/snapshot-sources";
import { recommendTutorAction } from "./tutor-policy";

const observation = (id: string, changes: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id, skillLabel: "秩", requirementKey: null, attemptedAt: "2026-10-27T00:00:00Z", problemId: id,
  assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes", ...changes,
});

describe("course route canonical decision input", () => {
  it.each([
    { name: "空旧记录", observations: [], expected: { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null } },
    { name: "全部不可用", observations: [observation("stale", { usableForCurrentVersion: "no" })], expected: { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null } },
    { name: "最新有效记录而不是陈旧首行决定独立状态", observations: [observation("stale", { usableForCurrentVersion: "no", independentAttempt: "no" }), observation("current")], expected: { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null } },
    { name: "旧成功不会掩盖最新非独立成功", observations: [observation("old", { attemptedAt: "2026-10-26T00:00:00Z" }), observation("new", { independentAttempt: "no", assistance: "unknown" })], expected: { activityKind: "diagnose", reasonCode: "needs_check", focusObservationId: null } },
    { name: "未知独立资格不升级", observations: [observation("unknown", { independentAttempt: "unknown", assistance: "unknown" })], expected: { activityKind: "transfer_check", reasonCode: "correct_needs_independent_check", focusObservationId: null } },
    { name: "未知核验不升级", observations: [observation("unknown", { verifiedCorrect: "unknown" })], expected: { activityKind: "diagnose", reasonCode: "unverified_only", focusObservationId: null } },
    { name: "相同时间戳按规范ID顺序", observations: [observation("z", { verifiedCorrect: "no" }), observation("a")], expected: { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null } },
    { name: "较新判对消解更早受助错误", observations: [observation("old", { verifiedCorrect: "no", assistance: "hinted", attemptedAt: "2026-10-26T00:00:00Z" }), observation("new")], expected: { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null } },
  ])("$name，与agenda/span使用的规范输入一致", ({ observations, expected }) => {
    expect(courseRouteLearningDecision(observations)).toEqual(expected);
    expect(courseRouteLearningDecision(observations)).toEqual(nextLearningStep(buildDecisionInput({ observations, wantsFullExplanation: false })));
    expect(courseRouteLearningDecision([...observations].reverse())).toEqual(expected);
  });

  it("不修改调用者的观察顺序", () => {
    const rows = [observation("z"), observation("a")];
    courseRouteLearningDecision(rows);
    expect(rows.map(row => row.id)).toEqual(["z", "a"]);
  });
});

describe("不可无损迁移的legacy输入保持旧行为（待产品决定）", () => {
  it.each([
    { hasAssistance: false, hasCheckedIndependent: false, retestDue: false, expected: "clarify" },
    { hasAssistance: true, hasCheckedIndependent: false, retestDue: false, expected: "independent_variant" },
    { hasAssistance: false, hasCheckedIndependent: true, retestDue: false, expected: "independent_variant" },
    { hasAssistance: true, hasCheckedIndependent: true, retestDue: true, expected: "delayed_retest" },
  ])("adaptive只保留汇总语义：$expected", ({ expected, ...flags }) => {
    expect(recommendTutorAction({ nodeId: "node", ...flags })).toBe(expected);
  });

  it.each([
    { sessionExposures: [] as ("hinted" | "revealed")[], currentPage: null, expected: "clarify" },
    { sessionExposures: [] as ("hinted" | "revealed")[], currentPage: 1, expected: "guided" },
    { sessionExposures: ["hinted"] as const, currentPage: 1, expected: "worked_example" },
    { sessionExposures: ["revealed", "hinted"] as const, currentPage: null, expected: "independent_variant" },
  ])("thin的页面和暴露历史不是资格观察：$expected", ({ expected, ...state }) => {
    expect(recommendTutorAction({ skillLabel: " 秩 ", sourceIds: [], assistedSuccessOnCurrentItem: false, retestDue: false, ...state })).toMatchObject({ kind: expected, skillLabel: "秩" });
  });

  it("保留到期优先、变式身份与必要输入校验", () => {
    const input = { skillLabel: "秩", sourceIds: [], currentPage: 1, sessionExposures: ["hinted"] as const, assistedSuccessOnCurrentItem: true, retestDue: false, problemRef: "q:variant", evidenceIds: ["evidence"] };
    expect(recommendTutorAction(input)).toMatchObject({ kind: "independent_variant", problemRef: "q:variant-2", evidenceIds: ["evidence"] });
    expect(recommendTutorAction({ ...input, retestDue: true })).toMatchObject({ kind: "delayed_retest", problemRef: "q:variant" });
    expect(() => recommendTutorAction({ ...input, skillLabel: " " })).toThrow("skillLabel is required");
    expect(() => recommendTutorAction({ nodeId: " ", hasAssistance: false, hasCheckedIndependent: false, retestDue: true })).toThrow("nodeId is required");
  });
});
