import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureConfiguration, persistConfiguration } from "../../infra/deploy/hermes-config-durability.mjs";
import { configIdentity } from '../../infra/deploy/hermes-writer-control.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "hermes-durable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = ["deploy", join(root, "legacy"), join(root, "releases"), join(root, "current"), join(root, "state"), join(root, "backups"), join(root, "systemd"), join(root, "config"), "1", "a".repeat(40), "archive"];
  const target = join(args[2], "candidate");
  fs.mkdirSync(target, { recursive: true }); fs.symlinkSync(target, args[3]);
  const units = ["aistudy-web.service", "aistudy-worker.service"];
  const environment = join(args[1], ".env.production"), runtime = join(args[7], "worker-runtime.env");
  const files = [environment, runtime, join(args[4], "runtime-identity.mjs"), join(target, ".release-sha"), join(target, ".worker-protocol")];
  const effective = units.map((unit, index) => {
    const fragment = join(args[6], unit);
    const drops = [join(args[6], `${unit}.d/95-aistudy-migration-fence.conf`), join(args[6], `${unit}.d/${index ? "90-aistudy-protocol-guard.conf" : "50-aistudy-release.conf"}`)];
    files.push(fragment, ...drops);
    return `FragmentPath=${fragment}\nDropInPaths=${drops.join(" ")}\nEnvironmentFiles=${environment} (ignore_errors=no)${index ? ` ${runtime} (ignore_errors=no)` : ""}\nNeedDaemonReload=no\n`;
  });
  for (const file of files) { fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file, "private-input", { mode: 0o600 }); }
  fs.writeFileSync(join(target, ".release-sha"), `${args[9]}\n`);
  fs.writeFileSync(join(target, ".worker-protocol"), "delivery-leases-study-v2\n");
  const run = command => ({ ok: true, stdout: effective[units.indexOf(command.at(-1))] });
  return { root, args, target, files, effective, run };
}
function resources(t) {
  const f = fixture(t), unit = 'aistudy-worker.service';
  const memory = join(f.args[6], `${unit}.d/memory.conf`);
  const high = join(f.root, 'system.control', `${unit}.d/50-MemoryHigh.conf`);
  fs.mkdirSync(join(high, '..'), { recursive: true });
  fs.writeFileSync(memory, '[Service]\nMemoryMax=1G\n', { mode: 0o600 });
  fs.writeFileSync(high, '[Service]\nMemoryHigh=2147483648\n', { mode: 0o600 });
  fs.writeFileSync(join(f.args[6], unit), '[Service]\nMemoryMax=1024M\nMemoryHigh=896M\n');
  const wrapper = join(f.args[6], `${unit}.d/96-aistudy-writer-exec.conf`);
  fs.writeFileSync(wrapper, '# fixed trusted wrapper\n', { mode: 0o600 });
  const controls = join(f.args[4], 'writer-controls');
  fs.mkdirSync(controls, { recursive: true });
  for (const name of ['hermes-trusted-loader.py', 'hermes-writer-exec.py', 'hermes-peer-broker.py', 'hermes-writer-state.py']) {
    fs.writeFileSync(join(controls, name), '# fixture control\n', { mode: 0o600 });
  }
  f.effective[1] = f.effective[1].replace('DropInPaths=', `DropInPaths=${memory} ${high} ${wrapper} `)
    + 'MemoryMax=1073741824\nMemoryHigh=2147483648\n';
  const options = { trustedUid: process.geteuid(),
    resourceProfile: { systemd: f.args[6], control: join(f.root, 'system.control') },
    resourcePolicy: payload => {
      const result = spawnSync('/usr/bin/python3', ['-B', fileURLToPath(new URL('./hermes_writer_protocol_test.py', import.meta.url)), 'resource-policy-fixture'],
        { input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
      if (result.status !== 0) throw new Error('Shared Python resource policy refused');
      return JSON.parse(result.stdout);
    },
  };
  return { ...f, memory, high, options };
}
test('shared Python parser accepts only resource corpus and preserves actual high above max', t => {
  const corpus = JSON.parse(fs.readFileSync(new URL('./hermes-resource-policy-corpus.json', import.meta.url)));
  for (const row of corpus) {
    const f = resources(t);
    fs.writeFileSync(f.memory, row.text);
    const effective = row.parsed ? { MemoryMax: '1073741824', MemoryHigh: '2147483648', ...row.parsed } : {};
    if (row.parsed) {
      f.effective[1] = f.effective[1].replace('MemoryMax=1073741824', `MemoryMax=${effective.MemoryMax}`)
        .replace('MemoryHigh=2147483648', `MemoryHigh=${effective.MemoryHigh}`);
      const captured = captureConfiguration(f.args, f.run, f.options);
      assert.deepEqual(captured.resourceBinding.units[0].effective, effective, row.name);
      assert.deepEqual(configIdentity(captured).resourceBinding, captured.resourceBinding);
      persistConfiguration(captured, f.args, f.run, f.options);
    } else assert.throws(() => captureConfiguration(f.args, f.run, f.options), undefined, row.name);
  }
});
test('synthetic resource paths require explicit profile and root DAC remains default', t => {
  const f = resources(t);
  assert.throws(() => captureConfiguration(f.args, f.run), /Unknown or stale/);
  assert.throws(() => captureConfiguration(f.args, f.run, { ...f.options, trustedUid: 12345 }), /Untrusted configuration/);
  for (const path of [join(f.root, 'other', 'memory.conf'), join(f.root, 'system.control', 'unknown.conf'),
    '/run/systemd/system.control/aistudy-worker.service.d/50-MemoryHigh.conf']) {
    const run = command => ({ ok: true, stdout: f.run(command).stdout.replace('DropInPaths=', `DropInPaths=${path} `) });
    assert.throws(() => captureConfiguration(f.args, run, f.options), /Unknown or stale/);
  }
});
test('resource byte identity, metadata, effective drift, links and fsync failures refuse', t => {
  for (const defect of ['replace', 'edit', 'mode', 'parent', 'link', 'hardlink', 'missing', 'effective', 'fsync']) {
    const f = resources(t), captured = captureConfiguration(f.args, f.run, f.options);
    if (defect === 'replace') { fs.writeFileSync(`${f.memory}.next`, fs.readFileSync(f.memory), { mode: 0o600 }); fs.renameSync(`${f.memory}.next`, f.memory); }
    if (defect === 'edit') fs.writeFileSync(f.memory, '[Service]\nMemoryMax=2G\n');
    if (defect === 'mode') fs.chmodSync(f.memory, 0o620);
    if (defect === 'parent') fs.chmodSync(join(f.high, '..'), 0o775);
    if (defect === 'link') { fs.unlinkSync(f.memory); fs.symlinkSync(f.high, f.memory); }
    if (defect === 'hardlink') { fs.unlinkSync(f.memory); fs.linkSync(f.high, f.memory); }
    if (defect === 'missing') fs.unlinkSync(f.memory);
    if (defect === 'effective') f.effective[1] = f.effective[1].replace('MemoryHigh=2147483648', 'MemoryHigh=939524096');
    const original = fs.fsyncSync;
    if (defect === 'fsync') { fs.fsyncSync = fd => { if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.high) throw new Error('resource fsync fault'); original(fd); }; syncBuiltinESMExports(); }
    try { assert.throws(() => persistConfiguration(captured, f.args, f.run, f.options), undefined, defect); }
    finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  }
});
test('installed loader and every sibling are required durable identity inputs', t => {
  const f = fixture(t);
  const names = ['hermes-trusted-loader.py', 'hermes-writer-exec.py', 'hermes-peer-broker.py', 'hermes-writer-state.py'];
  const directory = join(f.args[4], 'writer-controls');
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of names) fs.writeFileSync(join(directory, name), 'trusted source', { mode: 0o600 });
  for (let index = 0; index < f.effective.length; index++) {
    const drop = join(f.args[6], `${['aistudy-web.service', 'aistudy-worker.service'][index]}.d/96-aistudy-writer-exec.conf`);
    fs.writeFileSync(drop, 'fixed wrapper', { mode: 0o600 });
    f.effective[index] = f.effective[index].replace('DropInPaths=', `DropInPaths=${drop} `);
  }
  const captured = captureConfiguration(f.args, f.run), synced = [];
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => { synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); original(fd); }; syncBuiltinESMExports();
  try { persistConfiguration(captured, f.args, f.run); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  for (const name of names) {
    const path = join(directory, name);
    assert(captured.files.some(entry => entry.file === path));
    assert(synced.includes(path));
    const bytes = fs.readFileSync(path);
    fs.unlinkSync(path);
    assert.throws(() => captureConfiguration(f.args, f.run));
    fs.writeFileSync(path, bytes, { mode: 0o600 });
  }
  assert(synced.includes(directory)); assert(synced.includes(f.args[4]));
  // Replacing control bytes must invalidate a previous capture/receipt identity;
  // no compatibility fallback removes the guard or accepts the older inventory.
  assert.throws(() => persistConfiguration(captured, f.args, f.run));
});

