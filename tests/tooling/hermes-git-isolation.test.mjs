import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { gitFixture, cleanGitEnvironment } from './hermes-git-fixture.mjs';

function metadata(root) {
  const snapshot = {};
  function walk(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path=join(directory,item.name);
      if(item.isDirectory()) walk(path);
      else snapshot[path.slice(root.length)]=readFileSync(path).toString('base64');
    }
  }
  walk(join(root,'.git'));
  return snapshot;
}

test('all real Git entry families preserve hostile caller metadata across Bash imported tooling clone and Python CLI', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-all-git-'));t.after(()=>rmSync(root,{recursive:true}));
  const caller=join(root,'caller');mkdirSync(caller);
  const source=gitFixture(caller);writeFileSync(join(caller,'caller'),'must remain');source.run('add','caller');
  source.run('-c','user.name=Caller','-c','user.email=caller@example.test','commit','-m','caller');
  const before=metadata(caller), hostile={...process.env,GIT_DIR:join(caller,'.git'),GIT_COMMON_DIR:join(caller,'.git'),
    GIT_WORK_TREE:caller,GIT_INDEX_FILE:join(caller,'.git/index'),GIT_OBJECT_DIRECTORY:join(caller,'.git/objects'),
    GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.worktree',GIT_CONFIG_VALUE_0:caller,HOME:join(root,'hostile-home'),XDG_CONFIG_HOME:join(root,'hostile-xdg')};
  const runs=[
    [process.execPath,['--test','tests/tooling/hermes-pre-migration-repair.test.mjs','tests/tooling/release-artifact.test.mjs','scripts/check-new-fixed-colors.test.mjs']],
    [process.execPath,['--test','--test-name-pattern=deploy prepares a separate release|deployment extra overrides','tests/tooling/hermes-deployment.test.mjs']],
    ['/usr/bin/python3',['-B','-m','unittest','discover','-s','scripts/ci','-p','test_checks.py']],
  ];
  for(const [command,args] of runs){
    const result=spawnSync(command,args,{cwd:resolve('.'),env:hostile,encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024});
    assert.deepEqual(metadata(caller),before,`caller drift from ${args.join(' ')}`);
    assert.equal(result.status,0,result.stdout+result.stderr);
  }
});

test('hostile caller Git routing cannot mutate caller HEAD refs index config or objects', t => {
  const root=mkdtempSync(join(tmpdir(),'sm95-git-isolation-'));t.after(()=>rmSync(root,{recursive:true}));
  const caller=join(root,'caller'), fixture=join(root,'fixture');mkdirSync(caller);mkdirSync(fixture);
  const original=gitFixture(caller);
  writeFileSync(join(caller,'caller'),'must remain');original.run('add','caller');
  original.run('-c','user.name=Caller','-c','user.email=caller@example.test','commit','-m','caller');
  const before=metadata(caller);
  const hostile={...process.env,GIT_DIR:join(caller,'.git'),GIT_COMMON_DIR:join(caller,'.git'),
    GIT_WORK_TREE:caller,GIT_INDEX_FILE:join(caller,'.git/index'),GIT_OBJECT_DIRECTORY:join(caller,'.git/objects'),
    GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.worktree',GIT_CONFIG_VALUE_0:caller};
  const isolated=gitFixture(fixture,hostile);
  writeFileSync(join(fixture,'fixture'),'private fixture');isolated.run('add','fixture');
  isolated.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture');
  isolated.run('checkout','-b','private-fixture-branch');
  isolated.run('config','tar.umask','0000');
  assert.deepEqual(metadata(caller),before);
  assert.equal(original.run('show','HEAD:caller'),'must remain');
  assert.equal(isolated.run('show','HEAD:fixture'),'private fixture');
  assert.deepEqual(Object.keys(cleanGitEnvironment(hostile)).filter(name=>name.startsWith('GIT_')).sort(),
    ['GIT_CONFIG_COUNT','GIT_CONFIG_GLOBAL','GIT_CONFIG_KEY_0','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_SYSTEM','GIT_CONFIG_VALUE_0','GIT_TEMPLATE_DIR']);
});
