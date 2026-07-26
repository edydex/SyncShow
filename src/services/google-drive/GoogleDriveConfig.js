'use strict';

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../../assets/google-drive-config.json');
const MAX_CONFIG_BYTES = 16 * 1024;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;

class GoogleDriveConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoogleDriveConfigError';
    this.code = code;
  }
}

function optionalString(value, label, maximumLength = 256) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new GoogleDriveConfigError('INVALID_CONFIG', `${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new GoogleDriveConfigError('INVALID_CONFIG', `${label} is not valid.`);
  }
  return normalized;
}

function optionalClientSecret(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(value)) {
    throw new GoogleDriveConfigError('INVALID_CONFIG', `${label} is not valid.`);
  }
  return value;
}

function normalizeGoogleDriveConfig(config = {}, { env = process.env } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new GoogleDriveConfigError('INVALID_CONFIG', 'Google Drive configuration must be an object.');
  }

  const environmentClientId = optionalString(
    env.SYNCSHOW_GOOGLE_CLIENT_ID,
    'SYNCSHOW_GOOGLE_CLIENT_ID'
  );
  const environmentClientSecret = optionalClientSecret(
    env.SYNCSHOW_GOOGLE_CLIENT_SECRET,
    'SYNCSHOW_GOOGLE_CLIENT_SECRET'
  );
  const environmentApiKey = optionalString(
    env.SYNCSHOW_GOOGLE_API_KEY,
    'SYNCSHOW_GOOGLE_API_KEY'
  );
  const fileClientId = optionalString(config.clientId ?? config.client_id, 'clientId');
  const fileClientSecret = optionalClientSecret(
    config.clientSecret ?? config.client_secret,
    'clientSecret'
  );
  const fileApiKey = optionalString(config.apiKey ?? config.api_key, 'apiKey');
  const clientId = environmentClientId || fileClientId;
  const clientSecret = environmentClientSecret || fileClientSecret;
  const apiKey = environmentApiKey || fileApiKey;

  if (clientId && !CLIENT_ID_PATTERN.test(clientId)) {
    throw new GoogleDriveConfigError(
      'INVALID_CLIENT_ID',
      'The Google OAuth client ID must be a Desktop app client ID.'
    );
  }
  if (apiKey && !API_KEY_PATTERN.test(apiKey)) {
    throw new GoogleDriveConfigError('INVALID_API_KEY', 'The Google Drive API key is not valid.');
  }
  if (clientSecret && !clientId) {
    throw new GoogleDriveConfigError(
      'INVALID_CLIENT_SECRET',
      'A Google OAuth client secret requires a matching Desktop app client ID.'
    );
  }

  return Object.freeze({
    clientId,
    clientSecret,
    apiKey,
    oauthConfigured: Boolean(clientId),
    publicAccessConfigured: Boolean(apiKey),
    clientIdSource: environmentClientId ? 'environment' : (fileClientId ? 'file' : null),
    clientSecretSource: environmentClientSecret
      ? 'environment'
      : (fileClientSecret ? 'file' : null),
    apiKeySource: environmentApiKey ? 'environment' : (fileApiKey ? 'file' : null)
  });
}

async function readOptionalConfigFile(configPath, readFile) {
  let contents;
  try {
    contents = await readFile(configPath);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new GoogleDriveConfigError(
      'CONFIG_READ_FAILED',
      'SyncShow could not read its Google Drive configuration.'
    );
  }
  if (!Buffer.isBuffer(contents)) contents = Buffer.from(contents);
  if (contents.length > MAX_CONFIG_BYTES) {
    throw new GoogleDriveConfigError('CONFIG_TOO_LARGE', 'Google Drive configuration is too large.');
  }
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch (_error) {
    throw new GoogleDriveConfigError(
      'INVALID_CONFIG_JSON',
      'Google Drive configuration is not valid JSON.'
    );
  }
}

async function loadGoogleDriveConfig({
  env = process.env,
  configPath = DEFAULT_CONFIG_PATH,
  readFile = fs.readFile
} = {}) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
    throw new GoogleDriveConfigError('INVALID_CONFIG_PATH', 'Google Drive config path must be absolute.');
  }
  if (typeof readFile !== 'function') {
    throw new TypeError('readFile must be a function');
  }
  const fileConfig = await readOptionalConfigFile(configPath, readFile);
  return normalizeGoogleDriveConfig(fileConfig, { env });
}

function sanitizeGoogleDriveConfig(config) {
  return Object.freeze({
    oauthConfigured: Boolean(config?.oauthConfigured),
    publicAccessConfigured: Boolean(config?.publicAccessConfigured)
  });
}

module.exports = {
  API_KEY_PATTERN,
  CLIENT_ID_PATTERN,
  DEFAULT_CONFIG_PATH,
  GoogleDriveConfigError,
  loadGoogleDriveConfig,
  normalizeGoogleDriveConfig,
  sanitizeGoogleDriveConfig
};
