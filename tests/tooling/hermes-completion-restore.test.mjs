import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionCompletion} from '../../infra/deploy/hermes-writer-control.mjs';

test('UNKNOWN cleanup never restores files before descendant absence is confirmed',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-restore-unknown-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const p of [systemd,config])mkdirSync(p,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env'),pidfile=join(root,'pid');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(join(config,'.worker-provision.lock'),'',{mode:0o600});
  const helper=join(root,'helper.py');
  const child=`import signal,os,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidfile)},'w').write(str(os.getpid()))\ntime.sleep(20)`;
  writeFileSync(helper,`import pathlib,subprocess\npathlib.Path(${JSON.stringify(unit)}).write_text('candidate-unit')\npathlib.Path(${JSON.stringify(runtime)}).write_text('candidate-runtime')\nsubprocess.run(['/usr/bin/python3','-c',${JSON.stringify(child)}],timeout=10)\n`);
  provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],(file,args)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;changed[changed.indexOf('480')]='3';
    const inject=`\nreal_send=signal.pidfd_send_signal\ndef blocked(fd,sig,*a):\n if sig==signal.SIGKILL: raise PermissionError('synthetic kill unavailable')\n return real_send(fd,sig,*a)\nsignal.pidfd_send_signal=blocked\n`;
    changed[index]=changed[index].replace('prepare_owner()\ntry:',inject+'\nprepare_owner()\ntry:')
      .replace('limit*5/6 if cleanup_enabled else limit','.15 if cleanup_enabled else limit')
      .replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`);
    const program=`import subprocess,pathlib,time,os,signal,json\nargs=json.loads(${JSON.stringify(JSON.stringify(changed))})\nowner=subprocess.Popen([${JSON.stringify(file)},*args],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nchild=None\ntry:\n deadline=time.monotonic()+2\n while time.monotonic()<deadline:\n  try:\n   child=int(pathlib.Path(${JSON.stringify(pidfile)}).read_text());break\n  except (FileNotFoundError,ValueError):time.sleep(.005)\n assert child is not None\n time.sleep(.6)\n assert owner.poll() is None\n assert pathlib.Path(${JSON.stringify(unit)}).read_text()=='candidate-unit'\n assert pathlib.Path(${JSON.stringify(runtime)}).read_text()=='candidate-runtime'\nfinally:\n if child is not None:\n  try:os.kill(child,signal.SIGKILL)\n  except ProcessLookupError:pass\n if owner.poll() is None:owner.kill();owner.wait()\n`;
    const r=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',program],{encoding:'utf8',timeout:5_000});
    assert.equal(r.status,0,r.stderr);return {status:0};
  });
});

test('real peer provision lock excludes capture and prevents mixed-generation restoration',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-lock-generation-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const p of [systemd,config])mkdirSync(p,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env'),lock=join(config,'.worker-provision.lock'),captured=join(root,'capture-hit');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(lock,'',{mode:0o600});
  const helper=join(root,'helper.py');writeFileSync(helper,"raise SystemExit(7)\n");
  provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],(file,args)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    changed[index]=changed[index].replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`)
      .replace('preimage.append((path,data,ident,parent_stat.st_dev,parent_stat.st_ino))',`preimage.append((path,data,ident,parent_stat.st_dev,parent_stat.st_ino)); open(${JSON.stringify(captured)},'w').write('captured')`)
      .replace("['/usr/bin/systemctl','daemon-reload']","['/usr/bin/true']");
    const program=`import subprocess,fcntl,pathlib,json\nlock=open(${JSON.stringify(lock)},'rb');fcntl.flock(lock,fcntl.LOCK_EX)\npathlib.Path(${JSON.stringify(unit)}).write_text('peer-unit')\nresult=subprocess.run([${JSON.stringify(file)},*json.loads(${JSON.stringify(JSON.stringify(changed))})],capture_output=True,timeout=3)\nassert not pathlib.Path(${JSON.stringify(captured)}).exists(),'preimage read while peer generation held lock'\nassert result.returncode!=0,'capture ignored live peer lock'\nassert pathlib.Path(${JSON.stringify(runtime)}).read_text()=='old-runtime'\npathlib.Path(${JSON.stringify(runtime)}).write_text('peer-runtime')\nfcntl.flock(lock,fcntl.LOCK_UN);lock.close()\nassert pathlib.Path(${JSON.stringify(unit)}).read_text()=='peer-unit'\nassert pathlib.Path(${JSON.stringify(runtime)}).read_text()=='peer-runtime'\n`;
    const r=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',program],{encoding:'utf8',timeout:5_000});
    assert.equal(r.status,0,r.stderr);return {status:0};
  });
});

