import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningAdaptivePrefsRepository, reviseOpeningLearningObservation } from "@aistudy/database";
import type { CourseMilestoneUpdate } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { closeRace, openRaceSession } from "./opening-race-helpers";

let f: OpeningFixture;
const goal = { targetDate: null, weeklyMinutes: 120 };
const milestone = (extra: Partial<CourseMilestoneUpdate> = {}): CourseMilestoneUpdate => ({ id: randomUUID(), title: "矩阵乘法",
  successCriteria: "隔天独立完成两道变式并说明维数。", targetDate: null, evidenceRefs: [], ...extra });
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`UPDATE workspace_preferences SET adaptive_planning=NULL WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
});
afterAll(async () => { await f?.close(); });

describe("owned course milestones", () => {
  it("persists goal policy through legacy and milestone edits with revision protection", async () => {
    const learned = await learningAttemptFixture(f), repo = createOpeningAdaptivePrefsRepository(f.sql);
    await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 0,
      goal: { ...goal, learningMode: "exam", priority: 5 } } });
    await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId,
      goal: { ...goal, weeklyMinutes: 180 } } });
    const value = milestone();
    await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 2,
      goal: { ...goal, weeklyMinutes: 180, milestones: [value] } } });
    expect((await repo.get(f.scope)).prefs.courseGoals[learned.courseId]).toMatchObject({
      revision: 3, learningMode: "exam", priority: 5, weeklyMinutes: 180, milestones: [{ id: value.id }],
    });
    expect((await repo.get(f.otherScope)).prefs.courseGoals).toEqual({});
    await expect(repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 2,
      goal: { ...goal, learningMode: "understand", priority: 1 } } })).rejects.toMatchObject({ code: "CONFLICT" });
    await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 3,
      goal: { ...goal, learningMode: "auto", priority: 0 } } });
    expect((await repo.get(f.scope)).prefs.courseGoals[learned.courseId]).toMatchObject({
      revision: 4, learningMode: "auto", priority: 0, milestones: [{ id: value.id }],
    });
  });

  it("persists outcome standards, learner confirmation and history without changing learning facts", async () => {
    const learned = await learningAttemptFixture(f), attempt = await learned.start(), observation = await learned.submit(attempt);
    const repo = createOpeningAdaptivePrefsRepository(f.sql);
    const value = milestone({ evidenceRefs: [{ kind: "attempt", id: attempt.id }, { kind: "observation", id: observation.id }] });
    const first = await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 0, goal: { ...goal, milestones: [value] } } });
    expect(first.prefs.courseGoals[learned.courseId]).toMatchObject({ revision: 1, milestones: [{ status: "planned", revision: 1 }] });
    await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 1, goal: { ...goal, milestones: [{ ...value, confirm: true }] } } });
    const changed = await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 2, goal: { ...goal,
      milestones: [{ ...value, successCriteria: "隔一周完成新题" }] } } });
    expect(changed.prefs.courseGoals[learned.courseId]?.milestones?.[0]).toMatchObject({ status: "planned", confirmedAt: null,
      revision: 3, history: [{ status: "planned" }, { status: "confirmed_by_learner", evidenceRefs: value.evidenceRefs }] });
    const legacy = await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, goal: { ...goal, weeklyMinutes: 240 } } });
    expect(legacy.prefs.courseGoals[learned.courseId]).toMatchObject({ revision: 4, weeklyMinutes: 240,
      milestones: changed.prefs.courseGoals[learned.courseId]?.milestones });
    expect((await repo.get(f.scope)).prefs).toEqual(legacy.prefs);
    expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toEqual([{ id: observation.id }]);
    expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toEqual([{ id: attempt.id }]);
  });

  it("rejects cross-course and cross-owner evidence atomically", async () => {
    const a = await learningAttemptFixture(f), b = await learningAttemptFixture(f);
    const foreign = await learningAttemptFixture({ ...f, scope: f.otherScope });
    const wrongCourse = await b.start(), wrongOwner = await foreign.start();
    const repo = createOpeningAdaptivePrefsRepository(f.sql);
    for (const id of [wrongCourse.id, wrongOwner.id]) {
      await expect(repo.patch(f.scope, { autonomy: "manual", courseGoal: { courseId: a.courseId, expectedRevision: 0,
        goal: { ...goal, milestones: [milestone({ evidenceRefs: [{ kind: "attempt", id }] })] } } })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await repo.get(f.scope)).prefs.autonomy).toBe("copilot");
      expect((await repo.get(f.scope)).prefs.courseGoals).toEqual({});
    }
  });

  it("revalidates materials on confirmation and rejects obsolete observation heads", async () => {
    const learned = await learningAttemptFixture(f), attempt = await learned.start(), observation = await learned.submit(attempt);
    const repo = createOpeningAdaptivePrefsRepository(f.sql), value = milestone({ evidenceRefs: [{ kind: "observation", id: observation.id }] });
    await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 0, goal: { ...goal, milestones: [value] } } });
    await f.sql`INSERT INTO opening_privacy_exclusions (workspace_id,source_id) VALUES (${f.scope.workspaceId},${learned.sourceId})`;
    await expect(repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 1,
      goal: { ...goal, milestones: [{ ...value, confirm: true }] } } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repo.get(f.scope)).prefs.courseGoals[learned.courseId]?.revision).toBe(1);
    await f.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id=${f.scope.workspaceId} AND source_id=${learned.sourceId}`;
    await reviseOpeningLearningObservation(f.sql, f.scope, { rootObservationId: observation.id, revisesObservationId: observation.id,
      expectedHead: observation.id, revisionKind: "retract", reason: "重做核对", clientKey: randomUUID() });
    await expect(repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 1,
      goal: { ...goal, milestones: [milestone({ evidenceRefs: [{ kind: "observation", id: observation.id }] })] } } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never overwrites unreadable prefs through defaults", async () => {
    const raw = { autonomy: "copilot", coachBudgetMinutes: 60, courseGoals: { future: { unknown: true } } };
    await f.sql`INSERT INTO workspace_preferences (workspace_id,adaptive_planning) VALUES (${f.scope.workspaceId},${f.sql.json(raw)})
      ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning`;
    const repo = createOpeningAdaptivePrefsRepository(f.sql);
    expect((await repo.get(f.scope)).invalidStoredPrefs).toBe(true);
    await expect(repo.patch(f.scope, { autonomy: "manual" })).rejects.toMatchObject({ code: "CONFLICT" });
    const [saved] = await f.sql`SELECT adaptive_planning FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`;
    expect(saved?.adaptive_planning).toEqual(raw);
  });

  it("preserves a monotonic revision across explicit deletion and recreation", async () => {
    const learned = await learningAttemptFixture(f), repo = createOpeningAdaptivePrefsRepository(f.sql), value = milestone();
    const write = (expectedRevision: number) => repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision,
      goal: { ...goal, milestones: [value] } } });
    await write(0);
    await expect(repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, goal: null } })).rejects.toMatchObject({ code: "CONFLICT" });
    await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 1, goal: null } });
    await expect(write(1)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(write(0)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await write(2)).prefs.courseGoals[learned.courseId]?.revision).toBe(3);
    await expect(write(1)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serializes concurrent milestone edits through the workspace lock", async () => {
    const learned = await learningAttemptFixture(f), value = milestone();
    const a = await openRaceSession().ready, b = await openRaceSession().ready;
    try {
      const updates = await Promise.allSettled([a, b].map(connection => createOpeningAdaptivePrefsRepository(connection.sql).patch(f.scope,
        { courseGoal: { courseId: learned.courseId, expectedRevision: 0, goal: { ...goal, milestones: [value] } } })));
      expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const rejected = updates.find(result => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "CONFLICT" });
      expect((await createOpeningAdaptivePrefsRepository(f.sql).get(f.scope)).prefs.courseGoals[learned.courseId]?.milestones).toHaveLength(1);
    } finally { await closeRace(b.sql); await closeRace(a.sql); }
  });
});

