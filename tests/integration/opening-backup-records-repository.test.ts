import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OPENING_BACKUP_TABLES, readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { backupRows, createBackupFixture, seedBackupGraph, seedBackupPlanning, sourceBytes, type BackupFixture } from "./opening-backup-records-fixture";

let fixture: BackupFixture;
beforeEach(async () => { fixture = await createBackupFixture(); });
afterEach(async () => { await fixture?.dispose(); });

it("exports all 17 populated durable tables with owner isolation and no object locators", async () => {
  const own = await seedBackupGraph(fixture.sql, fixture.scope);
  const other = await seedBackupGraph(fixture.sql, fixture.otherScope);
  const wrongOwner = { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId };
  const impostor = backupRows(fixture.sql, wrongOwner);
  await impostor.conversation();
  await impostor.learning();
  await seedBackupPlanning(fixture.sql, wrongOwner);
  const snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(Object.keys(snapshot.tables).sort()).toEqual([...OPENING_BACKUP_TABLES].sort());
  for (const rows of Object.values(snapshot.tables)) expect(rows).toHaveLength(1);
  expect(snapshot.privacyEpoch).toBe(1);
  expect(snapshot.deletionJournal).toHaveLength(1);
  expect(snapshot.tables.opening_sources[0]).toMatchObject({ id: own.source, bytes: sourceBytes.length });
  expect(snapshot.tables.opening_source_chunks[0]).not.toHaveProperty("image_object_key");
  expect(JSON.stringify(snapshot)).not.toContain(other.source);
  expect(JSON.stringify(snapshot)).not.toContain(fixture.otherScope.ownerUserId);
  await expect(readOpeningBackupRecords(fixture.sql, wrongOwner)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("omits excluded, pending, foreign and stale source lineage and its dependent records", async () => {
  const { sql, rows, scope, otherScope } = fixture;
  const kept = await rows.source(), excluded = await rows.source();
  const pending = await rows.source("pending"), stale = await rows.source("uploaded", 2);
  const foreign = await backupRows(sql, otherScope).source();
  const conversation = await rows.conversation(), session = await rows.learning([kept]);
  const goodTurn = await rows.turn(conversation, [kept]);
  const goodChunk = await rows.chunk(kept);
  await rows.chunk(stale);
  await rows.chunk(excluded);
  const blocked: string[] = [];
  for (const source of [excluded, pending, foreign, stale, randomUUID()]) blocked.push(await rows.turn(conversation, [source]));
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
  await rows.problem(session, stale);
  await rows.memory([goodTurn], "deleted");
  const excludedMemory = await rows.memory([goodTurn]);
  await rows.exclude(excluded, excludedMemory);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_sources.map((row) => row.id).sort()).toEqual([kept, stale].sort());
  expect(tables.opening_source_chunks.map((row) => row.id)).toEqual([goodChunk]);
  expect(tables.opening_turns.map((row) => row.id)).toEqual([goodTurn]);
  for (const table of ["opening_assistant_candidates", "opening_memories", "opening_help_exposures", "opening_learning_observations", "opening_problem_refs"] as const) {
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
