'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  MAX_SERMON_BODY_BYTES,
  MAX_SERMON_BODY_ENTRY_BYTES,
  SERMON_KIND,
  normalizeSermonDocument,
  sermonDocumentSha256
} = require('../src/services/sermon/SermonDocument');
const {
  NATIVE_SERMON_MATERIAL_APPLICATION_KIND,
  NATIVE_SERMON_MATERIAL_APPLICATION_SCHEMA_VERSION,
  NATIVE_SERMON_MATERIAL_COMMIT_KIND,
  NATIVE_SERMON_MATERIAL_COMMIT_SCHEMA_VERSION,
  NATIVE_SERMON_MATERIAL_PROPOSAL_KIND,
  NATIVE_SERMON_MATERIAL_PROPOSAL_SCHEMA_VERSION,
  NATIVE_SERMON_MATERIAL_REASON,
  NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT,
  NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
  NativeSermonMaterialIntakeError,
  applyNativeSermonMaterialCommit,
  buildNativeSermonMaterialProposal,
  confirmNativeSermonMaterialProposal,
  normalizeNativeSermonMaterialCommit,
  normalizeNativeSermonMaterialProposal
} = require('../src/services/sermon/NativeSermonMaterialIntake');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sermon(overrides = {}) {
  return normalizeSermonDocument({
    schemaVersion: 3,
    kind: SERMON_KIND,
    id: 'sermon-native-material',
    titles: { en: 'Native sermon material' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-08-02',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-john',
      range: {
        schemaVersion: 1,
        bookId: 'John',
        start: { chapter: 3, verse: 16 },
        end: { chapter: 3, verse: 17 }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'John 3:16-17',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    body: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    },
    ...overrides
  });
}

function binding(document, overrides = {}) {
  const revision = sermonDocumentSha256(document);
  return {
    projectId: 'service-2026-08-02',
    expectedProjectRevisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    resourceId: `sha256:${revision}`,
    resourceOwnerId: 'sermon-group',
    sermonId: document.id,
    expectedSermonRevisionId: revision,
    ...overrides
  };
}

function materials(overrides = {}) {
  return {
    manuscript: {
      text: 'Complete pastor manuscript.\n\nSecond paragraph.',
      language: 'en',
      providedBy: 'Pastor Example'
    },
    slideNotes: {
      text: 'Opening title\nMain point\nClosing application',
      language: 'en',
      providedBy: 'Pastor Example'
    },
    ...overrides
  };
}

function build(document = sermon(), materialOverrides = {}) {
  return buildNativeSermonMaterialProposal({
    sermon: document,
    binding: binding(document),
    materials: materials(materialOverrides)
  });
}

function confirmation(proposal, overrides = {}) {
  return {
    confirmed: true,
    statementId: NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
    reviewFingerprint: proposal.review.reviewFingerprint,
    materials: clone(proposal.review.materials),
    ...overrides
  };
}

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof NativeSermonMaterialIntakeError);
    assert.equal(error.code, code);
    return true;
  });
}

test('native material API exposes a versioned proposal, confirmation, and application contract', () => {
  assert.equal(NATIVE_SERMON_MATERIAL_PROPOSAL_SCHEMA_VERSION, 1);
  assert.equal(
    NATIVE_SERMON_MATERIAL_PROPOSAL_KIND,
    'syncshow-native-sermon-material-proposal'
  );
  assert.equal(NATIVE_SERMON_MATERIAL_COMMIT_SCHEMA_VERSION, 1);
  assert.equal(
    NATIVE_SERMON_MATERIAL_COMMIT_KIND,
    'syncshow-native-sermon-material-commit'
  );
  assert.equal(NATIVE_SERMON_MATERIAL_APPLICATION_SCHEMA_VERSION, 1);
  assert.equal(
    NATIVE_SERMON_MATERIAL_APPLICATION_KIND,
    'syncshow-native-sermon-material-application'
  );
  assert.equal(
    NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
    'complete-pasted-sermon-material-v1'
  );
  assert.match(
    NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT,
    /complete pasted text block/
  );
  assert.equal(NATIVE_SERMON_MATERIAL_REASON, 'add-native-sermon-material');
  assert.equal(typeof buildNativeSermonMaterialProposal, 'function');
  assert.equal(typeof confirmNativeSermonMaterialProposal, 'function');
  assert.equal(typeof applyNativeSermonMaterialCommit, 'function');
});

