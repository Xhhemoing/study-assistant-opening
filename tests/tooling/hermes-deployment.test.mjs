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
 case "$1" in --snapshot|--restore) mode=$1; shift;; --app-dir) app=$2; shift 2;; --state-dir) state=$2; shift 2;; --systemd-dir) systemd=$2; shift 2;; --config-dir) config=$2; shift 2;; *) shift 2;; esac
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
 printf 'new-worker-unit\\n[Service]\\nExecStart=/usr/bin/node %s/apps/worker/src/index.ts\\n' "$app" > "$systemd/aistudy-worker.service"
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
  const oldUnit = `old-worker-unit\n[Service]\nExecStart=/usr/bin/node ${server}/apps/worker/src/index.ts\n`;
  writeFileSync(join(systemd, "aistudy-worker.service"), oldUnit);
  writeFileSync(join(workerConfig, "worker-runtime.env"), "old-runtime-env\n");

  mkdirSync(join(repo, "infra/deploy"), { recursive: true });
  mkdirSync(join(repo, "services/parser"), { recursive: true });
  writeFileSync(join(repo, "services/parser/placeholder"), "parser source\n");
  for (const name of ["deploy-hermes.sh", "hermes-release.sh", "hermes-db.mjs", "hermes-ci.mjs", "hermes-health.mjs"]) copyFileSync(join(deploymentDirectory, name), join(repo, "infra/deploy", name));
  writeFileSync(join(repo, "infra/deploy/provision-worker.sh"), workerHelper, { mode: 0o755 });
  if (overrides.MOCK_ARTIFACT_PROTOCOL) writeFileSync(join(repo, ".worker-protocol"), `${overrides.MOCK_ARTIFACT_PROTOCOL}\n`);
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
  if [[ "\${MOCK_LEGACY_ROOT:-}" == 1 && "$3" == "$DIR" && "$4" == 1 ]]; then
   [[ -n "\${5:-}" && -f "$5" ]] || exit 32
   printf '旧身份已恢复，非 root 加固尚未生效\\n'
  fi
  printf 'web: PID=101 User=root release=%s\\n' "$3"
 fi
else exec "$REAL_NODE" "$@"; fi`,
    mv: `
