import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploymentDirectory = fileURLToPath(new URL("../../infra/deploy/", import.meta.url));
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
const workerHelper = `#!/usr/bin/env bash
set -euo pipefail
mode=provision
while [[ $# -gt 0 ]]; do
 case "$1" in --snapshot|--restore) mode=$1; shift;; --state-dir) state=$2; shift 2;; --systemd-dir) systemd=$2; shift 2;; --config-dir) config=$2; shift 2;; *) shift 2;; esac
done
printf 'worker %s\\n' "$mode" >> "$MOCK_LOG"
mkdir -p "$state/worker-before" "$systemd" "$config"
if [[ "$mode" == --snapshot ]]; then
 for pair in "aistudy-worker.service:$systemd/aistudy-worker.service" "worker-runtime.env:$config/worker-runtime.env"; do
  name=\${pair%%:*}; source=\${pair#*:}
  if [[ -f "$source" ]]; then cp "$source" "$state/worker-before/$name"; else touch "$state/worker-before/$name.absent"; fi
 done
 touch "$state/worker-before/ready"
elif [[ "$mode" == --restore ]]; then
 [[ -f "$state/worker-before/ready" ]]
 for pair in "aistudy-worker.service:$systemd/aistudy-worker.service" "worker-runtime.env:$config/worker-runtime.env"; do
  name=\${pair%%:*}; destination=\${pair#*:}
  if [[ -f "$state/worker-before/$name" ]]; then cp "$state/worker-before/$name" "$destination"; else rm -f "$destination"; fi
 done
else
 [[ "\${MOCK_FAIL:-}" != provision ]] || exit 24
 printf new-worker-unit > "$systemd/aistudy-worker.service"
 printf new-runtime-env > "$config/worker-runtime.env"
fi
`;

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "hermes-atomic-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const server = join(root, "legacy");
  const bin = join(root, "bin");
  const state = join(root, "state");
  const systemd = join(root, "systemd");
  const workerConfig = join(root, "worker-config");
  for (const dir of [repo, server, bin, state, systemd, workerConfig]) mkdirSync(dir);
  const current = join(root, "current");
  const backups = join(root, "backups");
  const releases = join(root, "releases");
  const log = join(root, "commands.log");
  writeFileSync(log, "");
  writeFileSync(join(server, ".env.production"), "DATABASE_URL='postgres://prod:secret-never-print@127.0.0.1:5432/study'\nOPENING_ADAPTIVE_PLANNING=0\nUNTRUSTED=$(touch should-not-execute)\n");
  writeFileSync(join(server, ".release-sha"), "previous-success\n");
  writeFileSync(join(server, "keep-live-source"), "original source\n");
  mkdirSync(join(server, "apps/web/.next/standalone/apps/web"), { recursive: true });
  writeFileSync(join(server, "apps/web/.next/standalone/apps/web/server.js"), "old-built-server\n");
  mkdirSync(join(server, ".local/docling-venv/bin"), { recursive: true });
  const python = join(server, ".local/docling-venv/bin/python");
  writeFileSync(python, `#!/usr/bin/env bash\nfixture_root="$(cd -- "$(dirname -- "$0")/../../../.." && pwd)"\nprintf 'parser %s\\n' "$*" >> "$fixture_root/commands.log"\n[[ ! -f "$fixture_root/parser-failure" ]]\n`, { mode: 0o755 });
  mkdirSync(join(systemd, "aistudy-web.service.d"));
  writeFileSync(join(systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "old-web-override\n");
  writeFileSync(join(systemd, "aistudy-worker.service"), "old-worker-unit\n");
  writeFileSync(join(workerConfig, "worker-runtime.env"), "old-runtime-env\n");

  mkdirSync(join(repo, "infra/deploy"), { recursive: true });
  mkdirSync(join(repo, "services/parser"), { recursive: true });
  writeFileSync(join(repo, "services/parser/placeholder"), "parser source\n");
  for (const name of ["deploy-hermes.sh", "hermes-release.sh", "hermes-db.mjs", "hermes-ci.mjs", "hermes-health.mjs"]) copyFileSync(join(deploymentDirectory, name), join(repo, "infra/deploy", name));
  writeFileSync(join(repo, "infra/deploy/provision-worker.sh"), workerHelper, { mode: 0o755 });
  const git = (...args) => {
    const result = spawnSync(realGit, args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "feat/opening-release");
  git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "add", ".");
  git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "commit", "-m", "fixture");
  git("remote", "add", "origin", "https://github.com/test-owner/test-repo.git");
  const sha = git("rev-parse", "HEAD");
  const ciFile = join(root, "ci.json");
  const ciRun = (extra = {}) => ({ id: 12, head_sha: sha, head_branch: "feat/opening-release", event: "push", status: "completed", conclusion: "success", html_url: "https://github.com/test-owner/test-repo/actions/runs/12", ...extra });
  writeFileSync(ciFile, JSON.stringify({ workflow_runs: [ciRun()] }));

  const commands = {
    node: `
if [[ "\${1##*/}" == runtime-identity.mjs || "\${1##*/}" == hermes-health.mjs ]]; then
 if [[ "$2" == capture ]]; then
  printf 'identity capture=%s\\n' "$4" >> "$MOCK_LOG"
  printf '{"version":1,"release":"%s","worker":{"unitUser":"","uid":0}}' "$4" > "$6"
  chmod 600 "$6"
 else
  printf 'identity current=%s\\n' "$3" >> "$MOCK_LOG"
  [[ "\${MOCK_FAIL:-}" != identity || "$3" == "$DIR" ]] || exit 31
  if [[ "\${MOCK_LEGACY_ROOT:-}" == 1 && "$3" == "$DIR" ]]; then
   [[ -n "\${5:-}" && -f "$5" ]] || exit 32
   printf '旧身份已恢复，非 root 加固尚未生效\\n'
  fi
  printf 'web: PID=101 User=root release=%s\\n' "$3"
 fi
else exec "$REAL_NODE" "$@"; fi`,
    mv: `
arguments=("$@"); destination=\${arguments[\${#arguments[@]}-1]}; source=\${arguments[\${#arguments[@]}-2]}
if [[ "\${MOCK_FAIL:-}" == switch && "$destination" == "$CURRENT_LINK" && "$(readlink "$source")" != "$DIR" && ! -f "$MOCK_MV_FAILED" ]]; then
 touch "$MOCK_MV_FAILED"; exit 34
fi
exec /bin/mv "$@"`,
    cp: `
if [[ "\${MOCK_FAIL:-}" == rollback-copy && "\${!#}" == "$SYSTEMD_DIR/aistudy-web.service.d/50-aistudy-release.conf" ]]; then exit 33; fi
exec /bin/cp "$@"`,
    git: `if [[ "$1" == ls-remote ]]; then printf '%s\\trefs/heads/feat/opening-release\\n' "$MOCK_RELEASE_SHA"; else exec "$REAL_GIT" "$@"; fi`,
    gh: `printf 'gh %s\\n' "$*" >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != ci-unavailable ]] || exit 2; cat "$MOCK_CI_FILE"`,
    ssh: `printf 'ssh %s\\n' "$*" >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != ssh ]] || exit 255; bash -c "\${!#}"`,
    scp: `printf 'scp\\n' >> "$MOCK_LOG"; arguments=("$@"); source=\${arguments[\${#arguments[@]}-2]}; destination=\${arguments[\${#arguments[@]}-1]}; cp "$source" "\${destination#*:}"`,
    npm: `
printf 'npm %s\\n' "$*" >> "$MOCK_LOG"
if [[ "$1" == ci && "\${MOCK_FAIL:-}" == install ]]; then exit 17; fi
if [[ "$1 $2" == 'run build' ]]; then
 [[ "\${MOCK_FAIL:-}" != build ]] || exit 18
 mkdir -p apps/web/.next/static apps/web/.next/standalone/apps/web
 printf asset > apps/web/.next/static/asset.js
 printf server > apps/web/.next/standalone/apps/web/server.js
fi`,
    npx: `
printf 'migrate current=%s\\n' "$(readlink -f "$CURRENT_LINK")" >> "$MOCK_LOG"
if systemctl is-active --quiet aistudy-worker.service; then printf 'refused migration with active worker\\n' >> "$MOCK_LOG"; exit 35; fi
[[ "\${MOCK_FAIL:-}" != migrate ]] || exit 19`,
    pg_dump: `printf 'pg_dump\\n' >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != backup ]] || exit 25; printf dump > "\${!#}"`,
    pg_restore: `printf 'pg_restore %s\\n' "$1" >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != backup-list ]] || exit 26`,
    df: `if [[ "\${MOCK_FAIL:-}" == disk ]]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nmock 100 99 1 99%% /\\n'; else exec /bin/df "$@"; fi`,
    systemctl: `
printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
 is-active)
  if [[ "\${!#}" == aistudy-worker.service ]]; then
   [[ ! -f "$MOCK_CRASHED" && ! -f "$MOCK_STOPPED" ]] || exit 3
   [[ "$MOCK_WORKER" == active || -f "$MOCK_RESTARTED" ]]
  fi;;
 is-enabled) [[ "$MOCK_WORKER" == enabled ]];;
 stop) touch "$MOCK_STOPPED";;
 restart)
  target=$(readlink -f "$CURRENT_LINK")
  if [[ "$2" == aistudy-worker.service ]]; then
   [[ "\${MOCK_FAIL:-}" != worker || "$target" == "$DIR" ]] || exit 20
   rm -f "$MOCK_STOPPED" "$MOCK_CRASHED"; touch "$MOCK_RESTARTED"
  fi;;
esac`,
    curl: `
printf 'health current=%s\\n' "$(readlink -f "$CURRENT_LINK")" >> "$MOCK_LOG"
if [[ "$(readlink -f "$CURRENT_LINK")" != "$DIR" ]]; then
 [[ "\${MOCK_FAIL:-}" != health && "\${MOCK_FAIL:-}" != rollback-copy ]] || exit 22
 if [[ "\${MOCK_FAIL:-}" == worker-after-start ]]; then touch "$MOCK_CRASHED"; fi
fi
printf '{"status":"ok"}'`,
    sleep: "exit 0",
    journalctl: "exit 0",
  };
  for (const [name, source] of Object.entries(commands)) writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOST: "mock-hermes", DIR: server,
    RELEASES_DIR: releases, CURRENT_LINK: current, DEPLOY_STATE: state, BACKUP_DIR: backups,
    SYSTEMD_DIR: systemd, WORKER_CONFIG_DIR: workerConfig, MIN_FREE_KB: "10", DEPLOY_REMOTE: "",
    REAL_GIT: realGit, REAL_NODE: process.execPath, MOCK_RELEASE_SHA: sha, MOCK_LOG: log, MOCK_CI_FILE: ciFile,
    MOCK_MV_FAILED: join(root, "mv-failed"), MOCK_WORKER: "active", MOCK_CRASHED: join(root, "worker-crashed"), MOCK_STOPPED: join(root, "worker-stopped"), MOCK_RESTARTED: join(root, "worker-restarted"), ...overrides,
  };
  return {
    root, repo, server, current, backups, releases, state, systemd, workerConfig, sha, git, env, ciRun,
    setRuns(runs) { writeFileSync(ciFile, JSON.stringify({ workflow_runs: runs })); },
    run(action = "deploy", extra = {}) {
      const childEnvironment = { ...env, ...extra };
      const parserFailure = join(root, "parser-failure");
      if (childEnvironment.MOCK_FAIL === "parser") writeFileSync(parserFailure, "");
      else rmSync(parserFailure, { force: true });
      const result = spawnSync("bash", [join(repo, "infra/deploy/deploy-hermes.sh"), action], { cwd: repo, encoding: "utf8", timeout: 15_000, env: childEnvironment });
      assert.ifError(result.error);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-never-print/);
      return { ...result, log: readFileSync(log, "utf8") };
    },
  };
}