test('proposal canonicalizes UTF-8 text and deterministically keeps manuscript before slide notes', () => {
  const current = sermon();
  const decomposed = 'Cafe\u0301\r\nLine two\rFinal line\n';
  const slideNotes = 'Заголовок\r\nГлавная мысль';
  const proposal = buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      slideNotes: {
        text: slideNotes,
        language: 'RU',
        providedBy: '  Media Team  '
      },
      manuscript: {
        text: decomposed,
        language: 'EN',
        providedBy: '  Pastor Example  '
      }
    }
  });
  const same = buildNativeSermonMaterialProposal({
    sermon: current,
    binding: { ...binding(current) },
    materials: {
      manuscript: {
        text: 'Café\nLine two\nFinal line\n',
        language: 'en',
        providedBy: 'Pastor Example'
      },
      slideNotes: {
        text: 'Заголовок\nГлавная мысль',
        language: 'ru',
        providedBy: 'Media Team'
      }
    }
  });

  assert.deepEqual(proposal, same);
  assert.deepEqual(
    proposal.materials.map(material => material.role),
    ['manuscript', 'slide-notes']
  );
  assert.equal(
    proposal.materials[0].body.text,
    'Café\nLine two\nFinal line\n'
  );
  assert.equal(proposal.materials[0].language, 'en');
  assert.equal(proposal.materials[1].language, 'ru');
  assert.equal(proposal.materials[0].providedBy, 'Pastor Example');
  assert.equal(proposal.materials[1].providedBy, 'Media Team');

  for (const material of proposal.materials) {
    assert.equal(material.source.kind, material.role);
    assert.equal(material.body.kind, material.role);
    assert.equal(material.body.sourceId, material.source.id);
    assert.equal(material.source.sha256, digest(material.body.text));
    assert.equal(
      material.source.sizeBytes,
      Buffer.byteLength(material.body.text, 'utf8')
    );
    assert.equal(material.source.mediaType, 'text/plain');
    assert.equal(material.source.provenance.receivedAt, null);
    assert.equal(
      material.source.provenance.sourceSystem,
      'syncshow-native-paste'
    );
    assert.doesNotMatch(
      JSON.stringify(material),
      /sourcePath|filePath|localPath|absolutePath/
    );
  }
  assert.equal(
    proposal.review.statementId,
    NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID
  );
  assert.deepEqual(proposal.review.materials, [
    {
      role: 'manuscript',
      language: 'en',
      action: 'add',
      sha256: proposal.materials[0].sha256,
      sizeBytes: proposal.materials[0].sizeBytes
    },
    {
      role: 'slide-notes',
      language: 'ru',
      action: 'add',
      sha256: proposal.materials[1].sha256,
      sizeBytes: proposal.materials[1].sizeBytes
    }
  ]);
  assert.deepEqual(
    normalizeNativeSermonMaterialProposal(proposal, current),
    proposal
  );
  assert.ok(Object.isFrozen(proposal));
  assert.ok(Object.isFrozen(proposal.binding));
  assert.ok(Object.isFrozen(proposal.materials[0].source.provenance));
  assert.ok(Object.isFrozen(proposal.materials[1].body));
});

