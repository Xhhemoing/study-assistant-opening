// Test-only Git routing. Never allow a caller's repository/index/config/object
// environment to redirect fixture writes outside the private temporary root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { cleanGitEnvironment } from '../../infra/deploy/hermes-git-environment.mjs';
export { cleanGitEnvironment } from '../../infra/deploy/hermes-git-environment.mjs';

export function gitFixture(root, inherited = process.env) {
  root = resolve(root);
  const home=join(root,'.fixture-home'), templates=join(home,'templates'), hooks=join(home,'hooks');
  for(const directory of [home,templates,hooks]) mkdirSync(directory,{recursive:true,mode:0o700});
  const env = { ...cleanGitEnvironment(inherited), HOME:home, XDG_CONFIG_HOME:join(home,'xdg'),
    GIT_TEMPLATE_DIR:templates, GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'core.hooksPath', GIT_CONFIG_VALUE_0:hooks,
    GIT_DIR: join(root, '.git'), GIT_WORK_TREE: root, GIT_INDEX_FILE: join(root, '.git/index'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const run = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run('init');
  assert.equal(run('rev-parse', '--absolute-git-dir'), join(root, '.git'));
  assert.equal(run('rev-parse', '--show-toplevel'), root);
  return { run, env, root };
}
