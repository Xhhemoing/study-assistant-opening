import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

for (const mode of ['curl-fast-fail', 'identity-fast-fail', 'ready']) test(`real scaled readiness deadline: ${mode}`, t => {
  const root = mkdtempSync(join(tmpdir(), 'sm95-health-deadline-'));
  t.after(() => rmSync(root, { recursive: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'events');
  const release = readFileSync(resolve('infra/deploy/hermes-release.sh'), 'utf8');
  const begin = release.indexOf('completion_health() {');
  const end = release.indexOf('\nhealth() {', begin);
  // Scale the real time window only. Commands still run through real GNU timeout;
  // no fake clock or attempt-count assertion can satisfy this test.
  const health = release.slice(begin, end).replace('SECONDS + 1000', 'SECONDS + 2');
  writeFileSync(join(root, 'runtime-identity.mjs'), 'fixture');
  writeFileSync(join(bin, 'curl'), `#!/bin/bash\nprintf 'curl\\n' >> "$EVENTS"\n${mode === 'curl-fast-fail' ? 'exit 7' : 'printf \'{"status":"ok"}\''}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'systemctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'node'), `#!/bin/bash\nprintf 'identity\\n' >> "$EVENTS"\n${mode === 'ready' ? 'exit 0' : 'exit 1'}\n`, { mode: 0o755 });
  // Short sleep simulates fast-failing probes many times inside the true window.
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexec /bin/sleep .03\n', { mode: 0o755 });
  const script = `${health}\nSECONDS=0\nSTATE=${JSON.stringify(root)}\nCONFIG=/unused\nconsumed=0\ncomplete_once() {\n ((consumed == 0)) || return 9\n consumed=1\n printf 'activate\\n' >> "$EVENTS"\n completion_health 1 /release || { printf 'refence\\nstop\\n' >> "$EVENTS"; return 1; }\n}\ncomplete_once; result=$?\ncomplete_once; again=$?\n[[ "$again" == 9 ]] || exit 8\nexit "$result"\n`;
  const start = performance.now();
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5_000,
    env: { PATH: `${bin}:/usr/bin:/bin`, EVENTS: log } });
  const elapsed = performance.now() - start;
  const events = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(result.status, mode === 'ready' ? 0 : 1, result.stderr);
  assert.equal(events.filter(v => v === 'activate').length, 1);
  if (mode === 'ready') {
    assert(elapsed < 1000, `ready did not return early: ${elapsed}`);
    assert(!events.includes('refence'));
  } else {
    // Bash SECONDS has integer resolution; permit its <=1s rounding, not a
    // 20-attempt/fastfail early return. Total leaf overrun remains bounded.
    assert(elapsed >= 1000 && elapsed < 3500, `deadline elapsed ${elapsed}`);
    assert.deepEqual(events.slice(-2), ['refence', 'stop']);
  }
});
