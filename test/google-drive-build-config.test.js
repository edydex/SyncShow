'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const asar = require('@electron/asar');
const {
  doMergeConfigs
} = require('app-builder-lib/out/util/config/config');
const {
  GENERATED_MARKER,
  cleanGoogleDriveBuildConfig,
  injectGoogleDriveBuildConfig,
  main,
  verifyPackagedGoogleDriveConfig
} = require('../scripts/google-drive-build-config');
const {
  CONFIG_EXCLUSION,
  RELEASE_PACKAGE_FLAG,
  prepareGoogleDrivePackaging
} = require('../scripts/beforePack');

const CLIENT_ID = '123456789012-release.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-release-test-desktop-credential';
const API_KEY = 'AIzaSyReleaseBuildKey_1234567890';

async function temporaryConfig(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-drive-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'assets', 'google-drive-config.json');
}

function packagingContext({ normalized = false } = {}) {
  const rules = [
    'main.js',
    'assets/**/*',
    CONFIG_EXCLUSION,
    'node_modules/**/*'
  ];
  return {
    packager: {
      config: {
        files: normalized ? doMergeConfigs([{ files: rules }]).files : rules
      }
    }
  };
}

function packagingRules(context) {
  const [first] = context.packager.config.files;
  return typeof first === 'string'
    ? context.packager.config.files
    : first.filter;
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

test('ordinary packaging always keeps Google Drive configuration excluded', async t => {
  const configPath = await temporaryConfig(t);
  const missingContext = packagingContext();
  assert.deepEqual(
    await prepareGoogleDrivePackaging(missingContext, {
      env: {},
      configPath
    }),
    { googleDriveConfigIncluded: false }
  );
  assert.ok(packagingRules(missingContext).includes(CONFIG_EXCLUSION));

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify({
      _generatedBy: GENERATED_MARKER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiKey: API_KEY
    })}\n`,
    { mode: 0o600 }
  );
  const generatedContext = packagingContext();
  await prepareGoogleDrivePackaging(generatedContext, {
    env: {},
    configPath
  });
  assert.ok(packagingRules(generatedContext).includes(CONFIG_EXCLUSION));
});

test('ordinary packaging accepts electron-builder normalized file rules', async t => {
  const configPath = await temporaryConfig(t);
  const context = packagingContext({ normalized: true });
  assert.deepEqual(
    await prepareGoogleDrivePackaging(context, { env: {}, configPath }),
    { googleDriveConfigIncluded: false }
  );
  assert.ok(packagingRules(context).includes(CONFIG_EXCLUSION));
});

test('release packaging includes only the exact generated Google Drive config', async t => {
  const configPath = await temporaryConfig(t);
  await injectGoogleDriveBuildConfig({
    configPath,
    env: {
      SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
      SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      SYNCSHOW_GOOGLE_API_KEY: API_KEY
    }
  });
  const context = packagingContext();
  const env = { [RELEASE_PACKAGE_FLAG]: '1' };

  assert.deepEqual(
    await prepareGoogleDrivePackaging(context, { env, configPath }),
    { googleDriveConfigIncluded: true }
  );
  assert.ok(!packagingRules(context).includes(CONFIG_EXCLUSION));
  assert.deepEqual(
    await prepareGoogleDrivePackaging(context, { env, configPath }),
    { googleDriveConfigIncluded: true },
    'multi-architecture hook calls must be idempotent'
  );
});

test('release packaging mutates normalized file rules idempotently', async t => {
  const configPath = await temporaryConfig(t);
  await injectGoogleDriveBuildConfig({
    configPath,
    env: {
      SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
      SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      SYNCSHOW_GOOGLE_API_KEY: API_KEY
    }
  });
  const context = packagingContext({ normalized: true });
  const env = { [RELEASE_PACKAGE_FLAG]: '1' };

  await prepareGoogleDrivePackaging(context, { env, configPath });
  assert.ok(!packagingRules(context).includes(CONFIG_EXCLUSION));
  assert.deepEqual(
    await prepareGoogleDrivePackaging(context, { env, configPath }),
    { googleDriveConfigIncluded: true }
  );
});

test('release packaging rejects missing, local, malformed, and unsafe configs without exposing values', async t => {
  const configPath = await temporaryConfig(t);
  const env = { [RELEASE_PACKAGE_FLAG]: '1' };
  await assert.rejects(
    prepareGoogleDrivePackaging(packagingContext(), { env, configPath }),
    error => error.code === 'GENERATED_CONFIG_MISSING'
  );

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiKey: API_KEY
    })}\n`,
    { mode: 0o600 }
  );
  await assert.rejects(
    prepareGoogleDrivePackaging(packagingContext(), { env, configPath }),
    error => {
      assert.equal(error.code, 'UNRECOGNIZED_CONFIG');
      assert.doesNotMatch(error.message, new RegExp(CLIENT_ID));
      assert.doesNotMatch(error.message, new RegExp(CLIENT_SECRET));
      assert.doesNotMatch(error.message, new RegExp(API_KEY));
      return true;
    }
  );

  await fs.writeFile(configPath, '{not json}\n', { mode: 0o600 });
  await assert.rejects(
    prepareGoogleDrivePackaging(packagingContext(), { env, configPath }),
    error => error.code === 'UNRECOGNIZED_CONFIG'
  );

  if (process.platform !== 'win32') {
    const targetPath = `${configPath}.target`;
    await fs.writeFile(
      targetPath,
      `${JSON.stringify({
        _generatedBy: GENERATED_MARKER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        apiKey: API_KEY
      })}\n`,
      { mode: 0o600 }
    );
    await fs.unlink(configPath);
    await fs.symlink(targetPath, configPath);
    await assert.rejects(
      prepareGoogleDrivePackaging(packagingContext(), { env, configPath }),
      error => error.code === 'UNSAFE_CONFIG_PATH'
    );
  }
});

test('package manifest keeps the local credential exclusion behind the global hook', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.resolve(__dirname, '../package.json'), 'utf8')
  );
  assert.equal(packageJson.build.beforePack, 'scripts/beforePack.js');
  const assetsIndex = packageJson.build.files.lastIndexOf('assets/**/*');
  const exclusionIndex = packageJson.build.files.lastIndexOf(CONFIG_EXCLUSION);
  assert.ok(assetsIndex >= 0);
  assert.ok(exclusionIndex > assetsIndex);
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

test('public native-service release builds omit optional Drive credentials', async () => {
  const workflow=await fs.readFile(path.resolve(__dirname,'../.github/workflows/build.yml'),'utf8');
  assert.doesNotMatch(workflow,/secrets\.SYNCSHOW_GOOGLE_|SYNCSHOW_PACKAGE_GOOGLE_DRIVE_CONFIG/);
  assert.doesNotMatch(workflow,/google-drive-build-config\.js (inject|verify|clean)/);
  assert.match(workflow,/contents: read/);
  assert.doesNotMatch(workflow,/^\s+pull_request:/m);
  assert.equal((workflow.match(/if: needs\.check-version\.outputs\.version_changed == 'true' && github\.ref == 'refs\/heads\/main'/g)||[]).length,5);
  assert.equal((workflow.match(/name: Download exact dependency source materials/g)||[]).length,3);
  assert.equal((workflow.match(/name: Enforce public-release legal materials/g)||[]).length,3);
  assert.match(workflow,/Direct Google Drive integration is optional/);
  const qa=await fs.readFile(path.resolve(__dirname,'../.github/workflows/ci.yml'),'utf8');
  assert.match(qa,/^\s+pull_request:/m);
  assert.doesNotMatch(qa,/secrets\.SYNCSHOW_GOOGLE_/);
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
