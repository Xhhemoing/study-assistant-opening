#!/usr/bin/env node
// Managed release owner and crash fence. Does not claim protection against host,
// kernel or supervisor death. Persistent conditions also fence the next boot.
import { spawn, spawnSync } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const units = ["aistudy-web.service", "aistudy-worker.service"];
const filename = fileURLToPath(import.meta.url);
function validateArguments(args) {
  if (![11, 13].includes(args.length) || !["deploy", "restart", "rollback"].includes(args[0])) throw new Error("Invalid managed arguments");
  for (const value of args.slice(1, 8)) {
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.includes('/..') || value.endsWith('/.')) throw new Error("Managed paths must be normalized safe absolute paths");
  }
}
export function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function durableWrite(file, contents, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.next-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temporary, "wx", mode);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(dirname(file));
}
function durableRemove(file) { unlinkSync(file); syncDirectory(dirname(file)); }
function command(args) {
  const result = spawnSync("systemctl", args, { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "" };
}
export function cgroupEmpty(group, root = "/sys/fs/cgroup") {
  if (!group) return true;
  if (!existsSync(root)) return false;
  if (!/^\/[A-Za-z0-9_.@:/-]+$/.test(group) || group.includes("..")) return false;
  const directory = resolve(root, `.${group}`);
  if (!directory.startsWith(`${resolve(root)}/`)) return false;
  try {
    const walk = directory => {
      if (lstatSync(directory).isSymbolicLink()) return false;
      if (readFileSync(join(directory, "cgroup.procs"), "utf8").trim()) return false;
      return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .every(entry => walk(join(directory, entry.name)));
    };
    return walk(directory);
  } catch (error) { return error.code === "ENOENT" && !existsSync(directory); }
}
/** Each stop and each observation are independent; is-active exit codes prove nothing. */
export function stopWriters(run = command, empty = cgroupEmpty) {
  let confirmed = true;
  for (const unit of units) {
    const stopped = run(["stop", unit]);
    const observed = run(["show", "--all", "--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,ControlGroup", unit]);
    const properties = Object.fromEntries(observed.stdout.trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const keys = ["LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "Job", "ControlGroup"];
    const absent = observed.ok && keys.every(key => Object.hasOwn(properties, key))
      && ["loaded", "not-found", "masked"].includes(properties.LoadState)
      && ["inactive", "failed"].includes(properties.ActiveState)
      && ["dead", "failed"].includes(properties.SubState)
      && properties.MainPID === "0" && properties.ControlPID === "0"
      && ["", "0"].includes(properties.Job) && empty(properties.ControlGroup);
    const ok = absent && (stopped.ok || properties.LoadState === "not-found");
    console.error(`${unit}: stop ${ok ? "confirmed" : "UNCONFIRMED"}; MainPID=${/^\d+$/.test(properties.MainPID) ? properties.MainPID : "unknown"} ControlPID=${/^\d+$/.test(properties.ControlPID) ? properties.ControlPID : "unknown"} job=${properties.Job ? "present" : "empty-or-unavailable"} cgroup=${absent ? "empty" : "unconfirmed"}`);
    confirmed = ok && confirmed;
  }
  return confirmed;
}
async function request(action) {
  const socket = createConnection(process.env.HERMES_SUPERVISOR_SOCKET);
  return new Promise((resolve, reject) => {
    let body = "";
    socket.setTimeout(90_000, () => socket.destroy(new Error("Managed supervisor response timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ action, token: process.env.HERMES_SUPERVISOR_TOKEN, transition: process.env.HERMES_TRANSITION, release: process.env.HERMES_RELEASE })}\n`));
    socket.on("data", data => { body += data; if (body.includes("\n")) { socket.end(); try { resolve(JSON.parse(body)); } catch (error) { reject(error); } } });
    socket.on("error", reject);
    socket.on("end", () => { if (!body) reject(new Error("Managed supervisor disconnected")); });
  });
}
async function supervise(script, args) {
  const state = args[4], systemd = args[6], action = args[0];
  const guard = join(state, "migration-forward-only");
  const fence = join(state, "writers-fenced");
  const socketPath = join(state, `owner-${process.pid}.sock`);
  const token = randomBytes(32).toString("hex");
  let armed = existsSync(guard) || existsSync(fence), settled = false, owner, transition, ownerStart, ownerPid, release;
  function ownerIdentity() {
    // Linux /proc starttime prevents a reused numeric process-group ID from
    // authorizing signals to an unrelated group after the direct child exits.
    const stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^\d+$/.test(started ?? '')) throw new Error("Owner starttime unavailable");
    return started;
  }
  function signalOwnerGroup(signal) {
    try { if (ownerStart && ownerIdentity() === ownerStart) process.kill(-owner.pid, signal); }
    catch { console.error("Owner identity no longer observable; descendant termination UNCONFIRMED (no unrelated PID signalled)."); }
  }
  function installFence() {
    durableWrite(fence, "Writers fenced; managed forward repair required.\n");
    for (const unit of units) {
      const directory = join(systemd, `${unit}.d`);
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      syncDirectory(systemd);
      durableWrite(join(directory, "95-aistudy-migration-fence.conf"), `[Unit]\nConditionPathExists=!${fence}\n`, 0o644);
    }
    if (!command(["daemon-reload"]).ok) throw new Error("Fence daemon reload unconfirmed");
  }
  function arm(at, reason) {
    armed = true; // Memory first: failure in ANY persistence step cannot permit recovery.
    let failed = false;
    try {
      if (!existsSync(guard)) durableWrite(guard, `${JSON.stringify({ transition: at ?? null, reason, ownerPid: ownerPid ?? null })}\n`);
      if (at) durableWrite(join(at, "forward-armed"), "Unknown/partial migration outcome requires forward repair.\n");
    } catch { failed = true; }
    // Still attempt the boot/start fence when guard storage itself fails.
    try { installFence(); } catch { failed = true; }
    if (failed) throw new Error("Guard/fence persistence or reload UNCONFIRMED");
  }
  function crashFence() {
    let persisted = true;
    try { arm(transition, "owner exited without durable success"); }
    catch { persisted = false; console.error("UNCONFIRMED: crash fence persistence/reload failed; guard remains armed in memory."); }
    const stopped = stopWriters();
    console.error(`FORWARD FIX REQUIRED: writers ${stopped ? "stopped" : "UNCONFIRMED"}; fence ${persisted ? "persisted" : "UNCONFIRMED"}; database backend completion is not inferred from process exit.`);
    if (release) {
      const probe = spawnSync("node", [join(dirname(filename), "hermes-db.mjs"), "quiescence", join(args[1], ".env.production"), release],
        { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
      if (probe.error || probe.status !== 0) console.error("UNCONFIRMED: independent database activity/backend probe failed; writers remain fenced.");
      else console.error("Independent read-only database quiescence observed (point-in-time only); writers remain fenced.");
    } else console.error("UNCONFIRMED: no trusted migration session target available for backend probe; writers remain fenced.");
  }
  if (armed && ["deploy", "restart", "rollback"].includes(action)) {
    crashFence(); return 3;
  }
  const server = createServer(socket => {
    let body = "";
    socket.setTimeout(90_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", data => {
      body += data;
      if (body.length > 4096) { socket.destroy(); return; }
      if (!body.includes("\n")) return;
      try {
        const message = JSON.parse(body);
        if (message.token !== token) throw new Error("Owner identity mismatch");
        if (message.transition) {
          if (!resolve(message.transition).startsWith(`${resolve(state)}/releases/`)) throw new Error("Invalid transition");
          transition = message.transition;
        }
        if (message.release) {
          if (!resolve(message.release).startsWith(`${resolve(args[2])}/`)) throw new Error("Invalid migration session target");
          release = message.release;
        }
        switch (message.action) {
          case "ping": break;
          case "arm": arm(transition, "migration runner may execute"); break;
          case "stop": if (!stopWriters()) throw new Error("Writer stop UNCONFIRMED"); break;
          case "activate":
            if (armed && (!transition || !existsSync(join(transition, "migration-succeeded")))) throw new Error("Migration success is unconfirmed");
            if (existsSync(fence)) durableRemove(fence);
            break;
          case "success":
            if (!transition && action !== "restart") throw new Error("Missing success transition");
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
              durableWrite(join(transition, "success-record"), "Activation and health completed.\n");
            }
            // Guard is removed LAST, after all transition metadata and health.
            if (armed) durableRemove(guard);
            settled = true;
            break;
          case "settled": if (armed) throw new Error("Forward-only owner cannot restore old writers"); settled = true; break;
          default: throw new Error("Unknown managed request");
        }
        socket.end('{"ok":true}\n');
      } catch (error) { console.error(error.message); socket.end('{"ok":false}\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const result = await new Promise(resolve => {
    // A group anchor remains alive after Bash dies, so its observable starttime
    // still authorizes killing ONLY this owned group, including orphan children.
    owner = spawn(process.execPath, [...process.execArgv, filename, "anchor", script, ...args], { stdio: ["inherit", "inherit", "inherit", "ipc"], detached: true,
      env: { ...process.env, HERMES_SUPERVISOR_SOCKET: socketPath, HERMES_SUPERVISOR_TOKEN: token, HERMES_SUPERVISOR_HELPER: filename } });
    try { ownerStart = ownerIdentity(); } catch { /* spawn failure is handled below */ }
    // Direct child identity, no PID-file lookup, no signalling unrelated PIDs.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => signalOwnerGroup(signal));
    owner.on("message", message => {
      if (message.ownerPid) ownerPid = message.ownerPid;
      if (Number.isInteger(message.result)) resolve(message.result);
    });
    owner.once("error", () => resolve(1));
    owner.once("exit", () => resolve(1));
  });
  if (!settled) {
    // The group was created for this direct child; descendants must not keep
    // provisioning or starting writers after their owner is dead.
    signalOwnerGroup("SIGKILL");
    crashFence();
  }
  if (settled && owner.connected) owner.send({ done: true });
  await new Promise(resolve => server.close(resolve));
  if (existsSync(socketPath)) unlinkSync(socketPath);
  return settled ? result : result || 1;
}
async function main() {
  const [mode, script, ...args] = process.argv.slice(2);
  if (mode === "request") {
    const reply = await request(script); process.exitCode = reply.ok ? 0 : 1;
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
