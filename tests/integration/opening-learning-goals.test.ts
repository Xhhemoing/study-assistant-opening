import { validateOpeningRestore } from "@aistudy/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningAdaptivePrefsRepository, createOpeningLearningGoalRepository, assertLearningGoalAction, readOpeningBackupRecords, executeOpeningRestoreApply } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

it("writes a legacy course goal into the formal authority without turning a deadline into an exam", async () => {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Full course',${courseId})`;
  const repo = createOpeningAdaptivePrefsRepository(f.sql);
  const input = { targetDate: "2027-02-01", weeklyMinutes: 120 };
  await repo.patch(f.scope, { courseGoal: { courseId, goal: input } });
  const formal = await f.sql`SELECT id,exam_date FROM course_goals WHERE workspace_id=${f.scope.workspaceId} AND course_id=${courseId}`;
  expect(formal).toHaveLength(1);
  expect(formal[0]!.exam_date).toBeNull();
  expect((await repo.get(f.scope)).prefs.courseGoals[courseId]).toMatchObject(input);
  const [stored] = await f.sql`SELECT adaptive_planning FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`;
  expect(stored!.adaptive_planning.courseGoals[courseId]).toBeUndefined();
  expect(stored!.adaptive_planning.courseGoalRefs[courseId]).toBe(formal[0]!.id);
});


async function newCourse(other = false) {
  const id = randomUUID(), scope = other ? f.otherScope : f.scope;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${scope.workspaceId},'Goal test',${id})`;
  return id;
}
const definition = (courseIds: string[]) => ({ courseIds, clientKey: randomUUID(), title: "长期理解", kind: "custom" as const,
  targetDate: "2027-02-01", examDate: null, weeklyMinutes: 80, priority: 1, learningMode: "auto" as const, successCriteria: "能独立解释并迁移" });
it("supports distinct goals of the same kind, cross-course links and stable explicit selection", async () => {
  const a = await newCourse(), b = await newCourse(), repo = createOpeningLearningGoalRepository(f.sql);
  const first = await repo.create(f.scope, definition([a, b]));
  const second = await repo.create(f.scope, definition([a]));
  expect((await repo.list(f.scope, b)).goals.map(goal => goal.id)).toEqual([first.id]);
  expect((await repo.list(f.scope, a)).selectedGoalIds[a]).toBe(first.id);
  await repo.select(f.scope, { courseId: a, goalId: second.id, expectedRevision: 1, expectedSelectedGoalId: first.id });
  expect((await repo.list(f.scope, a)).selectedGoalIds[a]).toBe(second.id);
  await expect(repo.select(f.scope, { courseId: a, goalId: first.id, expectedRevision: 1, expectedSelectedGoalId: first.id })).rejects.toMatchObject({ code: "CONFLICT" });
});
it("replays a creation without duplicates, rejects changed intent and stale edits", async () => {
  const c = await newCourse(), repo = createOpeningLearningGoalRepository(f.sql), input = definition([c]);
  const goal = await repo.create(f.scope, input);
  expect((await repo.create(f.scope, input)).id).toBe(goal.id);
  await expect(repo.create(f.scope, { ...input, weeklyMinutes: 200 })).rejects.toMatchObject({ code: "CONFLICT" });
  await repo.update(f.scope, goal.id, { expectedRevision: 1, weeklyMinutes: 90 });
  await expect(repo.update(f.scope, goal.id, { expectedRevision: 1, weeklyMinutes: 300 })).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await createOpeningAdaptivePrefsRepository(f.sql).get(f.scope)).prefs.courseGoals[c]?.weeklyMinutes).toBe(90);
});
it("requires explicit legacy resolution and retains the old definition", async () => {
  const c = await newCourse(), repo = createOpeningLearningGoalRepository(f.sql);
  const goal = await repo.create(f.scope, definition([c]));
  await f.sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(adaptive_planning,'{courseGoalRefs}',COALESCE(adaptive_planning->'courseGoalRefs','{}') - ${c})
    || jsonb_build_object('courseGoals',COALESCE(adaptive_planning->'courseGoals','{}') || jsonb_build_object(${c}::text,jsonb_build_object('targetDate',NULL,'weeklyMinutes',77))) WHERE workspace_id=${f.scope.workspaceId}`;
  expect((await repo.list(f.scope, c)).legacyConflicts[0]?.legacyGoal.weeklyMinutes).toBe(77);
  const select = { courseId: c, goalId: goal.id, expectedRevision: 1, expectedSelectedGoalId: null };
  await expect(repo.select(f.scope, select)).rejects.toMatchObject({ code: "CONFLICT" });
  await repo.select(f.scope, { ...select, resolveLegacy: true });
  const [stored] = await f.sql`SELECT definition_history FROM course_goals WHERE id=${goal.id}`;
  expect(stored!.definition_history[0].legacyGoal.weeklyMinutes).toBe(77);
  expect((await repo.list(f.scope, c)).legacyConflicts).toEqual([]);
});
it("rejects foreign-course goals and prevents new actions after pause while preserving history", async () => {
  const foreign = await newCourse(true), c = await newCourse(), repo = createOpeningLearningGoalRepository(f.sql);
  await expect(repo.create(f.scope, definition([foreign]))).rejects.toMatchObject({ code: "NOT_FOUND" });
  const goal = await repo.create(f.scope, definition([c]));
  await expect(repo.update(f.otherScope, goal.id, { expectedRevision: 1, title: "wrong owner" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const paused = await repo.update(f.scope, goal.id, { expectedRevision: 1, lifecycle: "paused" });
  await expect(f.sql.begin(tx => assertLearningGoalAction(tx, f.scope, goal.id, paused.revision))).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await repo.list(f.scope, c)).goals[0]?.lifecycle).toBe("paused");
  const resumed = await repo.update(f.scope, goal.id, { expectedRevision: 2, lifecycle: "active" });
  expect((await f.sql.begin(tx => assertLearningGoalAction(tx, f.scope, goal.id, resumed.revision))).id).toBe(goal.id);
});
it("exports formal definitions and selection links together, rejecting a dangling restored selection", async () => {
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);
  expect(snapshot.tables.course_goals.length).toBeGreaterThan(0);
  expect(snapshot.tables.course_goal_links.length).toBeGreaterThan(0);
  const backup = { format: "opening-backup", version: 1, workspaceId: f.scope.workspaceId,
    privacyEpoch: snapshot.privacyEpoch, deletionJournal: snapshot.deletionJournal, memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] };
  expect(validateOpeningRestore(backup, snapshot.deletionJournal, snapshot.memoryDeletions).errors).toEqual([]);
  expect(validateOpeningRestore({ ...backup, tables: { ...backup.tables, course_goals: [] } }, snapshot.deletionJournal, snapshot.memoryDeletions).allowed).toBe(false);
  await f.sql`DELETE FROM courses WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}`;
  const restored = await executeOpeningRestoreApply(f.sql, { confirmLocalRestore: true, backup,
    currentDeletionJournal: [], currentMemoryDeletions: snapshot.memoryDeletions,
    currentLearningState: { workspacePreferences: null, courses: [] } });
  expect(restored).toMatchObject({ ok: true });
  const after = await createOpeningLearningGoalRepository(f.sql).list(f.scope);
  expect(after.goals).toHaveLength(snapshot.tables.course_goals.length);
  expect(after.goals.every(goal => goal.lifecycle === "paused")).toBe(true);
  expect(Object.keys(after.selectedGoalIds).length).toBeGreaterThan(0);
});



