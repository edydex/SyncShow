'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-translation-controls-'));
const profile = path.join(evidence, 'profile'); fs.mkdirSync(profile);
for (const phase of ['write', 'reopen']) {
  const env = { ...process.env, SYNCSHOW_TRANSLATION_EVIDENCE: evidence, SYNCSHOW_TRANSLATION_PHASE: phase,
    SYNCSHOW_TEST_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/translation-control-smoke-app.js'), '--syncshow-test-user-data'], { env, stdio: 'inherit', timeout: 60000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ passed: true, evidence }));
