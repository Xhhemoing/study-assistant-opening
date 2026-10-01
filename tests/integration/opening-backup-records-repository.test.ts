import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OPENING_BACKUP_TABLES, readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { backupRows, createBackupFixture, seedBackupGraph, seedBackupPlanning, sourceBytes, type BackupFixture } from "./opening-backup-records-fixture";

let fixture: BackupFixture;
beforeEach(async () => { fixture = await createBackupFixture(); });
afterEach(async () => { await fixture?.dispose(); });

it("exports durable tables and version metadata with owner isolation and no object locators", async () => {
  const own = await seedBackupGraph(fixture.sql, fixture.scope);
  const other = await seedBackupGraph(fixture.sql, fixture.otherScope);
  const wrongOwner = { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId };
  const impostor = backupRows(fixture.sql, wrongOwner);
  await impostor.conversation();
  await impostor.learning();
  await seedBackupPlanning(fixture.sql, wrongOwner);
  const snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(Object.keys(snapshot.tables).sort()).toEqual([...OPENING_BACKUP_TABLES].sort());
  for (const [name, rows] of Object.entries(snapshot.tables)) expect(rows).toHaveLength(["workspace_preferences", "courses", "course_asset_memberships", "opening_learning_attempts", "opening_learning_item_versions", "opening_learning_history_revisions", "opening_retest_activities"].includes(name) ? 0 : 1);
  expect(snapshot.privacyEpoch).toBe(1);
  expect(snapshot.deletionJournal).toHaveLength(1);
  expect(snapshot.tables.opening_sources[0]).toMatchObject({ id: own.source, bytes: sourceBytes.length });
  expect(snapshot.tables.opening_source_chunks[0]).not.toHaveProperty("image_object_key");
  expect(JSON.stringify(snapshot)).not.toContain(other.source);
  expect(JSON.stringify(snapshot)).not.toContain(fixture.otherScope.ownerUserId);
  await expect(readOpeningBackupRecords(fixture.sql, wrongOwner)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("omits private and foreign lineage while retaining captured historical versions", async () => {
  const { sql, rows, scope, otherScope } = fixture;
  const kept = await rows.source(), excluded = await rows.source();
  const pending = await rows.source("pending"), stale = await rows.source("uploaded", 2);
  const foreign = await backupRows(sql, otherScope).source();
  const conversation = await rows.conversation(), session = await rows.learning([kept]);
  const goodTurn = await rows.turn(conversation, [kept]);
  const goodChunk = await rows.chunk(kept);
  const historicalChunk = await rows.chunk(stale);
  const historicalTurn = await rows.turn(conversation, [stale]);
  await rows.chunk(excluded);
  const blocked: string[] = [];
  for (const source of [excluded, pending, foreign, randomUUID()]) blocked.push(await rows.turn(conversation, [source]));
  const citationOnly = await rows.turn(conversation);
  await sql`UPDATE opening_turns SET citations = ${sql.json([{ sourceId: excluded, sourceVersion: 1 }])} WHERE id = ${citationOnly}`;
  const versionOnly = await rows.turn(conversation);
  await sql`UPDATE opening_turns SET source_versions = ${sql.json({ [excluded]: 1 })} WHERE id = ${versionOnly}`;
  blocked.push(citationOnly, versionOnly);
  for (const turn of blocked) {
    await rows.candidate(conversation, turn);
    await rows.memory([turn]);
    await rows.help(session, turn);
    await rows.observation(session, [], [turn]);
  }
  await rows.problem(session, excluded);
  const historicalProblem = await rows.problem(session, stale);
  await rows.memory([goodTurn], "deleted");
  const excludedMemory = await rows.memory([goodTurn]);
  await rows.exclude(excluded, excludedMemory);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_sources.map((row) => row.id).sort()).toEqual([kept, stale].sort());
  expect(tables.opening_source_chunks.map((row) => row.id).sort()).toEqual([goodChunk, historicalChunk].sort());
  expect(tables.opening_turns.map((row) => row.id).sort()).toEqual([goodTurn, historicalTurn].sort());
  expect(tables.opening_problem_refs.map(row => row.problem_id)).toEqual([historicalProblem]);
  for (const table of ["opening_assistant_candidates", "opening_memories", "opening_help_exposures", "opening_learning_observations"] as const) {
    expect(tables[table], table).toEqual([]);
  }
});

it("omits problems and observations when their parent session is excluded", async () => {
  const { rows, sql, scope } = fixture;
  const kept = await rows.source(), excluded = await rows.source();
  const session = await rows.learning([excluded]), cleanSession = await rows.learning([kept]);
  await rows.problem(session, kept);
  await rows.observation(session);
  const cleanProblem = await rows.problem(cleanSession, kept);
  const cleanObservation = await rows.observation(cleanSession);
  await rows.exclude(excluded);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_learning_sessions.map((row) => row.id)).toEqual([cleanSession]);
  expect.soft(tables.opening_problem_refs.map((row) => row.problem_id)).toEqual([cleanProblem]);
  expect.soft(tables.opening_learning_observations.map((row) => row.id)).toEqual([cleanObservation]);
});

it("omits turns and downstream memories linked to a filtered or missing learning session", async () => {
  const { rows, sql, scope } = fixture;
  const source = await rows.source(), session = await rows.learning([source]);
  const conversation = await rows.conversation(), kept = await rows.turn(conversation);
  const foreign = await backupRows(sql, fixture.otherScope).learning();
  const wrongOwner = await backupRows(sql, { ...scope, ownerUserId: fixture.otherScope.ownerUserId }).learning();
  for (const sessionId of [session, randomUUID(), foreign, wrongOwner]) {
    const turn = await rows.turn(conversation);
    await sql`UPDATE opening_turns SET learning_session_id = ${sessionId} WHERE id = ${turn}`;
    await rows.memory([turn]);
    await rows.candidate(conversation, turn);
  }
  await rows.exclude(source);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_turns.map((row) => row.id)).toEqual([kept]);
  expect(tables.opening_memories).toEqual([]);
  expect(tables.opening_assistant_candidates).toEqual([]);
});

