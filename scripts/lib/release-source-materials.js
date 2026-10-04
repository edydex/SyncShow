'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function safeBytes(file, maximum) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) {
    sourceError('RELEASE_SOURCE_UNSAFE', 'Release source material is not a bounded regular file.');
  }
  return fsp.readFile(file);
}

async function readReleaseSourceMaterials({
  projectDir = path.resolve(__dirname, '../..'),
  version,
  root = process.env.SYNCSHOW_RELEASE_SOURCE_DIR || path.join(projectDir, 'dist'),
  required = false
} = {}) {
  const receiptPath = path.join(root, 'release-source-receipt.json');
  let receiptBytes;
  try { receiptBytes = await safeBytes(receiptPath, 1024 * 1024); } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    if (error.code === 'ENOENT') sourceError('RELEASE_SOURCE_MISSING', 'The sealed corresponding-source asset and receipt are required.');
    throw error;
  }
  let receipt;
  try { receipt = JSON.parse(receiptBytes); } catch (_error) {
    sourceError('RELEASE_SOURCE_INVALID', 'Release source receipt is invalid JSON.');
  }
  const specBytes = await safeBytes(path.join(projectDir, 'legal/release-sources/inputs.json'), 2 * 1024 * 1024);
  const spec = JSON.parse(specBytes);
  const fileName = `SyncShow-${version}-corresponding-sources.zip`;
  const expectedUrl = `https://github.com/edydex/SyncShow/releases/download/v${version}/${fileName}`;
  if (receipt.schemaVersion !== 1 || receipt.version !== version
    || receipt.inputsManifestSha256 !== sha256(specBytes)
    || receipt.archiveInputCount !== spec.inputs.length
    || receipt.noticeCount !== spec.noticeCount
    || receipt.noticeSha256 !== spec.noticeSha256
    || receipt.archive?.fileName !== fileName || receipt.archive.downloadUrl !== expectedUrl
    || !Number.isSafeInteger(receipt.archive.size) || receipt.archive.size < 1
    || !/^[a-f0-9]{64}$/u.test(receipt.archive.sha256 || '')) {
    sourceError('RELEASE_SOURCE_INVALID', 'Release source receipt differs from the reviewed exact source inventory.');
  }
  const sourceBytes = await safeBytes(path.join(root, fileName), 2 * 1024 * 1024 * 1024);
  if (sourceBytes.length !== receipt.archive.size || sha256(sourceBytes) !== receipt.archive.sha256) {
    sourceError('RELEASE_SOURCE_CHANGED', 'The corresponding-source release asset changed.');
  }
  const zip = await JSZip.loadAsync(sourceBytes);
  const expectedPaths = ['SOURCE-INDEX.json', 'THIRD-PARTY-NOTICES.txt', 'REBUILDING-AND-REPLACEMENT.md',
    ...spec.inputs.map(record => `sources/${record.fileName}`)].sort();
  const actualPaths = Object.values(zip.files).filter(entry => !entry.dir).map(entry => entry.name).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    sourceError('RELEASE_SOURCE_INVALID', 'The corresponding-source ZIP inventory differs from the reviewed inputs.');
  }
  const index = JSON.parse(await zip.file('SOURCE-INDEX.json').async('string'));
  if (index.schemaVersion !== 1 || index.version !== version
    || index.inputsManifestSha256 !== sha256(specBytes)
    || JSON.stringify(index.inputs) !== JSON.stringify(spec.inputs)
    || index.noticeSha256 !== spec.noticeSha256 || index.noticeCount !== spec.noticeCount) {
    sourceError('RELEASE_SOURCE_INVALID', 'The corresponding-source ZIP index differs from the pinned source inventory.');
  }
  for (const record of spec.inputs) {
    const bytes = await zip.file(`sources/${record.fileName}`).async('nodebuffer');
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      sourceError('RELEASE_SOURCE_CHANGED', `Exact upstream source archive changed: ${record.id}.`);
    }
  }
  const noticeBytes = await zip.file('THIRD-PARTY-NOTICES.txt').async('nodebuffer');
  if (sha256(noticeBytes) !== spec.noticeSha256) {
    sourceError('RELEASE_SOURCE_CHANGED', 'Reviewed upstream native copyright/license terms changed.');
  }
  const rebuildingBytes = await zip.file('REBUILDING-AND-REPLACEMENT.md').async('nodebuffer');
  const expectedRebuilding = await safeBytes(path.join(projectDir, 'legal/release-sources/REBUILDING.md'), 1024 * 1024);
  if (sha256(rebuildingBytes) !== sha256(expectedRebuilding)) {
    sourceError('RELEASE_SOURCE_CHANGED', 'Corresponding-source replacement instructions changed.');
  }
  return { receipt, receiptBytes, noticeBytes, rebuildingBytes };
}

module.exports = { readReleaseSourceMaterials, sha256 };