function assertLegacyIntact(f) {
  assert.equal(readFileSync(join(f.server, "keep-live-source"), "utf8"), "original source\n");
  assert.equal(readFileSync(join(f.server, ".release-sha"), "utf8"), "previous-success\n");
  assert.equal(readFileSync(join(f.server, "apps/web/.next/standalone/apps/web/server.js"), "utf8"), "old-built-server\n");
  assert(!existsSync(join(f.repo, "should-not-execute")));
  assert(!existsSync(join(f.server, "should-not-execute")));
}

test("deploy prepares a separate release, verifies a retained PG backup, and atomically switches services", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assertLegacyIntact(f);
  const release = readlinkSync(f.current);
  assert(release.startsWith(`${f.releases}/${f.sha}-`));
  assert.equal(readFileSync(join(release, ".release-sha"), "utf8"), `${f.sha}\n`);
  assert.equal(readlinkSync(join(release, ".env.production")), join(f.server, ".env.production"));
  const backup = readdirSync(f.backups).find(name => name.endsWith(".dump"));
  assert(backup);
  assert.equal(statSync(join(f.backups, backup)).mode & 0o777, 0o600);
  assert(result.log.indexOf("pg_restore --list") < result.log.indexOf("migrate current="));
  assert.match(result.log, new RegExp(`migrate current=${f.server}`));
  assert.match(result.log, /systemctl restart aistudy-worker.service/);
  assert.match(result.log, /StrictHostKeyChecking=yes/);
  assert.match(result.stdout, /部署完成/);
});