it("rejects a new observation link if any captured source version has been privately excluded", async () => {
  const learned = await learningAttemptFixture(f), attempt = await learned.start(), observation = await learned.submit(attempt);
  const secondary = await import("./opening-backup-records-fixture").then(module => module.backupRows(f.sql, f.scope).source());
  await f.sql`UPDATE opening_learning_observations SET source_versions=${f.sql.json({ [learned.sourceId]: 1, [secondary]: 1 })} WHERE id=${observation.id}`;
  await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${secondary})`;
  await expect(createOpeningAdaptivePrefsRepository(f.sql).patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 0,
    goal: { ...goal, milestones: [milestone({ evidenceRefs: [{ kind: "observation", id: observation.id }] })] } } })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("exports a privacy-safe goal without dangling evidence, retaining the online goal and strict restore validation", async () => {
  const { readOpeningBackupRecords } = await import("@aistudy/database");
  const { validateOpeningRestore } = await import("@aistudy/domain");
  const learned = await learningAttemptFixture(f), attempt = await learned.start(), observation = await learned.submit(attempt);
  const repo = createOpeningAdaptivePrefsRepository(f.sql), value = milestone({ evidenceRefs: [{ kind: "observation", id: observation.id }, { kind: "attempt", id: attempt.id }] });
  const saved = await repo.patch(f.scope, { courseGoal: { courseId: learned.courseId, expectedRevision: 0, goal: { ...goal, milestones: [value] } } });
  const secondary = await import("./opening-backup-records-fixture").then(module => module.backupRows(f.sql, f.scope).source());
  // The session and answer still depend only on A. Only their parent activity names excluded B.
  await f.sql`UPDATE opening_teaching_activities SET source_ids=${[learned.sourceId, secondary]} WHERE id=(SELECT activity_id FROM opening_learning_sessions WHERE id=${learned.sessionId})`;
  await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${secondary})`;
  const snapshot = await readOpeningBackupRecords(f.sql, f.scope);
  expect(snapshot.tables.opening_learning_observations.some(row => row.id === observation.id)).toBe(false);
  expect(snapshot.tables.opening_learning_attempts.some(row => row.id === attempt.id)).toBe(false);
  expect(JSON.stringify(snapshot.tables.workspace_preferences)).not.toContain(observation.id);
  expect(JSON.stringify(snapshot.tables.workspace_preferences)).not.toContain(attempt.id);
  expect((await repo.get(f.scope)).prefs.courseGoals).toEqual(saved.prefs.courseGoals);
  const archive = { format: "opening-backup", version: 1, workspaceId: f.scope.workspaceId, privacyEpoch: snapshot.privacyEpoch,
    deletionJournal: snapshot.deletionJournal, memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables,
    objects: snapshot.tables.opening_sources.map(source => ({ sourceId: String(source.id), sha256: String(source.sha256),
      bytes: Number(source.bytes), archivePath: `objects/${source.id}/v${source.version}.bin` })) };
  expect(validateOpeningRestore(archive, snapshot.deletionJournal, snapshot.memoryDeletions)).toMatchObject({ allowed: true });
});
