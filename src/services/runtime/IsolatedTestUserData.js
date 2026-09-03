'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ISOLATED_TEST_USER_DATA_SWITCH = '--syncshow-test-user-data';
const ISOLATED_TEST_USER_DATA_ENV = 'SYNCSHOW_TEST_USER_DATA_DIR';
const ISOLATED_TEST_USER_DATA_MARKER = '.syncshow-isolated-test-user-data';
const MARKER_SOURCE = 'SyncShow isolated test user data v1\n';

function fail() {
  throw new Error('SyncShow could not activate its isolated test profile.');
}

function confinedChild(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return Boolean(relative)
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

function configureIsolatedTestUserData({
  app,
  argv = process.argv,
  env = process.env,
  fsModule = fs,
  temporaryRoot = os.tmpdir()
} = {}) {
  const enabled = Array.isArray(argv)
    && argv.includes(ISOLATED_TEST_USER_DATA_SWITCH);
  const requestedPath = env?.[ISOLATED_TEST_USER_DATA_ENV];

  if (!enabled && requestedPath === undefined) return Object.freeze({ active: false });
  if (
    !enabled
    || typeof requestedPath !== 'string'
    || !path.isAbsolute(requestedPath)
    || !app
    || typeof app.setPath !== 'function'
    || typeof app.isReady !== 'function'
    || app.isReady()
  ) {
    fail();
  }

  let rootPath;
  let profilePath;
  let profileStats;
  try {
    rootPath = fsModule.realpathSync(path.resolve(temporaryRoot));
    const requestedResolved = path.resolve(requestedPath);
    profileStats = fsModule.lstatSync(requestedResolved);
    if (profileStats.isSymbolicLink()) fail();
    profilePath = fsModule.realpathSync(requestedResolved);
  } catch (_error) {
    fail();
  }
  if (
    !confinedChild(rootPath, profilePath)
    || !profileStats.isDirectory()
    || profileStats.isSymbolicLink()
  ) {
    fail();
  }

  const markerPath = path.join(profilePath, ISOLATED_TEST_USER_DATA_MARKER);
  let entries;
  try {
    entries = fsModule.readdirSync(profilePath);
  } catch (_error) {
    fail();
  }
  if (!entries.includes(ISOLATED_TEST_USER_DATA_MARKER)) {
    if (entries.length !== 0) fail();
    try {
      fsModule.writeFileSync(markerPath, MARKER_SOURCE, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
    } catch (_error) {
      fail();
    }
  } else {
    let markerStats;
    let markerSource;
    try {
      markerStats = fsModule.lstatSync(markerPath);
      markerSource = fsModule.readFileSync(markerPath, 'utf8');
    } catch (_error) {
      fail();
    }
    if (
      !markerStats.isFile()
      || markerStats.isSymbolicLink()
      || markerSource !== MARKER_SOURCE
    ) {
      fail();
    }
  }

  try {
    if (process.platform !== 'win32') fsModule.chmodSync(profilePath, 0o700);
    app.setPath('userData', profilePath);
  } catch (_error) {
    fail();
  }
  return Object.freeze({ active: true });
}

module.exports = {
  ISOLATED_TEST_USER_DATA_ENV,
  ISOLATED_TEST_USER_DATA_MARKER,
  ISOLATED_TEST_USER_DATA_SWITCH,
  configureIsolatedTestUserData
};
