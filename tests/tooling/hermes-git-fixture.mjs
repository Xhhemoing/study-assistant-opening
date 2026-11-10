// Test-only Git routing. Never allow a caller's repository/index/config/object
// environment to redirect fixture writes outside the private temporary root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')));
}

export function gitFixture(root, inherited = process.env) {
  root = resolve(root);
  const env = { ...cleanGitEnvironment(inherited),
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
