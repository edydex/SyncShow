'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const asar = require('@electron/asar');
const {
  GENERATED_MARKER,
  cleanGoogleDriveBuildConfig,
  injectGoogleDriveBuildConfig,
  main,
  verifyPackagedGoogleDriveConfig
} = require('../scripts/google-drive-build-config');

const CLIENT_ID = '123456789012-release.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-release-test-desktop-credential';
const API_KEY = 'AIzaSyReleaseBuildKey_1234567890';

async function temporaryConfig(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-drive-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'assets', 'google-drive-config.json');
}

test('release credentials are written without logging and generated config can be cleaned', async t => {
  const configPath = await temporaryConfig(t);
  const output = [];
  await main(
    ['inject'],
    {
      configPath,
      env: {
        SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
        SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
        SYNCSHOW_GOOGLE_API_KEY: API_KEY
      },
      stdout: { write: value => output.push(value) }
    }
  );

  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(config, {
    _generatedBy: GENERATED_MARKER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    apiKey: API_KEY
  });
  if (process.platform !== 'win32') {
    const mode = (await fs.stat(configPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  assert.doesNotMatch(output.join(''), new RegExp(CLIENT_ID));
  assert.doesNotMatch(output.join(''), new RegExp(CLIENT_SECRET));
  assert.doesNotMatch(output.join(''), new RegExp(API_KEY));

  assert.equal(await cleanGoogleDriveBuildConfig({ configPath }), true);
  await assert.rejects(fs.access(configPath), { code: 'ENOENT' });
  assert.equal(await cleanGoogleDriveBuildConfig({ configPath }), false);
});

test('official-build injection fails closed if any release credential is missing', async t => {
  const configPath = await temporaryConfig(t);
  const completeEnvironment = {
    SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
    SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    SYNCSHOW_GOOGLE_API_KEY: API_KEY
  };
  for (const missing of Object.keys(completeEnvironment)) {
    const env = { ...completeEnvironment };
    delete env[missing];
    await assert.rejects(
      injectGoogleDriveBuildConfig({ configPath, env }),
      error => error.code === 'MISSING_RELEASE_CREDENTIALS'
    );
    await assert.rejects(fs.access(configPath), { code: 'ENOENT' });
  }
});

test('injection and cleanup preserve a developer-maintained local config', async t => {
  const configPath = await temporaryConfig(t);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const localConfig = `${JSON.stringify({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    apiKey: API_KEY
  })}\n`;
  await fs.writeFile(configPath, localConfig, { mode: 0o600 });

  await assert.rejects(
    injectGoogleDriveBuildConfig({
      configPath,
      env: {
        SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
        SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
        SYNCSHOW_GOOGLE_API_KEY: API_KEY
      }
    }),
    error => error.code === 'CONFIG_ALREADY_EXISTS'
  );
  await assert.rejects(
    cleanGoogleDriveBuildConfig({ configPath }),
    error => error.code === 'LOCAL_CONFIG_PRESERVED'
  );
  assert.equal(await fs.readFile(configPath, 'utf8'), localConfig);
});

test('packaged app verification requires the exact generated config without printing it', async t => {
  const configPath = await temporaryConfig(t);
  await injectGoogleDriveBuildConfig({
    configPath,
    env: {
      SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
      SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      SYNCSHOW_GOOGLE_API_KEY: API_KEY
    }
  });

  const root = path.dirname(path.dirname(configPath));
  const applicationSource = path.join(root, 'application-source');
  const outputPath = path.join(root, 'dist');
  const archivePath = path.join(
    outputPath,
    'mac-arm64',
    'SyncShow.app',
    'Contents',
    'Resources',
    'app.asar'
  );
  await fs.mkdir(path.join(applicationSource, 'assets'), { recursive: true });
  await fs.copyFile(
    configPath,
    path.join(applicationSource, 'assets', 'google-drive-config.json')
  );
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(applicationSource, archivePath);

  assert.equal(
    await verifyPackagedGoogleDriveConfig({ configPath, outputPath, asar }),
    1
  );

  const output = [];
  await main(
    ['verify'],
    {
      configPath,
      outputPath,
      stdout: { write: value => output.push(value) }
    }
  );
  assert.doesNotMatch(output.join(''), new RegExp(CLIENT_ID));
  assert.doesNotMatch(output.join(''), new RegExp(CLIENT_SECRET));
  assert.doesNotMatch(output.join(''), new RegExp(API_KEY));
});

test('packaged app verification fails when the generated config is missing from an archive', async t => {
  const configPath = await temporaryConfig(t);
  await injectGoogleDriveBuildConfig({
    configPath,
    env: {
      SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
      SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      SYNCSHOW_GOOGLE_API_KEY: API_KEY
    }
  });

  const root = path.dirname(path.dirname(configPath));
  const applicationSource = path.join(root, 'application-without-drive-config');
  const outputPath = path.join(root, 'dist');
  const archivePath = path.join(
    outputPath,
    'win-unpacked',
    'resources',
    'app.asar'
  );
  await fs.mkdir(applicationSource, { recursive: true });
  await fs.writeFile(path.join(applicationSource, 'package.json'), '{}\n');
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(applicationSource, archivePath);

  await assert.rejects(
    verifyPackagedGoogleDriveConfig({ configPath, outputPath, asar }),
    error => error.code === 'PACKAGED_CONFIG_MISSING'
  );
});

test('packaged app verification rejects a mismatched client secret without echoing either value', async t => {
  const configPath = await temporaryConfig(t);
  await injectGoogleDriveBuildConfig({
    configPath,
    env: {
      SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
      SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      SYNCSHOW_GOOGLE_API_KEY: API_KEY
    }
  });

  const mismatchedSecret = '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l';
  const root = path.dirname(path.dirname(configPath));
  const applicationSource = path.join(root, 'application-with-wrong-drive-config');
  const outputPath = path.join(root, 'dist');
  const archivePath = path.join(outputPath, 'win-unpacked', 'resources', 'app.asar');
  await fs.mkdir(path.join(applicationSource, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(applicationSource, 'assets', 'google-drive-config.json'),
    `${JSON.stringify({
      _generatedBy: GENERATED_MARKER,
      clientId: CLIENT_ID,
      clientSecret: mismatchedSecret,
      apiKey: API_KEY
    })}\n`
  );
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(applicationSource, archivePath);

  await assert.rejects(
    verifyPackagedGoogleDriveConfig({ configPath, outputPath, asar }),
    error => {
      assert.equal(error.code, 'PACKAGED_CONFIG_MISMATCH');
      assert.doesNotMatch(error.message, new RegExp(CLIENT_SECRET));
      assert.doesNotMatch(error.message, new RegExp(mismatchedSecret));
      return true;
    }
  );
});

test('release workflow scopes secrets to injection and always removes generated config', async () => {
  const workflow = await fs.readFile(
    path.resolve(__dirname, '../.github/workflows/build.yml'),
    'utf8'
  );
  const clientIdBindings = workflow.match(
    /SYNCSHOW_GOOGLE_CLIENT_ID:\s*\$\{\{\s*secrets\.SYNCSHOW_GOOGLE_CLIENT_ID\s*\}\}/g
  ) || [];
  const clientSecretBindings = workflow.match(
    /SYNCSHOW_GOOGLE_CLIENT_SECRET:\s*\$\{\{\s*secrets\.SYNCSHOW_GOOGLE_CLIENT_SECRET\s*\}\}/g
  ) || [];
  const apiKeyBindings = workflow.match(
    /SYNCSHOW_GOOGLE_API_KEY:\s*\$\{\{\s*secrets\.SYNCSHOW_GOOGLE_API_KEY\s*\}\}/g
  ) || [];

  assert.equal(clientIdBindings.length, 3, 'one OAuth client ID binding per platform build');
  assert.equal(clientSecretBindings.length, 3, 'one OAuth client secret binding per platform build');
  assert.equal(apiKeyBindings.length, 3, 'one API key binding per platform build');
  assert.equal(
    (
      workflow.match(/node scripts\/google-drive-build-config\.js inject/g) || []
    ).length,
    3,
    'each platform must generate its config immediately before packaging'
  );
  assert.equal(
    (
      workflow.match(/node scripts\/google-drive-build-config\.js clean/g) || []
    ).length,
    3,
    'each platform must remove its generated config'
  );
  assert.equal(
    (workflow.match(/if:\s*always\(\)/g) || []).length,
    3,
    'cleanup must run even when packaging fails'
  );
  assert.equal(
    (
      workflow.match(/node scripts\/google-drive-build-config\.js verify/g) || []
    ).length,
    3,
    'each platform must verify the generated config was packaged'
  );
  assert.match(workflow, /^permissions:\n\s+contents:\s+read$/m);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
  assert.equal(
    (workflow.match(/^\s+environment:\s+release-build$/gm) || []).length,
    3,
    'Drive credentials must come from the protected release environment'
  );
  assert.equal(
    (
      workflow.match(
        /if: needs\.check-version\.outputs\.version_changed == 'true' && github\.ref == 'refs\/heads\/main'/g
      ) || []
    ).length,
    4,
    'platform builds and release publication must reject non-main dispatches'
  );

  const preparationSteps = workflow.match(
    /- name: Prepare Google Drive release configuration[\s\S]*?(?=\n\s+- name:)/g
  ) || [];
  assert.equal(preparationSteps.length, 3);
  for (const step of preparationSteps) {
    assert.match(step, /secrets\.SYNCSHOW_GOOGLE_CLIENT_ID/);
    assert.match(step, /secrets\.SYNCSHOW_GOOGLE_CLIENT_SECRET/);
    assert.match(step, /secrets\.SYNCSHOW_GOOGLE_API_KEY/);
  }

  const packagingSteps = workflow.match(
    /- name: Build (?:Windows|macOS|Linux)[\s\S]*?(?=\n\s+- name:)/g
  ) || [];
  assert.equal(packagingSteps.length, 3);
  for (const step of packagingSteps) {
    assert.doesNotMatch(step, /SYNCSHOW_GOOGLE_(?:CLIENT_ID|CLIENT_SECRET|API_KEY)/);
    assert.doesNotMatch(step, /secrets\./);
  }

  const buildJobs = workflow.match(
    /^  build-(?:windows|mac|linux):[\s\S]*?(?=^  (?:build-|create-release:))/gm
  ) || [];
  assert.equal(buildJobs.length, 3);
  for (const job of buildJobs) {
    const prepare = job.indexOf('Prepare Google Drive release configuration');
    const build = job.search(/Build (?:Windows|macOS|Linux) installer|Build Linux packages/);
    const verify = job.indexOf('Verify Google Drive release configuration was packaged');
    const cleanup = job.indexOf('Remove Google Drive release configuration');
    const upload = job.search(/Upload (?:Windows|macOS|Linux) artifact/);
    assert.ok(prepare >= 0 && prepare < build);
    assert.ok(build < verify && verify < cleanup);
    assert.ok(cleanup < upload);
  }

  const pullRequestWorkflow = await fs.readFile(
    path.resolve(__dirname, '../.github/workflows/ci.yml'),
    'utf8'
  );
  assert.match(pullRequestWorkflow, /^\s+pull_request:/m);
  assert.doesNotMatch(pullRequestWorkflow, /secrets\.SYNCSHOW_GOOGLE_/);
});

test('real build config remains ignored while the placeholder example remains source-controlled', async () => {
  const ignore = await fs.readFile(path.resolve(__dirname, '../.gitignore'), 'utf8');
  const example = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, '../assets/google-drive-config.example.json'),
      'utf8'
    )
  );

  assert.match(ignore, /^assets\/google-drive-config\.json$/m);
  assert.match(example.clientId, /YOUR_DESKTOP_OAUTH_CLIENT_ID/);
  assert.match(example.clientSecret, /YOUR_DESKTOP_OAUTH_CLIENT_SECRET/);
  assert.match(example.apiKey, /YOUR_DRIVE_API_RESTRICTED_KEY/);
});
