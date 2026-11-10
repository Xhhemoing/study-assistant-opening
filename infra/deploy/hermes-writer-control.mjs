// Trusted supervisor bridge. All calls are synchronous across the final commit.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
// Shared by the installer and supervisor; never import the supervisor here.
export function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function durableWrite(file, contents, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.next-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fd = openSync(temporary, 'wx', mode);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(dirname(file));
}
const units = ['aistudy-web.service', 'aistudy-worker.service'];
const controls = dirname(fileURLToPath(import.meta.url));
const sourceNames = ['hermes-trusted-loader.py', 'hermes-writer-exec.py', 'hermes-peer-broker.py', 'hermes-writer-state.py'];
export function verifyEntrySources() {
  // Check the source entry, not the not-yet-installed state/writer-controls.
  // This mode reads the complete Python inventory without executing siblings.
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', join(controls, 'hermes-trusted-loader.py'), 'verify'], {
    encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  if (result.error || result.status !== 0) throw new Error('Trusted entry source preflight refused');
}
export const brokerDirectory = '/run/aistudy-writer-broker';
export const brokerSocket = join(brokerDirectory, 'exec.sock');
export function python(file, args, payload) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', join(controls, 'hermes-trusted-loader.py'), file === 'hermes-writer-state.py' ? 'state' : 'broker', ...args], {
    input: payload === undefined ? undefined : JSON.stringify(payload), encoding: 'utf8', timeout: args[0] === 'completion-check' ? 150_000 : 30_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  if (result.error || result.status !== 0) throw new Error('Trusted writer control unavailable');
  return result.stdout.trim();
}
export function classify(state, current, scope) {
  try {
    return python('hermes-writer-state.py', ['query', state, current, brokerSocket], scope ?? null);
  } catch { return 'unknown'; }
}
export function brokerControl(payload) {
  return JSON.parse(python('hermes-peer-broker.py', ['control', join(brokerDirectory, 'control.sock')], payload));
}
export async function startBroker(current, ownerPid, starttime, installedControls, signal, created = () => {}) {
  mkdirSync(brokerDirectory, { mode: 0o700 }); // Existing/stale owner requires explicit repair; never steal.
  const broker = spawn('/usr/bin/python3', ['-I', '-S', '-B', join(controls, 'hermes-trusted-loader.py'), 'broker', 'serve',
    brokerDirectory, current, join(installedControls, 'hermes-trusted-loader.py'), String(ownerPid), starttime], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  const abort = () => broker.stdin.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  created(broker);
  broker.once('exit', () => signal?.removeEventListener('abort', abort));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { broker.stdin.destroy(); reject(new Error('Broker readiness timed out')); }, 10_000);
    broker.once('error', error => { clearTimeout(timer); reject(error); });
    broker.once('exit', () => { clearTimeout(timer); reject(new Error('Broker exited before readiness')); });
    broker.stdout.once('data', data => {
      clearTimeout(timer);
      if (data.toString() === 'READY\n') resolve();
      else { broker.stdin.destroy(); reject(new Error('Invalid broker readiness')); }
    });
    if (signal?.aborted) abort();
  }).catch(async error => {
    broker.stdin.destroy();
    if (broker.exitCode === null && broker.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => broker.kill('SIGKILL'), 1000);
        broker.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    // Only retire our own mkdir after the child has exited and unlinked. A
    // residual listener/name is an explicit failed cleanup, never stolen.
    try { rmdirSync(brokerDirectory); } catch (cleanup) {
      if (cleanup.code !== 'ENOENT') throw new Error('Broker readiness failed; private directory cleanup unconfirmed');
    }
    throw error;
  });
  broker.stdout.resume();
  return broker;
}
export async function retireBroker(broker) {
  // Failure cleanup only, after fencing/stopping. Never unlink unknown names.
  broker.stdin.destroy();
  if (broker.exitCode === null && broker.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => broker.kill('SIGKILL'), 1000);
      broker.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  try { rmdirSync(brokerDirectory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function closeBroker(broker) {
  // ACK means both listeners are closed and both names unlinked, not merely EOF
  // requested. Verify absence before removing this generation's private directory.
  brokerControl({ action: 'close' });
  for (const name of ['exec.sock', 'control.sock']) {
    try { lstatSync(join(brokerDirectory, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Broker listener remains after close acknowledgement');
  }
  rmdirSync(brokerDirectory);
  broker.stdin.end();
}
export function configIdentity(captured) {
  return { files: captured.files.map(file => {
    const stat = statSync(file.file, { bigint: true });
    const identity = ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(key => String(stat[key]));
    if (captured.resourceBinding && identity.join(':') !== file.identity) throw new Error('Captured resource configuration changed');
    return { path: file.file, identity,
      ...(captured.resourceBinding ? { ancestors: file.ancestors } : {}) };
  }), ...(captured.resourceBinding ? { resourceBinding: captured.resourceBinding } : {}) };
}
export function binding(owner, action, transition, target, config) {
  const stat = statSync(target);
  return { protocol: 2, owner, action, transition, target: realpathSync(target), targetIdentity: [stat.dev, stat.ino], config };
}
export function terminalCommit(state, current, record) {
  python('hermes-writer-state.py', ['commit', state, current, brokerSocket], record);
}
export function controlPaths() {
  return sourceNames.map(name => join(controls, name));
}
export function brokerPresent() { return existsSync(brokerSocket); }
export function checkRepair(args) {
  return JSON.parse(python('hermes-writer-state.py', ['repair-check', args[4], args[3], args[6]]));
}
export function checkCompletion(args) {
  const [, dir, , current, state, , systemd, workerConfig, , sha, release, digest, archive] = args;
  if (sha !== 'e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf'
    || digest !== '4136bafe71484359263128af46d8ddadfe7e9e0227a0976d3f3858f3b9d2b0a0') throw new Error('Wrong completion payload scope');
  const observation = JSON.parse(python('hermes-writer-state.py', ['completion-check', state, current, systemd, release, join(dir, '.env.production'), archive, workerConfig]));
  verifyCompletionLedger(join(dir, '.env.production'), release);
  return observation;
}

export function completionLedgerProgram(release) {
  // Payload is fully verified against retained signed gzip BEFORE this import.
  const module = pathToFileURL(join(release, 'packages/database/src/migrate.ts')).href;
  return `const { readFile, readdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { createMigrationSqlClient, planMigrations, inspectMigrationQuiescence } = await import(${JSON.stringify(module)});
    const directory = ${JSON.stringify(join(release, 'packages/database/src/migrations'))};
    const ids = (await readdir(directory)).filter(id => /^\\d{4}_.+\\.sql$/.test(id)).sort();
    if (ids.length !== 110 || !ids[109].startsWith('0110_')) throw new Error('Wrong completion inventory');
    const expected = await Promise.all(ids.map(async id => ({ id,
      checksum: createHash('sha256').update(await readFile(directory + '/' + id)).digest('hex'), verification_state: 'verified' })));
    const sql = createMigrationSqlClient(process.env.DATABASE_URL);
    try {
      const version = await sql\`SHOW server_version_num\`;
      if (Math.floor(Number(version[0].server_version_num) / 10000) !== 16) throw new Error('PostgreSQL 16 required');
      const plan = await planMigrations(sql);
      if (plan.readOnly !== true || plan.registryReadyWithoutWrites !== true || plan.applied.length || plan.pending.length
        || JSON.stringify(plan.alreadyApplied) !== JSON.stringify(ids)) throw new Error('Completion planner refused');
      await sql.begin('isolation level repeatable read read only', async tx => {
        const rows = await tx\`SELECT id, checksum, verification_state FROM schema_migrations ORDER BY id\`;
        if (rows.length !== expected.length || rows.some((row, i) => row.id !== expected[i].id
          || row.checksum !== expected[i].checksum || row.verification_state !== 'verified')) throw new Error('Completion exact verified checksums refused');
      });
      const quiet = await inspectMigrationQuiescence(sql);
      if (quiet.readOnly !== true || quiet.otherSessions !== 0) throw new Error('Completion not quiet');
      console.log(JSON.stringify({ scope: 'postmigration-independent-observation', plan, ledger: expected, quiet }));
    } finally { await sql.end({ timeout: 5 }); }`;
}
export function verifyCompletionLedger(config, release) {
  const configured = parseEnv(readFileSync(config, 'utf8'));
  if (!configured.DATABASE_URL) throw new Error('Configured completion database required');
  // tsx CLI creates an IPC directory/socket even with cache disabled. Use its
  // in-process ESM loader: readonly probes must not create filesystem entries.
  const result = spawnSync('timeout', ['--signal=KILL', '45s', process.execPath, '--import',
    pathToFileURL(join(release, 'node_modules/tsx/dist/esm/index.mjs')).href, '--input-type=module', '--eval',
    completionLedgerProgram(release)], {
    cwd: release, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TSX_DISABLE_CACHE: '1', DATABASE_URL: configured.DATABASE_URL }, encoding: 'utf8', timeout: 50_000,
  });
  if (result.error || result.status !== 0) throw new Error('Independent completion ledger observation refused');
  return JSON.parse(result.stdout);
}

export function claimCompletion(state, scope) {
  // First named state write remains the exclusive claim. Independent StopPost
  // verifies the durable runtime origin even when creation/write/fsync ACK dies.
  try { python('hermes-writer-state.py', ['completion-create', state], scope); }
  catch (error) {
    try {
      const origin = JSON.parse(python('hermes-writer-state.py', ['completion-origin', state]));
      error.completionClaimConsumed = origin.invocation === scope.invocation && origin.mainPid === scope.mainPid
        && origin.release === scope.release && origin.owner === scope.owner;
    } catch { /* No independently verified creation: never adopt an old claim. */ }
    throw error;
  }
}

export function validateRepairPlan(plan, inventory) {
  const expected = inventory.slice(0, 107), pending = inventory.slice(107);
  if (inventory.length !== 110 || !inventory[106].startsWith('0107_')
    || pending.map(id => id.slice(0, 4)).join(',') !== '0108,0109,0110'
    || plan.readOnly !== true || plan.registryReadyWithoutWrites !== true
    || JSON.stringify(plan.applied) !== '[]'
    || JSON.stringify(plan.alreadyApplied) !== JSON.stringify(expected)
    || JSON.stringify(plan.pending) !== JSON.stringify(pending)) throw new Error('Repair requires exact ledger 107 and pending 108/109/110');
}

// The existing planner verifies contiguous IDs and checksums, but intentionally
// accepts legacy-unverified history. Repair has a narrower, all-verified profile.
// Separate read-only observation, no registry/bootstrap/SQL changes and no grants.
export function verifyRepairLedger(config, release) {
  const configured = parseEnv(readFileSync(config, 'utf8'));
  if (!configured.DATABASE_URL) throw new Error('Configured repair database required');
  const module = pathToFileURL(join(release, 'packages/database/src/migrate.ts')).href;
  const code = `const { createMigrationSqlClient } = await import(${JSON.stringify(module)});
    const sql = createMigrationSqlClient(process.env.DATABASE_URL);
    try { await sql.begin('isolation level repeatable read read only', async tx => {
      const rows = await tx\`SELECT id, verification_state FROM schema_migrations ORDER BY id\`;
      if (rows.length !== 107 || !rows[106].id.startsWith('0107_') || rows.some(row => row.verification_state !== 'verified'))
        throw new Error('Repair ledger is not fully verified through 107');
    }); } finally { await sql.end({ timeout: 5 }); }`;
  const result = spawnSync(join(release, 'node_modules/.bin/tsx'), ['--eval', `(async () => { ${code} })()`], {
    cwd: release, env: { ...process.env, ...configured }, stdio: 'ignore',
  });
  if (result.error || result.status !== 0) throw new Error('Read-only verified ledger 107 observation failed');
}

export function installWriterBoundary(state, systemd, source, run) {
  const installed = join(state, 'writer-controls');
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  for (const name of sourceNames) durableWrite(join(installed, name), readFileSync(join(source, name)), 0o600);
  syncDirectory(installed);
  syncDirectory(state);
  for (const unit of units) {
    const directory = join(systemd, `${unit}.d`), worker = unit === units[1];
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    durableWrite(join(directory, '96-aistudy-writer-exec.conf'), `[Service]\nExecStart=\nExecStart=${worker ? '!' : ''}/usr/bin/python3 -I -S -B ${installed}/hermes-trusted-loader.py exec ${state} ${unit}\n${worker ? 'CapabilityBoundingSet=CAP_SETUID CAP_SETGID\nNoNewPrivileges=yes\n' : ''}`, 0o644);
  }
  syncDirectory(systemd);
  if (!run(['daemon-reload']).ok) throw new Error('Wrapper reload failed');
  // Confirm BOTH sole effective wrappers before neutralizing either old 95.
  for (const unit of units) {
    const shown = run(['show', '--property=ExecStartEx,NeedDaemonReload', unit]);
    const exact = `argv[]=/usr/bin/python3 -I -S -B ${installed}/hermes-trusted-loader.py exec ${state} ${unit} ;`;
    if (!shown.ok || !shown.stdout.includes('NeedDaemonReload=no') || (shown.stdout.match(/path=/g) ?? []).length !== 1
      || !shown.stdout.includes('path=/usr/bin/python3 ;') || !shown.stdout.includes(exact)
      || (unit === units[1] && (!shown.stdout.includes('no-setuid') || shown.stdout.includes('privileged')))) throw new Error('Sole trusted ExecStart unconfirmed');
    const fd = openSync(join(systemd, `${unit}.d`, '96-aistudy-writer-exec.conf'), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(join(systemd, `${unit}.d`));
  }
  for (const unit of units) durableWrite(join(systemd, `${unit}.d/95-aistudy-migration-fence.conf`), '# Admission is enforced by persistent 96 trusted wrapper.\n', 0o644);
  if (!run(['daemon-reload']).ok) throw new Error('Fence neutralization reload failed');
}