it("keeps another active linked course usable after one course is archived", async () => {
  const a = await newCourse(), b = await newCourse(), repo = createOpeningLearningGoalRepository(f.sql);
  const goal = await repo.create(f.scope, definition([a, b]));
  await f.sql`UPDATE courses SET archived_at=now() WHERE id=${b}`;
  const changed = await repo.update(f.scope, goal.id, { expectedRevision: 1, weeklyMinutes: 70 });
  expect((await f.sql.begin(tx => assertLearningGoalAction(tx, f.scope, goal.id, changed.revision))).courseIds).toContain(a);
});
it("stopping the legacy selected goal also closes its course-only automatic trial", async () => {
  const c = await newCourse(), repo = createOpeningAdaptivePrefsRepository(f.sql);
  const first = await repo.patch(f.scope, { courseGoal: { courseId: c, goal: { targetDate: null, weeklyMinutes: 90 } } });
  await repo.patch(f.scope, { spanTutorGrant: { courseId: c, enabled: true, dailyMinutes: 30, expiresOn: null, expectedRevision: 0 } });
  const result = await repo.patch(f.scope, { courseGoal: { courseId: c, expectedRevision: first.prefs.courseGoals[c]!.revision, goal: null } });
  expect(result.prefs.courseGoals[c]).toBeUndefined();
  expect(result.prefs.spanTutorGrants?.[c]).toMatchObject({ enabled: false, revision: 2 });
});
