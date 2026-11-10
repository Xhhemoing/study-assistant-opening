import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionCompletion, runCompletionOwned } from '../../infra/deploy/hermes-writer-control.mjs';

test('pre-spawn rejection is clean; confirmed nonzero command may restore', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-confirmed-cleanup-'));
  t.after(()=>rmSync(root,{recursive:true}));
  const rejected=runCompletionOwned('/definitely/missing/sm95-command',[],.1,{stdio:'pipe'});
  assert.equal(rejected.status,1);
  const helper=join(root,'helper.py');
  writeFileSync(helper,`import subprocess,os\ntry:\n subprocess.run(['/usr/bin/python3','-c','import sys; sys.exit(7)'],check=True)\nexcept subprocess.CalledProcessError as error:\n assert error.returncode == 7\nelse: raise AssertionError('expected command failure')\n`);
  assert.doesNotThrow(()=>provisionCompletion(helper,[]));
});

test('signal after real fork but before Popen returns cannot leave live child', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-popen-window-'));t.after(()=>rmSync(root,{recursive:true}));
  const pidfile=join(root,'child');
  const child=`import os,signal,time\nos.setsid()\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidfile)},'w').write(str(os.getpid()))\ntime.sleep(20)`;
  const result=runCompletionOwned('/usr/bin/python3',['-c',child],5,{stdio:'pipe'},(file,args,options)=>{
    assert.equal(options.stdio,'pipe');
    const injected=[...args], index=injected.indexOf('-c')+1;
    const hook=`\nreal_popen=subprocess.Popen\ndef interrupted_popen(*args,**kwargs):\n    process=real_popen(*args,**kwargs)\n    deadline=time.monotonic()+2\n    while not os.path.exists(${JSON.stringify(pidfile)}) and time.monotonic()<deadline: time.sleep(.005)\n    os.kill(os.getpid(),signal.SIGTERM)\n    return process\nsubprocess.Popen=interrupted_popen\n`;
    injected[index]=injected[index].replace('\nprepare_owner()\ntry:',hook+'\nprepare_owner()\ntry:');
    const program=`import subprocess,pathlib,os,signal,json,sys\nargs=json.loads(${JSON.stringify(JSON.stringify(injected))})\nneighbor=subprocess.Popen([sys.executable,'-c','import time; time.sleep(20)'],start_new_session=True)\nowner=subprocess.Popen([${JSON.stringify(file)},*args],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\ntry:\n owner.wait(timeout=4)\n pid=int(pathlib.Path(${JSON.stringify(pidfile)}).read_text())\n live=pathlib.Path('/proc/'+str(pid)).exists()\n assert owner.returncode==1\n assert not live,'owner returned while forked child still live'\n assert neighbor.poll() is None,'adjacent session was killed'\nfinally:\n if pathlib.Path(${JSON.stringify(pidfile)}).exists():\n  try: os.kill(int(pathlib.Path(${JSON.stringify(pidfile)}).read_text()),signal.SIGKILL)\n  except ProcessLookupError: pass\n if owner.poll() is None: owner.kill(); owner.wait()\n neighbor.kill(); neighbor.wait()\n`;
    const check=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',program],{encoding:'utf8',timeout:7_000});
    assert.equal(check.status,0,check.stderr);
    return {status:1};
  });
  assert.equal(result.status,1);
});

