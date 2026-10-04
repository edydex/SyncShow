'use strict';

// Source preparation is deliberately separate from the installers. It runs on
// a POSIX build host, then every native builder consumes the same sealed ZIP.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function main(argv = process.argv.slice(2)) {
  const result = spawnSync(process.env.PYTHON || 'python3', [
    path.join(__dirname, 'prepare-release-sources.py'), ...argv
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native corresponding-source preparation failed (${result.status}).`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
