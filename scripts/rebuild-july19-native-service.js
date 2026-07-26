#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  LocalSongLibrary,
  OUTPUT_ONLY_SONG_PROVIDER,
  ServiceProjectExchange,
  ServiceProjectStore,
  compileServiceProject,
  normalizeServiceProject,
  serializeServiceProject
} = require('../src/services/project');
const { resolveSafeOutputRoot } = require('./lib/service-deck-importer');

const APP_VERSION = require('../package.json').version;
const SERVICE_DATE = '2026-07-19';
const FIXED_BUILD_TIME = '2026-07-24T12:00:00.000Z';
const COMPLETE_SERVICE_FILE =
  '2026-07-19-07-19-2026-service-native-import.syncshow-service';
const BUILD_REPORT_FILE = '2026-07-19-native-service-rebuild-report.json';
const EXPECTED_TEMPLATE_PROJECT_ID = 'sample-2026-07-19-native-v2';
const EXPECTED_CATALOG_PROJECT_ID =
  'downloaded-song-library-2026-06-21-through-2026-07-19';
const CATALOG_GROUP_ID = 'service-date-2026-07-19';
const EXPECTED_KIND_COUNTS = Object.freeze({
  blank: 9,
  group: 12,
  notice: 10,
  picture: 3,
  sermon: 31,
  song: 6
});
const SONG_ITEM_MAP = Object.freeze({
  'song-item-budu-pet-gospodu-0719': 'service-2026-07-19-budu-pet-gospodu',
  'song-item-bog-moi-ty-skala-moya-0719':
    'service-2026-07-19-bog-moi-ty-skala-moya',
  'song-item-my-soul-will-wait-0719':
    'service-2026-07-19-my-soul-will-wait',
  'song-item-lish-odna-doroga-0719':
    'service-2026-07-19-lish-odna-doroga',
  'song-item-i-love-thy-kingdom-lord-0719':
    'service-2026-07-19-i-love-thy-kingdom-lord',
  'song-item-tserkov-telo-khristovo-0719':
    'service-2026-07-19-tserkov-telo-khristovo'
});
const CATALOG_TO_SERVICE_CHANNEL = Object.freeze({
  primary: 'primary',
  secondary: 'secondary',
  singer: 'media'
});
const SERVICE_TO_CATALOG_CHANNEL = Object.freeze({
  primary: 'primary',
  secondary: 'secondary',
  media: 'singer'
});

function usage() {
  return [
    'Usage:',
    '  node scripts/rebuild-july19-native-service.js \\',
    '    --template /absolute/reviewed-native-service-template.syncshow-service \\',
    '    --catalog /absolute/downloaded-song-library.syncshow-service \\',
    '    --work-root /absolute/new-isolated-work-root \\',
    '    [--output /absolute/complete-service.syncshow-service] \\',
    '    [--report /absolute/rebuild-report.json]',
    '',
    'This developer utility never writes to SyncShow live user data. It preserves',
    'the reviewed July 19 service structure/assets while replacing its old song',
    'pins with the final catalog resources and translation families.'
  ].join('\n');
}

