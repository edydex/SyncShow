'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const asar = require('@electron/asar');
const { verifyBundledPlannerIntegrity } = require('../scripts/lib/bundled-planner-integrity');

async function fixture(t, mutate = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.cp(path.resolve(__dirname, '../assets/planner-editor'), path.join(source, 'assets/planner-editor'), { recursive: true });
  await fs.mkdir(path.join(source, 'assets/fonts'));
  await fs.copyFile(path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf'), path.join(source, 'assets/fonts/NotoSans-Variable.ttf'));
  await mutate(source);
  const archive = path.join(root, 'app.asar');
  await asar.createPackage(source, archive);
  return archive;
}

test('the packaged Adjust editor, entry assets, notices, provenance, and font match the frozen source', async t => {
  const verified = await verifyBundledPlannerIntegrity(await fixture(t));
  assert.equal(verified.verification, 'source-bytes-matched');
  assert.equal(verified.activeService, true);
  assert.ok(verified.files.some(file => file.path.endsWith('.js')));
  assert.ok(verified.files.some(file => file.path.endsWith('.css')));
  assert.ok(verified.files.some(file => file.path.endsWith('.ttf')));
  assert.ok(verified.files.every(file => file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('package checks reject missing, stale, extra, and corrupt bundled planner files', async t => {
  for (const mutation of ['missing-script', 'corrupt-script', 'stale-provenance', 'missing-font', 'extra-file']) {
    await t.test(mutation, async child => {
      const archive = await fixture(child, async source => {
        const planner = path.join(source, 'assets/planner-editor');
        const script = (await fs.readdir(path.join(planner, 'assets'))).find(name => name.endsWith('.js'));
        if (mutation === 'missing-script') await fs.unlink(path.join(planner, 'assets', script));
        if (mutation === 'corrupt-script') await fs.writeFile(path.join(planner, 'assets', script), '// damaged bundle');
        if (mutation === 'stale-provenance') await fs.writeFile(path.join(planner, 'source.json'), '{}');
        if (mutation === 'missing-font') await fs.unlink(path.join(source, 'assets/fonts/NotoSans-Variable.ttf'));
        if (mutation === 'extra-file') await fs.writeFile(path.join(planner, 'old-bundle.js'), '// stale artifact');
      });
      await assert.rejects(verifyBundledPlannerIntegrity(archive), { code: 'PACKAGE_PLANNER_INTEGRITY' });
    });
  }
});
