#!/usr/bin/env node
// Trusted control-plane code. A manifest is consistency metadata, NOT provenance.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'Xhhemoing/study-assistant-opening';
export const BRANCH = 'feat/opening-release';
const WORKFLOW = '.github/workflows/ci.yml';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) fail(`${command} failed; artifact rejected.`);
  return result.stdout;
}
export function platform() {
  const header = process.report.getReport().header;
  return { node: process.versions.node, npm: run('npm', ['--version']).trim(), os: process.platform,
    arch: process.arch, libc: header.glibcVersionRuntime ? `glibc-${header.glibcVersionRuntime}` : 'unknown' };
}
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function allowed(path) {
  // Explicit code roots only. Never sweep a checkout/cache/home into a release.
  return safePath(path) && /^(?:apps\/(?:web|worker)\/|packages\/|node_modules\/|scripts\/|services\/parser\/|infra\/deploy\/|package(?:-lock)?\.json$|tsconfig[^/]*\.json$|\.worker-protocol$)/.test(path)
    && !path.split('/').some(part => /^\.env(?:\.|$)/.test(part) || ['.git', '.local', '.tmp', '__pycache__'].includes(part))
    && !/\.(?:dump|sqlite|pem|key)$/.test(path);
}
export function tree(root) {
  const files = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path), key = relative(root, path).split('\\').join('/');
      if (!safePath(key) || stat.isSymbolicLink() || (stat.mode & 0o7022)) fail('Unsafe artifact path, link or permissions.');
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        if (key !== 'release-manifest.json' && !allowed(key)) fail(`Not release code: ${key}`);
        if (key !== 'release-manifest.json') files.push({ path: key, size: stat.size, mode: stat.mode & 0o777, sha256: digest(readFileSync(path)) });
      } else fail('Special files are not release code.');
    }
  }
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function dependencies(root, prefix) {
  return tree(root).filter(file => file.path.startsWith(prefix) && /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package.json$/.test(file.path))
    .map(file => {
      const body = JSON.parse(readFileSync(join(root, file.path), 'utf8'));
      if (typeof body.name !== 'string' || typeof body.version !== 'string') fail('Dependency version is missing.');
      return { path: file.path, name: body.name, version: body.version };
    });
}
export function verifyTree(root, sha, expectedPlatform = platform()) {
  const manifest = JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(sha) || manifest.sha !== sha || manifest.branch !== BRANCH || manifest.mainlineTip !== sha) fail('Artifact SHA/branch/tip mismatch.');
  if (JSON.stringify(manifest.platform) !== JSON.stringify(expectedPlatform) || expectedPlatform.libc === 'unknown') fail('Artifact Node/npm/OS/arch/libc mismatch.');
  const files = tree(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files) || digest(JSON.stringify(files)) !== manifest.treeSha256
    || digest(readFileSync(join(root, 'package-lock.json'))) !== manifest.lockfileSha256) fail('Artifact tree/lockfile tampered.');
  for (const path of ['apps/web/.next/standalone/apps/web/server.js', 'apps/worker/src/index.ts', 'node_modules/tsx/dist/cli.mjs', 'scripts/db-migrate.ts', 'services/parser/opening_parser/__main__.py', '.worker-protocol']) {
    if (!files.some(file => file.path === path)) fail(`Incomplete runtime: ${path}`);
  }
  if (!files.some(file => file.path.startsWith('apps/web/.next/standalone/apps/web/.next/static/'))) fail('Standalone static assets missing.');
  const worker = dependencies(root, 'node_modules/'), standalone = dependencies(root, 'apps/web/.next/standalone/');
  if (!worker.length || !standalone.length || JSON.stringify({ worker, standalone }) !== JSON.stringify(manifest.dependencies)) fail('Runtime dependency inventory mismatch.');
  return manifest;
}
export function pack(root, archive, sha, gitRoot = root) {
  if (!/^[a-f0-9]{40}$/.test(sha) || run('git', ['-C', gitRoot, 'rev-parse', 'HEAD']).trim() !== sha) fail('Build SHA differs from Git source.');
  const staging = mkdtempSync(join(tmpdir(), 'aistudy-pack-'));
  const source = mkdtempSync(join(tmpdir(), 'aistudy-pack-source-'));
  try {
    const committed = spawnSync('git', ['-C', gitRoot, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', sha], { maxBuffer: 256 * 1024 * 1024 });
    if (committed.status !== 0) fail('Cannot archive committed release code.');
    run('tar', ['-x', '-C', source], { input: committed.stdout });
    // Committed code only, independent of ignored files produced during build.
    for (const name of ['packages', 'scripts', 'services/parser', 'infra/deploy', 'apps/worker', 'package.json', 'package-lock.json', '.worker-protocol', ...readdirSync(source).filter(name => /^tsconfig[^/]*\.json$/.test(name))]) {
      cpSync(join(source, name), join(staging, name), { recursive: true, dereference: true });
    }
    mkdirSync(join(staging, 'apps/web'), { recursive: true });
    for (const name of ['package.json', 'next.config.mjs']) cpSync(join(source, 'apps/web', name), join(staging, 'apps/web', name));
    // Materialize workspace/.bin links on the builder; no links are accepted on the host.
    const sourceRoot = realpathSync(root);
    const copyRuntime = (runtimeSource, target) => {
      const workspaces = [];
      cpSync(runtimeSource, target, { recursive: true, dereference: true, filter: path => {
        const stat = lstatSync(path);
        if (!stat.isSymbolicLink()) return true;
        const resolved = realpathSync(path);
        if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}/`)) fail('Dependency link escapes builder checkout.');
        // Workspace code comes from Git too, never ignored/private builder files.
        const workspace = relative(sourceRoot, resolved);
        if (/^(?:packages\/|apps\/worker(?:\/|$))/.test(workspace)) {
          workspaces.push([join(source, workspace), join(target, relative(runtimeSource, path))]);
          return false;
        }
        // npm also links non-runtime apps/spikes; never duplicate build caches.
        return !/^(?:apps\/web|spikes)(?:\/|$)/.test(workspace);
      } });
      for (const [committed, destination] of workspaces) cpSync(committed, destination, { recursive: true, dereference: true });
    };
    for (const name of ['node_modules', 'apps/web/.next/standalone']) copyRuntime(join(root, name), join(staging, name));
    // npx uses this bin during the existing DB migration command. Dereferencing
    // npm's original bin link would break tsx's relative module imports.
    mkdirSync(join(staging, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(staging, 'node_modules/.bin/tsx'), '#!/bin/sh\nexec node "$(dirname "$0")/../tsx/dist/cli.mjs" "$@"\n', { mode: 0o755 });
    cpSync(join(root, 'apps/web/.next/static'), join(staging, 'apps/web/.next/standalone/apps/web/.next/static'), { recursive: true });
    if (existsSync(join(source, 'apps/web/public'))) cpSync(join(source, 'apps/web/public'), join(staging, 'apps/web/.next/standalone/apps/web/public'), { recursive: true });
    // npm's copied bin files and all code stay non-writable to runtime identities.
    function modes(directory) {
      chmodSync(directory, 0o755);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), stat = lstatSync(path);
        if (stat.isDirectory()) modes(path);
        else if (stat.isFile()) chmodSync(path, stat.mode & 0o111 ? 0o755 : 0o644);
        else fail('Unsupported build output.');
      }
    }
    modes(staging);
    const files = tree(staging);
    const manifest = { version: 1, sha, branch: BRANCH, mainlineTip: sha, platform: platform(),
      lockfileSha256: digest(readFileSync(join(staging, 'package-lock.json'))), files, treeSha256: digest(JSON.stringify(files)),
      dependencies: { worker: dependencies(staging, 'node_modules/'), standalone: dependencies(staging, 'apps/web/.next/standalone/') } };
    writeFileSync(join(staging, 'release-manifest.json'), JSON.stringify(manifest), { mode: 0o644 });
    verifyTree(staging, sha, manifest.platform);
    // POSIX pax format supports long npm paths; links are already materialized.
    run('tar', ['--format=posix', '-czf', resolve(archive), '-C', staging, ...readdirSync(staging)]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
}

// tarfile reads the full effective header (including pax) BEFORE any writes. No
// system tar extraction, link following, devices, sparse files or duplicate paths.
const EXTRACT = `import os,sys,tarfile,re
archive,dest=sys.argv[1:]
with tarfile.open(archive,'r:gz') as tar:
 members=tar.getmembers(); seen=set(); total=0
 if len(members)>300000: raise ValueError('too many members')
 for m in members:
  p=m.name.rstrip('/') if m.isdir() else m.name
  if not p or p.startswith('/') or '\\\\' in p or re.search(r'[\\x00-\\x1f\\x7f]',p) or any(x in ('','.','..') for x in p.split('/')): raise ValueError('unsafe path')
  if p in seen or not (m.isdir() or m.isfile()) or m.mode & 0o7022 or m.sparse: raise ValueError('unsafe member')
  seen.add(p); total+=m.size
  if total>12*1024**3: raise ValueError('artifact too large')
 for m in members:
  p=os.path.join(dest,m.name)
  if m.isdir(): os.makedirs(p,mode=0o755,exist_ok=True)
  else:
   os.makedirs(os.path.dirname(p),mode=0o755,exist_ok=True)
   with tar.extractfile(m) as src, open(p,'xb') as out:
    import shutil
    shutil.copyfileobj(src,out)
   os.chmod(p,m.mode & 0o777)
`;
export function extract(archive, destination, sha, trustedDigest, expectedPlatform) {
  if (!/^[a-f0-9]{64}$/.test(trustedDigest) || digest(readFileSync(archive)) !== trustedDigest) fail('Trusted archive digest mismatch.');
  if (existsSync(destination)) fail('Release destination already exists.');
  const staging = mkdtempSync(join(dirname(destination), '.artifact-staging-'));
  try {
    run('python3', ['-c', EXTRACT, archive, staging]);
    verifyTree(staging, sha, expectedPlatform);
    renameSync(staging, destination);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function api(path) { return JSON.parse(run('gh', ['api', `repos/${REPOSITORY}/${path}`])); }
export function verifySource({ runs, run: selected, jobs, artifact }, sha, runId) {
  const latest = runs.workflow_runs?.filter(run => run.head_sha === sha && run.head_branch === BRANCH && run.event === 'push').sort((a, b) => b.id - a.id)[0];
  if (latest?.id !== runId || selected.id !== runId || selected.head_sha !== sha || selected.head_branch !== BRANCH
    || selected.event !== 'push' || selected.status !== 'completed' || selected.conclusion !== 'success'
    || selected.path !== WORKFLOW || selected.head_repository?.full_name !== REPOSITORY
    || selected.html_url !== `https://github.com/${REPOSITORY}/actions/runs/${runId}`) fail('Untrusted or unsuccessful CI source.');
  // Fixed required jobs cannot be replaced by a client-supplied list. Include
  // real worker gate, not merely the aggregate lint/typecheck/build check.
  for (const name of ['lint-typecheck-test-build', 'real-worker-pdf-browser-flow', 'production-build', 'static-unit-contract-spikes', 'integration-parser', 'handler-browser-spikes', 'isolated-worker-pdf-browser']) {
    const matches = jobs.jobs?.filter(job => job.name === name);
    if (matches?.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') fail(`Required CI check not green: ${name}`);
  }
  if (!Number.isSafeInteger(artifact?.id) || artifact.expired !== false || artifact.name !== `release-${sha}`
    || artifact.workflow_run?.id !== runId || artifact.workflow_run?.head_sha !== sha) fail('Artifact does not belong to the trusted workflow run.');
}
// Accept only certificate fields from successful `gh attestation verify` output,
// never the workflow-controlled predicate's invocationId.
export function verifyRunBinding(verified, runId, runAttempt) {
  const invocation = `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`;
  let bound = false;
  if (!Array.isArray(verified)) fail('Attestation is not bound to this workflow run attempt.');
  for (const result of verified) {
    const certificate = result?.verificationResult?.signature?.certificate;
    const direct = certificate?.runInvocationURI;
    const legacy = certificate?.extensions?.runInvocationURI;
    if (direct !== undefined && legacy !== undefined && direct !== legacy) fail('Conflicting certificate run invocation fields.');
    if ((direct !== undefined ? direct : legacy) === invocation) bound = true;
  }
  if (!bound) fail('Attestation is not bound to this workflow run attempt.');
}
export function download(sha, runId, destination) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(runId) || runId < 1) fail('Explicit SHA and run ID required.');
  const runs = api(`actions/workflows/ci.yml/runs?head_sha=${sha}&branch=feat%2Fopening-release&event=push&per_page=100`);
  const selected = api(`actions/runs/${runId}`);
  const jobs = api(`actions/runs/${runId}/attempts/${selected.run_attempt}/jobs?per_page=100`);
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length || jobs.total_count > 100) fail('Incomplete required-check response.');
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`);
  if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length || artifacts.total_count > 100) fail('Incomplete artifact response.');
  const matching = artifacts.artifacts?.filter(item => item.name === `release-${sha}`);
  if (matching?.length !== 1) fail('Expected one release artifact.');
  verifySource({ runs, run: selected, jobs, artifact: matching[0] }, sha, runId);
  mkdirSync(destination, { mode: 0o700 });
  run('gh', ['run', 'download', String(runId), '--repo', REPOSITORY, '--name', `release-${sha}`, '--dir', destination]);
  if (JSON.stringify(readdirSync(destination).sort()) !== JSON.stringify(['release.tar.gz'])) fail('Unexpected artifact payload.');
  const archive = join(destination, 'release.tar.gz');
  if (!lstatSync(archive).isFile() || lstatSync(archive).isSymbolicLink()) fail('Downloaded artifact is not a regular archive.');
  // GitHub's signed provenance, not self-reported manifest hashes. Verify issuer,
  // repo, exact workflow, source ref/SHA and runner trust against the actual blob.
  // Bind the run using the OIDC certificate fields, NOT predicate metadata
  // (which the originating workflow can freely set).
  const verified = JSON.parse(run('gh', ['attestation', 'verify', archive, '--repo', REPOSITORY, '--signer-workflow', `${REPOSITORY}/${WORKFLOW}`,
    '--source-ref', `refs/heads/${BRANCH}`, '--source-digest', sha, '--deny-self-hosted-runners', '--format', 'json']));
  verifyRunBinding(verified, runId, selected.run_attempt);
  return digest(readFileSync(archive));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'pack') pack(...args);
    else if (action === 'extract') extract(...args);
    else if (action === 'download') console.log(download(args[0], Number(args[1]), args[2]));
    else fail('Unknown artifact action.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
