import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningTutorLearnerContextRepository, createOpeningLearningGoalRepository, createOpeningAdaptivePrefsRepository, setCourseLearningPreferences } from "@aistudy/database";
import { tutorLearnerContextInstruction } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
async function profileCourse() {
  const courseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${fixture.scope.workspaceId},'Profile course',${courseId})`;
  const repository = createOpeningTutorLearnerContextRepository(fixture.sql);
  return { courseId, repository, read: () => repository.read(fixture.scope, { courseId, sourceIds: [] }) };
}
it("reads authoritative goal revisions and preference sources into the tutor instruction on each read", async () => {
  const f = await profileCourse(), goals = createOpeningLearningGoalRepository(fixture.sql);
  const formal = await goals.create(fixture.scope, { courseIds: [f.courseId], clientKey: randomUUID(), title: "期末目标", kind: "final-exam",
    targetDate: "2027-02-01", examDate: "2027-02-02", weeklyMinutes: 90, priority: 2, learningMode: "exam", successCriteria: "独立解释" });
  await fixture.sql`UPDATE workspace_preferences SET assessment_enabled=true,retest_suggestions_enabled=true,automatic_reminders_enabled=true WHERE workspace_id=${fixture.scope.workspaceId}`;
  await setCourseLearningPreferences(fixture.sql, fixture.scope, f.courseId, { retestSuggestionsEnabled: false });
  const first = await f.read();
  expect(first?.goalPreferenceProfile).toMatchObject({ version: 1, goal: { source: "course_goals", goalId: formal.id, revision: 1, lifecycle: "active",
    definition: { targetDate: "2027-02-01", examDate: "2027-02-02", weeklyMinutes: 90, learningMode: "exam" } },
    learningPreferences: { account: { assessmentEnabled: true, retestSuggestionsEnabled: true }, course: { retestSuggestionsEnabled: false },
      effective: { assessmentEnabled: true, retestSuggestionsEnabled: false } } });
  expect(tutorLearnerContextInstruction(first)).toContain('"weeklyMinutes":90');
  await goals.update(fixture.scope, formal.id, { expectedRevision: 1, weeklyMinutes: 30, learningMode: "understand", lifecycle: "paused" });
  await setCourseLearningPreferences(fixture.sql, fixture.scope, f.courseId, { assessmentEnabled: false });
  const next = await f.read();
  expect(next?.goalPreferenceProfile).toMatchObject({ goal: { goalId: formal.id, revision: 2, lifecycle: "paused", definition: { weeklyMinutes: 30, learningMode: "understand" } },
    learningPreferences: { course: { assessmentEnabled: false }, effective: { assessmentEnabled: false, automaticRemindersEnabled: false } } });
  expect(tutorLearnerContextInstruction(next)).toContain('"weeklyMinutes":30');
  await setCourseLearningPreferences(fixture.sql, fixture.scope, f.courseId, { assessmentEnabled: true, retestSuggestionsEnabled: true });
  const restored = await f.read();
  expect(restored?.goalPreferenceProfile?.learningPreferences).toMatchObject({ course: {}, effective: { assessmentEnabled: true, retestSuggestionsEnabled: true } });
  expect(restored?.goalPreferenceProfile?.learningPreferences.course).toEqual({});
  const other = await profileCourse();
  await setCourseLearningPreferences(fixture.sql, fixture.scope, f.courseId, { assessmentEnabled: false });
  const unrelated = await other.read();
  expect(unrelated?.goalPreferenceProfile?.goal).toEqual({ source: "unknown", reason: "missing" });
  expect(unrelated?.goalPreferenceProfile?.learningPreferences).toMatchObject({ course: {}, effective: { assessmentEnabled: true } });
  await expect(f.repository.read(fixture.otherScope, { courseId: f.courseId, sourceIds: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(f.repository.read({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, { courseId: f.courseId, sourceIds: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // A persisted selection cannot import a goal that belongs to another course.
  await fixture.sql`UPDATE workspace_preferences SET adaptive_planning=${fixture.sql.json({ ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoalRefs: { [other.courseId]: formal.id } })} WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect((await other.read())?.goalPreferenceProfile?.goal).toEqual({ source: "unknown", reason: "unresolved" });
});
it("keeps missing, damaged, unresolved and explicitly cleared selections unknown", async () => {
  const f = await profileCourse();
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
  const missing = await f.read();
  expect(missing?.goalPreferenceProfile).toMatchObject({ goal: { source: "unknown", reason: "missing" }, learningPreferences: {
    account: {}, course: {}, effective: { assessmentEnabled: false, autoGradeOnSave: true },
  } });
  const prefs = createOpeningAdaptivePrefsRepository(fixture.sql);
  const saved = await prefs.patch(fixture.scope, { courseGoal: { courseId: f.courseId, goal: { targetDate: null, weeklyMinutes: 90 } } });
  await prefs.patch(fixture.scope, { courseGoal: { courseId: f.courseId, expectedRevision: saved.prefs.courseGoals[f.courseId]!.revision, goal: null } });
  expect((await f.read())?.goalPreferenceProfile?.goal).toEqual({ source: "unknown", reason: "cleared" });
  await fixture.sql`UPDATE course_goals SET lifecycle='active' WHERE course_id=${f.courseId}`;
  expect((await f.read())?.goalPreferenceProfile?.goal).toEqual({ source: "unknown", reason: "cleared" });
  await fixture.sql`UPDATE workspace_preferences SET adaptive_planning=${fixture.sql.json({ ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoalRefs: { [f.courseId]: randomUUID() } })} WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect((await f.read())?.goalPreferenceProfile?.goal).toEqual({ source: "unknown", reason: "unresolved" });
  await fixture.sql`UPDATE workspace_preferences SET adaptive_planning='{"broken":true}'::jsonb WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect((await f.read())?.goalPreferenceProfile?.goal).toEqual({ source: "unknown", reason: "invalid" });
  await fixture.sql`UPDATE workspace_preferences SET adaptive_planning=${fixture.sql.json(DEFAULT_OPENING_ADAPTIVE_PREFS)} WHERE workspace_id=${fixture.scope.workspaceId}`;
});
async function wrongAnswer(withHelp = true) {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  // Real delivered help remains usable context even when an AI verdict is uncalibrated.
  if (withHelp) await f.help(attempt);
  const original = await f.submit(attempt, { outcome: "unverified", answer: "2" });
  const graded = await createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope, { observationId: original.id }, {
    outcome: "incorrect", questionMatch: true, confidence: 0.95, feedback: "同分母相加只加分子，分母保持不变。",
    criteria: [{ label: "分母", verdict: "incorrect", feedback: "不应把分母相加。" }],
  }, "fixture");
  const repository = createOpeningTutorLearnerContextRepository(fixture.sql);
  return { ...f, original, graded, repository, read: () => repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId] }) };
}