for (const failure of ["install", "build", "parser", "backup", "backup-list", "disk"]) {
  test(`${failure} fails before activation and preserves the running release`, t => {
    const f = fixture(t, { MOCK_FAIL: failure });
    const result = f.run();
    assert.notEqual(result.status, 0, result.stderr);
    assertLegacyIntact(f);
    assert.equal(readlinkSync(f.current), f.server);
    assert.doesNotMatch(result.log, /systemctl restart/);
    assert.equal(readFileSync(join(f.systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "utf8"), "old-web-override\n");
  });
}

test("deployment quiesces the old worker after backup and before the write-protocol migration", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const backup = result.log.indexOf("pg_restore --list");
  const snapshot = result.log.indexOf("worker --snapshot");
  const stop = result.log.indexOf("systemctl stop aistudy-worker.service");
  const migration = result.log.indexOf("migrate current=");
  const restart = result.log.indexOf("systemctl restart aistudy-worker.service");
  assert(backup >= 0 && backup < snapshot && snapshot < stop && stop < migration && migration < restart, result.log);
  assert.doesNotMatch(result.log, /refused migration with active worker/);
});

test("migration failure restores the original worker and configuration while retaining the old pointer and backup", t => {
  const f = fixture(t, { MOCK_FAIL: "migrate" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assertLegacyIntact(f);
  assert.equal(readlinkSync(f.current), f.server);
  assert(result.log.indexOf("systemctl stop aistudy-worker.service") < result.log.indexOf("migrate current="), result.log);
  assert(result.log.indexOf("migrate current=") < result.log.indexOf("systemctl restart aistudy-worker.service"), result.log);
  assert.match(result.log, /worker --restore/);
  assert.doesNotMatch(result.log, /worker provision/);
  assert.match(result.stderr, /Previous release restored/);
  assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), "old-worker-unit\n");
  assert.equal(readFileSync(join(f.workerConfig, "worker-runtime.env"), "utf8"), "old-runtime-env\n");
  assert.equal(readFileSync(join(f.systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "utf8"), "old-web-override\n");
  assert(!existsSync(f.env.MOCK_STOPPED));
  assert(existsSync(f.env.MOCK_RESTARTED));
  assert(readdirSync(f.backups).some(name => name.endsWith(".dump")));
});

for (const failure of ["provision", "worker", "health", "worker-after-start", "identity"]) {
  test(`${failure} failure restores the previous pointer and both service configurations`, t => {
    const f = fixture(t, { MOCK_FAIL: failure });
    const result = f.run();
    assert.notEqual(result.status, 0, result.stderr);
    assertLegacyIntact(f);
    assert.equal(readlinkSync(f.current), f.server);
    assert.equal(readFileSync(join(f.systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "utf8"), "old-web-override\n");
    assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), "old-worker-unit\n");
    assert.equal(readFileSync(join(f.workerConfig, "worker-runtime.env"), "utf8"), "old-runtime-env\n");
    assert.match(result.stderr, /Previous release restored/, result.log + result.stdout + result.stderr);
    assert(readdirSync(f.backups).some(name => name.endsWith(".dump")));
  });
}