function valueAfter(argumentsList, index, flag) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') {
      options.help = true;
    } else if (argument === '--template') {
      options.templatePath = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--catalog') {
      options.catalogPath = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--work-root') {
      options.workRoot = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--output') {
      options.outputPath = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--report') {
      options.reportPath = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function stableHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [
    key,
    stableValue(value[key])
  ]));
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function kindCounts(project) {
  const counts = {};
  for (const item of Object.values(project.items)) {
    counts[item.kind] = (counts[item.kind] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function itemCueMap(project) {
  const timeline = compileServiceProject(project);
  const result = new Map();
  for (const cueId of timeline.cueIds) {
    const cue = timeline.cues[cueId];
    const cues = result.get(cue.itemId) || [];
    cues.push(cue);
    result.set(cue.itemId, cues);
  }
  return { timeline, cues: result };
}

function visibleCueDescriptor(cue, channelMap = null) {
  const channels = {};
  for (const [sourceChannelId, rawChannel] of Object.entries(cue.channels)) {
    const channelId = channelMap?.[sourceChannelId] || sourceChannelId;
    const channel = clone(rawChannel);
    if (channel.sourceChannelId && channelMap?.[channel.sourceChannelId]) {
      channel.sourceChannelId = channelMap[channel.sourceChannelId];
    }
    channels[channelId] = channel;
  }
  return {
    kind: cue.kind,
    presetId: cue.presetId,
    channels
  };
}

function mapCatalogVariant(rawVariant) {
  const variant = clone(rawVariant);
  if (variant.from) {
    requireCondition(
      CATALOG_TO_SERVICE_CHANNEL[variant.from],
      `Catalog variant inherits from unsupported channel ${variant.from}.`
    );
    variant.from = CATALOG_TO_SERVICE_CHANNEL[variant.from];
  }
  return variant;
}

function catalogJulyItems(catalogProject) {
  const group = catalogProject.items[CATALOG_GROUP_ID];
  requireCondition(
    group?.kind === 'group',
    `Catalog project is missing ${CATALOG_GROUP_ID}.`
  );
  const expected = Object.values(SONG_ITEM_MAP).sort();
  const actual = [...group.childIds].sort();
  requireCondition(
    sameValue(actual, expected),
    'The final catalog July 19 group no longer contains the six reviewed song occurrences.'
  );
  return new Map(group.childIds.map(itemId => [itemId, catalogProject.items[itemId]]));
}

function assertTemplateShape(templateProject) {
  requireCondition(
    templateProject.id === EXPECTED_TEMPLATE_PROJECT_ID,
    `Template project must be ${EXPECTED_TEMPLATE_PROJECT_ID}.`
  );
  requireCondition(
    templateProject.serviceDate === SERVICE_DATE,
    `Template project must use service date ${SERVICE_DATE}.`
  );
  requireCondition(
    sameValue(templateProject.channelIds, ['primary', 'secondary', 'media']),
    'Template project channel order must remain primary, secondary, media.'
  );
  requireCondition(
    sameValue(kindCounts(templateProject), EXPECTED_KIND_COUNTS),
    'Template project no longer has the reviewed 71-item kind counts.'
  );
  requireCondition(
    Object.keys(templateProject.items).length === 71,
    'Template project must contain 71 semantic items.'
  );
  requireCondition(
    Object.keys(templateProject.assets).length === 7,
    'Template project must contain seven reviewed picture assets.'
  );
  requireCondition(
    Object.values(templateProject.items).every(item =>
      item.kind !== 'imported-deck' && item.kind !== 'legacy-deck'),
    'Template project must not contain PPTX, imported-deck, or legacy-deck items.'
  );
  for (const itemId of Object.keys(SONG_ITEM_MAP)) {
    requireCondition(
      templateProject.items[itemId]?.kind === 'song',
      `Template project is missing reviewed song item ${itemId}.`
    );
  }
  requireCondition(
    compileServiceProject(templateProject).cueIds.length === 114,
    'Template project must compile to the reviewed 114-cue timeline.'
  );
}

function assertCatalogShape(catalogProject) {
  requireCondition(
    catalogProject.id === EXPECTED_CATALOG_PROJECT_ID,
    `Catalog project must be ${EXPECTED_CATALOG_PROJECT_ID}.`
  );
  requireCondition(
    catalogProject.channelIds.includes('singer'),
    'Catalog project must include its Singer channel.'
  );
  catalogJulyItems(catalogProject);
}

function rebaseJuly19Project(rawTemplateProject, rawCatalogProject, options = {}) {
  const templateProject = normalizeServiceProject(rawTemplateProject);
  const catalogProject = normalizeServiceProject(rawCatalogProject);
  assertTemplateShape(templateProject);
  assertCatalogShape(catalogProject);
  const catalogItems = catalogJulyItems(catalogProject);
  const raw = JSON.parse(serializeServiceProject(templateProject));
  const resources = {};

  for (const [templateItemId, catalogItemId] of Object.entries(SONG_ITEM_MAP)) {
    const target = raw.items[templateItemId];
    const source = catalogItems.get(catalogItemId);
    requireCondition(source?.kind === 'song', `Catalog item ${catalogItemId} is missing.`);

    target.primaryChannelId =
      CATALOG_TO_SERVICE_CHANNEL[source.primaryChannelId];
    requireCondition(
      target.primaryChannelId,
      `Catalog item ${catalogItemId} has an unsupported primary channel.`
    );
    target.variants = {};
    for (const [catalogChannelId, serviceChannelId] of
      Object.entries(CATALOG_TO_SERVICE_CHANNEL)) {
      const variant = source.variants[catalogChannelId];
      requireCondition(
        variant,
        `Catalog item ${catalogItemId} is missing channel ${catalogChannelId}.`
      );
      target.variants[serviceChannelId] = mapCatalogVariant(variant);
      if (variant.mode === 'content') {
        const resource = catalogProject.resources[variant.resourceId];
        requireCondition(
          resource?.kind === 'song',
          `Catalog item ${catalogItemId} references missing resource ${variant.resourceId}.`
        );
        resources[resource.id] = clone(resource);
      }
    }
    target.arrangement = source.arrangement.map((entry, index) => ({
      id: `arr-${templateItemId}-${String(index + 1).padStart(2, '0')}`,
      sectionId: entry.sectionId
    }));
  }

  raw.resources = resources;
  raw.revision = 0;
  raw.updatedAt = options.now || FIXED_BUILD_TIME;
  const rebased = normalizeServiceProject(raw, {
    now: new Date(options.now || FIXED_BUILD_TIME)
  });
  assertRebuildIntegrity(templateProject, catalogProject, rebased);
  return rebased;
}

function assertRebuildIntegrity(templateProject, catalogProject, rebuiltProject) {
  requireCondition(
    sameValue(rebuiltProject.rootItemIds, templateProject.rootItemIds),
    'Rebuild changed the root service order.'
  );
  requireCondition(
    sameValue(rebuiltProject.assets, templateProject.assets),
    'Rebuild changed reviewed picture asset metadata.'
  );
  requireCondition(
    sameValue(kindCounts(rebuiltProject), EXPECTED_KIND_COUNTS),
    'Rebuild changed the reviewed item-kind counts.'
  );
  for (const [itemId, templateItem] of Object.entries(templateProject.items)) {
    const rebuiltItem = rebuiltProject.items[itemId];
    requireCondition(rebuiltItem, `Rebuild removed item ${itemId}.`);
    if (templateItem.kind === 'group') {
      requireCondition(
        sameValue(rebuiltItem.childIds, templateItem.childIds),
        `Rebuild changed nesting or order under ${itemId}.`
      );
    } else if (templateItem.kind !== 'song') {
      requireCondition(
        sameValue(rebuiltItem, templateItem),
        `Rebuild changed non-song item ${itemId}.`
      );
    }
  }

  const templateCues = itemCueMap(templateProject);
  const rebuiltCues = itemCueMap(rebuiltProject);
  const catalogCues = itemCueMap(catalogProject);
  requireCondition(
    templateCues.timeline.cueIds.length === 114
      && rebuiltCues.timeline.cueIds.length === 114,
    'Rebuild must preserve the 114-position service timeline.'
  );

  for (const [itemId, item] of Object.entries(templateProject.items)) {
    if (item.kind === 'song') continue;
    const before = (templateCues.cues.get(itemId) || []).map(cue =>
      visibleCueDescriptor(cue));
    const after = (rebuiltCues.cues.get(itemId) || []).map(cue =>
      visibleCueDescriptor(cue));
    requireCondition(
      sameValue(before, after),
      `Rebuild changed visible non-song output for ${itemId}.`
    );
  }

  for (const [templateItemId, catalogItemId] of Object.entries(SONG_ITEM_MAP)) {
    const catalogOutput = (catalogCues.cues.get(catalogItemId) || []).map(cue =>
      visibleCueDescriptor(cue, CATALOG_TO_SERVICE_CHANNEL));
    const rebuiltOutput = (rebuiltCues.cues.get(templateItemId) || []).map(cue =>
      visibleCueDescriptor(cue));
    requireCondition(
      sameValue(rebuiltOutput, catalogOutput),
      `Rebuilt song ${templateItemId} does not match its final catalog occurrence.`
    );
  }

  const reusable = Object.values(rebuiltProject.resources)
    .filter(resource => resource.origin?.provider !== OUTPUT_ONLY_SONG_PROVIDER);
  const outputOnly = Object.values(rebuiltProject.resources)
    .filter(resource => resource.origin?.provider === OUTPUT_ONLY_SONG_PROVIDER);
  requireCondition(
    reusable.length === 8 && outputOnly.length === 2,
    'Rebuilt service must pin eight catalog songs and two output-only Singer resources.'
  );
  for (const resource of Object.values(rebuiltProject.resources)) {
    requireCondition(
      sameValue(resource, catalogProject.resources[resource.id]),
      `Rebuilt resource ${resource.id} differs from the final catalog pin.`
    );
  }
}

async function readRegularFile(filePath, label, maximumBytes = 128 * 1024 * 1024) {
  const stats = await fs.lstat(filePath);
  requireCondition(
    stats.isFile() && !stats.isSymbolicLink()
      && stats.size > 0 && stats.size <= maximumBytes,
    `${label} must be a regular bounded file.`
  );
  const handle = await fs.open(filePath, 'r');
  try {
    const opened = await handle.stat();
    requireCondition(
      opened.dev === stats.dev && opened.ino === stats.ino && opened.size === stats.size,
      `${label} changed while it was opened.`
    );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

async function readAssetBuffers(store, project, revisionId) {
  const buffers = new Map();
  for (const assetId of Object.keys(project.assets).sort()) {
    const resolved = await store.resolveAssetPath(project.id, revisionId, assetId);
    buffers.set(assetId, await readRegularFile(
      resolved.assetPath,
      `Template asset ${assetId}`,
      75 * 1024 * 1024
    ));
  }
  return buffers;
}

async function validateImportSequence(catalogBuffer, rebuiltBuffer, rootPath) {
  const store = new ServiceProjectStore({
    rootPath: path.join(rootPath, 'service-projects'),
    clock: () => new Date(FIXED_BUILD_TIME)
  });
  const library = new LocalSongLibrary({
    rootPath: path.join(rootPath, 'song-library'),
    clock: () => new Date(FIXED_BUILD_TIME)
  });
  await Promise.all([store.initialize(), library.initialize()]);
  const exchange = new ServiceProjectExchange({
    projectStore: store,
    songLibrary: library,
    appVersion: APP_VERSION
  });
  const catalog = await exchange.importBundle(catalogBuffer);
  requireCondition(
    catalog.songLibrary.added === 42
      && catalog.songLibrary.unchanged === 0
      && catalog.songLibrary.conflicts === 0
      && catalog.songLibrary.failed === 0,
    'Clean catalog import did not add the expected 42 reusable songs.'
  );
  const before = await library.list({ limit: 10000, offset: 0 });
  const full = await exchange.importBundle(rebuiltBuffer);
  requireCondition(
    full.songLibrary.discovered === 8
      && full.songLibrary.added === 0
      && full.songLibrary.unchanged === 8
      && full.songLibrary.conflicts === 0
      && full.songLibrary.failed === 0,
    'Full-service import did not reuse all eight eligible final catalog songs.'
  );
  const after = await library.list({ limit: 10000, offset: 0 });
  requireCondition(
    before.total === 42 && after.total === 42,
    'Full-service import changed the reusable library count after catalog import.'
  );
  const repeated = await exchange.importBundle(rebuiltBuffer);
  requireCondition(
    repeated.imported === false
      && repeated.forked === false
      && repeated.songLibrary.added === 0
      && repeated.songLibrary.unchanged === 8
      && repeated.songLibrary.conflicts === 0
      && repeated.songLibrary.failed === 0,
    'Rebuilt full service was not idempotent on re-import.'
  );
  return {
    catalogFirstImport: catalog.songLibrary,
    fullServiceSecondImport: full.songLibrary,
    fullServiceRepeatImport: repeated.songLibrary,
    reusableLibrarySongsBeforeFullService: before.total,
    reusableLibrarySongsAfterFullService: after.total,
    fullServiceImported: full.imported,
    fullServiceForked: full.forked
  };
}

async function run(options) {
  if (!options.templatePath) throw new Error('--template is required.');
  if (!options.catalogPath) throw new Error('--catalog is required.');
  if (!options.workRoot) throw new Error('--work-root is required.');
  const workRoot = await resolveSafeOutputRoot(options.workRoot);
  try {
    await fs.lstat(workRoot);
    throw new Error('--work-root must not already exist.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(workRoot, { mode: 0o700 });
  await fs.chmod(workRoot, 0o700);

  const outputPath = options.outputPath || path.join(process.cwd(), 'dist', COMPLETE_SERVICE_FILE);
  const reportPath = options.reportPath || path.join(process.cwd(), 'dist', BUILD_REPORT_FILE);
  requireCondition(
    outputPath.endsWith('.syncshow-service'),
    '--output must use the .syncshow-service extension.'
  );
  const templateBuffer = await readRegularFile(options.templatePath, 'Template bundle');
  const catalogBuffer = await readRegularFile(options.catalogPath, 'Catalog bundle');

  const inputStore = new ServiceProjectStore({
    rootPath: path.join(workRoot, 'inputs', 'service-projects'),
    clock: () => new Date(FIXED_BUILD_TIME)
  });
  await inputStore.initialize();
  const inputExchange = new ServiceProjectExchange({
    projectStore: inputStore,
    appVersion: APP_VERSION
  });
  const templateImport = await inputExchange.importBundle(templateBuffer);
  const catalogImport = await inputExchange.importBundle(catalogBuffer);
  assertTemplateShape(templateImport.project);
  assertCatalogShape(catalogImport.project);
  const assetBuffers = await readAssetBuffers(
    inputStore,
    templateImport.project,
    templateImport.revisionId
  );
  const rebuilt = rebaseJuly19Project(templateImport.project, catalogImport.project, {
    now: FIXED_BUILD_TIME
  });

  const outputStore = new ServiceProjectStore({
    rootPath: path.join(workRoot, 'output', 'service-projects'),
    clock: () => new Date(FIXED_BUILD_TIME)
  });
  await outputStore.initialize();
  const installed = await outputStore.importPortableProject(rebuilt, assetBuffers, {
    reason: 'catalog-linked-native-service'
  });
  const outputExchange = new ServiceProjectExchange({
    projectStore: outputStore,
    appVersion: APP_VERSION
  });
  const exported = await outputExchange.exportBundle(rebuilt.id, installed.revisionId);
  await writePrivateFile(outputPath, exported.buffer);

  const sequence = await validateImportSequence(
    catalogBuffer,
    exported.buffer,
    path.join(workRoot, 'clean-sequence')
  );
  const rebuiltTimeline = compileServiceProject(installed.project);
  const outputOnlyResources = Object.values(installed.project.resources)
    .filter(resource => resource.origin?.provider === OUTPUT_ONLY_SONG_PROVIDER);
  const reusableResources = Object.values(installed.project.resources)
    .filter(resource => resource.origin?.provider !== OUTPUT_ONLY_SONG_PROVIDER);
  const report = {
    schemaVersion: 1,
    kind: 'syncshow-july19-native-service-rebuild-report',
    appVersion: APP_VERSION,
    serviceDate: SERVICE_DATE,
    inputs: {
      template: {
        fileName: path.basename(options.templatePath),
        size: templateBuffer.length,
        sha256: stableHash(templateBuffer),
        projectId: templateImport.project.id,
        revisionId: templateImport.revisionId
      },
      finalCatalog: {
        fileName: path.basename(options.catalogPath),
        size: catalogBuffer.length,
        sha256: stableHash(catalogBuffer),
        projectId: catalogImport.project.id,
        revisionId: catalogImport.revisionId
      }
    },
    output: {
      fileName: path.basename(outputPath),
      size: exported.buffer.length,
      sha256: stableHash(exported.buffer),
      projectId: installed.project.id,
      revisionId: installed.revisionId
    },
    counts: {
      semanticItems: Object.keys(installed.project.items).length,
      itemKinds: kindCounts(installed.project),
      sermonItems: kindCounts(installed.project).sermon,
      nestedSermonGroups: installed.project.items['service-sermon'].childIds.length,
      assets: Object.keys(installed.project.assets).length,
      cuesPerOutput: rebuiltTimeline.cueIds.length,
      catalogSongResources: reusableResources.length,
      outputOnlySingerResources: outputOnlyResources.length
    },
    validation: {
      reviewedRootOrderPreserved: true,
      reviewedNestingPreserved: true,
      allNonSongItemsByteEquivalent: true,
      allNonSongVisibleCuesEquivalent: true,
      songVisibleCuesMatchFinalCatalogOccurrences: true,
      pictureAssetsPreservedBySha256: true,
      finalCatalogResourcesPinnedExactly: true,
      finalTranslationFamiliesPinnedExactly: true,
      combinedCatalogThenFullServiceAddsNoSongs: true,
      combinedCatalogThenFullServiceHasNoSongConflicts: true,
      fullServiceReimportIdempotent: true,
      pptxOrLegacyItems: 0
    },
    cleanImportSequence: sequence,
    coverage: {
      completeNativeServiceDates: ['2026-07-19'],
      songOnlyServiceDates: [
        '2026-06-21',
        '2026-06-28',
        '2026-07-05',
        '2026-07-12'
      ],
      psalm32CompleteNativeArtifact: false
    }
  };
  await writePrivateFile(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
  return { reportPath, outputPath, report };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await run(options);
  process.stdout.write(`${JSON.stringify({
    output: result.report.output,
    counts: result.report.counts,
    validation: result.report.validation,
    cleanImportSequence: result.report.cleanImportSequence,
    report: path.basename(result.reportPath)
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`JULY19_NATIVE_SERVICE_REBUILD_FAILED: ${error.message}\n`);
    if (process.env.SYNCSHOW_IMPORT_DEBUG === '1' && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  BUILD_REPORT_FILE,
  CATALOG_TO_SERVICE_CHANNEL,
  COMPLETE_SERVICE_FILE,
  EXPECTED_KIND_COUNTS,
  SERVICE_TO_CATALOG_CHANNEL,
  SONG_ITEM_MAP,
  assertRebuildIntegrity,
  kindCounts,
  parseArguments,
  rebaseJuly19Project,
  run,
  visibleCueDescriptor
};
