#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const {
  LocalSongLibrary,
  OUTPUT_ONLY_SONG_PROVIDER,
  ServiceProjectExchange,
  ServiceProjectStore,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compareSongTranslations,
  compileServiceProject,
  createServiceProject,
  normalizeServiceProject,
  resolveAuthoritativeSongSource
} = require('../src/services/project');
const {
  applyImportPlan,
  buildImportPlan,
  projectFingerprint,
  resolveSafeOutputRoot
} = require('./lib/service-deck-importer');
const {
  reconcileServiceSongCatalog
} = require('./lib/song-catalog-reconciler');

const PROPOSAL_KIND = 'syncshow-native-song-catalog-proposal';
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_DECK_BYTES = 500 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NORMALIZATION_SPEC_PATTERN =
  /^(\d{4}-\d{2}-\d{2}):([A-Za-z0-9][A-Za-z0-9._-]{0,95}):([A-Za-z0-9][A-Za-z0-9._-]{0,31})=([A-Za-z0-9][A-Za-z0-9._-]{0,95}):([1-9][0-9]{0,5})$/;
const APP_VERSION = require('../package.json').version;

function usage() {
  return [
    'Usage:',
    '  node scripts/build-service-song-catalog.js \\',
    '    --proposal /absolute/song-catalog-proposal.json \\',
    '    --work-root /absolute/new-isolated-work-root \\',
    '    [--source-root /absolute/folder-containing-the-decks] \\',
    '    [--artifacts-dir /absolute/output-folder] \\',
    '    [--normalization DATE:SONG_ID:CHANNEL=MODE:EXPECTED_REPLACEMENTS] \\',
    '    [--expected-occurrences N] [--expected-families N] \\',
    '    [--expected-exact-reuse N] [--expected-translation-items N]',
    '',
    'The work root must not already exist. The command never writes to SyncShow',
    'live user data. It creates five per-service portable projects, one combined',
    'one-step song-library project, and a lyric-free validation report.'
  ].join('\n');
}

function valueAfter(argumentsList, index, flag) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveInteger(value, flag, { allowZero = false } = {}) {
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`${flag} must be a whole number.`);
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be ${minimum} or greater.`);
  }
  return parsed;
}

function parseNormalizationSpec(value) {
  const match = NORMALIZATION_SPEC_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      '--normalization must use DATE:SONG_ID:CHANNEL=MODE:EXPECTED_REPLACEMENTS.'
    );
  }
  const [, serviceDate, songId, channelId, mode, expectedReplacementText] = match;
  return {
    key: `${serviceDate}:${songId}:${channelId}`,
    serviceDate,
    songId,
    channelId,
    mode,
    expectedReplacements: positiveInteger(expectedReplacementText, '--normalization')
  };
}

function parseArguments(argumentsList) {
  const options = { normalizations: new Map() };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') {
      options.help = true;
    } else if (argument === '--proposal') {
      options.proposalPath = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--work-root') {
      options.workRoot = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--source-root') {
      options.sourceRoot = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--artifacts-dir') {
      options.artifactsDir = path.resolve(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === '--normalization') {
      const spec = parseNormalizationSpec(valueAfter(argumentsList, index, argument));
      if (options.normalizations.has(spec.key)) {
        throw new Error(`Normalization ${spec.key} was supplied more than once.`);
      }
      options.normalizations.set(spec.key, spec);
      index += 1;
    } else if (argument === '--expected-occurrences') {
      options.expectedOccurrences = positiveInteger(
        valueAfter(argumentsList, index, argument),
        argument
      );
      index += 1;
    } else if (argument === '--expected-families') {
      options.expectedFamilies = positiveInteger(
        valueAfter(argumentsList, index, argument),
        argument
      );
      index += 1;
    } else if (argument === '--expected-exact-reuse') {
      options.expectedExactReuse = positiveInteger(
        valueAfter(argumentsList, index, argument),
        argument,
        { allowZero: true }
      );
      index += 1;
    } else if (argument === '--expected-translation-items') {
      options.expectedTranslationItems = positiveInteger(
        valueAfter(argumentsList, index, argument),
        argument,
        { allowZero: true }
      );
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function requireText(value, field, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${field} must be non-empty text no longer than ${maximum} characters.`);
  }
  return value.trim();
}

function requireSafeId(value, field) {
  const result = requireText(value, field, 128);
  if (!SAFE_ID_PATTERN.test(result)) throw new Error(`${field} is not a safe stable id.`);
  return result;
}

function requireDate(value, field) {
  const result = requireText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)
    || new Date(`${result}T12:00:00.000Z`).toISOString().slice(0, 10) !== result) {
    throw new Error(`${field} must be a real YYYY-MM-DD date.`);
  }
  return result;
}

function stableHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readBoundedJson(filePath, maximumBytes, field) {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximumBytes) {
    throw new Error(`${field} must be a regular file no larger than ${maximumBytes} bytes.`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function loadProposal(filePath) {
  const proposal = await readBoundedJson(filePath, MAX_PROPOSAL_BYTES, 'Proposal');
  requireRecord(proposal, 'Proposal');
  if (proposal.schemaVersion !== 1 || proposal.kind !== PROPOSAL_KIND) {
    throw new Error(`Proposal must be ${PROPOSAL_KIND} schema v1.`);
  }
  if (!Array.isArray(proposal.services) || proposal.services.length < 1 || proposal.services.length > 512) {
    throw new Error('Proposal must contain 1 to 512 services.');
  }
  return proposal;
}

function sourcePathForDeck(rawDeck, sourceRoot) {
  const deck = requireRecord(rawDeck, 'Deck');
  const proposedPath = requireText(deck.path, 'Deck path', 4096);
  const selected = sourceRoot ? path.join(sourceRoot, path.basename(proposedPath)) : proposedPath;
  if (!path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== '.pptx') {
    throw new Error('Every proposal deck must resolve to an absolute .pptx path.');
  }
  return path.resolve(selected);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function validateDeckSource(rawDeck, sourceRoot, field) {
  const deck = requireRecord(rawDeck, field);
  const expectedSha256 = requireText(deck.sha256, `${field}.sha256`, 64);
  if (!SHA256_PATTERN.test(expectedSha256)) throw new Error(`${field}.sha256 is invalid.`);
  const filePath = sourcePathForDeck(deck, sourceRoot);
  const before = await fs.lstat(filePath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > MAX_DECK_BYTES) {
    throw new Error(`${field} must resolve to a regular bounded PPTX file.`);
  }
  const handle = await fs.open(filePath, 'r');
  let buffer;
  let opened;
  try {
    opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) throw new Error(`${field} changed while it was opened.`);
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  const after = await fs.lstat(filePath);
  if (!sameFileIdentity(opened, after) || after.isSymbolicLink()) {
    throw new Error(`${field} changed while it was being verified.`);
  }
  const actualSha256 = stableHash(buffer);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${field} checksum does not match the reviewed proposal.`);
  }
  return {
    path: filePath,
    sha256: actualSha256,
    size: buffer.length,
    slideCount: positiveInteger(deck.slideCount, `${field}.slideCount`)
  };
}

function localizedTitle(song, language = null) {
  const titles = requireRecord(song.titles, `Song ${song.canonicalId} titles`);
  if (language && typeof titles[language] === 'string' && titles[language].trim()) {
    return titles[language].trim();
  }
  for (const preferred of ['ru', 'uk', 'en']) {
    if (typeof titles[preferred] === 'string' && titles[preferred].trim()) {
      return titles[preferred].trim();
    }
  }
  const title = Object.values(titles).find(value => typeof value === 'string' && value.trim());
  return requireText(title, `Song ${song.canonicalId} title`, 200);
}

function creditMetadata(song, channel) {
  const credits = isRecord(song.credits) ? song.credits : {};
  const translatedDocument = Boolean(channel.translationOf)
    || (channel.language !== 'en' && Array.isArray(credits.translators));
  return {
    ...(Array.isArray(credits.authors) ? { authors: credits.authors } : {}),
    ...(translatedDocument && Array.isArray(credits.translators)
      ? { translators: credits.translators }
      : {}),
    ...(Array.isArray(credits.composers) ? { composers: credits.composers } : {}),
    ...(typeof credits.raw === 'string' && credits.raw.trim()
      ? { attribution: credits.raw.trim() }
      : {})
  };
}

function approvedNormalization(song, serviceDate, channelId, normalizations, usedNormalizations) {
  const key = `${serviceDate}:${song.canonicalId}:${channelId}`;
  const approval = normalizations.get(key);
  if (!approval) return null;
  const proposal = song.review?.targetedTextNormalization;
  if (!isRecord(proposal)
    || proposal.status !== 'proposed_for_review_not_applied'
    || proposal.replacementCount !== approval.expectedReplacements
    || proposal.channelId !== channelId
    || proposal.mode !== approval.mode) {
    throw new Error(
      `Normalization ${key} does not exactly match a reviewed proposal and was not applied.`
    );
  }
  usedNormalizations.add(key);
  return approval.mode;
}

function contentChannelSpec(song, serviceDate, channelId, rawChannel, options) {
  const channel = requireRecord(
    rawChannel,
    `Service ${serviceDate} song ${song.canonicalId} channel ${channelId}`
  );
  const language = requireText(channel.language || 'und', `Song ${song.canonicalId} language`, 35);
  const documentId = requireSafeId(channel.documentId, `Song ${song.canonicalId} document id`);
  const normalization = approvedNormalization(
    song,
    serviceDate,
    channelId,
    options.normalizations,
    options.usedNormalizations
  );
  return {
    mode: 'content',
    ...(channel.titleCardMode ? {
      titleCardMode: requireText(
        channel.titleCardMode,
        `Song ${song.canonicalId} title card mode`,
        16
      )
    } : {}),
    deck: requireSafeId(channel.deckRole, `Song ${song.canonicalId} deck role`),
    catalog: channel.catalog !== false,
    ...(Array.isArray(channel.includeColors) ? { includeColors: channel.includeColors } : {}),
    ...(Array.isArray(channel.excludeColors) ? { excludeColors: channel.excludeColors } : {}),
    ...(normalization ? { textNormalization: normalization } : {}),
    song: {
      id: documentId,
      title: localizedTitle(song, language),
      language,
      ...(channel.translationOf ? { translationOf: channel.translationOf } : {}),
      ...creditMetadata(song, channel),
      extraMetadata: {
        catalog_family: requireSafeId(song.canonicalId, 'Canonical song family'),
        section_labels: 'provisional'
      }
    }
  };
}

function channelSpec(song, serviceDate, channelId, rawChannel, options) {
  const channel = requireRecord(
    rawChannel,
    `Service ${serviceDate} song ${song.canonicalId} channel ${channelId}`
  );
  const mode = requireText(channel.mode, `Song ${song.canonicalId} channel ${channelId} mode`, 20);
  if (mode === 'content') {
    return contentChannelSpec(song, serviceDate, channelId, channel, options);
  }
  if (mode === 'inherit') {
    return {
      mode: 'inherit',
      from: requireSafeId(channel.from, `Song ${song.canonicalId} inherited channel`),
      ...(channel.titleCardMode ? {
        titleCardMode: requireText(
          channel.titleCardMode,
          `Song ${song.canonicalId} title card mode`,
          16
        )
      } : {})
    };
  }
  if (mode === 'derive') {
    return {
      mode: 'derive',
      from: requireSafeId(channel.from, `Song ${song.canonicalId} derived channel`),
      maxLines: channel.maxLines === undefined
        ? 2
        : positiveInteger(channel.maxLines, `Song ${song.canonicalId} maxLines`),
      ...(channel.titleCardMode ? {
        titleCardMode: requireText(
          channel.titleCardMode,
          `Song ${song.canonicalId} title card mode`,
          16
        )
      } : {})
    };
  }
  if (mode === 'hidden') {
    return {
      mode: 'hidden',
      ...(channel.titleCardMode ? {
        titleCardMode: requireText(
          channel.titleCardMode,
          `Song ${song.canonicalId} title card mode`,
          16
        )
      } : {})
    };
  }
  throw new Error(`Song ${song.canonicalId} channel ${channelId} has unsupported mode ${mode}.`);
}

function rootContentChannel(song) {
  const entries = Object.entries(requireRecord(song.channels, `Song ${song.canonicalId} channels`));
  const roots = entries.filter(([_channelId, channel]) =>
    channel?.mode === 'content'
      && channel.catalog !== false
      && !channel.translationOf);
  if (roots.length !== 1) {
    throw new Error(
      `Song ${song.canonicalId} must declare exactly one catalog-eligible original/root channel.`
    );
  }
  return roots[0][0];
}

function manifestForService(rawService, options = {}) {
  const service = requireRecord(rawService, 'Service');
  const serviceId = requireSafeId(service.id, 'Service id');
  const serviceDate = requireDate(service.serviceDate, `Service ${serviceId} date`);
  if (!Array.isArray(service.songs) || service.songs.length < 1) {
    throw new Error(`Service ${serviceId} must contain at least one song.`);
  }
  const groupId = `songs-${serviceDate}`;
  const items = [{
    id: groupId,
    kind: 'group',
    title: `Songs · ${serviceDate}`,
    groupKind: 'section',
    operatorNotes: 'Imported from reviewed service decks; section labels remain provisional.'
  }];
  for (const rawSong of service.songs) {
    const song = requireRecord(rawSong, `Service ${serviceDate} song`);
    const canonicalId = requireSafeId(song.canonicalId, `Service ${serviceDate} canonical song id`);
    if (!Array.isArray(song.sections) || song.sections.length < 1) {
      throw new Error(`Song ${canonicalId} has no provisional sections.`);
    }
    if (!Array.isArray(song.arrangement) || song.arrangement.length < 1) {
      throw new Error(`Song ${canonicalId} has no arrangement.`);
    }
    const channels = {};
    for (const channelId of ['primary', 'secondary', 'singer']) {
      channels[channelId] = channelSpec(
        song,
        serviceDate,
        channelId,
        song.channels?.[channelId],
        options
      );
    }
    items.push({
      id: `${serviceId}-${canonicalId}`,
      kind: 'song',
      title: localizedTitle(song),
      parentId: groupId,
      primaryChannelId: rootContentChannel(song),
      channels,
      sections: song.sections.map((section, index) => ({
        id: requireSafeId(section.id, `Song ${canonicalId} section ${index + 1} id`),
        marker: requireText(section.marker, `Song ${canonicalId} section ${index + 1} marker`, 64),
        label: requireText(section.label, `Song ${canonicalId} section ${index + 1} label`, 200),
        slides: requireRecord(section.slides, `Song ${canonicalId} section ${index + 1} slides`)
      })),
      arrangement: song.arrangement.map((sectionId, index) =>
        requireSafeId(sectionId, `Song ${canonicalId} arrangement ${index + 1}`)),
      operatorNotes: 'Verify provisional musical section labels before permanent library cleanup.'
    });
  }
  return {
    schemaVersion: 1,
    project: {
      id: `downloaded-songs-${serviceDate}`,
      title: `Downloaded service songs · ${serviceDate}`,
      serviceDate,
      preferredProfileId: 'default',
      channels: [
        { id: 'primary', label: 'Russian', language: 'ru' },
        { id: 'secondary', label: 'English', language: 'en' },
        { id: 'singer', label: 'Singers', language: 'mul' }
      ]
    },
    items
  };
}

function projectItemsInOrder(project) {
  const result = [];
  const visit = itemId => {
    const item = project.items[itemId];
    if (!item) throw new Error(`Project order references missing item ${itemId}.`);
    result.push(item);
    if (item.kind === 'group') item.childIds.forEach(visit);
  };
  project.rootItemIds.forEach(visit);
  return result;
}

function combinedProject(reconciledServices, serviceDates) {
  const ordered = reconciledServices
    .map(service => ({
      ...service,
      serviceDate: serviceDates.get(service.id)
    }))
    .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
  const firstDate = ordered[0].serviceDate;
  const lastDate = ordered.at(-1).serviceDate;
  const now = `${lastDate}T12:00:00.000Z`;
  let combined = createServiceProject({
    id: `downloaded-song-library-${firstDate}-through-${lastDate}`,
    title: `Downloaded service song library · ${firstDate} through ${lastDate}`,
    serviceDate: lastDate,
    preferredProfileId: 'default',
    channels: [
      { id: 'primary', label: 'Russian', language: 'ru' },
      { id: 'secondary', label: 'English', language: 'en' },
      { id: 'singer', label: 'Singers', language: 'mul' }
    ],
    now
  });

  for (const service of ordered) {
    const groupId = `service-date-${service.serviceDate}`;
    combined = addGroupItem(combined, {
      id: groupId,
      title: `Service · ${service.serviceDate}`,
      groupKind: 'section',
      operatorNotes: 'Song occurrences retain the reviewed service order.',
      now
    });
    const songItems = projectItemsInOrder(service.project).filter(item => item.kind === 'song');
    for (const item of songItems) {
      const resourceMappings = new Map();
      for (const variant of Object.values(item.variants)) {
        if (variant.mode !== 'content' || resourceMappings.has(variant.resourceId)) continue;
        const sourceResource = service.project.resources[variant.resourceId];
        if (!sourceResource || sourceResource.kind !== 'song') {
          throw new Error(`Song item ${item.id} references a missing song resource.`);
        }
        const pinned = addSongResource(combined, sourceResource.document, {
          provider: sourceResource.origin?.provider || 'syncshow-song-catalog',
          providerId: sourceResource.origin?.providerId || service.id,
          itemId: sourceResource.origin?.itemId || sourceResource.document.id,
          revision: sourceResource.origin?.revision
        });
        combined = pinned.project;
        resourceMappings.set(variant.resourceId, pinned.resourceId);
      }
      const variants = Object.fromEntries(Object.entries(item.variants).map(([channelId, variant]) => [
        channelId,
        variant.mode === 'content'
          ? { ...variant, resourceId: resourceMappings.get(variant.resourceId) }
          : { ...variant }
      ]));
      combined = addProjectItem(combined, {
        id: item.id,
        kind: 'song',
        title: item.title,
        primaryChannelId: item.primaryChannelId,
        variants,
        arrangement: item.arrangement,
        titlePresetId: item.titlePresetId,
        lyricsPresetId: item.lyricsPresetId,
        operatorNotes: item.operatorNotes
      }, { parentId: groupId, now });
    }
  }
  return normalizeServiceProject(combined);
}

function projectAudit(project) {
  const timeline = compileServiceProject(project);
  const items = projectItemsInOrder(project);
  const outputOnlyResourceIds = Object.values(project.resources)
    .filter(resource => resource.origin?.provider === OUTPUT_ONLY_SONG_PROVIDER)
    .map(resource => resource.id)
    .sort();
  return {
    projectId: project.id,
    groupCount: items.filter(item => item.kind === 'group').length,
    songOccurrenceCount: items.filter(item => item.kind === 'song').length,
    itemKinds: [...new Set(items.map(item => item.kind))].sort(),
    resourceCount: Object.keys(project.resources).length,
    outputOnlyResourceCount: outputOnlyResourceIds.length,
    outputOnlyResourceIds,
    assetCount: Object.keys(project.assets).length,
    cueCount: timeline.cueIds.length,
    cueIds: timeline.cueIds
  };
}

async function auditProjectTranslationCandidates(project, library) {
  const expectedItemIds = [];
  const candidateItemIds = [];
  let candidateOptionCount = 0;
  for (const item of projectItemsInOrder(project).filter(candidate => candidate.kind === 'song')) {
    const primary = resolveAuthoritativeSongSource(project, item.id).resource.document;
    const pinnedReusableDocuments = Object.values(item.variants)
      .filter(variant => variant.mode === 'content')
      .map(variant => project.resources[variant.resourceId])
      .filter(resource =>
        resource?.kind === 'song'
        && resource.origin?.provider !== OUTPUT_ONLY_SONG_PROVIDER)
      .map(resource => resource.document);
    const hasPinnedTranslation = pinnedReusableDocuments.some(document =>
      document.id !== primary.id
      && compareSongTranslations(primary, document).compatible);
    if (!hasPinnedTranslation) continue;
    expectedItemIds.push(item.id);

    const familyId = primary.translationOf || primary.id;
    const listed = await library.list({
      query: familyId,
      pageSize: 100,
      offset: 0
    });
    let compatibleCandidates = 0;
    for (const summary of listed.items) {
      if (summary.id === primary.id) continue;
      const candidate = await library.read(summary.id, { revision: summary.revision });
      if (compareSongTranslations(primary, candidate.song).compatible) {
        compatibleCandidates += 1;
      }
    }
    if (compatibleCandidates > 0) candidateItemIds.push(item.id);
    candidateOptionCount += compatibleCandidates;
  }
  const candidateItemSet = new Set(candidateItemIds);
  return {
    expectedItemCount: expectedItemIds.length,
    candidateItemCount: candidateItemIds.length,
    candidateOptionCount,
    missingItemIds: expectedItemIds.filter(itemId => !candidateItemSet.has(itemId))
  };
}

async function writePrivateFile(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

async function writePrivateJson(filePath, value) {
  await writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileReport(filePath) {
  const buffer = await fs.readFile(filePath);
  return {
    fileName: path.basename(filePath),
    size: buffer.length,
    sha256: stableHash(buffer)
  };
}

async function exportProject(exchange, projectId, revisionId, filePath) {
  const exported = await exchange.exportBundle(projectId, revisionId);
  await writePrivateFile(filePath, exported.buffer);
  return {
    ...await fileReport(filePath),
    projectId,
    revisionId,
    assetCount: exported.assetCount,
    buffer: exported.buffer
  };
}

function expectedEquals(actual, expected, label) {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}.`);
  }
}

function lyricFreeReviewItems(proposal, reconciled) {
  return [
    ...(Array.isArray(proposal.manualReviewItems) ? proposal.manualReviewItems : []),
    ...reconciled.reviewItems.map(item => ({
      issue: item.code,
      detail: item.message,
      ...(item.serviceId ? { serviceId: item.serviceId } : {}),
      ...(item.songId ? { songId: item.songId } : {})
    }))
  ];
}

async function run(options) {
  if (!options.proposalPath) throw new Error('--proposal is required.');
  if (!options.workRoot) throw new Error('--work-root is required.');
  options.workRoot = await resolveSafeOutputRoot(options.workRoot);
  const artifactsDir = await resolveSafeOutputRoot(
    path.resolve(options.artifactsDir || path.join(process.cwd(), 'dist'))
  );
  try {
    await fs.lstat(options.workRoot);
    throw new Error('--work-root must not already exist.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(options.workRoot, { mode: 0o700 });
  await fs.chmod(options.workRoot, 0o700);
  const manifestsDir = path.join(options.workRoot, 'manifests');
  const applyRoot = path.join(options.workRoot, 'isolated-data');
  const roundTripRoot = path.join(options.workRoot, 'roundtrip-data');
  const combinedOnlyRoot = path.join(options.workRoot, 'combined-only-data');
  await Promise.all([
    fs.mkdir(manifestsDir, { mode: 0o700 }),
    fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 })
  ]);

  const proposal = await loadProposal(options.proposalPath);
  const usedNormalizations = new Set();
  const serviceDates = new Map();
  const services = [];
  const sourceDecks = [];
  for (const rawService of proposal.services) {
    const serviceId = requireSafeId(rawService.id, 'Service id');
    const serviceDate = requireDate(rawService.serviceDate, `Service ${serviceId} date`);
    if (serviceDates.has(serviceId)) throw new Error(`Service id ${serviceId} is duplicated.`);
    serviceDates.set(serviceId, serviceDate);
    const decks = {};
    for (const [role, rawDeck] of Object.entries(requireRecord(rawService.decks, `Service ${serviceId} decks`))) {
      const safeRole = requireSafeId(role, `Service ${serviceId} deck role`);
      const verified = await validateDeckSource(
        rawDeck,
        options.sourceRoot,
        `Service ${serviceId} deck ${safeRole}`
      );
      decks[safeRole] = verified.path;
      sourceDecks.push({
        serviceId,
        role: safeRole,
        fileName: path.basename(verified.path),
        sha256: verified.sha256,
        size: verified.size,
        expectedSlideCount: verified.slideCount
      });
    }
    const manifest = manifestForService(rawService, {
      normalizations: options.normalizations,
      usedNormalizations
    });
    const manifestPath = path.join(manifestsDir, `${serviceId}.json`);
    await writePrivateJson(manifestPath, manifest);
    const plan = await buildImportPlan({ manifest, decks });
    for (const [role, verifiedDeck] of Object.entries(rawService.decks)) {
      const extractedSlideCount = plan.summary.decks[role]?.slideCount;
      if (extractedSlideCount !== verifiedDeck.slideCount) {
        throw new Error(
          `Service ${serviceId} deck ${role} has ${extractedSlideCount} slides; `
          + `the reviewed proposal requires ${verifiedDeck.slideCount}.`
        );
      }
      await validateDeckSource(
        verifiedDeck,
        options.sourceRoot,
        `Service ${serviceId} deck ${role} after extraction`
      );
    }
    services.push({ id: serviceId, manifest, plan });
  }
  for (const key of options.normalizations.keys()) {
    if (!usedNormalizations.has(key)) {
      throw new Error(`Approved normalization ${key} did not match any proposal channel.`);
    }
  }

  const occurrenceCount = proposal.services
    .reduce((count, service) => count + service.songs.length, 0);
  const familyCount = new Set(proposal.services
    .flatMap(service => service.songs.map(song => song.canonicalId))).size;
  expectedEquals(occurrenceCount, options.expectedOccurrences, 'Song occurrence count');
  expectedEquals(familyCount, options.expectedFamilies, 'Canonical family count');

  const reconciled = reconcileServiceSongCatalog(services);
  expectedEquals(
    reconciled.summary.exactReuseCount,
    options.expectedExactReuse,
    'Exact document reuse count'
  );
  const normalizedCharacters = services
    .reduce((count, service) => count + service.plan.summary.extracted.normalizedCharacters, 0);
  const approvedNormalizationCharacters = [...options.normalizations.values()]
    .reduce((count, spec) => count + spec.expectedReplacements, 0);
  expectedEquals(
    normalizedCharacters,
    approvedNormalizationCharacters,
    'Reviewed normalization replacement count'
  );
  const approvedScopeKeys = new Set();
  for (const spec of options.normalizations.values()) {
    const matchingServices = services.filter(service =>
      serviceDates.get(service.id) === spec.serviceDate);
    if (matchingServices.length !== 1) {
      throw new Error(
        `Normalization ${spec.key} must resolve to exactly one reviewed service.`
      );
    }
    const service = matchingServices[0];
    const scope = `${service.id}-${spec.songId}:${spec.channelId}:${spec.mode}`;
    const actual = service.plan.summary.extracted.normalizedCharactersByScope[scope] || 0;
    if (actual !== spec.expectedReplacements) {
      throw new Error(
        `Normalization ${spec.key} expected ${spec.expectedReplacements} replacement(s), `
        + `but extraction produced ${actual}.`
      );
    }
    approvedScopeKeys.add(`${service.id}:${scope}`);
  }
  for (const service of services) {
    for (const scope of Object.keys(
      service.plan.summary.extracted.normalizedCharactersByScope
    )) {
      if (!approvedScopeKeys.has(`${service.id}:${scope}`)) {
        throw new Error(
          `Extraction produced an unapproved normalization scope ${service.id}:${scope}.`
        );
      }
    }
  }
  const normalizedCharactersByMode = [...options.normalizations.values()]
    .reduce((counts, spec) => {
      counts[spec.mode] = (counts[spec.mode] || 0) + spec.expectedReplacements;
      return counts;
    }, {});

  const firstApplyResults = [];
  const secondApplyResults = [];
  for (const service of reconciled.services) {
    const serviceClock = () => new Date(`${serviceDates.get(service.id)}T12:00:00.000Z`);
    firstApplyResults.push(await applyImportPlan(service.plan, {
      outputRoot: applyRoot,
      clock: serviceClock
    }));
  }
  for (const service of reconciled.services) {
    const serviceClock = () => new Date(`${serviceDates.get(service.id)}T12:00:00.000Z`);
    secondApplyResults.push(await applyImportPlan(service.plan, {
      outputRoot: applyRoot,
      clock: serviceClock
    }));
  }
  if (secondApplyResults.some(result =>
    !result.project.unchanged || result.songs.some(song => !song.unchanged))) {
    throw new Error('The second isolated apply was not fully idempotent.');
  }

  const lastServiceDate = [...serviceDates.values()].sort().at(-1);
  const artifactClock = () => new Date(`${lastServiceDate}T12:00:00.000Z`);
  const store = new ServiceProjectStore({
    rootPath: path.join(applyRoot, 'service-projects'),
    clock: artifactClock
  });
  const library = new LocalSongLibrary({
    rootPath: path.join(applyRoot, 'song-library'),
    clock: artifactClock
  });
  await Promise.all([store.initialize(), library.initialize()]);
  const exchange = new ServiceProjectExchange({
    projectStore: store,
    songLibrary: library,
    appVersion: APP_VERSION
  });
  const serviceArtifacts = [];
  const sourceAudits = new Map();
  for (const [index, service] of reconciled.services.entries()) {
    const applied = firstApplyResults[index];
    const selected = await store.read(service.project.id, { revisionId: applied.project.revisionId });
    const audit = projectAudit(selected.project);
    sourceAudits.set(selected.project.id, audit);
    const artifactPath = path.join(
      artifactsDir,
      `${serviceDates.get(service.id)}-downloaded-songs.syncshow-service`
    );
    serviceArtifacts.push(await exportProject(
      exchange,
      selected.project.id,
      applied.project.revisionId,
      artifactPath
    ));
  }

  const combined = combinedProject(reconciled.services, serviceDates);
  const combinedAudit = projectAudit(combined);
  expectedEquals(combinedAudit.songOccurrenceCount, occurrenceCount, 'Combined song occurrence count');
  if (combinedAudit.itemKinds.some(kind => kind !== 'group' && kind !== 'song')
    || combinedAudit.assetCount !== 0) {
    throw new Error('Combined project contains a legacy/non-native item or asset.');
  }
  const combinedSaved = await store.importPortableProject(combined, new Map(), {
    reason: 'downloaded-song-catalog-combined'
  });
  const combinedArtifactPath = path.join(
    artifactsDir,
    `${combined.id}.syncshow-service`
  );
  const combinedArtifact = await exportProject(
    exchange,
    combined.id,
    combinedSaved.revisionId,
    combinedArtifactPath
  );

  const roundTripStore = new ServiceProjectStore({
    rootPath: path.join(roundTripRoot, 'service-projects')
  });
  const roundTripLibrary = new LocalSongLibrary({
    rootPath: path.join(roundTripRoot, 'song-library')
  });
  await Promise.all([roundTripStore.initialize(), roundTripLibrary.initialize()]);
  const roundTripExchange = new ServiceProjectExchange({
    projectStore: roundTripStore,
    songLibrary: roundTripLibrary,
    appVersion: APP_VERSION
  });
  const roundTrips = [];
  for (const artifact of [...serviceArtifacts, combinedArtifact]) {
    const imported = await roundTripExchange.importBundle(artifact.buffer);
    if (imported.forked) throw new Error(`Portable project ${artifact.projectId} unexpectedly forked.`);
    const importedAudit = projectAudit(imported.project);
    const expectedAudit = artifact.projectId === combined.id
      ? combinedAudit
      : sourceAudits.get(artifact.projectId);
    const sourceProject = artifact.projectId === combined.id
      ? combined
      : reconciled.services.find(service => service.project.id === artifact.projectId).project;
    if (projectFingerprint(imported.project) !== projectFingerprint(sourceProject)) {
      throw new Error(
        `Portable project ${artifact.projectId} changed semantically during round-trip import.`
      );
    }
    if (JSON.stringify(importedAudit.cueIds) !== JSON.stringify(expectedAudit.cueIds)) {
      throw new Error(`Portable project ${artifact.projectId} changed cue identity during round-trip.`);
    }
    const repeated = await roundTripExchange.importBundle(artifact.buffer);
    if (repeated.forked || repeated.imported === true) {
      throw new Error(`Portable project ${artifact.projectId} was not idempotent on re-import.`);
    }
    roundTrips.push({
      projectId: artifact.projectId,
      cueCount: importedAudit.cueCount,
      songOccurrenceCount: importedAudit.songOccurrenceCount,
      outputOnlyResourceCount: importedAudit.outputOnlyResourceCount,
      firstImport: {
        imported: imported.imported,
        forked: imported.forked,
        songLibrary: imported.songLibrary
      },
      secondImport: {
        imported: repeated.imported,
        forked: repeated.forked,
        songLibrary: repeated.songLibrary
      }
    });
  }

  const libraryListing = await roundTripLibrary.list({ limit: 10000, offset: 0 });
  if (libraryListing.total !== reconciled.summary.catalogSongCount) {
    throw new Error(
      `Portable library hydrated ${libraryListing.total} songs; `
      + `the reconciled catalog contains ${reconciled.summary.catalogSongCount}.`
    );
  }
  const outputOnlyDocuments = Object.values(combined.resources)
    .filter(resource => resource.origin?.provider === OUTPUT_ONLY_SONG_PROVIDER)
    .map(resource => resource.document.id)
    .sort();
  for (const songId of outputOnlyDocuments) {
    try {
      await roundTripLibrary.read(songId);
      throw new Error(`Output-only Singer document ${songId} leaked into the reusable library.`);
    } catch (error) {
      if (error.code !== 'SONG_NOT_FOUND') throw error;
    }
  }

  const combinedOnlyStore = new ServiceProjectStore({
    rootPath: path.join(combinedOnlyRoot, 'service-projects')
  });
  const combinedOnlyLibrary = new LocalSongLibrary({
    rootPath: path.join(combinedOnlyRoot, 'song-library')
  });
  await Promise.all([combinedOnlyStore.initialize(), combinedOnlyLibrary.initialize()]);
  const combinedOnlyExchange = new ServiceProjectExchange({
    projectStore: combinedOnlyStore,
    songLibrary: combinedOnlyLibrary,
    appVersion: APP_VERSION
  });
  const combinedOnlyFirst = await combinedOnlyExchange.importBundle(combinedArtifact.buffer);
  if (combinedOnlyFirst.forked
    || combinedOnlyFirst.songLibrary.discovered !== reconciled.summary.catalogSongCount
    || combinedOnlyFirst.songLibrary.added !== reconciled.summary.catalogSongCount
    || combinedOnlyFirst.songLibrary.unchanged !== 0
    || combinedOnlyFirst.songLibrary.conflicts !== 0
    || combinedOnlyFirst.songLibrary.failed !== 0) {
    throw new Error(
      'The one-step combined artifact did not hydrate the complete catalog into a clean library.'
    );
  }
  if (projectFingerprint(combinedOnlyFirst.project) !== projectFingerprint(combined)
    || JSON.stringify(projectAudit(combinedOnlyFirst.project).cueIds)
      !== JSON.stringify(combinedAudit.cueIds)) {
    throw new Error('The one-step combined artifact changed during clean import.');
  }
  const combinedOnlySecond = await combinedOnlyExchange.importBundle(combinedArtifact.buffer);
  if (combinedOnlySecond.forked
    || combinedOnlySecond.imported === true
    || combinedOnlySecond.songLibrary.added !== 0
    || combinedOnlySecond.songLibrary.unchanged !== reconciled.summary.catalogSongCount
    || combinedOnlySecond.songLibrary.conflicts !== 0
    || combinedOnlySecond.songLibrary.failed !== 0) {
    throw new Error('The one-step combined artifact was not idempotent on clean re-import.');
  }
  const combinedOnlyListing = await combinedOnlyLibrary.list({ limit: 10000, offset: 0 });
  if (combinedOnlyListing.total !== reconciled.summary.catalogSongCount) {
    throw new Error('The clean one-step library count does not match the reconciled catalog.');
  }
  for (const songId of outputOnlyDocuments) {
    try {
      await combinedOnlyLibrary.read(songId);
      throw new Error(
        `Output-only Singer document ${songId} leaked during clean one-step import.`
      );
    } catch (error) {
      if (error.code !== 'SONG_NOT_FOUND') throw error;
    }
  }
  const translationCandidateAudit = await auditProjectTranslationCandidates(
    combinedOnlyFirst.project,
    combinedOnlyLibrary
  );
  expectedEquals(
    translationCandidateAudit.expectedItemCount,
    options.expectedTranslationItems,
    'Bilingual translation item count'
  );
  if (translationCandidateAudit.candidateItemCount
      !== translationCandidateAudit.expectedItemCount
    || translationCandidateAudit.missingItemIds.length > 0) {
    throw new Error(
      `${translationCandidateAudit.missingItemIds.length} bilingual service item(s) `
      + 'did not offer a structurally compatible library translation after clean import.'
    );
  }
  const combinedOnlyRoundTrip = {
    projectId: combined.id,
    firstImport: {
      imported: combinedOnlyFirst.imported,
      forked: combinedOnlyFirst.forked,
      songLibrary: combinedOnlyFirst.songLibrary
    },
    secondImport: {
      imported: combinedOnlySecond.imported,
      forked: combinedOnlySecond.forked,
      songLibrary: combinedOnlySecond.songLibrary
    },
    reusableLibrarySongs: combinedOnlyListing.total,
    outputOnlySingerDocumentsInLibrary: 0,
    translationCandidates: translationCandidateAudit,
    cueCount: projectAudit(combinedOnlyFirst.project).cueCount
  };

  const report = {
    schemaVersion: 1,
    kind: 'syncshow-service-song-catalog-build-report',
    appVersion: APP_VERSION,
    proposal: {
      fileName: path.basename(options.proposalPath),
      sha256: stableHash(await fs.readFile(options.proposalPath))
    },
    sourceDecks,
    counts: {
      services: services.length,
      sourceDecks: sourceDecks.length,
      songOccurrences: occurrenceCount,
      canonicalSongFamilies: familyCount,
      catalogSongDocuments: reconciled.summary.catalogSongCount,
      exactDocumentReuses: reconciled.summary.exactReuseCount,
      outputOnlySingerResources: reconciled.summary.outputOnlyResourceCount,
      normalizedCharacters,
      normalizedCharactersByMode,
      combinedCues: combinedAudit.cueCount,
      combinedGroups: combinedAudit.groupCount,
      roundTripLibrarySongs: libraryListing.total,
      cleanCombinedOnlyLibrarySongs: combinedOnlyListing.total,
      bilingualSongOccurrences: translationCandidateAudit.expectedItemCount,
      translationCandidateItems: translationCandidateAudit.candidateItemCount
    },
    validation: {
      sourceSha256VerifiedBeforeExtraction: true,
      sourceSha256VerifiedAfterExtraction: true,
      sourceSlideCountsVerified: true,
      isolatedRootOnly: true,
      secondApplyIdempotent: true,
      portableRoundTripExact: true,
      portableReimportIdempotent: true,
      cleanCombinedOnlyImportHydratedEntireCatalog: true,
      cleanCombinedOnlyReimportIdempotent: true,
      allBilingualItemsOfferCompatibleTranslationCandidates:
        translationCandidateAudit.candidateItemCount
          === translationCandidateAudit.expectedItemCount,
      outputOnlySingerDocumentsPinned: combinedAudit.outputOnlyResourceCount > 0,
      outputOnlySingerDocumentsExcludedFromLibrary: true,
      nativeItemKindsOnly: combinedAudit.itemKinds.every(kind => ['group', 'song'].includes(kind)),
      pptxOrLegacyItems: 0,
      assetCount: combinedAudit.assetCount
    },
    artifacts: {
      oneStepCombinedImport: {
        ...Object.fromEntries(Object.entries(combinedArtifact)
          .filter(([key]) => !['buffer'].includes(key))),
        songOccurrenceCount: combinedAudit.songOccurrenceCount,
        groupCount: combinedAudit.groupCount,
        cueCount: combinedAudit.cueCount
      },
      perService: serviceArtifacts.map(artifact => ({
        ...Object.fromEntries(Object.entries(artifact)
          .filter(([key]) => !['buffer'].includes(key))),
        ...Object.fromEntries(Object.entries(sourceAudits.get(artifact.projectId))
          .filter(([key]) => !['cueIds', 'outputOnlyResourceIds'].includes(key)))
      }))
    },
    reconciliation: reconciled.summary,
    normalizations: [...options.normalizations.values()]
      .sort((left, right) =>
        left.serviceDate.localeCompare(right.serviceDate)
        || left.songId.localeCompare(right.songId)
        || left.channelId.localeCompare(right.channelId))
      .map(spec => ({
        serviceDate: spec.serviceDate,
        songId: spec.songId,
        channelId: spec.channelId,
        mode: spec.mode,
        replacementCount: spec.expectedReplacements
      })),
    roundTrips,
    combinedOnlyRoundTrip,
    reviewItems: lyricFreeReviewItems(proposal, reconciled)
  };
  const reportPath = path.join(artifactsDir, 'downloaded-service-song-catalog-report.json');
  await writePrivateJson(reportPath, report);
  return {
    reportPath,
    report: {
      ...report,
      artifacts: {
        ...report.artifacts,
        report: await fileReport(reportPath)
      }
    }
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await run(options);
  process.stdout.write(`${JSON.stringify({
    report: path.basename(result.reportPath),
    counts: result.report.counts,
    validation: result.report.validation,
    artifacts: result.report.artifacts
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`SERVICE_SONG_CATALOG_BUILD_FAILED: ${error.message}\n`);
    if (process.env.SYNCSHOW_IMPORT_DEBUG === '1' && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  auditProjectTranslationCandidates,
  combinedProject,
  manifestForService,
  parseArguments,
  parseNormalizationSpec,
  projectAudit,
  run
};