test("explicit rollback restores the previous prepared app without rolling the DB back", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const rollback = f.run("rollback");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(readlinkSync(f.current), f.server);
  assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), "old-worker-unit\n");
  assert.equal(rollback.log.match(/^migrate current=/gm)?.length, 1);
  assertLegacyIntact(f);
});

test("an active deployment lock rejects concurrent deployment before build or activation", async t => {
  const f = fixture(t);
  const holder = spawn("flock", ["-x", join(f.state, "deploy.lock"), "bash", "-c", "printf ready; read -r keep"], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { holder.stdout.once("data", resolve); holder.once("error", reject); });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already running/);
    assert.doesNotMatch(result.log, /npm|systemctl restart/);
    assertLegacyIntact(f);
  } finally { holder.stdin.end("done\n"); }
});

for (const [label, patch] of [["failure", { conclusion: "failure" }], ["running", { status: "in_progress", conclusion: null }], ["PR success", { event: "pull_request" }], ["different SHA", { head_sha: "a".repeat(40) }]]) {
  test(`CI ${label} cannot deploy`, t => {
    const f = fixture(t);
    f.setRuns([f.ciRun(patch)]);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.log, /ssh|scp|npm|systemctl/);
  });
}

test("an older CI success cannot override a newer failed run", t => {
  const f = fixture(t);
  f.setRuns([f.ciRun(), f.ciRun({ id: 13, conclusion: "failure", html_url: "https://github.com/test-owner/test-repo/actions/runs/13" })]);
  assert.notEqual(f.run().status, 0);
});

