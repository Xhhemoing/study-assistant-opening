import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import { createSqlClient } from "../../packages/database/src/migrate";
import { applyOpeningRestore, createOpeningS3RestoreObjectPut } from "../../packages/database/src/repositories/opening-backup";
import { OpeningStorageError } from "../../packages/database/src/storage/opening-s3";
import { createOpeningTestStorage } from "./opening-storage-fixture";
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const enabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL && process.env.S3_ENDPOINT);
describe.skipIf(!enabled)("restore object side effects", () => {
  const sql = createSqlClient(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
  const storage = createOpeningTestStorage();
  const scopes: { workspaceId: string; userId: string }[] = [];
  const keys: string[] = [];
  afterAll(async () => {
    try {
      if (keys.length) {
        const result = await storage.client.send(new DeleteObjectsCommand({ Bucket: storage.bucket,
          Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }));
        if (result.Errors?.length) throw new Error("fixture cleanup failed");
      }
      if (scopes.length) {
        await sql`DELETE FROM workspaces WHERE id=ANY(${sql.array(scopes.map(s => s.workspaceId))}::uuid[])`;
        await sql`DELETE FROM users WHERE id=ANY(${sql.array(scopes.map(s => s.userId))}::uuid[])`;
      }
    } finally {
      if (storage.client instanceof S3Client) storage.client.destroy();
      await sql.end({ timeout: 1 });
    }
  });
  async function fixture(count = 1) {
    const workspaceId = randomUUID(), userId = randomUUID();
    scopes.push({ workspaceId, userId });
    await sql`INSERT INTO users (id,email,display_name,password_hash) VALUES (${userId},${`${userId}@br03.example`},'BR03','test')`;
    await sql`INSERT INTO workspaces (id,owner_user_id) VALUES (${workspaceId},${userId})`;
    await sql`INSERT INTO opening_jobs (id,workspace_id,owner_user_id,key,kind,payload,state)
      VALUES (${randomUUID()},${workspaceId},${userId},${randomUUID()},'parse','{}','queued')`;
    const bodies: Record<string, Uint8Array> = {};
    const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0,
      deletionJournal: [], tables: { opening_sources: [] }, objects: [] };
    for (let i = 0; i < count; i++) {
      const sourceId = randomUUID(), body = Uint8Array.from([1, 2, 3, i + 4]);
      const archivePath = `objects/${sourceId}/v1.bin`, sha256 = hash(body);
      backup.tables.opening_sources!.push({ id: sourceId, workspace_id: workspaceId, name: 'br03.bin',
        mime: 'application/octet-stream', bytes: body.length, sha256, version: 1, upload_state: 'uploaded', parse_state: 'ready' });
      backup.objects.push({ sourceId, archivePath, sha256, bytes: body.length });
      bodies[archivePath] = body;
      keys.push(storage.finalKey(sourceId, 1));
    }
    return { workspaceId, backup, bodies };
  }
  it('cleans first real PUT after second conditional PUT fails and rolls SQL/jobs back', async () => {
    const f = await fixture(2), first = f.backup.objects[0]!, second = f.backup.objects[1]!;
    const firstKey = storage.finalKey(first.sourceId, 1), secondKey = storage.finalKey(second.sourceId, 1);
    const original = Uint8Array.from([8, 7, 6]);
    await storage.putObject(secondKey, original);
    const writer = createOpeningS3RestoreObjectPut({
      finalKey: (id, version) => storage.finalKey(id, version),
      async putObject(key, body, input) {
        if (key === secondKey) throw new OpeningStorageError('CONFLICT', 'controlled second PUT failure');
        await storage.putObject(key, body, input);
      },
      deleteObject: key => storage.deleteObject(key),
    });
    const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, sql,
      objectBodies: f.bodies, objectPut: writer });
    console.log('BR03 partial PUT result', result.code, result.mutated, 'first exists', (await storage.headObject(firstKey)).exists);
    expect(writer.keys).toEqual([firstKey]);
    expect(result).toMatchObject({ code: 'APPLY_FAILED', mutated: false,
      objectSideEffects: { status: 'clean', createdKeys: [firstKey], remainingKeys: [], unknownKeys: [] } });
    expect((await storage.headObject(firstKey)).exists).toBe(false);
    expect(await storage.streamDigest(secondKey)).toMatchObject({ sha256: hash(original), bytes: original.length });
    expect(await sql`SELECT id FROM opening_sources WHERE workspace_id=${f.workspaceId}`).toHaveLength(0);
    const [job] = await sql`SELECT state FROM opening_jobs WHERE workspace_id=${f.workspaceId}`;
    expect(job?.state).toBe('queued');
  });
  it('refuses an existing final key without overwriting or deleting its bytes', async () => {
    const f = await fixture(2), second = f.backup.objects[1]!;
    const key = storage.finalKey(second.sourceId, 1), original = Uint8Array.from([8, 7, 6]);
    await storage.putObject(key, original);
    const writer = createOpeningS3RestoreObjectPut(storage);
    const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, sql,
      objectBodies: f.bodies, objectPut: writer });
    expect(result).toMatchObject({ code: 'APPLY_FAILED', mutated: false, objectSideEffects: { status: 'clean' } });
    expect((await storage.headObject(storage.finalKey(f.backup.objects[0]!.sourceId, 1))).exists).toBe(false);
    expect(await storage.streamDigest(key)).toMatchObject({ bytes: original.length, sha256: hash(original) });
  });
  it.each(['cleanup-fails', 'put-ack-lost', 'generic-writer'] as const)('reports %s honestly through the public entrypoint', async kind => {
    const f = await fixture(2), first = f.backup.objects[0]!, second = f.backup.objects[1]!;
    const firstKey = storage.finalKey(first.sourceId, 1), secondKey = storage.finalKey(second.sourceId, 1);
    const writer = createOpeningS3RestoreObjectPut({
      finalKey: (id, version) => storage.finalKey(id, version),
      async putObject(key, body, input) {
        if (key === secondKey) {
          if (kind === 'put-ack-lost') {
            await storage.putObject(key, body, input);
            throw new OpeningStorageError('UNAVAILABLE', 'lost acknowledgement');
          }
          throw new OpeningStorageError('CONFLICT', 'controlled second PUT failure');
        }
        await storage.putObject(key, body, input);
      },
      async deleteObject(key) {
        if (kind === 'cleanup-fails') throw new Error('cleanup unavailable');
        await storage.deleteObject(key);
      },
    });
    const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, sql,
      objectBodies: f.bodies, objectPut: kind === 'generic-writer' ? { put: input => writer.put(input) } : writer });
    expect(result).toMatchObject({ code: 'APPLY_FAILED', mutated: true,
      objectSideEffects: kind === 'cleanup-fails'
        ? { status: 'remaining', createdKeys: [firstKey], remainingKeys: [firstKey], unknownKeys: [] }
        : kind === 'put-ack-lost'
          ? { status: 'unknown', createdKeys: [firstKey], remainingKeys: [], unknownKeys: [secondKey] }
          : { status: 'unknown' } });
    expect((await storage.headObject(firstKey)).exists).toBe(kind !== 'put-ack-lost');
    expect((await storage.headObject(secondKey)).exists).toBe(kind === 'put-ack-lost');
    expect(await sql`SELECT id FROM opening_sources WHERE workspace_id=${f.workspaceId}`).toHaveLength(0);
    const [job] = await sql`SELECT state FROM opening_jobs WHERE workspace_id=${f.workspaceId}`;
    expect(job?.state).toBe('queued');
  });
  it('restores two new objects and reads back their hashes', async () => {
    const f = await fixture(2), writer = createOpeningS3RestoreObjectPut(storage);
    const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, sql,
      objectBodies: f.bodies, objectPut: writer });
    expect(result).toMatchObject({ code: 'APPLY_OK', objectsApplied: 2 });
    for (const object of f.backup.objects) expect(await storage.streamDigest(storage.finalKey(object.sourceId, 1)))
      .toMatchObject({ bytes: object.bytes, sha256: object.sha256 });
  });
});
