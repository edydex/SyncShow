'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  normalizeGoogleDriveConfig
} = require('../src/services/google-drive/GoogleDriveConfig');

const CONFIG_PATH = path.resolve(__dirname, '../assets/google-drive-config.json');
const BUILD_OUTPUT_PATH = path.resolve(__dirname, '../dist');
const GENERATED_MARKER = 'syncshow-release-build-v1';

class GoogleDriveBuildConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoogleDriveBuildConfigError';
    this.code = code;
  }
}

async function pathType(targetPath) {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function releaseConfigFromEnvironment(env) {
  if (!env.SYNCSHOW_GOOGLE_CLIENT_ID
    || !env.SYNCSHOW_GOOGLE_CLIENT_SECRET
    || !env.SYNCSHOW_GOOGLE_API_KEY) {
    throw new GoogleDriveBuildConfigError(
      'MISSING_RELEASE_CREDENTIALS',
      'Official builds require all Google Drive release credentials.'
    );
  }
  const normalized = normalizeGoogleDriveConfig({}, { env });
  if (!normalized.clientId || !normalized.clientSecret || !normalized.apiKey) {
    throw new GoogleDriveBuildConfigError(
      'MISSING_RELEASE_CREDENTIALS',
      'Official builds require all Google Drive release credentials.'
    );
  }

  return {
    _generatedBy: GENERATED_MARKER,
    clientId: normalized.clientId,
    clientSecret: normalized.clientSecret,
    apiKey: normalized.apiKey
  };
}

async function injectGoogleDriveBuildConfig({
  env = process.env,
  configPath = CONFIG_PATH
} = {}) {
  if (await pathType(configPath) !== 'missing') {
    throw new GoogleDriveBuildConfigError(
      'CONFIG_ALREADY_EXISTS',
      'Refusing to replace an existing Google Drive configuration.'
    );
  }

  const releaseConfig = releaseConfigFromEnvironment(env);
  const directory = path.dirname(configPath);
  const temporaryPath = path.join(
    directory,
    `.google-drive-config.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );

  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(releaseConfig, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    // Linking instead of renaming gives us no-replace semantics on every
    // release runner: a file that appeared after the lstat check wins.
    await fs.link(temporaryPath, configPath);
    await fs.unlink(temporaryPath);
    if (process.platform !== 'win32') {
      await fs.chmod(configPath, 0o600);
    }
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }

  return configPath;
}

async function cleanGoogleDriveBuildConfig({
  configPath = CONFIG_PATH
} = {}) {
  const type = await pathType(configPath);
  if (type === 'missing') return false;
  if (type !== 'file') {
    throw new GoogleDriveBuildConfigError(
      'UNSAFE_CONFIG_PATH',
      'Refusing to remove a non-file Google Drive configuration path.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (_error) {
    throw new GoogleDriveBuildConfigError(
      'UNRECOGNIZED_CONFIG',
      'Refusing to remove an unrecognized Google Drive configuration.'
    );
  }

  if (parsed?._generatedBy !== GENERATED_MARKER) {
    throw new GoogleDriveBuildConfigError(
      'LOCAL_CONFIG_PRESERVED',
      'Refusing to remove a locally maintained Google Drive configuration.'
    );
  }

  await fs.unlink(configPath);
  return true;
}

async function findPackagedAppArchives(rootPath) {
  const archives = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (
        entry.isFile()
        && entry.name === 'app.asar'
        && path.basename(directory).toLowerCase() === 'resources'
      ) {
        archives.push(entryPath);
      } else if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }

  await visit(rootPath);
  return archives.sort();
}

function loadAsarModule() {
  try {
    return require('@electron/asar');
  } catch (_error) {
    const appBuilderRoot = path.dirname(require.resolve('app-builder-lib/package.json'));
    return require(require.resolve('@electron/asar', { paths: [appBuilderRoot] }));
  }
}

function matchingPackagedConfig(expected, actual) {
  return actual?._generatedBy === GENERATED_MARKER
    && actual.clientId === expected.clientId
    && actual.clientSecret === expected.clientSecret
    && actual.apiKey === expected.apiKey;
}

async function verifyPackagedGoogleDriveConfig({
  configPath = CONFIG_PATH,
  outputPath = BUILD_OUTPUT_PATH,
  asar = loadAsarModule()
} = {}) {
  let expected;
  try {
    expected = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (_error) {
    throw new GoogleDriveBuildConfigError(
      'GENERATED_CONFIG_MISSING',
      'The generated Google Drive release configuration is unavailable for verification.'
    );
  }
  if (expected?._generatedBy !== GENERATED_MARKER) {
    throw new GoogleDriveBuildConfigError(
      'GENERATED_CONFIG_MISSING',
      'The generated Google Drive release configuration is unavailable for verification.'
    );
  }

  const archives = await findPackagedAppArchives(outputPath);
  if (archives.length === 0) {
    throw new GoogleDriveBuildConfigError(
      'PACKAGED_APP_MISSING',
      'No packaged SyncShow application was found for Google Drive verification.'
    );
  }

  for (const archivePath of archives) {
    let packaged;
    try {
      packaged = JSON.parse(
        asar.extractFile(archivePath, 'assets/google-drive-config.json').toString('utf8')
      );
    } catch (_error) {
      throw new GoogleDriveBuildConfigError(
        'PACKAGED_CONFIG_MISSING',
        'A packaged SyncShow application is missing its Google Drive release configuration.'
      );
    }
    if (!matchingPackagedConfig(expected, packaged)) {
      throw new GoogleDriveBuildConfigError(
        'PACKAGED_CONFIG_MISMATCH',
        'A packaged SyncShow application has the wrong Google Drive release configuration.'
      );
    }
  }

  return archives.length;
}

async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    configPath = CONFIG_PATH,
    outputPath = BUILD_OUTPUT_PATH,
    stdout = process.stdout
  } = {}
) {
  const [action] = argv;
  if (action === 'inject') {
    await injectGoogleDriveBuildConfig({ env, configPath });
    stdout.write('Google Drive release configuration prepared.\n');
    return;
  }
  if (action === 'clean') {
    const removed = await cleanGoogleDriveBuildConfig({ configPath });
    stdout.write(
      removed
        ? 'Google Drive release configuration removed.\n'
        : 'No generated Google Drive release configuration was present.\n'
    );
    return;
  }
  if (action === 'verify') {
    const archiveCount = await verifyPackagedGoogleDriveConfig({
      configPath,
      outputPath
    });
    stdout.write(
      `Google Drive release configuration verified in ${archiveCount} packaged application(s).\n`
    );
    return;
  }

  throw new GoogleDriveBuildConfigError(
    'INVALID_ACTION',
    'Usage: node scripts/google-drive-build-config.js <inject|verify|clean>'
  );
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Google Drive build configuration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BUILD_OUTPUT_PATH,
  CONFIG_PATH,
  GENERATED_MARKER,
  GoogleDriveBuildConfigError,
  cleanGoogleDriveBuildConfig,
  findPackagedAppArchives,
  injectGoogleDriveBuildConfig,
  main,
  releaseConfigFromEnvironment,
  verifyPackagedGoogleDriveConfig
};
