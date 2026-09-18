'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ServiceSermonPacketError,
  buildServiceSermonPacketSourcePlan,
  importedSourceMatchesPlan,
  serviceSermonPacketSourceDispositions,
  serviceSetFingerprint
} = require('../src/services/sermon/ServiceSermonPacket');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: '2026-07-26-main',
    name: 'Sunday, July 26',
    profileId: 'main-sanctuary',
    serviceDate: '2026-07-26',
    createdAt: '2026-07-26T14:00:00.000Z',
    inputs: {
      russian: {
        roleId: 'russian',
        assetId: 'asset-rus',
        sourceName: '07-26-2026 Служение RUS.pptx',
        pinnedPath: '/private/pinned/2026-07-26/russian.pptx',
        size: 1001,
        sha256: SHA_A
      },
      media: {
        roleId: 'media',
        assetId: 'asset-media',
        sourceName: '07-26-2026 Media.pptx',
        pinnedPath: '/private/pinned/2026-07-26/media.pptx',
        size: 1002,
        sha256: SHA_B
      },
      english: {
        roleId: 'english',
        assetId: 'asset-eng',
        sourceName: '07-26-2026 Service ENG.pptx',
        pinnedPath: '/private/pinned/2026-07-26/english.pptx',
        size: 1003,
        sha256: SHA_C
      }
    },
    ...overrides
  };
}

function manuscript(overrides = {}) {
  return {
    fileName: 'Prayer Notes.pdf',
    mediaType: 'application/pdf',
    sha256: SHA_D,
    sizeBytes: 4200,
    defaultKind: 'manuscript',
    ...overrides
  };
}

function sourcePlan(overrides = {}) {
  let counter = 0;
  return buildServiceSermonPacketSourcePlan({
    manifest: manifest(),
    manuscript: manuscript(),
    manuscriptPath: '/private/reviewed/Prayer Notes.pdf',
    manuscriptLanguages: ['EN', 'ru', 'en'],
    manuscriptProvidedBy: 'Paul Lvutin',
    receivedAt: '2026-07-26T15:20:00.000Z',
    createSourceId: () => `source-${++counter}`,
    ...overrides
  });
}

function hasPath(value) {
  if (typeof value === 'string') return value.includes('/private/') || value.includes('\\\\');
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasPath);
}

test('service sermon source plan deterministically preserves reviewed service identities and only projects public metadata', () => {
  const plan = sourcePlan();
  assert.deepEqual(
    plan.importPlans.map(entry => entry.key),
    ['service:english', 'service:media', 'service:russian', 'manuscript'],
    'role keys, not object insertion order, determine packet ordering'
  );
  assert.deepEqual(
    plan.publicSources.map(entry => [entry.key, entry.fileName, entry.languages]),
    [
      ['service:english', '07-26-2026 Service ENG.pptx', ['en']],
      ['service:media', '07-26-2026 Media.pptx', ['und']],
      ['service:russian', '07-26-2026 Служение RUS.pptx', ['ru']],
      ['manuscript', 'Prayer Notes.pdf', ['en', 'ru']]
    ]
  );
  assert.equal(hasPath(plan.publicSources), false);
  assert.equal(hasPath(plan.serviceSet), false);
  assert.ok(plan.importPlans.every(entry => typeof entry.sourcePath === 'string'));
  assert.deepEqual(plan.importPlans[0].importOptions.provenance, {
    providedBy: '',
    receivedAt: '2026-07-26T15:20:00.000Z',
    sourceSystem: 'service-set',
    externalId: plan.importPlans[0].importOptions.provenance.externalId
  });
  assert.match(plan.importPlans[0].importOptions.provenance.externalId, /^service-set:[a-f0-9]{64}$/);
  assert.equal(plan.importPlans.at(-1).importOptions.provenance.providedBy, 'Paul Lvutin');
  assert.equal(plan.importPlans.at(-1).importOptions.provenance.sourceSystem, 'service-sermon-packet');
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.importPlans[0]), true);
});

test('service-set fingerprint pins every service identity, checksum, and local snapshot location', () => {
  const base = manifest();
  const fingerprint = serviceSetFingerprint(base);
  const changed = (transform) => {
    const copy = structuredClone(base);
    transform(copy);
    assert.notEqual(serviceSetFingerprint(copy), fingerprint);
  };
  changed(value => { value.inputs.english.assetId = 'asset-eng-replacement'; });
  changed(value => { value.inputs.english.sha256 = SHA_D; });
  changed(value => { value.inputs.english.pinnedPath = '/private/pinned/new/english.pptx'; });
  changed(value => { value.inputs.english.size = 9013; });
  changed(value => { value.serviceDate = '2026-08-02'; });
});

test('service sermon plan rejects malformed or non-PPTX reviewed presentations before any import plan exists', () => {
  const assertPacketError = (input, code) => assert.throws(
    () => sourcePlan({ manifest: input }),
    error => error instanceof ServiceSermonPacketError && error.code === code
  );
  const wrongExtension = manifest();
  wrongExtension.inputs.english.sourceName = '07-26-2026 Service ENG.ppt';
  assertPacketError(wrongExtension, 'UNSUPPORTED_SERVICE_PRESENTATION');

  const wrongPinnedExtension = manifest();
  wrongPinnedExtension.inputs.english.pinnedPath = '/private/pinned/english.ppt';
  assertPacketError(wrongPinnedExtension, 'UNSUPPORTED_SERVICE_PRESENTATION');

  const malformed = manifest();
  malformed.inputs.english.sha256 = 'not-a-checksum';
  assertPacketError(malformed, 'INVALID_PACKET_SOURCE');
});

