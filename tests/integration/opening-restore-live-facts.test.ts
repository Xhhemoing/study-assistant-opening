import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createSqlClient } from "../../packages/database/src/migrate";
import { applyOpeningRestore, exportOpeningBackup, readOpeningRestoreNamespaceCounts } from "../../packages/database/src/repositories/opening-backup";
import { readOpeningRestoreCurrentFacts, snapshotOpeningRestoreCurrentFacts } from "../../packages/database/src/repositories/opening-restore-current-facts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const enabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);
describe.skipIf(!enabled)("real export → serialized CLI live facts", () => {
  const sql = createSqlClient(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
  const owned: { workspaceId: string; ownerUserId: string }[] = [];
  const directories: string[] = [];
  afterAll(async () => {
    try {
      for (const scope of owned) {
        await sql`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
        await sql`DELETE FROM users WHERE id=${scope.ownerUserId}`;
      }
      for (const dir of directories) await rm(dir, { recursive: true, force: true });
    } finally { await sql.end({ timeout: 1 }); }
  });
  async function fixture(withLearningState = false) {
    const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    owned.push(scope);
    await sql`INSERT INTO users (id,email,display_name,password_hash) VALUES
      (${scope.ownerUserId},${`${scope.ownerUserId}@br01.example`},'BR01','test')`;
    await sql`INSERT INTO workspaces (id,owner_user_id) VALUES (${scope.workspaceId},${scope.ownerUserId})`;
    if (withLearningState) {
      await sql`INSERT INTO workspace_preferences (workspace_id,assessment_enabled) VALUES (${scope.workspaceId},true)`;
      await sql`INSERT INTO courses (id,workspace_id,title,slug) VALUES (${randomUUID()},${scope.workspaceId},'BR01','br01')`;
    }
    const directory = await mkdtemp(path.join(tmpdir(), "br01-cli-"));
    directories.push(directory);
    const backup = await exportOpeningBackup(sql, scope, directory, {
      finalKey() { throw new Error("empty source inventory must not read objects"); },
      async readObject() { throw new Error("empty source inventory must not read objects"); },
    });
    const draft = path.join(directory, "draft.json");
    await writeFile(draft, JSON.stringify(backup));
    const config = path.join(directory, "tsx.json");
    await writeFile(config, JSON.stringify({ compilerOptions: { baseUrl: root, paths: {
      "@aistudy/domain": ["packages/domain/src/index.ts"],
      "@aistudy/contracts": ["packages/contracts/src/index.ts"],
      "@aistudy/config": ["packages/config/src/index.ts"],
    } } }));
    async function cli(args: string[] = []) {
      return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import",path.join(root,"node_modules/tsx/dist/loader.mjs"),
          "scripts/opening-restore.ts","--confirm-local-restore","--draft",draft,...args],
        { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: config,
          OPENING_RESTORE_DATABASE_URL: process.env.OPENING_TEST_DATABASE_URL }, stdio: ["ignore","pipe","pipe"] });
        let output = "";
        // A cold real CLI import takes ~21s on the shared host; bound this one child,
        // not the project timeout, and surface partial output if it cannot finish.
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`restore CLI did not finish within 60s: ${output}`));
        }, 60000);
        child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
        child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
        child.on("error", reject);
        child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
      });
    }
    return { scope, backup, draft, cli };
  }
  it("restores an actual empty-inventory export without inventing deletion facts", async () => {
    const { cli, backup } = await fixture();
    expect(backup.memoryDeletions).toBeDefined();
    const result = await cli();
    expect(result.output).toContain("code=APPLY_OK");
    expect(result.code).toBe(0);
  }, 90000);
  it("live dry-run reads preferences/courses without writes or S3; offline remains closed", async () => {
    const f = await fixture(true);
    const before = await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId);
    const offline = await f.cli(["--dry-run"]);
    expect(offline.code).toBe(1);
    expect(offline.output).toContain("current owner-scoped memory deletion facts are required");
    const live = await f.cli(["--dry-run", "--live-preflight"]);
    expect(live.output).toContain("code=DRY_RUN_OK");
    expect(live.code).toBe(0);
    expect(await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId)).toEqual(before);
    await sql`DELETE FROM courses WHERE workspace_id=${f.scope.workspaceId}`;
    await sql`DELETE FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`;
    const restored = await f.cli();
    expect(restored.output).toContain("code=APPLY_OK");
    expect(restored.code).toBe(0);
    const [prefs] = await sql`SELECT assessment_enabled FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`;
    expect(prefs?.assessment_enabled).toBe(true);
    expect((await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId)).courses).toBe(1);
  }, 210000);
  it("rejects current closed preferences and preserves their microsecond activation", async () => {
    const f = await fixture(true);
    // Use the real activation trigger: enabling records a server timestamp, while
    // disabling assessment must clear it rather than retaining a forged cutoff.
    const [enabled] = await sql`UPDATE workspace_preferences
      SET assessment_enabled=true,retest_suggestions_enabled=true
      WHERE workspace_id=${f.scope.workspaceId}
      RETURNING to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activation`;
    const activeFacts = await snapshotOpeningRestoreCurrentFacts(sql, f.backup);
    expect(enabled?.activation).toMatch(/\.\d{6}Z$/);
    expect(activeFacts.currentLearningState.workspacePreferences?.retest_suggestions_enabled_at).toBe(enabled?.activation);
    await sql`UPDATE workspace_preferences SET assessment_enabled=false
      WHERE workspace_id=${f.scope.workspaceId}`;
    const facts = await snapshotOpeningRestoreCurrentFacts(sql, f.backup);
    expect(facts.currentLearningState.workspacePreferences?.retest_suggestions_enabled_at).toBeNull();
    const before = await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId);
    const result = await f.cli();
    expect(result.code).toBe(1);
    expect(result.output).toContain("closed learning preference");
    expect(await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId)).toEqual(before);
  }, 90000);
  it("rejects current source deletions before cancelling jobs or applying objects", async () => {
    const f = await fixture();
    await sql`INSERT INTO opening_privacy_exclusions (id,workspace_id,source_id,deleted_at)
      VALUES (${randomUUID()},${f.scope.workspaceId},${randomUUID()},now())`;
    const before = await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId);
    const result = await f.cli();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/JOURNAL_DRIFT|PREFLIGHT_REJECTED/);
    expect(await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId)).toEqual(before);
  }, 90000);
  it("rejects foreign scope and missing targets rather than returning empty facts", async () => {
    const a = await fixture(), b = await fixture();
    await expect(sql.begin(tx => readOpeningRestoreCurrentFacts(tx, a.scope.workspaceId, b.scope.ownerUserId)))
      .rejects.toThrow("owner is missing or changed");
    await writeFile(a.draft, JSON.stringify({ ...a.backup, workspaceId: randomUUID(), ownerUserId: b.scope.ownerUserId }));
    const result = await a.cli(["--dry-run", "--live-preflight"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("restore workspace owner is missing");
  }, 90000);
  it("executor rechecks deletions after caller snapshot and before all side effects", async () => {
    const f = await fixture();
    const facts = await snapshotOpeningRestoreCurrentFacts(sql, f.backup);
    await sql`INSERT INTO opening_jobs (id,workspace_id,owner_user_id,key,kind,payload,state)
      VALUES (${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},${randomUUID()},'parse', '{}','queued')`;
    await sql`INSERT INTO opening_privacy_exclusions (id,workspace_id,source_id,deleted_at)
      VALUES (${randomUUID()},${f.scope.workspaceId},${randomUUID()},now())`;
    let puts = 0;
    const result = await applyOpeningRestore({ confirmLocalRestore: true, backup: f.backup, ...facts, sql,
      objectPut: { async put() { puts++; } } });
    expect(result.code).toBe("JOURNAL_DRIFT");
    expect(result.mutated).toBe(false);
    expect(puts).toBe(0);
    const [job] = await sql`SELECT state FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`;
    expect(job?.state).toBe("queued");
  }, 90000);
  it("does not clear memory tombstones to manufacture an empty target", async () => {
    const f = await fixture();
    await sql`INSERT INTO opening_memories (id,workspace_id,kind,text,source_turn_ids,version,status)
      VALUES (${randomUUID()},${f.scope.workspaceId},'candidate','BR01 tombstone','[]'::jsonb,0,'deleted')`;
    const before = await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId);
    const result = await f.cli();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/JOURNAL_DRIFT|PREFLIGHT_REJECTED/);
    expect(await readOpeningRestoreNamespaceCounts(sql, f.scope.workspaceId)).toEqual(before);
    // A current export includes the same tombstone facts, but empty-namespace still rejects it.
    const facts = await snapshotOpeningRestoreCurrentFacts(sql, f.backup);
    const current = { ...f.backup, memoryDeletions: facts.currentMemoryDeletions };
    const matching = await applyOpeningRestore({ confirmLocalRestore: true, backup: current, ...facts, sql });
    expect(matching.code).toBe("TARGET_NOT_EMPTY");
  }, 90000);
});
