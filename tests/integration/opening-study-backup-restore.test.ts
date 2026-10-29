import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningBudgetRepository, createOpeningLearningDecisionsRepository, createOpeningStudyExposureRepository,
  createOpeningTeachingActivitiesRepository, createOpeningStudyIntentRepository, executeOpeningRestoreApply, readOpeningBackupRecords } from "@aistudy/database";
import { validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });

it("round-trips Study release states and immutable decisions without restoring paid execution", async () => {
  const { sql, scope } = fixture;
  const activity = await createOpeningTeachingActivitiesRepository(sql).create(scope, {
    clientKey: randomUUID(), intentKind: "question", intentSummary: "Explain", createIntent: {},
  });
  const exposures = createOpeningStudyExposureRepository(sql);
  const input = { releaseKey: randomUUID(), contextAnchor: { activityId: activity.id, purpose: "learning_help" as const },
    origin: "assistant" as const, kind: "hint" as const, level: "hinted" as const, hintStage: 2 as const, initiatedBy: "user" as const };
  const generated = await exposures.generate(scope, input);
  const released = await exposures.deliver(scope, { ...input, releaseKey: randomUUID() });
  await exposures.acknowledge(scope, released.id);
  const decision = await createOpeningLearningDecisionsRepository(sql).record(scope, {
    layer: "activity", targetId: activity.id, stateVersion: "snapshot", goalVersion: "1", intentVersion: "1", policyVersion: "1",
    candidates: [{ action: "explain", eligible: true, reasonCodes: ["unobserved"], evidenceRefs: [] }], selectedAction: "explain",
    reasonCodes: ["unobserved"], evidenceRefs: [], sourceVersions: {}, dataAsOf: new Date().toISOString(), invalidationConditions: ["state_changed"],
  }, randomUUID());
  await createOpeningBudgetRepository(sql, { envCapCents: 100_000 }).reserve(scope, {
    purpose: "tutor", amountCents: 10, requestId: randomUUID(), parentBudget: { id: randomUUID(), budgetCents: 20 },
  });
  const snapshot = await readOpeningBackupRecords(sql, scope);
  expect(snapshot.tables.opening_help_exposures).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: generated.id, hint_stage: 2, initiated_by: "user", delivered: false, released_at: null, acknowledged_at: null }),
    expect.objectContaining({ id: released.id, hint_stage: 2, initiated_by: "user", delivered: true, acknowledged_at: expect.any(Date) }),
  ]));
  expect(snapshot.tables.opening_learning_decisions).toEqual([expect.objectContaining({ id: decision.id })]);
  expect(snapshot.tables).not.toHaveProperty("opening_parent_interaction_budgets");
  expect(snapshot.tables).not.toHaveProperty("opening_assistant_proposals");
  const backup = { format: "opening-backup", version: 1, workspaceId: scope.workspaceId, privacyEpoch: snapshot.privacyEpoch,
    deletionJournal: snapshot.deletionJournal, memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] } satisfies OpeningBackup;
  expect(validateOpeningRestore(backup, [], snapshot.memoryDeletions)).toMatchObject({ allowed: true });
  await sql`DELETE FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId}`;
  await sql`DELETE FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}`;
  await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`;
  await sql`DELETE FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}`;
  const jobId = randomUUID();
  await sql`INSERT INTO opening_jobs (id,workspace_id,owner_user_id,key,kind,payload,state)
    VALUES (${jobId},${scope.workspaceId},${scope.ownerUserId},${randomUUID()},'tutor','{}','queued')`;
  const result = await executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup, currentDeletionJournal: [], currentMemoryDeletions: snapshot.memoryDeletions });
  expect(result).toMatchObject({ ok: true, pendingJobsCancelled: 1 });
  expect((await sql`SELECT state FROM opening_jobs WHERE id=${jobId}`)[0]!.state).toBe("cancelled");
  const restored = await readOpeningBackupRecords(sql, scope);
  expect(restored.tables.opening_help_exposures).toEqual(snapshot.tables.opening_help_exposures);
  expect(restored.tables.opening_learning_decisions).toEqual(snapshot.tables.opening_learning_decisions);
  const legacy = structuredClone(backup);
  for (const row of legacy.tables.opening_help_exposures!) { delete row.hint_stage; delete row.initiated_by; }
  expect(validateOpeningRestore(legacy, [], snapshot.memoryDeletions)).toMatchObject({ allowed: true });
  await sql`DELETE FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId}`;
  await sql`DELETE FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}`;
  await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`;
  await sql`DELETE FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}`;
  expect(await executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup: legacy, currentDeletionJournal: [], currentMemoryDeletions: snapshot.memoryDeletions })).toMatchObject({ ok: true });
  const oldRestored = await readOpeningBackupRecords(sql, scope);
  expect(oldRestored.tables.opening_help_exposures).toEqual(legacy.tables.opening_help_exposures!.map(row => ({ ...row, hint_stage: null, initiated_by: null })));
  expect(await sql`SELECT id FROM opening_parent_interaction_budgets WHERE workspace_id=${scope.workspaceId}`).toHaveLength(1);
});