it("provides course goal, actual help and provenance without treating AI-only mistakes as verified", async () => {
  const f = await wrongAnswer(), other = await wrongAnswer();
  await fixture.sql`UPDATE courses SET description='十天后期末，完成基础题' WHERE id=${f.courseId}`;
  const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [f.courseId]: { targetDate: "2026-10-31", weeklyMinutes: 420 } } };
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES(${fixture.scope.workspaceId},${fixture.sql.json(prefs)})
    ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning`;
  const context = await f.read();
  expect(context).toMatchObject({ courseId: f.courseId, goal: { description: "十天后期末，完成基础题", targetDate: "2026-10-31", weeklyMinutes: 420 },
    weaknesses: [{ skillLabel: "fractions", incorrect: 0, assisted: 1, samples: 1 }],
    recentMistakes: [], observationIds: [f.graded.id],
    sourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }] });
  expect(context!.observationIds).not.toContain(other.graded.id);
  expect(context!.goalPreferenceProfile?.goal).toMatchObject({ source: "legacy", revision: null, lifecycle: "unknown",
    definition: { targetDate: "2026-10-31", weeklyMinutes: 420 } });
  await expect(f.repository.assertCurrent(fixture.scope, context!)).resolves.toBeUndefined();
  expect(await f.repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [] })).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
  await expect(f.repository.read(fixture.otherScope, { courseId: f.courseId, sourceIds: [f.sourceId] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await f.repository.read(fixture.scope, { sourceIds: [] })).toBeNull();
});

it("keeps unassisted AI-only feedback without declaring a confirmed weakness", async () => {
  const f = await wrongAnswer(false);
  expect(f.graded).toMatchObject({ outcome: "incorrect", aiEvaluation: { feedback: "同分母相加只加分子，分母保持不变。" },
    eligibility: { verifiedCorrect: "unknown", independentAttempt: "yes" } });
  expect(await f.read()).toMatchObject({ weaknesses: [], recentMistakes: [], observationIds: [], sourceRefs: [] });
});

it("uses effective heads and refuses a corrected or retracted snapshot before model send", async () => {
  const f = await wrongAnswer(), context = await f.read();
  await f.learning.reviseObservation(fixture.scope, { rootObservationId: f.original.id, revisesObservationId: f.graded.id,
    expectedHead: f.graded.id, revisionKind: "replace", clientKey: randomUUID(), reason: "判错了",
    replacement: { answer: "1", outcome: "correct", assistance: "independent" } });
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.read()).toMatchObject({ weaknesses: [{ incorrect: 0, assisted: 1 }], recentMistakes: [] });
});

it("excludes unavailable and privacy-blocked evidence, including a change between reading and sending", async () => {
  const f = await wrongAnswer(), context = await f.read();
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.read()).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${f.sourceId}`;
  await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.read()).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
});

