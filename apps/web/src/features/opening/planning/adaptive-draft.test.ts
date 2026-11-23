import { describe, expect, it } from "vitest";
import { uuidSchema } from "@aistudy/contracts";
import type { CourseGoal, TaskItem } from "@aistudy/contracts";
import { generateAdaptiveRemedyClinic, revalidateRemedyClinic, type ClinicCandidateProbe } from "@aistudy/domain";
import { buildAdaptiveDraft, freeMinutes, suggestionTaskId, type BuildAdaptiveDraftInput } from "./adaptive-draft";

describe("adaptive draft helpers", () => {
  it("derives a stable, valid task id per workspace and suggestion key", () => {
    const key = "planner:2026-09-14:weak_skill:course:0123abcd";
    const id = suggestionTaskId("11111111-1111-4111-8111-111111111111", key);
    expect(uuidSchema.safeParse(id).success).toBe(true);
    expect(suggestionTaskId("11111111-1111-4111-8111-111111111111", key)).toBe(id);
    expect(suggestionTaskId("22222222-2222-4222-8222-222222222222", key)).not.toBe(id);
  });

  it("counts only free time as capacity", () => {
    expect(freeMinutes([
      { start: "2026-09-14T00:00:00.000Z", end: "2026-09-14T01:30:00.000Z", kind: "free" },
      { start: "2026-09-14T01:30:00.000Z", end: "2026-09-14T02:15:00.000Z", kind: "class" },
      { start: "2026-09-14T02:15:00.000Z", end: "2026-09-14T02:40:30.000Z", kind: "free" },
    ])).toBe(115);
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const examCourse = id(901), otherCourse = id(902);
const pending = (n: number, changes: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `待办 ${n}`, minutes: 30, dueAt: null, priority: 1, status: "pending", courseId: otherCourse, ...changes,
});
const draftInput = (goal: CourseGoal | null, tasks: TaskItem[] = []): BuildAdaptiveDraftInput => ({
  workspaceId: id(800), date: "2026-10-17", timeZone: "America/Los_Angeles", now: new Date("2026-10-17T14:00:00Z"),
  tasks, yesterdayAccepted: [], freeBlocks: [{ start: "2026-10-17T17:00:00Z", end: "2026-10-17T17:30:00Z", kind: "free" }],
  adaptive: { autonomy: "copilot", plannerInputRevision: "input-1", snapshot: {
    date: "2026-10-17", timeZone: "America/Los_Angeles", dueCardCount: 0, plannerHistory: [],
    courses: [{ courseId: examCourse, title: "Math I", goal, minutesThisWeek: 0, skills: [], nextSkills: ["积分"], hasUsableMaterials: true }],
  } },
  planDayOptions: preferredOrder => ({ preferredOrder, localDate: "2026-10-17", timeZone: "America/Los_Angeles", planningNow: "2026-10-17T14:00:00Z" }),
});

function clinicDraftInput(includeExtraAttempt = false) {
  const draft = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 });
  const course = draft.adaptive.snapshot.courses[0]!;
  course.nextSkills = [];
  const ruleId = "negative_sign_flip";
  const activeSourcesMap = new Map([["A", 1], ["B", 1], ["C", 1], ["probes", 1]]);
  const chapters = ["A", "A", "B", ...(includeExtraAttempt ? ["C"] : [])];
  const candidateProbes: ClinicCandidateProbe<number, string>[] = [3, 5].map(n => ({
    probeId: `p${n}`, requirementKey: "inequality", prompt: `Solve -x ≤ ${n}.`, input: n,
    correctModel: { id: "correct", label: "Correct", role: "correct", predict: input => `x ≥ ${-input}` },
    hypotheses: [{ id: ruleId, label: "Incorrect direction", role: "misconception",
      description: "Preserves the inequality direction after dividing by a negative.", predict: input => `x ≤ ${-input}` }],
    targetMisconceptionId: ruleId,
    observableKey: value => value, parseResponse: raw => typeof raw === "string" ? raw : null,
    sourceRefs: [{ sourceId: "probes", sourceVersion: 1 }],
  }));
  const clinic = generateAdaptiveRemedyClinic({
    learnerId: draft.workspaceId, courseId: course.courseId, ruleId, currentPrivacyEpoch: 4, activeSourcesMap, candidateProbes,
    verifyRuleViolation: attempt => attempt.excerpt === "x ≤ -3",
    attempts: chapters.map((chapterId, i) => ({
      attemptId: id(i + 10), rootAttemptId: id(i + 10), learnerId: draft.workspaceId, courseId: course.courseId, ruleId, chapterId,
      localDate: i === 2 ? "2026-10-17" : "2026-10-16", excerpt: "x ≤ -3", invariantSummary: "除以负数时不等号反向。",
      privacyEpoch: 4, assisted: false, sourceRefs: [{ sourceId: chapterId, sourceVersion: 1 }],
    })),
  }, { skillLabel: "不等式", requirementKey: "inequality" });
  expect(clinic).not.toBeNull();
  return { ...draft, remedyClinics: [Object.freeze(clinic!)],
    remedyClinicValidation: { currentPrivacyEpoch: 4, activeSources: new Map(activeSourcesMap) } } satisfies BuildAdaptiveDraftInput;
}

describe("remedy clinic daily draft", () => {
  it("schedules the full clinic before an ordinary weak skill and keeps legacy draft bytes", () => {
    const input = clinicDraftInput();
    input.freeBlocks = [{ start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:00:00Z", kind: "free" }];
    input.adaptive.snapshot.courses[0]!.skills = [{
      skillLabel: "积分", status: "needs_review", lastObservedAt: null, recentAssistance: [],
    }];
    const draft = buildAdaptiveDraft(input);
    expect(draft.adaptive.suggestedTasks).toMatchObject([
      { kind: "weak_skill", minutes: 14, title: "Math I · 不等式 跨章错因诊所" },
      { kind: "weak_skill", minutes: 25, title: "Math I · 积分 巩固练习" },
    ]);
    expect(draft.blocks[0]).toMatchObject({
      taskId: draft.adaptive.suggestedTasks![0]!.id, start: "2026-10-17T17:00:00.000Z", end: "2026-10-17T17:14:00.000Z",
    });
    const legacy = draftInput(null);
    expect(JSON.stringify(buildAdaptiveDraft({ ...legacy, remedyClinics: [] }))).toBe(JSON.stringify(buildAdaptiveDraft(legacy)));
  });

  it("removes a cached clinic from the draft when live source or privacy authority changes", () => {
    const input = clinicDraftInput();
    const live = input.remedyClinicValidation!;
    expect(buildAdaptiveDraft(input).adaptive.suggestedTasks).toMatchObject([{ minutes: 14 }]);
    for (const remedyClinicValidation of [
      undefined,
      { ...live, currentPrivacyEpoch: 5 },
      { ...live, activeSources: new Map([["A", 1], ["probes", 1]]) },
      { ...live, activeSources: new Map([["A", 1], ["B", 2], ["probes", 1]]) },
    ]) {
      const draft = buildAdaptiveDraft({ ...input, remedyClinicValidation });
      expect(draft.adaptive.suggestedTasks).toEqual([]);
      expect(draft.blocks).toEqual([]);
    }
  });

  it.each(["revoked", "re-versioned"])("removes the four-attempt clinic and block when one source is %s at the same epoch", change => {
    const input = clinicDraftInput(true);
    const candidate = input.remedyClinics[0]!;
    expect(candidate.clinic.coverage.rootAttemptCount).toBe(4);
    const before = buildAdaptiveDraft(input);
    expect(before.adaptive.suggestedTasks).toMatchObject([{ minutes: 14 }]);
    expect(before.blocks).toHaveLength(1);

    const activeSources = new Map(input.remedyClinicValidation.activeSources);
    if (change === "revoked") activeSources.delete("C");
    else activeSources.set("C", 2);
    const remedyClinicValidation = { ...input.remedyClinicValidation, activeSources };
    const draft = buildAdaptiveDraft({ ...input, remedyClinicValidation });
    expect(draft.adaptive.suggestedTasks).toEqual([]);
    expect(draft.blocks).toEqual([]);

    const partiallyRevoked = revalidateRemedyClinic(candidate.clinic, activeSources, remedyClinicValidation.currentPrivacyEpoch);
    expect(partiallyRevoked).toMatchObject({
      status: "active", revocationSummary: { reason: "partial_source_revoked_still_active", strippedCaseCount: 1 },
    });
    const rebuilt = buildAdaptiveDraft({
      ...input, remedyClinicValidation, remedyClinics: [{ ...candidate, clinic: partiallyRevoked }],
    });
    expect(rebuilt.adaptive.suggestedTasks).toEqual([]);
    expect(rebuilt.blocks).toEqual([]);
  });

  it("leaves a tight exam slot free when the suggestion budget cannot fit all 14 minutes", () => {
    const input = clinicDraftInput();
    input.freeBlocks = [{ start: "2026-10-17T17:00:00Z", end: "2026-10-17T17:17:00Z", kind: "free" }];
    const draft = buildAdaptiveDraft(input);
    expect(draft.adaptive.suggestedTasks).toEqual([]);
    expect(draft.blocks).toEqual([]);
  });
});

describe("goal-aware adaptive draft integration", () => {
  it("allows an imminent goal to use the budget and keeps displaced pending work visible", () => {
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 }, [pending(1), pending(2)]);
    input.yesterdayAccepted = [{ taskId: id(1), start: "2026-10-16T17:00:00Z", end: "2026-10-16T17:30:00Z", reason: "昨天" }];
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ courseId: examCourse, minutes: 24 }]);
    expect(result.blocks.map(block => block.taskId)).toEqual([result.adaptive.suggestedTasks![0]!.id]);
    expect(result.unscheduledTaskIds).toEqual([id(1), id(2)]);
    expect(input.tasks.every(task => task.status === "pending")).toBe(true);
    expect(buildAdaptiveDraft(input).adaptive.suggestedTasks).toEqual(result.adaptive.suggestedTasks);
  });

  it("reserves real deadlines first and fits the shortened exam task into the remaining budget", () => {
    const result = buildAdaptiveDraft(draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 }, [
      pending(1, { minutes: 10, dueAt: "2026-10-17T18:00:00Z" }), pending(2),
    ]));
    expect(result.blocks[0]?.taskId).toBe(id(1));
    expect(result.adaptive.suggestedTasks).toMatchObject([{ minutes: 14 }]);
    expect(result.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0)).toBe(24);
    expect(result.unscheduledTaskIds).toContain(id(2));
  });

  it("keeps ordinary own work ahead without an active goal", () => {
    const result = buildAdaptiveDraft(draftInput(null, [pending(1)]));
    expect(result.adaptive.suggestedTasks).toEqual([]);
    expect(result.blocks.map(block => block.taskId)).toEqual([id(1)]);
  });

  it("does not charge impossible or future-deferred pending work as committed time", () => {
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 }, [
      pending(1, { minutes: 90, dueAt: "2026-10-17T18:00:00Z" }),
      pending(2, { courseId: examCourse, notBefore: "2026-10-18T17:00:00Z" }),
    ]);
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toHaveLength(1);
    expect(result.blocks).toHaveLength(1);
    expect(result.unscheduledTaskIds).toEqual([id(1)]);
  });

  it("still respects same-day suppression when a high-priority goal has spare time", () => {
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 }, [pending(1)]);
    const first = buildAdaptiveDraft(input).adaptive.suggestedTasks![0]!;
    input.adaptive.snapshot.plannerHistory = [{ date: input.date, identity: first.key.replace(`planner:${input.date}:`, ""), status: "done" }];
    expect(buildAdaptiveDraft(input).adaptive.suggestedTasks).toEqual([]);
  });

  it("uses time remaining after a late page open and the confirmation buffer", () => {
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.now = new Date("2026-10-17T17:40:00Z");
    input.freeBlocks = [{ start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:00:00Z", kind: "free" }];
    input.planDayOptions = preferredOrder => ({ preferredOrder, planningNow: input.now.toISOString(), localDate: input.date, timeZone: input.timeZone });
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ minutes: 15 }]);
    expect(result.blocks).toMatchObject([{ start: "2026-10-17T17:41:00.000Z", end: "2026-10-17T17:56:00.000Z" }]);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("deduplicates overlapping free time and fits an exam block around fixed exclusions", () => {
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.freeBlocks = [
      { start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:00:00Z", kind: "free" },
      { start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:00:00Z", kind: "free" },
      { start: "2026-10-17T17:12:00Z", end: "2026-10-17T17:48:00Z", kind: "class" },
    ];
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ minutes: 12 }]);
    expect(result.blocks).toMatchObject([{ start: "2026-10-17T17:00:00.000Z", end: "2026-10-17T17:12:00.000Z" }]);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("accounts for prior suggestions when consuming fragmented continuous slots", () => {
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.freeBlocks = [25, 10, 10].map((minutes, index) => ({
      start: `2026-10-17T${17 + index}:00:00Z`, end: `2026-10-17T${17 + index}:${minutes}:00Z`, kind: "free",
    }));
    input.adaptive.snapshot.courses = [{ ...input.adaptive.snapshot.courses[0]!, nextSkills: [], skills: ["a", "b", "c"].map(skillLabel => ({
      skillLabel, status: "needs_review", lastObservedAt: null, recentAssistance: [],
    })) }];
    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks?.map(task => task.minutes)).toEqual([25, 10]);
    expect(result.blocks).toHaveLength(2);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("does not propose an indivisible study block when every free fragment is below ten minutes", () => {
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 });
    input.freeBlocks = [0, 1, 2].map(index => ({
      start: `2026-10-17T${17 + index}:00:00Z`, end: `2026-10-17T${17 + index}:09:00Z`, kind: "free",
    }));
    expect(buildAdaptiveDraft(input).adaptive.suggestedTasks).toEqual([]);
  });

  it("preserves carryOverTaskIds across resourcesBeforeSuggestion slicing in a split window", () => {
    // 82 min single window split by a 10 min pinned deadline into 48 min + 24 min.
    // Preserving carryOverTaskIds lets the 24 min carry-over take the shorter 24 min gap
    // inside the budget probe, leaving 48 min continuous for a full 25 min suggestion.
    const pinned = pending(1, {
      minutes: 10,
      notBefore: "2026-10-17T17:48:00Z",
      dueAt: "2026-10-17T17:58:00Z",
    });
    const carry = pending(2, { minutes: 24, courseId: examCourse });
    const input = draftInput({ kind: "custom", targetDate: "2026-10-20", weeklyMinutes: 0 }, [pinned, carry]);
    input.yesterdayAccepted = [{
      taskId: carry.id,
      start: "2026-10-16T17:00:00Z",
      end: "2026-10-16T17:24:00Z",
      reason: "昨天",
    }];
    input.freeBlocks = [{ start: "2026-10-17T17:00:00Z", end: "2026-10-17T18:22:00Z", kind: "free" }];

    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ courseId: examCourse, minutes: 25 }]);
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [result.adaptive.suggestedTasks![0]!.id, "2026-10-17T17:00:00.000Z", "2026-10-17T17:25:00.000Z"],
      [pinned.id, "2026-10-17T17:48:00.000Z", "2026-10-17T17:58:00.000Z"],
      [carry.id, "2026-10-17T17:58:00.000Z", "2026-10-17T18:22:00.000Z"],
    ]);
  });

  it("preserves empty carryOverTaskIds across resourcesBeforeSuggestion slicing so probe and final plan agree across multiple windows", () => {
    // Ordinary non-carry-over work (22 min) takes first fit in the 45 min window (leaving 23 min + 22 min).
    // If slicing stripped the empty carryOverTaskIds set, the probe would treat ordinary work as best-fit
    // in the 22 min window and propose a 25 min suggestion that cannot fit in the final plan.
    const ordinary = pending(1, { minutes: 22, courseId: examCourse });
    const input = draftInput({ kind: "final-exam", targetDate: "2026-10-20", weeklyMinutes: 0 }, [ordinary]);
    input.freeBlocks = [
      { start: "2026-10-17T17:00:00Z", end: "2026-10-17T17:45:00Z", kind: "free" },
      { start: "2026-10-17T18:00:00Z", end: "2026-10-17T18:22:00Z", kind: "free" },
    ];

    const result = buildAdaptiveDraft(input);
    expect(result.adaptive.suggestedTasks).toMatchObject([{ courseId: examCourse, minutes: 23 }]);
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [ordinary.id, "2026-10-17T17:00:00.000Z", "2026-10-17T17:22:00.000Z"],
      [result.adaptive.suggestedTasks![0]!.id, "2026-10-17T17:22:00.000Z", "2026-10-17T17:45:00.000Z"],
    ]);
  });

  it("ranks an end-of-local-day deadline ahead of undated carry-over in adaptive drafts", () => {
    const carry = pending(1, { priority: 5 });
    const endOfDayDeadline = pending(2, { priority: 1, dueAt: "2026-10-18T07:00:00.000Z" });
    const input = draftInput(null, [carry, endOfDayDeadline]);
    input.yesterdayAccepted = [{
      taskId: carry.id,
      start: "2026-10-16T17:00:00Z",
      end: "2026-10-16T17:30:00Z",
      reason: "昨天",
    }];
    input.freeBlocks = [{ start: "2026-10-18T06:30:00.000Z", end: "2026-10-18T07:00:00.000Z", kind: "free" }];

    const result = buildAdaptiveDraft(input);
    expect(result.blocks.map(block => block.taskId)).toEqual([endOfDayDeadline.id]);
    expect(result.unscheduledTaskIds).toEqual([carry.id]);
  });
});
