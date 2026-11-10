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
anchor=${JSON.stringify(scope === 'outer' ? 'def cancelled(signum,frame):' : 'def bounded(argv,*args,**kwargs):')}
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
 while not pathlib.Path(${JSON.stringify(pidfile)}).exists() and time.monotonic()<deadline: time.sleep(.005)
 child=int(pathlib.Path(${JSON.stringify(pidfile)}).read_text())
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
