'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-raster-check-'));
try {
  const env = { ...process.env, SYNCSHOW_RASTER_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures', 'native-raster-app.js')], {
    env, encoding: 'utf8', timeout: 90_000, maxBuffer: 256 * 1024
  });
  if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr || result.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  if (!receipt.native || !receipt.fallback || !receipt.cacheValidated) throw new Error('Incomplete raster acceptance checks.');
  console.log(JSON.stringify(receipt));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
