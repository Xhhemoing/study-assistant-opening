#!/usr/bin/env bash
# CI only: bound APT network stalls without changing runner sources or apt.conf.d.
# Keep deps + browser installation + ldd inside the workflow's single 10m step.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]]
apt_bin=$(mktemp -d)
trap 'rm -f "$apt_bin/apt-get"; rmdir "$apt_bin"' EXIT
apt_get=$(command -v apt-get)
# APT_CONFIG is loaded before apt.conf.d and can be overridden by the image.
# Command-line -o options take precedence without touching any system config.
{
  printf '#!/usr/bin/env bash\nexec %q ' "$apt_get"
  printf '%s\n' '-o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o APT::Update::Error-Mode=any "$@"'
} > "$apt_bin/apt-get"
chmod 700 "$apt_bin/apt-get"

# Explicit PATH after sudo keeps the wrapper for Playwright's apt-get calls.
# Run only OS dependency installation as root, not the browser cache write.
# Error-Mode=any prevents apt-get update from succeeding with stale indexes when
# an official mirror is unavailable. No mirror fallback or ignored install error.
node_path=$(command -v node)
sudo -- env PATH="$apt_bin:$PATH" "$node_path" node_modules/playwright/cli.js install-deps chromium
node node_modules/playwright/cli.js install chromium

# A restored browser cache is not evidence that this runner has its system libs.
# Check every executable installed for Chromium, including the default headless
# shell and ffmpeg. This inspects linked libraries; it does not launch a browser.
node <<'NODE'
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { registry } = require(path.resolve('node_modules/playwright-core/lib/server/registry/index.js'));
for (const name of ['chromium', 'chromium-headless-shell', 'ffmpeg']) {
  const executable = registry.findExecutable(name).executablePath();
  const result = spawnSync('ldd', [executable], { encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /not found/, `Missing system library for ${name}`);
  if (name === 'ffmpeg' && result.status === 1 && /not a dynamic executable/.test(output)) {
    // The pinned Linux ffmpeg may be static. Do not accept ldd's message alone:
    // require a readable executable ELF with neither interpreter nor dependencies.
    require('node:fs').accessSync(executable, require('node:fs').constants.X_OK);
    const inspect = flags => {
      const elf = spawnSync('readelf', [flags, executable], { encoding: 'utf8' });
      assert.ifError(elf.error);
      assert.equal(elf.status, 0, `ELF inspection failed for ${name}`);
      return elf.stdout || '';
    };
    const header = inspect('-h');
    assert.match(header, /ELF Header:/);
    assert.match(header, /Type:\s+(EXEC|DYN)\b/);
    assert.doesNotMatch(inspect('-l'), /\bINTERP\b/);
    assert.doesNotMatch(inspect('-d'), /\(NEEDED\)/);
    console.log(`Static ELF verified: ${name}`);
  } else {
    assert.equal(result.status, 0, `ldd failed for ${name}`);
    console.log(`Linked libraries OK: ${name}`);
  }
}
NODE
