import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { supervise } from '../../infra/deploy/hermes-supervisor.mjs';
import { verifySources } from './hermes-entry-fixture.mjs';
const source = resolve('infra/deploy');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-entry-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controls = join(root, 'entry'); mkdirSync(controls, { mode: 0o700 });
  for (const name of readdirSync(source)) if (/\.(mjs|py|sh)$/.test(name)) {
    copyFileSync(join(source, name), join(controls, name)); chmodSync(join(controls, name), 0o600);
  }
  const args = ['deploy', join(root, 'legacy'), join(root, 'releases'), join(root, 'current'), join(root, 'state'), join(root, 'backups'), join(root, 'systemd'), join(root, 'config'), '1', 'a'.repeat(40), 'archive'];
  return { root, controls, args };
}
for (const action of ['deploy', 'restart', 'rollback']) for (const defect of ['bad-directory', 'missing', 'symlink', 'hardlink', 'writable', 'owner']) {
  test(`${action} ${defect} entry refuses before any owner/manager/state/backend event`, async t => {
    const f = fixture(t); f.args[0] = action;
    const file = join(f.controls, 'hermes-writer-state.py');
    const marker = join(f.root, 'sibling-executed');
    // Even valid inventory must never execute sibling top-level code in verify.
    writeFileSync(join(f.controls, 'hermes-peer-broker.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
    if (defect === 'bad-directory') chmodSync(f.controls, 0o770);
    if (defect === 'missing') unlinkSync(file);
    if (defect === 'symlink' || defect === 'hardlink') {
      unlinkSync(file);
      const anchor = join(f.root, 'anchor'); writeFileSync(anchor, 'not executable');
      if (defect === 'symlink') symlinkSync(anchor, file); else linkSync(anchor, file);
    }
    if (defect === 'writable') chmodSync(file, 0o620);
    const events = [];
    const forbidden = name => () => { events.push(name); throw new Error(`Forbidden ${name}`); };
    await assert.rejects(supervise(join(f.controls, 'hermes-release.sh'), f.args, {
      verifyEntrySources: () => {
        events.push('verify');
        if (defect === 'owner') {
          // Actual production UID0 check, no object seam.
          const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', join(f.controls, 'hermes-trusted-loader.py'), 'verify']);
          assert.notEqual(result.status, 0); throw new Error('preflight refused');
        }
        verifySources(f.controls);
      },
      createServer: forbidden('state/socket'), spawn: forbidden('owner/migrate/backup'),
      command: forbidden('manager/config'), stopWriters: forbidden('stop'),
      boundedQuiescence: forbidden('backend'), captureConfiguration: forbidden('config'),
    }), /preflight refused/);
    assert.deepEqual(events, ['verify']);
    assert(!existsSync(marker)); assert(!existsSync(f.args[4]));
    assert(!existsSync(f.args[3])); assert(!existsSync(f.args[6]));
  });
}
test('good object-UID entry verifies without sibling execution before first socket/owner event', async t => {
  const f = fixture(t), events = [];
  const marker = join(f.root, 'executed');
  for (const name of ['hermes-writer-state.py', 'hermes-writer-exec.py', 'hermes-peer-broker.py']) {
    writeFileSync(join(f.controls, name), `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\nraise RuntimeError('must not execute')\n`);
  }
  await assert.rejects(supervise('unused-owner', f.args, {
    verifyEntrySources: () => { verifySources(f.controls); events.push('verified'); },
    createServer: () => { events.push('first-socket'); throw new Error('test boundary'); },
  }), /test boundary/);
  assert.deepEqual(events, ['verified', 'first-socket']);
  assert(!existsSync(marker)); assert(!existsSync(f.args[4]));
});
for (const mode of ['run', 'owned']) test(`production ${mode} rejects UID1000 before persistent state, even existing fences`, t => {
  if (process.getuid() === 0) { t.skip('requires unprivileged fixture owner'); return; }
  const f = fixture(t);
  for (const existing of [false, true]) {
    if (existing) {
      mkdirSync(f.args[4], { mode: 0o750 });
      writeFileSync(join(f.args[4], 'writers-fenced'), 'unchanged');
    }
    const result = spawnSync(process.execPath, [join(f.controls, 'hermes-supervisor.mjs'), mode, join(f.controls, 'hermes-release.sh'), ...f.args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /source preflight refused/);
    if (existing) {
      assert.deepEqual(readdirSync(f.args[4]), ['writers-fenced']);
      assert.equal(statSync(f.args[4]).mode & 0o777, 0o750);
      assert.equal(readFileSync(join(f.args[4], 'writers-fenced'), 'utf8'), 'unchanged');
    } else assert(!existsSync(f.args[4]));
  }
});
