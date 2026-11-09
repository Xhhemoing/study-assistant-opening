// Trusted supervisor bridge. All calls are synchronous across the final commit.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { durableWrite, syncDirectory } from './hermes-supervisor.mjs';
const units = ['aistudy-web.service', 'aistudy-worker.service'];
const controls = dirname(fileURLToPath(import.meta.url));
export const brokerDirectory = '/run/aistudy-writer-broker';
export const brokerSocket = join(brokerDirectory, 'exec.sock');
export function python(file, args, payload) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', join(controls, file), ...args], {
    input: payload === undefined ? undefined : JSON.stringify(payload), encoding: 'utf8', timeout: 30_000,
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
export async function startBroker(current, ownerPid, starttime, installedControls) {
  mkdirSync(brokerDirectory, { mode: 0o700 }); // Existing/stale owner requires explicit repair; never steal.
  const broker = spawn('/usr/bin/python3', ['-I', '-S', join(controls, 'hermes-peer-broker.py'), 'serve',
    brokerDirectory, current, join(installedControls, 'hermes-writer-exec.py'), String(ownerPid), starttime], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { broker.stdin.destroy(); reject(new Error('Broker readiness timed out')); }, 10_000);
    broker.once('error', error => { clearTimeout(timer); reject(error); });
    broker.once('exit', () => { clearTimeout(timer); reject(new Error('Broker exited before readiness')); });
    broker.stdout.once('data', data => { clearTimeout(timer); data.toString() === 'READY\n' ? resolve() : reject(new Error('Invalid broker readiness')); });
  });
  broker.stdout.resume();
  return broker;
}
export function configIdentity(captured) {
  return { files: captured.files.map(file => {
    const stat = statSync(file.file, { bigint: true });
    return { path: file.file, identity: ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(key => String(stat[key])) };
  }) };
}
export function binding(owner, action, transition, target, config) {
  const stat = statSync(target);
  return { protocol: 2, owner, action, transition, target: realpathSync(target), targetIdentity: [stat.dev, stat.ino], config };
}
export function terminalCommit(state, current, record) {
  python('hermes-writer-state.py', ['commit', state, current, brokerSocket], record);
}
export function controlPaths() {
  return ['hermes-writer-exec.py', 'hermes-peer-broker.py', 'hermes-writer-state.py'].map(name => join(controls, name));
}
export function brokerPresent() { return existsSync(brokerSocket); }

export function installWriterBoundary(state, systemd, source, run) {
  const installed = join(state, 'writer-controls');
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  for (const name of ['hermes-writer-exec.py', 'hermes-peer-broker.py', 'hermes-writer-state.py']) durableWrite(join(installed, name), readFileSync(join(source, name)), 0o600);
  for (const unit of units) {
    const directory = join(systemd, `${unit}.d`), worker = unit === units[1];
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    durableWrite(join(directory, '96-aistudy-writer-exec.conf'), `[Service]\nExecStart=\nExecStart=${worker ? '!' : ''}/usr/bin/python3 -I -S ${installed}/hermes-writer-exec.py ${state} ${unit}\n${worker ? 'CapabilityBoundingSet=CAP_SETUID CAP_SETGID\nNoNewPrivileges=yes\n' : ''}`, 0o644);
  }
  syncDirectory(systemd);
  if (!run(['daemon-reload']).ok) throw new Error('Wrapper reload failed');
  // Confirm BOTH sole effective wrappers before neutralizing either old 95.
  for (const unit of units) {
    const shown = run(['show', '--property=ExecStartEx,NeedDaemonReload', unit]);
    const exact = `argv[]=/usr/bin/python3 -I -S ${installed}/hermes-writer-exec.py ${state} ${unit} ;`;
    if (!shown.ok || !shown.stdout.includes('NeedDaemonReload=no') || (shown.stdout.match(/path=/g) ?? []).length !== 1
      || !shown.stdout.includes('path=/usr/bin/python3 ;') || !shown.stdout.includes(exact)
      || (unit === units[1] && (!shown.stdout.includes('no-setuid') || shown.stdout.includes('privileged')))) throw new Error('Sole trusted ExecStart unconfirmed');
  }
  for (const unit of units) durableWrite(join(systemd, `${unit}.d/95-aistudy-migration-fence.conf`), '# Admission is enforced by persistent 96 trusted wrapper.\n', 0o644);
  if (!run(['daemon-reload']).ok) throw new Error('Fence neutralization reload failed');
}
