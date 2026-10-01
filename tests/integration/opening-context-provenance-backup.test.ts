import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { planOpeningRestoreApply } from "../../packages/domain/src/opening/backup-apply-plan";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { contextSourceRefsIncluded } from "../../packages/database/src/repositories/opening-context-provenance";
import { backupRows, createBackupFixture, type BackupFixture } from "./opening-backup-records-fixture";

let fixture: BackupFixture;
beforeEach(async () => { fixture = await createBackupFixture(); });
afterEach(async () => { await fixture?.dispose(); });

it("quarantines unknown assistant provenance and dependent rows while preserving original user leaves", async () => {
  const { rows, sql, scope } = fixture;
  const conversation = await rows.conversation();
  const known = await rows.turn(conversation);
  const unknown = await rows.turn(conversation, [], null);
  const user = await rows.turn(conversation, [], null);
  await sql`UPDATE opening_turns SET role = 'user', text = 'Original user leaf' WHERE id = ${user}`;
  const keptMemory = await rows.memory([known]);
  const keptCandidate = await rows.candidate(conversation, known);
  await rows.memory([unknown]);
  await rows.candidate(conversation, unknown);

  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_turns.map(row => row.id).sort()).toEqual([known, user].sort());
  expect(tables.opening_turns.find(row => row.id === known)?.context_source_refs).toEqual([]);
  expect(tables.opening_turns.find(row => row.id === user)).toMatchObject({ text: "Original user leaf", context_source_refs: null });
  expect(tables.opening_memories.map(row => row.id)).toEqual([keptMemory]);
  expect(tables.opening_assistant_candidates.map(row => row.id)).toEqual([keptCandidate]);
  expect(await sql`SELECT id FROM opening_turns WHERE id = ${unknown}`).toHaveLength(1);
});

it("exports historical multi-version context references and rejects their replay after a mixed source is excluded", async () => {
  const { rows, sql, scope } = fixture;
  const a = await rows.source("uploaded", 2), b = await rows.source();
  await rows.chunk(a, 1);
  const conversation = await rows.conversation();
  const refs = [{ sourceId: a.toUpperCase(), sourceVersion: 1 }, { sourceId: a, sourceVersion: 2 }, { sourceId: b, sourceVersion: 1 }];
  const mixed = await rows.turn(conversation, [], refs);
  const memory = await rows.memory([mixed]);
  const candidate = await rows.candidate(conversation, mixed);
  const clean = await rows.turn(conversation, [], [{ sourceId: b, sourceVersion: 1 }]);
  const cleanMemory = await rows.memory([clean]);
  const cleanCandidate = await rows.candidate(conversation, clean);
  const user = await rows.turn(conversation, [b], null);
  await sql`UPDATE opening_turns SET role = 'user', text = 'Keep my original notes' WHERE id = ${user}`;
  const linkedUser = await rows.turn(conversation, [a], null);
  await sql`UPDATE opening_turns SET role = 'user' WHERE id = ${linkedUser}`;

  const before = await readOpeningBackupRecords(sql, scope);
  expect(before.tables.opening_turns.find(row => row.id === mixed)).toMatchObject({ source_ids: [], source_versions: {}, citations: [], context_source_refs: refs });
  expect(before.tables.opening_memories.map(row => row.id)).toContain(memory);
  expect(before.tables.opening_assistant_candidates.map(row => row.id)).toContain(candidate);
  const backup: OpeningBackup = JSON.parse(JSON.stringify({ format: "opening-backup", version: 1, workspaceId: scope.workspaceId,
    ...before, objects: [] }));
  expect(planOpeningRestoreApply(backup, [], { confirmLocalRestore: true, currentMemoryDeletions: before.memoryDeletions }).ok).toBe(true);
  expect((backup.tables.opening_turns as Record<string, unknown>[]).find(row => row.id === mixed)?.context_source_refs).toEqual(refs);

  await rows.exclude(a);
  const after = await readOpeningBackupRecords(sql, scope);
  expect(after.tables.opening_turns.map(row => row.id).sort()).toEqual([clean, user].sort());
  expect(after.tables.opening_memories.map(row => row.id)).toEqual([cleanMemory]);
  expect(after.tables.opening_assistant_candidates.map(row => row.id)).toEqual([cleanCandidate]);
  expect(validateOpeningRestore(backup, after.deletionJournal, after.memoryDeletions).errors).toContain("table opening_turns references a deleted source");
  expect(planOpeningRestoreApply(backup, after.deletionJournal, { confirmLocalRestore: true, currentMemoryDeletions: after.memoryDeletions })).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED" });
  expect(await sql`SELECT text FROM opening_turns WHERE id = ${user}`).toEqual([{ text: "Keep my original notes" }]);
});

