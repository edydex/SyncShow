'use strict';

const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const ALLOWED_USP_VALUES = new Set(['sharing', 'drive_link']);
const FOLDER_PATH_PATTERN = /^\/drive\/(?:u\/[0-9]{1,3}\/)?folders\/([A-Za-z0-9_-]{10,200})\/?$/;

class GoogleDriveLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoogleDriveLinkError';
    this.code = code;
  }
}

function singleParameter(searchParams, name) {
  const values = searchParams.getAll(name);
  if (values.length > 1) {
    throw new GoogleDriveLinkError('INVALID_FOLDER_LINK', `The Google Drive link repeats ${name}.`);
  }
  return values[0] || null;
}

function parseGoogleDriveFolderLink(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new GoogleDriveLinkError('INVALID_FOLDER_LINK', 'Paste a Google Drive folder link.');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_error) {
    throw new GoogleDriveLinkError('INVALID_FOLDER_LINK', 'Paste a valid Google Drive folder link.');
  }
  if (parsed.protocol !== 'https:'
    || parsed.hostname !== 'drive.google.com'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw new GoogleDriveLinkError(
      'INVALID_FOLDER_LINK',
      'Use an HTTPS folder link from drive.google.com.'
    );
  }

  const pathMatch = parsed.pathname.match(FOLDER_PATH_PATTERN);
  if (!pathMatch || !FOLDER_ID_PATTERN.test(pathMatch[1])) {
    throw new GoogleDriveLinkError(
      'INVALID_FOLDER_LINK',
      'This is not a supported Google Drive folder link.'
    );
  }
  const allowedParameters = new Set(['usp', 'resourcekey']);
  for (const name of parsed.searchParams.keys()) {
    if (!allowedParameters.has(name)) {
      throw new GoogleDriveLinkError(
        'INVALID_FOLDER_LINK',
        `The Google Drive folder link contains an unsupported ${name} parameter.`
      );
    }
  }
  const usp = singleParameter(parsed.searchParams, 'usp');
  if (usp && !ALLOWED_USP_VALUES.has(usp)) {
    throw new GoogleDriveLinkError('INVALID_FOLDER_LINK', 'The Google Drive sharing link is not valid.');
  }
  const resourceKey = singleParameter(parsed.searchParams, 'resourcekey');
  if (resourceKey && !RESOURCE_KEY_PATTERN.test(resourceKey)) {
    throw new GoogleDriveLinkError(
      'INVALID_RESOURCE_KEY',
      'The Google Drive folder resource key is not valid.'
    );
  }

  const folderId = pathMatch[1];
  const canonical = new URL(`https://drive.google.com/drive/folders/${folderId}`);
  if (resourceKey) canonical.searchParams.set('resourcekey', resourceKey);
  return Object.freeze({
    folderId,
    resourceKey,
    canonicalUrl: canonical.toString()
  });
}

module.exports = {
  FOLDER_ID_PATTERN,
  GoogleDriveLinkError,
  RESOURCE_KEY_PATTERN,
  parseGoogleDriveFolderLink
};
