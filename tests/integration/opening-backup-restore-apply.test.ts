/**
 * Q03 Opening restore apply against OPENING_TEST_DATABASE_URL + live MinIO.
 * Dedicated empty workspace UUID + source keys only — never wipes shared DB/bucket.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import type { OpeningBackup } from "@aistudy/domain";
import {
  applyOpeningRestore,
  createOpeningBackupReader,
  createOpeningS3RestoreObjectPut,
  createSqlClient,
  exportOpeningBackup,
  OPENING_BACKUP_TABLES,
  publishOpeningBackupArchive,
  readOpeningRestoreNamespaceCounts,
} from "@aistudy/database";
import { createOpeningTestStorage } from "./opening-storage-fixture";

const dbEnabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);
const s3Enabled = Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID);
const enabled = dbEnabled && s3Enabled;

describe.skipIf(!enabled)("opening restore apply executor (empty workspace UUID + live MinIO)", () => {
  const url = assertOpeningTestDatabase(
    process.env.OPENING_TEST_DATABASE_URL ?? "",
    process.env.OPENING_TEST_DB,
  );
  const sql = createSqlClient(url.toString(), { max: 1 });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();
  const storage = createOpeningTestStorage();
  const trackedKeys: string[] = [];

  afterAll(async () => {
    try {
      for (const key of [...new Set(trackedKeys)]) {
        try {
          await storage.deleteObject(key);
        } catch {
          /* best-effort dedicated key cleanup */
        }
      }
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    } finally {
      if (storage.client instanceof S3Client) storage.client.destroy();
      await sql.end({ timeout: 1 });
    }
  });

  it("applies opening_sources + live MinIO objectPut (objectApplyDeferred=false)", async () => {
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${userId}, ${`${userId}@q03-apply.example`}, 'Q03 apply', 'test')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${userId})
    `;

    const before = await readOpeningRestoreNamespaceCounts(sql, workspaceId);
    for (const table of OPENING_BACKUP_TABLES) {
      expect(before[table]).toBe(0);
    }

    const body = new Uint8Array([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const draft: OpeningBackup = {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: 0,
      deletionJournal: [],
      tables: Object.fromEntries(
        OPENING_BACKUP_TABLES.map((name) => [
          name,
          name === "opening_sources"
            ? [{
                id: sourceId,
                workspace_id: workspaceId,
                name: "q03-apply.bin",
                mime: "application/octet-stream",
                bytes: body.byteLength,
                sha256,
                version: 1,
                upload_state: "uploaded",
                parse_state: "ready",
              }]
            : [],
        ]),
      ),
      objects: [{
        sourceId,
        sha256,
        bytes: body.byteLength,
        archivePath: `objects/${sourceId}/v1.bin`,
      }],
    };

    const objectPut = createOpeningS3RestoreObjectPut(storage);
    const result = await applyOpeningRestore({
      confirmLocalRestore: true,
      backup: draft,
      currentDeletionJournal: [],
      sql,
      objectPut,
      objectBodies: { [`objects/${sourceId}/v1.bin`]: body },
    });

    trackedKeys.push(...objectPut.keys);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe("APPLY_OK");
    expect(result.mutated).toBe(true);
    expect(result.emptyNamespaceVerified).toBe(true);
    expect(result.rowsInserted).toBe(1);
    expect(result.objectsApplied).toBe(1);
    expect(result.objectApplyDeferred).toBe(false);
    expect(result.guarantees.secretsRestored).toBe(false);
    expect(result.guarantees.apiKeysRestored).toBe(false);
    expect(result.guarantees.sessionsRestored).toBe(false);
    expect(result.guarantees.pendingJobs).toBe("cancelled");

    const finalKey = storage.finalKey(sourceId, 1);
    expect(objectPut.keys).toEqual([finalKey]);
    const head = await storage.headObject(finalKey);
    expect(head.exists).toBe(true);
    expect(head.bytes).toBe(body.byteLength);
    const digest = await storage.streamDigest(finalKey);
    expect(digest.sha256).toBe(sha256);

    const [row] = await sql`
      SELECT id::text AS id, name, upload_state FROM opening_sources
      WHERE workspace_id = ${workspaceId} AND id = ${sourceId}
    `;
    expect(row).toMatchObject({ id: sourceId, name: "q03-apply.bin", upload_state: "uploaded" });

    const after = await readOpeningRestoreNamespaceCounts(sql, workspaceId);
    expect(after.opening_sources).toBe(1);

    // Fail-closed: second apply must see non-empty namespace
    const again = await applyOpeningRestore({
      confirmLocalRestore: true,
      backup: draft,
      currentDeletionJournal: [],
      sql,
      objectPut,
      objectBodies: { [`objects/${sourceId}/v1.bin`]: body },
    });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("TARGET_NOT_EMPTY");
    expect(again.mutated).toBe(false);
  });
});

describe.skipIf(!enabled)("opening export→archive→apply live MinIO E2E (dedicated UUID)", () => {
  const url = assertOpeningTestDatabase(
    process.env.OPENING_TEST_DATABASE_URL ?? "",
    process.env.OPENING_TEST_DB,
  );
  const sql = createSqlClient(url.toString(), { max: 1 });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const storage = createOpeningTestStorage();
  const reader = createOpeningBackupReader(storage);
  const trackedKeys: string[] = [];
  let scratch = "";

  afterAll(async () => {
    try {
      for (const key of [...new Set(trackedKeys)]) {
        try {
          await storage.deleteObject(key);
        } catch {
          /* best-effort */
        }
      }
      if (scratch) await rm(scratch, { recursive: true, force: true });
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    } finally {
      if (storage.client instanceof S3Client) storage.client.destroy();
      await sql.end({ timeout: 1 });
    }
  });

  it("exports seeded workspace, empties durable rows, applies with live objectPut", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "q03-export-apply-"));
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${userId}, ${`${userId}@q03-e2e.example`}, 'Q03 e2e', 'test')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${userId})
    `;

    const sourceId = randomUUID();
    const body = Buffer.from("Q03 live export apply bytes\n", "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");
    await sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (
        ${sourceId}, ${workspaceId}, 'e2e.txt', 'text/plain', ${body.byteLength}, ${sha256},
        1, 'uploaded', 'ready'
      )
    `;
    // Cancel-path seed: queued job must be cancelled on apply, never restored as paid
    await sql`
      INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${userId}, ${`q03-e2e-seed-${sourceId}`},
        'parse', ${sql.json({ sourceId })}, 'queued'
      )
    `;

    const seedKey = storage.finalKey(sourceId, 1);
    await storage.putObject(seedKey, body, { mime: "text/plain" });
    trackedKeys.push(seedKey);

    const scope = { workspaceId, ownerUserId: userId };
    const backup = await exportOpeningBackup(sql, scope, scratch, reader);
    expect(backup.workspaceId.toLowerCase()).toBe(workspaceId.toLowerCase());
    expect(backup.objects.length).toBeGreaterThanOrEqual(1);
    expect(backup.tables.opening_sources?.length).toBe(1);

    const entries = await readdir(scratch);
    const stagingName = entries.find((e) => e.startsWith("opening-backup-"));
    expect(stagingName).toBeTruthy();
    const stagingDirectory = path.join(scratch, stagingName!);

    const archivePath = path.join(scratch, "backup.opening");
    await publishOpeningBackupArchive(backup, stagingDirectory, archivePath);

    // Empty this workspace's durable restore namespace only (dedicated UUID — not shared wipe)
    await sql`DELETE FROM opening_jobs WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM opening_sources WHERE workspace_id = ${workspaceId}`;
    await storage.deleteObject(seedKey);

    const empty = await readOpeningRestoreNamespaceCounts(sql, workspaceId);
    for (const table of OPENING_BACKUP_TABLES) {
      expect(empty[table]).toBe(0);
    }

    // Re-seed a queued job so apply can cancel it
    await sql`
      INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${userId}, ${`q03-e2e-pre-${randomUUID()}`},
        'parse', ${sql.json({ note: "pre-restore" })}, 'queued'
      )
    `;

    // Empty target: owner-scoped memory deletion facts required when backup carries memoryDeletions.
    const objectPut = createOpeningS3RestoreObjectPut(storage);
    const result = await applyOpeningRestore({
      confirmLocalRestore: true,
      backup,
      currentDeletionJournal: [],
      currentMemoryDeletions: { workspaceId: backup.workspaceId, memories: [] },
      sql,
      objectPut,
      stagingDirectory,
    });
    trackedKeys.push(...objectPut.keys);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe("APPLY_OK");
    expect(result.mutated).toBe(true);
    expect(result.objectApplyDeferred).toBe(false);
    expect(result.objectsApplied).toBeGreaterThanOrEqual(1);
    expect(result.pendingJobsCancelled).toBeGreaterThanOrEqual(1);
    expect(result.guarantees.secretsRestored).toBe(false);
    expect(result.guarantees.apiKeysRestored).toBe(false);
    expect(result.guarantees.sessionsRestored).toBe(false);
    expect(result.guarantees.pendingJobs).toBe("cancelled");

    const restoredKey = storage.finalKey(sourceId, 1);
    const head = await storage.headObject(restoredKey);
    expect(head.exists).toBe(true);
    const digest = await storage.streamDigest(restoredKey);
    expect(digest.sha256).toBe(sha256);

    const [job] = await sql`
      SELECT state::text AS state FROM opening_jobs
      WHERE workspace_id = ${workspaceId} AND state = 'cancelled'
      LIMIT 1
    `;
    expect(job?.state).toBe("cancelled");

    const [src] = await sql`
      SELECT id::text AS id, name FROM opening_sources
      WHERE workspace_id = ${workspaceId} AND id = ${sourceId}
    `;
    expect(src).toMatchObject({ id: sourceId, name: "e2e.txt" });
  });
});


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function spawnOpeningRestore(
  args: string[],
  childEnv: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), "scripts/opening-restore.ts", ...args],
      {
        cwd: repoRoot,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!enabled)("opening-restore CLI spawn APPLY_OK (live DB+S3)", () => {
  const url = assertOpeningTestDatabase(
    process.env.OPENING_TEST_DATABASE_URL ?? "",
    process.env.OPENING_TEST_DB,
  );
  const sql = createSqlClient(url.toString(), { max: 1 });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();
  const storage = createOpeningTestStorage();
  const trackedKeys: string[] = [];
  let scratch = "";

  afterAll(async () => {
    try {
      for (const key of [...new Set(trackedKeys)]) {
        try {
          await storage.deleteObject(key);
        } catch {
          /* best-effort */
        }
      }
      if (scratch) await rm(scratch, { recursive: true, force: true });
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    } finally {
      if (storage.client instanceof S3Client) storage.client.destroy();
      await sql.end({ timeout: 1 });
    }
  });

  it("CLI confirm+draft+live env → APPLY_OK mutated=true (spawn scripts/opening-restore.ts)", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "q03-cli-apply-"));
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${userId}, ${`${userId}@q03-cli.example`}, 'Q03 CLI', 'test')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${userId})
    `;

    const body = new Uint8Array([9, 8, 7, 6]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const archivePath = `objects/${sourceId}/v1.bin`;
    const stagingDir = path.join(scratch, "staging");
    await mkdir(path.join(stagingDir, "objects", sourceId), { recursive: true });
    await writeFile(path.join(stagingDir, archivePath), body);

    const draft: OpeningBackup = {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: 0,
      deletionJournal: [],
      tables: Object.fromEntries(
        OPENING_BACKUP_TABLES.map((name) => [
          name,
          name === "opening_sources"
            ? [{
                id: sourceId,
                workspace_id: workspaceId,
                name: "q03-cli.bin",
                mime: "application/octet-stream",
                bytes: body.byteLength,
                sha256,
                version: 1,
                upload_state: "uploaded",
                parse_state: "ready",
              }]
            : [],
        ]),
      ),
      objects: [{
        sourceId,
        sha256,
        bytes: body.byteLength,
        archivePath,
      }],
    };
    const draftPath = path.join(scratch, "draft.json");
    await writeFile(draftPath, JSON.stringify(draft), "utf8");

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENING_TEST_DATABASE_URL: url.toString(),
      OPENING_RESTORE_DATABASE_URL: url.toString(),
      // Prefer restore URL; keep S3_* from parent (.env / shell)
    };

    const spawned = await spawnOpeningRestore(
      [
        "--confirm-local-restore",
        "--draft",
        draftPath,
        "--staging",
        stagingDir,
      ],
      childEnv,
    );

    expect(spawned.stderr).toMatch(/APPLY_OK/);
    expect(spawned.stderr).toMatch(/mutated=true/);
    expect(spawned.stderr).not.toMatch(/LIVE_DEPS_MISSING|APPLY_EXECUTOR_DEFERRED/);
    expect(spawned.code).toBe(0);

    const finalKey = storage.finalKey(sourceId, 1);
    trackedKeys.push(finalKey);
    const head = await storage.headObject(finalKey);
    expect(head.exists).toBe(true);
    const digest = await storage.streamDigest(finalKey);
    expect(digest.sha256).toBe(sha256);

    const [row] = await sql`
      SELECT id::text AS id, name FROM opening_sources
      WHERE workspace_id = ${workspaceId} AND id = ${sourceId}
    `;
    expect(row).toMatchObject({ id: sourceId, name: "q03-cli.bin" });
  });
});

