import test from 'node:test';
import assert from 'node:assert/strict';
import { systemctlCommand, RELOAD_TIMEOUT_MS, SYSTEMCTL_TIMEOUT_MS, SUPERVISOR_REQUEST_TIMEOUT_MS } from '../../infra/deploy/hermes-writer-control.mjs';
import { fixture } from './hermes-supervisor-fixture.mjs';
import { provisionCompletion } from '../../infra/deploy/hermes-writer-control.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('review immutable helper ordinary systemctl receives bounded timeout', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-provision-budget-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  // Replace only the wrapper's subprocess sink: never execute systemctl.
  writeFileSync(helper, `import subprocess\ndef observe(argv,*args,**kwargs):\n    assert kwargs.get('timeout') == 15, repr(kwargs)\n    return subprocess.CompletedProcess(argv,0)\nsubprocess.run.__globals__['original']=observe\nsubprocess.run(['systemctl','show','fixture'])\n`);
  provisionCompletion(helper, []);
});

for (const failure of [false, true]) test(`provision wrapper budgets every systemctl, preserves stricter limits, restores on ${failure ? 'exception' : 'return'}`, t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-provision-wrapper-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  writeFileSync(helper, `import subprocess\nfor command in ['is-active','is-enabled','show','daemon-reload']:\n    for supplied in [None,1,100]:\n        subprocess.run(['systemctl',command,'fixture'],timeout=supplied)\n${failure ? "raise RuntimeError('synthetic helper failure')" : ''}\n`);
  provisionCompletion(helper, [], (file, args, options) => {
    assert.equal(file, 'timeout');
    assert.deepEqual(args.slice(0, 2), ['--signal=KILL', '240s']);
    assert.equal(options.timeout, 245_000);
    const code = args[args.indexOf('-c') + 1];
    const program = `import subprocess,sys\nseen=[]\ndef observe(argv,*a,**kw):\n    seen.append(kw['timeout'])\n    return subprocess.CompletedProcess(argv,0)\nsubprocess.run=observe\nsys.argv=['entry',${JSON.stringify(helper)}]\ntry:\n    exec(${JSON.stringify(code)})\nexcept RuntimeError:\n    assert ${failure ? 'True' : 'False'}\nassert subprocess.run is observe\nassert seen == [15,1,15,15,1,15,15,1,15,60,1,60],repr(seen)\n`;
    const result = spawnSync('/usr/bin/python3', ['-I','-S','-B','-c',program], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { status: 0 };
  });
});

test('synthetic delayed child is leaf-killed and provision outer deadline kills its process group', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-outer-budget-'));
  t.after(() => rmSync(root, { recursive: true }));
  let observed;
  const leaf = systemctlCommand(['daemon-reload'], (file, args, options) => {
    observed = options.timeout;
    return spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { ...options, timeout: 25 });
  });
  assert.equal(observed, 60_000);
  assert.equal(leaf.ok, false);
  assert.equal(leaf.status, null);
  const helper = join(root, 'slow.py');
  writeFileSync(helper, 'import time\ntime.sleep(10)\n');
  assert.throws(() => provisionCompletion(helper, [], (file, args, options) => {
    assert.equal(args[1], '240s');
    assert.equal(options.timeout, 245_000);
    // Scale only the deadline, not the actual timeout/process-group mechanism.
    return spawnSync(file, [args[0], '0.05s', ...args.slice(2)], { ...options, timeout: 1_000 });
  }), /immutable provision helper failed/);
});

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
