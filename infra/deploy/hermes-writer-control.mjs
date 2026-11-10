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
// Completion budget (seconds; reload=R60, ordinary systemctl=S15):
// prepare: 3R + 2S wrapper proof + 4S stop/show = 270.
// activate: prepare270 + capture60 + 3*persist60 + broker-ready10 +
//   4*broker-control30 + 2S starts = 670. Failure refence/revoke/stop <=150.
// success: broker90 + identity shows60 + health30 + persist60 + close30 +
//   terminal30 = 300; failure refence/stop <=150. No blind retry.
// request: both socket ends1200 > max(prepare270, activate670, success300)+150.
// provision leaves: snapshot2*15 + identity2*15 + parser90 + verify15 +
//   configure reload60 + effective show15 + failure restore reload60 = 300.
// Nine leaves each add <=2s owned-tree TERM/KILL/drain (18s maximum).
// Helper execution480 > leaves300+drain18+IO162; top owner drain <=2 more.
// Parser execution90 + owned drain2. Neither Node nor GNU timeout kills owner.
// Unsupported pidfd/subreaper refuses before spawn. Unconfirmed kill remains
// UNKNOWN with owner retained (no clean refusal, no configuration continuation).
// Full signed payload observation is synchronous BEFORE socket creation/claim:
// Python2400 + ledger50 + claim-admission300 + claim30 + entry/service45 = 2825.
// service7200: admission2825 + prepare270 + parser/provision574 + owner reloads120
//   + activate670 + health1001 + success300 = 5760; IO/failure margin1440.
// Service/cgroup hard death is UNKNOWN, not an owned-cancellation receipt;
// StopPost retains guards and scopes cleanup, and never invents a consumed claim.
// Health uses SECONDS deadline1000, remaining-time leaf caps; <=1s clock rounding.
// StopPost240 > cleanup180; no-claim StopPost NEVER performs payload observation.
// Readonly formal precheck: shell timeout2700 > full-check2400+ledger55+report IO.
// Provision runs in owner shell, NOT inside socket requests: socket1200 unchanged.
// Historical checker <=120 (two units, optional typed-hook queries included).
// PM samples: seven full incident scopes270 + 3*(reload60+2*manager15)=2160;
// Python3000 leaves 840 for IO. Scope repeats backup/current/guard, NOT payload.
// Archive python650 > 2*scope270+2*manager15+IO; launch-check300 > scope270+manager15.
// Socket timers cannot preempt synchronous work: bounded subprocesses and the
// independent system service, not timer callbacks, own hard termination.
// SSH ConnectTimeout15 bounds CONNECT only; no command/pipe deadline kills
// these requests. The independent service, not SSH, owns execution lifetime.
// Reload has measured 19s latency; do not apply the ordinary command budget.
export const RELOAD_TIMEOUT_MS = 60_000;
export const SYSTEMCTL_TIMEOUT_MS = 15_000;
export const SUPERVISOR_REQUEST_TIMEOUT_MS = 1_200_000;
export const COMPLETION_CHECK_TIMEOUT_MS = 2_400_000;
export function systemctlCommand(args, execute = spawnSync) {
  const result = execute('systemctl', args, { encoding: 'utf8',
    timeout: args[0] === 'daemon-reload' ? RELOAD_TIMEOUT_MS : SYSTEMCTL_TIMEOUT_MS, killSignal: 'SIGKILL' });
  return { ok: !result.error && result.status === 0, status: result.error ? null : result.status, stdout: result.stdout ?? '' };
}
const ownershipProgram = `import runpy,subprocess,sys,os,signal,time,ctypes,tempfile,pickle
original=subprocess.run

def prepare_owner():
    if ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0) != 0:
        raise OSError('Subreaper unavailable')
    probe=os.pidfd_open(os.getpid())
    try: signal.pidfd_send_signal(probe,0)
    finally: os.close(probe)
    children()

def owned_run(argv,*args,**kwargs):
    # One dedicated subreaper per leaf. Only its direct/adopted children are
    # enumerated, never arbitrary host PIDs or another deployment's session.
    with tempfile.TemporaryFile() as result_file:
        controller=os.fork()
        if controller == 0:
            try:
                prepare_owner()  # Refuse unsupported proc/pidfd before spawning anything.
                result=leaf(argv,*args,**kwargs)
                value=(True,result)
            except BaseException as error:
                value=(False,error)
            try:
                pickle.dump(value,result_file); result_file.flush()
            finally:
                os._exit(0)
        # The controller owns timeout + at most 2s TERM/KILL/drain work.
        # Parent never restores/configures while this owned leaf is still live.
        os.waitpid(controller,0)
        result_file.seek(0)
        success,value=pickle.load(result_file)
        if not success: raise value
        return value

def children():
    with open('/proc/self/task/'+str(os.getpid())+'/children') as source:
        return [int(pid) for pid in source.read().split()]

def drain():
    # Killing a parent adopts its children even after runuser/setsid. pidfds
    # pin the observed direct child; no numeric PID signalling/reuse race.
    had_children=False
    for sig,grace in ((signal.SIGTERM,.25),(signal.SIGKILL,1.5)):
        deadline=time.monotonic()+grace
        while True:
            while True:
                try:
                    pid,_=os.waitpid(-1,os.WNOHANG)
                    if pid == 0: break
                except ChildProcessError: break
            owned=children()
            if not owned: return had_children
            had_children=True
            for pid in owned:
                try:
                    fd=os.pidfd_open(pid)
                    try:
                        if pid in children(): signal.pidfd_send_signal(fd,sig)
                    finally: os.close(fd)
                except ProcessLookupError: pass
            if time.monotonic()>=deadline: break
            time.sleep(.005)
    # An unkillable child must NOT release the helper to restore/continue.
    # Retain this controller and ownership until external service inspection.
    print('UNKNOWN: owned descendants termination unconfirmed; owner retained',file=sys.stderr,flush=True)
    while children():
        try: os.waitpid(-1,0)
        except ChildProcessError: break
    raise RuntimeError('Owned descendants termination was UNKNOWN')

def leaf(argv,*args,**kwargs):
    timeout=kwargs.pop('timeout',None)
    check=kwargs.pop('check',False)
    data=kwargs.pop('input',None)
    capture=kwargs.pop('capture_output',False)
    if data is not None: kwargs['stdin']=subprocess.PIPE
    if capture:
        if kwargs.get('stdout') is not None or kwargs.get('stderr') is not None:
            raise ValueError('capture_output conflicts with pipes')
        kwargs['stdout']=kwargs['stderr']=subprocess.PIPE
    proc=subprocess.Popen(argv,*args,**kwargs)
    try:
        out,err=proc.communicate(data,timeout=timeout)
    except BaseException:
        # Do not communicate/reap just the parent and leave inherited pipes or
        # escaped grandchildren alive. Drain the whole adopted tree first.
        drain()
        proc.communicate(timeout=.25)
        raise
    orphaned=drain()
    if orphaned: raise RuntimeError('Leaf left descendants after return')
    result=subprocess.CompletedProcess(argv,proc.returncode,out,err)
    if check: result.check_returncode()
    return result
`;

