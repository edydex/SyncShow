'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

function plistBuddy(infoPlistPath, command, { optional = false } = {}) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, infoPlistPath], {
      stdio: optional ? 'ignore' : 'inherit'
    });
  } catch (error) {
    if (!optional) throw error;
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const infoPlistPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist'
  );

  // SyncShow hosts an opt-in local Remote server but does not need arbitrary
  // outbound cleartext access. Electron's stock plist enables it broadly.
  plistBuddy(infoPlistPath, 'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false');
  plistBuddy(infoPlistPath, 'Set :NSAppTransportSecurity:NSAllowsLocalNetworking true');

  // SyncShow does not request these device capabilities. Removing Electron's
  // generic descriptions keeps macOS privacy metadata honest and avoids
  // implying that presentation files can activate unrelated hardware.
  for (const key of [
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) {
    plistBuddy(infoPlistPath, `Delete :${key}`, { optional: true });
  }
};
