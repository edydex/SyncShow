'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(
  path.join(__dirname, '..', 'main.js'),
  'utf8'
);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadProjection() {
  const names = [
    'sermonConflictFingerprint',
    'middleTruncatedText',
    'publicSermonConflictLink',
    'publicSermonConflictMedia',
    'publicCommunitySermonConflictCopy'
  ];
  const source = [
    ...names.map(name => functionBlock(mainSource, name)),
    'projection = publicCommunitySermonConflictCopy;'
  ].join('\n');
  const context = {
    crypto,
    URL,
    SERMON_CONFLICT_MEDIA_LIMIT: 32,
    sermonConflictUrlProjectionKey: Buffer.alloc(32, 7),
    failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    },
    projection: null
  };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-conflict-projection.js'
  });
  return context.projection;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sermon(canonicalUrl, mediaUrls) {
  return {
    id: 'sermon-conflict-links',
    titles: { en: 'Conflict links' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [{
      id: 'private-source',
      fileName: 'pastor-notes.pdf',
      provenance: { providedBy: 'Pastor' }
    }],
    references: [],
    publication: {
      status: 'ready',
      visibility: 'members',
      publishedAt: null,
      canonicalUrl
    },
    media: mediaUrls.map((url, index) => ({
      id: `media-${index + 1}`,
      kind: index % 2 === 0 ? 'audio' : 'document',
      status: 'ready',
      title: `Media ${index + 1}`,
      language: 'en',
      fileName: `secret-${index + 1}.mp3`,
      sha256: String(index).padStart(64, '0'),
      url
    }))
  };
}

test('sermon conflict link descriptors hide query data while distinguishing exact URLs', () => {
  const project = loadProjection();
  const left = project({
    sermon: sermon(
      'https://church.example/sermons/prayer?token=left-secret',
      ['https://media.example/watch?id=one&signature=left-secret']
    ),
    revision: 'a'.repeat(64)
  });
  const right = project({
    sermon: sermon(
      'https://church.example/sermons/prayer?token=right-secret',
      ['https://media.example/watch?id=one&signature=right-secret']
    ),
    revision: 'b'.repeat(64)
  });
  const same = project({
    sermon: sermon(
      'https://church.example/sermons/prayer?token=left-secret',
      ['https://media.example/watch?id=one&signature=left-secret']
    ),
    revision: 'c'.repeat(64)
  });

  assert.deepEqual(
    plain(
    {
      origin: left.publication.canonicalLink.origin,
      path: left.publication.canonicalLink.pathDisplay,
      hidden: left.publication.canonicalLink.parametersHidden
    }),
    {
      origin: 'https://church.example',
      path: '/sermons/prayer',
      hidden: true
    }
  );
  assert.notEqual(
    left.publication.canonicalLink.fingerprint,
    right.publication.canonicalLink.fingerprint
  );
  assert.equal(
    left.publication.canonicalLink.fingerprint,
    same.publication.canonicalLink.fingerprint
  );
  assert.notEqual(
    left.media.items[0].link.fingerprint,
    right.media.items[0].link.fingerprint
  );

  const serialized = JSON.stringify({ left, right });
  for (const secret of [
    'left-secret',
    'right-secret',
    '?token=',
    '&signature=',
    'pastor-notes.pdf',
    'secret-1.mp3',
    'providedBy',
    'sha256'
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} must stay out of IPC`);
  }
  assert.equal(serialized.includes('canonicalUrl'), false);
});

test('bounded media projections signal undisplayed differences with a set fingerprint', () => {
  const project = loadProjection();
  const urls = Array.from(
    { length: 33 },
    (_value, index) => `https://media.example/item/${index + 1}?id=${index + 1}`
  );
  const first = project({
    sermon: sermon('https://church.example/sermon', urls),
    revision: 'a'.repeat(64)
  });
  const changedUrls = [...urls];
  changedUrls[32] = 'https://media.example/item/33?id=changed';
  const changed = project({
    sermon: sermon('https://church.example/sermon', changedUrls),
    revision: 'b'.repeat(64)
  });

  assert.equal(first.media.total, 33);
  assert.equal(first.media.shown, 32);
  assert.equal(first.media.items.length, 32);
  assert.equal(first.media.truncated, true);
  assert.notEqual(first.media.setFingerprint, changed.media.setFingerprint);
  assert.deepEqual(plain(first.media.items), plain(changed.media.items));
});

test('sermon conflicts expose complete ordered body text without private body provenance', () => {
  const project = loadProjection();
  const document = sermon('https://church.example/sermon', []);
  document.schemaVersion = 3;
  document.body = [{
    id: 'private-body-id',
    kind: 'manuscript',
    language: 'mul',
    sourceId: 'private-source',
    sectionId: 'private-outline-section',
    text: 'Complete reviewed first paragraph.\n\nПолный проверенный второй абзац.'
  }];

  const projected = project({
    sermon: document,
    revision: 'd'.repeat(64)
  });

  assert.equal(projected.body.length, 1);
  assert.match(
    projected.body[0].metadataFingerprint,
    /^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/
  );
  const { metadataFingerprint, ...visibleBody } = plain(projected.body[0]);
  assert.deepEqual(visibleBody, {
    position: 1,
    kind: 'manuscript',
    language: 'mul',
    text: 'Complete reviewed first paragraph.\n\nПолный проверенный второй абзац.'
  });

  const metadataChangedDocument = {
    ...document,
    body: [{
      ...document.body[0],
      id: 'different-private-body-id'
    }]
  };
  const metadataChanged = project({
    sermon: metadataChangedDocument,
    revision: 'e'.repeat(64)
  });
  assert.notEqual(
    metadataChanged.body[0].metadataFingerprint,
    metadataFingerprint,
    'hidden canonical body metadata differences must remain reviewable'
  );
  assert.deepEqual(
    plain({
      ...metadataChanged.body[0],
      metadataFingerprint
    }),
    plain(projected.body[0])
  );
  const serialized = JSON.stringify(projected);
  for (const privateValue of [
    'private-body-id',
    'private-source',
    'private-outline-section',
    'sourceId',
    'sectionId'
  ]) {
    assert.equal(
      serialized.includes(privateValue),
      false,
      `${privateValue} must stay out of conflict IPC`
    );
  }
});
