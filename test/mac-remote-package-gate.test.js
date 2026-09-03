'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const syncFs = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const packageJson = require('../package.json');
const {
  applyMacRemoteNetworkMetadata
} = require('../scripts/afterPack');
const {
  MAC_LOCAL_NETWORK_USAGE_DESCRIPTION,
  MAC_UNRELATED_DEVICE_USAGE_KEYS,
  readPlistValue,
  verifyMacRemoteNetworkMetadata
} = require('../scripts/lib/mac-network-privacy');
const {
  buildSmokeCommandBody,
  physicalBundleFilesystem,
  selectRealLanBinding
} = require('../scripts/verify-packaged-remote-lan');

test('packaged LAN verifier uses the physical filesystem under Electron', () => {
  const originalFs = { realpathSync() {} };
  const loaded = [];
  assert.equal(
    physicalBundleFilesystem({
      electron: true,
      loadModule: name => {
        loaded.push(name);
        return originalFs;
      }
    }),
    originalFs
  );
  assert.deepEqual(loaded, ['original-fs']);
  assert.equal(
    physicalBundleFilesystem({
      electron: false,
      loadModule: () => {
        throw new Error('Normal Node must not load original-fs.');
      }
    }),
    syncFs
  );
});

test('macOS package config and afterPack bind the exact local-network privacy contract', () => {
  const mac = packageJson.build.mac;
  assert.equal(
    mac.extendInfo.NSLocalNetworkUsageDescription,
    MAC_LOCAL_NETWORK_USAGE_DESCRIPTION
  );
  assert.equal(mac.extendInfo.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(mac.extendInfo.NSAppTransportSecurity.NSAllowsLocalNetworking, true);

  const calls = [];
  applyMacRemoteNetworkMetadata('/private/tmp/SyncShow.app/Contents/Info.plist', {
    runPlistBuddy: (infoPlistPath, command) => {
      calls.push({ infoPlistPath, command });
    }
  });
  assert.deepEqual(calls, [
    {
      infoPlistPath: '/private/tmp/SyncShow.app/Contents/Info.plist',
      command: 'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false'
    },
    {
      infoPlistPath: '/private/tmp/SyncShow.app/Contents/Info.plist',
      command: 'Set :NSAppTransportSecurity:NSAllowsLocalNetworking true'
    },
    {
      infoPlistPath: '/private/tmp/SyncShow.app/Contents/Info.plist',
      command: `Set :NSLocalNetworkUsageDescription ${MAC_LOCAL_NETWORK_USAGE_DESCRIPTION}`
    },
    ...MAC_UNRELATED_DEVICE_USAGE_KEYS.map(key => ({
      infoPlistPath: '/private/tmp/SyncShow.app/Contents/Info.plist',
      command: `Delete :${key}`
    }))
  ]);
});

test('packaged plist verification fails closed on missing or drifted metadata', () => {
  const infoPlistPath = '/private/tmp/SyncShow.app/Contents/Info.plist';
  const values = new Map([
    ['NSAppTransportSecurity.NSAllowsLocalNetworking', 'true'],
    ['NSLocalNetworkUsageDescription', MAC_LOCAL_NETWORK_USAGE_DESCRIPTION]
  ]);
  const execFileSyncImpl = (executable, args) => {
    assert.equal(executable, '/usr/bin/plutil');
    assert.deepEqual(args.slice(0, 1), ['-extract']);
    assert.equal(args.at(-1), infoPlistPath);
    const value = values.get(args[1]);
    if (value === undefined) throw new Error('No value at that key path');
    return value;
  };

  assert.deepEqual(
    verifyMacRemoteNetworkMetadata(infoPlistPath, { execFileSyncImpl }),
    {
      allowsLocalNetworking: true,
      usageDescription: MAC_LOCAL_NETWORK_USAGE_DESCRIPTION
    }
  );

  values.set('NSAppTransportSecurity.NSAllowsLocalNetworking', 'false');
  assert.throws(
    () => verifyMacRemoteNetworkMetadata(infoPlistPath, { execFileSyncImpl }),
    error => error.code === 'MAC_REMOTE_LOCAL_NETWORK_DISABLED'
  );

  values.set('NSAppTransportSecurity.NSAllowsLocalNetworking', 'true');
  values.set('NSLocalNetworkUsageDescription', 'A vague or stale explanation.');
  assert.throws(
    () => verifyMacRemoteNetworkMetadata(infoPlistPath, { execFileSyncImpl }),
    error => error.code === 'MAC_REMOTE_USAGE_DESCRIPTION_MISMATCH'
  );

  values.delete('NSLocalNetworkUsageDescription');
  assert.throws(
    () => verifyMacRemoteNetworkMetadata(infoPlistPath, { execFileSyncImpl }),
    error => error.code === 'MAC_REMOTE_METADATA_MISSING'
  );

  values.set('NSLocalNetworkUsageDescription', MAC_LOCAL_NETWORK_USAGE_DESCRIPTION);
  values.set('NSAudioCaptureUsageDescription', 'This app needs access to audio capture');
  assert.throws(
    () => verifyMacRemoteNetworkMetadata(infoPlistPath, { execFileSyncImpl }),
    error => error.code === 'MAC_UNRELATED_DEVICE_USAGE_DESCRIPTION'
  );
});

test('afterPack produces metadata accepted by the real macOS plist reader', {
  skip: process.platform === 'darwin'
    ? false
    : 'The real PlistBuddy/plutil contract is macOS-only.'
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-mac-remote-plist-'));
  const infoPlistPath = path.join(directory, 'Info.plist');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(infoPlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
    <key>NSAllowsLocalNetworking</key>
    <false/>
  </dict>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Wrong value</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>Unused stock Electron permission</string>
  <key>NSCameraUsageDescription</key>
  <string>Unused stock Electron permission</string>
</dict>
</plist>
`, 'utf8');

  applyMacRemoteNetworkMetadata(infoPlistPath);
  assert.deepEqual(verifyMacRemoteNetworkMetadata(infoPlistPath), {
    allowsLocalNetworking: true,
    usageDescription: MAC_LOCAL_NETWORK_USAGE_DESCRIPTION
  });
  for (const key of MAC_UNRELATED_DEVICE_USAGE_KEYS) {
    assert.throws(
      () => readPlistValue(infoPlistPath, key),
      error => error.code === 'MAC_REMOTE_METADATA_MISSING'
    );
  }
});

test('the packaged LAN gate refuses loopback, public, and absent bindings', () => {
  const isPrivateIpv4 = address => /^(?:10\.|192\.168\.)/.test(address);
  assert.throws(
    () => selectRealLanBinding([
      { id: 'loopback', kind: 'loopback', address: '127.0.0.1' },
      { id: 'fake-lan', kind: 'lan', address: '127.0.0.1' },
      { id: 'public', kind: 'lan', address: '203.0.113.10' }
    ], isPrivateIpv4),
    error => error.code === 'REAL_LAN_BINDING_REQUIRED'
  );

  assert.deepEqual(
    selectRealLanBinding([
      { id: 'second', kind: 'lan', address: '192.168.50.9' },
      { id: 'first', kind: 'lan', address: '10.0.0.8' }
    ], isPrivateIpv4),
    { id: 'first', kind: 'lan', address: '10.0.0.8' }
  );
});

test('the packaged LAN gate emits the protocol-required cue guard on every command', () => {
  const state = {
    outputSessionId: '4c480506-4436-4e72-90d2-6e3fca88e775',
    revision: 7
  };
  const next = buildSmokeCommandBody({
    state,
    sequence: 1,
    type: 'cue.next',
    expectedCueIndex: 3
  });
  assert.equal(next.expectedCueIndex, 3);
  assert.equal(next.command.type, 'cue.next');
  assert.match(next.commandId, /^[0-9a-f-]{36}$/);

  for (const [sequence, type] of [
    [2, 'output.clear'],
    [3, 'output.restore']
  ]) {
    const command = buildSmokeCommandBody({ state, sequence, type });
    assert.equal(command.expectedCueIndex, null);
    assert.deepEqual(command.command, { type });
  }
});
