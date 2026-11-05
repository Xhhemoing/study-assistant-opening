import { describe, expect, it } from "vitest";
import type { CourseRequirement } from "@aistudy/contracts";
import { buildDecisionInput, nextLearningStep, type CourseRouteObservation } from "@aistudy/domain";
import { courseRouteDecisionInput } from "./opening-course-route-decision-input";

const requirement: CourseRequirement = {
  id: "r", courseId: "c", stableSkillId: "skill", knowledgeNodeId: null, requirementKey: "key", title: "秩",
  position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [],
  verification: { kind: "exact", status: "ready", exerciseKeys: ["q"], rubric: null, missingReasons: [] },
  revision: 2, lifecycle: "active", origin: "confirmed", approvedAt: null,
};
const row = (id: string, overrides: Partial<CourseRouteObservation> = {}): CourseRouteObservation => ({
  id, skillLabel: "秩", requirementKey: "key", attemptedAt: "2026-10-27T00:00:00Z", problemId: id,
  usableForCurrentVersion: "yes", verifiedCorrect: "yes", independentAttempt: "yes", assistance: "independent",
  courseRequirement: { id: "r", revision: 2, stableSkillId: "skill", requirementKey: "key" }, ...overrides,
});
const decision = (rows: CourseRouteObservation[]) => nextLearningStep(courseRouteDecisionInput(requirement, rows));

describe("course route repository decision qualification", () => {
  it("不把相同key的旧修订、其他要求、缺绑定或不可用旧记录当作当前证据", () => {
    const wrongBindings = [undefined, { id: "other", revision: 2, stableSkillId: "skill", requirementKey: "key" },
      { id: "r", revision: 1, stableSkillId: "skill", requirementKey: "key" },
      { id: "r", revision: 2, stableSkillId: "old-skill", requirementKey: "key" },
      { id: "r", revision: 2, stableSkillId: "skill", requirementKey: "other" }];
    expect(decision([...wrongBindings.map((courseRequirement, i) => row(String(i), { courseRequirement })), row("stale", { usableForCurrentVersion: "no" })]))
      .toEqual({ activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null });
  });

  it("普通路线使用最新事实；显式origin保留原反馈范围，其他要求不会混入", () => {
    const old = row("origin", { verifiedCorrect: "no", attemptedAt: "2026-10-26T00:00:00Z" });
    const latest = row("latest");
    const expected = { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null };
    expect(decision([old, latest])).toEqual(expected);
    expect(decision([latest, old])).toEqual(expected);
    expect(decision([old, latest])).toEqual(nextLearningStep(buildDecisionInput({ observations: [old, latest], wantsFullExplanation: false })));
    expect(nextLearningStep(courseRouteDecisionInput(requirement, [old, latest], { origin: old }))).toEqual({ activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "origin" });
    const otherOrigin = row("other", { verifiedCorrect: "no", courseRequirement: undefined, requirementKey: "other" });
    expect(nextLearningStep(courseRouteDecisionInput(requirement, [latest, otherOrigin], { origin: otherOrigin }))).toEqual(expected);
  });

  it("只有精确共享目标绑定才进入；不要求共享行伪装成local key", () => {
    const shared = row("shared", { requirementKey: "source-key", courseRequirement: undefined,
      sharedFor: [{ linkId: "link", requirementId: "r", requirementRevision: 2, stableSkillId: "skill", sourceCourseId: "other", sourceRequirementId: "source-r" }] });
    expect(decision([shared])).toEqual({ activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null });
    expect(decision([{ ...shared, sharedFor: [{ ...shared.sharedFor![0]!, requirementRevision: 1 }] }])).toMatchObject({ reasonCode: "no_evidence" });
    const local = row("local", { verifiedCorrect: "no", attemptedAt: "2026-10-26T00:00:00Z" });
    expect(decision([shared, local])).toEqual({ activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "local" });
  });

  it("不从unknown帮助或非独立local观察借用共享成功", () => {
    const local = row("local", { assistance: "unknown", independentAttempt: "no" });
    const shared = row("shared", { attemptedAt: "2026-10-28T00:00:00Z", sharedFor: [{ linkId: "l", requirementId: "r", requirementRevision: 2, stableSkillId: "skill", sourceCourseId: "other", sourceRequirementId: "other-r" }] });
    expect(decision([shared, local])).toEqual({ activityKind: "diagnose", reasonCode: "needs_check", focusObservationId: null });
  });

  it("只把已通过调用方状态检查的bound retest作为due；普通调用不添加阶段默认值", () => {
    expect(nextLearningStep(courseRouteDecisionInput(requirement, [], { dueRetest: true }))).toEqual({ activityKind: "transfer_check", reasonCode: "due_retest", focusObservationId: null, phase: "maintain", phaseSource: "automatic" });
    expect(courseRouteDecisionInput(requirement, [], { dueRetest: false })).not.toHaveProperty("dueRetest");
    expect(decision([])).not.toHaveProperty("phase");
  });

  it("相同时间戳使用规范排序，不沿用route progress的降序ID", () => {
    expect(decision([row("z", { verifiedCorrect: "no" }), row("a")])).toEqual({ activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null });
  });
});
