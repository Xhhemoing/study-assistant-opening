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
