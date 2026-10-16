import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deployScript = fileURLToPath(new URL("../../infra/deploy/deploy-hermes.sh", import.meta.url));

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "hermes-deploy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const server = join(root, "server");
  const bin = join(root, "bin");
  const remoteTmp = join(root, "remote-tmp");
  for (const dir of [repo, server, bin, remoteTmp]) mkdirSync(dir);
  const log = join(root, "commands.log");
  writeFileSync(log, "");
  writeFileSync(join(repo, "README.md"), "fixture source\n");
  writeFileSync(join(server, ".env.production"), "OPENING_ADAPTIVE_PLANNING=0\n");
  writeFileSync(join(server, ".release-sha"), "previous-success\n");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "feat/opening-release");
  git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "add", "README.md");
  git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "commit", "-m", "fixture");
  git("remote", "add", "origin", repo);
  const sha = git("rev-parse", "HEAD");
  const commands = {
    ssh: `
printf 'ssh %s\\n' "$*" >> "$MOCK_LOG"
[ "\${MOCK_FAIL:-}" != ssh ] || exit 255
remote_script="$(cat)"
remote_script="\${remote_script//\\/tmp\\/aistudy-/$MOCK_REMOTE_TMP/aistudy-}"
bash -c "\${!#}" <<< "$remote_script"
`,
    scp: `
printf 'scp\\n' >> "$MOCK_LOG"
args=("$@")
cp "\${args[\${#args[@]}-2]}" "$MOCK_REMOTE_TMP/aistudy-src.tar.gz"
`,
    npm: `
printf 'npm %s\\n' "$*" >> "$MOCK_LOG"
if [ "$1" = ci ] && [ "\${MOCK_FAIL:-}" = install ]; then exit 17; fi
if [ "$1 $2" = 'run build' ]; then
  [ "\${MOCK_FAIL:-}" != build ] || exit 18
  if [ "\${MOCK_FAIL:-}" = worker-during-build ]; then touch "$MOCK_WORKER_CRASHED"; fi
  mkdir -p apps/web/.next/static apps/web/.next/standalone/apps/web
  printf 'asset' > apps/web/.next/static/asset.js
  printf 'server' > apps/web/.next/standalone/apps/web/server.js
fi
`,
    npx: `
printf 'migrate\\n' >> "$MOCK_LOG"
[ "\${MOCK_FAIL:-}" != migrate ] || exit 19
`,
    systemctl: `
printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
  is-active)
    if [ "\${!#}" = aistudy-worker.service ]; then
      [ ! -f "$MOCK_WORKER_CRASHED" ] || exit 3
      [ -f "$MOCK_WORKER_RESTARTED" ] || [ "$MOCK_WORKER" = active ]
    fi
    ;;
  is-enabled) [ "$MOCK_WORKER" = enabled ] ;;
  restart)
    if [ "$2" = aistudy-worker.service ]; then
      [ "\${MOCK_FAIL:-}" != worker ] || exit 20
      rm -f "$MOCK_WORKER_CRASHED"
      touch "$MOCK_WORKER_RESTARTED"
    fi
    ;;
esac
`,
    curl: `
printf 'health\\n' >> "$MOCK_LOG"
[ "\${MOCK_FAIL:-}" != health ] || exit 22
if [ "\${MOCK_FAIL:-}" = worker-after-start ]; then touch "$MOCK_WORKER_CRASHED"; fi
printf '{"status":"ok"}'
`,
    sleep: "exit 0\n",
    journalctl: "exit 0\n",
  };
  for (const [name, source] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -e\n${source}`, { mode: 0o755 });
  }
  return {
    server, sha, git,
    run(extra = {}) {
      const result = spawnSync("bash", [deployScript, "deploy"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HOST: "mock-hermes",
          DIR: server,
          DEPLOY_REMOTE: "",
          MOCK_LOG: log,
          MOCK_REMOTE_TMP: remoteTmp,
          MOCK_WORKER_RESTARTED: join(root, "worker-restarted"),
          MOCK_WORKER_CRASHED: join(root, "worker-crashed"),
          MOCK_WORKER: "active",
          ...overrides,
          ...extra,
        },
      });
      assert.ifError(result.error);
      return { ...result, log: readFileSync(log, "utf8") };
    },
  };
}

test("deploy restarts web and active worker, preserves flags, and records the verified release", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /systemctl restart aistudy-web.service/);
  assert.match(result.log, /systemctl restart aistudy-worker.service/);
  assert.match(result.log, /StrictHostKeyChecking=yes/);
  assert.equal(readFileSync(join(f.server, ".env.production"), "utf8"), "OPENING_ADAPTIVE_PLANNING=0\n");
  assert.equal(readFileSync(join(f.server, ".release-sha"), "utf8"), `${f.sha}\n`);
  assert.match(result.stdout, /部署完成/);
});

for (const [failure, status] of [["install", 17], ["build", 18], ["migrate", 19], ["worker", 20], ["health", 1], ["worker-after-start", 1]]) {
  test(`${failure} failure stops deployment and preserves the last successful SHA`, (t) => {
    const f = fixture(t, { MOCK_FAIL: failure });
    const result = f.run();
    assert.equal(result.status, status, result.stderr);
    assert.equal(readFileSync(join(f.server, ".release-sha"), "utf8"), "previous-success\n");
    assert.doesNotMatch(result.stdout, /部署完成/);
    if (["install", "build", "migrate"].includes(failure)) {
      assert.doesNotMatch(result.log, /systemctl restart/);
    }
    if (["install", "build"].includes(failure)) assert.doesNotMatch(result.log, /^migrate$/m);
  });
}

test("an enabled worker that is currently down is restarted", (t) => {
  const result = fixture(t, { MOCK_WORKER: "enabled" }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /systemctl restart aistudy-worker.service/);
});

test("an active worker that crashes during the build is still restarted", (t) => {
  const result = fixture(t, { MOCK_FAIL: "worker-during-build" }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /systemctl restart aistudy-worker.service/);
});

test("a disabled inactive worker stays off", (t) => {
  const result = fixture(t, { MOCK_WORKER: "disabled" }).run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.log, /systemctl restart aistudy-worker.service/);
});

test("SSH failure stops before upload without changing server configuration", (t) => {
  const f = fixture(t, { MOCK_FAIL: "ssh" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.log, /scp|systemctl/);
  assert.equal(readFileSync(join(f.server, ".release-sha"), "utf8"), "previous-success\n");
});

test("a pushed feature branch cannot deploy before it is merged into release", (t) => {
  const f = fixture(t);
  f.git("switch", "-c", "unmerged-feature");
  f.git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "commit", "--allow-empty", "-m", "unmerged");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.log, /scp|systemctl/);
  assert.match(result.stderr, /发布主干/);
});

test("the existing study-assistant-opening remote alias remains supported", (t) => {
  const f = fixture(t);
  f.git("remote", "rename", "origin", "study-assistant-opening");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test("an explicit deployment remote can override the defaults", (t) => {
  const f = fixture(t);
  f.git("remote", "rename", "origin", "deploy-source");
  const result = f.run({ DEPLOY_REMOTE: "deploy-source" });
  assert.equal(result.status, 0, result.stderr);
});