test('either role is optional while empty, unsafe, noncanonical, and excessive input fails closed', () => {
  const current = sermon();
  const slideOnly = buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: null,
      slideNotes: {
        text: 'One reviewed slide note.',
        language: 'en',
        providedBy: ''
      }
    }
  });
  assert.deepEqual(
    slideOnly.materials.map(material => material.role),
    ['slide-notes']
  );

  expectCode('MISSING_MATERIAL', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: { manuscript: null, slideNotes: null }
  }));
  expectCode('MISSING_MATERIAL_TEXT', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: { text: ' \n ', language: 'en', providedBy: '' },
      slideNotes: null
    }
  }));
  expectCode('UNSAFE_MATERIAL_TEXT', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: { text: 'Unsafe\u0000text', language: 'en', providedBy: '' },
      slideNotes: null
    }
  }));
  expectCode('UNSAFE_MATERIAL_TEXT', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: { text: `Unsafe${String.fromCharCode(0xd800)}`, language: 'en', providedBy: '' },
      slideNotes: null
    }
  }));
  expectCode('INVALID_MATERIAL_LANGUAGE', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: { text: 'Text', language: 'english', providedBy: '' },
      slideNotes: null
    }
  }));
  expectCode('INVALID_MATERIAL', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: {
        text: 'Text',
        language: 'en',
        providedBy: '',
        publication: 'public'
      },
      slideNotes: null
    }
  }));
  expectCode('MATERIAL_TOO_LARGE', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: {
        text: 'x'.repeat(MAX_SERMON_BODY_ENTRY_BYTES + 1),
        language: 'en',
        providedBy: ''
      },
      slideNotes: null
    }
  }));
  const halfPlus = Math.floor(MAX_SERMON_BODY_BYTES / 2) + 1;
  expectCode('MATERIAL_BODY_TOO_LARGE', () => buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: {
        text: 'm'.repeat(halfPlus),
        language: 'en',
        providedBy: ''
      },
      slideNotes: {
        text: 's'.repeat(halfPlus),
        language: 'en',
        providedBy: ''
      }
    }
  }));
});

test('confirmation binds the exact statement, fingerprint, roles, languages, hashes, and sizes', () => {
  const current = sermon();
  const proposal = build(current);
  const confirmed = confirmNativeSermonMaterialProposal(
    proposal,
    current,
    confirmation(proposal)
  );
  const retry = confirmNativeSermonMaterialProposal(
    clone(proposal),
    current,
    confirmation(proposal)
  );

  assert.deepEqual(confirmed, retry);
  assert.equal(confirmed.kind, NATIVE_SERMON_MATERIAL_COMMIT_KIND);
  assert.equal(confirmed.confirmation.confirmed, true);
  assert.equal(
    confirmed.confirmation.statement,
    NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT
  );
  assert.deepEqual(
    confirmed.confirmation.materials,
    proposal.review.materials
  );
  assert.deepEqual(confirmed.sources, proposal.materials.map(value => value.source));
  assert.deepEqual(
    confirmed.bodyEntries,
    proposal.materials.map(value => value.body)
  );
  assert.equal(confirmed.sourceObjects.length, 2);
  assert.equal(
    confirmed.sourceObjects[0].objectId,
    `sha256:${proposal.materials[0].sha256}`
  );
  assert.match(confirmed.commitFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    normalizeNativeSermonMaterialCommit(confirmed, current),
    confirmed
  );
  assert.ok(Object.isFrozen(confirmed));
  assert.ok(Object.isFrozen(confirmed.confirmation.materials[0]));
  assert.ok(Object.isFrozen(confirmed.sourceObjects[0]));

  expectCode('MATERIAL_REVIEW_REQUIRED', () =>
    confirmNativeSermonMaterialProposal(
      proposal,
      current,
      confirmation(proposal, { confirmed: false })
    ));
  expectCode('MATERIAL_REVIEW_STATEMENT_MISMATCH', () =>
    confirmNativeSermonMaterialProposal(
      proposal,
      current,
      confirmation(proposal, { statementId: 'different-review' })
    ));
  expectCode('MATERIAL_REVIEW_FINGERPRINT_MISMATCH', () =>
    confirmNativeSermonMaterialProposal(
      proposal,
      current,
      confirmation(proposal, { reviewFingerprint: 'f'.repeat(64) })
    ));
  const changedEvidence = clone(proposal.review.materials);
  changedEvidence[0].language = 'ru';
  expectCode('MATERIAL_REVIEW_EVIDENCE_MISMATCH', () =>
    confirmNativeSermonMaterialProposal(
      proposal,
      current,
      confirmation(proposal, { materials: changedEvidence })
    ));
});

