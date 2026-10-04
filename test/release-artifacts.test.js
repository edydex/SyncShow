'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const yaml = require('js-yaml');
const { verifyReleaseArtifacts } = require('../scripts/verify-release-artifacts');
const { expectedArtifactNames } = require('../scripts/verify-package-smoke');
const { packageTarget } = require('../scripts/lib/package-targets');

const VERSION = '2.0.0';
const REVISION = 'a'.repeat(40);
const TARGETS = [
  { directory: 'windows-installer', platform: 'win32', arch: 'x64' },
  { directory: 'macos-installer-arm64', platform: 'darwin', arch: 'arm64' },
  { directory: 'macos-installer-x64', platform: 'darwin', arch: 'x64' },
  { directory: 'linux-installer', platform: 'linux', arch: 'x64' }
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = object => Buffer.from(JSON.stringify(object) + '\n');
async function write(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
async function editJson(file, mutate) { const value = JSON.parse(await fs.readFile(file)); mutate(value); await fs.writeFile(file, json(value)); }

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'release-artifacts-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'artifacts');
  const projectDir = path.join(parent, 'project');
  const receipts = new Map();
  for (const { directory, platform, arch } of TARGETS) {
    const folder = path.join(root, directory);
    const names = expectedArtifactNames(packageTarget(platform, arch), { name: 'sync-show', productName: 'SyncShow', version: VERSION });
    const records = [];
    for (const name of names) {
      const bytes = Buffer.from(`${platform}-${arch} installer bytes: ${name}`);
      await write(path.join(folder, name), bytes);
      // Use the actual package-smoke schema, whose size field is `size`.
      records.push({ path: name, size: bytes.length, sha256: sha(bytes) });
    }
    const archiveHash = sha(Buffer.from(`verified app archive ${platform}-${arch}`));
    const executableHash = sha(Buffer.from(`verified executable ${platform}-${arch}`));
    const receiptFile = path.join(folder, `package-smoke-${platform}-${arch}.json`);
    const launchFile = path.join(folder, `packaged-launch-${platform}-${arch}.json`);
    await write(receiptFile, json({ schemaVersion: 1, sourceRevision: REVISION,
      application: { name: 'sync-show', productName: 'SyncShow', version: VERSION },
      target: { key: `${platform}-${arch}`, platform, arch },
      privateGoogleDriveConfig: 'absent',
      appArchive: { path: 'application/resources/app.asar', size: 1, sha256: archiveHash },
      runtime: { path: 'application/executable', size: 1, sha256: executableHash, architecture: arch },
      nativeArtifacts: [], artifacts: records,
      packagedPdfRuntimeGate: 'required-by-workflow', packagedSharpRuntimeGate: 'required-by-workflow', legalEvidenceGate: 'required-by-workflow' }));
    await write(launchFile, json({ schemaVersion: 1, target: `${platform}-${arch}`, archiveSha256: archiveHash, executableSha256: executableHash,
      isolatedProfile: 'confirmed-and-removed', launch: 'passed' }));
    receipts.set(directory, { folder, receiptFile, launchFile, installer: path.join(folder, names[0]) });
  }

  const sourceRoot = path.join(root, 'corresponding-sources');
  const sourceBytes = Buffer.from('pinned fixture upstream archive');
  const noticeBytes = Buffer.from('Fixture copyright and permissive license terms\n');
  const rebuildingBytes = Buffer.from('Build the fixture and replace its shared library.\n');
  const spec = { schemaVersion: 1, noticeCount: 1, noticeSha256: sha(noticeBytes), inputs: [{ id: 'fixture', version: '1',
    url: 'https://example.org/pinned', fileName: 'fixture.archive', bytes: sourceBytes.length, sha256: sha(sourceBytes) }] };
  const specBytes = json(spec);
  await write(path.join(projectDir, 'legal/release-sources/inputs.json'), specBytes);
  await write(path.join(projectDir, 'legal/release-sources/REBUILDING.md'), rebuildingBytes);
  const zip = new JSZip();
  zip.file('SOURCE-INDEX.json', json({ schemaVersion: 1, version: VERSION, inputsManifestSha256: sha(specBytes),
    inputs: spec.inputs, noticeSha256: spec.noticeSha256, noticeCount: spec.noticeCount }));
  zip.file('THIRD-PARTY-NOTICES.txt', noticeBytes);
  zip.file('REBUILDING-AND-REPLACEMENT.md', rebuildingBytes);
  zip.file('sources/fixture.archive', sourceBytes);
  const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const sourceName = `SyncShow-${VERSION}-corresponding-sources.zip`;
  const sourceArchive = path.join(sourceRoot, sourceName);
  const sourceReceipt = path.join(sourceRoot, 'release-source-receipt.json');
  await write(sourceArchive, zipBytes);
  await write(sourceReceipt, json({ schemaVersion: 1, version: VERSION, inputsManifestSha256: sha(specBytes), archiveInputCount: 1,
    noticeCount: spec.noticeCount, noticeSha256: spec.noticeSha256,
    archive: { fileName: sourceName, size: zipBytes.length, sha256: sha(zipBytes), downloadUrl: `https://github.com/edydex/SyncShow/releases/download/v${VERSION}/${sourceName}` } }));
  return { root, projectDir, receipts, sourceArchive, sourceReceipt };
}

const verify = f => verifyReleaseArtifacts(f.root, REVISION, { version: VERSION, projectDir: f.projectDir });

test('final publication accepts actual package-smoke size records for all four targets and seals every download', async t => {
  const f = await fixture(t);
  const result = await verify(f);
  assert.equal(result.installerTargets, 4);
  assert.equal(result.assets.length, 17);
  const checksums = (await fs.readFile(path.join(f.root, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(checksums.length, 17);
  for (const asset of result.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.equal(asset.sha256, sha(await fs.readFile(path.join(f.root, asset.path))));
    assert.ok(checksums.includes(`${asset.sha256}  ${asset.publishedName}`));
  }
});

test('final publication rejects installer damage, wrong source/version/target, stale launch evidence, and unexpected files', async t => {
  const mutations = {
    'changed installer bytes': async f => fs.appendFile(f.receipts.get('windows-installer').installer, 'damage'),
    'same-size installer damage': async f => { const file = f.receipts.get('macos-installer-arm64').installer; const bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes); },
    'wrong source revision': async f => editJson(f.receipts.get('windows-installer').receiptFile, receipt => { receipt.sourceRevision = 'b'.repeat(40); }),
    'wrong version': async f => editJson(f.receipts.get('macos-installer-x64').receiptFile, receipt => { receipt.application.version = '1.0.0'; }),
    'wrong platform': async f => editJson(f.receipts.get('linux-installer').receiptFile, receipt => { receipt.target.platform = 'darwin'; }),
    'private Drive configuration': async f => editJson(f.receipts.get('windows-installer').receiptFile, receipt => { receipt.privateGoogleDriveConfig = 'included'; }),
    'stale launch archive': async f => editJson(f.receipts.get('linux-installer').launchFile, launch => { launch.archiveSha256 = 'f'.repeat(64); }),
    'stale launch executable': async f => editJson(f.receipts.get('windows-installer').launchFile, launch => { launch.executableSha256 = 'e'.repeat(64); }),
    'failed native launch': async f => editJson(f.receipts.get('macos-installer-x64').launchFile, launch => { launch.launch = 'failed'; }),
    'missing native launch': async f => fs.unlink(f.receipts.get('windows-installer').launchFile),
    'extra installer': async f => write(path.join(f.receipts.get('windows-installer').folder, 'old-installer.exe'), Buffer.from('old')),
    'duplicate receipt': async f => fs.copyFile(f.receipts.get('linux-installer').receiptFile, path.join(f.receipts.get('linux-installer').folder, 'package-smoke-old.json')),
    'path traversal record': async f => editJson(f.receipts.get('windows-installer').receiptFile, receipt => { receipt.artifacts[0].path = '../outside.exe'; })
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async child => {
    const f = await fixture(child); await mutate(f);
    await assert.rejects(verify(f));
    await assert.rejects(fs.stat(path.join(f.root, 'SHA256SUMS')), { code: 'ENOENT' });
  });
});

test('final publication rejects source ZIP corruption and mismatched source receipts', async t => {
  for (const mutation of ['corrupt ZIP', 'wrong source version', 'wrong source inventory', 'wrong source digest']) await t.test(mutation, async child => {
    const f = await fixture(child);
    if (mutation === 'corrupt ZIP') await fs.appendFile(f.sourceArchive, 'damage');
    else await editJson(f.sourceReceipt, receipt => {
      if (mutation === 'wrong source version') receipt.version = '1.0.0';
      if (mutation === 'wrong source inventory') receipt.inputsManifestSha256 = 'b'.repeat(64);
      if (mutation === 'wrong source digest') receipt.archive.sha256 = 'c'.repeat(64);
    });
    await assert.rejects(verify(f));
    await assert.rejects(fs.stat(path.join(f.root, 'SHA256SUMS')), { code: 'ENOENT' });
  });
});

test('public-release workflow builds and verifies every native target with sealed source inputs and no Drive secrets', async () => {
  const workflow = yaml.load(await fs.readFile(path.resolve(__dirname, '../.github/workflows/build.yml'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../package.json')));
  assert.deepEqual(workflow.jobs['build-mac'].strategy.matrix.include.map(entry => [entry.arch, entry.runner]), [['arm64', 'macos-15'], ['x64', 'macos-15-intel']]);
  for (const [jobName, platform, buildRun] of [
    ['build-windows', 'win32', 'npm run build:win -- --publish never'],
    ['build-mac', 'darwin', 'npm run build:mac:adhoc -- --${{ matrix.arch }} --publish never'],
    ['build-linux', 'linux', 'npm run build:linux -- --publish never']
  ]) {
    const job = workflow.jobs[jobName];
    assert.ok(job.needs.includes('prepare-sources'));
    assert.equal(job.env.SYNCSHOW_RELEASE_SOURCE_DIR, '${{ github.workspace }}/release-sources');
    const steps = job.steps;
    assert.ok(steps.some(step => step.run === 'npm ci'));
    assert.ok(steps.some(step => step.run === 'npm run ci'));
    const download = steps.findIndex(step => step.uses === 'actions/download-artifact@v4');
    const build = steps.findIndex(step => step.run === buildRun);
    assert.ok(download > 0 && download < build);
    assert.deepEqual(steps[download].with, { name: 'corresponding-sources', path: 'release-sources' });
    const upload = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4');
    for (const command of ['build:verify-pdf-engine', 'build:verify-sharp', 'build:verify-service-core', 'build:verify-app-launch', 'build:verify-release-legal', 'build:verify-package-smoke']) {
      const index = steps.findIndex(step => step.run?.includes(command));
      assert.ok(index > build && index < upload, `${jobName} must ${command} before uploading`);
    }
    const evidence = steps.find(step => step.run?.includes('build:verify-package-smoke')).run;
    assert.ok(evidence.includes(`--platform ${platform}`));
    assert.ok(evidence.includes('--source-revision ${{ github.sha }}'));
    assert.ok(steps[upload].with.path.includes('dist/package-smoke-*.json'));
    assert.ok(steps[upload].with.path.includes('dist/packaged-launch-*.json'));
    assert.equal(steps[upload].with['if-no-files-found'], 'error');
    assert.doesNotMatch(JSON.stringify(job), /SYNCSHOW_GOOGLE|SYNCSHOW_PACKAGE_GOOGLE_DRIVE_CONFIG|secrets\./);
  }
  assert.deepEqual(manifest.build.win.target[0].arch, ['x64']);
  assert.ok(manifest.build.linux.target.every(target => target.arch.includes('x64')));
  const release = workflow.jobs['create-release'];
  assert.ok(release.needs.includes('prepare-sources'));
  assert.ok(release.needs.includes('build-windows') && release.needs.includes('build-mac') && release.needs.includes('build-linux'));
  const checkIndex = release.steps.findIndex(step => step.run?.includes('verify-release-artifacts.js'));
  const publishIndex = release.steps.findIndex(step => step.uses === 'softprops/action-gh-release@v2');
  assert.ok(checkIndex >= 0 && checkIndex < publishIndex);
  assert.equal(release.steps[publishIndex].with.target_commitish, '${{ github.sha }}', 'The release tag must point to the exact built commit even if main advances');
  for (const pattern of ['artifacts/windows-installer/*.exe', 'artifacts/macos-installer-*/*.dmg', 'artifacts/macos-installer-*/*.zip',
    'artifacts/linux-installer/*.AppImage', 'artifacts/linux-installer/*.deb', 'artifacts/corresponding-sources/*-corresponding-sources.zip',
    'artifacts/corresponding-sources/release-source-receipt.json', 'artifacts/*/package-smoke-*.json', 'artifacts/*/packaged-launch-*.json', 'artifacts/SHA256SUMS']) {
    assert.ok(release.steps[publishIndex].with.files.includes(pattern), `Missing published asset pattern ${pattern}`);
  }
});