test('pre-fork cooperative signal with empty owned scope returns cleanly', () => {
  const result=runCompletionOwned('/usr/bin/python3',['-c','raise SystemExit(0)'],5,{stdio:'pipe'},(file,args,options)=>{
    const changed=[...args], index=changed.indexOf('-c')+1;
    const hook=`\ndef interrupted_before_fork(*args,**kwargs):\n    os.kill(os.getpid(),signal.SIGTERM)\nsubprocess.Popen=interrupted_before_fork\n`;
    changed[index]=changed[index].replace('\nprepare_owner()\ntry:',hook+'\nprepare_owner()\ntry:');
    return spawnSync(file,changed,{...options,timeout:2_000});
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,1);
});

test('nested controller never falls back into helper restore after cleanup raises', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-controller-exit-'));t.after(()=>rmSync(root,{recursive:true}));
  const helper=join(root,'helper.py'),log=join(root,'restore');
  writeFileSync(helper,`import subprocess,os\ntry:\n subprocess.run(['/usr/bin/python3','-c','raise SystemExit(7)'],check=True)\nexcept BaseException:\n with open(${JSON.stringify(log)},'a') as out: out.write(str(os.getpid())+'\\n')\n`);
  provisionCompletion(helper,[],(file,args,options)=>{
    const changed=[...args], index=changed.lastIndexOf('-c')+1;
    const inject=`\nreal_drain=drain\ndef cleanup_raises():\n    real_drain()\n    raise RuntimeError('confirmed-empty cleanup error')\ndrain=cleanup_raises\n`;
    changed[index]=changed[index].replace('def bounded(argv,*args,**kwargs):',inject+'\ndef bounded(argv,*args,**kwargs):');
    const result=spawnSync(file,changed,{...options,stdio:'pipe'});
    assert.equal(result.status,0,result.stderr?.toString());
    const checked=spawnSync('/usr/bin/python3',['-c',`from pathlib import Path; rows=Path(${JSON.stringify(log)}).read_text().splitlines(); assert len(rows)==1,rows`],{encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr);
    return {status:0};
  });
});

test('post-fork ownership handoff fault drains leaf before original helper restore', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-fork-handoff-'));t.after(()=>rmSync(root,{recursive:true}));
  const pidfile=join(root,'pid'),log=join(root,'restore'),helper=join(root,'helper.py');
  const child=`import os,signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidfile)},'w').write(str(os.getpid()))\ntime.sleep(10)`;
  writeFileSync(helper,`import subprocess,sys,time,pathlib,os\ndef trace(frame,event,arg):\n if event=='line' and frame.f_code.co_name=='owned_run' and frame.f_locals.get('controller',0)>0:\n  sys.settrace(None)\n  deadline=time.monotonic()+2\n  while not pathlib.Path(${JSON.stringify(pidfile)}).exists() and time.monotonic()<deadline: time.sleep(.005)\n  raise OSError('post-fork handoff fault')\n return trace\nsys.settrace(trace)\ntry:\n subprocess.run(['/usr/bin/python3','-c',${JSON.stringify(child)}],timeout=5)\nexcept BaseException:\n pid=int(pathlib.Path(${JSON.stringify(pidfile)}).read_text())\n assert not pathlib.Path('/proc/'+str(pid)).exists(),'live leaf at restore'\n pathlib.Path(${JSON.stringify(log)}).write_text(str(os.getpid()))\n`);
  assert.doesNotThrow(()=>provisionCompletion(helper,[]));
});

