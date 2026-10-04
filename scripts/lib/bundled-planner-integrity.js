'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const asar = require('./asar');

const PLANNER_PREFIX = 'assets/planner-editor/';
const FONT_ENTRY = 'assets/fonts/NotoSans-Variable.ttf';
const sourceRoot = path.resolve(__dirname, '../..');

function invalid(message) {
  const error = new Error(message);
  error.code = 'PACKAGE_PLANNER_INTEGRITY';
  throw error;
}

async function plannerSourceEntries(root = sourceRoot) {
  const entries = [];
  async function visit(directory, relative) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) invalid('The bundled planner source contains a symbolic link.');
      const next = `${relative}${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), `${next}/`);
      else if (entry.isFile()) entries.push(next);
      else invalid('The bundled planner source contains an unsupported entry.');
    }
  }
  await visit(path.join(root, PLANNER_PREFIX), PLANNER_PREFIX);
  return entries.sort();
}

function bytesInArchive(archivePath, entry) {
  try { return asar.extractFile(archivePath, entry); }
  catch { invalid(`The packaged planner is missing ${entry}.`); }
}

async function verifyBundledPlannerIntegrity(archivePath, root = sourceRoot) {
  const expectedEntries = await plannerSourceEntries(root);
  const entries = asar.listPackage(archivePath).map(entry => entry.replace(/^\//, ''));
  const packagedFiles = entries.filter(entry => entry.startsWith(PLANNER_PREFIX)
    && !asar.statFile(archivePath, entry).files).sort();
  if (JSON.stringify(packagedFiles) !== JSON.stringify(expectedEntries)) {
    invalid('The packaged planner file inventory differs from the checked-out source.');
  }
  const required = ['index.html', 'source.json', 'THIRD_PARTY_NOTICES.txt'].map(entry => PLANNER_PREFIX + entry);
  if (!required.every(entry => expectedEntries.includes(entry))) invalid('The bundled planner source is incomplete.');

  const files = [];
  for (const entry of [...expectedEntries, FONT_ENTRY]) {
    const packaged = bytesInArchive(archivePath, entry);
    const source = await fs.readFile(path.join(root, entry));
    if (!packaged.length || !packaged.equals(source)) {
      invalid(`The packaged planner file ${entry} differs from the checked-out source.`);
    }
    files.push({ path: entry, size: packaged.length, sha256: crypto.createHash('sha256').update(packaged).digest('hex') });
  }

  let provenance;
  try { provenance = JSON.parse(bytesInArchive(archivePath, PLANNER_PREFIX + 'source.json')); }
  catch { invalid('The bundled planner provenance is invalid.'); }
  if (provenance.kind !== 'shared-community-editor'
    || provenance.entry !== 'community-server/src/components/PlanServiceClient.tsx'
    || !/^[a-f0-9]{64}$/.test(provenance.componentSha256 || '')
    || provenance.activeService !== true) invalid('The bundled planner provenance is invalid.');

  const html = bytesInArchive(archivePath, PLANNER_PREFIX + 'index.html').toString('utf8');
  const assets = [...html.matchAll(/(?:src|href)="\/syncshow-local\/adjust\/([^"?#]+)"/g)].map(match => match[1]);
  if (!assets.some(asset => asset.endsWith('.js')) || !assets.some(asset => asset.endsWith('.css'))
    || assets.some(asset => !expectedEntries.includes(PLANNER_PREFIX + asset))) {
    invalid('The bundled planner entry page references incomplete script or stylesheet assets.');
  }
  return { ...provenance, verification: 'source-bytes-matched', files };
}

module.exports = { FONT_ENTRY, PLANNER_PREFIX, plannerSourceEntries, verifyBundledPlannerIntegrity };
