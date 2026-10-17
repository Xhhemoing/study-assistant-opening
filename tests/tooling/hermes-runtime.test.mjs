import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { postgresBackupEnvironment } from "../../infra/deploy/hermes-db.mjs";
import { VISIBLE_FLAGS, verifyProcessSnapshot } from "../../infra/deploy/hermes-health.mjs";

const release = "/opt/aistudy-releases/new-sha";
const configured = { OPENING_ADAPTIVE_PLANNING: "0", OPENING_TEACHING_LOOP: "1", OPENING_MODEL_DAILY_CAP_CENTS: "0", DATABASE_URL: "never-print-secret" };
const web = {
  kind: "web", pid: 123, unitUser: "", uid: 0, cwd: `${release}/apps/web/.next/standalone/apps/web`,
  executable: "/usr/bin/node", unitExecutable: "/usr/bin/node", unitWorkingDirectory: release,
  argumentPaths: ["/usr/bin/node", `${release}/apps/web/.next/standalone/apps/web/server.js`],
  unitArgumentPaths: ["/usr/bin/node", `${release}/apps/web/.next/standalone/apps/web/server.js`],
  environment: { ...configured, PROVIDER_SECRET: "hidden-key" },
};
const worker = {
  kind: "worker", pid: 124, unitUser: "aistudy-worker", uid: 1001, accountUid: 1001, cwd: release,
  executable: "/usr/bin/node", unitExecutable: "/usr/bin/node", unitWorkingDirectory: release,
  argumentPaths: ["/usr/bin/node", `${release}/node_modules/tsx/dist/cli.mjs`, `${release}/apps/worker/src/index.ts`],
  unitArgumentPaths: ["/usr/bin/node", `${release}/node_modules/tsx/dist/cli.mjs`, `${release}/apps/worker/src/index.ts`],
  environment: { ...configured },
};

test("runtime identity checks the actual cwd and command paths and returns only allowlisted flags", () => {
  const result = verifyProcessSnapshot(web, release, configured);
  assert.equal(result.pid, 123);
  assert.equal(result.release, release);
  assert.equal(result.flags.OPENING_ADAPTIVE_PLANNING, "0");
  assert.equal(result.flags.OPENING_CHAT_PROSE, "unset");
  assert.deepEqual(Object.keys(result.flags), VISIBLE_FLAGS);
  assert.doesNotMatch(JSON.stringify(result), /never-print-secret|hidden-key|DATABASE_URL/);
  assert.equal(verifyProcessSnapshot(worker, release, configured).user, "aistudy-worker");
});

test("a healthy old web process or wrong ExecStart cannot sign off the new release", () => {
  assert.throws(() => verifyProcessSnapshot({ ...web, cwd: "/opt/aistudy/apps/web" }, release, configured), /different release/);
  assert.throws(() => verifyProcessSnapshot({ ...web, unitArgumentPaths: ["/opt/aistudy/apps/web/server.js"] }, release, configured), /different release/);
  assert.throws(() => verifyProcessSnapshot({ ...web, pid: 0 }, release, configured), /MainPID/);
});

test("worker identity rejects root, an overridden unit user, and stale code paths", () => {
  assert.throws(() => verifyProcessSnapshot({ ...worker, uid: 0 }, release, configured), /non-root/);
  assert.throws(() => verifyProcessSnapshot({ ...worker, uid: 1002 }, release, configured), /non-root/);
  assert.throws(() => verifyProcessSnapshot({ ...worker, unitUser: "root" }, release, configured), /non-root/);
  assert.throws(() => verifyProcessSnapshot({ ...worker, cwd: "/opt/aistudy" }, release, configured), /different release/);
  assert.throws(() => verifyProcessSnapshot({ ...worker, argumentPaths: ["/old/worker.js"] }, release, configured), /different release/);
});

test("allowlisted flags must match parsed configuration instead of just being printed", () => {
  assert.throws(() => verifyProcessSnapshot({ ...web, environment: { ...configured, OPENING_ADAPTIVE_PLANNING: "1" } }, release, configured), /differs: OPENING_ADAPTIVE_PLANNING/);
  assert.throws(() => verifyProcessSnapshot({ ...worker, environment: {} }, release, configured), /differs/);
  assert.throws(() => verifyProcessSnapshot(web, release, { ...configured, OPENING_TEACHING_LOOP: "invalid" }), /Invalid allowlisted/);
});

test("backup environment comes only from the PostgreSQL URL and clears ambient PG routing", () => {
  const env = postgresBackupEnvironment("postgres://user:p%40ss@127.0.0.1:5433/target?sslmode=require", {
    PATH: "/bin", PGDATABASE: "wrong", PGHOST: "elsewhere", PGUSER: "other", PGPASSWORD: "stale",
    PGSERVICE: "other-db", PGSERVICEFILE: "/other/file", PGPASSFILE: "/other/password", PGOPTIONS: "-c search_path=other",
  });
  assert.equal(env.PGHOST, "127.0.0.1");
  assert.equal(env.PGPORT, "5433");
  assert.equal(env.PGDATABASE, "target");
  assert.equal(env.PGUSER, "user");
  assert.equal(env.PGPASSWORD, "p@ss");
  assert.equal(env.PGSSLMODE, "require");
  assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.PGSERVICEFILE, undefined);
  assert.equal(env.PGPASSFILE, undefined);
  assert.equal(env.PGOPTIONS, undefined);
  assert.equal(env.PATH, "/bin");
});

