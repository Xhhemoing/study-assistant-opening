import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("libpq is loopback-only inside setup and caller configuration is restored", () => {
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", `
$ErrorActionPreference = 'Stop'
. ./scripts/opening-e2e/service-process.ps1
$env:PGSERVICE = 'test-sentinel'
$env:PGHOSTADDR = 'test-sentinel'
Invoke-WithLocalPostgres {
  if ($env:PGHOSTADDR -ne '127.0.0.1' -or $env:PGSERVICE -or $env:PGSERVICEFILE -or $env:PGOPTIONS) { throw 'libpq isolation failed' }
}
if ($env:PGSERVICE -ne 'test-sentinel' -or $env:PGHOSTADDR -ne 'test-sentinel') { throw 'caller environment was changed' }
`], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

for (const [browserExit, stopExit, expected] of [[0, 7, 7], [3, 7, 3], [0, 0, 0]]) {
  test(`acceptance propagates browser=${browserExit}, cleanup=${stopExit} as exit=${expected}`, () => {
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", `
$ErrorActionPreference = 'Stop'
function pwsh {
  if ($args[-1] -eq 'start') { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = ${stopExit} }
}
function node { $global:LASTEXITCODE = ${browserExit} }
& ./scripts/opening-e2e/run.ps1
exit $LASTEXITCODE
`], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, expected, result.stderr);
  });
}
