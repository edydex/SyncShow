'use strict';

const fs = require('node:fs/promises');
const {
  CONFIG_PATH,
  GENERATED_MARKER,
  GoogleDriveBuildConfigError
} = require('./google-drive-build-config');
const {
  normalizeGoogleDriveConfig
} = require('../src/services/google-drive/GoogleDriveConfig');

const CONFIG_EXCLUSION = '!assets/google-drive-config.json';
const RELEASE_PACKAGE_FLAG = 'SYNCSHOW_PACKAGE_GOOGLE_DRIVE_CONFIG';
const MAX_CONFIG_BYTES = 16 * 1024;
const releaseConfiguredContexts = new WeakSet();

function fail(code, message) {
  throw new GoogleDriveBuildConfigError(code, message);
}

function packagingConfig(context) {
  const config = context?.packager?.config;
  if (!config || typeof config !== 'object' || !Array.isArray(config.files)) {
    fail(
      'UNSAFE_PACKAGE_FILES',
      'Packaging must use the reviewed SyncShow file manifest.'
    );
  }
  return config;
}

function reviewedFileRules(files) {
  if (files.every(entry => typeof entry === 'string')) return files;

  // electron-builder normalizes a string-only files manifest to one FileSet
  // before invoking beforePack. Keep accepting the source form for focused
  // tests, but only accept the exact normalized shape produced for this
  // reviewed manifest.
  if (
    files.length === 1
    && files[0]
    && typeof files[0] === 'object'
    && !Array.isArray(files[0])
    && Object.keys(files[0]).every(key => key === 'filter')
    && Array.isArray(files[0].filter)
    && files[0].filter.every(entry => typeof entry === 'string')
  ) {
    return files[0].filter;
  }

  fail(
    'UNSAFE_PACKAGE_FILES',
    'Packaging must use the reviewed SyncShow file manifest.'
  );
}

function requiredConfigExclusion(files) {
  const rules = reviewedFileRules(files);
  const exclusionIndexes = [];
  for (let index = 0; index < rules.length; index += 1) {
    if (rules[index] === CONFIG_EXCLUSION) exclusionIndexes.push(index);
  }
  const assetsIndex = rules.lastIndexOf('assets/**/*');
  if (
    assetsIndex < 0
    || exclusionIndexes.length !== 1
    || exclusionIndexes[0] <= assetsIndex
  ) {
    fail(
      'UNSAFE_PACKAGE_FILES',
      'Packaging must exclude the local Google Drive configuration by default.'
    );
  }
  return {
    rules,
    exclusionIndex: exclusionIndexes[0]
  };
}

function requireAuthorizedReleaseManifest(files) {
  const rules = reviewedFileRules(files);
  if (
    rules.filter(entry => entry === 'assets/**/*').length !== 1
    || rules.includes(CONFIG_EXCLUSION)
  ) {
    fail(
      'UNSAFE_PACKAGE_FILES',
      'The release packaging manifest changed after it was authorized.'
    );
  }
}

async function readGeneratedReleaseConfig(configPath) {
  let stat;
  try {
    stat = await fs.lstat(configPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(
        'GENERATED_CONFIG_MISSING',
        'The generated Google Drive release configuration is unavailable for packaging.'
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
    fail(
      'UNSAFE_CONFIG_PATH',
      'The Google Drive release configuration is not a safe generated file.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (_error) {
    fail(
      'UNRECOGNIZED_CONFIG',
      'The Google Drive release configuration is not a recognized generated file.'
    );
  }
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.keys(parsed).sort()
    : [];
  if (
    parsed?._generatedBy !== GENERATED_MARKER
    || keys.join(',') !== '_generatedBy,apiKey,clientId,clientSecret'
  ) {
    fail(
      'UNRECOGNIZED_CONFIG',
      'The Google Drive release configuration is not a recognized generated file.'
    );
  }

  let normalized;
  try {
    normalized = normalizeGoogleDriveConfig(parsed, { env: {} });
  } catch (_error) {
    fail(
      'UNRECOGNIZED_CONFIG',
      'The Google Drive release configuration is not a recognized generated file.'
    );
  }
  if (
    !normalized.clientId
    || !normalized.clientSecret
    || !normalized.apiKey
    || normalized.clientIdSource !== 'file'
    || normalized.clientSecretSource !== 'file'
    || normalized.apiKeySource !== 'file'
    || normalized.clientId !== parsed.clientId
    || normalized.clientSecret !== parsed.clientSecret
    || normalized.apiKey !== parsed.apiKey
  ) {
    fail(
      'UNRECOGNIZED_CONFIG',
      'The Google Drive release configuration is not a recognized generated file.'
    );
  }
}

async function prepareGoogleDrivePackaging(
  context,
  {
    env = process.env,
    configPath = CONFIG_PATH
  } = {}
) {
  const config = packagingConfig(context);
  const releaseMode = env[RELEASE_PACKAGE_FLAG];
  if (releaseMode !== undefined && releaseMode !== '' && releaseMode !== '1') {
    fail(
      'INVALID_RELEASE_PACKAGE_FLAG',
      'The Google Drive release packaging flag is invalid.'
    );
  }

  if (releaseMode !== '1') {
    requiredConfigExclusion(config.files);
    return { googleDriveConfigIncluded: false };
  }

  await readGeneratedReleaseConfig(configPath);
  if (releaseConfiguredContexts.has(config)) {
    requireAuthorizedReleaseManifest(config.files);
    return { googleDriveConfigIncluded: true };
  }

  const { rules, exclusionIndex } = requiredConfigExclusion(config.files);
  rules.splice(exclusionIndex, 1);
  releaseConfiguredContexts.add(config);
  return { googleDriveConfigIncluded: true };
}

async function beforePack(context) {
  await prepareGoogleDrivePackaging(context);
}

module.exports = beforePack;
module.exports.CONFIG_EXCLUSION = CONFIG_EXCLUSION;
module.exports.RELEASE_PACKAGE_FLAG = RELEASE_PACKAGE_FLAG;
module.exports.beforePack = beforePack;
module.exports.prepareGoogleDrivePackaging = prepareGoogleDrivePackaging;
module.exports.readGeneratedReleaseConfig = readGeneratedReleaseConfig;
