'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const scriptPath = path.resolve(__dirname, '../scripts/verify-windows-installer.ps1');

test('Windows installer smoke uses a disposable current-user install, isolated app launch, and bounded cleanup', async () => {
  const source = await fs.readFile(scriptPath, 'utf8');
  assert.match(source, /GITHUB_ACTIONS -ne 'true'/);
  assert.match(source, /RUNNER_OS -ne 'Windows'/);
  assert.match(source, /Get-Process -Name SyncShow[^\n]+throw/);
  assert.match(source, /syncshow-installer-smoke-/);
  assert.match(source, /\/S \/currentuser --no-desktop-shortcut \/D=\$installRoot"/);
  assert.doesNotMatch(source, /["'](?:\/S[^"']*)--force-run/);
  assert.match(source, /verify-packaged-app-launch\.js'\) --root \$installRoot/);
  assert.match(source, /\$LASTEXITCODE -ne 0/);
  assert.match(source, /Get-FileHash -LiteralPath \$actual/);
  assert.match(source, /installed payload differs/);
  assert.match(source, /\/KEEP_APP_DATA _\?=\$installRoot/);
  assert.match(source, /WaitForExit\(\$TimeoutMilliseconds\)/);
  assert.match(source, /\$process\.Kill\(\$true\)/);
  assert.match(source, /finally \{/);
  assert.match(source, /Stop-Process -Id \$_\.Id/);
  assert.doesNotMatch(source, /taskkill\s+\/IM|Stop-Process\s+-Name/);
  assert.match(source, /Remove-Item -LiteralPath \$installRoot -Recurse -Force/);
  assert.match(source, /changed the original publication launch receipt/);
});

test('PowerShell installer smoke parses and its path guard rejects broad or neighboring cleanup targets', t => {
  const code = `
    $tokens=$null; $errors=$null
    [System.Management.Automation.Language.Parser]::ParseFile($env:SYNCSHOW_SMOKE_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null
    if($errors.Count) { throw ($errors | Out-String) }
    . $env:SYNCSHOW_SMOKE_SCRIPT
    $root=[IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar)
    $good=Join-Path $root ('syncshow-installer-smoke-' + ('a' * 32))
    Assert-IsolatedInstallPath $root $good
    foreach($bad in @($root,(Join-Path $root 'other-app'),($root+'-neighbor'+[IO.Path]::DirectorySeparatorChar+[IO.Path]::GetFileName($good)))) {
      $rejected=$false
      try { Assert-IsolatedInstallPath $root $bad } catch { $rejected=$true }
      if(-not $rejected) { throw 'Unsafe cleanup target was accepted' }
    }
    Write-Output 'SYNCSHOW_INSTALLER_GUARD_OK'
  `;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', code], {
    env: { ...process.env, SYNCSHOW_SMOKE_SCRIPT: scriptPath }, encoding: 'utf8', timeout: 15000
  });
  if (result.error?.code === 'ENOENT') { t.skip('PowerShell is exercised by the Windows release runner.'); return; }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /SYNCSHOW_INSTALLER_GUARD_OK/);
});

test('stable Windows release checks the actual installer after unpacked launch and before upload', async () => {
  const workflow = yaml.load(await fs.readFile(path.resolve(__dirname, '../.github/workflows/build.yml'), 'utf8'));
  const steps = workflow.jobs['build-windows'].steps;
  const launch = steps.findIndex(step => step.run?.includes('build:verify-app-launch'));
  const installed = steps.findIndex(step => step.run?.includes('verify-windows-installer.ps1'));
  const upload = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4');
  assert.ok(launch >= 0 && installed > launch && installed < upload);
  assert.match(steps[installed].run, /-DistributionRoot dist/);
});
