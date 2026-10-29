import { describe, expect, it, vi } from "vitest";
import type { SnapshotObservation } from "@aistudy/domain";
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
  it.each([
    { name: "independent pass", row: observation(), kind: "transfer_check", reason: "independent" },
    { name: "verified error", row: observation({ verifiedCorrect: "no" }), kind: "targeted_explain", reason: "verified_incorrect" },
    { name: "assisted pass", row: observation({ assistance: "revealed", independentAttempt: "no" }), kind: "reduced_help_practice", reason: "assistance_dependent" },
  ])("executes the actual next activity after $name", async ({ row, kind, reason }) => {
    const { deps, executions } = service(context({ decisionInput: { status: "observed_independent", observations: [row], wantsFullExplanation: false } }));
    const result = await prepareTutorNextAction(deps, scope, request);
    expect(executions).toEqual([expect.objectContaining({ operationId: "tutor-next:job", userTurnId: "turn",
      decision: { activityKind: kind, reasonCode: reason, focusObservationId: kind === "targeted_explain" ? "observation" : null } })]);
    expect(result).toMatchObject({ action: { activityId: "activity", sessionId: "session" }, decision: { activityKind: kind }, resumed: false });
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
