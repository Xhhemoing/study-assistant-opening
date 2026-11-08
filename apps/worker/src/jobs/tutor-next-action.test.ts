import { describe, expect, it, vi } from "vitest";
import type { SnapshotObservation } from "@aistudy/domain";
import { assembleLearningAgenda } from "@aistudy/domain";
import { prepareTutorNextAction, type TutorNextActionContext, type TutorNextActionService } from "./tutor-next-action";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const request = { courseId: "course", sourceIds: ["source"], sourceVersions: { source: 2 }, userTurnId: "turn", question: "继续学习", operationId: "tutor-next:job" };
const observation = (overrides: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id: "observation", skillLabel: "span", requirementKey: "span:linear-combination:v1", attemptedAt: "2026-10-27T00:00:00Z",
  assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes", problemId: "old-problem", ...overrides,
});
const context = (overrides: Partial<TutorNextActionContext> = {}): TutorNextActionContext => ({
  courseId: "course", privacyEpoch: 1, sourceRefs: [{ sourceId: "source", sourceVersion: 2 }],
  decisionInput: { status: "observed_independent", observations: [observation()], wantsFullExplanation: false }, ...overrides,
});
function service(read: TutorNextActionContext | null) {
  const executions: unknown[] = [];
  const deps: TutorNextActionService = {
    read: async () => read,
    assertCurrent: vi.fn(async () => {}),
    execute: async (_scope, input) => {
      executions.push(input);
      return { activityId: "activity", sessionId: "session", href: "/opening/courses/course/study/span?activity=activity" };
    },
  };
  return { deps, executions };
}