test("persists every actual input and release marker with ancestors and secret-free identities", t => {
  const f = fixture(t), captured = captureConfiguration(f.args, f.run), synced = [];
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => { synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); original(fd); }; syncBuiltinESMExports();
  let identity;
  try { identity = persistConfiguration(captured, f.args, f.run); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  for (const file of f.files) { assert(synced.includes(file), file); assert(synced.includes(join(file, "..")), file); }
  assert(synced.includes(f.root));
  assert.doesNotMatch(JSON.stringify(identity), /private-input|bytes|sha256/);
});
for (const fault of ["file", "parent"]) test(`each actual configuration ${fault} fsync failure refuses persistence`, t => {
  const f = fixture(t), captured = captureConfiguration(f.args, f.run);
  for (const file of f.files) {
    const path = fault === "file" ? file : join(file, "..");
    const original = fs.fsyncSync;
    fs.fsyncSync = fd => { if (fs.readlinkSync(`/proc/self/fd/${fd}`) === path) throw new Error("fsync fault"); original(fd); }; syncBuiltinESMExports();
    try { assert.throws(() => persistConfiguration(captured, f.args, f.run), /fsync fault/, path); }
    finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  }
});
test("new directory ancestor fsync failure and mutations during the last fsync fail closed", t => {
  for (const fault of ['ancestor', 'in-place-race', 'ancestor-swap']) {
    const f = fixture(t), captured = captureConfiguration(f.args, f.run);
    const original = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = fd => {
      const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (fault === 'ancestor' && path === f.root) throw new Error('ancestor fsync fault');
      original(fd);
      if (!injected && path === f.root) {
        injected = true;
        if (fault === 'in-place-race') fs.writeFileSync(f.files[0], 'raced-input');
        if (fault === 'ancestor-swap') {
          fs.renameSync(f.args[1], `${f.args[1]}.old`); fs.mkdirSync(f.args[1]);
          fs.copyFileSync(join(`${f.args[1]}.old`, '.env.production'), f.files[0]);
        }
      }
    }; syncBuiltinESMExports();
    try { assert.throws(() => persistConfiguration(captured, f.args, f.run)); }
    finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  }
});

