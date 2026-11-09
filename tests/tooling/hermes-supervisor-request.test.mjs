// Real transport and actual CLI coverage. Positive receipt/fallback assertions
// explicitly inject only the test fixture's trusted UID and manager objects.
// The unprivileged CLI remains subject to production root DAC.
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { requestCommand } from '../../infra/deploy/hermes-supervisor.mjs';
import { fixture, fixturePath } from './hermes-supervisor-fixture.mjs';

const cliPath = resolve('infra/deploy/hermes-supervisor.mjs');
const invalidScopes = {
  'missing-both': environment => { delete environment.HERMES_TRANSITION; delete environment.HERMES_TARGET; },
  'missing-transition': environment => { delete environment.HERMES_TRANSITION; },
  'missing-target': environment => { delete environment.HERMES_TARGET; },
  'empty-transition': environment => { environment.HERMES_TRANSITION = ''; },
  'empty-target': environment => { environment.HERMES_TARGET = ''; },
  'relative-transition': environment => { environment.HERMES_TRANSITION = 'releases/transition'; },
  'relative-target': environment => { environment.HERMES_TARGET = 'candidate'; },
  'noncanonical-transition': environment => { environment.HERMES_TRANSITION += '/../transition'; },
  'noncanonical-target': environment => { environment.HERMES_TARGET += '/.'; },
  'outside-transition': environment => { environment.HERMES_TRANSITION = environment.HERMES_STATE + '/other/transition'; },
  'prefix-transition': environment => { environment.HERMES_TRANSITION = environment.HERMES_STATE + '/releases-other/transition'; },
  'releases-directory': environment => { environment.HERMES_TRANSITION = environment.HERMES_STATE + '/releases'; },
  'malformed-transition': environment => { environment.HERMES_TRANSITION += '\n'; },
  'malformed-target': environment => { environment.HERMES_TARGET += ' bad'; },
};
async function cli(action, environment) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERMES_')));
  const child = spawn(process.execPath, [cliPath, 'request', action], { env: { ...inherited, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  return { code, stdout, stderr };
}
function diskSnapshot(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(directory, entry.name);
    const stat = lstatSync(file, { bigint: true });
    const identity = ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(key => String(stat[key]));
    return [entry.name, identity, entry.isDirectory() ? diskSnapshot(file) : entry.isFile() ? readFileSync(file).toString('hex') : 'socket'];
  });
}
for (const lostReply of ['eof', 'partial']) test(`actual success CLI rejects ${lostReply} after real receipt commit; one read-only query recovers without replay`, async t => {
  const f = fixture(t, { lostReply }); await f.ownerReady;
  let finished = false;
  t.after(async () => { if (!finished) f.finish(3); await f.running; });
  const environment = f.environment();
  assert.deepEqual(await cli('activate', environment), { code: 0, stdout: '', stderr: '' });
  const success = await cli('success', environment);
  assert.equal(success.code, 1);
  assert.match(success.stderr, /disconnected before a complete response/);
  assert.equal(f.events.at(-1), `transport:${lostReply}`, 'server barrier follows the durable terminal commit');
  const disk = diskSnapshot(f.args[4]), events = [...f.events];
  assert.deepEqual(await cli('query-success', environment), { code: 0, stdout: 'committed\n', stderr: '' });
  assert.deepEqual(f.events, [...events, 'classify'], 'query only classifies; no starts, health or receipt commit repeat');
  assert.deepEqual(diskSnapshot(f.args[4]), disk, 'query leaves all state/receipt bytes unchanged');
  assert.equal(f.events.filter(event => event === 'receipt').length, 1);
  assert.equal(f.events.filter(event => event.startsWith('start:')).length, 2);
  const afterQuery = [...f.events];
  if (lostReply === 'eof') f.ownerError(); // Test-object owner IPC EPIPE after real socket EOF.
  else f.finish(3);
  assert.equal(await f.running, lostReply === 'eof' ? 1 : 3); finished = true;
  assert.deepEqual(f.events, afterQuery, 'postcommit EPIPE/degraded exit never stops the committed candidate');
});

