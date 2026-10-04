'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { finished } = require('node:stream/promises');
const asar = require('@electron/asar');
const { CORE_ENTRY, EDITOR_SOURCE_ENTRIES, verifyBundledPlannerIntegrity } = require('../scripts/lib/bundled-planner-integrity');

async function createArchive(source, archive) {
  // ASAR 3 resolves with its output stream before queued writes finish.
  await finished(await asar.createPackage(source, archive));
}

async function fixture(t, mutate = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.cp(path.resolve(__dirname, '../assets/planner-editor'), path.join(source, 'assets/planner-editor'), { recursive: true });
  await fs.mkdir(path.join(source, 'assets/fonts'));
  await fs.copyFile(path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf'), path.join(source, 'assets/fonts/NotoSans-Variable.ttf'));
  await fs.mkdir(path.dirname(path.join(source, CORE_ENTRY)), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '..', CORE_ENTRY), path.join(source, CORE_ENTRY));
  await mutate(source);
  const archive = path.join(root, 'app.asar');
  await createArchive(source, archive);
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

async function provenanceFixture(t, mutate = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-source-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  async function write(entry, text) {
    const file = path.join(source, entry);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  await write('assets/planner-editor/index.html', '<script src="/syncshow-local/adjust/assets/editor.js"></script><link href="/syncshow-local/adjust/assets/editor.css">');
  await write('assets/planner-editor/assets/editor.js', 'console.log("checked editor");');
  await write('assets/planner-editor/assets/editor.css', 'body { color: white; }');
  await write('assets/planner-editor/THIRD_PARTY_NOTICES.txt', 'Retained notices');
  await write('assets/fonts/NotoSans-Variable.ttf', 'fixture font bytes');
  const sourceSha256 = {};
  for (const [original, entry] of Object.entries(EDITOR_SOURCE_ENTRIES)) {
    const bytes = Buffer.from(`// ${original}\nexport const fixture = "original";\n`);
    await write(entry, bytes);
    sourceSha256[original] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  const entry = 'community-server/src/components/PlanServiceClient.tsx';
  const provenance = { kind: 'shared-community-editor', entry,
    componentSha256: sourceSha256[entry], sourceSha256, activeService: true };
  const provenancePath = path.join(source, 'assets/planner-editor/source.json');
  await fs.writeFile(provenancePath, JSON.stringify(provenance));
  await mutate({ source, provenance, provenancePath });
  const archive = path.join(root, 'app.asar');
  await createArchive(source, archive);
  return { archive, source };
}

test('source provenance binds both original editor helpers and the packaged shared core', async t => {
  const { archive, source } = await provenanceFixture(t);
  const verified = await verifyBundledPlannerIntegrity(archive, source);
  const record = verified.files.find(file => file.path === CORE_ENTRY);
  assert.equal(record.sha256, verified.sourceSha256['community-server/packages/service-core/node/services/project/ServiceProject.js']);
  assert.ok(verified.files.some(file => file.path.endsWith('/source/plannerSlides.ts')));
  assert.ok(verified.files.some(file => file.path.endsWith('/source/plannerSelection.ts')));
});

test('matching source and package inventories cannot hide stale helper or core provenance', async t => {
  for (const original of Object.keys(EDITOR_SOURCE_ENTRIES)) {
    await t.test(original, async child => {
      const { archive, source } = await provenanceFixture(child, async ({ source }) => {
        await fs.appendFile(path.join(source, EDITOR_SOURCE_ENTRIES[original]), '\n// changed after export');
      });
      await assert.rejects(verifyBundledPlannerIntegrity(archive, source), { code: 'PACKAGE_PLANNER_INTEGRITY' });
    });
  }
});

test('new source provenance rejects missing digests, extra paths and a mismatched component digest', async t => {
  for (const mutation of ['missing-helper', 'selection-snapshot-only', 'selection-map-only', 'extra-path', 'component-mismatch', 'null-map']) {
    await t.test(mutation, async child => {
      const { archive, source } = await provenanceFixture(child, async ({ source, provenance, provenancePath }) => {
        if (mutation === 'missing-helper') delete provenance.sourceSha256['community-server/src/components/plannerSlides.ts'];
        if (mutation === 'selection-snapshot-only') delete provenance.sourceSha256['community-server/src/components/plannerSelection.ts'];
        if (mutation === 'selection-map-only') await fs.unlink(path.join(source, EDITOR_SOURCE_ENTRIES['community-server/src/components/plannerSelection.ts']));
        if (mutation === 'extra-path') provenance.sourceSha256['../unreviewed'] = 'a'.repeat(64);
        if (mutation === 'component-mismatch') provenance.componentSha256 = 'b'.repeat(64);
        if (mutation === 'null-map') provenance.sourceSha256 = null;
        await fs.writeFile(provenancePath, JSON.stringify(provenance));
      });
      await assert.rejects(verifyBundledPlannerIntegrity(archive, source), { code: 'PACKAGE_PLANNER_INTEGRITY' });
    });
  }
});

test('previous three-source exports remain bound to their exact original contract', async t => {
  const { archive, source } = await provenanceFixture(t, async ({ source, provenance, provenancePath }) => {
    const original='community-server/src/components/plannerSelection.ts';
    delete provenance.sourceSha256[original];
    await fs.unlink(path.join(source, EDITOR_SOURCE_ENTRIES[original]));
    await fs.writeFile(provenancePath, JSON.stringify(provenance));
  });
  assert.equal((await verifyBundledPlannerIntegrity(archive, source)).verification,'source-bytes-matched');
});

test('legacy exports without a source map retain their earlier verification contract', async t => {
  const { archive, source } = await provenanceFixture(t, async ({ provenance, provenancePath }) => {
    delete provenance.sourceSha256;
    await fs.writeFile(provenancePath, JSON.stringify(provenance));
  });
  const verified = await verifyBundledPlannerIntegrity(archive, source);
  assert.equal(verified.verification, 'source-bytes-matched');
  assert.equal(verified.sourceSha256, undefined);
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
