import { describe, expect, it } from "vitest";
import type {
  CourseRequirementProgress,
  CourseRouteSnapshot,
  CourseRouteTaskContext,
} from "@aistudy/contracts";
import {
  buildCourseExamPickerPlan,
  isDelayedRetestDue,
  resolveRetestTaskBinding,
} from "./asset-graph-exam-picker";

const COURSE_1 = "33333333-3333-4333-8333-333333333331";
const GOAL_1 = "44444444-4444-4444-8444-444444444441";
const TASK_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RETEST_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const AS_OF = "2026-11-19T12:00:00.000Z";

function makeProgress(
  index: number,
  overrides: Partial<CourseRequirementProgress> & {
    mandatory?: boolean;
    revision?: number;
  } = {},
): CourseRequirementProgress {
  const id = `55555555-5555-4555-8555-55555555550${index}`;
  const skillId = `66666666-6666-4666-8666-66666666660${index}`;
  const { mandatory = true, revision = 1, ...rest } = overrides;
  return {
    requirement: {
      id,
      courseId: COURSE_1,
      stableSkillId: skillId,
      knowledgeNodeId: null,
      requirementKey: `req:${index}`,
      title: `要求 ${index}`,
      position: index,
      mandatory,
      goalIds: [GOAL_1],
      prerequisiteIds: [],
      sourceRefs: [],
      verification: {
        kind: "manual",
        status: "ready",
        exerciseKeys: [],
        rubric: null,
        missingReasons: [],
      },
      revision,
      lifecycle: "active",
      origin: "confirmed",
      approvedAt: "2026-11-18T00:00:00.000Z",
    },
    status: "unobserved",
    observationId: null,
    missingReasons: [],
    sourcesAvailable: true,
    ...rest,
  };
}

function makeSnapshot(requirements: CourseRequirementProgress[]): CourseRouteSnapshot {
  return {
    courseId: COURSE_1,
    scopeState: "confirmed",
    requirements,
    suggestions: [],
    summary: {
      total: requirements.length,
      mandatory: requirements.filter(r => r.requirement.mandatory).length,
      verified: requirements.filter(r => r.status === "verified").length,
      blocked: requirements.filter(r => r.status === "blocked").length,
    },
    materials: [],
    currentActivity: null,
    currentRoute: null,
    observationId: null,
  };
}