// The top-level owner is outside the helper's cancellation scope. Its deadline
// kills/drains the helper AND nested leaf controllers, even across setsid.
// No Node/GNU timeout kills this owner before its cleanup confirmation. If the
// host/service kills it, outcome is UNKNOWN, never a clean cancellation receipt.
export function runCompletionOwned(command, args, seconds, options = {}, execute = spawnSync) {
  const code = ownershipProgram + `
def cancelled(signum,frame):
    raise RuntimeError('Ownership cancellation requested')
prepare_owner()
signal.signal(signal.SIGTERM,cancelled)
signal.signal(signal.SIGINT,cancelled)
signal.signal(signal.SIGHUP,cancelled)
try:
    result=leaf(sys.argv[2:],timeout=float(sys.argv[1]))
except BaseException:
    # leaf already drained on timeout. Recheck after cancellation/failed spawn.
    # Disable interrupting this final cleanup with another cooperative signal.
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,signal.SIG_IGN)
    drain()
    sys.exit(1)
sys.exit(result.returncode)
`;
  return execute('/usr/bin/python3', ['-I', '-S', '-B', '-c', code, String(seconds), command, ...args],
    { stdio: 'inherit', ...options });
}
export function provisionCompletion(helper, args, execute = spawnSync) {
  const code = ownershipProgram + `
def bounded(argv,*args,**kwargs):
    if isinstance(argv,(list,tuple)) and argv and argv[0] in ('systemctl','/usr/bin/systemctl','/bin/systemctl'):
        limit=${SYSTEMCTL_TIMEOUT_MS / 1000}
        if len(argv)>1 and argv[1]=='daemon-reload': limit=${RELOAD_TIMEOUT_MS / 1000}
        prior=kwargs.get('timeout')
        kwargs['timeout']=limit if prior is None else min(prior,limit)
    elif isinstance(argv,(list,tuple)) and argv and argv[0].rsplit('/',1)[-1] in ('systemd-analyze','groupadd','useradd'):
        prior=kwargs.get('timeout')
        kwargs['timeout']=${SYSTEMCTL_TIMEOUT_MS / 1000} if prior is None else min(prior,${SYSTEMCTL_TIMEOUT_MS / 1000})
    return owned_run(argv,*args,**kwargs)
subprocess.run=bounded
try:
    sys.argv=sys.argv[1:]
    runpy.run_path(sys.argv[0],run_name="__main__")
finally:
    subprocess.run=original`;
  const result = runCompletionOwned('/usr/bin/python3', ['-I', '-S', '-B', '-c', code, helper, ...args], 480,
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }, execute);
  if (result.error || result.status !== 0) throw new Error('Completion immutable provision helper failed');
}
export function completionLaunchAdmission(args, unit, phase = 'launch') {
  const retainedUnit = unit.split(controls).join('/tmp/aistudy-entry.Pz65J76D')
    .replace('RuntimeMaxSec=7200\nTimeoutStopSec=240', 'RuntimeMaxSec=1800\nTimeoutStopSec=120');
  return JSON.parse(python('hermes-writer-state.py', ['completion-launch-check', args[4]], { args, unit, phase, retainedUnit }));
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
export function python(file, args, payload, execute = spawnSync) {
  const result = execute('/usr/bin/python3', ['-I', '-S', '-B', join(controls, 'hermes-trusted-loader.py'), file === 'hermes-writer-state.py' ? 'state' : 'broker', ...args], {
    input: payload === undefined ? undefined : JSON.stringify(payload), encoding: 'utf8', timeout: args[0] === 'completion-reload-samples' ? 3_000_000
      : args[0] === 'completion-retained-archive' ? 650_000
      : args[0] === 'completion-launch-check' ? 300_000
      : args[0] === 'completion-check' ? COMPLETION_CHECK_TIMEOUT_MS : 30_000,
    killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
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
export function checkCompletion(args, dependencies = {}) {
  const observe = dependencies.python ?? python, ledger = dependencies.ledger ?? verifyCompletionLedger;
  const [, dir, , current, state, , systemd, workerConfig, , sha, release, digest, archive] = args;
  if (sha !== 'e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf'
    || digest !== '4136bafe71484359263128af46d8ddadfe7e9e0227a0976d3f3858f3b9d2b0a0') throw new Error('Wrong completion payload scope');
  const observation = JSON.parse(observe('hermes-writer-state.py', ['completion-check', state, current, systemd, release, join(dir, '.env.production'), archive, workerConfig]));
  ledger(join(dir, '.env.production'), release);
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