arguments=("$@"); destination=\${arguments[\${#arguments[@]}-1]}; source=\${arguments[\${#arguments[@]}-2]}
if [[ "$destination" == "$CURRENT_LINK" && "$(readlink "$source")" == "$DIR" && -d "$DEPLOY_STATE/worker-pauses" ]]; then
 guard="$SYSTEMD_DIR/aistudy-worker.service.d/90-aistudy-protocol-guard.conf"
 marker=$(sed -n 's/^ConditionPathExists=!//p' "$guard")
 [[ -n "$marker" && -f "$marker" ]] || { printf 'unsafe legacy pointer switch without guard\\n' >> "$MOCK_LOG"; exit 37; }
fi
if [[ "\${MOCK_FAIL:-}" == switch && "$destination" == "$CURRENT_LINK" && "$(readlink "$source")" != "$DIR" && ! -f "$MOCK_MV_FAILED" ]]; then
 touch "$MOCK_MV_FAILED"; exit 34
fi
if [[ "\${MOCK_FAIL:-}" == pause-guard && "$destination" == "$SYSTEMD_DIR/aistudy-worker.service.d/90-aistudy-protocol-guard.conf" ]]; then
 marker=$(sed -n 's/^ConditionPathExists=!//p' "$source")
 [[ ! -f "$marker" ]] || exit 38
fi
if [[ "$destination" == "$SYSTEMD_DIR/aistudy-worker.service.d/90-aistudy-protocol-guard.conf" ]]; then
 marker=$(sed -n 's/^ConditionPathExists=!//p' "$source")
 if [[ ! -f "$marker" && "$(readlink -f "$CURRENT_LINK")" != "$DIR" ]] && grep -Fq "$DIR/apps/worker/src/index.ts" "$SYSTEMD_DIR/aistudy-worker.service"; then
  printf 'unsafe guard release while absolute legacy unit remains\\n' >> "$MOCK_LOG"; exit 41
 fi
fi
exec /bin/mv "$@"`,
    cp: `
if [[ "\${MOCK_FAIL:-}" == rollback-copy && "\${!#}" == "$SYSTEMD_DIR/aistudy-web.service.d/50-aistudy-release.conf" ]]; then exit 33; fi
if [[ "\${MOCK_FAIL:-}" == restore-web-copy && -f "$DEPLOY_STATE/legacy-health-failed" && "\${!#}" == "$SYSTEMD_DIR/aistudy-web.service.d/50-aistudy-release.conf" ]]; then exit 33; fi
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
if [[ "$MOCK_WORKER" == auto-restart && ! -f "$MOCK_STOPPED" ]]; then printf 'pending old worker restarted during migration\\n' >> "$MOCK_LOG"; exit 35; fi
if systemctl is-active --quiet aistudy-worker.service; then printf 'refused migration with active worker\\n' >> "$MOCK_LOG"; exit 35; fi
[[ "\${MOCK_FAIL:-}" != migrate ]] || exit 19`,
    pg_dump: `printf 'pg_dump\\n' >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != backup ]] || exit 25; printf dump > "\${!#}"`,
    pg_restore: `printf 'pg_restore %s\\n' "$1" >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != backup-list ]] || exit 26`,
    df: `if [[ "\${MOCK_FAIL:-}" == disk ]]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nmock 100 99 1 99%% /\\n'; else exec /bin/df "$@"; fi`,
    systemctl: `
printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
 show) if [[ "$MOCK_WORKER" == missing ]]; then printf 'not-found\\n'; else printf 'loaded\\n'; fi;;
 is-active)
  if [[ "\${!#}" == aistudy-worker.service ]]; then
   [[ ! -f "$MOCK_CRASHED" && ! -f "$MOCK_STOPPED" ]] || exit 3
   [[ "$MOCK_WORKER" == active || -f "$MOCK_RESTARTED" ]]
  fi;;
 is-enabled) [[ "$MOCK_WORKER" == enabled || "$MOCK_WORKER" == auto-restart ]];;
 daemon-reload)
  if [[ "\${MOCK_FAIL:-}" == pause-reload ]]; then
   guard="$SYSTEMD_DIR/aistudy-worker.service.d/90-aistudy-protocol-guard.conf"
   if [[ -f "$guard" ]]; then
    marker=$(sed -n 's/^ConditionPathExists=!//p' "$guard")
    [[ ! -f "$marker" ]] || exit 39
   fi
  fi;;
 stop)
  if [[ -d "$DEPLOY_STATE/releases" && -n "$(find "$DEPLOY_STATE/releases" -name lease-worker-start-attempted -print -quit)" ]]; then
   [[ "\${MOCK_FAIL:-}" != stop-after-start ]] || { printf 'Worker may still be active: simulated stop failure\\n' >&2; exit 40; }
   [[ "\${MOCK_FAIL:-}" != stop-still-active ]] || exit 0
  fi
  touch "$MOCK_STOPPED";;
 start|restart)
  target=$(readlink -f "$CURRENT_LINK")
  if [[ "$2" == aistudy-web.service && "\${MOCK_FAIL:-}" == web-start && "$target" != "$DIR" ]]; then exit 21; fi
  if [[ "$2" == aistudy-worker.service ]]; then
   guard="$SYSTEMD_DIR/aistudy-worker.service.d/90-aistudy-protocol-guard.conf"
   if [[ -f "$guard" ]]; then
    marker=$(sed -n 's/^ConditionPathExists=!//p' "$guard")
    if [[ -f "$marker" ]]; then printf 'worker skipped by persistent condition\\n' >> "$MOCK_LOG"; exit 0; fi
   fi
   if [[ -f "$target/.worker-protocol" ]]; then
    latest=$(find "$DEPLOY_STATE/releases" -name lease-worker-start-attempted -print -quit)
    [[ -n "$latest" ]] || { printf 'missing persisted start marker\\n' >> "$MOCK_LOG"; exit 36; }
   fi
   [[ "\${MOCK_FAIL:-}" != worker || "$target" == "$DIR" ]] || exit 20
   rm -f "$MOCK_STOPPED" "$MOCK_CRASHED"; touch "$MOCK_RESTARTED"
   [[ "\${MOCK_FAIL:-}" != worker-partial-start || "$target" == "$DIR" ]] || exit 20
  fi;;
esac`,
    curl: `
printf 'health current=%s\\n' "$(readlink -f "$CURRENT_LINK")" >> "$MOCK_LOG"
target=$(readlink -f "$CURRENT_LINK")
if [[ "$target" == "$DIR" && "\${MOCK_FAIL_LEGACY_HEALTH:-}" == 1 ]]; then touch "$DEPLOY_STATE/legacy-health-failed"; exit 22; fi
if [[ "$target" != "$DIR" && "$target" != "\${MOCK_HEALTHY_TARGET:-}" ]]; then
 [[ "\${MOCK_FAIL:-}" != health && "\${MOCK_FAIL:-}" != rollback-copy && "\${MOCK_FAIL:-}" != pause-guard && "\${MOCK_FAIL:-}" != pause-reload && "\${MOCK_FAIL:-}" != stop-after-start && "\${MOCK_FAIL:-}" != stop-still-active ]] || exit 22
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
    root, repo, server, current, backups, releases, state, systemd, workerConfig, sha, git, env, ciRun, oldUnit,
    setRuns(runs) { writeFileSync(ciFile, JSON.stringify({ workflow_runs: runs })); },
    run(action = "deploy", extra = {}) {
      const logStart = readFileSync(log, "utf8").length;
      const childEnvironment = { ...env, ...extra };
      const parserFailure = join(root, "parser-failure");
      if (childEnvironment.MOCK_FAIL === "parser") writeFileSync(parserFailure, "");
      else rmSync(parserFailure, { force: true });
      const result = spawnSync("bash", [join(repo, "infra/deploy/deploy-hermes.sh"), action], { cwd: repo, encoding: "utf8", timeout: 15_000, env: childEnvironment });
      assert.ifError(result.error);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-never-print/);
      const allLog = readFileSync(log, "utf8");
      return { ...result, log: allLog, deltaLog: allLog.slice(logStart) };
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

for (const scenario of [{ worker: "active", failure: "worker" }, { worker: "disabled", failure: "health" }]) {
  test(`Study startup failure with ${scenario.worker} worker cannot restore a pre-Study Web`, t => {
    const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v1", MOCK_WORKER: scenario.worker });
    const failed = f.run("deploy", { MOCK_FAIL: scenario.failure });
    assert.notEqual(failed.status, 0);
    assert.notEqual(readlinkSync(f.current), f.server);
    assert.match(failed.stderr, /Refusing recovery to a pre-Study application/);
    assert(existsSync(join(f.state, "activation-incomplete")));
    assert(existsSync(f.env.MOCK_STOPPED));
    assert.doesNotMatch(failed.log, /worker --restore/);
    assert.equal(failed.log.match(/systemctl restart aistudy-web.service/g)?.length, 1);
    const transition = readdirSync(join(f.state, "releases"))[0];
    assert(existsSync(join(f.state, "releases", transition, "study-app-start-attempted")));
    assert.equal(f.run("restart").status, 3);
  });
}

test("Study rollback rejects a pre-Study target before stopping or changing services", t => {
  const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v1" });
  assert.equal(f.run().status, 0);
  const current = readlinkSync(f.current);
  const rejected = f.run("rollback");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Refusing rollback to a pre-Study application/);
  assert.equal(readlinkSync(f.current), current);
  assert.doesNotMatch(rejected.deltaLog, /systemctl stop|systemctl restart|worker --restore/);
});

test("Study releases retain ordinary rollback to another compatible Study release", t => {
  const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v1" });
  assert.equal(f.run().status, 0);
  const previous = readlinkSync(f.current);
  assert.equal(f.run().status, 0);
  const rollback = f.run("rollback");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(readlinkSync(f.current), previous);
  assert(!existsSync(f.env.MOCK_STOPPED));
});

test("Study v1 upgrades to text-question/photo-recognition support but cannot roll back to its old readers", t => {
  const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2" });
  writeFileSync(join(f.server, ".worker-protocol"), "delivery-leases-study-v1\n");
  const deployed = f.run();
  assert.equal(deployed.status, 0, deployed.stderr);
  const current = readlinkSync(f.current);
  assert.equal(readFileSync(join(current, ".worker-protocol"), "utf8"), "delivery-leases-study-v2\n");
  const rejected = f.run("rollback");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Refusing rollback.*text-question and photo-recognition support/);
  assert.equal(readlinkSync(f.current), current);
  assert.doesNotMatch(rejected.deltaLog, /systemctl stop|systemctl restart|worker --restore/);
  assert(!existsSync(f.env.MOCK_STOPPED));
});

for (const scenario of [
  { worker: "active", failure: "worker" },
  { worker: "disabled", failure: "health" },
  { worker: "disabled", failure: "web-start" },
]) {
  test(`Study v2 ${scenario.failure} with ${scenario.worker} worker cannot automatically restore Study v1 readers`, t => {
    const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2", MOCK_WORKER: scenario.worker });
    writeFileSync(join(f.server, ".worker-protocol"), "delivery-leases-study-v1\n");
    const failed = f.run("deploy", { MOCK_FAIL: scenario.failure });
    assert.notEqual(failed.status, 0);
    assert.notEqual(readlinkSync(f.current), f.server);
    assert.match(failed.stderr, /Refusing recovery.*text-question and photo-recognition support/);
    assert(existsSync(join(f.state, "activation-incomplete")));
    assert(existsSync(f.env.MOCK_STOPPED));
    assert.doesNotMatch(failed.deltaLog, /worker --restore/);
    assert.equal(failed.deltaLog.match(/systemctl restart aistudy-web.service/g)?.length, 1);
    const transition = readdirSync(join(f.state, "releases"))[0];
    assert(existsSync(join(f.state, "releases", transition, "study-v2-app-start-attempted")));
    assert.equal(f.run("restart").status, 3);
  });
}

for (const failure of ["migrate", "provision"]) {
  test(`Study v2 ${failure} failure before process startup can restore Study v1`, t => {
    const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2" });
    writeFileSync(join(f.server, ".worker-protocol"), "delivery-leases-study-v1\n");
    const failed = f.run("deploy", { MOCK_FAIL: failure });
    assert.notEqual(failed.status, 0);
    assert.equal(readlinkSync(f.current), f.server);
    assert.match(failed.deltaLog, /worker --restore/);
    assert.match(failed.deltaLog, /systemctl restart aistudy-worker.service/);
    assert.match(failed.stderr, /Previous release restored/);
    assert(!existsSync(join(f.state, "activation-incomplete")));
    assert(!existsSync(f.env.MOCK_STOPPED));
  });
}

test("Study v2 releases retain ordinary rollback and automatic recovery to another Study v2 release", t => {
  const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2" });
  assert.equal(f.run().status, 0);
  const previous = readlinkSync(f.current);
  assert.equal(f.run().status, 0);
  const rollback = f.run("rollback");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(readlinkSync(f.current), previous);
  assert.match(rollback.deltaLog, /systemctl restart aistudy-worker.service/);
  const failed = f.run("deploy", { MOCK_FAIL: "health", MOCK_HEALTHY_TARGET: previous });
  assert.notEqual(failed.status, 0);
  assert.equal(readlinkSync(f.current), previous);
  assert.match(failed.stderr, /Previous release restored/);
  assert(!existsSync(join(f.state, "activation-incomplete")));
  assert(!existsSync(f.env.MOCK_STOPPED));
});

test("Study v2 rejects deployment of a Study v1 artifact before build or activation", t => {
  const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2" });
  assert.equal(f.run().status, 0);
  const current = readlinkSync(f.current);
  writeFileSync(join(f.repo, ".worker-protocol"), "delivery-leases-study-v1\n");
  f.git("add", ".worker-protocol");
  f.git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "commit", "-m", "older Study artifact");
  const head = f.git("rev-parse", "HEAD");
  f.setRuns([f.ciRun({ head_sha: head })]);
  const rejected = f.run("deploy", { MOCK_RELEASE_SHA: head });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Refusing deployment.*text-question and photo-recognition support/);
  assert.equal(readlinkSync(f.current), current);
  assert.doesNotMatch(rejected.deltaLog, /npm|migrate|systemctl stop|systemctl restart|worker --restore/);
});

for (const protocol of ["delivery-leases-v1", null]) {
  test(`Study deploy rejects ${protocol ?? "unmarked"} artifacts before building or changing services`, t => {
    const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v1" });
    assert.equal(f.run().status, 0);
    const current = readlinkSync(f.current);
    if (protocol) writeFileSync(join(f.repo, ".worker-protocol"), `${protocol}\n`);
    else rmSync(join(f.repo, ".worker-protocol"));
    f.git("add", ".worker-protocol");
    f.git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "commit", "-m", "older protocol artifact");
    const head = f.git("rev-parse", "HEAD");
    f.setRuns([f.ciRun({ head_sha: head })]);
    const rejected = f.run("deploy", { MOCK_RELEASE_SHA: head });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Refusing deployment of a pre-Study application/);
    assert.equal(readlinkSync(f.current), current);
    assert.doesNotMatch(rejected.deltaLog, /npm|migrate|systemctl stop|systemctl restart|worker --restore/);
  });
}

test("deployment can move to another disk and roll back to the original managed release root", t => {
  const f = fixture(t);
  const first = f.run("deploy", { RELEASES_DIR: `${f.server}-releases` });
  assert.equal(first.status, 0, first.stderr);
  const previous = readlinkSync(f.current);
  const moved = f.run("deploy");
  assert.equal(moved.status, 0, moved.stderr);
  assert(readlinkSync(f.current).startsWith(`${f.releases}/`));
  const rollback = f.run("rollback");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(readlinkSync(f.current), previous);
  assertLegacyIntact(f);
  assert(!existsSync(f.env.MOCK_STOPPED));
});

test("moving release roots still rejects a previous target outside both managed roots", t => {
  const f = fixture(t);
  assert.equal(f.run("deploy", { RELEASES_DIR: join(f.root, "unmanaged") }).status, 0);
  const previous = readlinkSync(f.current);
  const refused = f.run("deploy");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Release pointer escapes managed directories/);
  assert.equal(readlinkSync(f.current), previous);
  assert.doesNotMatch(refused.deltaLog, /npm|migrate|systemctl stop|systemctl restart/);
});

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

test("an inactive legacy worker with a pending automatic restart is stopped before migration", t => {
  const f = fixture(t, { MOCK_WORKER: "auto-restart" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert(result.log.indexOf("systemctl stop aistudy-worker.service") < result.log.indexOf("migrate current="));
  assert.doesNotMatch(result.log, /pending old worker restarted during migration/);
  assert.match(result.log, /systemctl restart aistudy-worker.service/);
});

for (const failure of ["", "migrate"]) {
  test(`first installation without a worker unit supports ${failure || "normal deployment"}`, t => {
    const f = fixture(t, { MOCK_WORKER: "missing", MOCK_FAIL: failure });
    rmSync(join(f.systemd, "aistudy-worker.service"));
    const result = f.run();
    assert.equal(result.status === 0, !failure, result.stderr);
    assert.doesNotMatch(result.log, /systemctl (stop|restart) aistudy-worker.service/);
    if (failure) assert.equal(readlinkSync(f.current), f.server);
  });
}

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
  assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), f.oldUnit);
  assert.equal(readFileSync(join(f.workerConfig, "worker-runtime.env"), "utf8"), "old-runtime-env\n");
  assert.equal(readFileSync(join(f.systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "utf8"), "old-web-override\n");
  assert(!existsSync(f.env.MOCK_STOPPED));
  assert(existsSync(f.env.MOCK_RESTARTED));
  assert(readdirSync(f.backups).some(name => name.endsWith(".dump")));
});

for (const failure of ["provision", "web-start", "worker", "worker-partial-start", "health", "worker-after-start", "identity"]) {
  test(`${failure} failure restores the previous pointer and both service configurations`, t => {
    const f = fixture(t, { MOCK_FAIL: failure });
    const result = f.run();
    assert.notEqual(result.status, 0, result.stderr);
    assertLegacyIntact(f);
    assert.equal(readlinkSync(f.current), f.server);
    assert.equal(readFileSync(join(f.systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "utf8"), "old-web-override\n");
    assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), f.oldUnit);
    assert.equal(readFileSync(join(f.workerConfig, "worker-runtime.env"), "utf8"), "old-runtime-env\n");
    if (failure === "provision" || failure === "web-start") assert.match(result.stderr, /Previous release restored/, result.log + result.stdout + result.stderr);
    else {
      assert.match(result.stderr, /DEGRADED: web restored; legacy worker remains stopped/);
      assert.doesNotMatch(result.stderr, /Previous release restored/);
      const active = spawnSync(join(f.root, "bin/systemctl"), ["is-active", "--quiet", "aistudy-worker.service"], { env: f.env });
      assert.notEqual(active.status, 0);
      const guard = readFileSync(join(f.systemd, "aistudy-worker.service.d/90-aistudy-protocol-guard.conf"), "utf8");
      const marker = guard.match(/^ConditionPathExists=!(.+)$/m)?.[1];
      assert(marker && existsSync(marker));
      const transition = readdirSync(join(f.state, "releases"))[0];
      assert(existsSync(join(f.state, "releases", transition, "lease-worker-start-attempted")));
    }
    assert(readdirSync(f.backups).some(name => name.endsWith(".dump")));
  });
}

test("explicit legacy rollback restores web but pauses the worker without rolling the DB back", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const rollback = f.run("rollback");
  assert.equal(rollback.status, 3, rollback.stderr);
  assert.equal(readlinkSync(f.current), f.server);
  assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), f.oldUnit);
  assert.equal(rollback.log.match(/^migrate current=/gm)?.length, 1);
  assert.doesNotMatch(rollback.deltaLog, /systemctl restart aistudy-worker.service/);
  assert.match(rollback.stderr, /DEGRADED/);
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


test("before any new worker startup, migration failure can restore the captured legacy identity", t => {
  const f = fixture(t, { MOCK_FAIL: "migrate", MOCK_LEGACY_ROOT: "1" });
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
  assert.equal(first.status, 3, first.stderr);
  assert.equal(readlinkSync(f.current), f.server);
  assert.match(first.stderr, /legacy worker remains stopped/);
  assert.doesNotMatch(first.stdout, /旧身份已恢复/);
  const second = f.run("rollback");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readlinkSync(f.current), managed);
});

test("a paused enabled legacy worker stays blocked through script restart, status, direct starts and boot", t => {
  const f = fixture(t, { MOCK_WORKER: "enabled" });
  mkdirSync(join(f.systemd, "aistudy-worker.service.d"));
  const unrelated = join(f.systemd, "aistudy-worker.service.d/80-admin.conf");
  writeFileSync(unrelated, "[Service]\nMemoryMax=2G\n");
  assert.equal(f.run().status, 0);
  const rollback = f.run("rollback");
  assert.equal(rollback.status, 3, rollback.stderr);
  const guard = readFileSync(join(f.systemd, "aistudy-worker.service.d/90-aistudy-protocol-guard.conf"), "utf8");
  const marker = guard.match(/^ConditionPathExists=!(.+)$/m)?.[1];
  assert(marker && existsSync(marker), "persistent condition must reference an existing private marker");
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.equal(readFileSync(unrelated, "utf8"), "[Service]\nMemoryMax=2G\n");
  for (const action of ["restart", "status"]) {
    const result = f.run(action);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /Administrator reconciliation is required/);
    assert.doesNotMatch(result.deltaLog, /systemctl restart/);
    assert.doesNotMatch(result.stdout, /restarted and healthy|部署完成/);
  }
  // Fresh systemctl processes model a direct manual start and enabled boot
  // activation; the mock evaluates the actual persisted systemd condition.
  for (const command of ["start", "restart", "start"]) {
    const direct = spawnSync(join(f.root, "bin/systemctl"), [command, "aistudy-worker.service"], { env: f.env, encoding: "utf8" });
    assert.equal(direct.status, 0, "systemd may report a condition-skipped start as successful");
    assert(existsSync(f.env.MOCK_STOPPED));
  }
  assert(existsSync(marker));
});

test("a managed release can resume the intended active worker after a paused legacy rollback", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.run("rollback").status, 3);
  const pauses = readdirSync(join(f.state, "worker-pauses"));
  assert.equal(pauses.length, 1);
  const deploy = f.run();
  assert.equal(deploy.status, 0, deploy.stderr);
  assert.match(deploy.deltaLog, /systemctl restart aistudy-worker.service/);
  assert(!existsSync(f.env.MOCK_STOPPED));
  assert.deepEqual(readdirSync(join(f.state, "worker-pauses")), pauses, "legacy pauses are never silently removed");
  const guard = readFileSync(join(f.systemd, "aistudy-worker.service.d/90-aistudy-protocol-guard.conf"), "utf8");
  assert(!existsSync(guard.match(/^ConditionPathExists=!(.+)$/m)[1]), "new protocol guard must allow only its new target");
});

test("a failed web start restores an existing legacy pause guard before reverting the pointer", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.run("rollback").status, 3);
  const failed = f.run("deploy", { MOCK_FAIL: "web-start" });
  assert.notEqual(failed.status, 0);
  assert.equal(readlinkSync(f.current), f.server);
  assert.match(failed.stderr, /DEGRADED/);
  assert.doesNotMatch(failed.log, /unsafe legacy pointer switch without guard/);
  assert.doesNotMatch(failed.deltaLog, /systemctl restart aistudy-worker.service/);
});

test("automatic recovery between lease-protocol releases restarts the previous worker normally", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const managed = readlinkSync(f.current);
  const failed = f.run("deploy", { MOCK_FAIL: "health", MOCK_HEALTHY_TARGET: managed });
  assert.notEqual(failed.status, 0);
  assert.equal(readlinkSync(f.current), managed);
  assert.match(failed.stderr, /Previous release restored/);
  assert.doesNotMatch(failed.stderr, /DEGRADED/);
  assert(!existsSync(f.env.MOCK_STOPPED));
  assert(!existsSync(join(f.state, "worker-pauses")));
});

test("explicit rollback between lease-protocol releases preserves normal worker recovery", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const managed = readlinkSync(f.current);
  assert.equal(f.run().status, 0);
  const rollback = f.run("rollback");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(readlinkSync(f.current), managed);
  assert.match(rollback.deltaLog, /systemctl restart aistudy-worker.service/);
  assert.doesNotMatch(rollback.stderr, /DEGRADED/);
});

test("a failed legacy rollback restores the managed worker while retaining the legacy pause", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const managed = readlinkSync(f.current);
  const failed = f.run("rollback", { MOCK_FAIL_LEGACY_HEALTH: "1" });
  assert.notEqual(failed.status, 0);
  assert.equal(readlinkSync(f.current), managed);
  assert.match(failed.stderr, /Previous release restored/);
  assert(!existsSync(f.env.MOCK_STOPPED));
  assert.equal(readdirSync(join(f.state, "worker-pauses")).length, 1);
  const guard = readFileSync(join(f.systemd, "aistudy-worker.service.d/90-aistudy-protocol-guard.conf"), "utf8");
  assert(!existsSync(guard.match(/^ConditionPathExists=!(.+)$/m)[1]));
});

test("partial configuration recovery blocks later restart until a verified deployment repairs it", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const managed = readlinkSync(f.current);
  const failed = f.run("rollback", { MOCK_FAIL: "restore-web-copy", MOCK_FAIL_LEGACY_HEALTH: "1" });
  assert.notEqual(failed.status, 0);
  assert.equal(readlinkSync(f.current), managed);
  assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), f.oldUnit, "the concrete failure leaves an absolute legacy unit behind");
  assert(existsSync(join(f.state, "activation-incomplete")));
  const guardPath = join(f.systemd, "aistudy-worker.service.d/90-aistudy-protocol-guard.conf");
  const guard = readFileSync(guardPath, "utf8");
  assert(existsSync(guard.match(/^ConditionPathExists=!(.+)$/m)[1]));
  for (const action of ["restart", "status"]) {
    const result = f.run(action);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /INCOMPLETE/);
    assert.doesNotMatch(result.deltaLog, /systemctl restart/);
    assert.doesNotMatch(result.deltaLog, /unsafe guard release/, "the script must reject before the mock's guard observer can intervene");
    assert.equal(readFileSync(guardPath, "utf8"), guard, "script must not release the actual legacy guard based only on CURRENT");
  }
  // A real identity capture also refuses the mismatched absolute unit. Model
  // the documented administrator repair from the retained snapshot, while
  // retaining the incomplete marker until an entire deployment is verified.
  const failedTransition = readFileSync(join(f.state, "activation-incomplete"), "utf8").trim();
  copyFileSync(join(failedTransition, "worker-before/aistudy-worker.service"), join(f.systemd, "aistudy-worker.service"));
  assert.equal(f.run("restart").status, 3, "manual unit repair alone must not clear the activation barrier");
  const repaired = f.run();
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.deltaLog, /systemctl restart aistudy-worker.service/);
  assert(!existsSync(join(f.state, "activation-incomplete")));
  assert.match(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), /new-worker-unit/);
  assert.doesNotMatch(repaired.log, /unsafe guard release while absolute legacy unit remains/);
  assert.equal(f.run("restart").status, 0);
});

for (const failure of ["pause-guard", "pause-reload"]) {
  test(`${failure} failure never restores a legacy pointer without a confirmed persistent guard`, t => {
    const f = fixture(t);
    const failed = f.run("deploy", { MOCK_FAIL: failure });
    assert.notEqual(failed.status, 0);
    assert.notEqual(readlinkSync(f.current), f.server, "failed safety guard must retain the managed code pointer");
    assert.match(failed.stderr, /Rollback activation halted; inspect the current pointer and service configuration/);
    assert.match(failed.stderr, /Automatic application rollback failed/);
    assert.doesNotMatch(failed.stderr, /Previous release restored|DEGRADED: web restored/);
    assert(existsSync(f.env.MOCK_STOPPED));
    assert.equal(readdirSync(join(f.state, "worker-pauses")).length, 1);
  });
  test(`${failure} during explicit legacy rollback preserves safe managed recovery boundaries`, t => {
    const f = fixture(t);
    assert.equal(f.run().status, 0);
    const managed = readlinkSync(f.current);
    const failed = f.run("rollback", { MOCK_FAIL: failure, MOCK_HEALTHY_TARGET: managed });
    assert.notEqual(failed.status, 0);
    assert.equal(readlinkSync(f.current), managed);
    assert.doesNotMatch(failed.log, /unsafe legacy pointer switch without guard/);
    if (failure === "pause-reload") {
      assert.match(failed.stderr, /Automatic application rollback failed/);
      assert.doesNotMatch(failed.stderr, /Previous release restored/);
      assert(existsSync(f.env.MOCK_STOPPED), "failed configuration reload must keep worker stopped behind the legacy guard");
      const guard = readFileSync(join(f.systemd, "aistudy-worker.service.d/90-aistudy-protocol-guard.conf"), "utf8");
      assert(existsSync(guard.match(/^ConditionPathExists=!(.+)$/m)[1]));
    } else {
      assert.match(failed.stderr, /Previous release restored/);
      assert(!existsSync(f.env.MOCK_STOPPED));
    }
  });
}

for (const failure of ["stop-after-start", "stop-still-active"]) {
  test(`${failure} never switches back to legacy while the lease worker may still run`, t => {
    const f = fixture(t);
    const failed = f.run("deploy", { MOCK_FAIL: failure });
    assert.notEqual(failed.status, 0);
    assert.notEqual(readlinkSync(f.current), f.server);
    assert.match(failed.stderr, /Worker may still be active/);
    assert.match(failed.stderr, /Rollback activation halted; inspect the current pointer and service configuration/);
    assert.doesNotMatch(failed.stderr, /Previous release restored|DEGRADED: web restored/);
    assert(!existsSync(f.env.MOCK_STOPPED));
  });
}

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