test('supervisor process exits and unlinks socket before actual CLI uses production durable fallback', async t => {
  const child = fork(fixturePath, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const [{ environment }] = await once(child, 'message');
  t.after(() => rmSync(dirname(environment.HERMES_STATE), { recursive: true, force: true }));
  assert.equal((await cli('activate', environment)).code, 0);
  assert.equal((await cli('success', environment)).code, 0);
  const exited = once(child, 'exit'); child.send({ finish: true });
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  assert(!existsSync(environment.HERMES_SUPERVISOR_SOCKET));
  delete environment.HERMES_SUPERVISOR_TOKEN; // Durable fallback never requires the dead owner's bearer token.
  const disk = diskSnapshot(environment.HERMES_STATE);
  // A real manager is also unavailable, even if this runs as root. The fixture's
  // deliberately incomplete effective snapshot cannot satisfy production checks.
  assert.deepEqual(await cli('query-success', environment), { code: 4, stdout: 'unknown\n', stderr: '' }, 'production UID/manager checks remain in effect');
  for (const mutate of [...Object.values(invalidScopes),
    environment => { environment.HERMES_TRANSITION += '-wrong'; },
    environment => { environment.HERMES_TARGET += '-wrong'; }]) {
    const invalid = { ...environment }; mutate(invalid);
    assert.deepEqual(await cli('query-success', invalid), { code: 4, stdout: 'unknown\n', stderr: '' });
  }
  assert.deepEqual(diskSnapshot(environment.HERMES_STATE), disk);
});

for (const mutation of ['none', 'scope', 'target-scope', 'current', 'config', 'effective', 'guard', 'health-only', ...Object.keys(invalidScopes)]) test(`dead socket module CLI logic with explicit UID/manager injection: ${mutation}`, async t => {
  const f = fixture(t); await f.ownerReady;
  assert.equal((await f.request('activate')).ok, true);
  assert.equal((await f.request('success')).ok, true);
  f.finish(3); assert.equal(await f.running, 3);
  const environment = f.environment();
  delete environment.HERMES_SUPERVISOR_TOKEN;
  assert(!existsSync(environment.HERMES_SUPERVISOR_SOCKET));
  if (mutation === 'scope') environment.HERMES_TRANSITION += '-wrong';
  if (mutation === 'target-scope') environment.HERMES_TARGET += '-wrong';
  invalidScopes[mutation]?.(environment);
  if (mutation === 'current') { unlinkSync(f.args[3]); symlinkSync(f.args[1], f.args[3]); }
  if (mutation === 'config') writeFileSync(f.configFile, 'changed\n');
  if (mutation === 'effective') f.effective['aistudy-web.service'].NeedDaemonReload = 'yes';
  if (mutation === 'guard') writeFileSync(join(f.args[4], 'writers-fenced'), 'fenced\n');
  if (mutation === 'health-only') {
    rmSync(join(f.args[4], 'commit-receipts'), { recursive: true });
    writeFileSync(join(f.transition, 'succeeded'), 'healthy\n');
  }
  const disk = diskSnapshot(f.args[4]), events = [...f.events];
  const result = await requestCommand('query-success', environment, { classify: f.classify });
  const state = mutation === 'none' ? 'committed' : mutation === 'guard' ? 'fenced' : 'unknown';
  assert.deepEqual(result, { output: state, exitCode: state === 'committed' ? 0 : state === 'fenced' ? 3 : 4 });
  assert.deepEqual(f.events, invalidScopes[mutation] ? events : [...events, 'classify'], 'invalid scope is rejected before classifier; valid scope is checked exactly');
  assert.deepEqual(diskSnapshot(f.args[4]), disk);
});

test('actual request CLI propagates socket ENOENT; scoped query alone falls back', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-request-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { HERMES_SUPERVISOR_SOCKET: join(root, 'missing.sock'), HERMES_STATE: root,
    HERMES_CURRENT: join(root, 'current'), HERMES_TRANSITION: join(root, 'releases/transition'), HERMES_TARGET: join(root, 'target') };
  const success = await cli('success', environment);
  assert.equal(success.code, 1); assert.match(success.stderr, /ENOENT/);
  const withoutFallback = { ...environment }; delete withoutFallback.HERMES_STATE;
  const query = await cli('query-success', withoutFallback);
  assert.equal(query.code, 1); assert.match(query.stderr, /ENOENT/);
  assert.deepEqual(await cli('query-success', environment), { code: 4, stdout: 'unknown\n', stderr: '' });
});

// Real AF_UNIX response close/partial EOF, with the full request as barrier.
// destroy is not claimed as a TCP reset; ENOENT is tested separately above.
for (const response of ['empty', 'partial', 'destroy', 'committed', 'fenced', 'unknown', 'invalid-state']) test(`actual query CLI transport/status mapping: ${response}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-request-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'request.sock');
  let requests = 0;
  const server = createServer(socket => {
    let body = '';
    socket.on('error', () => {});
    socket.on('data', data => {
      body += data;
      if (!body.includes('\n') || requests) return;
      requests++;
      assert.equal(JSON.parse(body).action, 'query-success');
      if (response === 'destroy') socket.destroy(new Error('test transport failure'));
      else if (response === 'empty') socket.end();
      else if (response === 'partial') socket.end('{"ok":true,"state":"committed"}');
      else socket.end(JSON.stringify({ ok: response === 'committed', state: response }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await cli('query-success', { HERMES_SUPERVISOR_SOCKET: path, HERMES_STATE: join(root, 'missing-state'), HERMES_CURRENT: join(root, 'missing-current'),
    HERMES_TRANSITION: join(root, 'missing-state/releases/transition'), HERMES_TARGET: join(root, 'target') });
  const state = ['committed', 'fenced'].includes(response) ? response : 'unknown';
  assert.deepEqual(result, { code: state === 'committed' ? 0 : state === 'fenced' ? 3 : 4, stdout: state + '\n', stderr: '' });
  assert.equal(requests, 1);
});
