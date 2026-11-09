// Component-injected manager/broker only. This exercises the real supervisor's
// socket protocol, installer, serial queue, state files and Python receipt IO;
// it does not attest a real systemd manager, root DAC or sandbox.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { processStarttime, supervise } from '../../infra/deploy/hermes-supervisor.mjs';

const units = ['aistudy-web.service', 'aistudy-worker.service'];
const stateModule = resolve('infra/deploy/hermes-writer-state.py');
// Test-only import/object injection. The production CLI has no adapter switch.
const receiptDriver = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('state',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=json.load(sys.stdin);m.TRUSTED_UID=os.geteuid();original=m.validate_config
def validate(config,sync=False):
 original({'files':config['files']},sync)
 if config.get('effective') != p['effective']: raise ValueError('Manager changed')
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
else: print(m.classify(p['state'],p['current'],p['broker'],p.get('scope'),sync=True))
`;
function fixture(t, { required = '1', fault, guard, brokerFailure = false, pauseBroker = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-supervisor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const args = ['deploy', join(root, 'legacy'), join(root, 'releases'), join(root, 'current'), join(root, 'state'), join(root, 'backups'), join(root, 'systemd'), join(root, 'config'), '1', 'a'.repeat(40), 'archive'];
  for (const dir of [args[1], args[2], args[4], args[6], args[7]]) mkdirSync(dir, { mode: 0o700 });
  const target = join(args[2], 'candidate'), transition = join(args[4], 'releases', 'transition');
  mkdirSync(target); mkdirSync(transition, { recursive: true, mode: 0o700 }); symlinkSync(target, args[3]);
  const configFile = join(args[1], '.env.production'); writeFileSync(configFile, 'fixture=true\n', { mode: 0o600 });
  const brokerPath = join(root, 'exec.sock'), events = [], effective = {}, grants = new Map(), used = {};
  let owner, ownerEnv, resumeBroker, readyOwner, readyBroker;
  const brokerReady = new Promise(resolve => { readyBroker = resolve; });
  const ownerReady = new Promise(resolve => { readyOwner = resolve; });
  const broker = new EventEmitter(); broker.stdin = new PassThrough();
  const command = argv => {
    const unit = argv.at(-1);
    if (argv[0] === 'show' && argv[1].includes('ExecStartEx')) return { ok: true, stdout: `NeedDaemonReload=no\nExecStartEx={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -S ${args[4]}/writer-controls/hermes-writer-exec.py ${args[4]} ${unit} ; flags=${unit === units[1] ? 'no-setuid' : ''} ; }\n` };
    if (argv[0] === 'show') return { ok: true, stdout: `MainPID=${process.pid}` };
    if (argv[0] === 'start') {
      events.push(`start:${unit}`);
      if (!grants.has(unit)) return { ok: false };
      grants.delete(unit); used[unit] = { pid: process.pid, start: processStarttime(process.pid) };
    }
    return { ok: true, stdout: '' };
  };
  const python = (mode, record, scope) => {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', receiptDriver, stateModule], {
      input: JSON.stringify({ mode, state: args[4], current: args[3], broker: brokerPath, record, scope, effective, fault: mode === 'commit' ? fault : undefined, guard }), encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr.trim());
    return result.stdout.trim();
  };
  const dependencies = {
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
    classify: (_state, _current, scope) => { try { return python('query', undefined, scope); } catch { return 'unknown'; } },
    spawn: (_exe, _argv, options) => {
      owner = new EventEmitter(); owner.connected = true; owner.send = () => {};
      ownerEnv = options.env;
      queueMicrotask(() => { owner.emit('message', { ownerPid: process.pid }); readyOwner(); });
      return owner;
    },
  };
  writeFileSync(join(transition, 'expected-target'), target);
  function request(action, extra = {}, loseAck = false) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(ownerEnv.HERMES_SUPERVISOR_SOCKET);
      let body = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({ action, token: ownerEnv.HERMES_SUPERVISOR_TOKEN, transition, release: target, target, required, ...extra }) + '\n'));
      socket.on('data', data => { body += data; if (body.includes('\n')) { if (loseAck) { socket.destroy(); resolve({ lost: true }); } else { socket.end(); resolve(JSON.parse(body)); } } });
    });
  }
  const running = supervise('test-owner', args, dependencies);
  return { args, target, transition, events, effective, grants, used, broker, request, ownerReady, brokerReady, running,
    ownerError: () => owner.emit('error', Object.assign(new Error('broken IPC'), { code: 'EPIPE' })),
    ownerExit: () => { owner.connected = false; owner.emit('exit', 137); },
    resume: () => resumeBroker(), finish: result => owner.emit('message', { result }),
    query: () => python('query'),
  };
}
for (const required of ['0', '1']) test(`supervisor grants only required units, terminal receipt and immutable committed generation (${required})`, async t => {
  const f = fixture(t, { required }); await f.ownerReady;
  assert.deepEqual(await f.request('activate'), { ok: true });
  assert.deepEqual(f.events.filter(e => e.startsWith('start:')), units.slice(0, required === '1' ? 2 : 1).map(unit => `start:${unit}`));
  assert(existsSync(join(f.args[4], 'activation-incomplete')));
  assert.deepEqual(await f.request('success', {}, true), { lost: true });
  assert.deepEqual(await f.request('query-success'), { ok: true, state: 'committed' });
  assert.equal(f.query(), 'committed', 'boot query requires no live owner token');
  const stops = f.events.filter(e => e === 'stop:both').length;
  for (const action of ['activate', 'arm', 'refence', 'stop']) assert.equal((await f.request(action)).ok, false);
  assert.equal(f.events.filter(e => e === 'stop:both').length, stops);
  assert(f.events.indexOf('health:postexec') < f.events.indexOf('broker:closed-unlinked'));
  assert(f.events.indexOf('broker:closed-unlinked') < f.events.indexOf('receipt'));
  assert(!existsSync(join(f.args[4], 'activation-incomplete')));
  f.finish(3); assert.equal(await f.running, 3, 'degraded owner exit does not revoke durable success');
  assert.equal(f.events.filter(e => e === 'stop:both').length, stops);
});
for (const [fault, guard] of [['fsync'], ['replace'], ['unlink', 'activation-incomplete'], ['unlink', 'migration-forward-only'], ['unlink', 'writers-fenced']]) test(`Python ${fault} ${guard ?? 'receipt'} failure through supervisor retains double fencing and stops both`, async t => {
  const f = fixture(t, { fault, guard }); await f.ownerReady;
  assert.equal((await f.request('activate')).ok, true);
  assert.equal((await f.request('success')).ok, false);
  assert.equal((await f.request('query-success')).state, 'fenced');
  for (const guard of ['migration-forward-only', 'writers-fenced']) assert(existsSync(join(f.args[4], guard)));
  assert(f.events.filter(e => e === 'stop:both').length >= 2);
  f.finish(1); assert.equal(await f.running, 1);
});
test('owner EOF invalidates pending broker continuation and serialized activation cannot start', async t => {
  const f = fixture(t, { pauseBroker: true }); await f.ownerReady;
  const activation = f.request('activate');
  // Explicit phase barrier, not a timeout or sleep-based scheduling assumption.
  await f.brokerReady;
  const stop = f.request('stop').catch(error => {
    assert(['ECONNRESET', 'ENOENT', 'ECONNREFUSED'].includes(error.code));
    return { ok: false };
  });
  f.finish(137);
  assert.equal((await activation).ok, false);
  assert.equal((await stop).ok, false);
  assert.equal(await f.running, 137);
  assert(!f.events.some(e => e.startsWith('start:')));
  for (const guard of ['migration-forward-only', 'writers-fenced']) assert(existsSync(join(f.args[4], guard)));
});
test('broker readiness failure never permits a writer or removes guards', async t => {
  const f = fixture(t, { brokerFailure: true }); await f.ownerReady;
  assert.equal((await f.request('activate')).ok, false);
  assert(!f.events.some(e => e.startsWith('start:')));
  f.finish(1); assert.equal(await f.running, 1);
});
for (const ended of ['ownerError', 'ownerExit']) test(`postcommit ${ended} never refences or stops the committed candidate`, async t => {
  const f = fixture(t); await f.ownerReady;
  assert.equal((await f.request('activate')).ok, true);
  assert.equal((await f.request('success')).ok, true);
  const stops = f.events.filter(e => e === 'stop:both').length;
  f[ended](); await f.running;
  assert.equal(f.events.filter(e => e === 'stop:both').length, stops);
  assert.equal(f.query(), 'committed');
});
test('queued arm and stop cannot interleave broker readiness or create another grant generation', async t => {
  const f = fixture(t, { pauseBroker: true }); await f.ownerReady;
  const activation = f.request('activate'); await f.brokerReady;
  const arm = f.request('arm'), stop = f.request('stop');
  f.resume();
  assert.equal((await activation).ok, true);
  assert.equal((await arm).ok, false);
  assert.equal((await stop).ok, true);
  assert.equal(f.grants.size, 0);
  assert.equal((await f.request('success')).ok, false);
  assert.equal(f.events.filter(e => e === 'start:aistudy-web.service').length, 1);
  f.finish(1); await f.running;
});
test('CURRENT replacement invalidates both live query and dead durable query without restarting', async t => {
  const f = fixture(t); await f.ownerReady;
  assert.equal((await f.request('activate')).ok, true);
  assert.equal((await f.request('success')).ok, true);
  unlinkSync(f.args[3]); symlinkSync(f.args[1], f.args[3]);
  assert.equal((await f.request('query-success')).state, 'unknown');
  assert.equal(f.query(), 'unknown');
  assert.equal(f.events.filter(e => e.startsWith('start:')).length, 2);
  f.finish(0); await f.running;
});
test('pending migration needs success proof; changed effective configuration cannot commit', async t => {
  const f = fixture(t); await f.ownerReady;
  assert.equal((await f.request('arm')).ok, true);
  assert.equal((await f.request('activate')).ok, false);
  writeFileSync(join(f.transition, 'migration-succeeded'), 'synthetic migration fixture only');
  assert.equal((await f.request('activate')).ok, true);
  f.effective[units[0]].NeedDaemonReload = 'yes'; f.effective.changed = true;
  assert.equal((await f.request('success')).ok, false);
  assert.equal((await f.request('query-success')).state, 'fenced');
  f.finish(1); await f.running;
});
