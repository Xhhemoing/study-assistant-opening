import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { nextLearningStep, SPAN_SKILL_LABEL } from "@aistudy/domain";
import {
  createOpeningLearningAgendaRepository, createOpeningLearningRepository,
  createOpeningLongTermPlanningRepository, createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository, createOpeningSpanSessionRepository,
  createOpeningSpanTutorContextRepository, createWorkspacePreferencesRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

it.each(["active", "paused"] as const)("confirms a plan with a real state_changed %s span agenda and replays without duplicate learning writes", async status => {
  const { sql, scope } = f, now = new Date(), date = now.toISOString().slice(0, 10);
  const planning = createOpeningLongTermPlanningRepository(sql, () => new Date(`${date}T09:00:00Z`));
  await createOpeningPlanningSettingsRepository(sql).set(scope, {
    weekOneMonday: "2026-09-07", periodTimes: {}, dailyWindow: { start: "08:00", end: "18:00" },
    lunch: { start: "12:00", end: "13:00" }, dinner: { start: "18:00", end: "19:00" },
    sleep: { start: "23:00", end: "07:00" }, timeZone: "UTC",
  });
  await planning.command(scope, { action: "settings", dailyMinutes: 180, bufferMinutes: 0, expectedRevision: 0 });
  const rows = backupRows(sql, scope), sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Confirm agenda',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope, {
    assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false,
  });
  const at = now.toISOString(), grant = { enabled: true, dailyMinutes: 180, revision: 1, confirmedAt: at, updatedAt: at, expiresOn: null };
  await sql`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(COALESCE(adaptive_planning,${sql.json(DEFAULT_OPENING_ADAPTIVE_PREFS)}::jsonb),
    '{spanTutorGrants}',COALESCE(adaptive_planning->'spanTutorGrants','{}'::jsonb) || ${sql.json({ [courseId]: grant })}::jsonb) WHERE workspace_id=${scope.workspaceId}`;
  const tutor = createOpeningSpanTutorContextRepository(sql);
  const context = await tutor.read(scope, { courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, question: "继续学习" });
  if (!context) throw new Error("Expected real span context");
  const lesson = await tutor.execute(scope, { context, decision: nextLearningStep(context.decisionInput), operationId: randomUUID() });
  const [attempt] = await sql`SELECT * FROM opening_learning_attempts WHERE activity_id=${lesson.activityId}`;
  if (!attempt) throw new Error("Expected real span attempt");
  const observation = await createOpeningLearningRepository(sql).insertObservation(scope, {
    sessionId: lesson.sessionId, courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId],
    attemptId: String(attempt.id), problemId: String(attempt.problem_id), clientKey: randomUUID(),
    answer: JSON.stringify({ membership: "not_in_span" }), assistance: "independent", outcome: "unverified", verdictSource: "self_report",
  });
  expect(observation).toMatchObject({ outcome: "incorrect", serverEvaluation: { evaluatorVersion: "span-exact-v1" } });
  if (status === "paused") {
    const sessions = createOpeningSpanSessionRepository(sql), session = await sessions.get(scope, lesson.activityId);
    if (!session) throw new Error("Expected span session");
    await sessions.save(scope, lesson.activityId, {
      expectedRevision: session.revision, intent: session.intent, moveId: session.moveId, status: "paused",
    });
  }
  const expectedAgenda = await createOpeningLearningAgendaRepository(sql).get(scope, courseId, lesson.activityId);
  expect(expectedAgenda).toMatchObject({ activityId: lesson.activityId, resumable: true, decisionCurrent: false,
    invalidationReasons: expect.arrayContaining(["state_changed"]), suggestion: { activityKind: "targeted_explain" } });
  const task = await createOpeningPlansRepository(sql).createTask(scope, {
    courseId, title: "确认后保留原学习活动", minutes: 30, dueAt: null, priority: 1, candidateId: null,
  });
  const beforeActivities = await sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
  const beforeAttempts = await sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
  const beforeReceipts = await sql`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
  const preview = await planning.command(scope, { action: "preview", date, expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: randomUUID() });
  const draft = preview.draft;
  if (!draft) throw new Error("Expected executable plan draft");
  expect(draft.blocks.some(block => block.taskId === task.id)).toBe(true);
  const command = { action: "confirm", draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() };
  const confirmed = await planning.command(scope, command);
  expect(confirmed.draft).toMatchObject({ id: draft.id, status: "accepted" });
  expect(confirmed.overview).toMatchObject({ acceptedVersion: 1, acceptedBlocks: draft.blocks,
    recovery: { activityId: lesson.activityId, agenda: { activityId: lesson.activityId, resumable: true,
      invalidationReasons: expect.arrayContaining(["state_changed"]), suggestion: expectedAgenda?.suggestion, budget: expectedAgenda?.budget } } });
  const acceptances = await sql`SELECT * FROM opening_plan_acceptances WHERE workspace_id=${scope.workspaceId}`;
  expect(acceptances).toHaveLength(1);
  expect((await createOpeningPlansRepository(sql).getToday(scope, date))?.blocks).toEqual(draft.blocks);
  const replay = await planning.command(scope, command);
  expect(replay.draft).toEqual(confirmed.draft);
  expect(replay.overview.committedMinutes).toBe(confirmed.overview.committedMinutes);
  expect(replay.overview.recovery.agenda).toMatchObject({ activityId: lesson.activityId, suggestion: expectedAgenda?.suggestion, budget: expectedAgenda?.budget });
  expect(await sql`SELECT * FROM opening_plan_acceptances WHERE workspace_id=${scope.workspaceId}`).toEqual(acceptances);
  expect(await sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(beforeActivities);
  expect(await sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(beforeAttempts);
  expect(await sql`SELECT * FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId} ORDER BY id`).toEqual(beforeReceipts);
});
