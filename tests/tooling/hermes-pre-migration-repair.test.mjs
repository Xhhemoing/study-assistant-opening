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

test('normal guarded deploy/restart/rollback refuse without crashFence writes or stops', async t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-guard-')); t.after(() => rmSync(root, { recursive: true }));
  const incident = join(root, 'migration-forward-only'); writeFileSync(incident, 'original incident');
  for (const action of ['deploy', 'restart', 'rollback']) {
    const args = [action, root, root, root, root, root, root, root, '1', '', ''];
    const forbidden = () => { assert.fail('Guard refusal performed a side effect'); };
    assert.equal(await supervise('unused', args, { verifyEntrySources() {}, command: forbidden,
      stopWriters: forbidden, spawn: forbidden, createServer: forbidden }), 3);
    assert.equal(readFileSync(incident, 'utf8'), 'original incident');
  }
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
