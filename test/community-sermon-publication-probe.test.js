'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CommunitySermonPublicationProbeError,
  verifyDeployedCommunitySermonPublication
} = require('../src/services/community/CommunitySermonPublicationProbe');
const {
  deriveSermonPublicId,
  parseSermonPublicCatalog,
  parseSermonPublicPassageIndex,
  serializeSermonPublicCatalog,
  serializeSermonPublicPassageIndex
} = require('../src/services/sermon/SermonPublicProjection');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  'fixtures',
  'community-sermon-publication-conformance-v1.json'
), 'utf8'));
const ACCESS_TOKEN = 'community-publication-probe-token-0001';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactArtifacts(overrides = {}) {
  return {
    detailSource: FIXTURE.detailSource,
    catalogSource: FIXTURE.catalogSource,
    passageIndexSource: FIXTURE.passageIndexSource,
    ...overrides
  };
}

function clientFor({
  publicationState = clone(FIXTURE.publicationState),
  artifacts = exactArtifacts(),
  publicationError = null,
  artifactError = null
} = {}) {
  const calls = {
    publication: [],
    artifacts: []
  };
  return {
    calls,
    getSermonPublication: async options => {
      calls.publication.push(options);
      if (publicationError) throw publicationError;
      return publicationState;
    },
    getSermonPublicationArtifacts: async options => {
      calls.artifacts.push(options);
      if (artifactError) throw artifactError;
      return artifacts;
    }
  };
}

function libraryFor({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    readRevision: async (sermonId, revision) => {
      calls.push({ sermonId, revision });
      if (error) throw error;
      return {
        revision,
        source: FIXTURE.documentSource,
        documentSource: FIXTURE.documentSource
      };
    }
  };
}

function expectProbeCode(code, causeCode = undefined) {
  return error => {
    assert.equal(
      error instanceof CommunitySermonPublicationProbeError,
      true
    );
    assert.equal(error.code, code);
    if (causeCode !== undefined) {
      assert.equal(error.details.causeCode, causeCode);
    }
    return true;
  };
}

test('deployed probe verifies the exact older public revision, not a newer current revision', async () => {
  const publicationState = {
    ...clone(FIXTURE.publicationState),
    currentRevision: 'f'.repeat(64),
    syncVersion: FIXTURE.publicationState.syncVersion + 1
  };
  const client = clientFor({ publicationState });
  const localLibrary = libraryFor();
  const controller = new AbortController();

  const result = await verifyDeployedCommunitySermonPublication({
    client,
    localLibrary,
    syncId: publicationState.syncId,
    accessToken: ACCESS_TOKEN,
    signal: controller.signal
  });

  assert.notEqual(
    publicationState.currentRevision,
    publicationState.publicRevision,
    'the fixture must exercise an older approved public revision'
  );
  assert.deepEqual(client.calls.publication, [{
    syncId: publicationState.syncId,
    accessToken: ACCESS_TOKEN,
    signal: controller.signal
  }, {
    syncId: publicationState.syncId,
    accessToken: ACCESS_TOKEN,
    signal: controller.signal
  }]);
  assert.deepEqual(localLibrary.calls, [{
    sermonId: publicationState.syncId,
    revision: publicationState.publicRevision
  }]);
  assert.deepEqual(client.calls.artifacts, [{
    publicId: publicationState.publicId,
    signal: controller.signal
  }]);
  assert.deepEqual(Object.keys(client.calls.artifacts[0]), [
    'publicId',
    'signal'
  ]);

  assert.deepEqual(result.summary, {
    status: 'verified-older',
    publicId: publicationState.publicId,
    publishedAt: publicationState.publishedAt,
    publicationVersion: publicationState.publicationVersion,
    bodyEntryCount: 1,
    mediaCount: 1,
    primaryReferenceCount: 1,
    mentionedReferenceCount: 1
  });
  assert.deepEqual(Object.keys(result.summary), [
    'status',
    'publicId',
    'publishedAt',
    'publicationVersion',
    'bodyEntryCount',
    'mediaCount',
    'primaryReferenceCount',
    'mentionedReferenceCount'
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.publicationState), true);
  assert.equal(Object.isFrozen(result.summary), true);

  for (const forbiddenKey of [
    'body',
    'source',
    'documentSource',
    'detailChecksum',
    'catalogChecksum',
    'passageIndexChecksum'
  ]) {
    assert.equal(
      Object.hasOwn(result.summary, forbiddenKey),
      false,
      forbiddenKey
    );
  }
  const summarySource = JSON.stringify(result.summary);
  for (const forbiddenValue of [
    'The reviewed English sermon body',
    'private-pastor-manuscript.docx',
    FIXTURE.publicationState.detailChecksum
  ]) {
    assert.equal(
      summarySource.includes(forbiddenValue),
      false,
      forbiddenValue
    );
  }
});

