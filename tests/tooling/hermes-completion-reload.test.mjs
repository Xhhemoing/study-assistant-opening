import test from 'node:test';
import assert from 'node:assert/strict';
import { systemctlCommand, RELOAD_TIMEOUT_MS, SYSTEMCTL_TIMEOUT_MS, SUPERVISOR_REQUEST_TIMEOUT_MS } from '../../infra/deploy/hermes-writer-control.mjs';
import { fixture } from './hermes-supervisor-fixture.mjs';
import { provisionCompletion, python, checkCompletion, COMPLETION_CHECK_TIMEOUT_MS } from '../../infra/deploy/hermes-writer-control.mjs';
import { supervise, cleanupCompletion } from '../../infra/deploy/hermes-supervisor.mjs';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

for (const overLimit of [false, true]) test(`scaled real completion-check child ${overLimit ? 'exceeds new hard limit: clean refusal, no claim/StopPost consumption' : 'exceeds old 150s equivalent and reaches first claim only after check'}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-full-check-'));
  t.after(() => rmSync(root, { recursive: true }));
  const args = ['complete-postmigration','/legacy','/releases','/current',root,'/backups','/systemd','/config','6291456',
    'e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf','/release',
    '4136bafe71484359263128af46d8ddadfe7e9e0227a0976d3f3858f3b9d2b0a0','/archive'];
  const events = [];
  const claim = join(root, 'postmigration-completion-claimed');
  const observedCheck = () => checkCompletion(args, {
    python: (file, argv, payload) => python(file, argv, payload, (_command, _argv, options) => {
      assert.equal(options.timeout, COMPLETION_CHECK_TIMEOUT_MS);
      assert(options.timeout >= 1_800_000);
      assert.equal(options.killSignal, 'SIGKILL');
      // Scale 5000:1: old150s=30ms, full2400s=480ms. Actual isolated child,
      // not a fabricated successful spawn result, never systemd or payload IO.
      const delay = overLimit ? 1 : 0.09;
      const result = spawnSync('/usr/bin/python3', ['-I','-S','-B','-c',
        `import time,json; time.sleep(${delay}); print(json.dumps({'release':'/release'}))`],
        { ...options, timeout: options.timeout / 5000 });
      if (overLimit) {
        assert.equal(result.error?.code, 'ETIMEDOUT');
        assert.equal(result.signal, 'SIGKILL');
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert(delay * 1000 > 150_000 / 5000);
      }
      events.push(result.error ? 'check-timeout' : 'check-complete');
      return result;
    }),
    ledger: () => events.push('ledger-quiet'),
  });
  await assert.rejects(supervise('unused', args, {
    verifyEntrySources: () => {}, completionService: () => ({ InvocationID: 'a'.repeat(32), ExecMainPID: '1234' }),
    checkCompletion: observedCheck,
    claimCompletion: () => { events.push('claim'); writeFileSync(claim, 'exclusive claim', { flag: 'wx' }); throw Error('test stops after first claim'); },
    createServer: () => { throw Error('must not create socket'); },
    stopWriters: () => { events.push('stop'); return true; },
  }), overLimit ? /Trusted writer control unavailable/ : /test stops after first claim/);
  assert.equal(existsSync(claim), !overLimit);
  assert.deepEqual(events, overLimit ? ['check-timeout'] : ['check-complete','ledger-quiet','claim']);
  if (overLimit) {
    cleanupCompletion(args, {
      service: () => ({}), hasClaim: () => existsSync(claim),
      readOrigin: () => { throw Error('no origin may be consumed'); },
      readClaim: () => { throw Error('no claim may be consumed'); },
      fence: () => { throw Error('no mutation'); }, stop: () => { throw Error('no stop'); },
    });
    assert(!existsSync(claim));
  }
});

test('review immutable helper ordinary systemctl receives bounded timeout', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-provision-budget-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  // Replace only the wrapper's subprocess sink: never execute systemctl.
  writeFileSync(helper, `import subprocess\ndef observe(argv,*args,**kwargs):\n    assert kwargs.get('timeout') == 15, repr(kwargs)\n    return subprocess.CompletedProcess(argv,0)\nsubprocess.run.__globals__['original']=observe\nsubprocess.run(['systemctl','show','fixture'])\n`);
  provisionCompletion(helper, []);
});

test('review verify and identity commands have bounded leaves and restore fits the outer budget', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-restore-budget-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  writeFileSync(helper, `import subprocess\nfor name in ['systemd-analyze','groupadd','useradd']:\n    for supplied in [None,1,100]:\n        subprocess.run([name,'fixture'],timeout=supplied)\n`);
  provisionCompletion(helper, [], (file, args, options) => {
    const code = args[args.indexOf('-c') + 1];
    const program = `import subprocess,sys\nseen=[]\ndef observe(argv,*a,**kw):\n    seen.append(kw.get('timeout'))\n    return subprocess.CompletedProcess(argv,0)\nsubprocess.run=observe\nsys.argv=['entry',${JSON.stringify(helper)}]\nexec(${JSON.stringify(code)})\nassert seen == [15,1,15,15,1,15,15,1,15],repr(seen)\n`;
    const result = spawnSync('/usr/bin/python3', ['-I','-S','-B','-c',program], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert(Number.parseInt(args[1]) >= 300 + 120); // 300 leaf sum + IO/restore margin.
    return { status: 0 };
  });
});

test('synthetic immutable helper failure completes configure and restore reload within outer budget', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-full-restore-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  writeFileSync(helper, `import subprocess\nfor cmd in [['systemctl','is-active'],['systemctl','is-enabled'],['groupadd'],['useradd']]:\n    subprocess.run(cmd)\nsubprocess.run(['runuser','parser'],timeout=90)\nsubprocess.run(['systemd-analyze','verify'])\ntry:\n    subprocess.run(['systemctl','daemon-reload'])\n    subprocess.run(['systemctl','show'])\n    raise ValueError('effective verification failed')\nexcept ValueError:\n    subprocess.run(['systemctl','daemon-reload'])\n`);
  provisionCompletion(helper, [], (file, args, options) => {
    const code = args[args.indexOf('-c') + 1];
    const program = `import subprocess,sys\nseen=[]\ndef observe(argv,*a,**kw):\n    seen.append((argv,kw['timeout']))\n    return subprocess.CompletedProcess(argv,0)\nsubprocess.run=observe\nsys.argv=['entry',${JSON.stringify(helper)}]\nexec(${JSON.stringify(code)})\nassert [v[1] for v in seen] == [15,15,15,15,90,15,60,15,60],repr(seen)\nassert seen[-1][0] == ['systemctl','daemon-reload']\nassert sum(v[1] for v in seen) == 300\nassert subprocess.run is observe\n`;
    const result = spawnSync('/usr/bin/python3', ['-I','-S','-B','-c',program], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(args[1], '480s');
    assert.equal(options.timeout, 485_000);
    return { status: 0 };
  });
});

for (const failure of [false, true]) test(`provision wrapper budgets every systemctl, preserves stricter limits, restores on ${failure ? 'exception' : 'return'}`, t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-provision-wrapper-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  writeFileSync(helper, `import subprocess\nfor command in ['is-active','is-enabled','show','daemon-reload']:\n    for supplied in [None,1,100]:\n        subprocess.run(['systemctl',command,'fixture'],timeout=supplied)\n${failure ? "raise RuntimeError('synthetic helper failure')" : ''}\n`);
  provisionCompletion(helper, [], (file, args, options) => {
    assert.equal(file, 'timeout');
    assert.deepEqual(args.slice(0, 2), ['--signal=KILL', '480s']);
    assert.equal(options.timeout, 485_000);
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
    assert.equal(args[1], '480s');
    assert.equal(options.timeout, 485_000);
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
