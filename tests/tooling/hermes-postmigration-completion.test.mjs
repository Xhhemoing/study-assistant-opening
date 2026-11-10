import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { claimCompletion, verifyCompletionLedger } from '../../infra/deploy/hermes-writer-control.mjs';
import { fixture, units } from './hermes-supervisor-fixture.mjs';
import { cleanGitEnvironment } from './hermes-git-fixture.mjs';
import { cleanupCompletion, completionService, completionServiceUnit, launchCompletion, supervise } from '../../infra/deploy/hermes-supervisor.mjs';

test('completion filesystem and payload readonly negatives', () => {
  const result = spawnSync('python3', ['-I','-S','-B',resolve('tests/tooling/hermes_postmigration_completion_test.py')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

for (const lostReply of [undefined, 'eof', 'partial']) test(`completion independently observed, no migration marker, ${lostReply ?? 'normal'} ACK`, async t => {
  const f = fixture(t, { completion: true, lostReply }); await f.ownerReady;
  assert(existsSync(join(f.args[4], 'postmigration-completion-claimed')));
  assert.equal((await f.request('arm')).ok, false);
  assert(!existsSync(join(f.transition, 'migration-succeeded')));
  assert.equal((await f.request('prepare')).ok, true);
  assert.equal((await f.request('activate')).ok, true);
  if (lostReply) await assert.rejects(f.request('success'), /Incomplete/);
  else assert.equal((await f.request('success')).ok, true);
  assert.equal(f.query(), 'committed');
  assert(!existsSync(join(f.transition, 'migration-succeeded')));
  assert(existsSync(join(f.args[4], 'postmigration-completion-claimed')));
  f.finish(0); assert.equal(await f.running, 0);
});

for (const fault of ['replace', 'fsync', 'unlink']) test(`completion terminal ${fault} fault retains refusal`, async t => {
  const f = fixture(t, { completion: true, fault }); await f.ownerReady;
  assert.equal((await f.request('prepare')).ok, true);
  assert.equal((await f.request('activate')).ok, true);
  assert.equal((await f.request('success')).ok, false);
  f.finish(1); assert.equal(await f.running, 1);
  assert(existsSync(join(f.args[4], 'writers-fenced')));
  assert(existsSync(join(f.args[4], 'postmigration-completion-claimed')));
  assert(f.events.includes('stop:both'));
});

for (const boundary of ['initial', 'partial96', 'broker', 'active']) test(`completion owner ends at ${boundary}, no automatic reentry`, async t => {
  const f = fixture(t, { completion: true, pauseBroker: boundary === 'broker' }); await f.ownerReady;
  if (boundary === 'partial96') {
    const blocked = join(f.args[6], `${units[1]}.d/96-aistudy-writer-exec.conf`);
    mkdirSync(blocked, { recursive: true });
    assert.equal((await f.request('prepare')).ok, false);
  } else if (boundary !== 'initial') {
    assert.equal((await f.request('prepare')).ok, true);
    if (boundary === 'broker') {
      const pending = f.request('activate'); await f.brokerReady;
      f.ownerExit(); f.resume(); assert.equal((await pending).ok, false);
    } else assert.equal((await f.request('activate')).ok, true);
  }
  if (boundary !== 'broker') f.ownerExit();
  assert.equal(await f.running, 1);
  assert(existsSync(join(f.args[4], 'writers-fenced')));
  assert(existsSync(join(f.args[4], 'postmigration-completion-claimed')));
});

test('completion queued cleanup after broker failure cannot admit another generation', async t => {
  const f=fixture(t,{completion:true,pauseBroker:true});await f.ownerReady;
  assert.equal((await f.request('prepare')).ok,true);
  const active=f.request('activate');await f.brokerReady;
  // Owner termination may close a queued connection before a JSON refusal.
  // Both are refusal; attach the transport assertion before triggering cleanup.
  const repeat=f.request('prepare').catch(error=>{assert(['ECONNRESET','ENOENT'].includes(error.code));return {ok:false};});
  f.ownerExit();f.resume();
  assert.equal((await active).ok,false);
  assert.equal((await repeat).ok,false);
  assert.equal(await f.running,1);
  assert(existsSync(join(f.args[4],'writers-fenced')));
  assert(f.events.includes('stop:both'));
  assert(existsSync(join(f.args[4],'postmigration-completion-claimed')));
});

test('independent service bounds, identity and cgroup fail closed', () => {
  const group = '/system.slice/aistudy-postmigration-completion.service';
  const good = { Id: 'aistudy-postmigration-completion.service', LoadState:'loaded', Restart:'no', KillMode:'control-group',
    RuntimeMaxUSec:'2h',TimeoutStopUSec:'4min', InvocationID:'a'.repeat(32),ControlGroup:group,Slice:'system.slice',MainPID:'1234',ExecMainPID:'1234',
    ExecStopPost:`{ path=/usr/bin/env ; argv[]=/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 ${process.execPath} ${resolve('infra/deploy/hermes-supervisor.mjs')} completion-stop-post ${resolve('infra/deploy/hermes-release.sh')} complete-postmigration /legacy ; }` };
  const run = values => () => ({ok:true,stdout:Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')});
  assert.equal(completionService(run(good),()=>`0::${group}`).InvocationID,good.InvocationID);
  for(const [key,value] of [['Restart','always'],['KillMode','process'],['RuntimeMaxUSec','infinity'],['TimeoutStopUSec','30s'],['InvocationID','unknown'],['ControlGroup','/user.slice/shared']])
    assert.throws(()=>completionService(run({...good,[key]:value}),()=>`0::${group}`));
  assert.throws(()=>completionService(run(good),()=> '0::/other'));
  const args=['complete-postmigration','/legacy','/releases','/current','/state','/backups','/systemd','/config','6291456','a'.repeat(40),'/release','b'.repeat(64),'/archive'];
  const unit = completionServiceUnit(args,'/trusted-controls','/usr/bin/node');
  assert.match(unit,/Restart=no\nKillMode=control-group\nRuntimeMaxSec=7200\nTimeoutStopSec=240/);
  assert.match(unit,/ExecStopPost=.*completion-stop-post/);
  assert.throws(()=>completionServiceUnit([...args.slice(0,-1),'/archive;evil']));
});

test('independent deadline/parent-death cleanup respects committed scope and stops both after fence failure', () => {
  const args = ['complete-postmigration','','','/current','/state','','','','','','/release'];
  const claim = {invocation:'a'.repeat(32),owner:'b'.repeat(32),incident:'/incident',release:'/release'};
  const origin = {...claim,state:'/state',mainPid:'1234'};
  for (const state of ['committed','fenced','unknown','partial-claim','no-claim','fence-fault']) {
    const events=[];
    const run=()=>cleanupCompletion(args,{
      service:()=>({InvocationID:claim.invocation,ExecMainPID:'1234'}),hasClaim:()=>state!=='no-claim',
      readOrigin:()=>origin,
      readClaim:()=>{if(state==='partial-claim')throw Error('partial');return claim;},
      query:(_s,_c,scope)=>{assert.deepEqual(scope,{owner:claim.owner,transition:claim.incident,target:claim.release});return state;},
      fence:()=>{events.push('fence');if(state==='fence-fault')throw Error('fsync');},stop:()=>{events.push('stop:both');return true;},
    });
    if(state==='fence-fault')assert.throws(run,/UNCONFIRMED/);else run();
    assert.deepEqual(events,['committed','no-claim'].includes(state)?[]:['fence','stop:both']);
  }
  for (const changed of [{invocation:'c'.repeat(32)},{mainPid:'999'},{state:'/other'},{release:'/other'}]) {
    const events=[];
    assert.throws(()=>cleanupCompletion(args,{service:()=>({InvocationID:claim.invocation,ExecMainPID:'1234'}),hasClaim:()=>true,
      readOrigin:()=>({...origin,...changed}),readClaim:()=>claim,fence:()=>events.push('fence'),stop:()=>events.push('stop')}),/scope changed/);
    assert.deepEqual(events,[]);
  }
  for (const contents of ['', '{broken']) {
    const events=[];
    assert.throws(()=>cleanupCompletion(args,{service:()=>({InvocationID:claim.invocation,ExecMainPID:'1234'}),hasClaim:()=>true,
      readOrigin:()=>{throw Error('no trusted origin');},readClaim:()=>JSON.parse(contents),
      fence:()=>events.push('fence'),stop:()=>events.push('stop')}),/no trusted origin/);
    assert.deepEqual(events,[]);
  }
});

test('immediate claim fault fences only independently proven creation', async t => {
  const root=mkdtempSync(join(tmpdir(),'completion-claim-fault-'));t.after(()=>rmSync(root,{recursive:true}));
  const args=['complete-postmigration','','','/current',root,'','','','','','/release'];
  for (const consumed of [false,true]) {
    const events=[];
    await assert.rejects(supervise('unused',args,{
      verifyEntrySources:()=>{},completionService:()=>({InvocationID:'a'.repeat(32),ExecMainPID:'1234'}),
      completionLaunchAdmission:()=>{},checkCompletion:()=>({release:'/release'}),claimCompletion:()=>{throw Object.assign(Error('claim fault'),{completionClaimConsumed:consumed});},
      stopWriters:()=>{events.push('stop:both');return true;},createServer:()=>{throw Error('must not start');},
    }),/claim fault/);
    assert.deepEqual(events,consumed?['stop:both']:[]);
    assert.equal(existsSync(join(root,'writers-fenced')),consumed);
  }
});

test('injected manager still traverses claim admission before any first write', async t => {
  const root = mkdtempSync(join(tmpdir(), 'completion-admission-order-')); t.after(() => rmSync(root, { recursive: true }));
  const args=['complete-postmigration','','','/current',root,'','','','','','/release'];
  const events=[];
  await assert.rejects(supervise('unused',args,{
    verifyEntrySources:()=>{}, completionService:()=>({InvocationID:'a'.repeat(32),ExecMainPID:'1234'}),
    checkCompletion:()=>{events.push('full-check');return {release:'/release'};},
    completionLaunchAdmission:(_args,_unit,phase)=>{events.push(`admission:${phase}`);throw Error('expired admission');},
    claimCompletion:()=>{events.push('claim');writeFileSync(join(root,'postmigration-completion-claimed'),'forbidden');},
    stopWriters:()=>{events.push('stop');return true;}, createServer:()=>{throw Error('no socket');},
  }),/expired admission/);
  assert.deepEqual(events,['full-check','admission:claim']);
  assert(!existsSync(join(root,'postmigration-completion-claimed')));
});

test('claim refuses an untrusted production entry without writing fixture state', t => {
  const root = mkdtempSync(join(tmpdir(), 'completion-claim-')); t.after(() => rmSync(root, { recursive: true }));
  assert.throws(() => claimCompletion(root, { owner: 'a'.repeat(32) }));
  assert(!existsSync(join(root, 'postmigration-completion-claimed')));
});

test('exact planner plus full verified id/checksum ledger and quiet activity required', t => {
  const root = mkdtempSync(join(tmpdir(), 'completion-ledger-')); t.after(() => rmSync(root, { recursive: true }));
  const dir = join(root, 'packages/database/src'); mkdirSync(join(dir, 'migrations'), { recursive: true });
  mkdirSync(join(root, 'node_modules/tsx/dist/esm'), { recursive: true });
  // Empty in-process fixture loader; native Node handles the JS-only .ts module.
  writeFileSync(join(root, 'node_modules/tsx/dist/esm/index.mjs'), '');
  const config = join(root, 'config'); writeFileSync(config, 'DATABASE_URL=postgres://fixture.invalid/unused\n');
  const rows = Array.from({ length: 110 }, (_, i) => {
    const id = `${String(i + 1).padStart(4, '0')}_migration.sql`, body = `SELECT ${i};\n`;
    writeFileSync(join(dir, 'migrations', id), body);
    return { id, checksum: createHash('sha256').update(body).digest('hex'), verification_state: 'verified' };
  });
  const plan = { readOnly: true, registryReadyWithoutWrites: true, applied: [], alreadyApplied: rows.map(r => r.id), pending: [] };
  const quiet = { readOnly: true, otherSessions: 0 };
  function source(change = {}) {
    writeFileSync(join(dir, 'migrate.ts'), `export function createMigrationSqlClient(){
      const sql=async()=>[{server_version_num:${JSON.stringify(change.version ?? '160006')}}];
      sql.begin=async(mode,fn)=>{if(mode!=='isolation level repeatable read read only')throw Error('not readonly');return fn(()=>${JSON.stringify(change.rows ?? rows)})};
      sql.end=async()=>{};return sql; }
      export async function planMigrations(){return ${JSON.stringify(change.plan ?? plan)}}
      export async function inspectMigrationQuiescence(){${change.quietError ? "throw Error('prepared or unsafe activity')" : `return ${JSON.stringify(change.quiet ?? quiet)}`}}`);
  }
  source(); assert.equal(verifyCompletionLedger(config, root).ledger.length, 110);
  for (const bad of [
    { rows: rows.slice(1) }, { rows: rows.map((r,i)=>i===109?{...r,checksum:'bad'}:r) },
    { rows: rows.map((r,i)=>i===0?{...r,verification_state:'legacy-unverified'}:r) },
    { rows: [...rows].reverse() }, { rows: [...rows, rows[0]] },
    { plan: {...plan,pending:[rows[109].id]} }, { plan: {...plan,registryReadyWithoutWrites:false} },
    { quiet: {...quiet,otherSessions:1} }, { quietError:true }, { version:'150001' },
  ]) { source(bad); assert.throws(()=>verifyCompletionLedger(config,root)); }
});

for (const fail of ['', 'provision']) test(`actual completion shell ${fail || 'success'} never migrates, backs up or starts directly`, t => {
  const root=mkdtempSync(join(tmpdir(),'completion-shell-'));t.after(()=>rmSync(root,{recursive:true}));
  const [legacy,releases,state,backups,systemd,config,bin,controls]=['legacy','releases','state','backups','systemd','config','bin','controls'].map(p=>join(root,p));
  for(const path of [legacy,releases,state,backups,systemd,config,bin,controls])mkdirSync(path);
  const target=join(releases,'e5-existing'), transition=join(state,'releases','20261110T081511-846613');
  mkdirSync(target);mkdirSync(transition,{recursive:true});mkdirSync(join(target,'infra/deploy'),{recursive:true});
  writeFileSync(join(legacy,'.env.production'),'fixture=true\n');
  writeFileSync(join(transition,'worker-required'),'1\n');
  for(const name of ['migration-armed','forward-armed','repair-adopted'])writeFileSync(join(transition,name),'original '+name);
  writeFileSync(join(state,'migration-forward-only'),'original guard');writeFileSync(join(state,'writers-fenced'),'original fence');
  const current=join(root,'current');symlinkSync(legacy,current);
  const helper=join(controls,'hermes-supervisor.mjs');writeFileSync(helper,'');writeFileSync(join(controls,'hermes-health.mjs'),'fixture');
  writeFileSync(join(controls,'hermes-writer-control.mjs'),readFileSync(resolve('infra/deploy/hermes-writer-control.mjs')));
  // Object-only synthetic UID seam, matching the existing trusted-entry fixture.
  writeFileSync(join(controls,'hermes-trusted-loader.py'),readFileSync(resolve('infra/deploy/hermes-trusted-loader.py'),'utf8').replaceAll('uid=0','uid=os.geteuid()'));
  writeFileSync(join(config,'.worker-provision.lock'),'',{mode:0o600});
  const log=join(root,'commands');writeFileSync(log,'');
  writeFileSync(join(bin,'node'),`#!/bin/bash\nprintf 'node %s\\n' "$*" >> "$MOCK_LOG"\nif [[ "$1" == --input-type=module ]]; then exec ${process.execPath} "$@"; fi\nif [[ "$2" == request ]]; then\n [[ "$3" != arm ]] || exit 90\n if [[ "$3" == prepare ]];then for u in aistudy-web.service aistudy-worker.service; do mkdir -p "$MOCK_SYSTEMD/$u.d";touch "$MOCK_SYSTEMD/$u.d/96-aistudy-writer-exec.conf";done;fi\n exit 0\nfi\n[[ "\${1##*/}" == runtime-identity.mjs || "$2" == quiescence || "$2" == parser || "$2" == parser-owned || "$1" == --input-type=module ]] || exit 91\n`,{mode:0o755});
  writeFileSync(join(bin,'systemctl'),'#!/bin/bash\nprintf "systemctl %s\\n" "$*" >> "$MOCK_LOG"\n[[ "$1" == daemon-reload || "$1" == is-active ]]\n',{mode:0o755});
  writeFileSync(join(bin,'curl'),'#!/bin/bash\nprintf \'{"status":"ok"}\'\n',{mode:0o755});
  writeFileSync(join(target,'infra/deploy/provision-worker.py'), 'import os,sys\nwith open(os.environ["MOCK_LOG"],"a") as log: log.write("provision\\n")\nsys.exit(1 if os.environ["MOCK_FAIL"] == "provision" else 0)\n');
  const result=spawnSync('bash',[resolve('infra/deploy/hermes-release.sh'),'complete-postmigration',legacy,releases,current,state,backups,systemd,config,'6291456','e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf',target,'a'.repeat(64),join(root,'retained.tar.gz')],{
    encoding:'utf8',env:{PATH:`${bin}:/usr/bin:/bin`,HERMES_SUPERVISOR_SOCKET:'/fixture/socket',HERMES_SUPERVISOR_HELPER:helper,MOCK_LOG:log,MOCK_SYSTEMD:systemd,MOCK_FAIL:fail},
  });
  assert.equal(result.status,fail?1:0,result.stdout+result.stderr);
  const events=readFileSync(log,'utf8');
  assert(!events.includes(' backup ')&&!events.includes(' migrate ')&&!events.includes('systemctl start'));
  assert(!existsSync(join(transition,'migration-succeeded')));
  for(const name of ['migration-armed','forward-armed','repair-adopted'])assert.equal(readFileSync(join(transition,name),'utf8'),'original '+name);
  assert.equal(readFileSync(join(state,'migration-forward-only'),'utf8'),'original guard');
  if(fail){assert.match(events,/request refence/);assert.match(events,/request stop/);}
  else {assert.match(events,/request prepare/);assert.match(events,/request activate/);assert.match(events,/request success/);}
});

test('completion launch submits a single bounded service and retains controls on unknown ACK', () => {
  const args=['complete-postmigration','/legacy','/releases','/current','/state','/backups','/systemd','/config','6291456','a'.repeat(40),'/release','b'.repeat(64),'/archive'];
  for (const fault of ['', 'existing', 'reload', 'start']) {
    const events=[];
    const run = argv => {
      events.push(argv);
      if(argv[0]==='show')return {ok:true,stdout:`LoadState=${fault==='existing'?'loaded':'not-found'}\n`};
      return {ok:argv[0]!==fault && !(fault==='reload' && argv[0]==='daemon-reload'),stdout:''};
    };
    const launch=()=>launchCompletion('/trusted/hermes-release.sh',args,{root:'/trusted',node:'/usr/bin/node',run,admission:()=>{},write:(path,text)=>{events.push(['write',path]);assert.match(text,/ExecStopPost=/);}});
    if(fault)assert.throws(launch);else assert.equal(launch().submitted,true);
    assert.equal(events.filter(v=>v[0]==='start').length,['','start'].includes(fault)?1:0);
    assert(!events.some(v=>['stop','restart','reset-failed'].includes(v[0])));
  }
});

test('completion admission denial is zero-mutation, and final claim race cannot start', () => {
  const args=['complete-postmigration','/legacy','/releases','/current','/state','/backups','/systemd','/config','6291456','a'.repeat(40),'/release','b'.repeat(64),'/archive'];
  for (const boundary of ['absent', 'ready']) {
    const events=[];
    const run=argv=>{events.push(argv[0]);return {ok:true,stdout:argv[0]==='show'?'LoadState=not-found\n':''};};
    const admission=(_args,_unit,phase)=>{if(phase===boundary)throw Error('claim or evidence changed');};
    assert.throws(()=>launchCompletion('/trusted/hermes-release.sh',args,{root:'/trusted',node:'/usr/bin/node',run,admission,write:()=>events.push('write')}));
    assert(!events.includes('start'));
    if(boundary==='absent')assert.deepEqual(events,[]);
    else assert.deepEqual(events,['daemon-reload','show','write','daemon-reload']);
  }
});

test('reviewed parser control sets dontwritebytecode even against configured override', t => {
  const root=mkdtempSync(join(tmpdir(),'completion-parser-env-'));t.after(()=>rmSync(root,{recursive:true}));
  const target=join(root,'release');mkdirSync(join(target,'services/parser'),{recursive:true});
  const config=join(root,'config');writeFileSync(config,'PYTHONDONTWRITEBYTECODE=0\n');
  const capture=join(root,'environment');
  const python=join(root,'python');writeFileSync(python,`#!/bin/bash\nprintf '%s' "$PYTHONDONTWRITEBYTECODE" > ${JSON.stringify(capture)}\n`,{mode:0o755});
  const result=spawnSync(process.execPath,[resolve('infra/deploy/hermes-db.mjs'),'parser',config,target,python,root],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(capture,'utf8'),'1');
});

test('completion caller rejects Pi before Git, SSH, staging or manager access', () => {
  const result=spawnSync('bash',[resolve('infra/deploy/deploy-hermes.sh'),'complete-postmigration'],{encoding:'utf8',env:{PATH:process.env.PATH,PI_CODING_AGENT:'true'}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/outside Pi/);
});

test('actual caller check and launch transport carry exact independent arguments, never download payload', t => {
  const root=mkdtempSync(join(tmpdir(),'completion-caller-'));t.after(()=>rmSync(root,{recursive:true}));
  const bin=join(root,'bin');mkdirSync(bin);
  const log=join(root,'events'),stdin=join(root,'intake');
  const sha='f'.repeat(40),source=resolve('.');
  const git=`#!/bin/bash\nprintf 'git %s\\n' "$*" >> "$LOG"\ncase "$*" in\n 'rev-parse HEAD') echo ${sha};;\n 'rev-parse --show-toplevel') echo ${source};;\n 'status --porcelain') ;;\n 'remote get-url study-assistant-opening') echo https://github.com/Xhhemoing/study-assistant-opening;;\n 'ls-remote study-assistant-opening refs/heads/feat/opening-release') printf '${sha}\\trefs/heads/feat/opening-release\\n';;\n 'merge-base --is-ancestor '*) ;;\n 'log --format= -m --name-only '*) ;;\n 'diff --quiet '*) ;;\n *' archive '*) for arg in "$@";do if [[ "$arg" == --output=* ]];then printf 'fixture-committed-git-controls' > "\${arg#--output=}";fi;done;;\n *) exit 90;;\nesac\n`;
  writeFileSync(join(bin,'git'),git,{mode:0o755});
  writeFileSync(join(bin,'gh'),`#!/bin/bash\nprintf '%s' '{"workflow_runs":[{"head_sha":"${sha}","head_branch":"feat/opening-release","event":"push","id":123,"status":"completed","conclusion":"success","html_url":"https://github.com/Xhhemoing/study-assistant-opening/actions/runs/123"}]}'\n`,{mode:0o755});
  writeFileSync(join(bin,'ssh'),'#!/bin/bash\nprintf "ssh %s\\n" "$*" >> "$LOG"\n/bin/cat > "$INTAKE"\n',{mode:0o755});
  const env={PATH:`${bin}:${process.env.PATH}`,LOG:log,INTAKE:stdin,HOST:'fixture.invalid',COMPLETION_SCOPE:'20261110T081511-846613',COMPLETION_RELEASE:'/opt/aistudy-releases/e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf-existing',COMPLETION_ARCHIVE:'/tmp/retained/release.tar.gz',COMPLETION_CONFIRM:'complete-20261110T081511-846613-existing-e5'};
  for(const action of ['complete-postmigration-check','complete-postmigration','complete-postmigration-reload-sample','complete-postmigration-archive-retained']) {
    writeFileSync(log,'');
    const result=spawnSync('bash',[resolve('infra/deploy/deploy-hermes.sh'),action],{encoding:'utf8',env});
    assert.equal(result.status,0,result.stderr);
    const events=readFileSync(log,'utf8');
    assert(!events.includes('download')&&!events.includes('scp '));
    assert.match(events,/StrictHostKeyChecking=yes/);
    if(action.endsWith('-check')) {
      assert.match(events,/timeout --signal=KILL 2700s \/usr\/bin\/python3/);
      assert.match(events,/'\/opt\/aistudy-deployment' '\/opt\/aistudy-current' '\/etc\/systemd\/system'/);
      assert.match(readFileSync(stdin,'utf8'),/readonlyProbe/);
    } else {
      const mode = action.endsWith('-reload-sample') ? 'completion-reload-samples'
        : action.endsWith('-archive-retained') ? 'completion-retained-archive' : 'completion-launch';
      assert(events.includes(mode));
      assert.match(events,/extract-git/);
      assert.match(events,/4136bafe71484359263128af46d8ddadfe7e9e0227a0976d3f3858f3b9d2b0a0/);
      assert.equal(readFileSync(stdin,'utf8'),'fixture-committed-git-controls');
    }
  }
});

test('actual Git archive controls intake validates inventory before extraction', t => {
  const root=mkdtempSync(join(tmpdir(),'completion-git-entry-'));t.after(()=>rmSync(root,{recursive:true}));
  const names=['hermes-release.sh','hermes-supervisor.mjs','hermes-config-durability.mjs','hermes-db.mjs','hermes-health.mjs','hermes-writer-control.mjs','hermes-trusted-loader.py','hermes-writer-state.py','hermes-writer-exec.py','hermes-peer-broker.py'];
  const archive=spawnSync('git',['-c','tar.umask=0022','archive','--format=tar.gz','HEAD',...names.map(n=>'infra/deploy/'+n)],
    { cwd: resolve('.'), env: cleanGitEnvironment() });
  assert.equal(archive.status,0);
  const code=`import importlib.util,io,os,sys\ns=importlib.util.spec_from_file_location('entry',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.extract(io.BytesIO(sys.stdin.buffer.read()),sys.argv[2],uid=os.geteuid(),git_controls=True)`;
  const result=spawnSync('python3',['-I','-S','-B','-c',code,resolve('infra/deploy/hermes-entry.py'),root],{input:archive.stdout});
  assert.equal(result.status,0,result.stderr?.toString());
  for(const name of names)assert(existsSync(join(root,name)));
  const invalid=join(root,'invalid');mkdirSync(invalid,{mode:0o700});
  const reject=spawnSync('python3',['-I','-S','-B','-c',code,resolve('infra/deploy/hermes-entry.py'),invalid],{input:Buffer.alloc(1048577)});
  assert.notEqual(reject.status,0);
  assert(!existsSync(join(invalid,names[0])));
});

test('candidate readonly stdin generator syntax and source hashes are reproducible', () => {
  const generator = resolve('tests/tooling/hermes-completion-precheck.mjs');
  const generated = spawnSync(process.execPath, [generator], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const parsed = spawnSync('python3', ['-I','-S','-B','-c','import ast,sys; ast.parse(sys.stdin.read())'], { input: generated.stdout, encoding:'utf8' });
  assert.equal(parsed.status,0,parsed.stderr);
  const exercised = spawnSync('python3',['-I','-S','-B',resolve('tests/tooling/hermes_postmigration_completion_test.py'),'--generated-check'],{input:generated.stdout,encoding:'utf8'});
  assert.equal(exercised.status,0,exercised.stdout+exercised.stderr);
  const hashes = spawnSync(process.execPath,[generator,'--hashes'],{encoding:'utf8'});
  assert.equal(hashes.status,0,hashes.stderr);
  assert(hashes.stdout.includes(createHash('sha256').update(generated.stdout).digest('hex')));
});
