import test from 'node:test';
import assert from 'node:assert/strict';
import { systemctlCommand, RELOAD_TIMEOUT_MS, SYSTEMCTL_TIMEOUT_MS, SUPERVISOR_REQUEST_TIMEOUT_MS } from '../../infra/deploy/hermes-writer-control.mjs';
import { fixture } from './hermes-supervisor-fixture.mjs';
import { provisionCompletion, python, checkCompletion, COMPLETION_CHECK_TIMEOUT_MS } from '../../infra/deploy/hermes-writer-control.mjs';
import { parserPreflightOwned } from '../../infra/deploy/hermes-db.mjs';
import { supervise, cleanupCompletion } from '../../infra/deploy/hermes-supervisor.mjs';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { spawn, spawnSync } from 'node:child_process';

// The generated helper exits with os._exit: never put assertions after exec.
// Publish observations at the real exit boundary; assert them in this parent.
function observeBudgetWrapper(code, helper, failure = false) {
  const program=`import subprocess,sys,os,json\nseen=[]\nraised=False\ndef observe(argv,*a,**kw):\n    seen.append([argv,kw.get('timeout')])\n    return subprocess.CompletedProcess(argv,0)\nsubprocess.run=observe\nreal_exit=os._exit\ndef publish(code):\n    print(json.dumps({'seen':seen,'restored':subprocess.run is observe,'raised':raised,'code':code}),flush=True)\n    real_exit(code)\nos._exit=publish\nsys.argv=['entry',${JSON.stringify(helper)}]\ntry:\n    exec(${JSON.stringify(code)})\nexcept RuntimeError:\n    raised=True\n    publish(0)\n`;
  const result=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',program],{encoding:'utf8'});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);
  assert.equal(result.status,0,result.stderr);
  const observed=JSON.parse(result.stdout.trim());
  assert.equal(observed.code,0);assert.equal(observed.raised,failure);
  assert.equal(observed.restored,true,'wrapper did not restore subprocess.run');
  return observed.seen;
}

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
    checkCompletion: observedCheck, completionLaunchAdmission: () => {},
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

test('review timed-out leaf cannot leave setsid grandchild or inherited pipes alive', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-leaf-tree-'));
  t.after(() => rmSync(root, { recursive: true }));
  const marker = join(root, 'escaped-marker');
  const helper = join(root, 'helper.py');
  const grandchild = `import os,time; os.setsid(); time.sleep(.4); open(${JSON.stringify(marker)},'w').write('escaped')`;
  const child = `import subprocess,time; subprocess.Popen(['/usr/bin/python3','-c',${JSON.stringify(grandchild)}]); time.sleep(10)`;
  writeFileSync(helper, `import subprocess\nsubprocess.run(['/usr/bin/python3','-c',${JSON.stringify(child)}],timeout=.15,capture_output=True)\n`);
  assert.throws(() => provisionCompletion(helper, []), /immutable provision helper failed/);
  spawnSync('/usr/bin/python3', ['-c','import time; time.sleep(.5)']);
  assert(!existsSync(marker), 'escaped grandchild wrote after rejected leaf returned');
});

for (const ignoreTerm of [false, true]) test(`double-fork setsid leaf and inherited pipe drained; ignore TERM=${ignoreTerm}; adjacent session safe`, t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-adopted-leaf-'));
  t.after(() => rmSync(root, { recursive: true }));
  const adjacent = spawn('/usr/bin/python3', ['-c','import time; time.sleep(10)'], { stdio: 'ignore', detached: true });
  t.after(() => adjacent.kill('SIGKILL'));
  const pidfile = join(root, 'descendants');
  const marker = join(root, 'marker');
  const barrier = join(root, 'release-after-return');
  const helper = join(root, 'helper.py');
  const child = `import os,time,signal\n${ignoreTerm ? 'signal.signal(signal.SIGTERM,signal.SIG_IGN)' : ''}\nwith open(${JSON.stringify(pidfile)},'a') as f: f.write(str(os.getpid())+'\\n')\npid=os.fork()\nif pid:\n    os._exit(0)\nos.setsid()\nwith open(${JSON.stringify(pidfile)},'a') as f: f.write(str(os.getpid())+'\\n')\npid=os.fork()\nif pid:\n    os._exit(0)\nwith open(${JSON.stringify(pidfile)},'a') as f: f.write(str(os.getpid())+'\\n')\nwhile not os.path.exists(${JSON.stringify(barrier)}): time.sleep(.005)\nopen(${JSON.stringify(marker)},'w').write('escaped')\n`;
  writeFileSync(helper, `import subprocess\nsubprocess.run(['/usr/bin/python3','-c',${JSON.stringify(child)}],timeout=.15,capture_output=True)\n`);
  assert.throws(() => provisionCompletion(helper, []), /immutable provision helper failed/);
  writeFileSync(barrier, 'released after refusal');
  const pids = readFileSync(pidfile, 'utf8').trim().split('\n');
  assert.equal(pids.length, 3);
  for (const pid of pids) assert(!existsSync('/proc/' + pid), `owned descendant ${pid} still exists after refusal`);
  assert.doesNotThrow(() => process.kill(adjacent.pid, 0));
  spawnSync('/usr/bin/python3', ['-c','import time; time.sleep(.5)']);
  assert(!existsSync(marker));
});