test('identical bytes keep distinct semantic roles but require only one private object', () => {
  const current = sermon();
  const proposal = buildNativeSermonMaterialProposal({
    sermon: current,
    binding: binding(current),
    materials: {
      manuscript: {
        text: 'The same reviewed words.',
        language: 'en',
        providedBy: 'Pastor Example'
      },
      slideNotes: {
        text: 'The same reviewed words.',
        language: 'en',
        providedBy: 'Pastor Example'
      }
    }
  });
  const commit = confirmNativeSermonMaterialProposal(
    proposal,
    current,
    confirmation(proposal)
  );

  assert.equal(commit.sources.length, 2);
  assert.equal(commit.bodyEntries.length, 2);
  assert.equal(commit.sourceObjects.length, 1);
  assert.notEqual(commit.sources[0].id, commit.sources[1].id);
  assert.notEqual(commit.bodyEntries[0].id, commit.bodyEntries[1].id);
  assert.equal(commit.sources[0].sha256, commit.sources[1].sha256);
});

test('one exact application creates a coordinator-ready revision and reopens published content', () => {
  const current = sermon({
    publication: {
      status: 'published',
      visibility: 'members',
      publishedAt: '2026-08-02T20:00:00.000Z',
      canonicalUrl: 'https://church.example/sermons/native-material'
    }
  });
  const before = clone(current);
  const proposal = build(current);
  const commit = confirmNativeSermonMaterialProposal(
    proposal,
    current,
    confirmation(proposal)
  );
  const applied = applyNativeSermonMaterialCommit(current, commit);

  assert.equal(applied.schemaVersion, 1);
  assert.equal(applied.kind, NATIVE_SERMON_MATERIAL_APPLICATION_KIND);
  assert.equal(applied.document.schemaVersion, 3);
  assert.deepEqual(
    applied.document.sources.slice(-2),
    commit.sources
  );
  assert.deepEqual(
    applied.document.body.slice(-2),
    commit.bodyEntries
  );
  assert.equal(applied.document.publication.status, 'draft');
  assert.equal(applied.document.publication.publishedAt, null);
  assert.equal(applied.document.publication.visibility, 'members');
  assert.equal(
    applied.document.publication.canonicalUrl,
    'https://church.example/sermons/native-material'
  );
  assert.equal(applied.revision, sermonDocumentSha256(applied.document));
  assert.deepEqual(applied.addedRoles, ['manuscript', 'slide-notes']);
  assert.deepEqual(applied.replacedRoles, []);
  assert.deepEqual(applied.unchangedRoles, []);
  assert.equal(applied.requiresCommit, true);
  assert.deepEqual(
    applied.changedSourceIds,
    commit.sources.map(source => source.id)
  );
  assert.deepEqual(
    applied.changedBodyEntryIds,
    commit.bodyEntries.map(entry => entry.id)
  );
  assert.deepEqual(applied.sourceObjects, commit.sourceObjects);
  assert.deepEqual(applied.confirmation, commit.confirmation);
  assert.deepEqual(applied.transaction, {
    projectId: 'service-2026-08-02',
    expectedProjectRevisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    resourceOwnerId: 'sermon-group',
    previousResourceId: binding(current).resourceId,
    nextResourceId: `sha256:${applied.revision}`,
    sermonId: current.id,
    expectedSermonRevision: sermonDocumentSha256(current),
    nextSermonRevision: applied.revision,
    required: true,
    reason: NATIVE_SERMON_MATERIAL_REASON
  });
  assert.deepEqual(current, before, 'application must not mutate the exact input');
  assert.deepEqual(normalizeSermonDocument(applied.document), applied.document);
  assert.ok(Object.isFrozen(applied));
  assert.ok(Object.isFrozen(applied.document.body.at(-1)));
  assert.ok(Object.isFrozen(applied.transaction));
});

