$ErrorActionPreference = 'Stop'
$action = if ($args.Count) { $args[0] } else { 'status' }
if ($action -notin @('start','status','stop')) { throw 'Use services.ps1 start|status|stop' }
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$state = Join-Path $root '.local/opening-e2e'
$pgbin = Join-Path $root '.local/pgsql/bin'
$pgdata = Join-Path $state 'pgdata'
. (Join-Path $PSScriptRoot 'service-process.ps1')
if ($action -eq 'status') {
  @(15432,16379,19000,19001,3100) | ForEach-Object { [pscustomobject]@{ Port=$_; Reachable=Test-LocalPort $_ } }
  exit 0
}
if ($action -eq 'stop') {
  Stop-OwnedService 'minio'
  Stop-OwnedService 'redis'
  $manifest = Join-Path $state 'postgres.process.json'
  if (Test-Path -LiteralPath $manifest) {
    $record = Get-Content -LiteralPath $manifest -Encoding UTF8 -Raw | ConvertFrom-Json
    if (Get-OwnedProcess $record) {
      & (Join-Path $pgbin 'pg_ctl.exe') -D $pgdata -m fast -w stop
      if ($LASTEXITCODE -ne 0) { throw 'Isolated PostgreSQL stop failed' }
    }
    Remove-Item -LiteralPath $manifest
  }
  exit 0
}
New-Item -ItemType Directory -Path $state -Force | Out-Null
foreach ($exe in @((Join-Path $pgbin 'postgres.exe'), (Join-Path $root '.local/redis8/redis-server.exe'), (Join-Path $root '.local/minio.exe'))) {
  if (-not (Test-Path -LiteralPath $exe)) { throw "Missing portable dependency: $exe" }
}
if (-not (Test-Path -LiteralPath (Join-Path $pgdata 'PG_VERSION'))) {
  $passwordFile = Join-Path $state 'initdb-password.tmp'
  'opening-local-test' | Set-Content -LiteralPath $passwordFile -Encoding UTF8
  try {
    & (Join-Path $pgbin 'initdb.exe') -D $pgdata -U opening --encoding=UTF8 --locale=C --auth=scram-sha-256 --pwfile=$passwordFile
    if ($LASTEXITCODE -ne 0) { throw 'Isolated initdb failed' }
  } finally { Remove-Item -LiteralPath $passwordFile -ErrorAction SilentlyContinue }
}
Start-OwnedService 'postgres' (Join-Path $pgbin 'postgres.exe') @('-D', "`"$pgdata`"", '-h','127.0.0.1','-p','15432') 15432
Invoke-WithLocalPostgres {
  foreach ($db in @('aistudy_opening_e2e','aistudy_opening_test')) {
    $exists = & (Join-Path $pgbin 'psql.exe') --no-password -h 127.0.0.1 -p 15432 -U opening -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'"
    if ($LASTEXITCODE -ne 0) { throw 'Isolated database probe failed' }
    if ($exists -ne '1') {
      & (Join-Path $pgbin 'createdb.exe') --no-password -h 127.0.0.1 -p 15432 -U opening $db
      if ($LASTEXITCODE -ne 0) { throw 'Creating isolated test database failed' }
    }
  }
}
$redisDir = Join-Path $state 'redis-data'
$minioDir = Join-Path $state 'objects'
New-Item -ItemType Directory -Path $redisDir,$minioDir -Force | Out-Null
Start-OwnedService 'redis' (Join-Path $root '.local/redis8/redis-server.exe') @('--bind','127.0.0.1','--port','16379','--dir',"`"$redisDir`"",'--appendonly','yes') 16379
$previousUser = $env:MINIO_ROOT_USER
$previousSecret = $env:MINIO_ROOT_PASSWORD
$previousCors = $env:MINIO_API_CORS_ALLOW_ORIGIN
try {
  $env:MINIO_API_CORS_ALLOW_ORIGIN = 'http://127.0.0.1:3100'
  $env:MINIO_ROOT_USER = 'opening-e2e'
  $env:MINIO_ROOT_PASSWORD = 'opening-e2e-local-secret'
  Start-OwnedService 'minio' (Join-Path $root '.local/minio.exe') @('server',"`"$minioDir`"",'--address','127.0.0.1:19000','--console-address','127.0.0.1:19001') 19000
} finally { $env:MINIO_ROOT_USER = $previousUser; $env:MINIO_ROOT_PASSWORD = $previousSecret; $env:MINIO_API_CORS_ALLOW_ORIGIN = $previousCors }
Write-Output 'Isolated services ready; existing development services were not changed.'