it("exports retest business state without dangling transport candidate references", async () => {
  const { sql, scope } = fixture;
  const courseId = randomUUID();
  const taskId = randomUUID();
  const activityId = randomUUID();
  const candidateId = randomUUID();
  await sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${scope.workspaceId}, 'Retest backup', ${courseId})`;
  await sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
    VALUES (${candidateId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${`retest:${candidateId}`}, 'retest', '{}'::jsonb, 'succeeded')`;
  await sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, candidate_id)
    VALUES (${taskId}, ${scope.workspaceId}, ${scope.ownerUserId}, 'Retest', 20, ${candidateId})`;
  await sql`INSERT INTO opening_retest_activities (
    id, workspace_id, owner_user_id, course_id, skill_label, evidence_cycle_id, candidate_id, task_id,
    status, version, reason
  ) VALUES (
    ${activityId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId}, 'fractions', ${candidateId}, ${candidateId}, ${taskId},
    'completed', 1, 'existing_reason'
  )`;
  const sessionId = randomUUID();
  const observationId = randomUUID();
  await sql`INSERT INTO opening_learning_sessions (id, workspace_id, owner_user_id, course_id, skill_label, source_ids)
    VALUES (${sessionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId}, 'fractions', ARRAY[]::uuid[])`;
  await sql`INSERT INTO opening_learning_observations (
    id, workspace_id, owner_user_id, session_id, course_id, skill_label, source_ids, retest_id,
    answer, outcome, assistance, client_key, source_turn_ids, verdict_source, workspace_history_revision
  ) VALUES (
    ${observationId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${sessionId}, ${courseId}, 'fractions',
    ARRAY[]::uuid[], ${candidateId}, 'answer', 'correct', 'independent', ${observationId}, ARRAY[]::uuid[], 'self_report', 0
  )`;

  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_tasks.find((row) => row.id === taskId)).toMatchObject({ candidate_id: null });
  expect(tables.opening_retest_activities.find((row) => row.id === activityId)).toMatchObject({
    candidate_id: null,
    task_id: taskId,
    reason: expect.stringContaining("candidate_reference_unresolved"),
  });
  expect(tables.opening_learning_observations.find((row) => row.id === observationId)).toMatchObject({ retest_id: activityId });
});