it("does not let five recent AI-only results hide an earlier delivered-help dependency", async () => {
  const f = await wrongAnswer();
  for (let index = 0; index < 5; index++) {
    const skillLabel = `strong skill ${index}`;
    const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel, sourceIds: [f.sourceId] });
    const original = await f.submit(await f.start({ sessionId: session.id }), { sessionId: session.id, skillLabel, outcome: "unverified" });
    await createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope, { observationId: original.id }, {
      outcome: "correct", questionMatch: true, confidence: 0.95, feedback: "计算正确。", criteria: [{ label: "计算", verdict: "correct", feedback: "相加得一。" }],
    }, "fixture");
  }
  expect(await f.read()).toMatchObject({ weaknesses: [{ skillLabel: "fractions", incorrect: 0, assisted: 1 }], recentMistakes: [], observationIds: [f.graded.id] });
});

it("captures all correction lineage sources and refuses unversioned, unselected or changed ancestors", async () => {
  const f = await wrongAnswer(), ancestorSource = await backupRows(fixture.sql, fixture.scope).source();
  // Models a legacy revision whose effective head narrowed attribution after consuming another material.
  await fixture.sql`UPDATE opening_learning_observations SET source_ids=${[f.sourceId, ancestorSource]},
    source_versions=${fixture.sql.json({ [f.sourceId]: 1, [ancestorSource]: 1 })} WHERE id=${f.original.id}`;
  expect(await f.read()).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
  const read = () => f.repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId, ancestorSource] });
  const context = await read();
  expect(context).toMatchObject({ recentMistakes: [], observationIds: [f.graded.id], sourceRefs: expect.arrayContaining([
    { sourceId: f.sourceId, sourceVersion: 1 }, { sourceId: ancestorSource, sourceVersion: 1 },
  ]) });
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${ancestorSource}`;
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await read()).toMatchObject({ recentMistakes: [], sourceRefs: [] });
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${ancestorSource}`;
  await fixture.sql`UPDATE opening_learning_observations SET source_versions=${fixture.sql.json({ [f.sourceId]: 1 })} WHERE id=${f.original.id}`;
  expect(await read()).toMatchObject({ recentMistakes: [], sourceRefs: [] });
  await fixture.sql`UPDATE opening_learning_observations SET source_versions=${fixture.sql.json({ [f.sourceId]: 1, [ancestorSource]: 1 })} WHERE id=${f.original.id}`;
  await backupRows(fixture.sql, fixture.scope).exclude(ancestorSource);
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await read()).toMatchObject({ recentMistakes: [], sourceRefs: [] });
});