test('parser-owned hard deadline kills ignored TERM and escaped descendants before return', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-owned-parser-'));t.after(()=>rmSync(root,{recursive:true}));
  const pidfile=join(root,'pids'),barrier=join(root,'release'),marker=join(root,'marker');
  const child=`import os,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nos.setsid()\nopen(${JSON.stringify(pidfile)},'a').write(str(os.getpid())+'\\n')\nwhile not os.path.exists(${JSON.stringify(barrier)}): time.sleep(.005)\nopen(${JSON.stringify(marker)},'w').write('after')`;
  const parser=`import subprocess,signal,time,os\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidfile)},'a').write(str(os.getpid())+'\\n')\nsubprocess.Popen(['/usr/bin/python3','-c',${JSON.stringify(child)}])\ntime.sleep(10)`;
  const start=performance.now();
  const result=parserPreflightOwned('/usr/bin/python3',['-c',parser],{stdio:'pipe'},(file,args,options)=>{
    assert(args.includes('90'));assert.equal(options.timeout,undefined);
    const scaled=[...args];scaled[scaled.indexOf('90')]='.1';
    return spawnSync(file,scaled,options);
  });
  assert.equal(result.status,1);
  assert(performance.now()-start<1000,'parser cancellation was not hard bounded');
  writeFileSync(barrier,'after wrapper returned');
  for(const pid of readFileSync(pidfile,'utf8').trim().split('\n')) assert(!existsSync('/proc/'+pid));
  assert(!existsSync(marker));
});

test('real scaled OUTER deadline owns escaped helper descendants until drained', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-outer-escape-'));
  t.after(() => rmSync(root, { recursive: true }));
  const adjacent=spawn('/usr/bin/python3',['-c','import time; time.sleep(10)'],{stdio:'ignore',detached:true});
  t.after(()=>adjacent.kill('SIGKILL'));
  const barrier=join(root,'release'), marker=join(root,'marker'), pidfile=join(root,'pid');
  const child=`import os,time,signal\nos.setsid()\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidfile)},'a').write(str(os.getpid())+'\\n')\npid=os.fork()\nif pid: os._exit(0)\nopen(${JSON.stringify(pidfile)},'a').write(str(os.getpid())+'\\n')\nwhile not os.path.exists(${JSON.stringify(barrier)}): time.sleep(.005)\nopen(${JSON.stringify(marker)},'w').write('after-return')`;
  const helper=join(root,'helper.py');
  writeFileSync(helper,`import subprocess\nsubprocess.run(['/usr/bin/python3','-c',${JSON.stringify(child)}],timeout=10,capture_output=True)\n`);
  assert.throws(()=>provisionCompletion(helper,[],(file,args,options)=>{
    const scaled=[...args];
    if(file==='timeout') scaled[1]='.25s';
    else scaled[scaled.indexOf('480')]='.25';
    return spawnSync(file,scaled,{...options,stdio:'pipe'});
  }));
  writeFileSync(barrier,'released only AFTER wrapper refusal');
  const pids=readFileSync(pidfile,'utf8').trim().split('\n');
  assert.equal(pids.length,2);
  for(const pid of pids) assert(!existsSync('/proc/'+pid),'outer returned while escaped descendant alive');
  assert.doesNotThrow(()=>process.kill(adjacent.pid,0));
  assert(!existsSync(marker));
});

