param([string]$DistributionRoot = 'dist')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-IsolatedInstallPath([string]$RunnerTemporaryRoot, [string]$InstallRoot) {
  $root = [IO.Path]::GetFullPath($RunnerTemporaryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $target = [IO.Path]::GetFullPath($InstallRoot)
  $prefix = $root + [IO.Path]::DirectorySeparatorChar
  if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($target) -notmatch '^syncshow-installer-smoke-[a-f0-9]{32}$') {
    throw 'Installer smoke path must be its unique directory under RUNNER_TEMP.'
  }
}

function Invoke-BoundedInstaller([string]$Executable, [string]$Arguments, [int]$TimeoutMilliseconds = 300000) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Executable
  $info.Arguments = $Arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($info)
  try {
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      $process.Kill($true)
      throw 'The isolated NSIS installer operation timed out.'
    }
    if ($process.ExitCode -ne 0) { throw "NSIS operation failed with exit code $($process.ExitCode)." }
  } finally { $process.Dispose() }
}

# Dot-sourcing exposes only the path/process helpers to isolated contract tests.
if ($MyInvocation.InvocationName -eq '.') { return }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or -not $IsWindows -or -not $env:RUNNER_TEMP) {
  throw 'Actual installation smoke is restricted to disposable GitHub Windows runners.'
}
if (Get-Process -Name SyncShow -ErrorAction SilentlyContinue) { throw 'Refusing to replace a running SyncShow installation.' }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dist = [IO.Path]::GetFullPath((Join-Path $projectRoot $DistributionRoot))
$manifest = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$installer = Join-Path $dist "SyncShow Setup $($manifest.version).exe"
$originalReceiptPath = Join-Path $dist 'packaged-launch-win32-x64.json'
$originalReceiptBytes = [IO.File]::ReadAllBytes($originalReceiptPath)
$originalReceipt = [Text.Encoding]::UTF8.GetString($originalReceiptBytes) | ConvertFrom-Json
$unpackedRoot = Join-Path $dist 'win-unpacked'
$installRoot = Join-Path $env:RUNNER_TEMP ('syncshow-installer-smoke-' + [Guid]::NewGuid().ToString('N'))
Assert-IsolatedInstallPath $env:RUNNER_TEMP $installRoot
if (Test-Path -LiteralPath $installRoot) { throw 'The isolated install directory already exists.' }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The exact release installer is missing.' }

$installed = $false
$proof = $null
try {
  # NSIS requires /D to be last and unquoted, even when RUNNER_TEMP has spaces.
  # No --force-run: the installer must not launch the normal application profile.
  Invoke-BoundedInstaller $installer "/S /currentuser --no-desktop-shortcut /D=$installRoot"
  $installed = $true
  Assert-IsolatedInstallPath $env:RUNNER_TEMP $installRoot
  if (Get-Process -Name SyncShow -ErrorAction SilentlyContinue) { throw 'The silent installer unexpectedly launched the normal app profile.' }
  foreach ($relative in @('SyncShow.exe', 'resources/app.asar')) {
    $expected = Join-Path $unpackedRoot $relative
    $actual = Join-Path $installRoot $relative
    if (-not (Test-Path -LiteralPath $actual -PathType Leaf) -or
        (Get-FileHash -LiteralPath $actual -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash) {
      throw "NSIS installed payload differs from the checked package: $relative"
    }
  }
  $node = (Get-Command node -ErrorAction Stop).Source
  & $node (Join-Path $projectRoot 'scripts/verify-packaged-app-launch.js') --root $installRoot
  if ($LASTEXITCODE -ne 0) { throw 'The installed application failed its isolated launch smoke.' }
  $launch = Get-Content (Join-Path $installRoot 'packaged-launch-win32-x64.json') -Raw | ConvertFrom-Json
  if ($launch.launch -ne 'passed' -or $launch.isolatedProfile -ne 'confirmed-and-removed' -or
      $launch.archiveSha256 -ne $originalReceipt.archiveSha256 -or
      $launch.executableSha256 -ne $originalReceipt.executableSha256) {
    throw 'Installed application launch evidence differs from the exact package.'
  }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($originalReceiptPath)) -ne [Convert]::ToBase64String($originalReceiptBytes)) {
    throw 'Installer smoke changed the original publication launch receipt.'
  }
  $proof = @{ schemaVersion = 1; target = 'win32-x64'; installer = [IO.Path]::GetFileName($installer);
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant();
    archiveSha256 = $launch.archiveSha256; executableSha256 = $launch.executableSha256;
    installedLaunch = 'passed'; isolatedProfile = 'confirmed-and-removed' }
} finally {
  Assert-IsolatedInstallPath $env:RUNNER_TEMP $installRoot
  # Kill only a process from this exact temporary install, if a failed launch
  # left one behind. Never use a global taskkill by application name.
  Get-Process -Name SyncShow -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Path -and [IO.Path]::GetFullPath($_.Path).Equals((Join-Path $installRoot 'SyncShow.exe'), [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
  $uninstaller = Join-Path $installRoot 'Uninstall SyncShow.exe'
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    # Explicitly keep application data. _?= disables NSIS's asynchronous
    # self-copy so the bounded process wait covers actual uninstallation.
    Invoke-BoundedInstaller $uninstaller "/S /currentuser /KEEP_APP_DATA _?=$installRoot" 120000
  } elseif ($installed) { throw 'The isolated NSIS uninstaller is missing.' }
  if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
  if (Test-Path -LiteralPath $installRoot) { throw 'The isolated install tree was not cleaned.' }
}

$proof.cleanup = 'uninstalled-and-removed'
$proof | ConvertTo-Json -Depth 5
