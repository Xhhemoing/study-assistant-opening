$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location $root
$runExit = 1
try {
  pwsh -NoProfile -File scripts/opening-e2e/services.ps1 start
  if ($LASTEXITCODE -ne 0) { throw 'Could not start isolated acceptance services' }
  node node_modules/@playwright/test/cli.js test --config playwright.opening.config.mts @args
  $runExit = $LASTEXITCODE
} finally {
  pwsh -NoProfile -File scripts/opening-e2e/services.ps1 stop
  if ($runExit -eq 0 -and $LASTEXITCODE -ne 0) { $runExit = $LASTEXITCODE }
  Pop-Location
}
exit $runExit