test("backup supports IPv6 and fails closed on ambiguous or unsupported URL overrides", () => {
  assert.equal(postgresBackupEnvironment("postgres://user:password@[::1]:5432/db", {}).PGHOST, "::1");
  for (const suffix of ["host=elsewhere", "dbname=wrong", "password=other", "ssl=true", "sslmode=require&sslmode=disable"]) {
    assert.throws(() => postgresBackupEnvironment(`postgres://user:password@localhost/db?${suffix}`, {}), /Unsupported or duplicate/);
  }
  assert.throws(() => postgresBackupEnvironment("https://localhost/db", {}), /PostgreSQL DATABASE_URL/);
});


test("a real Next-style process.title replacement does not lose the verified standalone launch", () => {
  const directory = mkdtempSync(join(tmpdir(), "hermes-process-title-"));
  const app = join(directory, "apps/web/.next/standalone/apps/web");
  mkdirSync(app, { recursive: true });
  const beforeCwd = process.cwd();
  const beforeTitle = process.title;
  try {
    process.chdir(app);
    process.title = "next-server (v15.5.21)";
    const changedArgs = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
    assert.match(changedArgs[0], /next-server/);
    const executable = realpathSync("/proc/self/exe");
    const actual = { ...web, cwd: realpathSync("/proc/self/cwd"), executable, unitExecutable: executable,
      unitWorkingDirectory: directory, argumentPaths: [], unitArgumentPaths: [join(app, "server.js")] };
    assert.equal(verifyProcessSnapshot(actual, directory, configured).release, directory);
  } finally {
    process.title = beforeTitle;
    process.chdir(beforeCwd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy root identity is accepted only for restoration of its matching captured release", () => {
  const legacy = { ...worker, unitUser: "", uid: 0, accountUid: 0 };
  const profile = { version: 1, release, worker: { unitUser: "", uid: 0 } };
  assert.throws(() => verifyProcessSnapshot(legacy, release, configured), /non-root/);
  assert.throws(() => verifyProcessSnapshot(legacy, release, configured, { ...profile, release: "/another/release" }), /non-root/);
  assert.throws(() => verifyProcessSnapshot(legacy, release, configured, { ...profile, worker: { unitUser: "other", uid: 0 } }), /non-root/);
  assert.equal(verifyProcessSnapshot(legacy, release, configured, profile).legacyWorkerIdentityRestored, true);
});

test("parser deployment preflight gives the actual child only the minimal offline environment", t => {
  const directory = mkdtempSync(join(tmpdir(), "hermes-parser-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, "release");
  const parserCwd = join(target, "services/parser");
  mkdirSync(parserCwd, { recursive: true });
  const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  const executable = join(directory, "parser-python");
  const captured = `${executable}.json`;
  writeFileSync(executable, `#!${python.stdout.trim()}\nimport json, os, pathlib, sys\npathlib.Path(sys.argv[0] + '.json').write_text(json.dumps(dict(os.environ)))\n`, { mode: 0o755 });
  const config = join(directory, "production.env");
  const cache = join(directory, "models");
  const ocr = join(directory, "ocr");
  writeFileSync(config, [
    "DATABASE_URL=postgres://secret@localhost/study", "S3_SECRET_ACCESS_KEY=s3-secret", "OPENAI_API_KEY=model-secret",
    "HF_TOKEN=cache-token", "NODE_OPTIONS=--require=/untrusted/loader.js", "PYTHONPATH=/untrusted/modules",
    "PYTHONHOME=/untrusted/python", "LD_PRELOAD=/untrusted/loader.so", "HTTP_PROXY=http://secret-proxy",
    "PATH=/untrusted/bin", `HF_HOME=${cache}`, `PARSER_OCR_MODEL_DIR=${ocr}`, "HF_HUB_OFFLINE=0", "PYTHONNOUSERSITE=0",
  ].join("\n"));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../infra/deploy/hermes-db.mjs", import.meta.url)), "parser", config, target, executable, directory], {
    encoding: "utf8", env: { ...process.env, AWS_SECRET_ACCESS_KEY: "ambient-secret", HTTPS_PROXY: "http://ambient-proxy", ALL_PROXY: "http://ambient-proxy" },
  });
  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(readFileSync(captured, "utf8"));
  for (const key of ["DATABASE_URL", "S3_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "HF_TOKEN", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    assert.equal(environment[key], undefined, `${key} reached the parser child`);
  }
  assert.equal(environment.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.equal(environment.HF_HOME, cache);
  assert.equal(environment.HF_HUB_CACHE, join(cache, "hub"));
  assert.equal(environment.PARSER_OCR_MODEL_DIR, ocr);
  assert.equal(environment.PARSER_CWD, parserCwd);
  assert.equal(environment.HF_HUB_OFFLINE, "1");
  assert.equal(environment.PYTHONNOUSERSITE, "1");
  assert.equal(environment.PYTHONIOENCODING, "utf-8");
  assert.equal(environment.TMPDIR, "/tmp");
});
