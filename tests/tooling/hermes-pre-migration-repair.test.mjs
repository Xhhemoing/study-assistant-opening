import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkRepair, validateRepairPlan, verifyRepairLedger } from '../../infra/deploy/hermes-writer-control.mjs';
import { supervise } from '../../infra/deploy/hermes-supervisor.mjs';
import { fixture, units } from './hermes-supervisor-fixture.mjs';

test('incident eligibility Python cases run in the selected tooling suite', () => {
  const result = spawnSync('python3', ['-I', '-S', '-B', resolve('tests/tooling/hermes_pre_migration_repair_test.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('actual repair-check shell-generated code loads the trusted dependency inventory in memory', () => {
  const script = readFileSync(resolve('infra/deploy/deploy-hermes.sh'), 'utf8');
  const entry = script.slice(script.indexOf('if [[ "$ACTION" == repair-check ]]'), script.indexOf("remote_archive=''"));
  // Run the production shell generator, not a copied Python entry. Stub only
  // release/network gates; the generated code is executed locally below.
  const generated = spawnSync('bash', ['-c', `set -euo pipefail
verify_release() { :; }
verify_repair_git() { :; }
fail() { echo "$*" >&2; exit 1; }
${script.split('\n').find(line => line.startsWith('quote()'))}
ssh_run() {
  python3 -I -S -B -c 'import shlex,sys; args=shlex.split(sys.argv[1]); assert args[:5] == ["/usr/bin/python3", "-I", "-S", "-B", "-c"]; assert args[6:] == ["/fixture/state", "/fixture/current", "/fixture/systemd"]; print(args[5], end="")' "$1"
}
${entry}`], {
    encoding: 'utf8', env: { ...process.env, ACTION: 'repair-check', EXPLICIT_HOST: 'fixture.invalid',
      SCRIPT_DIR: resolve('infra/deploy'), DEPLOY_STATE: '/fixture/state', CURRENT_LINK: '/fixture/current', SYSTEMD_DIR: '/fixture/systemd' },
  });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  assert(generated.stdout.length > 0);
  const checked = spawnSync('python3', ['-I', '-S', '-B', resolve('tests/tooling/hermes_pre_migration_repair_test.py'), '--generated-check'], {
    encoding: 'utf8', input: generated.stdout,
  });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

const inventory = Array.from({ length: 110 }, (_, i) => `${String(i + 1).padStart(4, '0')}_migration.sql`);
const valid = () => ({ readOnly: true, registryReadyWithoutWrites: true, applied: [], alreadyApplied: inventory.slice(0, 107), pending: inventory.slice(107) });
test('repair accepts only exact contiguous ledger 107 and pending 108/109/110', () => {
  validateRepairPlan(valid(), inventory);
  for (const change of [p => p.pending.pop(), p => p.alreadyApplied.pop(), p => p.applied.push(inventory[107]),
    p => p.registryReadyWithoutWrites = false, p => p.readOnly = false,
    p => p.alreadyApplied.reverse(), p => p.pending.reverse()]) {
    const plan = valid(); change(plan); assert.throws(() => validateRepairPlan(plan, inventory));
  }
  assert.throws(() => validateRepairPlan(valid(), [...inventory, '0111_other.sql']));
});

test('verified ledger observation uses an actual read-only transaction and rejects unverified or advanced history', t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-ledger-')); t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, 'packages/database/src'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  const config = join(root, 'config'); writeFileSync(config, 'DATABASE_URL=postgres://fixture.invalid/unused\n');
  // Avoid environment/CLI seams in production: only this isolated executable
  // reads fixture rows and evaluates the exact production-generated transaction.
  writeFileSync(join(root, 'node_modules/.bin/tsx'), `#!/usr/bin/env node
    (async () => { await eval(process.argv[3]); })().catch(() => { process.exitCode = 1; });
  `, { mode: 0o755 });
  const module = join(root, 'packages/database/src/migrate.ts');
  const source = rows => `export function createMigrationSqlClient(url) {
    if (url !== 'postgres://fixture.invalid/unused') throw Error('wrong target');
    return { begin: async (mode, fn) => { if (mode !== 'isolation level repeatable read read only') throw Error('write transaction');
      return fn(() => ${JSON.stringify(rows)}); }, end: async () => {} };
  }`;
  const rows = inventory.slice(0, 107).map(id => ({ id, verification_state: 'verified' }));
  writeFileSync(module, source(rows)); assert.doesNotThrow(() => verifyRepairLedger(config, root));
  rows[0].verification_state = 'legacy-unverified'; writeFileSync(module, source(rows));
  assert.throws(() => verifyRepairLedger(config, root));
  rows[0].verification_state = 'verified'; rows.push({ id: inventory[107], verification_state: 'verified' });
  writeFileSync(module, source(rows)); assert.throws(() => verifyRepairLedger(config, root));
});

test('ineligible repair is an early rejection, not a crash fence or spawned owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-reject-')); t.after(() => rmSync(root, { recursive: true }));
  const incident = join(root, 'migration-forward-only'); writeFileSync(incident, 'original incident');
  const args = ['repair-pre-migration', root, root, root, root, root, root, root, '1', 'a'.repeat(40), ''];
  const forbidden = () => { assert.fail('Rejection performed a side effect'); };
  await assert.rejects(supervise('unused', args, { verifyEntrySources() {}, checkRepair() { throw new Error('ineligible'); },
    command: forbidden, stopWriters: forbidden, spawn: forbidden, createServer: forbidden }), /ineligible/);
  assert.equal(readFileSync(incident, 'utf8'), 'original incident');
});

test('normal guarded deploy/restart/rollback persist crash fence and stop both without launching owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-guard-')); t.after(() => rmSync(root, { recursive: true }));
  for (const action of ['deploy', 'restart', 'rollback']) {
    const directory = join(root, action); mkdirSync(directory);
    const incident = join(directory, 'migration-forward-only'); writeFileSync(incident, 'original incident');
    const args = [action, directory, directory, directory, directory, directory, directory, directory, '1', '', ''];
    const events = [];
    const forbidden = () => { assert.fail('Guard refusal launched an owner/server'); };
    assert.equal(await supervise('unused', args, { verifyEntrySources() {},
      command(argv) { events.push(argv); return { ok: true }; },
      stopWriters() { events.push('stop:both'); return true; }, spawn: forbidden, createServer: forbidden }), 3);
    assert.deepEqual(events, [['daemon-reload'], 'stop:both']);
    assert.match(readFileSync(join(directory, 'writers-fenced'), 'utf8'), /Writers fenced/);
    for (const unit of units) assert.equal(readFileSync(join(directory, `${unit}.d/95-aistudy-migration-fence.conf`), 'utf8'),
      `[Unit]\nConditionPathExists=!${directory}/writers-fenced\n`);
    assert.equal(readFileSync(incident, 'utf8'), 'original incident');
  }
});

