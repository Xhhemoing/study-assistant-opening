$ErrorActionPreference = 'Stop'
function Test-LocalPort([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(500) -and $client.Connected }
  catch { return $false }
  finally { $client.Dispose() }
}
function Get-OwnedProcess($Record) {
  $process = Get-Process -Id $Record.Id -ErrorAction SilentlyContinue
  if ($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $Record.StartTicks -and $process.Path -eq $Record.Executable) { return $process }
  return $null
}
function Start-OwnedService([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$Port) {
  $manifest = Join-Path $state "$Name.process.json"
  if (Test-Path -LiteralPath $manifest) {
    $record = Get-Content -LiteralPath $manifest -Encoding UTF8 -Raw | ConvertFrom-Json
    if (Get-OwnedProcess $record) {
      if (-not (Test-LocalPort $Port)) { throw "$Name process exists but port $Port is unhealthy" }
      Write-Output "$Name already running on loopback:$Port"
      return
    }
  }
  if (Test-LocalPort $Port) { throw "Refusing to adopt unknown listener on port $Port" }
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $state -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $state "$Name.stdout.log") -RedirectStandardError (Join-Path $state "$Name.stderr.log")
  $record = @{ Id=$process.Id; StartTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); Executable=$process.Path }
  $record | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if (Test-LocalPort $Port) { Write-Output "$Name ready on loopback:$Port"; return }
    if ($process.HasExited) { throw "$Name exited; inspect $state/$Name.stderr.log" }
    Start-Sleep -Milliseconds 200
    $process.Refresh()
  }
  throw "$Name did not become ready on port $Port"
}
function Stop-OwnedService([string]$Name) {
  $manifest = Join-Path $state "$Name.process.json"
  if (-not (Test-Path -LiteralPath $manifest)) { return }
  $record = Get-Content -LiteralPath $manifest -Encoding UTF8 -Raw | ConvertFrom-Json
  $process = Get-OwnedProcess $record
  if ($process) { Stop-Process -Id $process.Id -ErrorAction Stop; $process.WaitForExit(5000) | Out-Null }
  Remove-Item -LiteralPath $manifest
}
function Invoke-WithLocalPostgres([scriptblock]$Operation) {
  $names = @('PGPASSWORD','PGHOSTADDR','PGSERVICE','PGSERVICEFILE','PGOPTIONS','PGCONNECT_TIMEOUT')
  $saved = @{}
  foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    $env:PGPASSWORD = 'opening-local-test'
    $env:PGHOSTADDR = '127.0.0.1'
    $env:PGCONNECT_TIMEOUT = '5'
    $env:PGSERVICE = $null
    $env:PGSERVICEFILE = $null
    $env:PGOPTIONS = $null
    & $Operation
  } finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
}
