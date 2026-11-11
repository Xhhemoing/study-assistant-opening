import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,statSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {provisionCompletion} from '../../infra/deploy/hermes-writer-control.mjs';

// These tests execute both generated owners with actual kernel flock/pidfd/fsync.
// Only fixture DAC ownership and system tools are substituted. Never run as root.
function fixture(t) {
  assert.notEqual(process.getuid(),0,'sm95 offline tests must run as nonroot');
  const root=mkdtempSync(join(tmpdir(),'sm95-flock-descriptor-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const systemd=join(root,'systemd'),config=join(root,'config'),state=join(root,'state');
  for(const path of [systemd,config,state])mkdirSync(path,{mode:0o700});
  const unit=join(systemd,'aistudy-worker.service'),runtime=join(config,'worker-runtime.env');
  const lock=join(config,'.worker-provision.lock'),helper=join(root,'helper.py'),hit=join(root,'hit');
  writeFileSync(unit,'old-unit',{mode:0o600});writeFileSync(runtime,'old-runtime',{mode:0o600});writeFileSync(lock,'',{mode:0o600});
  const events=join(root,'events'),tools=join(root,'fake-systemtools.py');
  const fault=join(root,'tool-fault');
  writeFileSync(tools,`import sys,json\nfrom pathlib import Path\nwith open(${JSON.stringify(events)},'a') as log: log.write(json.dumps(sys.argv[1:])+'\\n')\nname=sys.argv[1].rsplit('/',1)[-1]\nfault=Path(${JSON.stringify(fault)})\nif fault.exists():\n kind=fault.read_text()\n if kind in (name,name+':'+sys.argv[2]):\n  fault.unlink()\n  sys.exit(7)\n if name=='runuser' and kind=='parser-timeout':\n  import time\n  fault.unlink()\n  time.sleep(10)\n if name=='runuser' and kind in ('cancel-term','cancel-hup'):\n  import os,signal\n  fault.unlink()\n  os.kill(int(Path(${JSON.stringify(join(root,'helper-pid'))}).read_text()),signal.SIGTERM if kind=='cancel-term' else signal.SIGHUP)\n if name=='systemctl' and sys.argv[2]=='show' and kind=='bad-effective-config':\n  fault.unlink()\n  print('User=root')\n  sys.exit(0)\nif name=='systemctl' and sys.argv[2] in ('is-active','is-enabled'): sys.exit(1)\nif name=='systemctl' and sys.argv[2]=='show': print(Path(${JSON.stringify(join(root,'show'))}).read_text())\n`);
  let result;
  function execute(file,args,options) {
    const changed=[...args],outer=changed.indexOf('-c')+1,inner=changed.lastIndexOf('-c')+1;
    const fakeTools=`\nimport subprocess\nreal_popen=subprocess.Popen\ndef fake_popen(argv,*a,**kw):\n    if isinstance(argv,(list,tuple)) and argv and argv[0].rsplit('/',1)[-1] in ('systemctl','systemd-analyze','runuser','groupadd','useradd'):\n        argv=['/usr/bin/python3',${JSON.stringify(tools)},*argv]\n    return real_popen(argv,*a,**kw)\nsubprocess.Popen=fake_popen\n`;
    changed[outer]=changed[outer].replace('preimage=[]',`import functools\ntrusted['safe_open']=functools.partial(trusted['safe_open'],uid=os.geteuid())\ntrusted['read_trusted']=functools.partial(trusted['read_trusted'],uid=os.geteuid())\npreimage=[]`);
    changed[outer]=fakeTools+changed[outer];
    changed[inner]=fakeTools+changed[inner];
    const actual=process.env.SM95_FLOCK_OPTIMIZE==='1' ? changed.flatMap(value=>value==='-c'?['-O','-c']:[value]) : changed;
    result=spawnSync(file,actual,{...options,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe',timeout:8_000});
    return result;
  }
  function run(program) {
    writeFileSync(helper,program);
    let error;
    try { provisionCompletion(helper,['--systemd-dir',systemd,'--config-dir',config],execute); }
    catch(caught) { error=caught; }
    assert.equal(result?.error,undefined,result?.error?.message);
    return {error,status:result.status,stderr:result.stderr.toString()};
  }
  return {root,systemd,config,state,unit,runtime,lock,helper,hit,events,fault,execute,run,get result(){return result;}};
}

for(const kind of ['file-object','binary-file','integer']) test(`same generation ${kind} reaches real owned subprocess and keeps peer excluded`,t=>{
  const f=fixture(t);
  const value=kind==='integer'?'lock.fileno()':'lock';
  const r=f.run(`import fcntl,subprocess,sys,pathlib\nwith open(${JSON.stringify(f.lock)},${JSON.stringify(kind==='binary-file'?'rb':'a')}) as lock:\n fcntl.flock(${value},fcntl.LOCK_EX)\n peer=subprocess.run([sys.executable,'-c',"import fcntl,sys; f=open(sys.argv[1],'rb'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",${JSON.stringify(f.lock)}],capture_output=True)\n if peer.returncode==0: raise RuntimeError('peer entered owner generation')\n if b'BlockingIOError' not in peer.stderr: raise RuntimeError(repr(peer.stderr))\n pathlib.Path(${JSON.stringify(f.hit)}).write_text('lock accepted and peer excluded')\n`);
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.error,undefined);
  assert.equal(readFileSync(f.hit,'utf8'),'lock accepted and peer excluded');
});

for(const kind of ['different-inode','different-inode-fd','closed-file','closed-fd','invalid-op','replaced-lock']) test(`generated flock rejects ${kind} before helper mutation`,t=>{
  const f=fixture(t);
  const setup={
    'different-inode':`other=pathlib.Path(${JSON.stringify(join(f.root,'other'))});other.touch(mode=0o600)\nlock=open(other,'a')\n`,
    'different-inode-fd':`other=pathlib.Path(${JSON.stringify(join(f.root,'other'))});other.touch(mode=0o600)\nlock=os.open(other,os.O_RDONLY)\n`,
    'closed-file':`lock=open(${JSON.stringify(f.lock)},'a');lock.close()\n`,
    'closed-fd':`opened=os.open(${JSON.stringify(f.lock)},os.O_RDONLY);os.close(opened);lock=opened\n`,
    'invalid-op':`lock=open(${JSON.stringify(f.lock)},'a')\n`,
    'replaced-lock':`pathlib.Path(${JSON.stringify(f.lock)}).rename(${JSON.stringify(f.lock+'.original')})\npathlib.Path(${JSON.stringify(f.lock)}).touch(mode=0o600)\nlock=open(${JSON.stringify(f.lock)},'a')\n`,
  }[kind];
  const operation=kind==='invalid-op'?'fcntl.LOCK_UN':'fcntl.LOCK_EX';
  const expected={
    'different-inode':/different provision lock generation/,
    'different-inode-fd':/different provision lock generation/,
    'closed-file':/ValueError: I\/O operation on closed file/,
    'closed-fd':/OSError: \[Errno 9\] Bad file descriptor/,
    'invalid-op':/Unexpected provision lock operation/,
    'replaced-lock':/different provision lock generation/,
  }[kind];
  const r=f.run(`import os,fcntl,pathlib\n${setup}fcntl.flock(lock,${operation})\npathlib.Path(${JSON.stringify(f.hit)}).write_text('unexpected mutation')\n`);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,expected);
  assert.match(r.error.message,/immutable provision helper failed/);
  assert.equal(readFileSync(f.unit,'utf8'),'old-unit');
  assert.equal(readFileSync(f.runtime,'utf8'),'old-runtime');
  assert.throws(()=>readFileSync(f.hit),{code:'ENOENT'});
  if(kind==='replaced-lock')assert.match(r.stderr,/RESTORE_UNCONFIRMED/);
});

for(const operation of ['LOCK_SH','LOCK_EX|fcntl.LOCK_NB']) test(`generated flock accepts only exact LOCK_EX: ${operation}`,t=>{
  const f=fixture(t);
  const r=f.run(`import fcntl\nwith open(${JSON.stringify(f.lock)},'a') as lock: fcntl.flock(lock,fcntl.${operation})\n`);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Unexpected provision lock operation/);
});

test('private lock mode remains mandatory before helper execution',t=>{
  const f=fixture(t);chmodSync(f.lock,0o644);
  const r=f.run(`from pathlib import Path\nPath(${JSON.stringify(f.hit)}).touch()\n`);
  assert.notEqual(r.status,0);assert.match(r.stderr,/Private state is not private/);
  assert.throws(()=>readFileSync(f.hit),{code:'ENOENT'});
});

for(const failure of [undefined,'create-identities','groupadd','useradd','runuser','systemd-analyze','systemctl:daemon-reload','systemctl:show','bad-effective-config','cancel-term','cancel-hup','parser-timeout']) test(`unchanged provision-worker reaches natural terminal through generated owners: ${failure??'success'}`,t=>{
  const f=fixture(t),release=join(f.root,'release'),cache=join(f.root,'cache'),current=join(f.root,'current');
  mkdirSync(join(release,'services/parser/opening_parser'),{recursive:true});
  writeFileSync(join(release,'services/parser/opening_parser/__main__.py'),'pass\n');
  const env=join(f.root,'fixture.env');writeFileSync(env,'PARSER_PYTHON=/usr/bin/python3\n',{mode:0o600});
  writeFileSync(join(f.root,'show'),[
    'User=aistudy-worker','Group=aistudy-worker','ProtectSystem=strict','PrivateTmp=yes',
    'NoNewPrivileges=yes','CapabilityBoundingSet=cap_setgid cap_setuid',
    `WorkingDirectory=${current}`,`ReadWritePaths=${cache}`,
    `EnvironmentFiles=${env} (ignore_errors=no) ${f.runtime} (ignore_errors=no)`,
    `ExecStartEx={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -S -B ${f.state}/writer-controls/hermes-trusted-loader.py exec ${f.state} aistudy-worker.service ; flags=no-setuid ; }`,
    'ExecStartPre=','ExecStartPost=','ExecCondition=','ExecReload=',
  ].join('\n'));
  // The PM relay can be supplied explicitly; hash-identical repository bytes
  // remain the default for ordinary offline/CI runs. Never rewrite either input.
  const directory=process.env.SM95_SIGNED_HELPER_DIR;
  const worker=directory ? join(directory,'provision-worker.py') : fileURLToPath(new URL('../../infra/deploy/provision-worker.py',import.meta.url));
  const template=directory ? join(directory,'aistudy-worker.service') : fileURLToPath(new URL('../../infra/deploy/aistudy-worker.service',import.meta.url));
  const pins={
    'provision-worker.py':'118ace987068d5d80bc54ab72ebe866fabff90be9771076c9c0a27ccd7a197fd',
    'provision-worker.sh':'5fbf2b3d0b8023e935137bae093c56604d3ca32b25b4ae6cec464fe4425549f8',
    'aistudy-worker.service':'99572068e49a7f5b84840ad19b1bb7330d37d23d7fb12c6ca08057811bccdd73',
  };
  for(const [name,pin] of Object.entries(pins)) {
    const path=directory ? join(directory,name) : fileURLToPath(new URL('../../infra/deploy/'+name,import.meta.url));
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),pin,name);
  }
  const args=['--systemd-dir',f.systemd,'--config-dir',f.config,'--state-dir',f.state,
    '--writer-state-dir',f.state,'--release-dir',release,'--app-dir',current,
    '--legacy-app-dir',join(f.root,'legacy'),'--config-file',env,'--cache-dir',cache,'--unit-file',template];
  // Patch privileges in process memory AFTER inherited-lock verification. The
  // actual e5/425e worker bytes and its __main__ path are never rewritten.
  // Pin originals until after assertions: multiple helper/owner renames may
  // otherwise legitimately recycle a freed inode number on the same filesystem.
  const originals=[openSync(f.unit,'r'),openSync(f.runtime,'r')];
  t.after(()=>originals.forEach(fd=>closeSync(fd)));
  const unitInode=statSync(f.unit).ino,runtimeInode=statSync(f.runtime).ino;
  const fails=failure && failure!=='create-identities';
  if(fails)writeFileSync(f.fault,failure);
  let helperError;
  try { provisionCompletion(worker,args,(file,argv,options)=>{
    const changed=[...argv],inner=changed.lastIndexOf('-c')+1;
    const seam=`import grp,pwd,types\nfixture_uid=os.getuid();fixture_gid=os.getgid()\nwith open(${JSON.stringify(join(f.root,'helper-pid'))},'w') as marker: marker.write(str(os.getpid()))\nif fixture_uid==0: raise RuntimeError('offline fixture must not run as root')\nos.geteuid=lambda:0\nos.chown=lambda *a,**k:None\nos.fchown=lambda *a,**k:None\ngrp.getgrnam=lambda name:types.SimpleNamespace(gr_gid=fixture_gid)\npwd.getpwnam=lambda name:types.SimpleNamespace(pw_uid=fixture_uid,pw_gid=fixture_gid,pw_shell='/usr/sbin/nologin')\n    `;
    const identities=['create-identities','groupadd','useradd'].includes(failure) ? `\nlookups={'group':0,'user':0}\ndef lookup(kind):\n lookups[kind]+=1\n if lookups[kind]==1: raise KeyError(kind)\n return types.SimpleNamespace(gr_gid=fixture_gid) if kind=='group' else types.SimpleNamespace(pw_uid=fixture_uid,pw_gid=fixture_gid,pw_shell='/usr/sbin/nologin')\ngrp.getgrnam=lambda name:lookup('group')\npwd.getpwnam=lambda name:lookup('user')\n` : '';
    changed[inner]=changed[inner].replace('    runpy.run_path(sys.argv[0],run_name="__main__")',(seam.trim()+identities).split('\n').map(line=>'    '+line).join('\n')+'\n    runpy.run_path(sys.argv[0],run_name="__main__")');
    if(failure==='parser-timeout') {
      // Scale only the existing parser leaf timeout, retaining real timeout,
      // controller exception serialization, drain and owner cleanup behavior.
      changed[inner]=changed[inner].replace('    return owned_run(argv,*args,**kwargs)',"    if argv[0]=='runuser': kwargs['timeout']=.05\n    return owned_run(argv,*args,**kwargs)");
    }
    return f.execute(file,changed,options);
  }); } catch(error) { helperError=error; }
  assert.equal(f.result.error,undefined,f.result.error?.message);
  if(fails) {
    assert.match(helperError?.message??'',/immutable provision helper failed/);
    assert.equal(f.result.status,1,f.result.stderr.toString());
    if(failure==='parser-timeout')assert.match(f.result.stderr.toString(),/TimeoutExpired/);
    else if(failure.startsWith('cancel-'))assert.match(f.result.stderr.toString(),/Owned command cancelled/);
    else if(failure==='bad-effective-config')assert.match(f.result.stderr.toString(),/effective worker isolation differs/);
    else assert.match(f.result.stderr.toString(),/CalledProcessError/);
    assert.equal(readFileSync(f.unit,'utf8'),'old-unit');
    assert.equal(readFileSync(f.runtime,'utf8'),'old-runtime');
    // Even a pre-configure failure runs the owner's fixed preimage restore:
    // equal bytes are not evidence of no writes (both inode identities change).
    assert.notEqual(statSync(f.unit).ino,unitInode);
    assert.notEqual(statSync(f.runtime).ino,runtimeInode);
  } else {
    assert.equal(helperError,undefined,f.result.stderr.toString());
    assert.equal(f.result.status,0,f.result.stderr.toString());
    assert.match(readFileSync(f.unit,'utf8'),/ProtectSystem=strict/);
    assert.match(readFileSync(f.runtime,'utf8'),/HF_HUB_OFFLINE="1"/);
  }
  assert.equal(readFileSync(join(f.state,'worker-before/aistudy-worker.service'),'utf8'),'old-unit');
  const events=readFileSync(f.events,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const ordinary=[['systemctl','is-active'],['systemctl','is-enabled'],['runuser','-u'],
    ['systemd-analyze','verify'],['systemctl','daemon-reload'],['systemctl','show']];
  if(['create-identities','groupadd','useradd'].includes(failure))ordinary.splice(2,0,['groupadd','--system'],['useradd','--system']);
  const expected=failure==='groupadd' ? ordinary.slice(0,3) : failure==='useradd' ? ordinary.slice(0,4)
    : failure==='runuser'||failure==='parser-timeout'||failure?.startsWith('cancel-') ? ordinary.slice(0,3) : failure==='systemd-analyze' ? ordinary.slice(0,4)
    : failure==='systemctl:daemon-reload' ? [...ordinary.slice(0,5),['systemctl','daemon-reload'],['/usr/bin/systemctl','daemon-reload']]
    : failure==='systemctl:show'||failure==='bad-effective-config' ? [...ordinary,['systemctl','daemon-reload'],['/usr/bin/systemctl','daemon-reload']] : ordinary;
  if(['groupadd','useradd','runuser','systemd-analyze','cancel-term','cancel-hup','parser-timeout'].includes(failure))expected.push(['/usr/bin/systemctl','daemon-reload']);
  assert.deepEqual(events.map(argv=>[argv[0],argv[1]]),expected);
});
