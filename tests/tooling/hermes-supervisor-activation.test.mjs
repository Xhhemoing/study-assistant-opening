// Component-injected manager/broker and trusted UID; real socket/receipt IO.
// This does not attest production root DAC, systemd or sandbox behavior.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, units } from './hermes-supervisor-fixture.mjs';

test('fixture files-only validation survives sync recursion and still checks file identity', async t => {
  const f = fixture(t); await f.ownerReady;
  assert.equal((await f.request('activate')).ok, true);
  const { config } = JSON.parse(readFileSync(join(f.args[4], 'protocol2-transition.json'), 'utf8'));
  const filesOnly = { files: config.files };
  assert.doesNotThrow(() => f.validateConfiguration(filesOnly));
  writeFileSync(f.configFile, 'changed fixture configuration\n');
  assert.throws(() => f.validateConfiguration(filesOnly), /Configuration identity changed/);
});

test('fixture outer effective snapshot rejects real manager drift after files-only recursion', async t => {
  const f = fixture(t); await f.ownerReady;
  assert.equal((await f.request('activate')).ok, true);
  const { config } = JSON.parse(readFileSync(join(f.args[4], 'protocol2-transition.json'), 'utf8'));
  assert.doesNotThrow(() => f.validateConfiguration(config));
  f.effective[units[0]].NeedDaemonReload = 'yes';
  assert.throws(() => f.validateConfiguration(config), /Manager changed/);
  assert.equal((await f.request('success')).ok, false);
  assert.equal((await f.request('query-success')).state, 'fenced');
});

test('failed assertion tears down fixture owner, broker and open sockets before child exits', async t => {
  const source = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { existsSync } from 'node:fs';
    import { createConnection } from 'node:net';
    import test from 'node:test';
    import { fixture } from ${JSON.stringify(new URL('./hermes-supervisor-fixture.mjs', import.meta.url).href)};
    test('intentional fixture assertion failure', async t => {
      const signals = process.listenerCount('SIGTERM');
      const f = fixture(t); await f.ownerReady;
      assert.equal((await f.request('activate')).ok, true);
      const path = f.environment().HERMES_SUPERVISOR_SOCKET;
      const socket = createConnection(path);
      await once(socket, 'connect');
      const closed = once(socket, 'close');
      t.after(async () => {
        await closed;
        assert.equal(await f.running, 1);
        assert(!existsSync(path));
        assert(!existsSync(f.args[4]));
        assert(f.events.includes('broker:closed-unlinked'));
        assert.equal(process.listenerCount('SIGTERM'), signals);
      });
      process.send({ path, state: f.args[4] });
      process.disconnect();
      assert.fail('synthetic assertion before f.finish');
    });
  `;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '', paths;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('message', message => { paths = message; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  assert.equal(code, 1, stdout + stderr);
  assert.match(stdout, /synthetic assertion before f.finish/);
  assert.doesNotMatch(stdout, /hookFailed/);
  assert(paths, stdout + stderr);
  assert(!existsSync(paths.path));
  assert(!existsSync(paths.state));
});
for (const required of ['0', '1']) test(`supervisor grants only required units, terminal receipt and immutable committed generation (${required})`, async t => {
  const f = fixture(t, { required }); await f.ownerReady;
  assert.deepEqual(await f.request('activate'), { ok: true });
  assert.deepEqual(f.events.filter(e => e.startsWith('start:')), units.slice(0, required === '1' ? 2 : 1).map(unit => `start:${unit}`));
  assert(existsSync(join(f.args[4], 'activation-incomplete')));
  assert.deepEqual(await f.request('success'), { ok: true });
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