test('repair before adoption refuses mutation requests and owner death without rewriting the incident', async t => {
  const f = fixture(t, { repair: true }); await f.ownerReady;
  const incident = readFileSync(join(f.args[4], 'migration-forward-only'), 'utf8');
  for (const action of ['arm', 'prepare', 'activate', 'refence', 'stop']) assert.equal((await f.request(action)).ok, false);
  f.ownerExit(); assert.equal(await f.running, 1);
  assert.equal(readFileSync(join(f.args[4], 'migration-forward-only'), 'utf8'), incident);
  assert(!existsSync(join(f.args[4], 'repair-adopted')));
  assert(!f.events.some(event => event.startsWith('stop:') || event.startsWith('start:')));
  for (const unit of units) assert(!existsSync(join(f.args[6], `${unit}.d`)));
});

test('repair-check is read-only on missing state and creates no state directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-missing-')); t.after(() => rmSync(root, { recursive: true }));
  const missing = join(root, 'absent');
  assert.throws(() => checkRepair(['repair-pre-migration', '', '', missing, missing, '', missing]));
  assert.throws(() => readFileSync(join(missing, 'migration-forward-only')));
});

for (const lostReply of [undefined, 'eof', 'partial']) test(`one-shot repair keeps guards through migration and commits despite ${lostReply ?? 'normal'} ACK`, async t => {
  const f = fixture(t, { repair: true, lostReply }); await f.ownerReady;
  assert.equal((await f.request('adopt-repair')).ok, true);
  assert(existsSync(join(f.args[4], 'repair-adopted')));
  assert.equal((await f.request('adopt-repair')).ok, false);
  assert.equal((await f.request('arm')).ok, true);
  assert(existsSync(join(f.transition, 'migration-armed')));
  for (const unit of units) assert(!existsSync(join(f.args[6], `${unit}.d/96-aistudy-writer-exec.conf`)), '95 not neutralized during arm');
  assert.equal((await f.request('activate')).ok, false, 'cannot activate before migration succeeds');
  writeFileSync(join(f.transition, 'migration-succeeded'), 'synthetic runner success');
  assert.equal((await f.request('prepare')).ok, true);
  for (const unit of units) assert(existsSync(join(f.args[6], `${unit}.d/96-aistudy-writer-exec.conf`)));
  for (const name of ['migration-forward-only', 'writers-fenced']) assert(existsSync(join(f.args[4], name)));
  assert.equal((await f.request('activate')).ok, true);
  for (const name of ['migration-forward-only', 'writers-fenced']) assert(existsSync(join(f.args[4], name)));
  if (lostReply) await assert.rejects(f.request('success'), /Incomplete/);
  else assert.equal((await f.request('success')).ok, true);
  assert.equal(f.query(), 'committed');
  assert(existsSync(join(f.args[4], 'repair-adopted')), 'consumed adoption survives terminal commit');
  f.finish(0); assert.equal(await f.running, 0);
});

