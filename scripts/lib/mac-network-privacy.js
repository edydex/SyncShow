'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MAC_LOCAL_NETWORK_USAGE_DESCRIPTION =
  'SyncShow uses your trusted local network so a phone you pair can control the active presentation.';
const MAC_UNRELATED_DEVICE_USAGE_KEYS = Object.freeze([
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
]);

function requireInfoPlistPath(infoPlistPath) {
  if (typeof infoPlistPath !== 'string'
    || !path.isAbsolute(infoPlistPath)
    || path.basename(infoPlistPath) !== 'Info.plist') {
    const error = new TypeError('A packaged macOS Info.plist path is required.');
    error.code = 'INVALID_MAC_INFO_PLIST_PATH';
    throw error;
  }
  return infoPlistPath;
}

function readPlistValue(infoPlistPath, key, {
  execFileSyncImpl = execFileSync
} = {}) {
  requireInfoPlistPath(infoPlistPath);
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new TypeError('A bounded plist key path is required.');
  }

  try {
    return String(execFileSyncImpl(
      '/usr/bin/plutil',
      ['-extract', key, 'raw', '-o', '-', infoPlistPath],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )).trim();
  } catch (cause) {
    const error = new Error(`Packaged macOS metadata is missing ${key}.`);
    error.name = 'MacNetworkPrivacyError';
    error.code = 'MAC_REMOTE_METADATA_MISSING';
    error.cause = cause;
    throw error;
  }
}

function verifyMacRemoteNetworkMetadata(infoPlistPath, options = {}) {
  const allowsLocalNetworking = readPlistValue(
    infoPlistPath,
    'NSAppTransportSecurity.NSAllowsLocalNetworking',
    options
  );
  if (allowsLocalNetworking !== 'true') {
    const error = new Error(
      'The packaged app must allow only its declared local-network HTTP use.'
    );
    error.name = 'MacNetworkPrivacyError';
    error.code = 'MAC_REMOTE_LOCAL_NETWORK_DISABLED';
    throw error;
  }

  const usageDescription = readPlistValue(
    infoPlistPath,
    'NSLocalNetworkUsageDescription',
    options
  );
  if (usageDescription !== MAC_LOCAL_NETWORK_USAGE_DESCRIPTION) {
    const error = new Error(
      'The packaged app has an unexpected local-network privacy explanation.'
    );
    error.name = 'MacNetworkPrivacyError';
    error.code = 'MAC_REMOTE_USAGE_DESCRIPTION_MISMATCH';
    throw error;
  }

  for (const key of MAC_UNRELATED_DEVICE_USAGE_KEYS) {
    try {
      readPlistValue(infoPlistPath, key, options);
    } catch (error) {
      if (error?.code === 'MAC_REMOTE_METADATA_MISSING') continue;
      throw error;
    }
    const error = new Error(
      `The packaged app declares unrelated device access through ${key}.`
    );
    error.name = 'MacNetworkPrivacyError';
    error.code = 'MAC_UNRELATED_DEVICE_USAGE_DESCRIPTION';
    throw error;
  }

  return Object.freeze({
    allowsLocalNetworking: true,
    usageDescription
  });
}

module.exports = {
  MAC_LOCAL_NETWORK_USAGE_DESCRIPTION,
  MAC_UNRELATED_DEVICE_USAGE_KEYS,
  readPlistValue,
  requireInfoPlistPath,
  verifyMacRemoteNetworkMetadata
};