describe("tutor next action orchestration", () => {
  it("resumes the accepted activity with a fresh recommendation after normal state changes", async () => {
    const agenda = assembleLearningAgenda({ courseId: "10000000-0000-4000-8000-000000000001", status: "active", resumable: true,
      decisionCurrent: false, invalidationReasons: ["state_changed"] });
    const resume = { activityId: "old", sessionId: "session", href: "/old" };
    const { deps, executions } = service(context({ agenda, resume, historicalDecision: { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null } }));
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ action: resume, resumed: true, decision: { activityKind: "transfer_check" } });
    expect(executions).toEqual([]);
  });
  const historicalContext = (operationId = request.operationId): TutorNextActionContext => {
    const base = context({ resume: { activityId: "saved-v3", sessionId: "session", href: "/saved-v3" },
      agenda: assembleLearningAgenda({ courseId: "10000000-0000-4000-8000-000000000001", status: "active", resumable: true,
        decisionCurrent: false, invalidationReasons: ["policy_changed"] }),
      historicalDecision: { activityKind: "reduced_help_practice", reasonCode: "assisted_success", focusObservationId: null } as never });
    return { ...base, spanContext: { courseId: base.courseId, grantRevision: 1, privacyEpoch: base.privacyEpoch,
      sourceRefs: base.sourceRefs, sourceIds: ["source"], sourceVersions: { source: 2 }, decisionInput: base.decisionInput,
      intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" },
      resumeSession: null, dueRetestId: null, historicalOperationId: operationId } };
  };
  it("replays the exact historical operation decision without marking its policy current", async () => {
    const saved = historicalContext(), { deps, executions } = service(saved);
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ action: saved.resume, resumed: true,
      decision: saved.historicalDecision, context: { agenda: { decisionCurrent: false, invalidationReasons: ["policy_changed"] } } });
    expect(deps.assertCurrent).toHaveBeenCalledWith(scope, saved);
    expect(executions).toEqual([]);
  });
  it("replays an exact v2 operation rather than replacing it with the restored v3 suggestion", async () => {
    const saved = historicalContext();
    saved.historicalDecision = { activityKind: "diagnose", reasonCode: "needs_check", focusObservationId: null };
    saved.decisionInput = { observations: [observation({ assistance: "hinted", independentAttempt: "no" }), observation({ id: "prior" })], wantsFullExplanation: false };
    const { deps, executions } = service(saved);
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ resumed: true, decision: saved.historicalDecision });
    saved.spanContext!.historicalOperationId = "tutor-next:other";
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ resumed: true,
      decision: { activityKind: "reduced_help_practice", reasonCode: "assisted_success" } });
    expect(executions).toEqual([]);
  });
  it("recomputes a current suggestion for a different operation even with a saved v3 result", async () => {
    const { deps, executions } = service(historicalContext("tutor-next:other"));
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ resumed: true,
      decision: { activityKind: "transfer_check", reasonCode: "independent" } });
    expect(executions).toEqual([]);
  });
  it.each(["cancelled", "deferred", "completed"] as const)("does not replay an exact historical operation with a %s agenda", async status => {
    const saved = historicalContext();
    saved.agenda = assembleLearningAgenda({ courseId: "10000000-0000-4000-8000-000000000001", status, resumable: false });
    const { deps, executions } = service(saved);
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ action: null, resumed: false });
    expect(executions).toEqual([]);
  });
  it.each(["permission:disabled", "source_unavailable", "source_changed", "goal_changed"])("does not replay an exact historical operation with %s", reason => {
    const saved = historicalContext();
    saved.agenda = assembleLearningAgenda({ courseId: "10000000-0000-4000-8000-000000000001", status: "active", resumable: false,
      decisionCurrent: false, invalidationReasons: [reason] });
    const { deps, executions } = service(saved);
    return prepareTutorNextAction(deps, scope, request).then(result => {
      expect(result).toMatchObject({ action: null, resumed: false });
      expect(executions).toEqual([]);
    });
  });
  it("checks the privacy epoch before returning a historical operation", async () => {
    const { deps, executions } = service(historicalContext());
    await expect(prepareTutorNextAction(deps, scope, { ...request, expectedPrivacyEpoch: 0 })).rejects.toThrow();
    expect(deps.assertCurrent).not.toHaveBeenCalled();
    expect(executions).toEqual([]);
  });
  it("checks the effective origin before returning a historical operation", async () => {
    const { deps, executions } = service(historicalContext());
    vi.mocked(deps.assertCurrent).mockRejectedValueOnce(new Error("origin invalidated"));
    await expect(prepareTutorNextAction(deps, scope, request)).rejects.toThrow("origin invalidated");
    expect(executions).toEqual([]);
  });
  it("preserves an origin/material choice rather than replaying the historical operation", async () => {
    const saved = historicalContext();
    saved.unavailableAction = { message: "原材料已变化", label: "核对原记录", href: "/records" };
    const { deps, executions } = service(saved);
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ action: null, resumed: false, choice: saved.unavailableAction });
    expect(executions).toEqual([]);
  });
  it.each(["cancelled", "deferred", "completed"] as const)("never executes or claims a resume for a %s agenda", async status => {
    const agenda = assembleLearningAgenda({ courseId: "10000000-0000-4000-8000-000000000001", status, resumable: false });
    const { deps, executions } = service(context({ agenda, resume: { activityId: "old", sessionId: "session", href: "/old" } }));
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ action: null, resumed: false, choice: { label: "核对原学习记录" } });
    expect(executions).toEqual([]);
  });
  it.each([
    { name: "independent pass", row: observation(), kind: "transfer_check", reason: "independent" },
    { name: "verified error", row: observation({ verifiedCorrect: "no" }), kind: "targeted_explain", reason: "verified_incorrect" },
    { name: "assisted pass", row: observation({ assistance: "revealed", independentAttempt: "no" }), kind: "reduced_help_practice", reason: "assisted_success" },
  ])("executes the actual next activity after $name", async ({ row, kind, reason }) => {
    const { deps, executions } = service(context({ decisionInput: { status: "observed_independent", observations: [row], wantsFullExplanation: false } }));
    const result = await prepareTutorNextAction(deps, scope, request);
    expect(executions).toEqual([expect.objectContaining({ operationId: "tutor-next:job", userTurnId: "turn",
      decision: { activityKind: kind, reasonCode: reason, focusObservationId: kind === "targeted_explain" ? "observation" : null } })]);
    expect(result).toMatchObject({ action: { activityId: "activity", sessionId: "session" }, decision: { activityKind: kind }, resumed: false });
  });

  it.each([0, 1, 2])("shares the restored v3 assisted-success decision with agenda after %i earlier independent successes", async priorChecks => {
    for (const assistance of ["hinted", "revealed"] as const) {
      const observations = [observation({ assistance, independentAttempt: "no" }),
        ...Array.from({ length: priorChecks }, (_, i) => observation({ id: `prior-${i}`, attemptedAt: `2026-10-${24 + i}T00:00:00Z` }))];
      const decision = { activityKind: "reduced_help_practice" as const, reasonCode: "assisted_success" as const, focusObservationId: null };
      const agenda = assembleLearningAgenda({ courseId: "10000000-0000-4000-8000-000000000001", suggestion: decision });
      const { deps, executions } = service(context({ decisionInput: { status: "needs_check", observations, wantsFullExplanation: false } }));
      const prepared = await prepareTutorNextAction(deps, scope, request);
      expect(prepared?.decision).toEqual(agenda.suggestion);
      expect(executions).toEqual([expect.objectContaining({ decision })]);
    }
  });

  it("resumes an unfinished activity without replacing it after an earlier error", async () => {
    const resume = { activityId: "unfinished", sessionId: "existing-session", href: "/opening/courses/course/study/span?activity=unfinished" };
    const { deps, executions } = service(context({ resume }));
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ action: resume, resumed: true, decision: null });
    expect(executions).toEqual([]);
  });

  it("leaves ineligible courses on their existing conversation path", async () => {
    const { deps, executions } = service(null);
    expect(await prepareTutorNextAction(deps, scope, request)).toBeNull();
    expect(executions).toEqual([]);
  });

  it("does not start an activity when the read context became invalid", async () => {
    const { deps, executions } = service(context());
    deps.assertCurrent = async () => { throw new Error("authorization changed"); };
    await expect(prepareTutorNextAction(deps, scope, request)).rejects.toThrow("authorization changed");
    expect(executions).toEqual([]);
  });
  it("offers an ordinary-practice choice instead of creating an unusable reserved activity", async () => {
    const unavailableAction = { message: "题族已用完，普通练习不标作未见检查。", label: "继续普通练习", href: "/opening/courses/course/study/span?move=self-independent" };
    const { deps, executions } = service(context({ unavailableAction }));
    expect(await prepareTutorNextAction(deps, scope, request)).toMatchObject({ action: null, choice: unavailableAction });
    expect(executions).toEqual([]);
  });
  it("executes a reserved resume that still needs its actual attempt allocated", async () => {
    const { deps, executions } = service(context({ resume: { activityId: "old", sessionId: "old-session", href: "/existing" }, resumeRequiresExecution: true }));
    await prepareTutorNextAction(deps, scope, request);
    expect(executions).toHaveLength(1);
  });
});
