import { afterEach, beforeEach, expect, it } from "vitest";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { backupRows, createBackupFixture, type BackupFixture } from "./opening-backup-records-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let fixture: BackupFixture;
beforeEach(async () => { fixture = await createBackupFixture(); });
afterEach(async () => { await fixture?.dispose(); });

it("keeps one repeatable-read epoch and journal across a real concurrent privacy deletion", async () => {
  const source = await fixture.rows.source();
  const chunk = await fixture.rows.chunk(source);
  const holder = await openRaceSession().ready, exporter = await openRaceSession().ready;
  let release = () => undefined as void;
  const unlocked = new Promise<void>((resolve) => { release = resolve; });
  let opened = () => undefined as void;
  const gate = new Promise<void>((resolve) => { opened = resolve; });
  const lock = track(holder.sql.begin(async (tx) => {
    await tx`LOCK TABLE opening_source_chunks IN ACCESS EXCLUSIVE MODE`;
    opened();
    await unlocked;
  }));
  let pending: ReturnType<typeof readOpeningBackupRecords> | undefined;
  try {
    await Promise.race([gate, lock]);
    pending = track(readOpeningBackupRecords(exporter.sql, fixture.scope));
    await waitUntilBlocked(fixture.sql, exporter.pid, holder.pid, "backup snapshot", /FROM opening_source_chunks/);
    await fixture.rows.exclude(source);
    release();
    await lock;
    const snapshot = await pending;
    expect(snapshot.privacyEpoch).toBe(0);
    expect(snapshot.deletionJournal).toEqual([]);
    expect(snapshot.tables.opening_sources.map((row) => row.id)).toEqual([source]);
    expect(snapshot.tables.opening_source_chunks.map((row) => row.id)).toEqual([chunk]);
    const current = await readOpeningBackupRecords(exporter.sql, fixture.scope);
    expect(current.privacyEpoch).toBe(1);
    expect(current.deletionJournal.map((mark) => mark.sourceId)).toEqual([source]);
    expect(current.tables.opening_sources).toEqual([]);
    expect(current.tables.opening_source_chunks).toEqual([]);
  } finally {
    release();
    await Promise.allSettled([lock, ...(pending ? [pending] : [])]);
    await closeRace(exporter.sql);
    await closeRace(holder.sql);
  }
}, 15_000);

it("captures the caller scope before the asynchronous transaction begins", async () => {
  const own = await fixture.rows.source();
  await backupRows(fixture.sql, fixture.otherScope).source();
  const scope = { ...fixture.scope };
  const pending = readOpeningBackupRecords(fixture.sql, scope);
  Object.assign(scope, fixture.otherScope);
  const snapshot = await pending;
  expect(snapshot.tables.opening_sources.map((row) => row.id)).toEqual([own]);
});
