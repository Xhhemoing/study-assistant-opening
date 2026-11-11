import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {gitFixture} from './hermes-git-fixture.mjs';

test('actual completion tail preserves thirteen args ACK and diagnostics with action failure priority',()=>{
  const source=readFileSync(resolve('infra/deploy/deploy-hermes.sh'),'utf8');
  const start=source.indexOf('    mode=completion-launch'),end=source.indexOf('    ssh_run "$remote_command" < "$control_archive"',start);
  assert(start>0&&end>start);
  const builder=source.slice(start,end);
  const helper=readFileSync(resolve('infra/deploy/pm-capture-readonly.py'),'utf8');
  for(const [action,mode,stage] of [
    ['complete-postmigration-reload-sample','completion-reload-samples','A'],
    ['complete-postmigration-archive-retained','completion-retained-archive','B'],
    ['complete-postmigration','completion-launch','C'],
    ['complete-postmigration-postarchive-reload-sample','completion-postarchive-reload-samples','A'],
    ['complete-postmigration-postarchive','completion-postarchive-launch','C'],
  ]) for(const actionExit of [0,77]) for(const captureExit of [0,2]){
    const variables={ACTION:action,SCRIPT_DIR:resolve('infra/deploy'),DIR:'/legacy',RELEASES_DIR:'/releases',CURRENT_LINK:'/current',DEPLOY_STATE:'/state',BACKUP_DIR:'/backups',SYSTEMD_DIR:'/systemd',WORKER_CONFIG_DIR:'/etc/aistudy',MIN_FREE_KB:'6291456',COMPLETION_RELEASE:'/release',COMPLETION_ARCHIVE:'/archive'};
    const expected=[mode,'/tmp/aistudy-entry.ABCDEFGH/hermes-release.sh','complete-postmigration','/legacy','/releases','/current','/state','/backups','/systemd','/etc/aistudy','6291456','e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf','/release','4136bafe71484359263128af46d8ddadfe7e9e0227a0976d3f3858f3b9d2b0a0','/archive'];
    const program=`quote() { printf "'%s'" "\${1//\\'/\\'\\\\\\'\\'}"; }\nremote_command=''\n${builder}\nprintf '%s' "$remote_command"`;
    const built=spawnSync('/bin/bash',['-c',program],{env:variables,encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    // Execute the EXACT generated shell tail locally, with only its two
    // executables replaced by purefake sinks; no SSH/manager/helper I/O.
    const observed=[];
    const prefix=`entry=/tmp/aistudy-entry.ABCDEFGH\nnode() { printf '%s\\0' "$@" >&3; printf 'ORIGINAL-ACK\\n'; printf 'original diagnostic without newline' >&2; return ${actionExit}; }\ncapture_python() { printf '%s\\0' "$@" >&3; printf 'synthetic-capture'; return ${captureExit}; }\n`;
    const result=spawnSync('/bin/bash',['-c',prefix+built.stdout.replace('/usr/bin/python3','capture_python')],{encoding:'utf8',stdio:['ignore','pipe','pipe','pipe']});
    assert.equal(result.status,actionExit||captureExit,result.stderr);
    assert.equal(result.stdout,'ORIGINAL-ACK\n');assert(result.stderr.startsWith('original diagnostic without newline'));
    observed.push(...result.output[3].split('\0').filter(Boolean));
    assert.deepEqual(observed.slice(0,16),['/tmp/aistudy-entry.ABCDEFGH/hermes-supervisor.mjs',...expected]);
    const selector=action.startsWith('complete-postmigration-postarchive')?['--sample-phase','postarchive']:[];
    assert.deepEqual(observed.slice(16),['-I','-S','-B','-c',helper,'target','--stage',stage,'--entry','/tmp/aistudy-entry.ABCDEFGH','--state','/state',...selector]);
  }
});

test('unreadable producer prevents action-tail construction instead of masking cat failure',t=>{
  const root=mkdtempSync(join(tmpdir(),'pm-missing-producer-'));t.after(()=>rmSync(root,{recursive:true}));
  const source=readFileSync(resolve('infra/deploy/deploy-hermes.sh'),'utf8');
  const start=source.indexOf('    mode=completion-launch'),end=source.indexOf('    ssh_run "$remote_command" < "$control_archive"',start);
  const variables={ACTION:'complete-postmigration',SCRIPT_DIR:root,DIR:'/legacy',RELEASES_DIR:'/releases',CURRENT_LINK:'/current',DEPLOY_STATE:'/state',BACKUP_DIR:'/backups',SYSTEMD_DIR:'/systemd',WORKER_CONFIG_DIR:'/etc/aistudy',MIN_FREE_KB:'6291456',COMPLETION_RELEASE:'/release',COMPLETION_ARCHIVE:'/archive'};
  const built=spawnSync('/bin/bash',['-c',`set -euo pipefail; quote() { printf "'%s'" "$1"; }; remote_command=''; ${source.slice(start,end)}\nprintf 'UNEXPECTED'`],{env:variables,encoding:'utf8'});
  assert.notEqual(built.status,0);assert(!built.stdout.includes('UNEXPECTED'));
});

// Only private Git fixtures; no actual caller ref/config/objects are routed here.
test('PM capture ancestry admits only named completion helper and tests, never repair or adjacent paths',t=>{
  const root=mkdtempSync(join(tmpdir(),'pm-capture-ancestry-'));t.after(()=>rmSync(root,{recursive:true}));
  const isolated=gitFixture(root),git=isolated.run;
  writeFileSync(join(root,'baseline'),'fixture');git('add','baseline');
  const commit=()=>git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-am','fixture');
  commit();const baseline=git('rev-parse','HEAD');
  const script=readFileSync(resolve('infra/deploy/deploy-hermes.sh'),'utf8');
  const checkCode=script.slice(script.indexOf('verify_repair_git() {'),script.indexOf('# Execute reviewed Python bytes'))
    .replace('6afaaa70d3467da4f17daaad44a99e2d36b9f991',baseline);
  const check=action=>spawnSync('/bin/bash',['-c',`set -euo pipefail; fail() { echo "$*" >&2; exit 1; }; ${checkCode}\nverify_repair_git`],{
    cwd:root,env:{...isolated.env,ACTION:action,COMMIT:git('rev-parse','HEAD'),SCRIPT_DIR:join(root,'infra/deploy'),repository:'Xhhemoing/study-assistant-opening'},encoding:'utf8',
  });
  const paths=['infra/deploy/pm-capture-readonly.py','tests/tooling/hermes-pm-capture.test.mjs','tests/tooling/hermes_pm_capture_test.py'];
  for(const name of paths){mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),'fixture');git('add',name);}
  commit();const admitted=git('rev-parse','HEAD');
  for(const action of ['complete-postmigration-check','complete-postmigration-reload-sample','complete-postmigration-archive-retained','complete-postmigration']){
    const r=check(action);assert.equal(r.status,0,r.stderr);
  }
  const repair=check('repair-pre-migration');assert.notEqual(repair.status,0);assert.match(repair.stderr,/completion-only/);
  for(const [i,name] of ['infra/deploy/pm-capture-extra.py','infra/deploy/anything.py','scripts/pm-capture-readonly.py','apps/web/capture.ts'].entries()){
    git('checkout','-b',`outside-${i}`,admitted);mkdirSync(join(root,name,'..'),{recursive:true});writeFileSync(join(root,name),'unreviewed');git('add',name);commit();
    const r=check('complete-postmigration');assert.notEqual(r.status,0);assert.match(r.stderr,/outside the reviewed control/);
  }
});