test('transient real reap faults cannot execute controller copy of helper restore', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-reap-fallthrough-'));t.after(()=>rmSync(root,{recursive:true}));
  const helper=join(root,'helper.py'),log=join(root,'restore');
  writeFileSync(helper,`import subprocess,os\nreal_wait=os.waitpid\ncalls=0\ndef interrupted(pid,flags):\n global calls\n if pid==-1 and flags==os.WNOHANG:\n  calls+=1\n  if calls in (1,3): raise OSError('transient reap error')\n return real_wait(pid,flags)\nos.waitpid=interrupted\ntry:\n subprocess.run(['/usr/bin/python3','-c','raise SystemExit(7)'],check=True)\nexcept BaseException:\n with open(${JSON.stringify(log)},'a') as f: f.write(str(os.getpid())+'\\n')\n`);
  assert.doesNotThrow(()=>provisionCompletion(helper,[]));
  const result=spawnSync('/usr/bin/python3',['-c',`from pathlib import Path; rows=Path(${JSON.stringify(log)}).read_text().splitlines(); assert len(rows)==1,rows`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

for (const fault of ['signal', 'pidfd-open', 'observe', 'reap']) for (const scope of ['outer', 'nested']) test(`cleanup ${fault} failure retains ${scope} owner and never permits restore while child lives`, t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-cleanup-error-'));
  t.after(()=>rmSync(root,{recursive:true}));
  const pidfile=join(root,'child'), restore=join(root,'restore'), release=join(root,'release');
  const child=`import os,signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidfile)},'w').write(str(os.getpid()))\ntime.sleep(20)`;
  const helper=join(root,'helper.py');
  writeFileSync(helper,`import subprocess,pathlib\ntry:\n subprocess.run(['/usr/bin/python3','-c',${JSON.stringify(child)}],timeout=.1)\nexcept BaseException:\n pathlib.Path(${JSON.stringify(restore)}).write_text('configuration restore continued')\n`);
  provisionCompletion(helper,[],(file,args)=>{
    const program=`import subprocess,os,time,pathlib,signal,sys,json
args=json.loads(${JSON.stringify(JSON.stringify(args))})
indexes=[i+1 for i,v in enumerate(args) if v=='-c']
injection='''
real_send=signal.pidfd_send_signal
real_open=os.pidfd_open
real_children=children
real_wait=os.waitpid
def active():
    return os.path.exists(${JSON.stringify(pidfile)}) and not os.path.exists(${JSON.stringify(release)})
def broken_send(fd,sig,*args):
    if ${JSON.stringify(fault)}=='signal' and sig==signal.SIGKILL and active(): raise PermissionError('synthetic cleanup signal')
    return real_send(fd,sig,*args)
def broken_open(pid,*args):
    if ${JSON.stringify(fault)}=='pidfd-open' and active(): raise OSError('synthetic pidfd error')
    return real_open(pid,*args)
def broken_children():
    if ${JSON.stringify(fault)}=='observe' and active(): raise OSError('synthetic observation error')
    return real_children()
def broken_wait(pid,*args):
    if ${JSON.stringify(fault)}=='reap' and active(): raise OSError('synthetic reap error')
    return real_wait(pid,*args)
signal.pidfd_send_signal=broken_send
os.pidfd_open=broken_open
children=broken_children
os.waitpid=broken_wait
'''
index=indexes[${scope === 'outer' ? '0' : '-1'}]
anchor=${JSON.stringify(scope === 'outer' ? '\nprepare_owner()\ntry:' : 'def bounded(argv,*args,**kwargs):')}
args[index]=args[index].replace(anchor,injection+'\\n'+anchor)
if ${scope === 'outer' ? 'True' : 'False'}:
 args[args.index('480')]='.15'
 # Keep nested leaf deadline beyond outer, so outer cancellation owns the error.
 source=pathlib.Path(${JSON.stringify(helper)})
 source.write_text(source.read_text().replace('timeout=.1','timeout=10'))
owner=subprocess.Popen([${JSON.stringify(file)},*args],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
child=None
try:
 deadline=time.monotonic()+3
 while time.monotonic()<deadline:
  try:
   child=int(pathlib.Path(${JSON.stringify(pidfile)}).read_text())
   break
  except (FileNotFoundError,ValueError): time.sleep(.005)
 assert child is not None,'child PID handoff not complete'
 time.sleep(.9)
 assert owner.poll() is None,'owner returned before cleanup confirmation'
 assert pathlib.Path('/proc/'+str(child)).exists(),'fault did not leave a live owned child'
 assert not pathlib.Path(${JSON.stringify(restore)}).exists(),'helper restored while cleanup unconfirmed'
 pathlib.Path(${JSON.stringify(release)}).touch()
 os.kill(child,signal.SIGKILL) # Test supervisor resolves UNKNOWN; not a helper retry.
 owner.wait(timeout=4)
 assert not pathlib.Path('/proc/'+str(child)).exists(),'owner returned with child live'
finally:
 if child is not None:
  try: os.kill(child,signal.SIGKILL)
  except ProcessLookupError: pass
 if owner.poll() is None: owner.kill(); owner.wait()
`;
    const result=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',program],{encoding:'utf8',timeout:8_000});
    assert.equal(result.status,0,result.stderr);
    return {status:0};
  });
});
