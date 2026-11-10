#!/usr/bin/env node
// Managed release owner and crash fence. Does not claim protection against host,
// kernel or supervisor death. Persistent conditions also fence the next boot.
import { spawn, spawnSync } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync as writeFileForUnit } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureConfiguration, persistConfiguration } from "./hermes-config-durability.mjs";
import { binding, brokerControl, checkCompletion, claimCompletion, checkRepair, classify, closeBroker, configIdentity, durableWrite, installWriterBoundary, retireBroker, startBroker, syncDirectory, terminalCommit, verifyEntrySources, python, systemctlCommand, SUPERVISOR_REQUEST_TIMEOUT_MS, completionLaunchAdmission } from './hermes-writer-control.mjs';
export { durableWrite, syncDirectory, installWriterBoundary } from './hermes-writer-control.mjs';

// A disconnected SSH pipe is not permission to abandon independent cleanup.
export function protectCleanupStreams(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) stream.on("error", () => { /* Diagnostics unavailable; continue safety work. */ });
}
export function processStarttime(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!/^\d+$/.test(started ?? "")) throw new Error("Owner starttime unavailable");
  return started;
}
export function signalVerifiedGroup(pid, expectedStart, signal, identity = processStarttime, kill = process.kill) {
  try {
    if (!expectedStart || identity(pid) !== expectedStart) return false;
    kill(-pid, signal);
    return true;
  } catch { return false; }
}