it("preserves legacy HelpExposure metadata across replay and backup without backfilling old nulls", async () => {
  const isolated = await createOpeningFixture();
  try {
    const { sql, scope } = isolated;
    const f = await learningAttemptFixture(isolated), attempt = await f.start();
    const legacy = await f.help(attempt);
    const { createdAt: _createdAt, ...input } = legacy;
    expect(legacy).toMatchObject({ hintStage: null, initiatedBy: null });
    expect(await f.learning.insertHelpExposure(scope, { ...input, hintStage: 3, initiatedBy: "user" })).toEqual(legacy);
    await sql`DELETE FROM opening_help_exposures WHERE id=${legacy.id}`;
    const saved = await f.learning.insertHelpExposure(scope, { ...input, hintStage: 3, initiatedBy: "user" });
    expect(saved).toMatchObject({ hintStage: 3, initiatedBy: "user" });
    expect(await f.learning.insertHelpExposure(scope, { ...input, hintStage: 3, initiatedBy: "user" })).toEqual(saved);
    for (const changed of [{ hintStage: 2, initiatedBy: "user" as const }, { hintStage: 3, initiatedBy: "assistant" as const }]) {
      await expect(f.learning.insertHelpExposure(scope, { ...input, ...changed })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    const snapshot = await readOpeningBackupRecords(sql, scope);
    const backup = { format: "opening-backup", version: 1, workspaceId: scope.workspaceId, privacyEpoch: snapshot.privacyEpoch,
      deletionJournal: snapshot.deletionJournal, memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] } satisfies OpeningBackup;
    expect(validateOpeningRestore(backup, [], snapshot.memoryDeletions)).toMatchObject({ allowed: true });
    await sql`DELETE FROM opening_help_exposures WHERE id=${saved.id}`;
    await sql`DELETE FROM opening_conversations WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_learning_sessions WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_source_chunks WHERE source_id=${f.sourceId}`;
    await sql`DELETE FROM opening_sources WHERE id=${f.sourceId}`;
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM courses WHERE id=${f.courseId}`;
    await sql`DELETE FROM opening_learning_item_versions WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_source_versions WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_learning_history_revisions WHERE workspace_id=${scope.workspaceId}`;
    const restored = await executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup, currentDeletionJournal: [],
      currentMemoryDeletions: snapshot.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] } });
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    expect((await readOpeningBackupRecords(sql, scope)).tables.opening_help_exposures).toEqual(snapshot.tables.opening_help_exposures);
    expect(await f.learning.insertHelpExposure(scope, { ...input, hintStage: 3, initiatedBy: "user" })).toEqual(saved);
  } finally { await isolated.close(); }
});

it("round-trips all explicit answer-condition events and refuses a truncated intent history", async () => {
  const isolated = await createOpeningFixture();
  try {
    const { sql, scope } = isolated;
    const courseId = randomUUID(), sessionId = randomUUID(), attemptId = randomUUID();
    await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Intent backup',${randomUUID()})`;
    const activity = await createOpeningTeachingActivitiesRepository(sql).create(scope, {
      clientKey: randomUUID(), courseId, intentKind: "question", intentSummary: "Study intent history", createIntent: {},
    });
    await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label)
      VALUES (${sessionId},${scope.workspaceId},${scope.ownerUserId},${courseId},${activity.id},'Intent backup')`;
    await sql`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,client_key,create_intent,history_revision)
      VALUES (${attemptId},${scope.workspaceId},${scope.ownerUserId},${sessionId},${courseId},${activity.id},'Intent backup',${randomUUID()},'{}',0)`;
    const intents = createOpeningStudyIntentRepository(sql);
    const copied = await intents.append(scope, { sessionId, attemptId, clientKey: randomUUID(), change: { kind: "signal", signal: "copied_answer" } });
    const guessed = await intents.append(scope, { sessionId, attemptId, clientKey: randomUUID(), change: { kind: "signal", signal: "guessed" } });
    const snapshot = await readOpeningBackupRecords(sql, scope);
    expect(snapshot.tables.opening_study_intent_events).toMatchObject([
      { id: copied.id, attempt_id: attemptId, version: 1, payload: { signals: ["copied_answer"] } },
      { id: guessed.id, attempt_id: attemptId, version: 2, payload: { signals: ["guessed"] } },
    ]);
    const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId: scope.workspaceId, privacyEpoch: snapshot.privacyEpoch,
      deletionJournal: snapshot.deletionJournal, memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] };
    expect(validateOpeningRestore(backup, [], snapshot.memoryDeletions)).toMatchObject({ allowed: true });
    const truncated = structuredClone(backup);
    truncated.tables.opening_study_intent_events!.shift();
    expect(validateOpeningRestore(truncated, [], snapshot.memoryDeletions)).toMatchObject({ allowed: false });
    await sql`DELETE FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_learning_sessions WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM courses WHERE workspace_id=${scope.workspaceId}`;
    const restored = await executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup, currentDeletionJournal: [],
      currentMemoryDeletions: snapshot.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] } });
    expect(restored).toMatchObject({ ok: true });
    expect((await readOpeningBackupRecords(sql, scope)).tables.opening_study_intent_events).toEqual(snapshot.tables.opening_study_intent_events);
    expect(await intents.latest(scope, sessionId)).toEqual(guessed);
    expect((await sql`SELECT goal_json FROM opening_teaching_activities WHERE id=${activity.id}`)[0]!.goal_json)
      .toMatchObject({ sessionIntentEventId: guessed.id, sessionIntentVersion: 2 });
  } finally { await isolated.close(); }
});
