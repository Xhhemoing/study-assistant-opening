import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { planOpeningRestoreApply } from "../../packages/domain/src/opening/backup-apply-plan";
import { deleteOwnedMemory } from "../../packages/database/src/repositories/opening-memory-delete";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { readOpeningBackupSources } from "../../packages/database/src/repositories/opening-backup-sources";
import { assertOpeningBackupSnapshotCurrent } from "../../packages/database/src/repositories/opening-backup-current";
import { assembleOpeningBackupDraft } from "../../packages/database/src/repositories/opening-backup-compose";
import { readOpeningBackupArchive, writeOpeningBackupArchive } from "../../packages/database/src/storage/opening-backup-archive";
import { backupRows, createBackupFixture, sourceBytes, type BackupFixture } from "./opening-backup-records-fixture";

let fixture: BackupFixture;
const directories: string[] = [];
beforeEach(async () => { fixture = await createBackupFixture(); });
afterEach(async () => {
  await fixture?.dispose();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function seedAndDelete() {
  const { sql, scope, rows } = fixture;
  const conversation = await rows.conversation();
  const turn = await rows.turn(conversation, [], []);
  const original = await rows.turn(conversation, [], []);
  await sql`UPDATE opening_turns SET role = 'user', text = 'Preserve my original conversation' WHERE id = ${original}`;
  const memory = await rows.memory([turn]);
  const records = await readOpeningBackupRecords(sql, scope);
  const sources = await readOpeningBackupSources(sql, scope);
  const legacy: OpeningBackup = JSON.parse(JSON.stringify({ format: "opening-backup", version: 1,
    workspaceId: scope.workspaceId, ...records, objects: [] }));
  delete legacy.memoryDeletions;
  expect(validateOpeningRestore(legacy, sources.deletionJournal, sources.memoryDeletions).allowed).toBe(true);
  const [row] = await sql`SELECT version FROM opening_memories WHERE id = ${memory}`;
  await deleteOwnedMemory(sql, scope, { id: memory, expectedVersion: Number(row!.version),
    deleteSourceText: false, clientKey: `delete:${memory}` });
  return { memory, turn, original, legacy, sources };
}

it("overlays a source-free memory deletion on an old archive while retaining saved original turns", async () => {
  const { memory, turn, original, legacy, sources } = await seedAndDelete();
  const { sql, scope } = fixture;
  const current = await readOpeningBackupSources(sql, scope);
  const records = await readOpeningBackupRecords(sql, scope);
  expect(current.privacyEpoch).toBe(sources.privacyEpoch + 1);
  expect(current.deletionJournal).toEqual([]);
  expect(current.memoryDeletions).toEqual(records.memoryDeletions);
  expect(current.memoryDeletions.memories).toEqual([{ memoryId: memory, deletedAt: expect.any(String) }]);
  expect(records.tables.opening_memories).toEqual([]);
  expect(JSON.stringify(records.memoryDeletions)).not.toMatch(/Saved memory|Preserve my original conversation/);
  expect(records.tables.opening_turns.map(row => row.id)).toEqual(expect.arrayContaining([turn, original]));
  expect(await sql`SELECT text FROM opening_turns WHERE id = ${original}`)
    .toEqual([{ text: "Preserve my original conversation" }]);
  expect(validateOpeningRestore(legacy, current.deletionJournal, current.memoryDeletions).errors)
    .toContain("deleted memory cannot be restored");
  expect(planOpeningRestoreApply(legacy, current.deletionJournal, { confirmLocalRestore: true,
    currentMemoryDeletions: current.memoryDeletions })).toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED" });
  await expect(assertOpeningBackupSnapshotCurrent(sql, scope, sources)).rejects.toMatchObject({ code: "CONFLICT" });
});

it("round-trips only content-free memory deletion facts through the actual backup assembly", async () => {
  const { memory } = await seedAndDelete();
  const { sql, scope } = fixture;
  const parent = await mkdtemp(path.join(tmpdir(), "opening-memory-backup-"));
  directories.push(parent);
  const result = await assembleOpeningBackupDraft(sql, scope, parent, {
    finalKey: () => { throw new Error("source-free backup must not request an object key"); },
    readObject: async () => { throw new Error("source-free backup must not read an object"); },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const staged = (await readdir(parent)).find(name => name.startsWith("opening-backup-"));
  expect(staged).toBeDefined();
  const destination = path.join(parent, "memory.opening");
  await writeOpeningBackupArchive(result.backup, path.join(parent, staged!), destination);
  const opened = await readOpeningBackupArchive(destination);
  try {
    const current = await readOpeningBackupSources(sql, scope);
    expect(opened.metadata.memoryDeletions?.memories).toEqual([{ memoryId: memory, deletedAt: expect.any(String) }]);
    expect(JSON.stringify(opened.metadata)).not.toContain("Saved memory");
    expect(planOpeningRestoreApply(opened.metadata, current.deletionJournal, { confirmLocalRestore: true,
      currentMemoryDeletions: current.memoryDeletions }).ok).toBe(true);
  } finally { await opened.close(); }
});

it("rejects and cleans a draft when a source-free memory is deleted during object staging", async () => {
  const { sql, scope, rows } = fixture;
  const conversation = await rows.conversation();
  const turn = await rows.turn(conversation, [], []);
  const memory = await rows.memory([turn]);
  const [row] = await sql`SELECT version FROM opening_memories WHERE id = ${memory}`;
  await rows.source();
  const parent = await mkdtemp(path.join(tmpdir(), "opening-memory-drift-"));
  directories.push(parent);
  await expect(assembleOpeningBackupDraft(sql, scope, parent, {
    finalKey: (id, version) => `${id}/${version}`,
    readObject: async () => (async function* () {
      yield sourceBytes;
      await deleteOwnedMemory(sql, scope, { id: memory, expectedVersion: Number(row!.version),
        deleteSourceText: false, clientKey: `stage-delete:${memory}` });
    })(),
  })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await readdir(parent)).toEqual([]);
});

it("reads deletion facts only for the authenticated owner and rejects foreign current facts", async () => {
  const { sql, scope, otherScope, rows } = fixture;
  const own = await rows.memory([], "deleted");
  const foreign = await backupRows(sql, otherScope).memory([], "deleted");
  const records = await readOpeningBackupRecords(sql, scope);
  const current = await readOpeningBackupSources(sql, scope);
  const other = await readOpeningBackupSources(sql, otherScope);
  expect(current.memoryDeletions.memories.map(mark => mark.memoryId)).toEqual([own]);
  expect(records.memoryDeletions).toEqual(current.memoryDeletions);
  expect(JSON.stringify(current)).not.toContain(foreign);
  const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId: scope.workspaceId,
    ...records, objects: [] };
  expect(validateOpeningRestore(backup, [], other.memoryDeletions).allowed).toBe(false);
  const wrongOwner = { ...scope, ownerUserId: otherScope.ownerUserId };
  await expect(readOpeningBackupRecords(sql, wrongOwner)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(readOpeningBackupSources(sql, wrongOwner)).rejects.toMatchObject({ code: "NOT_FOUND" });
});
