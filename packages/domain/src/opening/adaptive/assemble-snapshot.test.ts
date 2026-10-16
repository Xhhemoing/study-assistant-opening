import { describe, expect, it } from "vitest";
import { assembleLearnerSnapshot } from "./assemble-snapshot";
import { proposeAdaptiveTasks } from "./propose-tasks";
import type { LearnerSnapshotSources, SnapshotCourseSource, SnapshotObservation, SnapshotSkillSummary, SnapshotTaskRow } from "./snapshot-sources";
import { suggestionIdentity, suggestionKey, type LearnerSnapshot } from "./types";

const courseId = "00000000-0000-4000-8000-000000000001";
const course = (overrides: Partial<SnapshotCourseSource> = {}): SnapshotCourseSource => ({
  courseId, title: "高等数学", goal: null, hasUsableMaterials: true, evidenceStatus: "available",
  summaries: [], observations: [], knowledgeNodes: [], ...overrides,
});
const sources = (overrides: Partial<LearnerSnapshotSources> = {}): LearnerSnapshotSources => ({
  date: "2026-10-21", timeZone: "America/Los_Angeles", courses: [], tasks: [], dueCardCount: 0, ...overrides,
});
const summary = (overrides: Partial<SnapshotSkillSummary> = {}): SnapshotSkillSummary => ({
  skillLabel: "极限", status: "needs_check", lastObservedAt: null, ...overrides,
});
const observation = (overrides: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id: "attempt-1", skillLabel: "极限", attemptedAt: "2026-10-21T10:00:00Z",
  assistance: "independent", usableForCurrentVersion: "yes", verifiedCorrect: "yes", independentAttempt: "yes", problemId: "problem-1", ...overrides,
});
const task = (overrides: Partial<SnapshotTaskRow> = {}): SnapshotTaskRow => ({
  clientKey: null, status: "done", minutes: 25, courseId, closedLocalDate: "2026-10-21", ...overrides,
});
const skillFor = (overrides: Partial<SnapshotCourseSource>) =>
  assembleLearnerSnapshot(sources({ courses: [course(overrides)] })).courses[0]!.skills[0]!;
