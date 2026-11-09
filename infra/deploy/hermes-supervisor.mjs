#!/usr/bin/env node
// Managed release owner and crash fence. Does not claim protection against host,
// kernel or supervisor death. Persistent conditions also fence the next boot.
import { spawn, spawnSync } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureConfiguration, persistConfiguration } from "./hermes-config-durability.mjs";
import { binding, brokerControl, classify, closeBroker, configIdentity, durableWrite, installWriterBoundary, retireBroker, startBroker, syncDirectory, terminalCommit } from './hermes-writer-control.mjs';
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
  if (![11, 13].includes(args.length) || !["deploy", "restart", "rollback"].includes(args[0])) throw new Error("Invalid managed arguments");
  for (const value of args.slice(1, 8)) {
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.includes('/..') || value.endsWith('/.')) throw new Error("Managed paths must be normalized safe absolute paths");
  }
}
export function boundedQuiescence(helper, config, release) {
  // GNU timeout owns a process group and kills the whole probe tree, including
  // the nested tsx client. No inherited pipe can hold cleanup open afterwards.
  const result = spawnSync("timeout", ["--signal=KILL", "15s", "node", helper, "quiescence", config, release],
    { stdio: "ignore", timeout: 20_000, killSignal: "SIGKILL" });
  return !result.error && result.status === 0;
}
function command(args) {
  const result = spawnSync("systemctl", args, { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "" };
}
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
    socket.setTimeout(90_000, () => socket.destroy(new Error("Managed supervisor response timed out")));
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
  createServer, command, stopWriters, boundedQuiescence, captureConfiguration, persistConfiguration,
  startBroker, brokerControl, closeBroker, retireBroker, classify, terminalCommit, spawn,
  health: (state, args, target, required) => {
    const result = spawnSync(process.execPath, [join(state, 'runtime-identity.mjs'), join(args[1], '.env.production'), target, required], { stdio: 'ignore', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error('Candidate process identity/health unconfirmed');
  },
};
// Object injection is restricted to module callers in tests. CLI always uses
// production dependencies; no environment, HTTP or command-line adapter switch.
export async function supervise(script, args, dependencies = {}) {
  const { createServer, command, stopWriters, boundedQuiescence, captureConfiguration, persistConfiguration,
    startBroker, brokerControl, closeBroker, retireBroker, classify, terminalCommit, spawn, health } = { ...production, ...dependencies };
  const state = args[4], systemd = args[6], action = args[0];
  const guard = join(state, "migration-forward-only");
  const fence = join(state, "writers-fenced");
  const socketPath = join(state, `owner-${process.pid}.sock`);
  const token = randomBytes(32).toString("hex");
  const ownerIdentity = randomBytes(16).toString("hex"); // Non-secret commit scope, never the bearer token.
  let activationTarget, committed, broker, record, ownerFinished = false, brokerClosing = false, migrationArmed = false;
  let phase = 'idle', generation = 0, queue = Promise.resolve(), wrapperConfirmed = false;
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
  let settled = false, owner, transition, ownerStart, ownerPid, ownerPidStart, release, configuration;
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
      if (at) durableWrite(join(at, "forward-armed"), "Unknown/partial migration outcome requires forward repair.\n");
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
    socket.setTimeout(90_000, () => socket.destroy());
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
        if (["activate", "success"].includes(message.action)) {
          const target = realpathSync(args[3]);
          if (!message.target || message.target !== target || (activationTarget && target !== activationTarget)
            || (action === "deploy" && target !== release)) throw new Error("Activation target mismatch");
          activationTarget = target;
        }
        switch (message.action) {
          case "ping": break;
          case "arm":
            if (phase !== 'idle') throw new Error('Repeated or out-of-phase arm');
            migrationArmed = true;
            arm(transition, 'migration runner may execute');
            installWrapper();
            break;
          case 'prepare':
            if (record || !transition || !['idle', 'fenced'].includes(phase)) throw new Error('Out-of-phase boundary preparation');
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
            if (!transition || !['0', '1'].includes(message.required) || !['idle', 'fenced'].includes(phase) || record || ownerFinished) throw new Error('Missing or repeated activation scope');
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
        // Success is a commit boundary. A failed fsync or lost persistence proof
        // cannot fall through to the owner's pre-migration restoration branch.
        if (!committed && message?.token === token && ['arm', 'prepare', 'activate'].includes(message.action)) {
          try { arm(transition, 'activation failed'); } catch { console.error('UNCONFIRMED: activation refence'); }
          stopWriters();
        }
        if (successStarted) {
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
    crashFence();
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
  if (mode === "request") {
    const result = await requestCommand(script);
    if (result.output !== undefined) console.log(result.output);
    process.exitCode = result.exitCode;
  } else if (mode === "run") {
    validateArguments(args);
    const state = args[4];
    mkdirSync(state, { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    syncDirectory(dirname(state));
    const child = spawn("flock", ["--nonblock", "--no-fork", join(state, "deploy.lock"), process.execPath, ...process.execArgv, filename, "owned", script, ...args], { stdio: "inherit" });
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
