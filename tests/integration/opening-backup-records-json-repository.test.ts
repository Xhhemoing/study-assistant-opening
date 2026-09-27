import { afterEach, beforeEach, expect, it } from "vitest";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { createBackupFixture, type BackupFixture } from "./opening-backup-records-fixture";

let fixture: BackupFixture;
beforeEach(async () => { fixture = await createBackupFixture(); });
afterEach(async () => { await fixture?.dispose(); });

it.each([{}, "bad-reference", null, 7])("omits malformed candidate source_ids %j instead of treating them as empty", async (value) => {
  const { rows, sql, scope } = fixture;
  const conversation = await rows.conversation(), turn = await rows.turn(conversation);
  const good = await rows.candidate(conversation, turn), bad = await rows.candidate(conversation, turn);
  await sql`UPDATE opening_assistant_candidates SET source_ids = ${JSON.stringify(value)}::text::jsonb WHERE id = ${bad}`;
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_assistant_candidates.map((row) => row.id)).toEqual([good]);
});

it.each([["not-a-uuid"], [null], [{}], {}, "bad-reference"].map((value) => ({ value })))("omits malformed memory references $value without aborting export", async ({ value }) => {
  const { rows, sql, scope } = fixture;
  const conversation = await rows.conversation(), turn = await rows.turn(conversation);
  const good = await rows.memory([turn]), bad = await rows.memory();
  await sql`UPDATE opening_memories SET source_turn_ids = ${JSON.stringify(value)}::text::jsonb WHERE id = ${bad}`;
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_memories.map((row) => row.id)).toEqual([good]);
});

it.each([{}, "scalar", null, [null], [{}]].map((value) => ({ value })))("omits malformed citations $value without aborting export", async ({ value }) => {
  const { rows, sql, scope } = fixture;
  const conversation = await rows.conversation();
  const good = await rows.turn(conversation), bad = await rows.turn(conversation);
  await sql`UPDATE opening_turns SET citations = ${JSON.stringify(value)}::text::jsonb WHERE id = ${bad}`;
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect(tables.opening_turns.map((row) => row.id)).toEqual([good]);
});

it("rejects citation string versions while retaining numeric versions and their dependent memories", async () => {
  const { rows, sql, scope } = fixture;
  const source = await rows.source(), conversation = await rows.conversation();
  const good = await rows.turn(conversation), bad = await rows.turn(conversation);
  await sql`UPDATE opening_turns SET citations = ${sql.json([{ sourceId: source, sourceVersion: 1 }])} WHERE id = ${good}`;
  await sql`UPDATE opening_turns SET citations = ${sql.json([{ sourceId: source, sourceVersion: "1" }])} WHERE id = ${bad}`;
  const goodMemory = await rows.memory([good]);
  await rows.memory([bad]);
  const { tables } = await readOpeningBackupRecords(sql, scope);
  expect.soft(tables.opening_turns.map((row) => row.id)).toEqual([good]);
  expect(tables.opening_memories.map((row) => row.id)).toEqual([goodMemory]);
});

it("retains valid uppercase candidate source IDs and still applies exclusions case-insensitively", async () => {
  const { rows, sql, scope } = fixture;
  const source = await rows.source(), conversation = await rows.conversation(), turn = await rows.turn(conversation);
  const lower = await rows.candidate(conversation, turn, [source]);
  const upper = await rows.candidate(conversation, turn, [source.toUpperCase()]);
  const before = await readOpeningBackupRecords(sql, scope);
  expect.soft(before.tables.opening_assistant_candidates.map((row) => row.id).sort()).toEqual([lower, upper].sort());
  await rows.exclude(source);
  const after = await readOpeningBackupRecords(sql, scope);
  expect(after.tables.opening_assistant_candidates).toEqual([]);
});
