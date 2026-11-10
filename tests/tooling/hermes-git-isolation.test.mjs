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
    [process.execPath,['--test','--test-name-pattern=Git parent admission|reviewed control archive strips|pack uses committed source|compares a real commit','tests/tooling/hermes-pre-migration-repair.test.mjs','tests/tooling/release-artifact.test.mjs','scripts/check-new-fixed-colors.test.mjs']],
    [process.execPath,['--test','--test-name-pattern=deploy prepares a separate release|deployment extra overrides','tests/tooling/hermes-deployment.test.mjs']],
    ['/usr/bin/python3',['-B','-m','unittest','discover','-s','scripts/ci','-p','test_checks.py']],
  ];
  for(const [command,args] of runs){
    // Nested --test otherwise inherits NODE_TEST_CONTEXT and may silently
    // discover zero suites while exiting 0. Clear harness routing, not Git
    // poison: the latter must still reach every entry under test.
    const runnerEnv=Object.fromEntries(Object.entries(hostile).filter(([key])=>!key.startsWith('NODE_TEST_') && !['NODE_OPTIONS','NODE_V8_COVERAGE'].includes(key)));
    const result=spawnSync(command,args,{cwd:resolve('.'),env:runnerEnv,encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024});
    assert.deepEqual(metadata(caller),before,`caller drift from ${args.join(' ')}`);
    assert.equal(result.status,0,result.stdout+result.stderr);
    if(command===process.execPath){
      const expected=args.some(value=>value.includes('hermes-deployment.test'))
        ? ['deploy prepares a separate release','deployment extra overrides']
        : ['Git parent admission','reviewed control archive strips','pack uses committed source','compares a real commit'];
      for(const name of expected)assert(result.stdout.includes(name),`nested runner did not execute ${name}: ${result.stdout}`);
      const count=Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]);
      assert.equal(count,expected.length,result.stdout);
      assert.match(result.stdout,/^# skipped 0$/m);
      assert.match(result.stdout,/^# fail 0$/m);
      assert(!/^not ok|# SKIP/m.test(result.stdout));
      t.diagnostic(`Executed nested Git tests: ${expected.join('; ')}; count=${count}; skip=0`);
    }else{
      assert.match(result.stderr,/Ran 21 tests/);
      assert.match(result.stderr,/\nOK\s*$/);
      assert(!/skipped=/i.test(result.stderr));
      t.diagnostic('Executed Python CI fixture/CLI: 21 tests; skip=0');
    }
  }
});

test('reviewed deploy shell Git boundary selects cwd and leaves hostile caller metadata unchanged',t=>{
  const root=mkdtempSync(join(tmpdir(),'sm95-shell-git-'));t.after(()=>rmSync(root,{recursive:true}));
  const caller=join(root,'caller'),target=join(root,'target');mkdirSync(caller);mkdirSync(target);
  const a=gitFixture(caller), b=gitFixture(target);
  for(const [repo,git,name] of [[caller,a,'caller'],[target,b,'target']]){
    writeFileSync(join(repo,name),name);git.run('add',name);
    git.run('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m',name);
  }
  const before=metadata(caller), expected=b.run('rev-parse','HEAD');
  const source=readFileSync(resolve('infra/deploy/deploy-hermes.sh'),'utf8');
  const start=source.indexOf('git() (');const end=source.indexOf('\nfail()',start);
  const r=spawnSync('bash',['-c',source.slice(start,end)+'\ngit rev-parse HEAD'],{cwd:target,encoding:'utf8',env:{...process.env,GIT_DIR:join(caller,'.git'),GIT_WORK_TREE:caller,GIT_INDEX_FILE:join(caller,'.git/index'),GIT_COMMON_DIR:join(caller,'.git'),GIT_OBJECT_DIRECTORY:join(caller,'.git/objects')}});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),expected);
  assert.deepEqual(metadata(caller),before);
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
