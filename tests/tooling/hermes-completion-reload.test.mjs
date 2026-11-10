import test from 'node:test';
import assert from 'node:assert/strict';
import { systemctlCommand, RELOAD_TIMEOUT_MS, SYSTEMCTL_TIMEOUT_MS, SUPERVISOR_REQUEST_TIMEOUT_MS } from '../../infra/deploy/hermes-writer-control.mjs';
import { fixture } from './hermes-supervisor-fixture.mjs';

test('reload uses named 60s limit; ordinary systemctl stays 15s; no retry after timeout', () => {
  const seen = [];
  const execute = (file, args, options) => { seen.push({ file, args, options }); return { error: Error('timeout'), status: null }; };
  assert.equal(systemctlCommand(['daemon-reload'], execute).ok, false);
  assert.equal(systemctlCommand(['show', 'unit'], execute).ok, false);
  assert.deepEqual(seen.map(v => v.options.timeout), [60_000, 15_000]);
  assert(seen.every(v => v.options.killSignal === 'SIGKILL'));
  assert.equal(seen.length, 2);
  assert.equal(RELOAD_TIMEOUT_MS, 60_000);
  assert.equal(SYSTEMCTL_TIMEOUT_MS, 15_000);
  // Prepare: 3 reload + wrapper shows + 4 stop/show + failure refence.
  assert(SUPERVISOR_REQUEST_TIMEOUT_MS > 3 * RELOAD_TIMEOUT_MS + 6 * SYSTEMCTL_TIMEOUT_MS + 120_000);
});

test('real synthetic-manager socket preparation consumes three reloads and activation another three', async t => {
  const f = fixture(t, { completion: true });
  await f.ownerReady;
  assert.equal((await f.request('prepare')).ok, true);
  assert.equal(f.events.filter(v => v === 'manager:reload').length, 3);
  assert.equal((await f.request('activate')).ok, true);
  assert.equal(f.events.filter(v => v === 'manager:reload').length, 6);
  f.finish(1);
  assert.equal(await f.running, 1);
});

test('reload failure has one cleanup refence, never reenters consumed prepare or starts', async t => {
  const f = fixture(t, { completion: true, reloadFailure: 2 });
  await f.ownerReady;
  assert.equal((await f.request('prepare')).ok, false);
  const count = f.events.filter(v => v === 'manager:reload').length;
  assert.equal(count, 3); // Failed wrapper reload + independent fail-closed fence.
  assert.equal((await f.request('prepare')).ok, false);
  assert.equal((await f.request('activate')).ok, false);
  assert.equal(f.events.filter(v => v === 'manager:reload').length, count + 2); // Refence only, never install/activate.
  assert(!f.events.some(v => v.startsWith('start:')));
  f.finish(1);
  assert.equal(await f.running, 1);
});
