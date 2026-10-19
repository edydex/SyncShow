'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function beforePack(context) {
  if (context.electronPlatformName === 'darwin') {
    // Electron 42+ downloads on first launch, which a fresh package job never
    // performs. Install the pinned runtime so its exact upstream notices are
    // available before electron-builder removes the stock macOS notice files.
    await promisify(execFile)(process.execPath, [require.resolve('electron/install.js')]);
  }
}


module.exports = beforePack;
module.exports.beforePack = beforePack;