it("omits foreign context-only references and their dependent memories", async () => {
  const { rows, sql, scope } = fixture;
  const foreign = await backupRows(sql, fixture.otherScope).source();
  const conversation = await rows.conversation();
  const good = await rows.turn(conversation);
  const bad = await rows.turn(conversation, [], [{ sourceId: foreign, sourceVersion: 1 }]);
  await rows.memory([bad]);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_turns.map(row => row.id)).toEqual([good]);
  expect(tables.opening_memories).toEqual([]);
});

it.each([[null], [{}], [{ sourceId: "bad", sourceVersion: 1 }],
  [{ sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceVersion: "1" }],
].map(value => ({ value })))("fails closed on malformed persisted context provenance $value without aborting export", async ({ value }) => {
  const { rows, sql, scope } = fixture;
  const conversation = await rows.conversation();
  const good = await rows.turn(conversation), bad = await rows.turn(conversation);
  await sql`UPDATE opening_turns SET context_source_refs = ${JSON.stringify(value)}::text::jsonb WHERE id = ${bad}`;
  await rows.memory([bad]);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_turns.map(row => row.id)).toEqual([good]);
  expect(tables.opening_memories).toEqual([]);
});

it("rejects unsafe integer context versions consistently at SQL export and archive preflight", async () => {
  const { rows, sql, scope } = fixture;
  const source = await rows.source();
  const refs = [{ sourceId: source, sourceVersion: Number.MAX_SAFE_INTEGER + 1 }];
  const [result] = await sql`SELECT (${contextSourceRefsIncluded(sql, scope.workspaceId, sql`${sql.json(refs)}::jsonb`, true)}) AS allowed`;
  expect(result?.allowed).toBe(false);
});
it.each([{}, "scalar", null].map(value => ({ value })))("rejects non-array context JSON safely before persistence: $value", async ({ value }) => {
  const { sql, scope } = fixture;
  const [result] = await sql`SELECT (${contextSourceRefsIncluded(sql, scope.workspaceId, sql`${JSON.stringify(value)}::text::jsonb`, true)}) AS allowed`;
  expect(result?.allowed).toBe(false);
});

it("retains context-only historical versions as unknown when original metadata is missing", async () => {
  const { rows, sql, scope } = fixture;
  const source = await rows.source("uploaded", 3);
  const conversation = await rows.conversation();
  await rows.turn(conversation, [], [{ sourceId: source.toUpperCase(), sourceVersion: 1 }, { sourceId: source, sourceVersion: 2 }]);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_source_versions).toMatchObject([
    { source_id: source, version: 1, bytes: null, sha256: null, availability: "unknown" },
    { source_id: source, version: 2, bytes: null, sha256: null, availability: "unknown" },
    { source_id: source, version: 3, availability: "available" },
  ]);
});
it("retains uppercase source version and reference check provenance through secondary filtering", async () => {
  const { rows, sql, scope } = fixture;
  const source = await rows.source();
  const session = await rows.learning([source]), cleanSession = await rows.learning();
  const [learning] = await sql`SELECT course_id FROM opening_learning_sessions WHERE id = ${session}`;
  const attempt = randomUUID();
  const sourceVersions = { [source.toUpperCase()]: 1 };
  await sql`INSERT INTO opening_learning_attempts (
    id, workspace_id, owner_user_id, session_id, course_id, skill_label,
    source_ids, source_versions, client_key, create_intent, history_revision
  ) VALUES (
    ${attempt}, ${scope.workspaceId}, ${scope.ownerUserId}, ${session}, ${learning!.course_id}, 'Recall',
    ${[source]}, ${sql.json(sourceVersions)}, ${attempt}, '{}'::jsonb, 0
  )`;
  const versionObservation = await rows.observation(session, [source]);
  await sql`UPDATE opening_learning_observations SET source_versions = ${sql.json(sourceVersions)} WHERE id = ${versionObservation}`;
  const referenceObservation = await rows.observation(cleanSession);
  const referenceCheck = { referenceId: source.toUpperCase(), method: "Compare every step" };
  await sql`UPDATE opening_learning_observations SET reference_check = ${sql.json(referenceCheck)} WHERE id = ${referenceObservation}`;

  const before = await readOpeningBackupRecords(sql, scope);
  expect.soft(before.tables.opening_learning_attempts).toContainEqual(expect.objectContaining({ id: attempt, source_versions: sourceVersions }));
  expect.soft(before.tables.opening_learning_observations).toContainEqual(expect.objectContaining({ id: versionObservation, source_versions: sourceVersions }));
  expect.soft(before.tables.opening_learning_observations).toContainEqual(expect.objectContaining({ id: referenceObservation, reference_check: referenceCheck }));

  await rows.exclude(source);
  const after = await readOpeningBackupRecords(sql, scope);
  expect(after.tables.opening_learning_attempts).toEqual([]);
  expect(after.tables.opening_learning_observations).toEqual([]);
});