const units = ["aistudy-web.service", "aistudy-worker.service"];
const filename = fileURLToPath(import.meta.url);
function present(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function validateArguments(args) {
  if (![11, 13].includes(args.length) || !["deploy", "restart", "rollback", "repair-pre-migration", "complete-postmigration"].includes(args[0])) throw new Error("Invalid managed arguments");
  for (const value of args.slice(1, 8)) {
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.includes('/..') || value.endsWith('/.')) throw new Error("Managed paths must be normalized safe absolute paths");
  }
}
export const completionUnit = 'aistudy-postmigration-completion.service';
const completionLockEntry = "import fcntl,os,sys,stat; fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o077 and s.st_nlink==1; fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); os.dup2(fd,9,inheritable=True); os.execv(sys.argv[2],sys.argv[2:])";
function assertCompletionLock(state) {
  const held = fstatSync(9), path = lstatSync(join(state, 'deploy.lock'));
  if (!held.isFile() || held.uid !== 0 || held.mode & 0o077 || held.nlink !== 1 || held.dev !== path.dev || held.ino !== path.ino
    || !readFileSync('/proc/self/fdinfo/9', 'utf8').split('\n').some(line =>
      new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s+\\S+:${held.ino}\\s+0\\s+EOF$`).test(line))) throw new Error('Completion exclusive managed lock not held');
}
export function completionService(run = command, selfCgroup = () => readFileSync('/proc/self/cgroup', 'utf8').trim(), stopping = false) {
  const keys = ['Id', 'LoadState', 'Restart', 'KillMode', 'RuntimeMaxUSec', 'TimeoutStopUSec', 'InvocationID', 'ControlGroup', 'Slice', 'MainPID', 'ExecMainPID', 'ExecStopPost'];
  const result = run(['show', '--all', `--property=${keys.join(',')}`, completionUnit]);
  const pairs = result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2));
  const value = Object.fromEntries(pairs);
  if (!result.ok || pairs.length !== keys.length || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || value.Id !== completionUnit || value.LoadState !== 'loaded'
    || value.Restart !== 'no' || value.KillMode !== 'control-group' || value.RuntimeMaxUSec !== '2h'
    || value.TimeoutStopUSec !== '4min' || value.Slice !== 'system.slice' || !(stopping ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value.MainPID)
    || !/^[1-9][0-9]*$/.test(value.ExecMainPID) || (!stopping && value.MainPID !== value.ExecMainPID)
    || !/^[0-9a-f]{32}$/.test(value.InvocationID)
    || !/^\/system.slice\/aistudy-postmigration-completion\.service$/.test(value.ControlGroup)
    || selfCgroup() !== `0::${value.ControlGroup}`
    || (value.ExecStopPost.match(/path=/g) ?? []).length !== 1
    || !value.ExecStopPost.includes(`argv[]=/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 ${process.execPath} ${filename} completion-stop-post ${dirname(filename)}/hermes-release.sh complete-postmigration `)) throw new Error('Independent completion system service unconfirmed');
  return value;
}

export function cleanupCompletion(args, dependencies = {}) {
  const { service = () => completionService(command, undefined, true), hasClaim = () => present(join(args[4], 'postmigration-completion-claimed')),
    readOrigin = () => JSON.parse(python('hermes-writer-state.py', ['completion-origin', args[4]])),
    readClaim = () => JSON.parse(python('hermes-writer-state.py', ['completion-claim', args[4]])),
    query = classify, fence = () => durableWrite(join(args[4], 'writers-fenced'), 'Completion uncommitted; independent scoped cleanup.\n'),
    stop = stopWriters } = dependencies;
  const observed = service();
  if (!hasClaim()) return; // Admission refused before first write: no crash cleanup.
  // A preexisting malformed claim is refusal, NOT evidence of our first write.
  // The descriptor-checked runtime proof must match manager identity and inode.
  const origin = readOrigin();
  if (origin.invocation !== observed.InvocationID || origin.mainPid !== observed.ExecMainPID
    || origin.state !== args[4] || origin.release !== args[10]) throw new Error('Cleanup creation scope changed');
  let claim;
  try { claim = readClaim(); } catch { /* Proven own inode: partial claim consumed. */ }
  if (claim && (claim.invocation !== origin.invocation || claim.owner !== origin.owner || claim.release !== origin.release)) throw new Error('Cleanup invocation scope changed');
  if (claim && query(args[4], args[3], { owner: claim.owner, transition: claim.incident, target: claim.release }) === 'committed') return;
  // StopPost follows systemd full-cgroup termination: broker grants are dead.
  // Retain unknown residual names; never connect to or unlink an unknown broker.
  let fenced = true;
  try { fence(); } catch { fenced = false; }
  const stopped = stop(); // Independent even if fence persistence failed.
  if (!fenced || !stopped) throw new Error('Completion cleanup UNCONFIRMED');
}

export function completionServiceUnit(args, root = dirname(filename), node = process.execPath) {
  validateArguments(args);
  if (args.length !== 13 || args[0] !== 'complete-postmigration' || !canonicalManagedPath(root) || !canonicalManagedPath(node)
    || args.slice(1).some(value => !/^[A-Za-z0-9_./-]+$/.test(value))) throw new Error('Unsafe completion service arguments');
  const entry = `${node} ${root}/hermes-supervisor.mjs`;
  const owner = `${root}/hermes-release.sh ${args.join(' ')}`;
  return `[Unit]\nDescription=AIstudy one-shot postmigration completion\n[Service]\nType=exec\nUser=root\nWorkingDirectory=/\nUMask=0077\nRuntimeDirectory=aistudy-completion\nRuntimeDirectoryMode=0700\nSlice=system.slice\nRestart=no\nKillMode=control-group\nRuntimeMaxSec=7200\nTimeoutStopSec=240\nStandardInput=null\nStandardOutput=journal\nStandardError=journal\nExecStart=/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 ${entry} run ${owner}\nExecStopPost=/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 ${entry} completion-stop-post ${owner}\n`;
}

export function launchCompletion(script, args, dependencies = {}) {
  const { run = command, root = dirname(filename), node = process.execPath,
    admission = completionLaunchAdmission, beforeStart = () => {},
    write = (path, text) => {
      const fd = openSync(path, 'wx', 0o644);
      try { writeFileForUnit(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(dirname(path));
    } } = dependencies;
  if (script !== join(root, 'hermes-release.sh')) throw new Error('Completion owner must be reviewed sibling');
  const unit = completionServiceUnit(args, root, node);
  const path = `/run/systemd/system/${completionUnit}`;
  // Incident-only archival is descriptor/DAC checked, never a generic overwrite.
  admission(args, unit, 'absent');
  // Archival retains the loaded manager record; unload it only after admission.
  if (!run(['daemon-reload']).ok) throw new Error('Archived unit unload unconfirmed');
  // Never overwrite/restart an existing service or an earlier retained attempt.
  const before = run(['show', '--all', '--property=LoadState', completionUnit]);
  if ((!before.ok && before.status !== 1) || before.stdout.trim() !== 'LoadState=not-found' || present(path)) throw new Error('Completion service already present or unconfirmed');
  admission(args, unit, 'unloaded'); // Historical writer proof again before creating new unit.
  write(path, unit);
  if (!run(['daemon-reload']).ok) throw new Error('Completion unit reload unconfirmed');
  admission(args, unit, 'ready'); // Recheck evidence, guards and claim race before submission.
  // Start once. The service, not SSH, owns its cgroup, timeout and StopPost.
  beforeStart(); // Release intake lock so the service can acquire its own lock.
  const started = run(['start', '--no-block', completionUnit]);
  if (!started.ok) throw new Error('Completion launch unconfirmed; retain entry and inspect manager');
  // Never unlink controls or the runtime unit after submission, including loss
  // of the start ACK. Explicit authorized housekeeping follows manager review.
  return { submitted: true, unit: completionUnit };
}

export function boundedQuiescence(helper, config, release) {
  // GNU timeout owns a process group and kills the whole probe tree, including
  // the nested tsx client. No inherited pipe can hold cleanup open afterwards.
  const result = spawnSync("timeout", ["--signal=KILL", "15s", "node", helper, "quiescence", config, release],
    { stdio: "ignore", timeout: 20_000, killSignal: "SIGKILL" });
  return !result.error && result.status === 0;
}
const command = systemctlCommand;
export function cgroupEmpty(group, root = "/sys/fs/cgroup") {
  // Only unified v2 is understood. Missing paths on v1/unknown layouts are
  // not evidence of an empty group, even if a unit reports inactive.
  if (!existsSync(join(root, "cgroup.controllers"))) return false;
  if (!group) return true;
  if (!/^\/[A-Za-z0-9_.@:/-]+$/.test(group) || group.includes("..")) return false;
  const directory = resolve(root, `.${group}`);
  if (!directory.startsWith(`${resolve(root)}/`)) return false;
  try {
    const walk = directory => {
      if (lstatSync(directory).isSymbolicLink()) return false;
      if (readFileSync(join(directory, "cgroup.procs"), "utf8").trim()) return false;
      const entries = readdirSync(directory, { withFileTypes: true });
      return !entries.some(entry => entry.isSymbolicLink()) && entries.filter(entry => entry.isDirectory())
        .every(entry => walk(join(directory, entry.name)));
    };
    return walk(directory);
  } catch { return false; }
}
/** Each stop and each observation are independent; is-active exit codes prove nothing. */
export function stopWriters(run = command, empty = cgroupEmpty, report = line => console.error(line)) {
  let confirmed = true;
  const attempt = args => { try { return run(args); } catch { return { ok: false, stdout: "" }; } };
  const observedEmpty = group => { try { return empty(group); } catch { return false; } };
  for (const unit of units) {
    const stopped = attempt(["stop", unit]);
    const observed = attempt(["show", "--all", "--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,ControlGroup", unit]);
    const properties = Object.fromEntries(observed.stdout.trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const keys = ["LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "Job", "ControlGroup"];
    const absent = observed.ok && keys.every(key => Object.hasOwn(properties, key))
      && ["loaded", "not-found", "masked"].includes(properties.LoadState)
      && ["inactive", "failed"].includes(properties.ActiveState)
      && ["dead", "failed"].includes(properties.SubState)
      && properties.MainPID === "0" && properties.ControlPID === "0"
      && ["", "0"].includes(properties.Job) && observedEmpty(properties.ControlGroup);
    const ok = absent && (stopped.ok || properties.LoadState === "not-found");
    try {
      report(`${unit}: stop ${ok ? "confirmed" : "UNCONFIRMED"}; MainPID=${/^\d+$/.test(properties.MainPID) ? properties.MainPID : "unknown"} ControlPID=${/^\d+$/.test(properties.ControlPID) ? properties.ControlPID : "unknown"} job=${properties.Job ? "present" : "empty-or-unavailable"} cgroup=${absent ? "empty" : "unconfirmed"}`);
    } catch { /* A broken diagnostic pipe must not skip the other writer. */ }
    confirmed = ok && confirmed;
  }
  return confirmed;
}
async function request(action, environment) {
  const socket = createConnection(environment.HERMES_SUPERVISOR_SOCKET);
  return new Promise((resolve, reject) => {
    let body = "";
    socket.setTimeout(SUPERVISOR_REQUEST_TIMEOUT_MS, () => socket.destroy(new Error("Managed supervisor response timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ action, token: environment.HERMES_SUPERVISOR_TOKEN, transition: environment.HERMES_TRANSITION, release: environment.HERMES_RELEASE, target: environment.HERMES_TARGET, required: environment.HERMES_WORKER_REQUIRED })}\n`));
    socket.on("data", data => { body += data; if (body.includes("\n")) { socket.end(); try { resolve(JSON.parse(body)); } catch (error) { reject(error); } } });
    socket.on("error", reject);
    socket.on("end", () => { if (!body.includes("\n")) reject(new Error("Managed supervisor disconnected before a complete response")); });
  });
}
function canonicalManagedPath(value) {
  return typeof value === 'string' && value === value.trim()
    && /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && resolve(value) === value;
}
function durableQueryScope(environment) {
  const state = environment.HERMES_STATE, transition = environment.HERMES_TRANSITION, target = environment.HERMES_TARGET;
  if (!canonicalManagedPath(state) || !canonicalManagedPath(transition) || !canonicalManagedPath(target)
    || !transition.startsWith(`${state}/releases/`)) return undefined;
  return { transition, target };
}
// Shared CLI logic; object injection is available only to module callers.
export async function requestCommand(action, environment = process.env, dependencies = {}) {
  const classifyState = dependencies.classify ?? classify;
  let reply;
  try { reply = await request(action, environment); }
  catch (error) {
    if (action !== 'query-success' || !environment.HERMES_STATE || !environment.HERMES_CURRENT) throw error;
    const scope = durableQueryScope(environment);
    const state = scope ? classifyState(environment.HERMES_STATE, environment.HERMES_CURRENT, scope) : 'unknown';
    reply = { ok: state === 'committed', state };
  }
  if (action === 'query-success') {
    const state = ['committed', 'fenced', 'unknown'].includes(reply.state) ? reply.state : 'unknown';
    return { output: state, exitCode: state === 'committed' ? 0 : state === 'fenced' ? 3 : 4 };
  }
  return { exitCode: reply.ok ? 0 : 1 };
}
const production = {
  createServer, command, stopWriters, boundedQuiescence, captureConfiguration, persistConfiguration, verifyEntrySources, checkRepair, checkCompletion, claimCompletion, completionService, completionLaunchAdmission,
  startBroker, brokerControl, closeBroker, retireBroker, classify, terminalCommit, spawn,
  health: (state, args, target, required) => {
    const result = spawnSync(process.execPath, [join(state, 'runtime-identity.mjs'), join(args[1], '.env.production'), target, required], { stdio: 'ignore', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error('Candidate process identity/health unconfirmed');
  },
};
// Object injection is restricted to module callers in tests. CLI always uses
// production dependencies; no environment, HTTP or command-line adapter switch.
export async function supervise(script, args, dependencies = {}) {
  const { createServer, command, stopWriters, boundedQuiescence, captureConfiguration, persistConfiguration, verifyEntrySources, checkRepair, checkCompletion, claimCompletion, completionService, completionLaunchAdmission,
    startBroker, brokerControl, closeBroker, retireBroker, classify, terminalCommit, spawn, health } = { ...production, ...dependencies };
  // Failure is an early rejection, NOT an owner crash: never fence/stop writers.
  verifyEntrySources();
  const state = args[4], systemd = args[6], action = args[0];
  const repair = action === 'repair-pre-migration';
  const completion = action === 'complete-postmigration';
  if (completion && !Object.keys(dependencies).length) {
    assertCompletionLock(state);
    if (script !== join(dirname(filename), 'hermes-release.sh')) throw new Error('Completion owner must be the reviewed sibling');
    for (const path of [args[10], args[12]]) if (!canonicalManagedPath(path)) throw new Error('Unsafe completion target/archive');
    if (dirname(args[10]) !== args[2]) throw new Error('Completion target must be an immediate managed release');
    const root = realpathSync(dirname(filename)), payload = realpathSync(args[10]);
    if (root === payload || root.startsWith(`${payload}/`)) throw new Error('Completion controls must not be payload controls');
  }
  // Called only with the managed exclusive lock held. Rejection is read-only,
  // never an owner crash and never a rewrite of the original incident.
  const repairScope = repair ? checkRepair(args) : undefined;
  let repairAdopted = false;
  // All readonly admission is repeated under the existing exclusive deploy.lock.
  // The exclusive claim is this action's FIRST write, before socket/96/config.
  const completionOwner = completion ? randomBytes(16).toString('hex') : undefined;
  if (completion) {
    const service = completionService();
    const observation = checkCompletion(args);
    // Always traverse this boundary, including object-injected manager fixtures.
    // Production uses the real admission; tests must explicitly own their seam.
    completionLaunchAdmission(args, Object.keys(dependencies).length ? undefined : completionServiceUnit(args), 'claim');
    try { claimCompletion(state, { ...observation, owner: completionOwner, invocation: service.InvocationID, mainPid: service.ExecMainPID }); }
    catch (error) {
      if (error.completionClaimConsumed) {
        try { durableWrite(join(state, 'writers-fenced'), 'Completion claim incomplete; no automatic retry.\n'); }
        finally { stopWriters(); }
      }
      throw error;
    }
  }
  const guard = join(state, "migration-forward-only");
  const fence = join(state, "writers-fenced");
  const socketPath = join(state, `owner-${process.pid}.sock`);
  const token = randomBytes(32).toString("hex");
  const ownerIdentity = completionOwner ?? randomBytes(16).toString("hex"); // Non-secret commit scope, never the bearer token.
  let activationTarget, committed, broker, record, ownerFinished = false, brokerClosing = false, migrationArmed = false;
  let phase = completion ? 'postmigration-independent-observation' : 'idle', generation = 0, queue = Promise.resolve(), wrapperConfirmed = false;
  let completionPrepared = false, completionActivationConsumed = false, completionFailed = false;
  const lifetime = new AbortController();
  const installedControls = join(state, 'writer-controls');
  function revoke(close = false) {
    if (!broker) return;
    if (close) {
      brokerClosing = true;
      try { closeBroker(broker); }
      catch (error) { brokerClosing = false; throw error; }
      broker = undefined;
    } else brokerControl({ action: 'revoke' });
  }
  function successState(message) {
    if (!transition || message.transition !== transition || message.target !== activationTarget
      || (message.release || "") !== (release || "")) return "unknown";
    try {
      if (realpathSync(args[3]) !== activationTarget) return "unknown";
      if (armed || present(guard) || present(fence)) return "fenced";
      // Existence alone is insufficient: rename may have succeeded before directory fsync failed.
      if (!committed) return "unknown";
      return classify(state, args[3], { owner: ownerIdentity, transition, target: activationTarget });
    } catch { return "unknown"; }
  }
  let armed = present(guard) || present(fence) || present(join(state, 'activation-incomplete'));
  let settled = false, owner, transition = completion ? join(state, 'releases', '20261110T081511-846613') : undefined,
    ownerStart, ownerPid, ownerPidStart, release = completion ? args[10] : undefined, configuration;
  function signalOwnerGroup(signal) {
    if (!signalVerifiedGroup(owner?.pid, ownerStart, signal)) {
      console.error("Owner identity no longer observable; descendant termination UNCONFIRMED (no unrelated PID signalled); backend outcome unknown.");
    }
  }
  function installWrapper() {
    installWriterBoundary(state, systemd, dirname(filename), command);
    wrapperConfirmed = true;
  }
  function installFence() {
    let failed = false;
    try { durableWrite(fence, "Writers fenced; managed forward repair required.\n"); } catch { failed = true; }
    for (const unit of units) {
      try {
        const directory = join(systemd, `${unit}.d`);
        mkdirSync(directory, { recursive: true, mode: 0o755 });
        syncDirectory(systemd);
        // Keep 96 installed across older recovery paths which may rewrite 95.
        if (!wrapperConfirmed) {
          // Bootstrap/failed installation retains the original boot barrier.
          durableWrite(join(directory, '95-aistudy-migration-fence.conf'), `[Unit]\nConditionPathExists=!${fence}\n`, 0o644);
        }
      } catch { failed = true; } // Still attempt the other persistent condition.
    }
    if (!command(["daemon-reload"]).ok) failed = true;
    if (failed) throw new Error("Fence persistence/reload unconfirmed");
  }
  function arm(at, reason) {
    if (committed) throw new Error('Committed owner refuses refence');
    phase = 'fenced';
    generation++;
    let revoked = true;
    try { revoke(); } catch { broker?.stdin.destroy(); revoked = false; }
    armed = true; // Memory first: failure in ANY persistence step cannot permit recovery.
    let failed = !revoked;
    try {
      if (!present(guard)) durableWrite(guard, `${JSON.stringify({ transition: at ?? null, reason, ownerPid: ownerPid ?? null })}\n`);
      if (at && !completion) durableWrite(join(at, "forward-armed"), "Unknown/partial migration outcome requires forward repair.\n");
    } catch { failed = true; }
    // Still attempt the boot/start fence when guard storage itself fails.
    try { installFence(); } catch { failed = true; }
    if (failed) throw new Error("Guard/fence persistence or reload UNCONFIRMED");
  }
  function crashFence() {
    if (committed || (record && classify(state, args[3], { owner: ownerIdentity, transition, target: activationTarget }) === 'committed')) {
      committed = true; settled = true; armed = false; return;
    }
    let persisted = true;
    try { arm(transition, "owner exited without durable success"); }
    catch { persisted = false; console.error("UNCONFIRMED: crash fence persistence/reload failed; guard remains armed in memory."); }
    const stopped = stopWriters();
    console.error(`FORWARD FIX REQUIRED: writers ${stopped ? "stopped" : "UNCONFIRMED"}; fence ${persisted ? "persisted" : "UNCONFIRMED"}; database backend completion is not inferred from process exit.`);
    if (release) {
      const observed = boundedQuiescence(join(dirname(filename), "hermes-db.mjs"), join(args[1], ".env.production"), release);
      if (!observed) console.error("UNCONFIRMED: independent database activity/backend probe failed; writers remain fenced.");
      else console.error("Independent read-only database quiescence observed (point-in-time only); writers remain fenced.");
    } else console.error("UNCONFIRMED: no trusted migration session target available for backend probe; writers remain fenced.");
  }
  if (armed && ["deploy", "restart", "rollback"].includes(action)) {
    crashFence(); return 3;
  }
  const server = createServer(socket => {
    let body = "", handled = false;
    socket.setTimeout(SUPERVISOR_REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", data => {
      if (handled) return;
      body += data;
      if (body.length > 4096) { socket.destroy(); return; }
      if (!body.includes("\n")) return;
      handled = true;
      queue = queue.then(async () => {
      let message, successStarted = false;
      try {
        message = JSON.parse(body.slice(0, body.indexOf("\n")));
        if (message.token !== token) throw new Error("Owner identity mismatch");
        if (message.action === "query-success") {
          // Strictly read-only: never bind or replace transition/release/target from a query.
          const state = successState(message);
          socket.end(`${JSON.stringify({ ok: state === "committed", state })}\n`);
          return;
        }
        if (ownerFinished || lifetime.signal.aborted) throw new Error('Owner generation ended');
        if (completionFailed && !['ping', 'refence', 'stop'].includes(message.action)) throw new Error('Completion failed; no automatic reentry');
        if (committed && !['ping', 'success', 'settled'].includes(message.action)) throw new Error('Committed generation is immutable');
        if (message.transition) {
          if (transition && message.transition !== transition) throw new Error("Transition identity mismatch");
          if (resolve(message.transition) !== message.transition) throw new Error("Noncanonical transition");
          if (!resolve(message.transition).startsWith(`${resolve(state)}/releases/`)) throw new Error("Invalid transition");
          transition = message.transition;
        }
        if (message.release) {
          if (release && message.release !== release) throw new Error("Release identity mismatch");
          if (resolve(message.release) !== message.release) throw new Error("Noncanonical release");
          if (!resolve(message.release).startsWith(`${resolve(args[2])}/`)) throw new Error("Invalid migration session target");
          release = message.release;
        }
        if (repair && !repairAdopted && !['ping', 'adopt-repair'].includes(message.action)) throw new Error('Repair adoption required');
        if (["activate", "success"].includes(message.action)) {
          const target = realpathSync(args[3]);
          if (!message.target || message.target !== target || (activationTarget && target !== activationTarget)
            || (['deploy', 'repair-pre-migration', 'complete-postmigration'].includes(action) && target !== release)) throw new Error("Activation target mismatch");
          activationTarget = target;
        }
        switch (message.action) {
          case "ping": break;
          case 'adopt-repair':
            if (!repair || repairAdopted || !transition || !release || phase !== 'idle') throw new Error('Invalid repair adoption');
            checkRepair(args); // Recheck immediately before the one-shot durable claim.
            // Memory first: a persistence/ACK failure is consumed, never retryable.
            repairAdopted = true;
            durableWrite(join(state, 'repair-adopted'), JSON.stringify({ ...repairScope, transition, release, owner: ownerIdentity }));
            durableWrite(join(transition, 'repair-adopted'), JSON.stringify(repairScope));
            break;
          case "arm":
            if (completion) throw new Error('Completion never authorizes migration');
            if (phase !== 'idle') throw new Error('Repeated or out-of-phase arm');
            migrationArmed = true;
            // Durable independent boundary BEFORE ACK/runner, never inferred from
            // generic crash reasons. Even a lost arm ACK permanently refuses adoption.
            durableWrite(join(transition, 'migration-armed'), 'Migration execution authorized; outcome must be inspected.\n');
            arm(transition, 'migration runner may execute');
            if (!repair) installWrapper(); // Historical 95 stays intact until post-migration prepare.
            break;
          case 'prepare':
            if (completion) {
              if (completionPrepared || phase !== 'postmigration-independent-observation') throw new Error('Completion preparation consumed');
              completionPrepared = true;
            }
            if (record || !transition || !['idle', 'fenced', ...(completion ? ['postmigration-independent-observation'] : [])].includes(phase)
              || (repair && !migrationArmed)) throw new Error('Out-of-phase boundary preparation');
            if (migrationArmed && !existsSync(join(transition, 'migration-succeeded'))) throw new Error('Migration success unconfirmed');
            arm(transition, 'candidate configuration preparation');
            installWrapper();
            if (!stopWriters()) throw new Error('Writers not quiescent before configuration');
            break;
          case "refence": arm(transition, "activation failed; writer permission revoked"); break;
          case "stop":
            if (phase === 'active' || phase === 'preparing') arm(transition, 'explicit stop revoked activation');
            if (!stopWriters()) throw new Error('Writer stop UNCONFIRMED');
            break;
          case "activate": {
            if (completion) {
              if (!completionPrepared || completionActivationConsumed) throw new Error('Completion activation absent or consumed');
              completionActivationConsumed = true;
            }
            if (!transition || !['0', '1'].includes(message.required) || !['idle', 'fenced'].includes(phase) || record || ownerFinished
              || (repair && !migrationArmed)) throw new Error('Missing or repeated activation scope');
            if (migrationArmed && !existsSync(join(transition, 'migration-succeeded'))) throw new Error('Migration success unconfirmed');
            arm(transition, 'execution authorization pending');
            installWrapper();
            if (!stopWriters()) throw new Error('Writers not quiescent');
            durableWrite(join(state, 'activation-incomplete'), `${transition}\n`);
            configuration = captureConfiguration(args, command);
            persistConfiguration(configuration, args, command);
            phase = 'preparing';
            const preparingGeneration = generation;
            if (!ownerPid || !ownerPidStart || processStarttime(ownerPid) !== ownerPidStart) throw new Error('Owner kernel identity unavailable');
            broker = await startBroker(args[3], ownerPid, ownerPidStart, installedControls, lifetime.signal, child => {
              broker = child;
              child.once('exit', () => {
                if (!brokerClosing && !committed) {
                  lifetime.abort(); generation++;
                  queue = queue.then(() => { if (!committed) { crashFence(); signalOwnerGroup('SIGKILL'); } });
                }
              });
            });
            if (settled || ownerFinished || !owner?.connected || lifetime.signal.aborted || generation !== preparingGeneration || phase !== 'preparing') throw new Error('Owner exited while broker started');
            persistConfiguration(configuration, args, command);
            const config = configIdentity(configuration);
            config.effective = Object.fromEntries(units.map(unit => [unit, brokerControl({ action: 'configuration', unit }).effective]));
            record = { ...binding(ownerIdentity, action, transition, activationTarget, config), required: message.required };
            durableWrite(join(state, 'protocol2-transition.json'), JSON.stringify(record));
            for (const unit of units) {
              const effective = config.effective[unit];
              const plan = { ...record, unit, state, systemd, current: args[3], effective, user: effective.User, group: effective.Group };
              durableWrite(join(state, `writer-${unit}.json`), JSON.stringify(plan));
              if (unit === units[0] || message.required === '1') brokerControl({ action: 'prepare', plan });
            }
            persistConfiguration(configuration, args, command);
            // Markers are persisted by owner before this action; starts are solely here.
            for (const unit of units.filter(unit => unit === units[0] || message.required === '1')) {
              if (!command(['start', unit]).ok) throw new Error('Authorized candidate start failed');
            }
            phase = 'active';
            break;
          }
          case "success": {
            if (!transition || message.transition !== transition || (message.release || "") !== (release || "")) throw new Error("Missing or mismatched success scope");
            if (committed) {
              if (successState(message) !== "committed") throw new Error("Committed identity is no longer provable");
              break; // Idempotent; no repeated configuration write, fsync, or start.
            }
            successStarted = true;
            if (phase !== 'active' || !record || message.required !== record.required) throw new Error('Missing or mismatched execution authorization record');
            phase = 'committing';
            // Health inspector and config proof precede the synchronous commit block.
            for (const unit of units) {
              const plan = JSON.parse(readFileSync(join(state, `writer-${unit}.json`), 'utf8'));
              if (JSON.stringify(brokerControl({ action: 'configuration', unit }).effective) !== JSON.stringify(plan.effective)) throw new Error('Effective execution configuration changed before receipt');
            }
            const executions = brokerControl({ action: 'status' }).executions;
            durableWrite(join(transition, 'writer-executions.json'), JSON.stringify(executions));
            for (const unit of units.filter(unit => unit === units[0] || message.required === '1')) {
              const started = executions[unit];
              const observed = command(['show', '--property=MainPID', unit]);
              if (!started || !observed.ok || observed.stdout.trim() !== `MainPID=${started.pid}`
                || processStarttime(started.pid) !== started.start) throw new Error('Authorized MainPID/starttime changed');
            }
            health(state, args, activationTarget, message.required);
            // Health may perform slow IO. Re-pin MainPID/starttime afterwards;
            // a replacement or restart during inspection is not execution proof.
            for (const unit of units.filter(unit => unit === units[0] || message.required === '1')) {
              const observed = command(['show', '--property=MainPID', unit]);
              const started = executions[unit];
              if (!observed.ok || observed.stdout.trim() !== `MainPID=${started.pid}`
                || processStarttime(started.pid) !== started.start) throw new Error('Authorized process changed during health');
            }
            if (!ownerPidStart || processStarttime(ownerPid) !== ownerPidStart) throw new Error('Owner ended before terminal commit');
            if (configuration) {
              const identity = persistConfiguration(configuration, args, command);
              durableWrite(join(transition, "configuration-identity"), `${JSON.stringify(identity)}\n`);
            }
            if (transition) {
              for (const entry of readdirSync(transition, { withFileTypes: true })) {
                if (entry.isFile()) {
                  const fd = openSync(join(transition, entry.name), "r");
                  try { fsyncSync(fd); } finally { closeSync(fd); }
                }
              }
              syncDirectory(transition);
              syncDirectory(dirname(transition));
              syncDirectory(state);
              syncDirectory(dirname(args[3])); // Persist CURRENT rename, possibly on another disk.
              // No await or event-loop yield from revoke through final fence fsync.
              revoke(true);
              terminalCommit(state, args[3], record);
              committed = true;
              phase = 'committed';
              armed = false;
            }
            settled = true;
            successStarted = false; // Transport failure after commit is not persistence failure.
            break;
          }
          case "settled": if (armed) throw new Error("Forward-only owner cannot restore old writers"); settled = true; break;
          default: throw new Error("Unknown managed request");
        }
        socket.end('{"ok":true}\n');
      } catch (error) {
        if (completion && ['prepare', 'activate', 'success'].includes(message?.action)) completionFailed = true;
        // Success is a commit boundary. A failed fsync or lost persistence proof
        // cannot fall through to the owner's pre-migration restoration branch.
        if (!committed && (!repair || repairAdopted) && message?.token === token && (completion ? ['prepare', 'activate'] : ['arm', 'prepare', 'activate']).includes(message.action)) {
          try { arm(transition, 'activation failed'); } catch { console.error('UNCONFIRMED: activation refence'); }
          stopWriters();
        }
        if (successStarted && (!repair || repairAdopted)) {
          settled = false;
          if (record && classify(state, args[3], { owner: ownerIdentity, transition, target: activationTarget }) === 'committed') {
            committed = true; armed = false; settled = true;
          } else {
            try { arm(transition, "success persistence failed"); }
            catch { console.error("UNCONFIRMED: success failure refence persistence failed"); }
            stopWriters();
          }
        }
        console.error(error.message); socket.end('{"ok":false}\n');
      }
      }).catch(error => { console.error(error.message); socket.destroy(); });
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const signalHandlers = new Map();
  const result = await new Promise(resolve => {
    // A group anchor remains alive after Bash dies, so its observable starttime
    // still authorizes killing ONLY this owned group, including orphan children.
    owner = spawn(process.execPath, [...process.execArgv, filename, "anchor", script, ...args], { stdio: ["inherit", "inherit", "inherit", "ipc"], detached: true,
      env: { ...process.env, HERMES_SUPERVISOR_SOCKET: socketPath, HERMES_SUPERVISOR_TOKEN: token, HERMES_SUPERVISOR_HELPER: filename } });
    try { ownerStart = processStarttime(owner.pid); } catch { /* spawn failure is handled below */ }
    // Direct child identity, no PID-file lookup, no signalling unrelated PIDs.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => signalOwnerGroup(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    owner.on("message", message => {
      if (message.ownerPid && !ownerPid) {
        ownerPid = message.ownerPid;
        try { ownerPidStart = processStarttime(ownerPid); } catch { lifetime.abort(); }
      }
      if (Number.isInteger(message.result)) { ownerFinished = true; generation++; lifetime.abort(); resolve(message.result); }
    });
    const ended = () => { ownerFinished = true; generation++; lifetime.abort(); resolve(1); };
    owner.once('error', ended);
    owner.once('exit', ended);
  });
  await queue;
  if (!settled) {
    // The group was created for this direct child; descendants must not keep
    // provisioning or starting writers after their owner is dead.
    signalOwnerGroup("SIGKILL");
    if (!repair || repairAdopted) crashFence();
  }
  if (broker) {
    try { revoke(true); }
    catch {
      console.error('UNCONFIRMED: broker close; retiring failed child behind retained guards.');
      try { await retireBroker(broker); } catch { console.error('UNCONFIRMED: private broker directory cleanup'); }
    }
  }
  if (settled && owner.connected) {
    try {
      owner.send({ done: true }, error => {
        if (error) console.error('Owner acknowledgement unavailable; durable commit state is unchanged.');
      });
    } catch { console.error('Owner acknowledgement unavailable; durable commit state is unchanged.'); }
  }
  await new Promise(resolve => server.close(resolve));
  if (existsSync(socketPath)) unlinkSync(socketPath);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  return settled ? result : result || 1;
}
async function main() {
  protectCleanupStreams();
  const [mode, script, ...args] = process.argv.slice(2);
  if (mode === 'completion-reload-samples' || mode === 'completion-retained-archive') {
    verifyEntrySources();
    validateArguments(args);
    const lock = spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c', completionLockEntry,
      join(args[4], 'deploy.lock'), process.execPath, filename, `${mode}-owned`, script, ...args], { stdio: 'inherit' });
    process.exitCode = await new Promise(resolve => { lock.once('error', () => resolve(1)); lock.once('exit', code => resolve(code ?? 1)); });
  } else if (mode === 'completion-reload-samples-owned' || mode === 'completion-retained-archive-owned') {
    verifyEntrySources();
    validateArguments(args);
    assertCompletionLock(args[4]);
    const retainedUnit = completionServiceUnit(args, '/tmp/aistudy-entry.Pz65J76D')
      .replace('RuntimeMaxSec=7200\nTimeoutStopSec=240', 'RuntimeMaxSec=1800\nTimeoutStopSec=120');
    console.log(python('hermes-writer-state.py', [mode.replace('-owned', ''), args[4]], { args, retainedUnit }));
  } else if (mode === 'completion-launch') {
    verifyEntrySources();
    validateArguments(args);
    const lock = spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c', completionLockEntry,
      join(args[4], 'deploy.lock'), process.execPath, filename, 'completion-launch-owned', script, ...args], { stdio: 'inherit' });
    process.exitCode = await new Promise(resolve => { lock.once('error', () => resolve(1)); lock.once('exit', code => resolve(code ?? 1)); });
  } else if (mode === 'completion-launch-owned') {
    verifyEntrySources(); // No service/state write before reviewed entry trust.
    assertCompletionLock(args[4]);
    launchCompletion(script, args, { beforeStart: () => closeSync(9) });
    console.log('Completion submitted; inspect independent manager terminal outcome.');
  } else if (mode === 'completion-unit') {
    console.log(completionServiceUnit(args));
  } else if (mode === "request") {
    const result = await requestCommand(script);
    if (result.output !== undefined) console.log(result.output);
    process.exitCode = result.exitCode;
  } else if (mode === 'completion-stop-post') {
    validateArguments(args);
    if (args[0] !== 'complete-postmigration') throw new Error('Cleanup is incident-only');
    // StopPost never races a subsequent deploy owner. Open the existing lock
    // read-only (no creation) and retain it through all scoped cleanup work.
    const lock = spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c',
      completionLockEntry,
      join(args[4], 'deploy.lock'), process.execPath, filename, 'completion-cleanup-owned', script, ...args], { stdio: 'inherit' });
    process.exitCode = await new Promise(resolve => { lock.once('error', () => resolve(1)); lock.once('exit', code => resolve(code ?? 1)); });
  } else if (mode === 'completion-cleanup-owned') {
    validateArguments(args);
    if (args[0] !== 'complete-postmigration') throw new Error('Cleanup is incident-only');
    assertCompletionLock(args[4]);
    const observed = command(['show', '--all', '--property=InvocationID,Result,ExecMainCode,ExecMainStatus', completionUnit]);
    if (!observed.ok) throw new Error('Completion manager terminal record unavailable');
    console.error(observed.stdout.trim()); // Manager outcome, not application success proof.
    cleanupCompletion(args);
  } else if (mode === "run") {
    validateArguments(args);
    verifyEntrySources(); // Before mkdir/chmod/lock, including existing guard recovery.
    const state = args[4];
    if (args[0] === 'repair-pre-migration' || args[0] === 'complete-postmigration') {
      if (args[0] !== 'complete-postmigration') checkRepair(args); // Before any mkdir/chmod/flock creation.
      const lock = lstatSync(join(state, 'deploy.lock'));
      if (!lock.isFile() || lock.uid !== 0 || (lock.mode & 0o077) || lock.nlink !== 1) throw new Error('Existing private managed lock required');
    } else {
      mkdirSync(state, { recursive: true, mode: 0o700 });
      chmodSync(state, 0o700);
      syncDirectory(dirname(state));
    }
    const child = args[0] === 'complete-postmigration'
      ? spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c', completionLockEntry,
        join(state, 'deploy.lock'), process.execPath, filename, 'owned', script, ...args], { stdio: 'inherit' })
      : spawn("flock", ["--nonblock", "--no-fork", join(state, "deploy.lock"), process.execPath, ...process.execArgv, filename, "owned", script, ...args], { stdio: "inherit" });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
    process.exitCode = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1)); });
    if (process.exitCode === 1) console.error("Managed entry failed or another deployment is already running; inspect retained state.");
  } else if (mode === "anchor") {
    const child = spawn("bash", [script, ...args], { stdio: "inherit", env: process.env });
    process.send({ ownerPid: child.pid });
    // Signals forwarded to the group reach Bash; the anchor survives to report.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
    child.once("error", () => process.send({ result: 1 }));
    child.once("exit", (code, signal) => process.send({ result: signal ? 128 + ({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[signal] ?? 1) : code ?? 1 }));
    process.on("message", message => { if (message.done) process.exit(0); });
    process.on("disconnect", () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } });
  } else if (mode === "owned") { validateArguments(args); process.exitCode = await supervise(script, args); }
  else throw new Error("Unknown supervisor mode");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`Managed entry failed: ${error.message}`); process.exitCode = 1; });
