/**
 * C1: the learner snapshot read service against real evidence, tasks and courses.
 * The assemble step (G5) is stubbed; these tests assert the sources it receives.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSnapshot, LearningAttempt, LearningObservation } from "@aistudy/contracts";
import {
  createCardRepository,
  createOpeningAdaptivePrefsRepository,
  createOpeningKnowledgeRepository,
  readOpeningCourseEvidence,
  readOpeningLearnerSnapshotBase,
} from "@aistudy/database";
import { assembleLearnerSnapshot, localDateKeyInZone, proposeAdaptiveTasks, suggestionIdentity, suggestionKey, type LearnerSnapshotSources } from "@aistudy/domain";
import {
  createLearnerSnapshotService,
  type LearnerSnapshotDeps,
} from "../../apps/web/src/features/opening/planning/learner-snapshot-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

const timeZone = "Asia/Shanghai";
let fixture: OpeningFixture;

beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  const { scope, otherScope, sql } = fixture;
  await sql`DELETE FROM opening_tasks WHERE workspace_id IN (${scope.workspaceId},${otherScope.workspaceId})`;
  await sql`UPDATE workspace_preferences SET adaptive_planning = NULL WHERE workspace_id = ${scope.workspaceId}`;
  await sql`TRUNCATE opening_learning_eligibility, opening_learning_observations, opening_help_exposures,
    opening_problem_refs, opening_learning_sessions, opening_course_knowledge, course_asset_memberships
    RESTART IDENTITY CASCADE`;
  await sql`DELETE FROM courses WHERE workspace_id IN (${scope.workspaceId},${otherScope.workspaceId})`;
});

function deps(overrides: Partial<LearnerSnapshotDeps> = {}): LearnerSnapshotDeps {
  const { sql } = fixture;
  return {
    readBase: (scope) => readOpeningLearnerSnapshotBase(sql, scope),
    readCourseEvidence: (scope, courseId) => readOpeningCourseEvidence(sql, scope, courseId),
    readAdaptivePrefs: (scope) => createOpeningAdaptivePrefsRepository(sql).get(scope),
    countDueCards: async (scope, input) => (await createCardRepository(sql).listQueue({
      workspaceId: scope.workspaceId, ownerUserId: scope.ownerUserId, mode: "auto", now: input.now, timeZone: input.timeZone,
    })).length,
    assembleSnapshot: (sources: LearnerSnapshotSources) => ({
      date: sources.date, timeZone: sources.timeZone, courses: [], dueCardCount: sources.dueCardCount, plannerHistory: [],
    }),
    ...overrides,
  };
}

const today = () => localDateKeyInZone(new Date(), timeZone);
const read = (overrides: Partial<LearnerSnapshotDeps> = {}) =>
  createLearnerSnapshotService(deps(overrides)).read(fixture.scope, { date: today(), timeZone });

type AttemptFixture = Awaited<ReturnType<typeof learningAttemptFixture>>;
function checked(f: AttemptFixture, outcome: "correct" | "incorrect", extra: Record<string, unknown> = {}) {
  return {
    outcome, verdictSource: "reference_checked", referenceSourceId: f.sourceId,
    referenceCheck: { referenceSourceId: f.sourceId, method: "Compared against the reference solution", scope: "whole_answer" },
    ...extra,
  };
}
async function submitChecked(f: AttemptFixture, outcome: "correct" | "incorrect", extra: Record<string, unknown> = {}) {
  return f.submit(await f.start(), checked(f, outcome, extra));
}
async function insertCourse(workspaceId: string, title: string): Promise<string> {
  const id = randomUUID();
  await fixture.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${id}, ${workspaceId}, ${title}, ${id})`;
  return id;
}
async function insertTask(workspaceId: string, ownerUserId: string, input: {
  clientKey?: string; status: "pending" | "done" | "skipped"; minutes?: number; courseId?: string; skillLabel?: string;
}) {
  await fixture.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, status, client_key, course_id, skill_label, origin)
    VALUES (${randomUUID()}, ${workspaceId}, ${ownerUserId}, 'task', ${input.minutes ?? 25}, ${input.status},
      ${input.clientKey ?? null}, ${input.courseId ?? null}, ${input.skillLabel ?? null}, ${input.clientKey ? "planner" : "manual"})`;
}

describe("learner snapshot read", () => {
  it("reads every effective observation with server eligibility, not a capped projection", async () => {
    const f = await learningAttemptFixture(fixture);
    for (let index = 0; index < 24; index += 1) await f.submit(await f.start());
    const wrong = await submitChecked(f, "incorrect");

    const result = await read();
    const course = result.sources.courses.find((row) => row.courseId === f.courseId)!;
    expect(course.evidenceStatus).toBe("available");
    expect(course.observations).toHaveLength(25);
    const latest = course.observations.find((row) => row.id === wrong.id)!;
    expect(latest).toMatchObject({ skillLabel: "fractions", verifiedCorrect: "no", independentAttempt: "yes", problemId: wrong.problemId });
    expect(course.observations.filter((row) => row.id !== wrong.id).every((row) => row.verifiedCorrect === "unknown")).toBe(true);
    expect(course.summaries).toEqual([expect.objectContaining({ skillLabel: "fractions", status: "needs_check" })]);
    expect(result.dataStatus).toEqual({ evidence: "available", goals: "not_configured", dueCards: "available" });
  });

  it("keeps a correct answer after help from counting as independent", async () => {
    const f = await learningAttemptFixture(fixture);
    const attempt: LearningAttempt = await f.start();
    await f.help(attempt, "hinted");
    const observation = await f.submit(attempt, checked(f, "correct", { assistance: "hinted" }));

    const course = (await read()).sources.courses.find((row) => row.courseId === f.courseId)!;
    const row = course.observations.find((item) => item.id === observation.id)!;
    expect(row.assistance).toBe("hinted");
    expect(row.verifiedCorrect).toBe("yes");
    expect(row.independentAttempt).not.toBe("yes");
  });

  it("uses only effective heads after a replacement or a retraction", async () => {
    const f = await learningAttemptFixture(fixture);
    const original: LearningObservation = await submitChecked(f, "incorrect");
    const replaced = await f.learning.reviseObservation(fixture.scope, {
      rootObservationId: original.id, expectedHead: original.id, revisesObservationId: original.id,
      reason: "Marked against the wrong key", clientKey: randomUUID(), revisionKind: "replace",
      replacement: { answer: "1", outcome: "correct", assistance: "independent" },
    });
    const retracted: LearningObservation = await f.submit(await f.start());
    await f.learning.reviseObservation(fixture.scope, {
      rootObservationId: retracted.id, expectedHead: retracted.id, revisesObservationId: retracted.id,
      reason: "Not my attempt", clientKey: randomUUID(), revisionKind: "retract",
    });

    const course = (await read()).sources.courses.find((row) => row.courseId === f.courseId)!;
    expect(course.observations.map((row) => row.id)).toEqual([replaced.headObservationId]);
  });

  it.each([["replace", "done"], ["retract", "skipped"]] as const)("preserves a legacy %s spelling's %s task after the earliest observation changes", async (change, status) => {
    const f = await learningAttemptFixture(fixture);
    const first = await submitChecked(f, "incorrect");
    const displayed = change === "retract" ? await submitChecked(f, "incorrect") : first;
    const clientKey = suggestionKey(today(), suggestionIdentity("weak_skill", f.courseId, "fractions"));
    await insertTask(fixture.scope.workspaceId, fixture.scope.ownerUserId, {
      clientKey, courseId: f.courseId, skillLabel: "fractions", status,
    });
    await f.learning.reviseObservation(fixture.scope, {
      rootObservationId: displayed.id, expectedHead: displayed.id, revisesObservationId: displayed.id,
      reason: "Normalize the displayed skill spelling", clientKey: randomUUID(), revisionKind: "replace",
      replacement: { answer: displayed.answer, outcome: displayed.outcome, assistance: displayed.assistance, skillLabel: "FRAC TIONS" },
    });
    if (change === "retract") await f.learning.reviseObservation(fixture.scope, {
      rootObservationId: first.id, expectedHead: first.id, revisesObservationId: first.id,
      reason: "Withdraw an incorrectly attributed earlier attempt", clientKey: randomUUID(), revisionKind: "retract",
    });
    const result = await read({ assembleSnapshot: assembleLearnerSnapshot });
    expect(result.sources.tasks).toContainEqual(expect.objectContaining({ clientKey, skillLabel: "fractions", status }));
    expect(result.snapshot.courses.find(row => row.courseId === f.courseId)?.skills).toMatchObject([
      { skillLabel: "FRAC TIONS", status: "needs_review" },
    ]);
    expect(proposeAdaptiveTasks(result.snapshot, {
      autonomy: "copilot", capacityMinutes: 180, committedMinutes: 0, pendingTasks: [], idFor: () => randomUUID(),
    }).suggestions).toEqual([]);
    expect((await fixture.sql`SELECT client_key FROM opening_tasks WHERE workspace_id=${fixture.scope.workspaceId}`)[0]!.client_key).toBe(clientKey);
  });

  it("reports planner tasks with their local close date and stays inside the workspace", async () => {
    const { scope, otherScope } = fixture;
    const date = today();
    await insertTask(scope.workspaceId, scope.ownerUserId, { clientKey: `planner:${date}:weak_skill:a:1`, status: "done", minutes: 30 });
    await insertTask(scope.workspaceId, scope.ownerUserId, { clientKey: `planner:${date}:new_material:a:2`, status: "skipped" });
    await insertTask(scope.workspaceId, scope.ownerUserId, { status: "pending" });
    await insertTask(otherScope.workspaceId, otherScope.ownerUserId, { clientKey: `planner:${date}:weak_skill:b:3`, status: "done" });
    const otherCourse = await insertCourse(otherScope.workspaceId, "Other workspace");

    const result = await read();
    expect(result.sources.tasks).toEqual([
      { clientKey: `planner:${date}:weak_skill:a:1`, status: "done", minutes: 30, courseId: null, closedLocalDate: date },
      { clientKey: `planner:${date}:new_material:a:2`, status: "skipped", minutes: 25, courseId: null, closedLocalDate: date },
      { clientKey: null, status: "pending", minutes: 25, courseId: null, closedLocalDate: null },
    ]);
    expect(result.sources.courses.map((row) => row.courseId)).not.toContain(otherCourse);
  });

  it("keeps other courses when one course's evidence read fails", async () => {
    const f = await learningAttemptFixture(fixture);
    await submitChecked(f, "incorrect");
    const broken = await insertCourse(fixture.scope.workspaceId, "Broken evidence");
    const onReadFailure = vi.fn();
    const result = await read({
      onReadFailure,
      readCourseEvidence: (scope, courseId) => courseId === broken
        ? Promise.reject(new Error("evidence store down"))
        : readOpeningCourseEvidence(fixture.sql, scope, courseId),
    });

    const working = result.sources.courses.find((row) => row.courseId === f.courseId)!;
    const failed = result.sources.courses.find((row) => row.courseId === broken)!;
    expect(working).toMatchObject({ evidenceStatus: "available" });
    expect(working.observations).toHaveLength(1);
    expect(failed).toMatchObject({ evidenceStatus: "unavailable", summaries: [], observations: [] });
    expect(result.dataStatus.evidence).toBe("unavailable");
    expect(onReadFailure).toHaveBeenCalledWith("evidence", expect.any(Error), broken);
  });

  it("reads materials, knowledge prerequisites and course goals", async () => {
    const f = await learningAttemptFixture(fixture);
    await fixture.sql`INSERT INTO course_asset_memberships
      (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
      VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${f.courseId}, 'source', ${f.sourceId}, 'core', 0, 'course')`;
    const bare = await insertCourse(fixture.scope.workspaceId, "No materials");
    const [chapter, first, second] = [randomUUID(), randomUUID(), randomUUID()];
    const node = (id: string, label: string, kind: "chapter" | "concept") =>
      ({ id, courseId: f.courseId, label, kind, evidenceChunkIds: [], status: "suggested" as const });
    const edge = (from: string, to: string, kind: "contains" | "prerequisite") =>
      ({ from, to, kind, evidenceChunkIds: [], status: "suggested" as const });
    const snapshot: KnowledgeSnapshot = {
      courseId: f.courseId, version: 0,
      nodes: [node(chapter, "第一章", "chapter"), node(first, "分数", "concept"), node(second, "分数加法", "concept")],
      edges: [edge(chapter, first, "contains"), edge(chapter, second, "prerequisite"), edge(first, second, "prerequisite")],
    };
    await createOpeningKnowledgeRepository(fixture.sql).replace(fixture.scope, f.courseId, { expectedVersion: 0, snapshot, sourceVersions: {} });
    await createOpeningAdaptivePrefsRepository(fixture.sql).patch(fixture.scope, {
      courseGoal: { courseId: f.courseId, goal: { targetDate: "2026-12-20", weeklyMinutes: 240 } },
    });

    const result = await read();
    const course = result.sources.courses.find((row) => row.courseId === f.courseId)!;
    expect(course).toMatchObject({ hasUsableMaterials: true, goal: { targetDate: "2026-12-20", weeklyMinutes: 240 } });
    expect(course.knowledgeNodes).toEqual([
      { id: first, title: "分数", prerequisiteIds: [] },
      { id: second, title: "分数加法", prerequisiteIds: [first] },
    ]);
    expect(result.sources.courses.find((row) => row.courseId === bare)).toMatchObject({ hasUsableMaterials: false, goal: null, knowledgeNodes: [] });
    expect(result.dataStatus.goals).toBe("available");
  });

  it("changes the history revision only when learning changes", async () => {
    const f = await learningAttemptFixture(fixture);
    await submitChecked(f, "correct");
    const first = await read();
    const again = await read();
    expect(again.plannerInputRevision).toBe(first.plannerInputRevision);
    await submitChecked(f, "incorrect");
    expect((await read()).plannerInputRevision).not.toBe(first.plannerInputRevision);
  });
});
