// Test-only manager/broker and trusted-UID object injection. Real sockets and
// Python receipt filesystem IO; NOT production root DAC or a real manager.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createConnection, createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifySources } from './hermes-entry-fixture.mjs';
import { processStarttime, supervise } from '../../infra/deploy/hermes-supervisor.mjs';

export const units = ['aistudy-web.service', 'aistudy-worker.service'];
const stateModule = resolve('infra/deploy/hermes-writer-state.py');
const receiptDriver = `import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('bootstrap',Path(sys.argv[1]).with_name('hermes-trusted-loader.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
b.TRUSTED_UID=os.geteuid();m=b.SourceLoader(Path(sys.argv[1]).parent).load('hermes-writer-state.py')
p=json.load(sys.stdin);m.TRUSTED_UID=os.geteuid();original=m.validate_config
def validate(config,sync=False):
 original({'files':config['files']},sync)
 if 'effective' in config and config['effective'] != p['effective']: raise ValueError('Manager changed')
m.validate_config=validate
if p.get('fault'):
 name=p['fault'];original_call=getattr(m.os,name);hit=[False]
 def fail(*args,**kw):
  path=str(args[0]) if args else ''
  receipt=name=='replace' or name=='fsync' and '.receipt-' in os.readlink('/proc/self/fd/'+str(args[0]))
  guard=name=='unlink' and path.endswith(p.get('guard','migration-forward-only'))
  if not hit[0] and (receipt or guard): hit[0]=True;raise OSError('synthetic receipt boundary '+name)
  return original_call(*args,**kw)
 setattr(m.os,name,fail)
if p['mode']=='commit': m.commit(p['state'],p['current'],p['broker'],p['record'])
elif p['mode']=='validate': m.validate_config(p['record'],sync=True)
else: print(m.classify(p['state'],p['current'],p['broker'],p.get('scope'),sync=True))
`;
export function fixture(t, { required = '1', fault, guard, brokerFailure = false, pauseBroker = false, lostReply, repair = false, completion = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-supervisor-'));
  const sockets = new Set();
  const trackSocket = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const args = ['deploy', join(root, 'legacy'), join(root, 'releases'), join(root, 'current'), join(root, 'state'), join(root, 'backups'), join(root, 'systemd'), join(root, 'config'), '1', 'a'.repeat(40), 'archive'];
  for (const dir of [args[1], args[2], args[4], args[6], args[7]]) mkdirSync(dir, { mode: 0o700 });
  const target = join(args[2], 'candidate'), transition = join(args[4], 'releases', completion ? '20261110T081511-846613' : 'transition');
  mkdirSync(target); mkdirSync(transition, { recursive: true, mode: 0o700 }); symlinkSync(target, args[3]);
  const configFile = join(args[1], '.env.production'); writeFileSync(configFile, 'fixture=true\n', { mode: 0o600 });
  const brokerPath = join(root, 'exec.sock'), events = [], effective = {}, grants = new Map(), used = {};
  let owner, ownerEnv, resumeBroker, readyOwner, readyBroker;
  const brokerReady = new Promise(resolve => { readyBroker = resolve; });
  const ownerReady = new Promise(resolve => { readyOwner = resolve; });
  const broker = new EventEmitter(); broker.stdin = new PassThrough();
  const command = argv => {
    const unit = argv.at(-1);
    if (argv[0] === 'show' && argv[1].includes('ExecStartEx')) return { ok: true, stdout: `NeedDaemonReload=no\nExecStartEx={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -S -B ${args[4]}/writer-controls/hermes-trusted-loader.py exec ${args[4]} ${unit} ; flags=${unit === units[1] ? 'no-setuid' : ''} ; }\n` };
    if (argv[0] === 'show') return { ok: true, stdout: `MainPID=${process.pid}` };
    if (argv[0] === 'start') {
      events.push(`start:${unit}`);
      if (!grants.has(unit)) return { ok: false };
      grants.delete(unit); used[unit] = { pid: process.pid, start: processStarttime(process.pid) };
    }
    return { ok: true, stdout: '' };
  };
  const python = (mode, record, scope) => {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', receiptDriver, stateModule], {
      input: JSON.stringify({ mode, state: args[4], current: args[3], broker: brokerPath, record, scope, effective, fault: mode === 'commit' ? fault : undefined, guard }), encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr.trim());
    return result.stdout.trim();
  };
  const dependencies = {
    verifyEntrySources: () => verifySources(resolve('infra/deploy')),
    // Real server and sockets. Intercept end only at the actual reply boundary,
    // after synchronous terminalCommit, before any success response byte is sent.
    createServer: listener => createServer(socket => {
      trackSocket(socket);
      if (lostReply) {
        const end = socket.end.bind(socket);
        socket.end = body => {
          if (body === '{"ok":true}\n' && events.at(-1) === 'terminal') {
            assert.equal(python('query'), 'committed');
            events.push(`transport:${lostReply}`);
            end(lostReply === 'partial' ? '{"ok":true}' : undefined);
            return socket;
          }
          return end(body);
        };
      }
      listener(socket);
    }),
    command,
    stopWriters: () => { events.push('stop:both'); return true; },
    boundedQuiescence: () => false,
    captureConfiguration: () => ({ target, files: [{ file: configFile }] }),
    persistConfiguration: captured => { if (captured.target !== readFileSync(join(transition, 'expected-target'), 'utf8') || effective.changed) throw new Error('Configuration changed'); return {}; },
    startBroker: async (_current, _pid, _start, _controls, signal, created) => {
      events.push('broker:opening'); created(broker); writeFileSync(brokerPath, 'online'); readyBroker();
      if (pauseBroker) await new Promise(resolve => { resumeBroker = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      if (brokerFailure) throw new Error('Broker readiness failed');
      if (signal.aborted) throw new Error('Owner EOF during broker readiness');
      return broker;
    },
    brokerControl: message => {
      events.push(`broker:${message.action}`);
      if (message.action === 'configuration') return { effective: effective[message.unit] ??= { User: message.unit === units[1] ? 'aistudy-worker' : '', Group: message.unit === units[1] ? 'aistudy-worker' : '', NeedDaemonReload: 'no' } };
      if (message.action === 'prepare') {
        assert(!grants.has(message.plan.unit) && !used[message.plan.unit]); grants.set(message.plan.unit, message.plan);
      }
      if (message.action === 'revoke') grants.clear();
      return { executions: used };
    },
    closeBroker: () => { events.push('broker:closed-unlinked'); grants.clear(); rmSync(brokerPath); broker.emit('exit', 0); },
    health: () => { events.push('health:postexec'); assert(used[units[0]]); if (required === '1') assert(used[units[1]]); },
    terminalCommit: (state, current, record) => { events.push('receipt'); python('commit', record); events.push('terminal'); },
    classify: (_state, _current, scope) => { events.push('classify'); try { return python('query', undefined, scope); } catch { return 'unknown'; } },
    spawn: (_exe, _argv, options) => {
      owner = new EventEmitter(); owner.connected = true; owner.send = () => {};
      ownerEnv = options.env;
      queueMicrotask(() => { owner.emit('message', { ownerPid: process.pid }); readyOwner(); });
      return owner;
    },
  };
  if (repair) {
    args[0] = 'repair-pre-migration';
    writeFileSync(join(args[4], 'migration-forward-only'), 'original incident');
    writeFileSync(join(args[4], 'writers-fenced'), 'original fence');
    dependencies.checkRepair = () => {
      events.push('repair:check');
      if (existsSync(join(args[4], 'repair-adopted'))) throw new Error('One-shot adoption consumed');
      return { eligible: true, incident: 'synthetic-pre-migration', automaticRetry: false };
    };
  }
  if (completion) {
    args[0] = 'complete-postmigration'; args[10] = target;
    writeFileSync(join(args[4], 'migration-forward-only'), 'original incident');
    writeFileSync(join(args[4], 'writers-fenced'), 'original fence');
    dependencies.completionService = () => ({ InvocationID: 'a'.repeat(32), ExecMainPID: '1234' });
    // Supervisor protocol tests use a synthetic manager; inode-origin creation
    // and faults run separately against the real Python implementation.
    dependencies.claimCompletion = (state, scope) => writeFileSync(join(state, 'postmigration-completion-claimed'), JSON.stringify(scope), { flag: 'wx', mode: 0o600 });
    dependencies.checkCompletion = () => { events.push('completion:readonly'); return { incident: transition, release: target }; };
  }
  writeFileSync(join(transition, 'expected-target'), target);
  function request(action, extra = {}) {
    return new Promise((resolve, reject) => {
      const socket = trackSocket(createConnection(ownerEnv.HERMES_SUPERVISOR_SOCKET));
      let body = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({ action, token: ownerEnv.HERMES_SUPERVISOR_TOKEN, transition, release: target, target, required, ...extra }) + '\n'));
      socket.on('data', data => { body += data; if (body.includes('\n')) { socket.end(); resolve(JSON.parse(body)); } });
      socket.on('end', () => { if (!body.includes('\n')) reject(new Error('Incomplete fixture response')); });
    });
  }
  const running = supervise('test-owner', args, dependencies);
  let finished = false;
  running.then(() => { finished = true; }, () => { finished = true; });
  t.after(async () => {
    try {
      await Promise.race([ownerReady, running]);
      if (!finished) owner.emit('message', { result: 1 });
      for (const socket of sockets) socket.destroy();
      await running;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { args, target, transition, configFile, events, effective, grants, used, broker, request, ownerReady, brokerReady, running,
    environment: () => ({ ...ownerEnv, HERMES_STATE: args[4], HERMES_CURRENT: args[3], HERMES_TRANSITION: transition, HERMES_RELEASE: target, HERMES_TARGET: target, HERMES_WORKER_REQUIRED: required }),
    classify: dependencies.classify,
    ownerError: () => owner.emit('error', Object.assign(new Error('broken IPC'), { code: 'EPIPE' })),
    ownerExit: () => { owner.connected = false; owner.emit('exit', 137); },
    resume: () => resumeBroker(), finish: result => owner.emit('message', { result }),
    query: () => python('query'),
    validateConfiguration: config => python('validate', config),
  };
}

// Child harness owns its supervisor process; no production environment adapter.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Parent removes state AFTER exit and fallback queries have completed.
  const f = fixture({ after: () => {} });
  await f.ownerReady;
  process.send({ environment: f.environment() });
  process.once('message', async () => {
    f.finish(3);
    const result = await f.running;
    assert.equal(result, 3);
    process.disconnect(); // Process exit is the parent's barrier, not this message.
  });
}
export const fixturePath = fileURLToPath(import.meta.url);