describe("asset-graph-exam-picker", () => {
  it("ranks due retests first even when correction is needed and keeps waiting and blocked items separate", () => {
    const reqCorrection = makeProgress(1, { status: "needs_correction" });
    const reqVerifiedDue = makeProgress(2, {
      status: "verified",
      delayedCheck: {
        status: "pending",
        retestId: RETEST_1,
        taskId: TASK_1,
        notBeforeAt: "2026-11-19T08:00:00.000Z",
      },
    });
    const reqVerifiedFuture = makeProgress(3, {
      status: "verified",
      delayedCheck: {
        status: "pending",
        retestId: RETEST_1,
        taskId: TASK_1,
        notBeforeAt: "2026-11-22T08:00:00.000Z",
      },
    });
    const reqCorrectionDue = makeProgress(7, {
      status: "needs_correction",
      delayedCheck: reqVerifiedDue.delayedCheck,
    });
    const reqAssisted = makeProgress(4, { status: "assisted" });
    const reqUnobserved = makeProgress(5, { status: "unobserved" });
    const reqBlocked = makeProgress(6, { status: "blocked" });

    expect(isDelayedRetestDue(reqVerifiedDue, Date.parse(AS_OF))).toBe(true);
    expect(isDelayedRetestDue(reqVerifiedFuture, Date.parse(AS_OF))).toBe(false);

    const plan = buildCourseExamPickerPlan(
      makeSnapshot([
        reqBlocked,
        reqUnobserved,
        reqAssisted,
        reqVerifiedFuture,
        reqVerifiedDue,
        reqCorrection,
        reqCorrectionDue,
      ]),
      { asOf: AS_OF },
    );

    expect(plan.totalCount).toBe(7);
    expect(plan.verifiedCount).toBe(2);
    expect(plan.blockedCount).toBe(1);
    expect(plan.blockedItems.map(i => i.requirement.id)).toEqual([reqBlocked.requirement.id]);
    expect(plan.items.map(i => [i.progress.requirement.id, i.bucket])).toEqual([
      [reqVerifiedDue.requirement.id, "due_retest"],
      [reqCorrectionDue.requirement.id, "due_retest"],
      [reqCorrection.requirement.id, "needs_correction"],
      [reqVerifiedFuture.requirement.id, "pending_verification"],
      [reqAssisted.requirement.id, "pending_verification"],
      [reqUnobserved.requirement.id, "unobserved"],
    ]);
    expect(plan.items.find(item => item.progress === reqVerifiedFuture)).toMatchObject({
      pendingRetest: true, dueRetest: false, retestTaskId: null,
    });
    expect(plan.dueRetestTaskIds).toEqual([TASK_1]);
  });

  it("applies tie-breakers: unmarked in 2A round first (keeping marked visible), then mandatory, then position", () => {
    const reqMarkedMandatory = makeProgress(1, { status: "unobserved", mandatory: true, revision: 2 });
    const reqUnmarkedOptional = makeProgress(2, { status: "unobserved", mandatory: false, revision: 1 });
    const reqUnmarkedMandatoryLater = makeProgress(3, { status: "unobserved", mandatory: true, revision: 1 });

    const plan = buildCourseExamPickerPlan(
      makeSnapshot([reqMarkedMandatory, reqUnmarkedOptional, reqUnmarkedMandatoryLater]),
      {
        asOf: AS_OF,
        isPaperMarked: (id, rev) => id === reqMarkedMandatory.requirement.id && rev === 2,
      },
    );

    expect(plan.items.map(i => [i.progress.requirement.id, i.paperMarked])).toEqual([
      [reqUnmarkedMandatoryLater.requirement.id, false],
      [reqUnmarkedOptional.requirement.id, false],
      [reqMarkedMandatory.requirement.id, true],
    ]);
  });

  it("enforces strict retest task-binding invariant before allowing '开始独立复测'", () => {
    const progress = makeProgress(2, {
      revision: 4,
      delayedCheck: { status: "pending", retestId: RETEST_1, taskId: TASK_1, notBeforeAt: "2026-11-19T08:00:00.000Z" },
    });
    const bind = (context: CourseRouteTaskContext | null) =>
      resolveRetestTaskBinding(context, COURSE_1, progress, Date.parse(AS_OF));

    const validCtx: CourseRouteTaskContext = {
      managed: true,
      courseId: COURSE_1,
      taskId: TASK_1,
      retestId: RETEST_1,
      expectedTaskVersion: 3,
      goalId: GOAL_1,
      expectedGoalRevision: 2,
      requirementId: progress.requirement.id,
      expectedRequirementRevision: 4,
      minutes: 15,
      notBeforeAt: "2026-11-19T08:00:00.000Z",
      available: true,
      reason: null,
    };
    expect(bind(validCtx)).toMatchObject({
      kind: "bound_retest",
      label: "开始独立复测",
    });

    // Unavailable task -> NEVER label 独立复测
    expect(bind({ ...validCtx, available: false, reason: "复测尚未到时间" })).toMatchObject({
      kind: "unbound_retest",
    });

    for (const mismatch of [
      { courseId: GOAL_1 },
      { taskId: GOAL_1 },
      { requirementId: GOAL_1 },
      { expectedRequirementRevision: 5 },
      { retestId: GOAL_1 },
      { retestId: undefined }, // Managed maintenance task
    ]) {
      expect(bind({ ...validCtx, ...mismatch }).kind).toBe("unbound_retest");
    }
    expect(bind({ managed: false }).kind).toBe("unbound_retest");
    expect(bind(null).kind).toBe("unbound_retest");
  });
});
