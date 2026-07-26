'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'main.js'), path.join(root, 'preload.js')];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
}

collect(path.join(root, 'src'));
collect(path.join(root, 'scripts'));

for (const filePath of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax checked ${new Set(files).size} JavaScript files.`);