const propose = (snapshot: LearnerSnapshot) => proposeAdaptiveTasks(snapshot, {
  autonomy: "copilot", capacityMinutes: 180, committedMinutes: 0, pendingTasks: [],
  idFor: () => "00000000-0000-4000-8000-000000000002",
}).suggestions;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("assembleLearnerSnapshot", () => {
  it("keeps same-label requirements and unattributed history in separate evidence groups", () => {
    const snapshot = assembleLearnerSnapshot(sources({ courses: [course({
      summaries: [summary({ requirementKey: "calculate", status: "observed_independent" }),
        summary({ requirementKey: "prove" }), summary({ requirementKey: null })],
      observations: [observation({ requirementKey: "calculate" }),
        observation({ id: "proof-error", requirementKey: "prove", verifiedCorrect: "no" }),
        observation({ id: "legacy", requirementKey: null, assistance: "hinted" })],
      knowledgeNodes: [{ id: "limit", title: "极限", prerequisiteIds: [] },
        { id: "next", title: "连续", prerequisiteIds: ["limit"] }],
    })] }));
    expect(snapshot.courses[0]!.skills).toMatchObject([
      { requirementKey: "calculate", status: "observed_independent", recentAssistance: ["independent"] },
      { requirementKey: "prove", status: "needs_review", recentAssistance: ["independent"] },
      { requirementKey: null, status: "needs_check", recentAssistance: ["hinted"] },
    ]);
    expect(snapshot.courses[0]!.nextSkills).toEqual([]);
    expect(propose(snapshot)).toMatchObject([{ skillLabel: "极限", requirementKey: "prove" }]);
  });

  it.each(["no", "unknown", undefined] as const)("does not act on stale errors or help when current eligibility is %s", (usableForCurrentVersion) => {
    const snapshot = assembleLearnerSnapshot(sources({ courses: [course({
      summaries: [summary()], observations: [
        observation({ usableForCurrentVersion, verifiedCorrect: "no", assistance: "revealed" }),
        observation({ id: "other", usableForCurrentVersion, assistance: "hinted" }),
      ],
    })] }));
    expect(snapshot.courses[0]!.skills[0]).toMatchObject({ status: "needs_check", recentAssistance: [] });
    expect(propose(snapshot)).toEqual([]);
  });

  it.each([
    { statuses: ["observed_independent", "needs_review", "needs_check"], expected: "needs_review" },
    { statuses: ["observed_independent", "observed_independent"], expected: "observed_independent" },
    { statuses: ["observed_independent", "needs_check"], expected: "needs_check" },
    { statuses: ["observed_independent", "unobserved"], expected: "needs_check" },
  ] as const)("merges requirement rows $statuses into $expected", ({ statuses, expected }) => {
    expect(skillFor({ summaries: statuses.map((status) => summary({ status })) }).status).toBe(expected);
  });

  it.each(["independent", "hinted", "revealed"] as const)("uses a latest verified error with %s assistance as negative evidence", (assistance) => {
    expect(skillFor({
      summaries: [summary({ status: "observed_independent" })],
      observations: [observation({ assistance, verifiedCorrect: "no", independentAttempt: assistance === "independent" ? "yes" : "no" })],
    }).status).toBe("needs_review");
  });

  it("does not turn a newer unknown into an error or let an older error override the summary", () => {
    expect(skillFor({
      summaries: [summary({ status: "observed_independent" })],
      observations: [
        observation({ id: "old-error", attemptedAt: "2026-10-20T10:00:00Z", verifiedCorrect: "no" }),
        observation({ id: "new-unknown", verifiedCorrect: "unknown" }),
      ],
    }).status).toBe("observed_independent");
    expect(skillFor({
      summaries: [summary({ status: "needs_review" })], observations: [observation()],
    }).status).toBe("needs_review");
  });

  it("keeps observation-only skills at needs_check unless their latest result is a verified error", () => {
    expect(skillFor({ observations: [observation()] })).toMatchObject({ status: "needs_check", lastObservedAt: null });
    expect(skillFor({ observations: [observation({ verifiedCorrect: "no" })] }).status).toBe("needs_review");
  });

  it("takes the latest summary timestamp and leaves all-null timestamps null", () => {
    expect(skillFor({ summaries: [
      summary({ lastObservedAt: "2026-10-21T04:00:00Z" }),
      summary(),
      summary({ lastObservedAt: "2026-10-20T22:30:00-07:00" }),
    ] }).lastObservedAt).toBe("2026-10-20T22:30:00-07:00");
    expect(skillFor({ summaries: [summary(), summary()], observations: [observation()] }).lastObservedAt).toBeNull();
  });

  it("uses the latest three effective heads without deduplicating attempts on the same problem", () => {
    const observations = [
      observation({ id: "fourth", attemptedAt: "2026-10-21T09:00:00Z", assistance: "unknown" }),
      observation({ id: "latest", attemptedAt: "2026-10-21T05:00:00-07:00", assistance: "revealed", verifiedCorrect: "no" }),
      observation({ id: "third", attemptedAt: "2026-10-21T10:00:00Z", assistance: "hinted" }),
      observation({ id: "second", attemptedAt: "2026-10-21T11:00:00Z", assistance: "independent" }),
    ];
    expect(skillFor({ observations })).toMatchObject({
      status: "needs_review", recentAssistance: ["revealed", "independent", "hinted"],
    });
  });

  it("uses observation ids to break equal attempt times consistently", () => {
    const observations = [
      observation({ id: "b", assistance: "hinted", verifiedCorrect: "unknown" }),
      observation({ id: "a", assistance: "independent", verifiedCorrect: "no" }),
    ];
    const skill = skillFor({ observations });
    expect(skill).toMatchObject({ status: "needs_review", recentAssistance: ["independent", "hinted"] });
    expect(skillFor({ observations: [...observations].reverse() })).toEqual(skill);
  });

  it("keeps full evidence when a skill has 25 observations and 25 requirement summaries", () => {
    const observations = Array.from({ length: 25 }, (_, index) => observation({
      id: `attempt-${index}`, attemptedAt: `2026-10-21T10:${String(index).padStart(2, "0")}:00Z`,
      assistance: index === 24 ? "revealed" : index === 23 ? "hinted" : "independent",
      verifiedCorrect: index === 24 ? "no" : "yes",
    }));
    const summaries = observations.map((row) => summary({ status: "observed_independent", lastObservedAt: row.attemptedAt }));
    expect(skillFor({ summaries, observations })).toEqual({
      skillLabel: "极限", status: "needs_review", lastObservedAt: observations[24]!.attemptedAt,
      recentAssistance: ["revealed", "hinted", "independent"],
    });
    // A requirement outside the first 20 must also participate in the merged summary.
    summaries[24] = summary({ status: "needs_review" });
    expect(skillFor({ summaries, observations: [] }).status).toBe("needs_review");
  });

  it("selects unobserved nodes with all prerequisites independently observed in outline order", () => {
    const result = assembleLearnerSnapshot(sources({ courses: [course({
      summaries: [
        summary({ skillLabel: "极限", status: "observed_independent" }),
        summary({ skillLabel: "连续", status: "needs_check" }),
      ],
      observations: [observation({ skillLabel: "积分" })],
      knowledgeNodes: [
        { id: "derivative", title: "导数", prerequisiteIds: ["limit"] },
        { id: "limit", title: "极限", prerequisiteIds: [] },
        { id: "continuity", title: "连续", prerequisiteIds: ["limit"] },
        { id: "integral", title: "积分", prerequisiteIds: [] },
        { id: "series", title: "级数", prerequisiteIds: ["limit", "continuity"] },
        { id: "orphan", title: "未知先修", prerequisiteIds: ["missing"] },
        { id: "intro", title: "概述", prerequisiteIds: [] },
      ],
    })] }));
    expect(result.courses[0]!.nextSkills).toEqual(["导数", "概述"]);
  });

  it("keeps exact skill labels and does not offer nodes without usable materials", () => {
    const result = assembleLearnerSnapshot(sources({ courses: [course({
      hasUsableMaterials: false,
      summaries: [summary({ skillLabel: "Limit" }), summary({ skillLabel: " limit " })],
      knowledgeNodes: [{ id: "new", title: "导数", prerequisiteIds: [] }],
    })] }));
    expect(result.courses[0]!.skills.map((skill) => skill.skillLabel)).toEqual(["Limit", " limit "]);
    expect(result.courses[0]!.nextSkills).toEqual([]);
  });

  it.each(["not_configured", "unavailable"] as const)("keeps course metadata and effort when evidence is %s", (evidenceStatus) => {
    const goal = { targetDate: "2026-11-01", weeklyMinutes: 180 };
    const result = assembleLearnerSnapshot(sources({
      courses: [course({ evidenceStatus, goal, summaries: [summary()], observations: [observation()],
        knowledgeNodes: [{ id: "new", title: "导数", prerequisiteIds: [] }] }), course({ courseId: "other", summaries: [summary()] })],
      tasks: [task()],
    }));
    expect(result.courses[0]).toEqual({ courseId, title: "高等数学", goal, hasUsableMaterials: true,
      minutesThisWeek: 25, skills: [], nextSkills: [] });
    expect(result.courses[1]!.skills).toHaveLength(1);
  });

  it("counts only done minutes attributed to each course in the Monday-to-Sunday local week", () => {
    const result = assembleLearnerSnapshot(sources({ courses: [course(), course({ courseId: "other" })], tasks: [
      task({ closedLocalDate: "2026-10-18", minutes: 80 }),
      task({ closedLocalDate: "2026-10-19", minutes: 10 }),
      task({ closedLocalDate: "2026-10-25", minutes: 20 }),
      task({ closedLocalDate: "2026-10-26", minutes: 90 }),
      task({ status: "skipped", minutes: 100 }),
      task({ status: "pending", minutes: 110 }),
      task({ closedLocalDate: null, minutes: 120 }),
      task({ courseId: null, minutes: 130 }),
      task({ courseId: "other", minutes: 40 }),
    ] }));
    expect(result.courses.map((item) => item.minutesThisWeek)).toEqual([30, 40]);
    expect(result.courses[0]!.skills).toEqual([]);
  });

  it.each([
    ["2026-11-01", "2026-10-26", "2026-11-01", "2026-10-25", "2026-11-02"],
    ["2026-11-02", "2026-11-02", "2026-11-08", "2026-11-01", "2026-11-09"],
    ["2027-01-01", "2026-12-28", "2027-01-03", "2026-12-27", "2027-01-04"],
  ])("uses calendar week boundaries for %s across DST and year changes", (date, monday, sunday, before, after) => {
    const result = assembleLearnerSnapshot(sources({ date, courses: [course()], tasks: [
      task({ closedLocalDate: monday, minutes: 10 }), task({ closedLocalDate: sunday, minutes: 20 }),
      task({ closedLocalDate: before, minutes: 40 }), task({ closedLocalDate: after, minutes: 80 }),
    ] }));
    expect(result.courses[0]!.minutesThisWeek).toBe(30);
  });

  it("retains all planner task statuses from seven days ago through today using the key date", () => {
    const identity = suggestionIdentity("weak_skill", courseId, "极限");
    const historyTask = (date: string, status: SnapshotTaskRow["status"]) => task({
      clientKey: suggestionKey(date, identity), status, closedLocalDate: null,
    });
    const result = assembleLearnerSnapshot(sources({ tasks: [
      historyTask("2026-10-13", "pending"),
      historyTask("2026-10-14", "pending"),
      historyTask("2026-10-20", "skipped"),
      historyTask("2026-10-21", "done"),
      historyTask("2026-10-21", "skipped"),
      historyTask("2026-10-21", "pending"),
      historyTask("2026-10-22", "done"),
      task({ clientKey: "manual:2026-10-21:example" }), task(),
    ] }));
    expect(result.plannerHistory).toEqual([
      { date: "2026-10-14", identity, status: "pending" },
      { date: "2026-10-20", identity, status: "skipped" },
      { date: "2026-10-21", identity, status: "done" },
      { date: "2026-10-21", identity, status: "skipped" },
      { date: "2026-10-21", identity, status: "pending" },
    ]);
  });

  it("turns an independently verified error into a weak_skill suggestion", () => {
    const snapshot = assembleLearnerSnapshot(sources({ courses: [course({
      summaries: [summary()], observations: [observation({ verifiedCorrect: "no" })],
    })] }));
    expect(snapshot.courses[0]!.skills[0]!.status).toBe("needs_review");
    expect(propose(snapshot)).toMatchObject([{ kind: "weak_skill", courseId, skillLabel: "极限" }]);
  });

  it("does not infer weak skills solely from unverified independent answers", () => {
    const snapshot = assembleLearnerSnapshot(sources({ courses: [course({ summaries: [summary()], observations: [
      observation({ id: "one", verifiedCorrect: "unknown", independentAttempt: "unknown" }),
      observation({ id: "two", verifiedCorrect: "unknown", independentAttempt: "unknown" }),
    ] })] }));
    expect(snapshot.courses[0]!.skills[0]!.status).toBe("needs_check");
    expect(propose(snapshot)).toEqual([]);
  });

  it("preserves date, zone and due cards and leaves every input unchanged on repeat calls", () => {
    const input = freeze(sources({ dueCardCount: 12, courses: [course({
      summaries: [summary()], observations: [
        observation({ id: "old", attemptedAt: "2026-10-20T10:00:00Z" }), observation({ id: "new" }),
      ],
      knowledgeNodes: [{ id: "new-node", title: "导数", prerequisiteIds: [] }],
    })], tasks: [task()] }));
    const before = structuredClone(input);
    const first = assembleLearnerSnapshot(input);
    expect(first).toMatchObject({ date: input.date, timeZone: input.timeZone, dueCardCount: 12 });
    expect(assembleLearnerSnapshot(input)).toEqual(first);
    expect(input).toEqual(before);
  });
});
