// Test-only component adapter. Production has no environment/CLI adapter switch.
// DB and manager observations here are synthetic; receipt filesystem IO is real.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [supervisor, mode, script, ...args] = process.argv.slice(2);
if (mode !== 'run') throw new Error('Fixture requires managed run');
const { supervise, processStarttime, stopWriters } = await import(pathToFileURL(supervisor));
const state = args[4], brokerPath = join(state, 'synthetic-broker');
const units = ['aistudy-web.service', 'aistudy-worker.service'];
const grants = new Set(), executions = {}, effective = {};
const command = argv => {
  const result = spawnSync('systemctl', argv, { encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
};
// Python object injection only in this fixture. Keep the root-private state,
// receipt, actual config identities and real fsync/rename/unlink implementation.
const driver = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('state',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=json.load(sys.stdin);m.TRUSTED_UID=os.geteuid();original=m.validate_config
m.validate_config=lambda config,sync=False: original({'files':config['files']},sync)
if p.get('fault'):
 original_fsync=m.os.fsync
 def fault(fd):
  if '.receipt-' in os.readlink('/proc/self/fd/'+str(fd)):raise OSError('injected fsync failure')
  original_fsync(fd)
 m.os.fsync=fault
if p['mode']=='commit':m.commit(p['state'],p['current'],p['broker'],p['record'])
else:print(m.classify(p['state'],p['current'],p['broker'],p.get('scope'),sync=True))
`;
const python = (mode, record, scope) => {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', driver, join(dirname(supervisor), 'hermes-writer-state.py')], {
    input: JSON.stringify({ mode, state, current: args[3], broker: brokerPath, record, scope, fault: mode === 'commit' && process.env.MOCK_RECEIPT_FAULT === '1' }), encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const { EventEmitter } = await import('node:events');
const { PassThrough } = await import('node:stream');
const dependencies = {
  command,
  stopWriters: () => stopWriters(command),
  // Fake migration fixture owns DB calls; no real database is touched.
  boundedQuiescence: (helper, config, release) => spawnSync('node', [helper, 'quiescence', config, release], { stdio: 'ignore' }).status === 0,
  startBroker: async (_current, _pid, _start, _controls, _signal, created) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); created(child);
    writeFileSync(brokerPath, 'synthetic manager'); return child;
  },
  brokerControl: message => {
    if (message.action === 'configuration') return { effective: effective[message.unit] ??= { User: message.unit === units[1] ? 'aistudy-worker' : '', Group: message.unit === units[1] ? 'aistudy-worker' : '', NeedDaemonReload: 'no' } };
    if (message.action === 'prepare') {
      if (grants.has(message.plan.unit) || executions[message.plan.unit]) throw new Error('Generation already consumed');
      grants.add(message.plan.unit);
    }
    if (message.action === 'revoke') grants.clear();
    return { executions };
  },
  closeBroker: () => { grants.clear(); rmSync(brokerPath); },
  terminalCommit: (_state, _current, record) => python('commit', record),
  classify: (_state, _current, scope) => { try { return python('query', undefined, scope); } catch { return 'unknown'; } },
  health: (state, args, target, required) => {
    const result = spawnSync('node', [join(state, 'runtime-identity.mjs'), join(args[1], '.env.production'), target, required]);
    if (result.status !== 0) throw new Error('Fixture postexec health failed');
  },
  spawn: (exe, argv, options) => {
    // Real group anchor and real Bash owner; same production IPC lifecycle.
    return spawn(exe, argv, options);
  },
};
const managedCommand = dependencies.command;
dependencies.command = argv => {
  if (argv[0] === 'start') {
    if (!grants.delete(argv[1])) return { ok: false, stdout: '' };
    executions[argv[1]] = { pid: process.pid, start: processStarttime(process.pid) };
  }
  if (argv[0] === 'show' && argv[1] === '--property=MainPID') return { ok: true, stdout: `MainPID=${process.pid}` };
  return managedCommand(argv);
};
// The fixture node wrapper holds the same flock boundary as production run.
// This module cannot be reached by a transported production entry.
try { process.exitCode = await supervise(script, args, dependencies); }
finally { if (existsSync(brokerPath)) rmSync(brokerPath); }
