'use strict';

const path = require('node:path');
const asar = require('@electron/asar');

// ASAR 3 uses host path separators both when looking up and listing entries.
// Keep our manifest paths portable while translating only at the API boundary.
module.exports = {
  ...asar,
  extractFile(archivePath, entryPath) {
    return asar.extractFile(archivePath, path.normalize(entryPath));
  },
  statFile(archivePath, entryPath, ...options) {
    return asar.statFile(archivePath, path.normalize(entryPath), ...options);
  },
  listPackage(archivePath, ...options) {
    return asar.listPackage(archivePath, ...options)
      .map(entry => entry.replace(/\\/gu, '/'));
  }
};
