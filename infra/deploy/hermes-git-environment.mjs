// Git routing is never inherited from another repository. Explicit source roots
// are selected by cwd/-C, not a caller's gitdir/index/object/config variables.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let privateHome;
function gitHome() {
  if (!privateHome) {
    privateHome=mkdtempSync(join(tmpdir(),'sm95-git-home-'));
    mkdirSync(join(privateHome,'xdg'),{mode:0o700});
    process.once('exit',()=>rmSync(privateHome,{recursive:true,force:true}));
  }
  return privateHome;
}
export function cleanGitEnvironment(environment = process.env) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('GIT_'))),
    HOME:gitHome(), XDG_CONFIG_HOME:join(gitHome(),'xdg'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TEMPLATE_DIR: '', GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'core.hooksPath', GIT_CONFIG_VALUE_0:'/dev/null' };
}