test('imported source match is exact, including source identity, canonical object identity and languages', () => {
  const plan = sourcePlan();
  const expected = plan.importPlans[0];
  const imported = {
    objectId: `sha256:${expected.expected.sha256}`,
    source: {
      id: expected.importOptions.id,
      kind: expected.importOptions.kind,
      fileName: expected.expected.fileName,
      mediaType: expected.expected.mediaType,
      sha256: expected.expected.sha256,
      sizeBytes: expected.expected.sizeBytes,
      languages: [...expected.importOptions.languages],
      provenance: { ...expected.importOptions.provenance }
    }
  };
  assert.equal(importedSourceMatchesPlan(imported, expected), true);
  assert.equal(importedSourceMatchesPlan({ ...imported, objectId: 'sha256:wrong' }, expected), false);
  assert.equal(importedSourceMatchesPlan({
    ...imported,
    source: { ...imported.source, languages: ['ru'] }
  }, expected), false);
  assert.equal(importedSourceMatchesPlan({
    ...imported,
    source: { ...imported.source, id: 'source-attacker-controlled' }
  }, expected), false);
  assert.equal(importedSourceMatchesPlan({
    ...imported,
    source: {
      ...imported.source,
      provenance: {
        ...imported.source.provenance,
        providedBy: 'A different provider'
      }
    }
  }, expected), false);
  assert.equal(importedSourceMatchesPlan({
    ...imported,
    source: {
      ...imported.source,
      provenance: {
        ...imported.source.provenance,
        unexpected: 'field'
      }
    }
  }, expected), false);
});

test('linked sermon source review reuses one compatible checksum and adds only missing service files', () => {
  const plan = sourcePlan();
  const existingPlan = plan.importPlans[0];
  const dispositions = serviceSermonPacketSourceDispositions({
    sources: [{
      id: 'existing-source',
      kind: existingPlan.importOptions.kind,
      fileName: 'Pastor reviewed name.pptx',
      mediaType: existingPlan.expected.mediaType,
      sha256: existingPlan.expected.sha256,
      sizeBytes: existingPlan.expected.sizeBytes,
      languages: ['en', 'ru'],
      provenance: {
        providedBy: 'Pastor',
        receivedAt: '2026-07-25T00:00:00.000Z',
        sourceSystem: 'manual-file-picker'
      }
    }]
  }, plan);

  assert.deepEqual(
    dispositions.map(source => [
      source.key,
      source.disposition,
      source.fileName,
      source.languages
    ]),
    [
      ['service:english', 'reuse', 'Pastor reviewed name.pptx', ['en', 'ru']],
      ['service:media', 'add', '07-26-2026 Media.pptx', ['und']],
      ['service:russian', 'add', '07-26-2026 Служение RUS.pptx', ['ru']],
      ['manuscript', 'add', 'Prayer Notes.pdf', ['en', 'ru']]
    ]
  );
  assert.equal(Object.isFrozen(dispositions), true);
  assert.equal(Object.isFrozen(dispositions[0]), true);
});

test('linked sermon source review refuses ambiguous or incompatible existing checksum records', () => {
  const plan = sourcePlan();
  const expected = plan.importPlans[0];
  const compatible = {
    id: 'existing-source',
    kind: expected.importOptions.kind,
    fileName: expected.expected.fileName,
    mediaType: expected.expected.mediaType,
    sha256: expected.expected.sha256,
    sizeBytes: expected.expected.sizeBytes,
    languages: ['en'],
    provenance: {
      providedBy: '',
      receivedAt: '2026-07-25T00:00:00.000Z',
      sourceSystem: 'manual-file-picker'
    }
  };

  assert.throws(
    () => serviceSermonPacketSourceDispositions({
      sources: [compatible, { ...compatible, id: 'duplicate-source' }]
    }, plan),
    error => error instanceof ServiceSermonPacketError
      && error.code === 'AMBIGUOUS_EXISTING_PACKET_SOURCE'
  );
  assert.throws(
    () => serviceSermonPacketSourceDispositions({
      sources: [{ ...compatible, kind: 'other' }]
    }, plan),
    error => error instanceof ServiceSermonPacketError
      && error.code === 'EXISTING_PACKET_SOURCE_CONFLICT'
  );
});

test('linked sermon source review imports identical reviewed presentation bytes only once', () => {
  const duplicateManifest = manifest();
  duplicateManifest.inputs.english.sha256 =
    duplicateManifest.inputs.russian.sha256;
  duplicateManifest.inputs.english.size =
    duplicateManifest.inputs.russian.size;
  const plan = sourcePlan({ manifest: duplicateManifest });
  const dispositions = serviceSermonPacketSourceDispositions(
    { sources: [] },
    plan
  );
  assert.deepEqual(
    dispositions.map(source => [source.key, source.disposition]),
    [
      ['service:english', 'add'],
      ['service:media', 'add'],
      ['service:russian', 'reuse'],
      ['manuscript', 'add']
    ]
  );
});
