// Mutable deployment configuration, not artifact inventory. Never log file bytes,
// environment values or content digests. Unknown effective inputs fail closed.
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const names = ["aistudy-web.service", "aistudy-worker.service"];
const fingerprint = stat => ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs", "nlink"]
  .map(key => String(stat[key])).join(":");
function safePath(path) {
  if (path !== resolve(path) || !/^\/[A-Za-z0-9_./-]+$/.test(path)) throw new Error("Unsupported configuration path");
  return path;
}
function inspect(file, sync) {
  safePath(file);
  const directories = [];
  let descriptor;
  try {
    // Descriptor-relative traversal never follows a replaced ancestor or symlink.
    descriptor = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directories.push({ path: "/", fd: descriptor });
    let path = "";
    for (const part of dirname(file).split("/").filter(Boolean)) {
      path += `/${part}`;
      descriptor = openSync(`/proc/self/fd/${descriptor}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push({ path, fd: descriptor });
    }
    const ancestors = directories.map(({ path, fd }) => {
      const stat = fstatSync(fd, { bigint: true });
      // A root-owned sticky temporary ancestor is allowed, not a writable config
      // parent. Every entry is still pinned and rechecked through its descriptor.
      const stickyRoot = stat.uid === 0n && (stat.mode & 0o1000n) !== 0n && path !== dirname(file);
      if (![0n, BigInt(process.geteuid())].includes(stat.uid) || ((stat.mode & 0o022n) !== 0n && !stickyRoot)) {
        throw new Error("Untrusted configuration ancestor");
      }
      return { path, identity: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}` };
    });
    const fd = openSync(`/proc/self/fd/${descriptor}/${file.split("/").at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.uid !== BigInt(process.geteuid()) || (before.mode & 0o022n) !== 0n || before.nlink !== 1n) {
        throw new Error("Untrusted configuration file");
      }
      const bytes = readFileSync(fd);
      if (sync) {
        fsyncSync(fd);
        // Includes newly created directory entries and ancestors, across disks.
        for (const directory of [...directories].reverse()) fsyncSync(directory.fd);
      }
      if (fingerprint(before) !== fingerprint(fstatSync(fd, { bigint: true }))
        || fingerprint(before) !== fingerprint(lstatSync(file, { bigint: true }))
        || !bytes.equals(readFileSync(`/proc/self/fd/${fd}`))) throw new Error("Configuration changed during persistence");
      for (const ancestor of ancestors) {
        const stat = lstatSync(ancestor.path, { bigint: true });
        if (stat.isSymbolicLink() || ancestor.identity !== `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}`) {
          throw new Error("Configuration ancestor changed");
        }
      }
      return { file, identity: fingerprint(before), ancestors, bytes };
    } finally { closeSync(fd); }
  } finally { for (const directory of directories.reverse()) closeSync(directory.fd); }
}
function effective(args, run) {
  const systemd = args[6], config = join(args[1], ".env.production"), runtime = join(args[7], "worker-runtime.env");
  const snapshot = [];
  const files = new Set([config, join(args[4], "runtime-identity.mjs")]);
  for (const [index, unit] of names.entries()) {
    const result = run(["show", "--property=FragmentPath,DropInPaths,EnvironmentFiles,NeedDaemonReload", unit]);
    if (!result.ok) throw new Error("Effective configuration unavailable");
    const values = Object.fromEntries(result.stdout.trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const fragment = join(systemd, unit);
    const allowedDrops = [join(systemd, `${unit}.d/96-aistudy-writer-exec.conf`), join(systemd, `${unit}.d/95-aistudy-migration-fence.conf`),
      join(systemd, `${unit}.d/${index === 0 ? "50-aistudy-release.conf" : "90-aistudy-protocol-guard.conf"}`)];
    const drops = values.DropInPaths ? values.DropInPaths.split(" ") : [];
    const expectedEnv = `${config} (ignore_errors=no)${index === 1 ? ` ${runtime} (ignore_errors=no)` : ""}`;
    if (values.NeedDaemonReload !== "no" || values.FragmentPath !== fragment
      || drops.some(path => !allowedDrops.includes(path)) || new Set(drops).size !== drops.length
      || !drops.includes(allowedDrops[2]) || values.EnvironmentFiles !== expectedEnv) {
      throw new Error("Unknown or stale effective configuration; success refused");
    }
    snapshot.push({ unit, ...values });
    for (const path of [fragment, ...drops, config, ...(index === 1 ? [runtime] : [])]) files.add(safePath(path));
  }
  for (const name of ['hermes-writer-exec.py', 'hermes-peer-broker.py', 'hermes-writer-state.py']) {
    const path = join(args[4], 'writer-controls', name);
    if (snapshot.some(row => row.DropInPaths.includes('96-aistudy-writer-exec.conf'))) files.add(path);
  }
  return { snapshot, files: [...files].sort() };
}
export function captureConfiguration(args, run) {
  const target = realpathSync(args[3]);
  const observed = effective(args, run);
  // Legacy bootstrap has no reviewed release markers and is not signed off here.
  const markers = [".release-sha", ".worker-protocol"].map(name => join(target, name));
  const files = [...observed.files, ...markers].map(file => inspect(file, false));
  const sha = files.find(file => file.file === markers[0]).bytes.toString("utf8");
  const protocol = files.find(file => file.file === markers[1]).bytes.toString("utf8");
  if (!/^[a-f0-9]{40}\n$/.test(sha) || !/^delivery-leases(?:-study-v[12]|-v1)\n$/.test(protocol)
    || (args[0] === "deploy" && sha.trim() !== args[9])) throw new Error("Release marker identity mismatch");
  return { target, observed, files };
}
export function persistConfiguration(captured, args, run) {
  if (realpathSync(args[3]) !== captured.target
    || JSON.stringify(effective(args, run)) !== JSON.stringify(captured.observed)) throw new Error("Effective configuration changed");
  const identities = captured.files.map(expected => {
    const actual = inspect(expected.file, true);
    if (actual.identity !== expected.identity || JSON.stringify(actual.ancestors) !== JSON.stringify(expected.ancestors)
      || !actual.bytes.equals(expected.bytes)) throw new Error("Configuration identity changed since activation");
    return { file: actual.file, identity: actual.identity, ancestors: actual.ancestors };
  });
  // Recheck the complete set after the last fsync, not only each isolated file.
  for (const expected of captured.files) {
    const actual = inspect(expected.file, false);
    if (actual.identity !== expected.identity || !actual.bytes.equals(expected.bytes)
      || JSON.stringify(actual.ancestors) !== JSON.stringify(expected.ancestors)) throw new Error("Configuration changed after persistence");
  }
  if (realpathSync(args[3]) !== captured.target
    || JSON.stringify(effective(args, run)) !== JSON.stringify(captured.observed)) throw new Error("Effective configuration changed after persistence");
  return { version: 1, target: captured.target, effective: captured.observed.snapshot, files: identities };
}
