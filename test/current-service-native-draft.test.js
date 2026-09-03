'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  CurrentServiceNativeDraftError,
  ServiceProjectError,
  ServiceProjectStore,
  ShowPackagePublisher,
  buildCurrentServiceNativeDraft,
  compileServiceProject,
  nativeDraftProjectId,
  normalizeServiceProject,
  serializeServiceProject
} = require('../src/services/project');

const NOW = '2026-07-29T18:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);
const FONT_PATH = path.resolve(
  __dirname,
  '../assets/fonts/NotoSans-Variable.ttf'
);
const BINDING = Object.freeze({
  id: '2026-07-29-main',
  fingerprint: FINGERPRINT,
  serviceDate: '2026-07-29',
  profileId: 'main-sanctuary'
});
const CHANNELS = Object.freeze([
  { id: 'english', label: 'English', language: 'en' },
  { id: 'russian', label: 'Russian', language: 'ru' }
]);

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createJpeg(directory, fileName, color) {
  const filePath = path.join(directory, fileName);
  await sharp({
    create: {
      width: 640,
      height: 360,
      channels: 3,
      background: color
    }
  }).jpeg({ quality: 92 }).toFile(filePath);
  const buffer = await fs.readFile(filePath);
  const metadata = await sharp(buffer).metadata();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    descriptor: {
      assetId: `sha256:${sha256}`,
      sha256,
      size: buffer.length,
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation || 1
    },
    external: {
      assetId: `sha256:${sha256}`,
      sourcePath: filePath,
      sourceRoot: directory
    }
  };
}

function expectDraftCode(code) {
  return error => {
    assert.ok(
      error instanceof CurrentServiceNativeDraftError,
      `expected CurrentServiceNativeDraftError, got ${error?.constructor?.name}`
    );
    assert.equal(error.code, code);
    return true;
  };
}

function expectProjectCode(code) {
  return error => {
    assert.ok(
      error instanceof ServiceProjectError,
      `expected ServiceProjectError, got ${error?.constructor?.name}`
    );
    assert.equal(error.code, code);
    return true;
  };
}