test("unknown effective inputs and stale manager configuration cannot be signed off", t => {
  const f = fixture(t);
  for (const transform of [s => s.replace("NeedDaemonReload=no", "NeedDaemonReload=yes"), s => s.replace("DropInPaths=", "DropInPaths=/unknown/admin.conf "), s => s.replace("EnvironmentFiles=", "EnvironmentFiles=/unknown/environment (ignore_errors=no) ")]) {
    assert.throws(() => captureConfiguration(f.args, command => ({ ok: true, stdout: transform(f.run(command).stdout) })), /Unknown or stale/);
  }
});
test("renames, in-place edits, symlink inputs and target switches invalidate captured identity", t => {
  for (const change of ["edit", "replace", "symlink", "target"]) {
    const f = fixture(t), captured = captureConfiguration(f.args, f.run), file = f.files[0];
    if (change === "edit") fs.writeFileSync(file, "changed-secret");
    if (change === "replace") { fs.writeFileSync(`${file}.next`, "private-input", { mode: 0o600 }); fs.renameSync(`${file}.next`, file); }
    if (change === "symlink") { fs.renameSync(file, `${file}.real`); fs.symlinkSync(`${file}.real`, file); }
    if (change === "target") { fs.unlinkSync(f.args[3]); fs.symlinkSync(f.args[1], f.args[3]); }
    assert.throws(() => persistConfiguration(captured, f.args, f.run));
  }
});
test("a symlink ancestor and writable configuration parent are rejected without traversing external input", t => {
  const f = fixture(t), directory = f.args[7];
  fs.renameSync(directory, `${directory}.real`); fs.symlinkSync(`${directory}.real`, directory);
  assert.throws(() => captureConfiguration(f.args, f.run));
  fs.unlinkSync(directory); fs.renameSync(`${directory}.real`, directory); fs.chmodSync(directory, 0o777);
  assert.throws(() => captureConfiguration(f.args, f.run), /Untrusted configuration ancestor/);
});
