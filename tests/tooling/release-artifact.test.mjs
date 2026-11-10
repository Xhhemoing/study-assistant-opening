import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gitFixture } from './hermes-git-fixture.mjs';
import { BRANCH, REPOSITORY, extract, pack, platform, tree, verifyRunBinding, verifySource, verifyTree } from '../../infra/deploy/verify-release-artifact.mjs';

const sha = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function artifactFixture(root, commit = sha) {
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const sources = {
    'package-lock.json': '{"lockfileVersion":3}',
    'apps/web/.next/standalone/apps/web/server.js': 'server',
    'apps/web/.next/standalone/apps/web/.next/static/asset.js': 'asset',
    'apps/web/.next/standalone/node_modules/next/package.json': '{"name":"next","version":"15.3.3"}',
    'apps/worker/src/index.ts': 'worker',
    'node_modules/tsx/dist/cli.mjs': 'tsx',
    'node_modules/tsx/package.json': '{"name":"tsx","version":"4.20.6"}',
    'scripts/db-migrate.ts': 'migration',
    'services/parser/opening_parser/__main__.py': '# parser',
    '.worker-protocol': 'delivery-leases-v1\n',
  };
  for (const [path, body] of Object.entries(sources)) {
    mkdirSync(join(root, path, '..'), { recursive: true, mode: 0o755 });
    writeFileSync(join(root, path), body, { mode: 0o644 });
  }
  const files = tree(root);
  const manifest = { version: 1, sha: commit, branch: BRANCH, mainlineTip: commit, platform: platform(),
    lockfileSha256: hash(readFileSync(join(root, 'package-lock.json'))), files, treeSha256: hash(JSON.stringify(files)),
    dependencies: { worker: [{ path: 'node_modules/tsx/package.json', name: 'tsx', version: '4.20.6' }],
      standalone: [{ path: 'apps/web/.next/standalone/node_modules/next/package.json', name: 'next', version: '15.3.3' }] } };
  writeFileSync(join(root, 'release-manifest.json'), JSON.stringify(manifest), { mode: 0o644 });
  return manifest;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-artifact-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const manifest = artifactFixture(source);
  const archive = join(root, 'release.tar.gz');
  const result = spawnSync('tar', ['--format=posix', '-czf', archive, '-C', source, ...readdirSync(source)]);
  assert.equal(result.status, 0);
  return { root, source, manifest, archive, destination: join(root, 'release'), digest: hash(readFileSync(archive)) };
}
test('pack uses committed source, materializes workspace dependencies, excludes private builder files', t => {
  const f = fixture(t);
  for (const [path, body] of Object.entries({
    'packages/example/package.json': '{"name":"@aistudy/example","version":"0.0.0"}',
    'packages/example/index.ts': 'export const value = 1;',
    'infra/deploy/control.mjs': '// trusted',
    'apps/web/package.json': '{"name":"web","version":"0.0.0"}',
    'apps/web/next.config.mjs': 'export default {};',
    'package.json': '{"name":"fixture","version":"0.0.0"}',
    'tsconfig.json': '{}',
  })) {
    mkdirSync(join(f.source, path, '..'), { recursive: true });
    writeFileSync(join(f.source, path), body);
  }
  // Commit only sources; dependencies and Next output belong to the builder.
  const git = gitFixture(f.source).run;
  git('checkout', '-b', BRANCH);
  git('add', 'packages', 'infra', 'scripts', 'services', 'apps/worker', 'apps/web/package.json', 'apps/web/next.config.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', '.worker-protocol');
  git('-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.test', 'commit', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  writeFileSync(join(f.source, 'packages/example/.env.production'), 'must never ship');
  writeFileSync(join(f.source, 'scripts/untracked-private.txt'), 'must never ship');
  mkdirSync(join(f.source, 'node_modules/@aistudy'), { recursive: true });
  symlinkSync('../../packages/example', join(f.source, 'node_modules/@aistudy/example'));
  mkdirSync(join(f.source, 'apps/web/.next/static'), { recursive: true });
  writeFileSync(join(f.source, 'apps/web/.next/static/asset.js'), 'asset');
  pack(f.source, f.archive, commit);
  extract(f.archive, f.destination, commit, hash(readFileSync(f.archive)), platform());
  assert(!existsSync(join(f.destination, 'scripts/untracked-private.txt')));
  assert(!existsSync(join(f.destination, 'node_modules/@aistudy/example/.env.production')));
  assert.equal(readFileSync(join(f.destination, 'node_modules/@aistudy/example/index.ts'), 'utf8'), 'export const value = 1;');
  assert.match(readFileSync(join(f.destination, 'node_modules/.bin/tsx'), 'utf8'), /exec node/);
});

test('verified archive stages, validates and atomically publishes complete runtime', t => {
  const f = fixture(t);
  extract(f.archive, f.destination, sha, f.digest, f.manifest.platform);
  assert(existsSync(join(f.destination, 'node_modules/tsx/dist/cli.mjs')));
  assert.deepEqual(verifyTree(f.destination, sha, f.manifest.platform), f.manifest);
  assert(!readdirSync(f.root).some(name => name.startsWith('.artifact-staging-')));
});
for (const scenario of ['blob', 'tree', 'SHA', 'tip', 'arch', 'versions', 'permissions', 'secret']) {
  test(`rejects ${scenario} without publishing`, t => {
    const f = fixture(t);
    if (scenario === 'blob') return assert.throws(() => extract(f.archive, f.destination, sha, '0'.repeat(64)), /digest/);
    if (scenario === 'tree') writeFileSync(join(f.source, 'node_modules/tsx/dist/cli.mjs'), 'tampered');
    if (scenario === 'permissions') chmodSync(join(f.source, 'node_modules/tsx/dist/cli.mjs'), 0o666);
    if (scenario === 'secret') writeFileSync(join(f.source, '.env.production'), 'not allowed');
    if (scenario === 'SHA') f.manifest.sha = 'b'.repeat(40);
    if (scenario === 'tip') f.manifest.mainlineTip = 'b'.repeat(40);
    if (scenario === 'arch') f.manifest.platform.arch = 'incompatible';
    if (scenario === 'versions') f.manifest.dependencies.worker[0].version = 'fake';
    writeFileSync(join(f.source, 'release-manifest.json'), JSON.stringify(f.manifest));
    assert.throws(() => verifyTree(f.source, sha), /tampered|mismatch|Unsafe|Not release code/);
    assert(!existsSync(f.destination));
  });
}
for (const [name, type, link, mode] of [
  ['../escape', 'file', '', 0o644], ['/absolute', 'file', '', 0o644], ['x/../../escape', 'file', '', 0o644],
  ['link', 'symlink', '/etc', 0o644], ['hard', 'hardlink', '../escape', 0o644],
  ['suid', 'file', '', 0o4755], ['writable', 'file', '', 0o666], ['fifo', 'fifo', '', 0o644],
]) {
  test(`tar rejects ${name}/${type} before writing`, t => {
    const f = fixture(t);
    const code = `import tarfile,sys,io\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n m=tarfile.TarInfo(sys.argv[2]); m.mode=int(sys.argv[5]); m.linkname=sys.argv[4]\n m.type={'file':tarfile.REGTYPE,'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}[sys.argv[3]]\n t.addfile(m)\n`;
    assert.equal(spawnSync('python3', ['-c', code, f.archive, name, type, link, String(mode)]).status, 0);
    assert.throws(() => extract(f.archive, f.destination, sha, hash(readFileSync(f.archive)), f.manifest.platform));
    assert(!existsSync(f.destination));
    assert(!readdirSync(f.root).some(name => name.startsWith('.artifact-staging-')));
  });
}
const invocation = `https://github.com/${REPOSITORY}/actions/runs/12/attempts/1`;
const certificateResult = certificate => ({ verificationResult: { signature: { certificate } } });
for (const [shape, certificate] of [
  ['direct gh certificate field', { runInvocationURI: invocation }],
  ['legacy certificate extension', { extensions: { runInvocationURI: invocation } }],
  ['matching direct and legacy fields', { runInvocationURI: invocation, extensions: { runInvocationURI: invocation } }],
]) {
  test(`run binding accepts ${shape}`, () => verifyRunBinding([certificateResult(certificate)], 12, 1));
}
for (const [name, value] of [
  ['wrong run', invocation.replace('/runs/12/', '/runs/13/')],
  ['wrong attempt', invocation.replace('/attempts/1', '/attempts/2')],
  ['wrong repository', invocation.replace(REPOSITORY, 'attacker/fork')],
  ['empty', ''], ['null', null], ['number', 12], ['array', [invocation]], ['object', { uri: invocation }],
]) {
  for (const shape of ['direct', 'legacy']) {
    test(`run binding rejects ${shape} ${name}, despite matching predicate metadata`, () => {
      const certificate = shape === 'direct' ? { runInvocationURI: value } : { extensions: { runInvocationURI: value } };
      const result = certificateResult(certificate);
      result.verificationResult.statement = { predicate: { runDetails: { metadata: { invocationId: invocation } } } };
      assert.throws(() => verifyRunBinding([result], 12, 1), /not bound/);
    });
  }
}
for (const [name, verified] of [
  ['missing verification results', {}], ['empty verification results', []], ['null result', [null]],
  ['missing certificate', [{ verificationResult: { signature: {} } }]],
  ['missing invocation', [certificateResult({})]],
  ['predicate only', [{ verificationResult: { statement: { predicate: { runDetails: { metadata: { invocationId: invocation } } } } } }]],
]) {
  test(`run binding rejects ${name}`, () => assert.throws(() => verifyRunBinding(verified, 12, 1), /not bound/));
}
for (const directMatches of [true, false]) {
  test(`run binding rejects conflicting certificate fields (direct matches: ${directMatches})`, () => {
    const wrong = invocation.replace('/attempts/1', '/attempts/2');
    const conflicting = certificateResult({ runInvocationURI: directMatches ? invocation : wrong,
      extensions: { runInvocationURI: directMatches ? wrong : invocation } });
    const valid = certificateResult({ runInvocationURI: invocation });
    assert.throws(() => verifyRunBinding([conflicting], 12, 1), /Conflicting/);
    assert.throws(() => verifyRunBinding([valid, conflicting], 12, 1), /Conflicting/);
    assert.throws(() => verifyRunBinding([conflicting, valid], 12, 1), /Conflicting/);
  });
}
function provenance() {
  const run = { id: 12, head_sha: sha, head_branch: BRANCH, event: 'push', status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', head_repository: { full_name: REPOSITORY }, html_url: `https://github.com/${REPOSITORY}/actions/runs/12` };
  return { run, runs: { workflow_runs: [run] }, jobs: { jobs: ['lint-typecheck-test-build', 'real-worker-pdf-browser-flow', 'production-build', 'static-unit-contract-spikes', 'integration-parser', 'handler-browser-spikes', 'isolated-worker-pdf-browser'].map(name => ({ name, status: 'completed', conclusion: 'success' })) },
    artifact: { id: 22, name: `release-${sha}`, expired: false, workflow_run: { id: 12, head_sha: sha } } };
}
test('accepts only exact successful formal repo workflow run and required checks', () => verifySource(provenance(), sha, 12));
for (const scenario of ['repo', 'workflow', 'event', 'SHA', 'CI red', 'CI skipped', 'missing check', 'newer failed CI', 'artifact run']) {
  test(`provenance rejects ${scenario}`, () => {
    const p = provenance();
    if (scenario === 'repo') p.run.head_repository.full_name = 'attacker/fork';
    if (scenario === 'workflow') p.run.path = '.github/workflows/other.yml';
    if (scenario === 'event') p.run.event = 'pull_request';
    if (scenario === 'SHA') p.run.head_sha = 'b'.repeat(40);
    if (scenario === 'CI red') p.run.conclusion = 'failure';
    if (scenario === 'CI skipped') p.jobs.jobs[0].conclusion = 'skipped';
    if (scenario === 'missing check') p.jobs.jobs.pop();
    if (scenario === 'newer failed CI') p.runs.workflow_runs.push({ ...p.run, id: 13, conclusion: 'failure' });
    if (scenario === 'artifact run') p.artifact.workflow_run.id = 11;
    assert.throws(() => verifySource(p, sha, 12));
  });
}