test('review immutable helper ordinary systemctl receives bounded timeout', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-provision-budget-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  // Replace only the wrapper's subprocess sink: never execute systemctl.
  writeFileSync(helper, `import subprocess\ndef observe(argv,*args,**kwargs):\n    assert kwargs.get('timeout') == 15, repr(kwargs)\n    return subprocess.CompletedProcess(argv,0)\nsubprocess.run.__globals__['owned_run']=observe\nsubprocess.run(['systemctl','show','fixture'])\n`);
  provisionCompletion(helper, []);
});

test('review verify and identity commands have bounded leaves and restore fits the outer budget', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-restore-budget-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  writeFileSync(helper, `import subprocess\nsubprocess.run.__globals__['owned_run']=subprocess.run.__globals__['original']\nfor name in ['systemd-analyze','groupadd','useradd']:\n    for supplied in [None,1,100]:\n        subprocess.run([name,'fixture'],timeout=supplied)\n`);
  provisionCompletion(helper, [], (file, args) => {
    const code = args[args.lastIndexOf('-c') + 1];
    const seen=observeBudgetWrapper(code,helper);
    assert.deepEqual(seen.map(value=>value[1]),[15,1,15,15,1,15,15,1,15]);
    assert(args.includes('480')); // 300 leaf sum + IO/restore margin.
    return { status: 0 };
  });
});

test('synthetic immutable helper failure completes configure and restore reload within outer budget', t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-full-restore-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  writeFileSync(helper, `import subprocess\nsubprocess.run.__globals__['owned_run']=subprocess.run.__globals__['original']\nfor cmd in [['systemctl','is-active'],['systemctl','is-enabled'],['groupadd'],['useradd']]:\n    subprocess.run(cmd)\nsubprocess.run(['runuser','parser'],timeout=90)\nsubprocess.run(['systemd-analyze','verify'])\ntry:\n    subprocess.run(['systemctl','daemon-reload'])\n    subprocess.run(['systemctl','show'])\n    raise ValueError('effective verification failed')\nexcept ValueError:\n    subprocess.run(['systemctl','daemon-reload'])\n`);
  provisionCompletion(helper, [], (file, args, options) => {
    const code = args[args.lastIndexOf('-c') + 1];
    const seen=observeBudgetWrapper(code,helper);
    assert.deepEqual(seen.map(value=>value[1]),[15,15,15,15,90,15,60,15,60]);
    assert.deepEqual(seen.at(-1)[0],['systemctl','daemon-reload']);
    assert.equal(seen.reduce((sum,value)=>sum+value[1],0),300);
    assert(args.includes('480'));
    assert.equal(options.timeout, undefined);
    return { status: 0 };
  });
});

for (const failure of [false, true]) test(`provision wrapper budgets every systemctl, preserves stricter limits, restores on ${failure ? 'exception' : 'return'}`, t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-provision-wrapper-'));
  t.after(() => rmSync(root, { recursive: true }));
  const helper = join(root, 'helper.py');
  writeFileSync(helper, `import subprocess\nsubprocess.run.__globals__['owned_run']=subprocess.run.__globals__['original']\nfor command in ['is-active','is-enabled','show','daemon-reload']:\n    for supplied in [None,1,100]:\n        subprocess.run(['systemctl',command,'fixture'],timeout=supplied)\n${failure ? "raise RuntimeError('synthetic helper failure')" : ''}\n`);
  provisionCompletion(helper, [], (file, args, options) => {
    assert.equal(file, '/usr/bin/python3');
    assert(args.includes('480'));
    assert.equal(options.timeout, undefined);
    const code = args[args.lastIndexOf('-c') + 1];
    const seen=observeBudgetWrapper(code,helper,failure);
    assert.deepEqual(seen.map(value=>value[1]),[15,1,15,15,1,15,15,1,15,60,1,60]);
    return { status: 0 };
  });
});

test('synthetic delayed child is leaf-killed and provision owned outer deadline drains its tree', t => {
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
    assert(args.includes('480'));
    assert.equal(options.timeout, undefined);
    const scaled=[...args]; scaled[scaled.indexOf('480')]='.05';
    return spawnSync(file, scaled, options);
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