describe.skipIf(!enabled)("opening-restore CLI spawn fail-closed without sql env", () => {
  it("confirm+draft but no DB URL env → LIVE_DEPS_MISSING (not APPLY_OK)", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "q03-cli-nodeps-"));
    try {
      const workspaceId = randomUUID();
      const draft: OpeningBackup = {
        format: "opening-backup",
        version: 1,
        workspaceId,
        privacyEpoch: 0,
        deletionJournal: [],
        tables: Object.fromEntries(OPENING_BACKUP_TABLES.map((name) => [name, []])),
        objects: [],
      };
      const draftPath = path.join(scratch, "draft.json");
      await writeFile(draftPath, JSON.stringify(draft), "utf8");

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OPENING_RESTORE_DATABASE_URL: "",
        OPENING_TEST_DATABASE_URL: "",
        DATABASE_URL: "",
      };
      // Ensure emptied (some shells keep empty as unset — delete keys too)
      delete childEnv.OPENING_RESTORE_DATABASE_URL;
      delete childEnv.OPENING_TEST_DATABASE_URL;
      delete childEnv.DATABASE_URL;

      const spawned = await spawnOpeningRestore(
        ["--confirm-local-restore", "--draft", draftPath],
        childEnv,
      );

      expect(spawned.code).toBe(1);
      expect(spawned.stderr).toMatch(/LIVE_DEPS_MISSING/);
      expect(spawned.stderr).toMatch(/OPENING_RESTORE_DATABASE_URL\|OPENING_TEST_DATABASE_URL\|DATABASE_URL/);
      expect(spawned.stderr).not.toMatch(/APPLY_OK/);
      expect(spawned.stderr).not.toMatch(/minioadmin|postgres:\/\//);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