test('builds deterministic runnable picture cues with exact channel mapping and no opaque deck blocks', () => {
  const shared = {
    assetId: `sha256:${'b'.repeat(64)}`,
    sha256: 'b'.repeat(64),
    size: 1200,
    width: 1920,
    height: 1080,
    orientation: 1
  };
  const englishSecond = {
    assetId: `sha256:${'c'.repeat(64)}`,
    sha256: 'c'.repeat(64),
    size: 1300,
    width: 1920,
    height: 1080,
    orientation: 1
  };
  const russianSecond = {
    assetId: `sha256:${'d'.repeat(64)}`,
    sha256: 'd'.repeat(64),
    size: 1400,
    width: 1920,
    height: 1080,
    orientation: 1
  };
  const result = buildCurrentServiceNativeDraft({
    binding: BINDING,
    title: 'Sunday Service',
    channels: CHANNELS,
    sources: [
      {
        roleId: 'english',
        channelId: 'english',
        fileName: 'Service ENG.pptx',
        slides: [shared, englishSecond]
      },
      {
        roleId: 'russian',
        channelId: 'russian',
        fileName: 'Service RUS.pptx',
        slides: [shared, russianSecond]
      }
    ],
    createdAt: NOW,
    renderRevisionId: 'e'.repeat(64)
  });

  assert.equal(result.project.id, nativeDraftProjectId(FINGERPRINT));
  assert.deepEqual(result.project.sourceServiceSet, BINDING);
  assert.equal(result.project.workflowMode, undefined);
  assert.equal(result.positionCount, 2);
  assert.equal(result.countsMatch, true);
  assert.deepEqual(result.project.rootItemIds, [
    'powerpoint-position-0001',
    'powerpoint-position-0002'
  ]);
  assert.equal(Object.keys(result.project.assets).length, 3);
  assert.ok(
    Object.values(result.project.assets).every(asset =>
      asset.kind === 'image'
      && asset.mediaType === 'image/jpeg'
      && asset.storedName === `${asset.sha256}.jpg`)
  );
  assert.deepEqual(
    result.project.items['powerpoint-position-0001'].assetIdsByChannel,
    {
      english: shared.assetId,
      russian: shared.assetId
    }
  );
  assert.deepEqual(
    result.project.items['powerpoint-position-0002'].assetIdsByChannel,
    {
      english: englishSecond.assetId,
      russian: russianSecond.assetId
    }
  );
  assert.deepEqual(
    result.project.items['powerpoint-position-0001'].sourceVisualReview,
    {
      schemaVersion: 1,
      kind: 'powerpoint-render',
      serviceSetId: BINDING.id,
      serviceSetFingerprint: BINDING.fingerprint,
      renderRevisionId: 'e'.repeat(64),
      position: 1,
      assetIdsByChannel: {
        english: shared.assetId,
        russian: shared.assetId
      }
    }
  );
  assert.deepEqual(
    result.project.items['powerpoint-position-0002'].sourceVisualReview,
    {
      schemaVersion: 1,
      kind: 'powerpoint-render',
      serviceSetId: BINDING.id,
      serviceSetFingerprint: BINDING.fingerprint,
      renderRevisionId: 'e'.repeat(64),
      position: 2,
      assetIdsByChannel: {
        english: englishSecond.assetId,
        russian: russianSecond.assetId
      }
    }
  );
  assert.ok(Object.isFrozen(
    result.project.items['powerpoint-position-0001'].sourceVisualReview
  ));
  const roundTrip = normalizeServiceProject(
    JSON.parse(serializeServiceProject(result.project))
  );
  assert.deepEqual(
    roundTrip.items['powerpoint-position-0001'].sourceVisualReview,
    result.project.items['powerpoint-position-0001'].sourceVisualReview
  );
  assert.match(
    result.project.items['powerpoint-position-0001'].operatorNotes,
    /sha256:e{64}/
  );
  const timeline = compileServiceProject(result.project);
  assert.equal(timeline.cueIds.length, 2);
  assert.doesNotMatch(JSON.stringify(timeline), /legacy-deck/);
  assert.ok(
    timeline.cueIds.every(cueId =>
      Object.values(timeline.cues[cueId].channels)
        .every(channel => channel.blocks[0].type === 'image'))
  );
  assert.doesNotMatch(JSON.stringify(result.project), /\/Users\/|C:\\\\/);
});

test('fails closed when source visual provenance is malformed or no longer matches its project and images', () => {
  const image = {
    assetId: `sha256:${'6'.repeat(64)}`,
    sha256: '6'.repeat(64),
    size: 1000,
    width: 640,
    height: 360,
    orientation: 1
  };
  const result = buildCurrentServiceNativeDraft({
    binding: BINDING,
    title: 'Sunday Service',
    channels: CHANNELS,
    sources: CHANNELS.map(channel => ({
      roleId: channel.id,
      channelId: channel.id,
      fileName: `${channel.id}.pptx`,
      slides: [image]
    })),
    createdAt: NOW,
    renderRevisionId: '7'.repeat(64)
  });
  const raw = JSON.parse(serializeServiceProject(result.project));
  const itemId = 'powerpoint-position-0001';

  const malformed = structuredClone(raw);
  malformed.items[itemId].sourceVisualReview.kind = 'unreviewed-render';
  assert.throws(
    () => normalizeServiceProject(malformed),
    expectProjectCode('INVALID_SOURCE_VISUAL_REVIEW')
  );

  const assetMismatch = structuredClone(raw);
  assetMismatch.items[itemId].sourceVisualReview.assetIdsByChannel.english =
    `sha256:${'8'.repeat(64)}`;
  assert.throws(
    () => normalizeServiceProject(assetMismatch),
    expectProjectCode('SOURCE_VISUAL_REVIEW_ASSET_MISMATCH')
  );

  const bindingMismatch = structuredClone(raw);
  bindingMismatch.items[itemId].sourceVisualReview.serviceSetFingerprint =
    '9'.repeat(64);
  assert.throws(
    () => normalizeServiceProject(bindingMismatch),
    expectProjectCode('SOURCE_VISUAL_REVIEW_SERVICE_SET_MISMATCH')
  );

  const unbound = structuredClone(raw);
  delete unbound.sourceServiceSet;
  assert.throws(
    () => normalizeServiceProject(unbound),
    expectProjectCode('SOURCE_VISUAL_REVIEW_SERVICE_SET_REQUIRED')
  );
});

