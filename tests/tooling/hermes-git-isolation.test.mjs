import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  assert(!Object.keys(cleanGitEnvironment(hostile)).some(name=>name.startsWith('GIT_')));
});
