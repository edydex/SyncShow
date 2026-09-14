'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  ISOLATED_TEST_USER_DATA_ENV,
  ISOLATED_TEST_USER_DATA_MARKER,
  ISOLATED_TEST_USER_DATA_SWITCH,
  configureIsolatedTestUserData
} = require('../src/services/runtime/IsolatedTestUserData');

async function tempDirectory(t, prefix = 'syncshow-isolated-profile-test-') {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  return fsPromises.realpath(directory);
}

function fakeApp({ ready = false } = {}) {
  const calls = [];
  return {
    calls,
    isReady: () => ready,
    setPath: (name, value) => calls.push({ name, value })
  };
}

function activate(app, profilePath, overrides = {}) {
  return configureIsolatedTestUserData({
    app,
    argv: ['SyncShow', ISOLATED_TEST_USER_DATA_SWITCH],
    env: { [ISOLATED_TEST_USER_DATA_ENV]: profilePath },
    ...overrides
  });
}

test('ordinary launches do not change Electron user data', () => {
  const app = fakeApp();
  assert.deepEqual(
    configureIsolatedTestUserData({ app, argv: ['SyncShow'], env: {} }),
    { active: false }
  );
  assert.deepEqual(app.calls, []);
});

test('isolated mode requires both its explicit switch and absolute temp profile', async t => {
  const profilePath = await tempDirectory(t);
  assert.throws(
    () => configureIsolatedTestUserData({
      app: fakeApp(),
      argv: ['SyncShow'],
      env: { [ISOLATED_TEST_USER_DATA_ENV]: profilePath }
    }),
    /could not activate/
  );
  assert.throws(
    () => configureIsolatedTestUserData({
      app: fakeApp(),
      argv: ['SyncShow', ISOLATED_TEST_USER_DATA_SWITCH],
      env: {}
    }),
    /could not activate/
  );
  assert.throws(
    () => activate(fakeApp(), 'relative-profile'),
    /could not activate/
  );
});

test('an empty confined profile is marked, private, and reusable across restart', async t => {
  const profilePath = await tempDirectory(t);
  const firstApp = fakeApp();
  assert.deepEqual(activate(firstApp, profilePath), { active: true });
  assert.deepEqual(firstApp.calls, [{ name: 'userData', value: profilePath }]);
  assert.equal(
    await fsPromises.readFile(
      path.join(profilePath, ISOLATED_TEST_USER_DATA_MARKER),
      'utf8'
    ),
    'SyncShow isolated test user data v1\n'
  );
  if (process.platform !== 'win32') {
    assert.equal((await fsPromises.stat(profilePath)).mode & 0o077, 0);
  }

  await fsPromises.writeFile(path.join(profilePath, 'settings.json'), '{}\n');
  const restartedApp = fakeApp();
  assert.deepEqual(activate(restartedApp, profilePath), { active: true });
  assert.deepEqual(restartedApp.calls, [{ name: 'userData', value: profilePath }]);
});

test('unmarked nonempty, tampered, outside-temp, and late profiles fail closed', async t => {
  const unmarked = await tempDirectory(t);
  await fsPromises.writeFile(path.join(unmarked, 'settings.json'), '{}\n');
  assert.throws(() => activate(fakeApp(), unmarked), /could not activate/);

  const tampered = await tempDirectory(t);
  await fsPromises.writeFile(
    path.join(tampered, ISOLATED_TEST_USER_DATA_MARKER),
    'not a SyncShow marker\n'
  );
  assert.throws(() => activate(fakeApp(), tampered), /could not activate/);

  const outsideRoot = await tempDirectory(t);
  const differentRoot = await tempDirectory(t);
  assert.throws(
    () => activate(fakeApp(), outsideRoot, { temporaryRoot: differentRoot }),
    /could not activate/
  );
  assert.throws(
    () => activate(fakeApp({ ready: true }), outsideRoot),
    /could not activate/
  );
});

test('a symlinked profile is never accepted', async t => {
  if (process.platform === 'win32') return;
  const target = await tempDirectory(t);
  const parent = await tempDirectory(t);
  const linkPath = path.join(parent, 'profile-link');
  await fsPromises.symlink(target, linkPath, 'dir');
  assert.throws(() => activate(fakeApp(), linkPath), /could not activate/);
});

test('main configures isolation before Electron takes the single-instance lock', async () => {
  const mainSource = await fsPromises.readFile(
    path.join(__dirname, '..', 'main.js'),
    'utf8'
  );
  const configureIndex = mainSource.indexOf('configureIsolatedTestUserData({ app })');
  const lockIndex = mainSource.indexOf('app.requestSingleInstanceLock()');
  assert.ok(configureIndex > 0);
  assert.ok(lockIndex > configureIndex);
});