test('stale, archived, and tampered material cannot advance a revision while identical text is a no-op', () => {
  const current = sermon();
  const proposal = build(current);
  const commit = confirmNativeSermonMaterialProposal(
    proposal,
    current,
    confirmation(proposal)
  );
  const applied = applyNativeSermonMaterialCommit(current, commit);
  const changed = normalizeSermonDocument({
    ...current,
    titles: { en: 'Changed after review' }
  });
  expectCode('SERMON_REVISION_MISMATCH', () =>
    applyNativeSermonMaterialCommit(changed, commit));

  const tampered = clone(commit);
  tampered.bodyEntries[0].text = 'Changed after confirmation.';
  expectCode('MATERIAL_REVIEW_FINGERPRINT_MISMATCH', () =>
    applyNativeSermonMaterialCommit(current, tampered));

  const archived = sermon({
    publication: {
      status: 'archived',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  });
  expectCode('ARCHIVED_SERMON', () => buildNativeSermonMaterialProposal({
    sermon: archived,
    binding: binding(archived),
    materials: materials()
  }));

  const unchangedProposal = buildNativeSermonMaterialProposal({
    sermon: applied.document,
    binding: binding(applied.document, {
      expectedProjectRevisionId: 'b'.repeat(64),
      resourceId: `sha256:${applied.revision}`,
      expectedSermonRevisionId: applied.revision
    }),
    materials: materials()
  });
  assert.deepEqual(
    unchangedProposal.materials.map(material => material.change.action),
    ['unchanged', 'unchanged']
  );
  const unchangedCommit = confirmNativeSermonMaterialProposal(
    unchangedProposal,
    applied.document,
    confirmation(unchangedProposal)
  );
  const unchangedApplication = applyNativeSermonMaterialCommit(
    applied.document,
    unchangedCommit
  );
  assert.equal(unchangedApplication.requiresCommit, false);
  assert.deepEqual(unchangedApplication.addedRoles, []);
  assert.deepEqual(unchangedApplication.replacedRoles, []);
  assert.deepEqual(
    unchangedApplication.unchangedRoles,
    ['manuscript', 'slide-notes']
  );
  assert.deepEqual(unchangedApplication.changedSourceIds, []);
  assert.deepEqual(unchangedApplication.changedBodyEntryIds, []);
  assert.deepEqual(unchangedApplication.sourceObjects, []);
  assert.deepEqual(unchangedApplication.document, applied.document);
  assert.equal(unchangedApplication.revision, applied.revision);
  assert.equal(unchangedApplication.transaction.required, false);

  expectCode('SERMON_REVISION_MISMATCH', () =>
    applyNativeSermonMaterialCommit(applied.document, commit));
});

test('re-paste replaces only the managed role and language while preserving file-attached material', () => {
  const fileText = 'Preserved file-attached manuscript.';
  const fileSource = {
    id: 'file-manuscript',
    kind: 'manuscript',
    fileName: 'pastor-original.md',
    mediaType: 'text/markdown',
    sha256: digest(fileText),
    sizeBytes: Buffer.byteLength(fileText, 'utf8'),
    provenance: {
      providedBy: 'Pastor Example',
      receivedAt: '2026-08-01T17:00:00.000Z',
      sourceSystem: 'manual-file-picker',
      externalId: ''
    },
    languages: ['en']
  };
  const fileBody = {
    id: 'file-body',
    kind: 'manuscript',
    language: 'en',
    sourceId: fileSource.id,
    sectionId: null,
    text: fileText
  };
  const current = sermon({
    sources: [fileSource],
    body: [fileBody]
  });
  const firstProposal = build(current);
  const firstCommit = confirmNativeSermonMaterialProposal(
    firstProposal,
    current,
    confirmation(firstProposal)
  );
  const first = applyNativeSermonMaterialCommit(current, firstCommit);
  const firstPastedManuscriptSource = first.document.sources.find(
    source => source.provenance.sourceSystem === 'syncshow-native-paste'
      && source.kind === 'manuscript'
  );
  const firstPastedManuscriptBody = first.document.body.find(
    entry => entry.sourceId === firstPastedManuscriptSource.id
  );
  const firstPastedSlideSource = first.document.sources.find(
    source => source.provenance.sourceSystem === 'syncshow-native-paste'
      && source.kind === 'slide-notes'
  );
  const preservedSource = clone(
    first.document.sources.find(source => source.id === fileSource.id)
  );
  const preservedBody = clone(
    first.document.body.find(entry => entry.id === fileBody.id)
  );

  const replacementText = 'Revised complete pastor manuscript.';
  const replacementProposal = buildNativeSermonMaterialProposal({
    sermon: first.document,
    binding: binding(first.document, {
      expectedProjectRevisionId: 'b'.repeat(64),
      resourceId: `sha256:${first.revision}`,
      expectedSermonRevisionId: first.revision
    }),
    materials: {
      manuscript: {
        text: replacementText,
        language: 'en',
        providedBy: 'Pastor Example'
      },
      slideNotes: materials().slideNotes
    }
  });
  assert.deepEqual(
    replacementProposal.materials.map(material => material.change.action),
    ['replace', 'unchanged']
  );
  const replacementCommit = confirmNativeSermonMaterialProposal(
    replacementProposal,
    first.document,
    confirmation(replacementProposal)
  );
  const replaced = applyNativeSermonMaterialCommit(
    first.document,
    replacementCommit
  );

  assert.deepEqual(replaced.addedRoles, []);
  assert.deepEqual(replaced.replacedRoles, ['manuscript']);
  assert.deepEqual(replaced.unchangedRoles, ['slide-notes']);
  assert.equal(replaced.requiresCommit, true);
  assert.equal(replaced.sourceObjects.length, 1);
  assert.deepEqual(
    replaced.document.sources.find(source => source.id === fileSource.id),
    preservedSource
  );
  assert.deepEqual(
    replaced.document.body.find(entry => entry.id === fileBody.id),
    preservedBody
  );

  const pastedSources = replaced.document.sources.filter(
    source => source.provenance.sourceSystem === 'syncshow-native-paste'
  );
  const pastedBodies = replaced.document.body.filter(
    entry => pastedSources.some(source => source.id === entry.sourceId)
  );
  assert.equal(pastedSources.length, 2);
  assert.equal(pastedBodies.length, 2);
  const replacedManuscriptSource = pastedSources.find(
    source => source.kind === 'manuscript'
  );
  const replacedManuscriptBody = pastedBodies.find(
    entry => entry.kind === 'manuscript'
  );
  const retainedSlideSource = pastedSources.find(
    source => source.kind === 'slide-notes'
  );
  assert.equal(
    replacedManuscriptSource.id,
    firstPastedManuscriptSource.id,
    'the managed role and language keep one stable source identity'
  );
  assert.equal(
    replacedManuscriptBody.id,
    firstPastedManuscriptBody.id,
    'the managed role and language keep one stable body identity'
  );
  assert.equal(replacedManuscriptBody.text, replacementText);
  assert.notEqual(
    replacedManuscriptSource.sha256,
    firstPastedManuscriptSource.sha256
  );
  assert.equal(retainedSlideSource.id, firstPastedSlideSource.id);
  assert.equal(
    replaced.document.body.some(entry =>
      entry.sourceId === replacedManuscriptSource.id
      && entry.text === materials().manuscript.text),
    false,
    'the replaced pasted body no longer remains in the next document'
  );
});