test('adopted repair owner death retains forward-only guards and migration boundary', async t => {
  const f = fixture(t, { repair: true }); await f.ownerReady;
  assert.equal((await f.request('adopt-repair')).ok, true);
  assert.equal((await f.request('arm')).ok, true);
  f.ownerExit(); assert.equal(await f.running, 1);
  for (const name of ['migration-forward-only', 'writers-fenced', 'repair-adopted']) assert(existsSync(join(f.args[4], name)));
  assert(existsSync(join(f.transition, 'migration-armed')));
  assert(!f.events.some(event => event.startsWith('start:')));
});

test('repair 95-to-96 preparation failure retains adoption and guards without launching old writers', async t => {
  const f = fixture(t, { repair: true }); await f.ownerReady;
  assert.equal((await f.request('adopt-repair')).ok, true);
  assert.equal((await f.request('arm')).ok, true);
  writeFileSync(join(f.transition, 'migration-succeeded'), 'synthetic runner success');
  // A concrete filesystem failure inside the real boundary installer, not a
  // claimed real-manager/database E2E. The other unit must remain crash-fenced.
  const blocked = join(f.args[6], `${units[1]}.d`); mkdirSync(blocked, { recursive: true });
  mkdirSync(join(blocked, '96-aistudy-writer-exec.conf'));
  assert.equal((await f.request('prepare')).ok, false);
  f.finish(1); assert.equal(await f.running, 1);
  for (const name of ['migration-forward-only', 'writers-fenced', 'repair-adopted']) assert(existsSync(join(f.args[4], name)));
  assert(existsSync(join(f.transition, 'migration-armed')));
  assert(!f.events.some(event => event.startsWith('start:')));
});

test('Git parent diff admission rejects application changes, even reverted at tip, and non-control deploy sources', t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-git-')); t.after(() => rmSync(root, { recursive: true }));
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init'); writeFileSync(join(root, 'app'), 'baseline'); git('add', 'app');
  const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-am', 'fixture');
  commit(); const baseline = git('rev-parse', 'HEAD');
  const script = readFileSync(resolve('infra/deploy/deploy-hermes.sh'), 'utf8');
  const helper = script.slice(script.indexOf('verify_repair_git() {'), script.indexOf('# Execute reviewed Python bytes'))
    .replace('6afaaa70d3467da4f17daaad44a99e2d36b9f991', baseline);
  const check = () => spawnSync('bash', ['-c', `set -euo pipefail; fail() { echo "$*" >&2; exit 1; }; ${helper}\nverify_repair_git`], {
    cwd: root, env: { ...process.env, COMMIT: git('rev-parse', 'HEAD'), SCRIPT_DIR: `${root}/infra/deploy`, repository: 'Xhhemoing/study-assistant-opening' }, encoding: 'utf8',
  });
  // Actual approved path, then a temporary application edit and reversal.
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  const result = spawnSync('bash', ['-c', 'mkdir -p infra/deploy; printf controls > infra/deploy/hermes-supervisor.mjs; git add infra/deploy/hermes-supervisor.mjs; git commit -m controls'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(check().status, 0, check().stderr);
  writeFileSync(join(root, 'app'), 'changed'); commit(); writeFileSync(join(root, 'app'), 'baseline'); commit();
  assert.notEqual(check().status, 0); assert.match(check().stderr, /outside the reviewed control/);
});

test('reviewed control archive strips group write even with permissive repository tar.umask', t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-archive-')); t.after(() => rmSync(root, { recursive: true }));
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git('init'); writeFileSync(join(root, 'control'), 'reviewed'); git('add', 'control');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  git('config', 'tar.umask', '0000');
  const script = readFileSync(resolve('infra/deploy/deploy-hermes.sh'), 'utf8');
  const command = script.split('\n').find(line => line.includes('--output="$control_archive"'));
  // Exercise the actual command options (only destination/path variables adapted).
  const archive = join(root, 'controls.tar.gz');
  const r = spawnSync('bash', ['-c', command.replace(' infra/deploy', ' control')], {
    cwd: root, env: { ...process.env, COMMIT: 'HEAD', control_archive: archive }, encoding: 'utf8',
  }); assert.equal(r.status, 0, r.stderr);
  const checked = spawnSync('python3', ['-I', '-S', '-B', '-c',
    'import sys,tarfile; t=tarfile.open(sys.argv[1]); assert all(not m.mode & 0o022 for m in t.getmembers())', archive], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});
