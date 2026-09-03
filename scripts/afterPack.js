'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { buildLegalBundle } = require('./package-legal-bundle');
const {
  MAC_LOCAL_NETWORK_USAGE_DESCRIPTION,
  MAC_UNRELATED_DEVICE_USAGE_KEYS,
  verifyMacRemoteNetworkMetadata
} = require('./lib/mac-network-privacy');

function plistBuddy(infoPlistPath, command, { optional = false } = {}) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, infoPlistPath], {
      stdio: optional ? 'ignore' : 'inherit'
    });
  } catch (error) {
    if (!optional) throw error;
  }
}

function applyMacRemoteNetworkMetadata(infoPlistPath, {
  runPlistBuddy = plistBuddy
} = {}) {
  // SyncShow hosts an opt-in local Remote server but does not need arbitrary
  // outbound cleartext access. Electron's stock plist enables it broadly.
  runPlistBuddy(
    infoPlistPath,
    'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false'
  );
  runPlistBuddy(
    infoPlistPath,
    'Set :NSAppTransportSecurity:NSAllowsLocalNetworking true'
  );
  runPlistBuddy(
    infoPlistPath,
    `Set :NSLocalNetworkUsageDescription ${MAC_LOCAL_NETWORK_USAGE_DESCRIPTION}`
  );
  for (const key of MAC_UNRELATED_DEVICE_USAGE_KEYS) {
    runPlistBuddy(infoPlistPath, `Delete :${key}`, { optional: true });
  }
}

exports.default = async function afterPack(context) {
  // Every QA package carries the exact notices and native-binary hashes that
  // are currently available. Public-release verification remains blocked
  // until the manifest's corresponding-source/relinking gaps are resolved.
  await buildLegalBundle(context);

  if (context.electronPlatformName !== 'darwin') return;

  const infoPlistPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist'
  );

  applyMacRemoteNetworkMetadata(infoPlistPath);

  // This is a release boundary, not a best-effort diagnostic. A package with
  // missing or drifted local-network privacy metadata must never proceed to
  // signing or distribution.
  verifyMacRemoteNetworkMetadata(infoPlistPath);
};

exports.applyMacRemoteNetworkMetadata = applyMacRemoteNetworkMetadata;