test('fails closed on channel, alignment, and package-capacity ambiguity', () => {
  const image = {
    assetId: `sha256:${'f'.repeat(64)}`,
    sha256: 'f'.repeat(64),
    size: 1000,
    width: 640,
    height: 360,
    orientation: 1
  };
  const options = {
    binding: BINDING,
    title: 'Sunday Service',
    channels: CHANNELS,
    createdAt: NOW,
    renderRevisionId: '1'.repeat(64)
  };
  assert.throws(
    () => buildCurrentServiceNativeDraft({
      ...options,
      sources: [{
        roleId: 'english',
        channelId: 'english',
        fileName: 'English.pptx',
        slides: [image]
      }]
    }),
    expectDraftCode('INCOMPLETE_NATIVE_DRAFT_CHANNELS')
  );
  assert.throws(
    () => buildCurrentServiceNativeDraft({
      ...options,
      sources: [
        {
          roleId: 'english',
          channelId: 'english',
          fileName: 'English.pptx',
          slides: [image, image]
        },
        {
          roleId: 'russian',
          channelId: 'russian',
          fileName: 'Russian.pptx',
          slides: [image]
        }
      ]
    }),
    expectDraftCode('NATIVE_DRAFT_SLIDE_COUNT_MISMATCH')
  );
  assert.throws(
    () => buildCurrentServiceNativeDraft({
      ...options,
      channels: Array.from({ length: 17 }, (_value, index) => ({
        id: `channel-${index + 1}`,
        label: `Channel ${index + 1}`,
        language: 'und'
      })),
      sources: []
    }),
    expectDraftCode('INVALID_NATIVE_DRAFT_CHANNELS')
  );
  assert.throws(
    () => buildCurrentServiceNativeDraft({
      ...options,
      sources: [
        {
          roleId: 'english',
          channelId: 'english',
          fileName: 'English.pptx',
          slides: Array.from({ length: 2001 }, () => image)
        },
        {
          roleId: 'russian',
          channelId: 'russian',
          fileName: 'Russian.pptx',
          slides: Array.from({ length: 2001 }, () => image)
        }
      ]
    }),
    expectDraftCode('INVALID_NATIVE_DRAFT_SLIDE_COUNT')
  );
});