for (const action of ["sync", "build", "migrate", "unknown"]) {
  test(`the ${action} action cannot bypass release gates`, t => {
    const result = fixture(t).run(action);
    assert.equal(result.status, 2);
    assert.equal(result.log, "");
  });
}

test("a pushed feature branch cannot deploy before it is merged into release", t => {
  const f = fixture(t);
  f.git("switch", "-c", "unmerged-feature");
  f.git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "commit", "--allow-empty", "-m", "unmerged");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /发布主干/);
  assert.doesNotMatch(result.log, /ssh|scp/);
});

test("unsafe remote paths are passed as data and rejected without executing shell fragments", t => {
  const f = fixture(t);
  const marker = join(f.root, "injected");
  const result = f.run("deploy", { DIR: `${f.server};touch ${marker}` });
  assert.notEqual(result.status, 0);
  assert(!existsSync(marker));
  assertLegacyIntact(f);
});

for (const worker of ["enabled", "disabled"]) {
  test(`a ${worker} worker preserves its intended running state`, t => {
    const result = fixture(t, { MOCK_WORKER: worker }).run();
    assert.equal(result.status, 0, result.stderr);
    if (worker === "enabled") assert.match(result.log, /systemctl restart aistudy-worker.service/);
    else assert.doesNotMatch(result.log, /systemctl restart aistudy-worker.service/);
  });
}


test("legacy root worker recovery uses only the captured target identity and explicitly reports pending hardening", t => {
  const f = fixture(t, { MOCK_FAIL: "health", MOCK_LEGACY_ROOT: "1" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readlinkSync(f.current), f.server);
  assert.match(result.stderr, /Previous release restored/);
  assert.match(result.stdout, /旧身份已恢复，非 root 加固尚未生效/);
  assert(existsSync(join(f.state, "current-identity")));
});

test("two explicit rollbacks can return from legacy to the last managed release", t => {
  const f = fixture(t, { MOCK_LEGACY_ROOT: "1" });
  const deploy = f.run();
  assert.equal(deploy.status, 0, deploy.stderr);
  const managed = readlinkSync(f.current);
  const first = f.run("rollback");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readlinkSync(f.current), f.server);
  assert.match(first.stdout, /旧身份已恢复/);
  const second = f.run("rollback");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readlinkSync(f.current), managed);
});

test("a web configuration restoration failure is never swallowed as successful rollback", t => {
  const f = fixture(t, { MOCK_FAIL: "rollback-copy" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rollback service configuration restoration failed/);
  assert.match(result.stderr, /Automatic application rollback failed/);
  assert.doesNotMatch(result.stderr, /Previous release restored/);
});


test("an activation rename failure cleans only its own temporary pointer and still restores services", t => {
  const f = fixture(t, { MOCK_FAIL: "switch" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readlinkSync(f.current), f.server);
  assert.match(result.stderr, /Previous release restored/);
  assert.match(result.log, /worker --restore/);
  assert.match(result.log, /systemctl restart aistudy-web.service/);
  assert.equal(readFileSync(join(f.systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "utf8"), "old-web-override\n");
  assert(!readdirSync(f.root).some(name => name.startsWith("current.next.")));
});