test('0644 provision lock refuses before capture without chmod or helper mutation',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-lock-dac-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const p of [systemd,config])mkdirSync(p,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env'),lock=join(config,'.worker-provision.lock'),marker=join(root,'ran');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(lock,'',{mode:0o644});
  const helper=join(root,'helper.py');writeFileSync(helper,`from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('ran')`);
  assert.throws(()=>provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],(file,args,options)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    changed[index]=changed[index].replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`);
    return spawnSync(file,changed,{...options,stdio:'pipe'});
  }),/immutable provision helper failed/);
  assert.equal(readFileSync(unit,'utf8'),'old-unit');assert.equal(readFileSync(runtime,'utf8'),'old-runtime');
  const result=spawnSync('/usr/bin/python3',['-c',`from pathlib import Path; import stat; assert stat.S_IMODE(Path(${JSON.stringify(lock)}).stat().st_mode)==0o644; assert not Path(${JSON.stringify(marker)}).exists()`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('same real provision lock description spans coherent snapshot helper writes and cleanup',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-held-generation-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const p of [systemd,config])mkdirSync(p,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env'),lock=join(config,'.worker-provision.lock');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(lock,'',{mode:0o600});
  const helper=join(root,'helper.py'),pidfile=join(root,'pid'),milestone=join(root,'locked-and-mutated');
  writeFileSync(helper,`import os,fcntl,pathlib,subprocess,sys\npathlib.Path(${JSON.stringify(pidfile)}).write_text(str(os.getpid()))\nwith open(${JSON.stringify(lock)},'a') as held:\n fcntl.flock(held,fcntl.LOCK_EX)\n # Unmodified lock call is routed only to the inherited same-generation FD.\n peer=subprocess.run([sys.executable,*(['-O'] if sys.flags.optimize else []),'-c',"import fcntl,sys\\nf=open(sys.argv[1],'rb')\\ntry:\\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\\nexcept BlockingIOError:\\n print('EXPECTED_LOCK_CONTENTION',file=sys.stderr)\\n sys.exit(73)\\nraise RuntimeError('peer entered live generation')",${JSON.stringify(lock)}],capture_output=True,text=True)\n if peer.returncode!=73 or peer.stderr.strip()!='EXPECTED_LOCK_CONTENTION':\n  raise RuntimeError('peer did not prove expected lock contention: '+repr((peer.returncode,peer.stderr)))\n pathlib.Path(${JSON.stringify(unit)}).write_text('candidate-unit')\n pathlib.Path(${JSON.stringify(runtime)}).write_text('candidate-runtime')\n pathlib.Path(${JSON.stringify(milestone)}).write_text('locked-peer-excluded-both-written')\n raise SystemExit(7)\n`);
  assert.throws(()=>provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],(file,args,options)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    changed[index]=changed[index].replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`)
      .replace("['/usr/bin/systemctl','daemon-reload']","['/usr/bin/true']");
    const actual=process.env.SM95_FLOCK_OPTIMIZE==='1' ? changed.flatMap(value=>value==='-c'?['-O','-c']:[value]) : changed;
    return spawnSync(file,actual,{...options,stdio:'pipe',timeout:4_000});
  }),/immutable provision helper failed/);
  assert(readFileSync(pidfile,'utf8').trim().length>0,'real helper did not execute');
  assert.equal(readFileSync(milestone,'utf8'),'locked-peer-excluded-both-written','restore must follow real lock acceptance and mutation, not an early TypeError');
  assert.equal(readFileSync(unit,'utf8'),'old-unit');assert.equal(readFileSync(runtime,'utf8'),'old-runtime');
});

test('confirmed-empty drain exception still performs fixed cleanup and remains failure',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-empty-drain-cleanup-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const p of [systemd,config])mkdirSync(p,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(join(config,'.worker-provision.lock'),'',{mode:0o600});
  const helper=join(root,'helper.py');writeFileSync(helper,`from pathlib import Path\nPath(${JSON.stringify(unit)}).write_text('candidate-unit')\nPath(${JSON.stringify(runtime)}).write_text('candidate-runtime')\nraise SystemExit(7)\n`);
  assert.throws(()=>provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],(file,args,options)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    const injection=`\nreal_drain=drain\nhit=False\ndef raised_empty():\n global hit\n value=real_drain()\n if not hit:\n  hit=True\n  raise RuntimeError('already empty drain')\n return value\ndrain=raised_empty\n`;
    changed[index]=changed[index].replace('def require_empty_scope():',injection+'\ndef require_empty_scope():')
      .replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`)
      .replace("['/usr/bin/systemctl','daemon-reload']","['/usr/bin/true']");
    return spawnSync(file,changed,{...options,stdio:'pipe'});
  }),/immutable provision helper failed/);
  assert.equal(readFileSync(unit,'utf8'),'old-unit');assert.equal(readFileSync(runtime,'utf8'),'old-runtime');
});

