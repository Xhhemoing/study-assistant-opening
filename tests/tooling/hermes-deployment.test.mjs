import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";
import { platform, tree } from "../../infra/deploy/verify-release-artifact.mjs";

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
 # Match production provision's prerequisite: both effective wrappers must have
 # been installed before no-pending configuration can be validated.
 for unit in aistudy-web.service aistudy-worker.service; do
  [[ -f "$systemd/$unit.d/96-aistudy-writer-exec.conf" ]] || { printf 'missing prepared wrapper\\n' >&2; exit 42; }
 done
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
  writeFileSync(join(systemd, "aistudy-web.service"), "[Service]\nExecStart=/usr/bin/node server.js\n");
  const oldUnit = `old-worker-unit\n[Service]\nExecStart=/usr/bin/node ${server}/apps/worker/src/index.ts\n`;
  writeFileSync(join(systemd, "aistudy-worker.service"), oldUnit);
  writeFileSync(join(workerConfig, "worker-runtime.env"), "old-runtime-env\n");

  mkdirSync(join(repo, "infra/deploy"), { recursive: true });
  mkdirSync(join(repo, "services/parser"), { recursive: true });
  writeFileSync(join(repo, "services/parser/placeholder"), "parser source\n");
  for (const name of ["deploy-hermes.sh", "hermes-entry.py", "hermes-release.sh", "hermes-supervisor.mjs", "hermes-config-durability.mjs", "hermes-db.mjs", "hermes-ci.mjs", "hermes-health.mjs", "verify-release-artifact.mjs", "hermes-writer-control.mjs", "hermes-writer-exec.py", "hermes-writer-state.py", "hermes-peer-broker.py", "hermes-trusted-loader.py"]) copyFileSync(join(deploymentDirectory, name), join(repo, "infra/deploy", name));
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
  const repository = overrides.MOCK_PREBUILT ? "Xhhemoing/study-assistant-opening" : "test-owner/test-repo";
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  const sha = git("rev-parse", "HEAD");
  const ciFile = join(root, "ci.json");
  const ciRun = (extra = {}) => ({ id: 12, head_sha: sha, head_branch: "feat/opening-release", event: "push", status: "completed", conclusion: "success", html_url: `https://github.com/${repository}/actions/runs/12`, ...extra });
  writeFileSync(ciFile, JSON.stringify({ workflow_runs: [ciRun()] }));

  const commands = {
    node: `
if [[ "\${1##*/}" == hermes-supervisor.mjs && "\${2:-}" == run ]]; then
 mkdir -p "$DEPLOY_STATE"
 flock --nonblock --no-fork "$DEPLOY_STATE/deploy.lock" "$REAL_NODE" "$MOCK_MANAGER_FIXTURE" "$@" && exit 0
 result=$?; printf 'Managed entry failed or another deployment is already running; inspect retained state.\\n' >&2; exit "$result"
fi
if [[ "\${1##*/}" == hermes-db.mjs && ( "$2" == plan || "$2" == quiescence || "$2" == migrate ) ]]; then
 printf 'db %s current=%s\\n' "$2" "$(readlink -f "$CURRENT_LINK")" >> "$MOCK_LOG"
 case "$2" in
  plan) if [[ "\${MOCK_PENDING:-0}" == 1 ]]; then printf '{"readOnly":true,"registryReadyWithoutWrites":true,"pending":["0109.sql"]}'; else printf '{"readOnly":true,"registryReadyWithoutWrites":true,"pending":[]}'; fi;;
  quiescence) [[ "\${MOCK_FAIL:-}" != quiescence ]] || exit 44; printf '{"readOnly":true,"otherSessions":0}';;
  migrate) exec npx tsx scripts/db-migrate.ts;;
 esac
elif [[ "\${1##*/}" == runtime-identity.mjs || "\${1##*/}" == hermes-health.mjs ]]; then
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
    git: `if [[ "$1" == ls-remote ]]; then
 sha=$MOCK_RELEASE_SHA
 if [[ "\${MOCK_FAIL:-}" == tip-change ]]; then
  count=0; [[ ! -f "$MOCK_LOG.tip" ]] || count=$(cat "$MOCK_LOG.tip"); count=$((count+1)); printf '%s' "$count" > "$MOCK_LOG.tip"
  [[ "$count" -le 1 ]] || sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
 fi
 printf '%s\\trefs/heads/feat/opening-release\\n' "$sha"; else exec "$REAL_GIT" "$@"; fi`,
    gh: `printf 'gh %s\\n' "$*" >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != ci-unavailable ]] || exit 2
if [[ -z "\${MOCK_PREBUILT:-}" ]]; then cat "$MOCK_CI_FILE"; exit; fi
if [[ "$1 $2" == 'run download' ]]; then cp "$MOCK_PREBUILT" "\${!#}/release.tar.gz"; exit; fi
if [[ "$1 $2" == 'attestation verify' ]]; then [[ "\${MOCK_FAIL:-}" != attestation ]] || exit 1; cat "$MOCK_ATTESTATION"; exit; fi
case "$2" in
 */attempts/*/jobs*) cat "$MOCK_JOBS";;
 */artifacts*) cat "$MOCK_ARTIFACTS";;
 */actions/runs/12) cat "$MOCK_RUN";;
 *) cat "$MOCK_CI_FILE";;