test('deployed probe reports verified-current only for the exact current public revision', async () => {
  const client = clientFor();
  const result = await verifyDeployedCommunitySermonPublication({
    client,
    localLibrary: libraryFor(),
    syncId: FIXTURE.publicationState.syncId,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(result.summary.status, 'verified-current');
});

test('deployed probe rejects every normalized publication receipt drift after artifact reads', async () => {
  const initial = clone(FIXTURE.publicationState);
  const withdrawn = {
    ...initial,
    publicationVersion: initial.publicationVersion + 1,
    publicRevision: null,
    publicId: null,
    detailChecksum: null,
    catalogChecksum: null,
    passageIndexChecksum: null,
    publishedAt: null,
    selectedBodyEntryIds: [],
    selectedMediaIds: []
  };
  const cases = [{
    label: 'withdrawal',
    changed: withdrawn
  }, {
    label: 'republish',
    changed: {
      ...initial,
      currentRevision: 'a'.repeat(64),
      syncVersion: initial.syncVersion + 1,
      publicationVersion: initial.publicationVersion + 1,
      publicRevision: 'a'.repeat(64),
      detailChecksum: 'b'.repeat(64),
      catalogChecksum: 'c'.repeat(64),
      passageIndexChecksum: 'd'.repeat(64),
      publishedAt: '2026-07-29T02:00:00.000Z'
    }
  }, {
    label: 'sermon identity',
    changed: {
      ...initial,
      syncId: 'sermon:different',
      publicId: deriveSermonPublicId('sermon:different')
    }
  }, {
    label: 'current revision',
    changed: {
      ...initial,
      currentRevision: 'e'.repeat(64)
    }
  }, {
    label: 'sync version',
    changed: {
      ...initial,
      syncVersion: initial.syncVersion + 1
    }
  }, {
    label: 'publication version',
    changed: {
      ...initial,
      publicationVersion: initial.publicationVersion + 1
    }
  }, {
    label: 'public revision',
    changed: {
      ...initial,
      publicRevision: '1'.repeat(64)
    }
  }, {
    label: 'detail checksum',
    changed: {
      ...initial,
      detailChecksum: '2'.repeat(64)
    }
  }, {
    label: 'catalog checksum',
    changed: {
      ...initial,
      catalogChecksum: '3'.repeat(64)
    }
  }, {
    label: 'passage-index checksum',
    changed: {
      ...initial,
      passageIndexChecksum: '4'.repeat(64)
    }
  }, {
    label: 'published time',
    changed: {
      ...initial,
      publishedAt: '2026-07-29T02:00:00.000Z'
    }
  }, {
    label: 'body selection',
    changed: {
      ...initial,
      selectedBodyEntryIds: [...initial.selectedBodyEntryIds, 'body-second']
    }
  }, {
    label: 'media selection',
    changed: {
      ...initial,
      selectedMediaIds: [...initial.selectedMediaIds, 'media-second']
    }
  }, {
    label: 'selection order',
    before: {
      ...initial,
      selectedBodyEntryIds: ['body-first', 'body-second']
    },
    changed: {
      ...initial,
      selectedBodyEntryIds: ['body-second', 'body-first']
    }
  }];

  for (const scenario of cases) {
    const client = clientFor();
    const before = scenario.before || initial;
    let publicationRead = 0;
    client.getSermonPublication = async options => {
      client.calls.publication.push(options);
      publicationRead += 1;
      return publicationRead === 1 ? before : scenario.changed;
    };

    await assert.rejects(
      verifyDeployedCommunitySermonPublication({
        client,
        localLibrary: libraryFor(),
        syncId: before.syncId,
        accessToken: ACCESS_TOKEN
      }),
      expectProbeCode('PUBLICATION_STATE_CHANGED'),
      scenario.label
    );
    assert.equal(client.calls.publication.length, 2, scenario.label);
    assert.equal(client.calls.artifacts.length, 1, scenario.label);
  }
});

test('post-artifact receipt transport and abort failures retain their original semantics', async () => {
  const transportError = Object.assign(
    new Error('second authenticated receipt failed'),
    { code: 'NETWORK_ERROR' }
  );
  const transportClient = clientFor();
  let transportRead = 0;
  transportClient.getSermonPublication = async options => {
    transportClient.calls.publication.push(options);
    transportRead += 1;
    if (transportRead === 2) throw transportError;
    return clone(FIXTURE.publicationState);
  };
  await assert.rejects(
    verifyDeployedCommunitySermonPublication({
      client: transportClient,
      localLibrary: libraryFor(),
      syncId: FIXTURE.publicationState.syncId,
      accessToken: ACCESS_TOKEN
    }),
    error => error === transportError
  );

  const controller = new AbortController();
  const abortReason = new Error('cancelled before receipt confirmation');
  const abortClient = clientFor();
  abortClient.getSermonPublicationArtifacts = async options => {
    abortClient.calls.artifacts.push(options);
    controller.abort(abortReason);
    return exactArtifacts();
  };
  await assert.rejects(
    verifyDeployedCommunitySermonPublication({
      client: abortClient,
      localLibrary: libraryFor(),
      syncId: FIXTURE.publicationState.syncId,
      accessToken: ACCESS_TOKEN,
      signal: controller.signal
    }),
    error => error === abortReason
  );
  assert.equal(abortClient.calls.publication.length, 1);
});

test('canonical detail, catalog, and passage-index tampering fail conformance', async () => {
  const tamperedCatalog = clone(parseSermonPublicCatalog(
    FIXTURE.catalogSource
  ));
  tamperedCatalog.items[0].title = 'A tampered catalog title';
  tamperedCatalog.items[0].titles.en = 'A tampered catalog title';

  const tamperedIndex = clone(parseSermonPublicPassageIndex(
    FIXTURE.passageIndexSource
  ));
  tamperedIndex.items[0].title = 'A tampered passage-index title';

  const cases = [{
    label: 'detail',
    artifacts: exactArtifacts({
      detailSource: FIXTURE.detailSource.replace(
        'The reviewed English sermon body.',
        'A tampered English sermon body.'
      )
    }),
    causeCode: 'PUBLICATION_CONFORMANCE_DETAIL_MISMATCH'
  }, {
    label: 'catalog',
    artifacts: exactArtifacts({
      catalogSource: serializeSermonPublicCatalog(tamperedCatalog)
    }),
    causeCode: 'PUBLICATION_CONFORMANCE_CATALOG_CHECKSUM_MISMATCH'
  }, {
    label: 'passage index',
    artifacts: exactArtifacts({
      passageIndexSource: serializeSermonPublicPassageIndex(tamperedIndex)
    }),
    causeCode: 'PUBLICATION_CONFORMANCE_PASSAGE_INDEX_CHECKSUM_MISMATCH'
  }];

  for (const scenario of cases) {
    const client = clientFor({ artifacts: scenario.artifacts });
    await assert.rejects(
      verifyDeployedCommunitySermonPublication({
        client,
        localLibrary: libraryFor(),
        syncId: FIXTURE.publicationState.syncId,
        accessToken: ACCESS_TOKEN
      }),
      expectProbeCode(
        'PUBLICATION_CONFORMANCE_FAILED',
        scenario.causeCode
      ),
      scenario.label
    );
  }
});

test('missing immutable public revision fails before anonymous artifact reads', async () => {
  const missing = Object.assign(
    new Error('immutable revision is unavailable'),
    { code: 'LIBRARY_REVISION_MISSING' }
  );
  const client = clientFor();
  const localLibrary = libraryFor({ error: missing });

  await assert.rejects(
    verifyDeployedCommunitySermonPublication({
      client,
      localLibrary,
      syncId: FIXTURE.publicationState.syncId,
      accessToken: ACCESS_TOKEN
    }),
    error => {
      assert.equal(expectProbeCode(
        'PUBLIC_REVISION_UNAVAILABLE',
        'LIBRARY_REVISION_MISSING'
      )(error), true);
      assert.equal(error.cause, missing);
      assert.equal(
        error.details.publicRevision,
        FIXTURE.publicationState.publicRevision
      );
      return true;
    }
  );
  assert.equal(localLibrary.calls.length, 1);
  assert.equal(client.calls.artifacts.length, 0);
});

test('withdrawn and never-published states stop before local or anonymous reads', async () => {
  for (const publicationVersion of [2, null]) {
    const publicationState = {
      ...clone(FIXTURE.publicationState),
      publicationVersion,
      publicRevision: null,
      publicId: null,
      detailChecksum: null,
      catalogChecksum: null,
      passageIndexChecksum: null,
      publishedAt: null,
      selectedBodyEntryIds: [],
      selectedMediaIds: []
    };
    const client = clientFor({ publicationState });
    const localLibrary = libraryFor();
    await assert.rejects(
      verifyDeployedCommunitySermonPublication({
        client,
        localLibrary,
        syncId: publicationState.syncId,
        accessToken: ACCESS_TOKEN
      }),
      expectProbeCode('PUBLICATION_NOT_ACTIVE')
    );
    assert.equal(localLibrary.calls.length, 0);
    assert.equal(client.calls.artifacts.length, 0);
  }
});

test('abort and public transport failures propagate without being mislabeled as conformance', async () => {
  const alreadyAborted = new AbortController();
  const abortReason = new Error('operator cancelled deployed verification');
  alreadyAborted.abort(abortReason);
  const untouchedClient = clientFor();
  await assert.rejects(
    verifyDeployedCommunitySermonPublication({
      client: untouchedClient,
      localLibrary: libraryFor(),
      syncId: FIXTURE.publicationState.syncId,
      accessToken: ACCESS_TOKEN,
      signal: alreadyAborted.signal
    }),
    error => error === abortReason
  );
  assert.equal(untouchedClient.calls.publication.length, 0);
  assert.equal(untouchedClient.calls.artifacts.length, 0);

  for (const code of [
    'UNSAFE_REDIRECT',
    'RESPONSE_TOO_LARGE',
    'INVALID_RESPONSE_ENCODING'
  ]) {
    const transportError = Object.assign(
      new Error(`mock public fetch failed: ${code}`),
      { code }
    );
    const client = clientFor({ artifactError: transportError });
    await assert.rejects(
      verifyDeployedCommunitySermonPublication({
        client,
        localLibrary: libraryFor(),
        syncId: FIXTURE.publicationState.syncId,
        accessToken: ACCESS_TOKEN
      }),
      error => error === transportError,
      code
    );
    assert.equal(client.calls.artifacts.length, 1);
  }
});

test('an abort after publication-state fetch prevents immutable and public reads', async () => {
  const controller = new AbortController();
  const abortReason = new Error('cancelled after authenticated state');
  const client = clientFor();
  client.getSermonPublication = async options => {
    client.calls.publication.push(options);
    controller.abort(abortReason);
    return clone(FIXTURE.publicationState);
  };
  const localLibrary = libraryFor();

  await assert.rejects(
    verifyDeployedCommunitySermonPublication({
      client,
      localLibrary,
      syncId: FIXTURE.publicationState.syncId,
      accessToken: ACCESS_TOKEN,
      signal: controller.signal
    }),
    error => error === abortReason
  );
  assert.equal(localLibrary.calls.length, 0);
  assert.equal(client.calls.artifacts.length, 0);
});

test('artifact wrappers are exact and cannot smuggle transport or private fields', async () => {
  for (const artifacts of [
    null,
    {
      detailSource: FIXTURE.detailSource,
      catalogSource: FIXTURE.catalogSource
    },
    {
      ...exactArtifacts(),
      accessToken: ACCESS_TOKEN
    }
  ]) {
    const client = clientFor({ artifacts });
    await assert.rejects(
      verifyDeployedCommunitySermonPublication({
        client,
        localLibrary: libraryFor(),
        syncId: FIXTURE.publicationState.syncId,
        accessToken: ACCESS_TOKEN
      }),
      expectProbeCode('INVALID_PUBLICATION_ARTIFACTS')
    );
  }
});

test('the Community barrel exports the probe without adding publication authority', () => {
  const api = require('../src/services/community');
  assert.equal(
    api.verifyDeployedCommunitySermonPublication,
    verifyDeployedCommunitySermonPublication
  );
  assert.equal(api.publishDeployedCommunitySermon, undefined);
  assert.equal(api.withdrawDeployedCommunitySermon, undefined);
});