for(const mode of ['outer-between-replaces','cancel-after-config','reload-failure','second-signal']) test(`owner cleanup-only restores confirmed-empty scope: ${mode}`,t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-cleanup-only-'));t.after(()=>rmSync(root,{recursive:true}));
  const systemd=join(root,'systemd'),config=join(root,'config');for(const p of [systemd,config])mkdirSync(p,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env'),log=join(root,'reload'),pidfile=join(root,'helper-pid');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});
  writeFileSync(join(config,'.worker-provision.lock'),'',{mode:0o600});
  const reload=join(root,'reload.py');
  writeFileSync(reload,`#!/usr/bin/python3\nimport os,pathlib,signal,sys\npid=int(pathlib.Path(${JSON.stringify(pidfile)}).read_text())\nassert not pathlib.Path('/proc/'+str(pid)).exists(),'helper live at reload'\n${mode==='second-signal'?"os.kill(os.getppid(),signal.SIGHUP)":""}\npathlib.Path(${JSON.stringify(log)}).write_text('cleanup-only')\nsys.exit(${mode==='reload-failure'?1:0})\n`,{mode:0o700});
  const helper=join(root,'helper.py');
  writeFileSync(helper,`import os,pathlib,time,signal\npathlib.Path(${JSON.stringify(pidfile)}).write_text(str(os.getpid()))\npathlib.Path(${JSON.stringify(unit)}).write_text('candidate-unit')\n${mode==='outer-between-replaces'?'time.sleep(10)':''}\npathlib.Path(${JSON.stringify(runtime)}).write_text('candidate-runtime')\nos.kill(os.getpid(),signal.SIGTERM)\nraise SystemExit(1)\n`);
  let stderr='';
  assert.throws(()=>provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],(file,args,options)=>{
    const changed=[...args],index=changed.indexOf('-c')+1;
    changed[changed.indexOf('480')]='3';
    // Object-only non-root DAC seam and scaled execution budget. Actual owner,
    // two-file restore, lock, fsync and cleanup leaf are otherwise unchanged.
    changed[index]=changed[index].replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`)
      .replace('limit*5/6 if cleanup_enabled else limit','.15 if cleanup_enabled else limit')
      .replace("['/usr/bin/systemctl','daemon-reload']",`[${JSON.stringify(reload)},'daemon-reload']`);
    const r=spawnSync(file,changed,{...options,stdio:'pipe'});stderr=r.stderr?.toString()??'';return r;
  }),/immutable provision helper failed/);
  assert.equal(readFileSync(unit,'utf8'),'old-unit');assert.equal(readFileSync(runtime,'utf8'),'old-runtime');
  assert.equal(readFileSync(log,'utf8'),'cleanup-only');
  if(mode==='reload-failure')assert.match(stderr,/RESTORE_UNCONFIRMED/);
});
