'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  GoogleDriveConfigError,
  loadGoogleDriveConfig,
  normalizeGoogleDriveConfig,
  sanitizeGoogleDriveConfig
} = require('../src/services/google-drive/GoogleDriveConfig');
const {
  GoogleDriveLinkError,
  parseGoogleDriveFolderLink
} = require('../src/services/google-drive/DriveLink');

const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-desktop-client-credential';
const API_KEY = 'AIzaSyDUMMY_KEY_FOR_SYNCSHOW_TESTING_123456';

test('Google Drive config loads an optional file and lets environment values override it', async () => {
  const configPath = path.resolve('/tmp/google-drive-config.json');
  const config = await loadGoogleDriveConfig({
    configPath,
    env: {
      SYNCSHOW_GOOGLE_CLIENT_ID: CLIENT_ID,
      SYNCSHOW_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      SYNCSHOW_GOOGLE_API_KEY: API_KEY
    },
    readFile: async candidate => {
      assert.equal(candidate, configPath);
      return Buffer.from(JSON.stringify({
        clientId: '999999999999-file.apps.googleusercontent.com',
        clientSecret: 'file-desktop-client-credential',
        apiKey: 'AIza_FILE_ONLY_KEY_1234567890123456789'
      }));
    }
  });

  assert.equal(config.clientId, CLIENT_ID);
  assert.equal(config.clientSecret, CLIENT_SECRET);
  assert.equal(config.apiKey, API_KEY);
  assert.equal(config.clientIdSource, 'environment');
  assert.equal(config.clientSecretSource, 'environment');
  assert.equal(config.apiKeySource, 'environment');
  assert.deepEqual(sanitizeGoogleDriveConfig(config), {
    oauthConfigured: true,
    publicAccessConfigured: true
  });
  assert.equal(JSON.stringify(sanitizeGoogleDriveConfig(config)).includes(CLIENT_SECRET), false);
  assert.equal(JSON.stringify(sanitizeGoogleDriveConfig(config)).includes(API_KEY), false);
});

test('Google Drive config keeps native client secrets optional, bounded, and main-only', async () => {
  const missing = await loadGoogleDriveConfig({
    configPath: path.resolve('/tmp/missing-google-drive-config.json'),
    env: {},
    readFile: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  });
  assert.equal(missing.oauthConfigured, false);
  assert.equal(missing.publicAccessConfigured, false);

  const secretless = normalizeGoogleDriveConfig({ clientId: CLIENT_ID }, { env: {} });
  assert.equal(secretless.clientSecret, null);
  assert.equal(secretless.oauthConfigured, true);

  const configured = normalizeGoogleDriveConfig({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  }, { env: {} });
  assert.equal(configured.clientSecret, CLIENT_SECRET);
  assert.equal(configured.clientSecretSource, 'file');
  assert.deepEqual(sanitizeGoogleDriveConfig(configured), {
    oauthConfigured: true,
    publicAccessConfigured: false
  });
  assert.equal(JSON.stringify(sanitizeGoogleDriveConfig(configured)).includes(CLIENT_SECRET), false);

  assert.throws(
    () => normalizeGoogleDriveConfig({ clientSecret: CLIENT_SECRET }, { env: {} }),
    error => error instanceof GoogleDriveConfigError && error.code === 'INVALID_CLIENT_SECRET'
  );
  for (const invalidSecret of [
    42,
    'short',
    ` ${CLIENT_SECRET}`,
    'line\nbreak',
    'unicode-\u2603',
    'x'.repeat(1025)
  ]) {
    assert.throws(
      () => normalizeGoogleDriveConfig({
        clientId: CLIENT_ID,
        clientSecret: invalidSecret
      }, { env: {} }),
      error => error instanceof GoogleDriveConfigError && error.code === 'INVALID_CONFIG'
    );
  }
  assert.throws(
    () => normalizeGoogleDriveConfig({ clientId: 'web-client.example.com' }, { env: {} }),
    error => error.code === 'INVALID_CLIENT_ID'
  );
  assert.throws(
    () => normalizeGoogleDriveConfig({ apiKey: 'short' }, { env: {} }),
    error => error.code === 'INVALID_API_KEY'
  );
});

test('public folder links accept canonical sharing forms and preserve resource keys', () => {
  assert.deepEqual(
    parseGoogleDriveFolderLink(
      'https://drive.google.com/drive/folders/13wdKhswg4tK8SWZ3lV6sjD8vV087aGdF?usp=sharing'
    ),
    {
      folderId: '13wdKhswg4tK8SWZ3lV6sjD8vV087aGdF',
      resourceKey: null,
      canonicalUrl: 'https://drive.google.com/drive/folders/13wdKhswg4tK8SWZ3lV6sjD8vV087aGdF'
    }
  );
  assert.deepEqual(
    parseGoogleDriveFolderLink(
      'https://drive.google.com/drive/u/0/folders/1234567890abcdefghij?resourcekey=0-test_key&usp=drive_link'
    ),
    {
      folderId: '1234567890abcdefghij',
      resourceKey: '0-test_key',
      canonicalUrl: 'https://drive.google.com/drive/folders/1234567890abcdefghij?resourcekey=0-test_key'
    }
  );
});

test('public folder parser rejects lookalike hosts, non-folder links, fragments, and query smuggling', () => {
  const rejected = [
    'http://drive.google.com/drive/folders/1234567890abcdefghij',
    'https://drive.google.com.evil.example/drive/folders/1234567890abcdefghij',
    'https://user@drive.google.com/drive/folders/1234567890abcdefghij',
    'https://drive.google.com/file/d/1234567890abcdefghij/view',
    'https://drive.google.com/drive/folders/1234567890abcdefghij#fragment',
    'https://drive.google.com/drive/folders/1234567890abcdefghij?key=attacker',
    'https://drive.google.com/drive/folders/1234567890abcdefghij?resourcekey=a&resourcekey=b',
    'https://drive.google.com/drive/folders/1234567890abcdefghij%2Fother',
    'https://drive.google.com/drive/folders/../../secret'
  ];
  for (const link of rejected) {
    assert.throws(
      () => parseGoogleDriveFolderLink(link),
      error => error instanceof GoogleDriveLinkError,
      link
    );
  }
});
