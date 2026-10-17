#!/usr/bin/env node
import { chmodSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VISIBLE_FLAGS = [
  "OPENING_ADAPTIVE_PLANNING", "OPENING_CHAT_PROSE", "OPENING_ANSWER_STYLE", "OPENING_CHAT_ARTIFACTS",
  "OPENING_TEACHING_LOOP", "OPENING_TEACHING_WORKSPACE", "OPENING_TEACHING_COMPILER_ENABLED",
  "OPENING_TEACHING_VALIDATION_ENABLED", "OPENING_MODEL_DAILY_CAP_CENTS",
];

/** Facts from systemd and /proc; raw command lines and environments never leave this function. */
export function verifyProcessSnapshot(snapshot, release, configured, restoration) {
  if (!/^[1-9][0-9]*$/.test(String(snapshot.pid))) throw new Error("Service has no running MainPID.");
  if (snapshot.unitWorkingDirectory !== release || snapshot.executable !== snapshot.unitExecutable
    || !["node", "nodejs"].includes(basename(snapshot.executable))) throw new Error("Service executable or effective WorkingDirectory differs from the release.");
  const webDirectory = `${release}/apps/web/.next/standalone/apps/web`;
  let legacyWorkerIdentityRestored = false;
  if (snapshot.kind === "web") {
    // Next changes process.title, replacing /proc/cmdline. Its real cwd + executable
    // and systemd's effective ExecStart (same MainPID before/after) prove the launch.
    if (![release, webDirectory].includes(snapshot.cwd)
      || !snapshot.unitArgumentPaths.includes(`${webDirectory}/server.js`)) throw new Error("Web process is running a different release.");
  } else if (snapshot.kind === "worker") {
    const restoring = restoration?.version === 1 && restoration.release === release && restoration.worker
      && restoration.worker.unitUser === snapshot.unitUser && restoration.worker.uid === snapshot.uid;
    if (!Number.isInteger(snapshot.uid) || snapshot.uid < 0 || snapshot.uid !== snapshot.accountUid
      || (!restoring && (snapshot.unitUser !== "aistudy-worker" || snapshot.uid === 0))) {
      throw new Error("Worker must run as the dedicated non-root aistudy-worker account.");
    }
    legacyWorkerIdentityRestored = Boolean(restoring && (snapshot.uid === 0 || snapshot.unitUser !== "aistudy-worker"));
    if (snapshot.cwd !== release || !snapshot.unitArgumentPaths.includes(`${release}/node_modules/tsx/dist/cli.mjs`)
      || !snapshot.unitArgumentPaths.includes(`${release}/apps/worker/src/index.ts`)
      || !snapshot.argumentPaths.includes(`${release}/apps/worker/src/index.ts`)) throw new Error("Worker process is running a different release.");
  } else throw new Error("Unknown service identity.");

  const flags = {};
  for (const key of VISIBLE_FLAGS) {
    const expected = configured[key];
    if (expected !== undefined && !(key.endsWith("_CENTS") ? /^[0-9]+$/ : /^[01]$/).test(expected)) throw new Error(`Invalid allowlisted configuration: ${key}.`);
    if (snapshot.environment[key] !== expected) throw new Error(`Running configuration differs: ${key}.`);
    flags[key] = expected ?? "unset";
  }
  return { kind: snapshot.kind, pid: Number(snapshot.pid), user: snapshot.unitUser || "root", release, flags, legacyWorkerIdentityRestored };
}

function readUnit(kind) {
  const response = spawnSync("systemctl", ["show", "--property=MainPID", "--property=User", "--property=WorkingDirectory", "--property=ExecStart", `aistudy-${kind}.service`], { encoding: "utf8" });
  if (response.error || response.status !== 0) throw new Error("Cannot inspect systemd process identity.");
  return Object.fromEntries(response.stdout.trim().split("\n").map(line => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
}
function accountUid(user) {
  const account = spawnSync("id", ["-u", user || "root"], { encoding: "utf8" });
  if (account.error || account.status !== 0 || !/^[0-9]+$/.test(account.stdout.trim())) throw new Error("Worker account identity is unavailable.");
  return Number(account.stdout.trim());
}
function argumentPaths(args, cwd) {
  return args.map(arg => { try { return realpathSync(resolve(cwd, arg)); } catch { return null; } });
}
function unitLaunch(unit) {
  const cwd = realpathSync(unit.WorkingDirectory);
  const executable = unit.ExecStart?.match(/(?:^|[ {;])path=([^ ;}]+)/)?.[1];
  const args = unit.ExecStart?.match(/argv\[\]=(.*?) ;/)?.[1];
  if (!executable || !args) throw new Error("Cannot inspect effective ExecStart.");
  return { cwd, executable: realpathSync(executable), paths: argumentPaths(args.split(/\s+/), cwd) };
}
function inspect(kind, release, configured, restoration) {
  const unit = readUnit(kind);
  if (!/^[1-9][0-9]*$/.test(unit.MainPID ?? "")) throw new Error("Service has no running MainPID.");
  const proc = `/proc/${unit.MainPID}`;
  const cwd = realpathSync(`${proc}/cwd`);
  const launch = unitLaunch(unit);
  const args = readFileSync(`${proc}/cmdline`, "utf8").split("\0").filter(Boolean);
  const environment = Object.fromEntries(readFileSync(`${proc}/environ`, "utf8").split("\0").filter(Boolean).map(entry => {
    const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)];
  }));
  const snapshot = {
    kind, pid: unit.MainPID, unitUser: unit.User, uid: statSync(proc).uid,
    accountUid: kind === "worker" ? accountUid(unit.User) : undefined, cwd,
    argumentPaths: argumentPaths(args, cwd), unitWorkingDirectory: launch.cwd, unitExecutable: launch.executable,
    unitArgumentPaths: launch.paths, executable: realpathSync(`${proc}/exe`), environment,
  };
  const after = readUnit(kind);
  if (after.MainPID !== unit.MainPID || after.ExecStart !== unit.ExecStart || after.User !== unit.User
    || after.WorkingDirectory !== unit.WorkingDirectory) throw new Error("Service changed while its identity was being read.");
  return verifyProcessSnapshot(snapshot, release, configured, restoration);
}
function captureRestoration(target, required, destination) {
  const release = realpathSync(target);
  let worker = null;
  if (required === "1") {
    const unit = readUnit("worker");
    const uid = accountUid(unit.User);
    const launch = unitLaunch(unit);
    if (launch.cwd !== release || !launch.paths.includes(`${release}/apps/worker/src/index.ts`)) throw new Error("Worker baseline does not point to the current release.");
    if (/^[1-9][0-9]*$/.test(unit.MainPID ?? "")) {
      if (statSync(`/proc/${unit.MainPID}`).uid !== uid || realpathSync(`/proc/${unit.MainPID}/cwd`) !== release) throw new Error("Worker baseline process identity differs from its unit.");
    }
    worker = { unitUser: unit.User, uid };
  }
  writeFileSync(destination, JSON.stringify({ version: 1, release, worker }), { mode: 0o600, flag: "wx" });
  chmodSync(destination, 0o600);
}
function readRestoration(file, release) {
  if (!file) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) throw new Error("Worker restoration identity must be a root-owned private snapshot.");
  const profile = JSON.parse(readFileSync(file, "utf8"));
  if (profile.version !== 1 || profile.release !== release) throw new Error("Worker restoration snapshot belongs to another release.");
  return profile;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "capture") {
      const [, , target, required, destination] = args;
      if (!["0", "1"].includes(required)) throw new Error("Invalid worker requirement.");
      captureRestoration(target, required, destination);
    } else {
      const [config, target, required, profile] = args;
      if (!["0", "1"].includes(required)) throw new Error("Invalid worker requirement.");
      const configured = parseEnv(readFileSync(config, "utf8"));
      const release = realpathSync(target);
      const restoration = readRestoration(profile, release);
      const identities = [inspect("web", release, configured, restoration)];
      if (required === "1") identities.push(inspect("worker", release, configured, restoration));
      for (const identity of identities) console.log(`${identity.kind}: PID=${identity.pid} User=${identity.user} release=${identity.release}`);
      if (identities.some(identity => identity.legacyWorkerIdentityRestored)) console.log("旧身份已恢复，非 root 加固尚未生效；本次仅恢复原应用可用状态。");
      console.log(Object.entries(identities[0].flags).map(([key, value]) => `${key}=${value}`).join("\n"));
    }
  } catch (error) {
    console.error(error instanceof Error && /^(Service |Web process|Worker |Running configuration|Invalid allowlisted|Cannot inspect|Invalid worker)/.test(error.message)
      ? error.message : "Cannot verify running service identity; sensitive process data was withheld.");
    process.exitCode = 1;
  }
}