esac`,
    ssh: `printf 'ssh %s\\n' "$*" >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != ssh ]] || exit 255; "$REAL_NODE" "$MOCK_ENTRY_FIXTURE" "\${!#}"`,
    scp: `printf 'scp\\n' >> "$MOCK_LOG"; arguments=("$@"); source=\${arguments[\${#arguments[@]}-2]}; destination=\${arguments[\${#arguments[@]}-1]}; cp "$source" "\${destination#*:}"`,
    npm: `
printf 'npm %s\\n' "$*" >> "$MOCK_LOG"
if [[ "$1" == --version ]]; then printf '%s\\n' "$MOCK_NPM_VERSION"; exit; fi
if [[ "$1" == ci && "\${MOCK_FAIL:-}" == install ]]; then exit 17; fi
if [[ "$1 $2" == 'run build' ]]; then
 printf 'build-commit=%s verified=%s\\n' "\${AISTUDY_COMMIT:-missing}" "\${AISTUDY_RELEASE_VERIFIED_SHA:-0}" >> "$MOCK_LOG"
 [[ "\${MOCK_FAIL:-}" != build ]] || exit 18
 mkdir -p apps/web/.next/static apps/web/.next/standalone/apps/web
 printf asset > apps/web/.next/static/asset.js
 printf server > apps/web/.next/standalone/apps/web/server.js
fi`,
    npx: `
printf 'migrate current=%s\\n' "$(readlink -f "$CURRENT_LINK")" >> "$MOCK_LOG"
if [[ "$MOCK_WORKER" == auto-restart && ! -f "$MOCK_STOPPED" ]]; then printf 'pending old worker restarted during migration\\n' >> "$MOCK_LOG"; exit 35; fi
if systemctl is-active --quiet aistudy-worker.service; then printf 'refused migration with active worker\\n' >> "$MOCK_LOG"; exit 35; fi
if [[ "\${MOCK_FAIL:-}" == owner-kill ]]; then kill -KILL "$PPID"; exec /bin/sleep 60; fi
if [[ "\${MOCK_FAIL:-}" == owner-term ]]; then kill -TERM "$PPID"; exit 143; fi
if [[ "\${MOCK_FAIL:-}" == migration-timeout ]]; then printf 'backend outcome unknown\\n' >&2; exit 124; fi
if [[ "\${MOCK_FAIL:-}" == lost-commit-receipt ]]; then printf '109 committed\\n' > "$DEPLOY_STATE/simulated-ledger"; exit 19; fi
[[ "\${MOCK_FAIL:-}" != migrate ]] || exit 19`,
    pg_dump: `if [[ "$1" == --version ]]; then if [[ "\${MOCK_FAIL:-}" == pg-version ]]; then printf 'pg_dump (PostgreSQL) 17.1\\n'; else printf 'pg_dump (PostgreSQL) 16.6\\n'; fi; exit; fi
printf 'pg_dump\\n' >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != backup ]] || exit 25; printf dump > "\${!#}"`,
    pg_restore: `if [[ "$1" == --version ]]; then printf 'pg_restore (PostgreSQL) 16.6\\n'; exit; fi
printf 'pg_restore %s\\n' "$1" >> "$MOCK_LOG"; [[ "\${MOCK_FAIL:-}" != backup-list ]] || exit 26`,
    df: `if [[ "\${MOCK_FAIL:-}" == disk ]]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nmock 100 99 1 99%% /\\n'; else exec /bin/df "$@"; fi`,
    systemctl: `
printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
 show)
  unit=\${!#}
  if [[ "$*" == *ExecStartEx* ]]; then
   flags=''; [[ "$unit" != aistudy-worker.service ]] || flags=no-setuid
   printf 'NeedDaemonReload=no\\nExecStartEx={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -S -B %s/writer-controls/hermes-trusted-loader.py exec %s %s ; flags=%s ; }\\n' "$DEPLOY_STATE" "$DEPLOY_STATE" "$unit" "$flags"
   exit
  fi
  if [[ "$*" == *FragmentPath* ]]; then
   printf 'FragmentPath=%s/%s\\nNeedDaemonReload=no\\n' "$SYSTEMD_DIR" "$unit"
   if [[ "$unit" == aistudy-web.service ]]; then
    printf 'DropInPaths=%s/aistudy-web.service.d/50-aistudy-release.conf\\nEnvironmentFiles=%s/.env.production (ignore_errors=no)\\n' "$SYSTEMD_DIR" "$DIR"
   else
    printf 'DropInPaths=%s/aistudy-worker.service.d/90-aistudy-protocol-guard.conf\\nEnvironmentFiles=%s/.env.production (ignore_errors=no) %s/worker-runtime.env (ignore_errors=no)\\n' "$SYSTEMD_DIR" "$DIR" "$WORKER_CONFIG_DIR"
   fi
   exit
  fi
  load=loaded; [[ "$MOCK_WORKER" != missing || "$unit" != aistudy-worker.service ]] || load=not-found
  printf 'LoadState=%s\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\nControlPID=0\\nJob=\\nControlGroup=\\n' "$load"
  [[ "\${MOCK_FAIL:-}" != residual-job ]] || printf 'Job=91\\n'
  [[ "\${MOCK_FAIL:-}" != residual-cgroup ]] || printf 'ControlGroup=/unreadable-test-cgroup\\nMainPID=922\\n'
  [[ "\${MOCK_FAIL:-}" != residual-control ]] || printf 'ControlPID=923\\n'
  [[ "\${MOCK_FAIL:-}" != unavailable-show ]] || exit 1
  if [[ "\${MOCK_FAIL:-}" == stop-still-active && -f "$MOCK_RESTARTED" && "$unit" == aistudy-worker.service ]]; then printf 'MainPID=345\\n'; fi;;
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
  if [[ -f "$MOCK_RESTARTED" ]]; then
   [[ "\${MOCK_FAIL:-}" != stop-after-start ]] || { printf 'Worker may still be active: simulated stop failure\\n' >&2; exit 40; }
   [[ "\${MOCK_FAIL:-}" != stop-still-active ]] || exit 0
  fi
  touch "$MOCK_STOPPED";;
 start|restart)
  fence="$SYSTEMD_DIR/$2.d/95-aistudy-migration-fence.conf"
  if [[ -f "$fence" ]]; then
   marker=$(sed -n 's/^ConditionPathExists=!//p' "$fence")
   if [[ -n "$marker" && -f "$marker" ]]; then printf 'writer skipped by migration fence\\n' >> "$MOCK_LOG"; exit 0; fi
  fi
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
    MOCK_NPM_VERSION: platform().npm,
    MOCK_ENTRY_FIXTURE: fileURLToPath(new URL('./hermes-entry-fixture.mjs', import.meta.url)),
    MOCK_MANAGER_FIXTURE: fileURLToPath(new URL('./hermes-deployment-manager-fixture.mjs', import.meta.url)),
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
      // The production cold-start budget now permits 120 identity probes. The
      // fixture removes sleeps, but subprocess creation still exceeds 15s on a
      // shared single-CPU host. Keep a bounded fixture budget and all assertions.
      const result = spawnSync("bash", [join(repo, "infra/deploy/deploy-hermes.sh"), action], { cwd: repo, encoding: "utf8", timeout: 60_000, env: childEnvironment });
      assert.ifError(result.error);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-never-print/);
      const allLog = readFileSync(log, "utf8");
      return { ...result, log: allLog, deltaLog: allLog.slice(logStart) };
    },
  };
}

for (const action of ['status', 'logs']) test(`${action} retains its existing direct release path without entry preflight`, t => {
  const f = fixture(t);
  // These read-only actions do not stage/start the managed entry.
  rmSync(join(f.repo, 'infra/deploy/hermes-entry.py'));
  const result = f.run(action);
  assert.equal(result.status, action === 'status' ? 1 : 0, result.stderr);
  if (action === 'status') assert.match(result.stderr, /Current release pointer is missing/);
  assert.doesNotMatch(result.deltaLog, /aistudy-entry|hermes-supervisor|systemctl stop|migrate|pg_dump|worker provision/);
  assert.deepEqual(readdirSync(f.state), []);
});

function prebuiltFixture(t) {
  const f = fixture(t, { MOCK_PREBUILT: "pending" });
  const source = join(f.root, "artifact-source");
  mkdirSync(source);
  const files = {
    "package-lock.json": '{}',
    "apps/web/.next/standalone/apps/web/server.js": "server",
    "apps/web/.next/standalone/apps/web/.next/static/asset.js": "asset",
    "apps/web/.next/standalone/node_modules/next/package.json": '{"name":"next","version":"15.3.3"}',
    "apps/worker/src/index.ts": "worker",
    "node_modules/tsx/dist/cli.mjs": "tsx",
    "node_modules/tsx/package.json": '{"name":"tsx","version":"4.20.6"}',
    "scripts/db-migrate.ts": "migration",
    "services/parser/opening_parser/__main__.py": "# parser",
    ".worker-protocol": "delivery-leases-v1\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), content, { mode: 0o644 });
  }
  // Privileged controls must match the separately transported trusted Git tree.
  mkdirSync(join(source, "infra/deploy"), { recursive: true });
  for (const name of readdirSync(join(f.repo, 'infra/deploy'))) copyFileSync(join(f.repo, 'infra/deploy', name), join(source, 'infra/deploy', name));
  const inventory = tree(source);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = { version: 1, sha: f.sha, branch: 'feat/opening-release', mainlineTip: f.sha, platform: platform(),
    lockfileSha256: hash(readFileSync(join(source, 'package-lock.json'))), files: inventory, treeSha256: hash(JSON.stringify(inventory)),
    dependencies: { worker: [{ path: 'node_modules/tsx/package.json', name: 'tsx', version: '4.20.6' }],
      standalone: [{ path: 'apps/web/.next/standalone/node_modules/next/package.json', name: 'next', version: '15.3.3' }] } };
  writeFileSync(join(source, 'release-manifest.json'), JSON.stringify(manifest));
  const archive = join(f.root, 'prebuilt.tar.gz');
  assert.equal(spawnSync('tar', ['--format=posix', '-czf', archive, '-C', source, ...readdirSync(source)]).status, 0);
  const writeJson = (name, value) => { const path = join(f.root, name); writeFileSync(path, JSON.stringify(value)); return path; };
  Object.assign(f.env, {
    MOCK_PREBUILT: archive, ARTIFACT_RUN_ID: '12', TARGET_SHA: f.sha, MIN_FREE_KB: '6291456',
    MOCK_RUN: writeJson('run.json', { ...f.ciRun(), run_attempt: 1, path: '.github/workflows/ci.yml', head_repository: { full_name: 'Xhhemoing/study-assistant-opening' } }),
    MOCK_JOBS: writeJson('jobs.json', { total_count: 7, jobs: ['lint-typecheck-test-build', 'real-worker-pdf-browser-flow', 'production-build', 'static-unit-contract-spikes', 'integration-parser', 'handler-browser-spikes', 'isolated-worker-pdf-browser'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }),
    MOCK_ARTIFACTS: writeJson('artifacts.json', { total_count: 1, artifacts: [{ id: 22, name: `release-${f.sha}`, expired: false, workflow_run: { id: 12, head_sha: f.sha } }] }),
    MOCK_ATTESTATION: writeJson('attestation.json', [{ verificationResult: { signature: { certificate: { extensions: { runInvocationURI: 'https://github.com/Xhhemoing/study-assistant-opening/actions/runs/12/attempts/1' } } } } }]),
  });
  return f;
}

for (const failure of ['', 'backup', 'backup-list', 'migrate', 'health', 'attestation', 'tip-change', 'pg-version']) {
  test(`prebuilt ${failure || 'success'} retains managed safety and never rebuilds`, t => {
    const f = prebuiltFixture(t);
    const result = f.run('deploy', { MOCK_FAIL: failure, MOCK_PENDING: failure === 'migrate' ? '1' : '0' });
    assert.equal(result.status === 0, failure === '', result.stderr);
    // npm --version is a platform comparison, not an install/build.
    assert.doesNotMatch(result.deltaLog, /npm (ci|run build)/);
    assertLegacyIntact(f);
    if (['attestation', 'tip-change'].includes(failure)) {
      assert.doesNotMatch(result.deltaLog, /ssh|scp|migrate|systemctl/);
      return;
    }
    if (failure) {
      if (failure === 'health') {
        assert.notEqual(readlinkSync(f.current), f.server);
        assertForwardRefusal(f, result);
      } else {
        assert.equal(readlinkSync(f.current), f.server);
        assert.equal(readFileSync(join(f.systemd, 'aistudy-worker.service'), 'utf8'), f.oldUnit);
      }
      if (failure === 'pg-version') { assert.match(result.stderr, /PostgreSQL 16/); assert.doesNotMatch(result.log, /migrate current=/); }
      if (failure === 'backup') assert.match(result.log, /pg_dump/);
      if (failure === 'backup-list') assert.match(result.log, /pg_restore --list/);
      if (failure === 'migrate') { assert.match(result.log, /migrate current=/); assert.match(result.stderr, /FORWARD FIX REQUIRED/); }
      if (failure === 'health') assert.doesNotMatch(result.stderr, /DEGRADED: web restored/);
    } else {
      assert.notEqual(readlinkSync(f.current), f.server);
      assert.match(result.log, /worker provision/);
      assert(result.log.indexOf('pg_restore --list') < result.log.indexOf('db plan current='));
    }
  });
}

test('prebuilt no-pending failure retains candidate and refuses both managed OLD_TARGET and legacy restoration', t => {
  const f = prebuiltFixture(t);
  assert.equal(f.run().status, 0);
  const old = readlinkSync(f.current);
  const failed = f.run('deploy', { MOCK_FAIL: 'health', MOCK_HEALTHY_TARGET: old });
  assert.notEqual(failed.status, 0);
  assert.notEqual(readlinkSync(f.current), old);
  assert.notEqual(readlinkSync(f.current), f.server);
  assertForwardRefusal(f, failed);
  assert.doesNotMatch(failed.deltaLog, /npm (ci|run build)/);
});

for (const scenario of ['wrong-attestation-run', 'missing-target', 'dirty', 'red-required-check', 'wrong-source-repo', 'disk-floor', 'wrong-architecture', 'tampered-blob', 'untrusted-control']) {
  test(`prebuilt ${scenario} fails closed without build or service changes`, t => {
    const f = prebuiltFixture(t);
    if (scenario === 'wrong-attestation-run') writeFileSync(f.env.MOCK_ATTESTATION, JSON.stringify([{ verificationResult: { signature: { certificate: { extensions: { runInvocationURI: 'https://github.com/Xhhemoing/study-assistant-opening/actions/runs/11/attempts/1' } } }, statement: { predicate: { runDetails: { metadata: { invocationId: 'https://github.com/Xhhemoing/study-assistant-opening/actions/runs/12/attempts/1' } } } } } }]));
    if (scenario === 'missing-target') f.env.TARGET_SHA = '';
    if (scenario === 'dirty') writeFileSync(join(f.repo, 'untracked'), 'dirty');
    if (scenario === 'red-required-check') { const jobs = JSON.parse(readFileSync(f.env.MOCK_JOBS)); jobs.jobs[0].conclusion = 'failure'; writeFileSync(f.env.MOCK_JOBS, JSON.stringify(jobs)); }
    if (scenario === 'wrong-source-repo') { const run = JSON.parse(readFileSync(f.env.MOCK_RUN)); run.head_repository.full_name = 'attacker/fork'; writeFileSync(f.env.MOCK_RUN, JSON.stringify(run)); }
    if (scenario === 'disk-floor') f.env.MIN_FREE_KB = '10';
    if (scenario === 'wrong-architecture' || scenario === 'untrusted-control') {
      const manifestFile = join(f.root, 'artifact-source/release-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestFile));
      if (scenario === 'wrong-architecture') manifest.platform.arch = 'other';
      else {
        writeFileSync(join(f.root, 'artifact-source/infra/deploy/provision-worker.sh'), 'exit 99\n');
        manifest.files = tree(join(f.root, 'artifact-source'));
        manifest.treeSha256 = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
      }
      writeFileSync(manifestFile, JSON.stringify(manifest));
      assert.equal(spawnSync('tar', ['-czf', f.env.MOCK_PREBUILT, '-C', join(f.root, 'artifact-source'), ...readdirSync(join(f.root, 'artifact-source'))]).status, 0);
    }
    if (scenario === 'tampered-blob') writeFileSync(f.env.MOCK_PREBUILT, 'not an archive');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.deltaLog, /npm (ci|run build)|migrate current=|systemctl (stop|restart)/);
    assertLegacyIntact(f);
  });
}

function seedPause(f, target) {
  const hash = createHash('sha256').update(target).digest('hex');
  mkdirSync(join(f.state, 'worker-pauses'), { recursive: true, mode: 0o700 });
  const pause = join(f.state, 'worker-pauses', `${hash}.pause`);
  writeFileSync(pause, '1\n', { mode: 0o600 });
  return pause;
}
function assertForwardRefusal(f, result) {
  assert.notEqual(result.status, 0);
  for (const name of ['migration-forward-only', 'writers-fenced', 'activation-incomplete']) assert(existsSync(join(f.state, name)), name);
  assert.doesNotMatch(result.deltaLog, /worker --restore|systemctl restart/);
  assert.doesNotMatch(result.stdout + result.stderr, /Previous release restored|DEGRADED: web restored/);
  assert.match(result.deltaLog, /systemctl stop aistudy-web.service/);
  assert.match(result.deltaLog, /systemctl stop aistudy-worker.service/);
}
function assertRollbackRefusal(f, result, target) {
  assert.notEqual(result.status, 0);
  assert.equal(readlinkSync(f.current), target);
  assert.match(result.stderr, /Refusing rollback across a migration boundary|requires an approved compatibility profile/);
  assert.doesNotMatch(result.deltaLog, /systemctl (start|restart|stop)|worker --restore/);
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
    assertForwardRefusal(f, failed);
    assert(existsSync(join(f.state, "activation-incomplete")));
    assert(existsSync(f.env.MOCK_STOPPED));
    assert.doesNotMatch(failed.log, /worker --restore/);
    assert.equal(failed.log.match(/systemctl start aistudy-web.service/g)?.length, 1);
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
  assertRollbackRefusal(f, rejected, current);
  assert.equal(readlinkSync(f.current), current);
  assert.doesNotMatch(rejected.deltaLog, /systemctl stop|systemctl restart|worker --restore/);
});

test("Study compatibility marker alone does not authorize old-target rollback", t => {
  const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v1" });
  assert.equal(f.run().status, 0);
  assert.equal(f.run().status, 0);
  const current = readlinkSync(f.current);
  assertRollbackRefusal(f, f.run('rollback'), current);
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
  assertRollbackRefusal(f, rejected, current);
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
    assertForwardRefusal(f, failed);
    assert(existsSync(join(f.state, "activation-incomplete")));
    assert(existsSync(f.env.MOCK_STOPPED));
    assert.doesNotMatch(failed.deltaLog, /worker --restore/);
    assert.equal(failed.deltaLog.match(/systemctl start aistudy-web.service/g)?.length, 1);
    const transition = readdirSync(join(f.state, "releases"))[0];
    assert(existsSync(join(f.state, "releases", transition, "study-v2-app-start-attempted")));
    assert.equal(f.run("restart").status, 3);
  });
}

for (const failure of ["quiescence", "provision"]) {
  test(`Study v2 ${failure} before activation refuses Study v1 restoration without profile`, t => {
    const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2" });
    writeFileSync(join(f.server, ".worker-protocol"), "delivery-leases-study-v1\n");
    const failed = f.run("deploy", { MOCK_FAIL: failure });
    assert.notEqual(failed.status, 0);
    assert.equal(readlinkSync(f.current), f.server);
    assertForwardRefusal(f, failed);
    if (failure === 'quiescence') assert.match(failed.stderr, /Old-target restoration requires an independently approved compatibility profile/);
    else assert.match(failed.stderr, /FORWARD FIX REQUIRED/);
    assert(existsSync(f.env.MOCK_STOPPED));
  });
}

test("Study v2 old-target rollback and automatic recovery require independent compatibility proof", t => {
  const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2" });
  assert.equal(f.run().status, 0);
  const previous = readlinkSync(f.current);
  assert.equal(f.run().status, 0);
  const rollback = f.run("rollback");
  assertRollbackRefusal(f, rollback, readlinkSync(f.current));
  const failed = f.run("deploy", { MOCK_FAIL: "health", MOCK_HEALTHY_TARGET: previous });
  assert.notEqual(readlinkSync(f.current), previous);
  assertForwardRefusal(f, failed);
  assert(existsSync(f.env.MOCK_STOPPED));
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

test("deployment can move to another disk while old-root rollback still requires a profile", t => {
  const f = fixture(t);
  const first = f.run("deploy", { RELEASES_DIR: `${f.server}-releases` });
  assert.equal(first.status, 0, first.stderr);
  const previous = readlinkSync(f.current);
  const moved = f.run("deploy");
  assert.equal(moved.status, 0, moved.stderr);
  assert(readlinkSync(f.current).startsWith(`${f.releases}/`));
  const target = readlinkSync(f.current);
  assert.notEqual(target, previous);
  const rollback = f.run("rollback");
  assertRollbackRefusal(f, rollback, target);
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
  assert(result.log.indexOf("pg_restore --list") < result.log.indexOf("db plan current="));
  assert.match(result.log, new RegExp(`db plan current=${f.server}`));
  assert.doesNotMatch(result.log, /migrate current=/);
  assert.match(result.log, /systemctl start aistudy-worker.service/);
  assert.doesNotMatch(result.log, /systemctl restart/);
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
  const migration = result.log.indexOf("db plan current=");
  const restart = result.log.indexOf("systemctl start aistudy-worker.service");
  assert(backup >= 0 && backup < snapshot && snapshot < stop && stop < migration && migration < restart, result.log);
  assert.doesNotMatch(result.log, /refused migration with active worker/);
});

test("an inactive legacy worker with a pending automatic restart is stopped before migration", t => {
  const f = fixture(t, { MOCK_WORKER: "auto-restart" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert(result.log.indexOf("systemctl stop aistudy-worker.service") < result.log.indexOf("db plan current="));
  assert.doesNotMatch(result.log, /pending old worker restarted during migration/);
  assert.match(result.log, /systemctl start aistudy-worker.service/);
});

for (const failure of ["", "migrate"]) {
  test(`first installation without a worker unit supports ${failure || "normal deployment"}`, t => {
    const f = fixture(t, { MOCK_WORKER: "missing", MOCK_FAIL: failure, MOCK_PENDING: failure ? '1' : '0' });
    rmSync(join(f.systemd, "aistudy-worker.service"));
    const result = f.run();
    assert.equal(result.status === 0, !failure, result.stderr);
    assert.doesNotMatch(result.log, /systemctl restart aistudy-worker.service/);
    assert.match(result.log, /systemctl stop aistudy-worker.service/);
    if (failure) assert.equal(readlinkSync(f.current), f.server);
  });
}

test("migration failure retains the pointer/configuration and backup with both writers fenced", t => {
  const f = fixture(t, { MOCK_FAIL: "migrate", MOCK_PENDING: '1' });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assertLegacyIntact(f);
  assert.equal(readlinkSync(f.current), f.server);
  assert(result.log.indexOf("systemctl stop aistudy-worker.service") < result.log.indexOf("migrate current="), result.log);
  assert.doesNotMatch(result.log, /systemctl restart|worker --restore/);
  assert.doesNotMatch(result.log, /worker provision/);
  assert.match(result.stderr, /FORWARD FIX REQUIRED/);
  assert.equal(readFileSync(join(f.systemd, "aistudy-worker.service"), "utf8"), f.oldUnit);
  assert.equal(readFileSync(join(f.workerConfig, "worker-runtime.env"), "utf8"), "old-runtime-env\n");
  assert.equal(readFileSync(join(f.systemd, "aistudy-web.service.d/50-aistudy-release.conf"), "utf8"), "old-web-override\n");
  assert(existsSync(f.env.MOCK_STOPPED));
  assert(!existsSync(f.env.MOCK_RESTARTED));
  assert(existsSync(join(f.state, 'migration-forward-only')));
  assert(existsSync(join(f.state, 'writers-fenced')));
  assert(readdirSync(f.backups).some(name => name.endsWith(".dump")));
});

for (const failure of ["provision", "web-start", "worker", "worker-partial-start", "health", "worker-after-start", "identity"]) {
  test(`${failure} failure fences both writers without restoring previous code or configuration`, t => {
    const f = fixture(t, { MOCK_FAIL: failure });
    const result = f.run();
    assert.notEqual(result.status, 0, result.stderr);
    assertLegacyIntact(f);
    assertForwardRefusal(f, result);
    if (failure === 'provision') {
      assert.equal(readlinkSync(f.current), f.server);
      assert.equal(readFileSync(join(f.systemd, 'aistudy-worker.service'), 'utf8'), f.oldUnit);
      assert.equal(readFileSync(join(f.workerConfig, 'worker-runtime.env'), 'utf8'), 'old-runtime-env\n');
    } else {
      assert.notEqual(readlinkSync(f.current), f.server);
      assert.match(readFileSync(join(f.systemd, 'aistudy-worker.service'), 'utf8'), /new-worker-unit/);
      const transition = readdirSync(join(f.state, 'releases'))[0];
      assert(existsSync(join(f.state, 'releases', transition, 'lease-worker-start-attempted')));
    }
    const active = spawnSync(join(f.root, 'bin/systemctl'), ['is-active', '--quiet', 'aistudy-worker.service'], { env: f.env });
    assert.notEqual(active.status, 0);
    assert(readdirSync(f.backups).some(name => name.endsWith(".dump")));
  });
}

test("explicit legacy rollback refuses without compatibility proof and never rolls DB back", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const target = readlinkSync(f.current), unit = readFileSync(join(f.systemd, 'aistudy-worker.service'), 'utf8');
  const rollback = f.run('rollback');
  assertRollbackRefusal(f, rollback, target);
  assert.equal(readFileSync(join(f.systemd, 'aistudy-worker.service'), 'utf8'), unit);
  assert.equal(rollback.log.match(/^migrate current=/gm)?.length ?? 0, 0);
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
    if (worker === "enabled") assert.match(result.log, /systemctl start aistudy-worker.service/);
    else assert.doesNotMatch(result.log, /systemctl (start|restart) aistudy-worker.service/);
  });
}


test("before any migration, missing compatibility profile refuses legacy restoration", t => {
  const f = fixture(t, { MOCK_FAIL: "quiescence", MOCK_LEGACY_ROOT: "1" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readlinkSync(f.current), f.server);
  assert.match(result.stderr, /Old-target restoration requires an independently approved compatibility profile/);
  assert.doesNotMatch(result.stderr + result.stdout, /Previous release restored|旧身份已恢复/);
  assert.doesNotMatch(result.deltaLog, /worker --restore|systemctl (start|restart)/);
  assert(!existsSync(join(f.state, "current-identity")));
  assert(existsSync(join(f.state, 'activation-incomplete')));
  for (const name of ['migration-forward-only', 'writers-fenced']) assert(existsSync(join(f.state, name)));
});

test("repeated explicit rollback cannot bypass missing compatibility authorization", t => {
  const f = fixture(t, { MOCK_LEGACY_ROOT: '1' });
  assert.equal(f.run().status, 0);
  const managed = readlinkSync(f.current);
  for (let attempt = 0; attempt < 2; attempt++) assertRollbackRefusal(f, f.run('rollback'), managed);
});

test("a paused enabled legacy worker stays blocked through script restart, status, direct starts and boot", t => {
  const f = fixture(t, { MOCK_WORKER: "enabled" });
  mkdirSync(join(f.systemd, "aistudy-worker.service.d"));
  const unrelated = join(f.systemd, "aistudy-worker.service.d/80-admin.conf");
  writeFileSync(unrelated, "[Service]\nMemoryMax=2G\n");
  assert.equal(f.run().status, 0);
  const failed = f.run('deploy', { MOCK_FAIL: 'health' });
  assertForwardRefusal(f, failed);
  const marker = seedPause(f, readlinkSync(f.current));
  writeFileSync(join(f.systemd, 'aistudy-worker.service.d/90-aistudy-protocol-guard.conf'), `[Unit]\nConditionPathExists=!${marker}\n`);
  const guard = readFileSync(join(f.systemd, 'aistudy-worker.service.d/90-aistudy-protocol-guard.conf'), 'utf8');
  assert.equal(guard.match(/^ConditionPathExists=!(.+)$/m)?.[1], marker);
  assert(existsSync(marker), 'persistent condition must reference an existing private marker');
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.equal(readFileSync(unrelated, "utf8"), "[Service]\nMemoryMax=2G\n");
  for (const action of ["restart", "status"]) {
    const result = f.run(action);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /FORWARD FIX REQUIRED/);
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

test("a managed release preserves retained historical pauses while starting only its candidate", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const pause = seedPause(f, f.server);
  const deployed = f.run();
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.equal(readFileSync(pause, 'utf8'), '1\n');
  assert(!existsSync(f.env.MOCK_STOPPED));
  const guard = readFileSync(join(f.systemd, 'aistudy-worker.service.d/90-aistudy-protocol-guard.conf'), 'utf8');
  assert(!existsSync(guard.match(/^ConditionPathExists=!(.+)$/m)[1]));
});

test("a failed web start retains historical pause and never reverts to the legacy pointer", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const pause = seedPause(f, f.server);
  const failed = f.run('deploy', { MOCK_FAIL: 'web-start' });
  assertForwardRefusal(f, failed);
  assert.notEqual(readlinkSync(f.current), f.server);
  assert(existsSync(pause));
  assert.doesNotMatch(failed.log, /unsafe legacy pointer switch without guard/);
});

test("lease-protocol labels cannot authorize automatic restoration of previous worker", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const managed = readlinkSync(f.current);
  const failed = f.run('deploy', { MOCK_FAIL: 'health', MOCK_HEALTHY_TARGET: managed });
  assertForwardRefusal(f, failed);
  assert.notEqual(readlinkSync(f.current), managed);
  assert(existsSync(f.env.MOCK_STOPPED));
  assert(!existsSync(join(f.state, 'worker-pauses')));
});

test("explicit rollback between lease-protocol releases still requires an approved profile", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.run().status, 0);
  assertRollbackRefusal(f, f.run('rollback'), readlinkSync(f.current));
});

test("legacy rollback refuses before health or configuration restoration and preserves retained pause", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const pause = seedPause(f, f.server);
  const failed = f.run('rollback', { MOCK_FAIL_LEGACY_HEALTH: '1' });
  assertRollbackRefusal(f, failed, readlinkSync(f.current));
  assert(existsSync(pause));
  assert(!existsSync(f.env.MOCK_STOPPED));
  assert.doesNotMatch(failed.deltaLog, /health current=/);
});

test("failed activation arms persistent barriers that ordinary deployment cannot clear or use to restore config", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const managed = readlinkSync(f.current);
  const failed = f.run('deploy', { MOCK_FAIL: 'health' });
  assertForwardRefusal(f, failed);
  assert.notEqual(readlinkSync(f.current), managed);
  assert.notEqual(readFileSync(join(f.systemd, 'aistudy-worker.service'), 'utf8'), f.oldUnit, 'old absolute unit is never restored');
  const guardPath = join(f.systemd, 'aistudy-worker.service.d/90-aistudy-protocol-guard.conf');
  const guard = readFileSync(guardPath, 'utf8');
  for (const action of ["restart", "status"]) {
    const result = f.run(action);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /FORWARD FIX REQUIRED/);
    assert.doesNotMatch(result.deltaLog, /systemctl restart/);
    assert.doesNotMatch(result.deltaLog, /unsafe guard release/, "the script must reject before the mock's guard observer can intervene");
    assert.equal(readFileSync(guardPath, "utf8"), guard, "script must not release the actual legacy guard based only on CURRENT");
  }
  // No approved manual clear escape hatch exists in this implementation.
  assert(existsSync(join(f.state, 'migration-forward-only')));
  assert.equal(f.run('deploy').status, 3);
  assert.equal(f.run('rollback').status, 3);
});

for (const failure of ["pause-guard", "pause-reload"]) {
  test(`${failure} failure never restores a legacy pointer without a confirmed persistent guard`, t => {
    const f = fixture(t);
    const failed = f.run("deploy", { MOCK_FAIL: failure });
    assert.notEqual(failed.status, 0);
    assert.notEqual(readlinkSync(f.current), f.server, "failed safety guard must retain the managed code pointer");
    assertForwardRefusal(f, failed);
    assert(existsSync(f.env.MOCK_STOPPED));
    assert(!existsSync(join(f.state, 'worker-pauses')), 'failure does not fabricate a legacy-resume path');
  });
  test(`${failure} during explicit legacy rollback preserves safe managed recovery boundaries`, t => {
    const f = fixture(t);
    assert.equal(f.run().status, 0);
    const managed = readlinkSync(f.current);
    const failed = f.run("rollback", { MOCK_FAIL: failure, MOCK_HEALTHY_TARGET: managed });
    assert.notEqual(failed.status, 0);
    assert.equal(readlinkSync(f.current), managed);
    assert.doesNotMatch(failed.log, /unsafe legacy pointer switch without guard/);
    assertRollbackRefusal(f, failed, managed);
    assert(!existsSync(f.env.MOCK_STOPPED), 'refused rollback never disturbs the committed candidate');
  });
}

for (const failure of ["stop-after-start", "stop-still-active"]) {
  test(`${failure} never switches back to legacy while the lease worker may still run`, t => {
    const f = fixture(t);
    const failed = f.run("deploy", { MOCK_FAIL: failure });
    assert.notEqual(failed.status, 0);
    assert.notEqual(readlinkSync(f.current), f.server);
    assert.match(failed.stderr, /Writer stop UNCONFIRMED/);
    assertForwardRefusal(f, failed);
    assert(!existsSync(f.env.MOCK_STOPPED));
  });
}

test("a web configuration restoration failure is never swallowed as successful rollback", t => {
  const f = fixture(t, { MOCK_FAIL: "rollback-copy" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assertForwardRefusal(f, result);
  assert.doesNotMatch(result.deltaLog, /worker --restore/);
});


test("an activation rename failure cleans only its temporary pointer and refuses restoration", t => {
  const f = fixture(t, { MOCK_FAIL: "switch" });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readlinkSync(f.current), f.server);
  assertForwardRefusal(f, result);
  assert.match(result.stderr, /FORWARD FIX REQUIRED/);
  assert.match(readFileSync(join(f.systemd, 'aistudy-web.service.d/50-aistudy-release.conf'), 'utf8'), /writer-controls\/hermes-trusted-loader.py exec/);
  assert(!readdirSync(f.root).some(name => name.startsWith("current.next.")));
});

test("release build receives the exact verified commit", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, new RegExp(`build-commit=${f.sha} verified=1`));
});

for (const failure of ['migrate', 'provision', 'switch', 'web-start', 'worker-partial-start', 'health', 'migration-timeout', 'lost-commit-receipt', 'owner-term', 'owner-kill']) {
  test(`pending migration ${failure} retains forward-only guard and never restores old writers`, t => {
    const f = fixture(t, { MOCK_PENDING: '1', MOCK_FAIL: failure });
    const began = Date.now();
    const result = f.run();
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /FORWARD FIX REQUIRED/);
    assert.doesNotMatch(result.deltaLog, /worker --restore/);
    assert.doesNotMatch(result.stderr, /Previous release restored|DEGRADED: web restored/);
    assert(existsSync(join(f.state, 'migration-forward-only')));
    assert(existsSync(join(f.state, 'writers-fenced')));
    assert.match(result.deltaLog, /systemctl stop aistudy-web.service/);
    assert.match(result.deltaLog, /systemctl stop aistudy-worker.service/);
    assert(existsSync(f.env.MOCK_STOPPED));
    if (failure === 'owner-kill') assert(Date.now() - began < 15000, 'owner SIGKILL must not leave the sleep child holding pipes/lock for 60s');
    const pointer = readlinkSync(f.current);
    if (['migrate', 'provision', 'switch', 'owner-term', 'owner-kill', 'migration-timeout', 'lost-commit-receipt'].includes(failure)) assert.equal(pointer, f.server);
    else assert.notEqual(pointer, f.server, 'retain the failed activation pointer, not an old writer');
    if (['web-start', 'worker-partial-start', 'health'].includes(failure)) {
      assert.match(result.stderr, /Authorized candidate start failed|Web\/worker health check failed/);
      assert.doesNotMatch(result.log, /systemctl restart/);
    }
    if (failure === 'lost-commit-receipt') assert.equal(readFileSync(join(f.state, 'simulated-ledger'), 'utf8'), '109 committed\n');
    const transition = readdirSync(join(f.state, 'releases'))[0];
    assert(existsSync(join(f.state, 'releases', transition, 'forward-armed')));
    assert(!existsSync(join(f.state, 'releases', transition, 'success-record')));
    for (const action of ['restart', 'rollback', 'deploy', 'status']) {
      const rejected = f.run(action, { MOCK_FAIL: '' });
      assert.equal(rejected.status, 3, rejected.stderr);
      assert.doesNotMatch(rejected.deltaLog, /systemctl restart|migrate current=/);
      assert.equal(readlinkSync(f.current), pointer);
    }
    assertLegacyIntact(f);
  });
}
for (const failure of ['residual-job', 'residual-cgroup', 'residual-control', 'unavailable-show']) {
  test(`stop ${failure} is unconfirmed and still attempts both services`, t => {
    const f = fixture(t, { MOCK_PENDING: '1', MOCK_FAIL: failure });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UNCONFIRMED/);
    assert.match(result.log, /systemctl stop aistudy-web.service/);
    assert.match(result.log, /systemctl stop aistudy-worker.service/);
    assert.doesNotMatch(result.log, /migrate current=|systemctl restart/);
  });
}
test('pending migration authorizes the candidate once, commits receipt and leaves disabled worker stopped', t => {
  const f = fixture(t, { MOCK_PENDING: '1', MOCK_WORKER: 'disabled' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const transition = join(f.state, 'releases', readdirSync(join(f.state, 'releases'))[0]);
  assert(existsSync(join(transition, 'forward-armed')));
  assert(existsSync(join(transition, 'migration-succeeded')));
  const binding = JSON.parse(readFileSync(join(f.state, 'protocol2-transition.json')));
  const receipt = JSON.parse(readFileSync(join(f.state, 'commit-receipts', `${binding.owner}.json`)));
  assert.deepEqual(receipt, { ...binding, phase: 'terminal' });
  assert.equal(binding.target, readlinkSync(f.current));
  for (const name of ['migration-forward-only', 'writers-fenced', 'activation-incomplete']) assert(!existsSync(join(f.state, name)));
  assert.equal(result.log.match(/systemctl start aistudy-web.service/g)?.length, 1);
  assert.doesNotMatch(result.log, /systemctl (restart|start aistudy-worker)/);
  assert(result.log.indexOf('migrate current=') < result.log.indexOf('systemctl start aistudy-web.service'));
  // Actual peercred/pidfd tests retain ungranted, wrong-target and duplicate
  // denial checks; this fixture models only the deployment owner call chain.
});

for (const point of ['guard-file', 'guard-directory', 'terminal-receipt']) {
test(`${point} fsync failure reaches real supervisor and cannot publish durable success`, t => {
  const f = fixture(t, { MOCK_PENDING: point === 'terminal-receipt' ? '0' : '1' });
  const preload = join(f.root, 'fail-fsync.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original=fs.fsyncSync; fs.fsyncSync=fd=>{ const name=fs.readlinkSync('/proc/self/fd/'+fd);
      if (${JSON.stringify(point)}==='guard-file' && name.includes('migration-forward-only.next-')
        || ${JSON.stringify(point)}==='guard-directory' && name===${JSON.stringify(f.state)}
        ) throw new Error('injected fsync failure');
      return original(fd); }; syncBuiltinESMExports();`);
  const result = f.run('deploy', { NODE_OPTIONS: `--import=${preload}`, MOCK_RECEIPT_FAULT: point === 'terminal-receipt' ? '1' : '0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Guard\/fence persistence|guard persistence|injected fsync failure/);
  if (point !== 'terminal-receipt') assert.doesNotMatch(result.log, /migrate current=|systemctl restart/);
  else assert.doesNotMatch(result.log, /migrate current=/);
  assert(existsSync(join(f.state, 'writers-fenced')));
  assert.equal(f.run('restart').status, 3);
});
}

test('failed fence persistence still attempts both service stops before quiescence', t => {
  const f = fixture(t, { MOCK_PENDING: '1', MOCK_FAIL: 'migrate' });
  const preload = join(f.root, 'fence-fault.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.fsyncSync; fs.fsyncSync=fd=>{if(fs.readlinkSync('/proc/self/fd/'+fd).includes('writers-fenced.next-')) throw new Error('fence fsync fault');return original(fd);};syncBuiltinESMExports();`);
  const result = f.run('deploy', { NODE_OPTIONS: `--import=${preload}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNCONFIRMED/);
  const stops = [...result.log.matchAll(/systemctl stop (aistudy-(?:web|worker).service)/g)];
  assert(stops.length >= 4, result.log);
  assert.deepEqual(stops.slice(-2).map(match => match[1]), ['aistudy-web.service', 'aistudy-worker.service']);
  assert(result.log.lastIndexOf('db quiescence') > stops.at(-1).index);
  assert.doesNotMatch(result.log, /migrate current=|worker --restore/);
  assert(existsSync(join(f.state, 'migration-forward-only')));
});

for (const input of ['web-unit', 'web-override', 'worker-unit', 'runtime-env', 'protocol-guard', 'runtime-helper', 'release-sha', 'worker-protocol']) {
  test(`actual ${input} file fsync fault cannot publish success or restore old writers`, t => {
    const f = fixture(t);
    const endings = {
      'web-unit': '/systemd/aistudy-web.service', 'web-override': '/50-aistudy-release.conf',
      'worker-unit': '/systemd/aistudy-worker.service', 'runtime-env': '/worker-runtime.env',
      'protocol-guard': '/90-aistudy-protocol-guard.conf', 'runtime-helper': '/runtime-identity.mjs',
      'release-sha': '/.release-sha', 'worker-protocol': '/.worker-protocol',
    };
    const preload = join(f.root, 'actual-fsync.mjs');
    writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.fsyncSync; fs.fsyncSync=fd=>{if(fs.readlinkSync('/proc/self/fd/'+fd).endsWith(${JSON.stringify(endings[input])})) throw new Error('actual config fsync fault'); return original(fd);}; syncBuiltinESMExports();`);
    const result = f.run('deploy', { NODE_OPTIONS: `--import=${preload}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /actual config fsync fault/);
    assert(existsSync(join(f.state, 'writers-fenced')));
    assert(existsSync(join(f.state, 'migration-forward-only')));
    assert.doesNotMatch(result.deltaLog, /worker --restore/);
    assert.notEqual(readlinkSync(f.current), f.server);
    const transition = join(f.state, 'releases', readdirSync(join(f.state, 'releases'))[0]);
    assert(!existsSync(join(transition, 'success-record')));
  });
}

test('restart command failure cannot become success through a healthy endpoint', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const result = f.run('restart', { MOCK_FAIL: 'web-start' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /restarted and healthy/);
  assert.doesNotMatch(result.deltaLog, /health current=/);
  assert(existsSync(join(f.state, 'migration-forward-only')));
});

for (const [setting, value, attributes] of [["core.autocrlf", "true"], ["core.eol", "crlf", "* text\n"]]) {
  test(`deploy archives the committed bytes despite local ${setting}=${value}`, t => {
    const f = fixture(t, { MOCK_ARTIFACT_PROTOCOL: "delivery-leases-study-v2" });
    // core.eol only converts files marked as text; the fixture commits no attributes.
    if (attributes) {
      mkdirSync(join(f.repo, ".git/info"), { recursive: true });
      writeFileSync(join(f.repo, ".git/info/attributes"), attributes);
    }
    f.git("config", setting, value);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(readlinkSync(f.current), "services/parser/placeholder"), "utf8"), "parser source\n");
  });
}