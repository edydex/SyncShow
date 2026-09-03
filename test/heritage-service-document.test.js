'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const browserCore = require('../packages/service-core');
const {
  HeritageServiceDocumentError,
  createHeritageServiceDocument,
  heritageServiceDocumentRevision,
  normalizeHeritageServiceDocument,
  normalizeHeritageServiceDocumentEnvelope,
  parseHeritageServiceDocumentSource,
  replaceHeritageServiceProject,
  serializeHeritageServiceDocument,
  validateHeritageServiceDocumentSource
} = require('../src/services/community/HeritageServiceDocument');
const {
  createServiceProject
} = require('../src/services/project');

const NOW = '2026-08-13T18:00:00.000Z';

function createProject(title = 'July 26 Service') {
  return createServiceProject({
    id: 'service-2026-07-26',
    title,
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'english', label: 'English', language: 'en' },
      { id: 'russian', label: 'Russian', language: 'ru' },
      { id: 'media', label: 'Media', language: 'und' }
    ]
  });
}

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof HeritageServiceDocumentError);
    assert.equal(error.code, code);
    return true;
  });
}

test('wraps the complete native ServiceProject as one canonical shared document', () => {
  const document = createHeritageServiceDocument(createProject());
  const source = serializeHeritageServiceDocument(document);
  const validated = validateHeritageServiceDocumentSource(source);

  assert.equal(document.kind, 'heritage-service-document');
  assert.equal(document.id, 'service-2026-07-26');
  assert.deepEqual(document.project.channelIds, ['english', 'russian', 'media']);
  assert.equal(validated.documentSource, source);
  assert.equal(validated.revision, heritageServiceDocumentRevision(source));
  assert.equal(Buffer.byteLength(validated.revision), 64);

  // The package-level reader is intentionally browser-safe and can consume the
  // same canonical source without importing Electron or Node storage code.
  const savedBrowserSource = browserCore.serializeHeritageServiceDocument(
    browserCore.createHeritageServiceDocument({
      ...document.project,
      revision: 1
    })
  );
  const browserDocument = browserCore.parseHeritageServiceDocumentSource(savedBrowserSource);
  assert.equal(browserDocument.project.title, 'July 26 Service');

  const browserSong = browserCore.parseSongDocument([
    '---',
    'id: pilot-song',
    'title: Pilot Song',
    'language: en',
    '---',
    '',
    '# Verse 1',
    'Prepare once',
    'Run reliably',
    ''
  ].join('\n'));
  assert.equal(browserSong.id, 'pilot-song');
});

test('one project mutation produces a new document revision without changing identity', () => {
  const original = createHeritageServiceDocument(createProject());
  const updatedProject = createProject('July 26 Service — reviewed');
  const updated = replaceHeritageServiceProject(original, updatedProject);

  assert.equal(updated.id, original.id);
  assert.notEqual(
    heritageServiceDocumentRevision(updated),
    heritageServiceDocumentRevision(original)
  );
  assert.equal(updated.project.title, 'July 26 Service — reviewed');
});

test('the synchronized envelope pins exact content, version, status, and change time', () => {
  const documentSource = serializeHeritageServiceDocument(
    createHeritageServiceDocument(createProject())
  );
  const envelope = normalizeHeritageServiceDocumentEnvelope({
    syncId: 'service-2026-07-26',
    syncVersion: 7,
    revision: heritageServiceDocumentRevision(documentSource),
    documentSource,
    status: 'planning',
    changedAt: NOW
  });

  assert.equal(envelope.syncVersion, 7);
  assert.equal(envelope.project.title, 'July 26 Service');
  assert.equal(envelope.revision, heritageServiceDocumentRevision(documentSource));
});

test('rejects mismatched identities, noncanonical content, and false revisions', () => {
  const document = createHeritageServiceDocument(createProject());
  const source = serializeHeritageServiceDocument(document);

  expectCode('DOCUMENT_PROJECT_ID_MISMATCH', () =>
    normalizeHeritageServiceDocument({
      schemaVersion: 1,
      kind: 'heritage-service-document',
      id: 'another-service',
      project: createProject()
    }));
  expectCode('NONCANONICAL_DOCUMENT_SOURCE', () =>
    parseHeritageServiceDocumentSource(JSON.stringify(document)));
  expectCode('DOCUMENT_REVISION_MISMATCH', () =>
    normalizeHeritageServiceDocumentEnvelope({
      syncId: document.id,
      syncVersion: 1,
      revision: '0'.repeat(64),
      documentSource: source,
      status: 'ready',
      changedAt: NOW
    }));
});