test('installs verified rendered images atomically and publishes a runnable native package', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-current-service-native-draft-'
  );
  const englishRoot = path.join(workspace, 'english-cache');
  const russianRoot = path.join(workspace, 'russian-cache');
  await fs.mkdir(englishRoot);
  await fs.mkdir(russianRoot);
  const english = await createJpeg(
    englishRoot,
    'slide_001.jpg',
    '#1d4ed8'
  );
  const russian = await createJpeg(
    russianRoot,
    'slide_001.jpg',
    '#7c3aed'
  );
  const draft = buildCurrentServiceNativeDraft({
    binding: BINDING,
    title: 'Sunday Service',
    channels: CHANNELS,
    sources: [
      {
        roleId: 'english',
        channelId: 'english',
        fileName: 'Service ENG.pptx',
        slides: [english.descriptor]
      },
      {
        roleId: 'russian',
        channelId: 'russian',
        fileName: 'Service RUS.pptx',
        slides: [russian.descriptor]
      }
    ],
    createdAt: NOW,
    renderRevisionId: '2'.repeat(64)
  });
  const store = new ServiceProjectStore({
    rootPath: path.join(workspace, 'projects'),
    clock: () => new Date(NOW)
  });
  let revalidations = 0;
  const saved = await store.createWithExternalImageAssets(
    draft.project,
    [english.external, russian.external],
    {
      beforePointerWrite: async () => {
        revalidations += 1;
      }
    }
  );
  assert.equal(revalidations, 1);
  assert.equal(saved.project.id, draft.projectId);
  for (const assetId of draft.assetIds) {
    const resolved = await store.resolveAssetPath(
      saved.project.id,
      saved.revisionId,
      assetId
    );
    assert.equal(
      crypto.createHash('sha256')
        .update(await fs.readFile(resolved.assetPath))
        .digest('hex'),
      resolved.asset.sha256
    );
  }

  const publisher = new ShowPackagePublisher({
    projectStore: store,
    rootPath: path.join(workspace, 'packages'),
    fontPath: FONT_PATH,
    clock: () => new Date(NOW)
  });
  const published = await publisher.publish({
    projectId: saved.project.id,
    revisionId: saved.revisionId,
    roleMapping: {
      englishOutput: 'english',
      russianOutput: 'russian'
    },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 88
  });
  assert.equal(published.manifest.cueCount, 1);
  assert.equal(published.presentations.englishOutput.slideCount, 1);
  assert.equal(published.presentations.russianOutput.slideCount, 1);
  assert.equal(
    published.presentations.englishOutput.scenes[0].layout,
    'picture'
  );
  assert.equal(
    published.presentations.russianOutput.scenes[0].layout,
    'picture'
  );
});

test('source mutation or failed final revalidation leaves no published project pointer', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-current-service-native-draft-failure-'
  );
  const sourceRoot = path.join(workspace, 'cache');
  await fs.mkdir(sourceRoot);
  const image = await createJpeg(
    sourceRoot,
    'slide_001.jpg',
    '#047857'
  );
  const channels = [
    { id: 'main', label: 'Main', language: 'en' }
  ];
  const draft = buildCurrentServiceNativeDraft({
    binding: BINDING,
    title: 'Sunday Service',
    channels,
    sources: [{
      roleId: 'main',
      channelId: 'main',
      fileName: 'Service.pptx',
      slides: [image.descriptor]
    }],
    createdAt: NOW,
    renderRevisionId: '3'.repeat(64)
  });
  const store = new ServiceProjectStore({
    rootPath: path.join(workspace, 'projects'),
    clock: () => new Date(NOW)
  });

  await fs.appendFile(image.external.sourcePath, Buffer.from([0]));
  await assert.rejects(
    store.createWithExternalImageAssets(
      draft.project,
      [image.external]
    ),
    error => [
      'EXTERNAL_IMAGE_SOURCE_CHANGED',
      'EXTERNAL_IMAGE_METADATA_MISMATCH'
    ].includes(error.code)
  );
  await assert.rejects(
    store.read(draft.projectId),
    error => error.code === 'PROJECT_NOT_FOUND'
  );

  const replacement = await createJpeg(
    sourceRoot,
    'replacement.jpg',
    '#047857'
  );
  const replacementDraft = buildCurrentServiceNativeDraft({
    binding: {
      ...BINDING,
      fingerprint: '4'.repeat(64)
    },
    title: 'Replacement service',
    channels,
    sources: [{
      roleId: 'main',
      channelId: 'main',
      fileName: 'Replacement.pptx',
      slides: [replacement.descriptor]
    }],
    createdAt: NOW,
    renderRevisionId: '5'.repeat(64)
  });
  await assert.rejects(
    store.createWithExternalImageAssets(
      replacementDraft.project,
      [replacement.external],
      {
        beforePointerWrite: async () => {
          const error = new Error('review changed');
          error.code = 'REVIEW_CHANGED';
          throw error;
        }
      }
    ),
    error => error.code === 'REVIEW_CHANGED'
  );
  await assert.rejects(
    store.read(replacementDraft.projectId),
    error => error.code === 'PROJECT_NOT_FOUND'
  );
});
