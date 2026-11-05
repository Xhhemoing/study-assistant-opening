import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import { createSqlClient } from "../../packages/database/src/migrate";
import { applyOpeningRestore, createOpeningS3RestoreObjectPut, readOpeningRestoreNamespaceCounts } from "../../packages/database/src/repositories/opening-backup";
import { createOpeningTestStorage } from "./opening-storage-fixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const enabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL && process.env.S3_ENDPOINT);
describe.skipIf(!enabled)("restore actual object integrity before side effects", () => {
  const sql = createSqlClient(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
  const storage = createOpeningTestStorage();
  const scopes: { workspaceId: string; userId: string }[] = [];
  const keys: string[] = [], dirs: string[] = [];
  async function cleanupRegisteredFixtures() {
    // Batch only the keys and scopes registered by this test file. Avoid one
    // remote round trip per fixture in the final hook; do not widen its timeout.
    if (keys.length) {
      if (!(storage.client instanceof S3Client)) throw new Error("fixture cleanup requires its real S3 client");
      const result = await storage.client.send(new DeleteObjectsCommand({
        Bucket: storage.bucket,
        Delete: { Objects: [...new Set(keys)].map(Key => ({ Key })), Quiet: true },
      }));
      if (result.Errors?.length) throw new Error(`fixture object cleanup failed: ${JSON.stringify(result.Errors)}`);
      keys.length = 0;
    }
    if (scopes.length) {
      await sql`DELETE FROM workspaces WHERE id=ANY(${sql.array(scopes.map(scope => scope.workspaceId))}::uuid[])`;
      await sql`DELETE FROM users WHERE id=ANY(${sql.array(scopes.map(scope => scope.userId))}::uuid[])`;
      scopes.length = 0;
    }
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  }
  afterAll(async () => {
    try {
      await cleanupRegisteredFixtures();
    } finally {
      if (storage.client instanceof S3Client) storage.client.destroy();
      await sql.end({ timeout: 1 });
    }
  });
  async function fixture(count = 1) {
    const workspaceId = randomUUID(), userId = randomUUID();
    scopes.push({ workspaceId, userId });
    await sql`INSERT INTO users (id,email,display_name,password_hash) VALUES (${userId},${`${userId}@br02.example`},'BR02','test')`;
    await sql`INSERT INTO workspaces (id,owner_user_id) VALUES (${workspaceId},${userId})`;
    await sql`INSERT INTO opening_jobs (id,workspace_id,owner_user_id,key,kind,payload,state)
      VALUES (${randomUUID()},${workspaceId},${userId},${randomUUID()},'parse','{}','queued')`;
    const bodies: Record<string, Uint8Array> = {};
    const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0,
      deletionJournal: [], tables: { opening_sources: [] }, objects: [] };
    for (let i = 0; i < count; i++) {
      const sourceId = randomUUID(), body = Uint8Array.from([1, 2, 3, i + 4]);
      const archivePath = `objects/${sourceId}/v1.bin`, sha256 = hash(body);
      backup.tables.opening_sources!.push({ id: sourceId, workspace_id: workspaceId, name: 'br02.bin',
        mime: 'application/octet-stream', bytes: body.length, sha256, version: 1, upload_state: 'uploaded', parse_state: 'ready' });
      backup.objects.push({ sourceId, archivePath, sha256, bytes: body.length });
      bodies[archivePath] = body;
      keys.push(storage.finalKey(sourceId, 1));
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'br02-integrity-')); dirs.push(directory);
    async function stage() {
      for (const [name, body] of Object.entries(bodies)) {
        await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
        await writeFile(path.join(directory, name), body);
      }
    }
    async function cli() {
      const draft = path.join(directory, 'draft.json'), config = path.join(directory, 'tsx.json');
      await writeFile(draft, JSON.stringify(backup));
      await writeFile(config, JSON.stringify({ compilerOptions: { baseUrl: root, paths: {
        '@aistudy/domain': ['packages/domain/src/index.ts'], '@aistudy/contracts': ['packages/contracts/src/index.ts'],
        '@aistudy/config': ['packages/config/src/index.ts'],
      } } }));
      return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'),
          'scripts/opening-restore.ts', '--confirm-local-restore', '--draft', draft, '--staging', directory],
        { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: config,
          OPENING_RESTORE_DATABASE_URL: process.env.OPENING_TEST_DATABASE_URL }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timeout: ${output}`)); }, 60000);
        child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
        child.on('error', reject);
        child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
      });
    }
    async function unchanged(before: Awaited<ReturnType<typeof readOpeningRestoreNamespaceCounts>>) {
      expect(await readOpeningRestoreNamespaceCounts(sql, workspaceId)).toEqual(before);
      const [job] = await sql`SELECT state FROM opening_jobs WHERE workspace_id=${workspaceId}`;
      expect(job?.state).toBe('queued');
      for (const object of backup.objects) expect((await storage.headObject(storage.finalKey(object.sourceId, 1))).exists).toBe(false);
    }
    return { workspaceId, backup, bodies, directory, stage, cli, unchanged };
  }
  it('cleans its registered fixture batch without replaying restore cases', async () => {
    const f = await fixture(2);
    const ownedKeys = f.backup.objects.map(object => storage.finalKey(object.sourceId, 1));
    for (const object of f.backup.objects) {
      await storage.putObject(storage.finalKey(object.sourceId, 1), f.bodies[object.archivePath]!);
    }
    expect((await storage.headObject(ownedKeys[0]!)).exists).toBe(true);
    await cleanupRegisteredFixtures();
    for (const key of ownedKeys) expect((await storage.headObject(key)).exists).toBe(false);
    expect(await sql`SELECT id FROM workspaces WHERE id=${f.workspaceId}`).toHaveLength(0);
    expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.workspaceId}`).toHaveLength(0);
    expect(scopes).toHaveLength(0);
    expect(keys).toHaveLength(0);
    expect(dirs).toHaveLength(0);
  });
  it('rejects same-length corrupted staging through real writer', async () => {
    const f = await fixture();
    f.bodies[f.backup.objects[0]!.archivePath] = Uint8Array.from([9, 9, 9, 9]);
    await f.stage();
    const before = await readOpeningRestoreNamespaceCounts(sql, f.workspaceId);
    const writer = createOpeningS3RestoreObjectPut(storage);
    const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, sql,
      stagingDirectory: f.directory, objectPut: writer });
    console.log('BR02 corrupted staging:', result);
    if (result.code === 'APPLY_OK') {
      const object = f.backup.objects[0]!;
      const digest = await storage.streamDigest(storage.finalKey(object.sourceId, 1));
      const [row] = await sql`SELECT sha256 FROM opening_sources WHERE workspace_id=${f.workspaceId}`;
      console.log('BR02 reproduced DB/S3 mismatch:', row?.sha256, digest.sha256);
    }
    expect(result.code).toBe('PREFLIGHT_REJECTED');
    expect(writer.keys).toHaveLength(0);
    await f.unchanged(before);
  }, 90000);
  it('rejects corrupt second staging object through real CLI before publishing the first', async () => {
    const f = await fixture(2);
    const second = f.backup.objects[1]!;
    second.actualSha256 = second.sha256;
    f.bodies[second.archivePath] = Uint8Array.from([9, 9, 9, 9]);
    await f.stage();
    const before = await readOpeningRestoreNamespaceCounts(sql, f.workspaceId);
    const result = await f.cli();
    expect(result.output).toContain('code=PREFLIGHT_REJECTED');
    expect(result.output).toContain('object integrity');
    expect(result.code).toBe(1);
    await f.unchanged(before);
  }, 90000);
  it('accepts correct staging through real CLI and reads the stored bytes back', async () => {
    const f = await fixture(); await f.stage();
    const result = await f.cli();
    expect(result.output).toContain('code=APPLY_OK'); expect(result.code).toBe(0);
    const object = f.backup.objects[0]!;
    expect(await storage.streamDigest(storage.finalKey(object.sourceId, 1))).toMatchObject({ bytes: object.bytes, sha256: object.sha256 });
  }, 90000);
  it.each(['same', 'short', 'long', 'second-bad', 'second-missing', 'forged-actual', 'foreign', 'duplicate', 'missing-version', 'metadata-bytes', 'metadata-hash', 'duplicate-source', 'duplicate-version'])(
    'rejects %s with zero real writer calls and unchanged scope', async kind => {
      const f = await fixture(2), first = f.backup.objects[0]!, second = f.backup.objects[1]!;
      if (kind === 'same' || kind === 'forged-actual') f.bodies[first.archivePath] = Uint8Array.from([9, 9, 9, 9]);
      if (kind === 'forged-actual') first.actualSha256 = first.sha256;
      if (kind === 'short') f.bodies[first.archivePath] = Uint8Array.from([1]);
      if (kind === 'long') f.bodies[first.archivePath] = Uint8Array.from([1, 2, 3, 4, 5]);
      if (kind === 'second-bad') f.bodies[second.archivePath] = Uint8Array.from([9, 9, 9, 9]);
      if (kind === 'second-missing') delete f.bodies[second.archivePath];
      if (kind === 'foreign') { first.sourceId = randomUUID(); first.archivePath = `objects/${first.sourceId}/v1.bin`; keys.push(storage.finalKey(first.sourceId, 1)); }
      if (kind === 'duplicate') f.backup.objects.push({ ...first });
      if (kind === 'missing-version') { first.archivePath = `objects/${first.sourceId}/v2.bin`; }
      if (kind === 'metadata-bytes') first.bytes++;
      if (kind === 'metadata-hash') first.sha256 = 'ab'.repeat(32);
      if (kind === 'duplicate-source') f.backup.tables.opening_sources!.push({ ...f.backup.tables.opening_sources![0] as object });
      if (kind === 'duplicate-version') {
        const version = { source_id: first.sourceId, workspace_id: f.workspaceId, version: 1, bytes: first.bytes, sha256: first.sha256, availability: 'available' };
        f.backup.tables.opening_source_versions = [version, { ...version }];
      }
      const before = await readOpeningRestoreNamespaceCounts(sql, f.workspaceId);
      const writer = createOpeningS3RestoreObjectPut(storage);
      const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, sql, objectPut: writer, objectBodies: f.bodies });
      expect(result.code).toBe('PREFLIGHT_REJECTED'); expect(result.mutated).toBe(false);
      expect(result.errors.join(' ')).toMatch(/object integrity/);
      expect(writer.keys).toHaveLength(0);
      await f.unchanged(before);
    });
  it('publishes two verified snapshots even if caller bodies change during the first PUT', async () => {
    const f = await fixture(2), writer = createOpeningS3RestoreObjectPut(storage);
    const sentinel = storage.finalKey(randomUUID(), 1), sentinelBody = Uint8Array.from([8, 7]); keys.push(sentinel);
    await storage.putObject(sentinel, sentinelBody);
    const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, sql, objectBodies: f.bodies,
      objectPut: { async put(input) {
        for (const body of Object.values(f.bodies)) body.fill(0);
        await writer.put(input);
      } } });
    expect(result.code).toBe('APPLY_OK');
    expect(writer.keys).toHaveLength(2);
    for (const object of f.backup.objects) expect(await storage.streamDigest(storage.finalKey(object.sourceId, 1)))
      .toMatchObject({ bytes: object.bytes, sha256: object.sha256 });
    expect(await storage.streamDigest(sentinel)).toMatchObject({ bytes: sentinelBody.length, sha256: hash(sentinelBody) });
  });
});
