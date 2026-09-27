import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { validateOpeningRestore } from "@aistudy/domain";
import { assembleOpeningBackupDraft } from "../../packages/database/src/repositories/opening-backup-compose";
import { readOpeningBackupSources } from "../../packages/database/src/repositories/opening-backup-sources";
import { readOpeningBackupArchive, writeOpeningBackupArchive } from "../../packages/database/src/storage/opening-backup-archive";
import { decryptOpeningArchive, encryptOpeningArchive } from "../../packages/database/src/storage/opening-backup-cipher";
import { createOpeningBackupReader } from "../../packages/database/src/storage/opening-backup-reader";
import { createOpeningTestStorage } from "./opening-storage-fixture";
import { createBackupFixture, seedBackupGraph, sourceBytes, type BackupFixture } from "./opening-backup-records-fixture";

const storage = createOpeningTestStorage();
const reader = createOpeningBackupReader(storage);
let fixture: BackupFixture;
let root: string;
const keys = new Set<string>();
beforeEach(async () => {
  fixture = await createBackupFixture();
  root = await mkdtemp(path.join(tmpdir(), "opening-backup-integration-"));
  await writeFile(path.join(root, "sentinel"), "retain unrelated file", "utf8");
});
afterEach(async () => {
  try {
    for (const key of keys) await storage.deleteObject(key);
  } finally {
    keys.clear();
    try { if (root) await rm(root, { recursive: true, force: true }); }
    finally { await fixture?.dispose(); }
  }
});
afterAll(() => { if (storage.client instanceof S3Client) storage.client.destroy(); });

async function put(source: string, bytes = sourceBytes) {
  const key = storage.finalKey(source, 1);
  keys.add(key);
  await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes }));
}
async function expectCleanFailure() {
  expect(await readdir(root)).toEqual(["sentinel"]);
  expect(await readFile(path.join(root, "sentinel"), "utf8")).toBe("retain unrelated file");
}

it("round-trips all 17 real database tables and MinIO bytes through an encrypted archive", async () => {
  const graph = await seedBackupGraph(fixture.sql, fixture.scope);
  await put(graph.source);
  const excluded = await fixture.rows.source();
  await fixture.rows.exclude(excluded); // No corresponding object: it must never be read.
  const draft = await assembleOpeningBackupDraft(fixture.sql, fixture.scope, root, reader);
  expect(draft).toMatchObject({ ok: true });
  if (!draft.ok) throw new Error(JSON.stringify(draft));
  expect(Object.keys(draft.backup.tables)).toHaveLength(17);
  expect(draft.backup.tables.opening_memories).toHaveLength(1);
  expect(draft.backup.objects.map((object) => object.sourceId)).toEqual([graph.source]);
  const staged = (await readdir(root)).filter((entry) => entry.startsWith("opening-backup-"));
  expect(staged).toHaveLength(1);
  const archive = path.join(root, "backup.bin"), encrypted = path.join(root, "backup.enc"), decoded = path.join(root, "decoded.bin");
  const passphrase = randomUUID();
  await writeOpeningBackupArchive(draft.backup, path.join(root, staged[0]!), archive);
  await encryptOpeningArchive(archive, encrypted, passphrase);
  expect((await readFile(encrypted)).includes(sourceBytes)).toBe(false);
  await expect(decryptOpeningArchive(encrypted, path.join(root, "wrong.bin"), "wrong-password")).rejects.toThrow("decryption failed");
  expect(await readdir(root)).not.toContain("wrong.bin");
  await decryptOpeningArchive(encrypted, decoded, passphrase);
  expect(await readFile(decoded)).toEqual(await readFile(archive));
  const opened = await readOpeningBackupArchive(decoded);
  try {
    expect(opened.metadata).toEqual(JSON.parse(JSON.stringify(draft.backup)));
    const chunks: Buffer[] = [];
    for await (const chunk of opened.objectBytes(draft.backup.objects[0]!.archivePath)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(sourceBytes);
    expect(validateOpeningRestore(opened.metadata, draft.backup.deletionJournal).allowed).toBe(true);
    await fixture.rows.exclude(graph.source);
    const live = await readOpeningBackupSources(fixture.sql, fixture.scope);
    expect(validateOpeningRestore(opened.metadata, live.deletionJournal).allowed).toBe(false);
  } finally { await opened.close(); }
});

it.each(["hash", "missing"])("rejects %s object failure and removes only its staging directory", async (failure) => {
  const source = await fixture.rows.source();
  if (failure === "hash") {
    const altered = Buffer.from(sourceBytes);
    altered[0] = altered[0]! ^ 1;
    await put(source, altered);
  }
  await expect(assembleOpeningBackupDraft(fixture.sql, fixture.scope, root, reader)).rejects.toThrow(
    failure === "hash" ? "backup object mismatch" : "storage unavailable",
  );
  await expectCleanFailure();
});

it.each(["exclusion", "version", "journal", "new-source"])("rejects %s drift while real object bytes are staged", async (change) => {
  const source = await fixture.rows.source();
  await put(source);
  const changingReader = { ...reader, async readObject(key: string) {
    const body = await reader.readObject(key);
    return (async function* () {
      yield* body;
      if (change === "exclusion") await fixture.rows.exclude(source);
      if (change === "version") await fixture.sql`UPDATE opening_sources SET version = 2 WHERE id = ${source}`;
      if (change === "journal") await fixture.sql`INSERT INTO opening_privacy_exclusions (workspace_id, source_id)
        VALUES (${fixture.scope.workspaceId}, ${randomUUID()})`;
      if (change === "new-source") await fixture.rows.source();
    })();
  } };
  await expect(assembleOpeningBackupDraft(fixture.sql, fixture.scope, root, changingReader)).rejects.toMatchObject({ code: "CONFLICT" });
  await expectCleanFailure();
});

it("rejects an impostor before creating staging or reading storage", async () => {
  let reads = 0;
  const observed = { ...reader, readObject: async (key: string) => { reads += 1; return reader.readObject(key); } };
  await expect(assembleOpeningBackupDraft(fixture.sql, {
    ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId,
  }, root, observed)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(reads).toBe(0);
  await expectCleanFailure();
});

it("omits memories without provenance so otherwise valid real backups remain restorable", async () => {
  const source = await fixture.rows.source();
  await put(source);
  await fixture.rows.memory();
  const draft = await assembleOpeningBackupDraft(fixture.sql, fixture.scope, root, reader);
  expect(draft).toMatchObject({ ok: true });
  if (draft.ok) expect(draft.backup.tables.opening_memories).toEqual([]);
});
