import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionCompletion, runCompletionOwned } from '../../infra/deploy/hermes-writer-control.mjs';

for (const phase of ['drain', 'serialize-finally', 'handoff']) test(`continuous signal matrix nested ${phase} cannot restore with live leaf or duplicate helper`, t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-signal-matrix-'));t.after(()=>rmSync(root,{recursive:true}));
  const pidfile=join(root,'pid'), log=join(root,'restore'), helper=join(root,'helper.py'), hit=join(root,'exit-wrapper-hit');
  const child=`import signal,time,os\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidfile)},'w').write(str(os.getpid()))\ntime.sleep(10)`;
  writeFileSync(helper,`import subprocess,sys,os,pathlib,time,pickle\nns=subprocess.run.__globals__\ndef burst():\n for sig in (2,15,1,2,15): os.kill(os.getpid(),sig)\n${phase === 'serialize-finally' ? `original_exit=os._exit\ndef signal_at_exit(code):\n with open(${JSON.stringify(hit)},'a') as f: f.write(str(code)+'\\n')\n burst()\n original_exit(code)\nos._exit=signal_at_exit\ndef fail_dump(*a,**kw): raise OSError('serialize failure')\npickle.dump=fail_dump\n` : phase === 'drain' ? `real_drain=ns['drain']\ndef signal_at_drain():\n burst()\n return real_drain()\nns['drain']=signal_at_drain\n` : ''}\ndef trace(frame,event,arg):\n if event=='line' and frame.f_code.co_name==${JSON.stringify(phase === 'handoff' ? 'owned_run' : 'drain')} and ${phase === 'handoff' ? "frame.f_locals.get('controller',0)>0" : 'True'}:\n  sys.settrace(None)\n  burst()\n return trace\n${phase === 'handoff' ? 'sys.settrace(trace)' : ''}\ntry:\n subprocess.run(['/usr/bin/python3','-c',${JSON.stringify(child)}],timeout=.1,capture_output=True)\nexcept BaseException:\n if pathlib.Path(${JSON.stringify(pidfile)}).exists():\n  pid=int(pathlib.Path(${JSON.stringify(pidfile)}).read_text())\n  assert not pathlib.Path('/proc/'+str(pid)).exists(),'live leaf during restore'\n with open(${JSON.stringify(log)},'a') as f: f.write(str(os.getpid())+'\\n')\n`);
  // serialize-finally signals inside os._exit, AFTER the masked commit.
  // Preserve that historical injection as contract-outside, not lost evidence.
  if(phase==='serialize-finally') {
    assert.doesNotThrow(()=>provisionCompletion(helper,[]));
    assert.deepEqual(readFileSync(hit,'utf8').trim().split('\n'),['70','0'],'controller and original helper exit wrappers must both run');
  }
  else assert.throws(()=>provisionCompletion(helper,[]),/immutable provision helper failed/);
  assert.equal(readFileSync(log,'utf8').trim().split('\n').length,1);
});

for(const fault of ['fork','serialize','deserialize','communicate','flush','flush-exit']) test(`structural ownership fault matrix ${fault}: only original helper restores after empty scope`,t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-owned-fault-'));t.after(()=>rmSync(root,{recursive:true}));
  const log=join(root,'restore'), helper=join(root,'helper.py'), hit=join(root,'exit-wrapper-hit');
  const injection={
    fork:"def broken(*a,**kw): raise OSError('fork failure')\nos.fork=broken",
    serialize:"def broken(*a,**kw): raise OSError('pickle write failure')\npickle.dump=broken",
    deserialize:"def broken(*a,**kw): raise OSError('pickle read failure')\npickle.load=broken",
    communicate:"real=subprocess.Popen.communicate\ndef broken(self,*a,**kw):\n subprocess.Popen.communicate=real\n raise OSError('pipe read failure')\nsubprocess.Popen.communicate=broken",
    flush:"import tempfile\nreal_file=tempfile.TemporaryFile\nclass BadFlush:\n def __init__(self,*a,**kw): self.file=real_file(*a,**kw)\n def __enter__(self): return self\n def __exit__(self,*a): return self.file.__exit__(*a)\n def __getattr__(self,name): return getattr(self.file,name)\n def flush(self): raise OSError('actual flush failure')\ntempfile.TemporaryFile=BadFlush",
    'flush-exit':`real_exit=os._exit\ndef interrupted_exit(code):\n with open(${JSON.stringify(hit)},'a') as f: f.write(str(code)+'\\n')\n for sig in (2,15,1,2): os.kill(os.getpid(),sig)\n real_exit(code)\nos._exit=interrupted_exit\ndef broken(*a,**kw): raise OSError('serialize/flush boundary failure')\npickle.dump=broken`,
  }[fault];
  writeFileSync(helper,`import subprocess,os,pickle\n${injection}\ntry:\n subprocess.run(['/usr/bin/python3','-c','raise SystemExit(7)'],check=True,timeout=.1,capture_output=True)\nexcept BaseException:\n with open(${JSON.stringify(log)},'a') as f: f.write(str(os.getpid())+'\\n')\n`);
  // flush-exit injects after the commit in os._exit; it is intentionally
  // contract-outside, while the helper still records its original failure.
  assert.doesNotThrow(()=>provisionCompletion(helper,[]));
  if(fault==='flush-exit') assert.deepEqual(readFileSync(hit,'utf8').trim().split('\n'),['70','0'],'controller and original helper exit wrappers must both run');
  assert.equal(readFileSync(log,'utf8').trim().split('\n').length,1);
});

test('pre-create repeated cancellation refuses before executing the target',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-cancel-precreate-'));t.after(()=>rmSync(root,{recursive:true}));
  const marker=join(root,'must-not-run');
  const result=runCompletionOwned('/usr/bin/python3',['-c',`open(${JSON.stringify(marker)},'w').write('ran')`],1,{stdio:'pipe'},(file,args,options)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    changed[index]=changed[index].replace('\nprepare_owner()\ntry:',"\nfor sig in cancel_signals: os.kill(os.getpid(),sig)\nprepare_owner()\ntry:");
    return spawnSync(file,changed,options);
  });
  assert.equal(result.status,1);
  const check=spawnSync('/usr/bin/python3',['-c',`from pathlib import Path; assert not Path(${JSON.stringify(marker)}).exists()`]);
  assert.equal(check.status,0);
});

test('outer entry TERM plus HUP records cancel and drains escaped child', () => {
  const child='import signal,time,os; os.setsid(); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(10)';
  const result=runCompletionOwned('/usr/bin/python3',['-c',child],.1,{stdio:'pipe'},(file,args,options)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    const inject=`\ndef inject(frame,event,arg):\n if event=='line' and frame.f_code.co_name=='leaf' and 'proc' in frame.f_locals and frame.f_locals['proc'] is not None:\n  sys.settrace(None)\n  os.kill(os.getpid(),signal.SIGTERM)\n  os.kill(os.getpid(),signal.SIGHUP)\n return inject\nsys.settrace(inject)\n`;
    changed[index]=changed[index].replace('\nprepare_owner()\ntry:',inject+'\nprepare_owner()\ntry:');
    return spawnSync(file,changed,{...options,timeout:3_000});
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,1);
});
