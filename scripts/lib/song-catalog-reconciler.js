'use strict';

const crypto = require('crypto');

const {
  OUTPUT_ONLY_SONG_PROVIDER,
  canonicalizeSongDocumentSectionIds,
  compareSongSections,
  normalizeServiceProject,
  normalizeSongDocument,
  serializeServiceProject
} = require('../../src/services/project');

const CATALOG_SCHEMA_VERSION = 1;
const MAX_SERVICES = 512;
const MAX_CATALOG_SONGS = 10000;
const MAX_REFERENCED_RESOURCES = 20000;
const MAX_REVIEW_ITEMS = 5000;
const SERVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class SongCatalogReconciliationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SongCatalogReconciliationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SongCatalogReconciliationError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedLookupText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en', {
    sensitivity: 'base',
    numeric: true
  }) || String(left).localeCompare(String(right), 'en', { numeric: true });
}

function contentDescriptor(rawSong) {
  const song = normalizeSongDocument(rawSong);
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    language: normalizedLookupText(song.language) || 'und',
    sections: song.sections.map(section => ({
      id: section.id,
      slides: section.slides.map(slide => ({
        lines: slide.lines.map(line => String(line).normalize('NFC'))
      }))
    }))
  };
}

function songContentFingerprint(rawSong) {
  return crypto.createHash('sha256')
    .update(`${JSON.stringify(contentDescriptor(rawSong))}\n`)
    .digest('hex');
}

function languageToken(value) {
  const token = normalizedLookupText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16);
  return token || 'und';
}

function canonicalSongId(rawSong, fingerprint = songContentFingerprint(rawSong)) {
  const song = normalizeSongDocument(rawSong);
  return `song-${languageToken(song.language)}-${fingerprint}`;
}

function sourceRecord(rawSong) {
  const canonical = canonicalizeSongDocumentSectionIds(rawSong);
  return {
    song: canonical.song,
    source: canonical.source,
    revision: crypto.createHash('sha256').update(canonical.source).digest('hex'),
    sectionIdMap: canonical.sectionIdMap
  };
}

function canonicalResource(record, fingerprint) {
  return {
    id: `sha256:${record.revision}`,
    kind: 'song',
    schemaVersion: record.song.schemaVersion,
    mediaType: 'application/vnd.syncshow.song+json',
    size: Buffer.byteLength(record.source, 'utf8'),
    sha256: record.revision,
    origin: {
      provider: 'syncshow-song-catalog',
      providerId: fingerprint,
      itemId: record.song.id,
      revision: record.revision
    },
    document: record.song
  };
}

function outputOnlyResource(record, origin = {}) {
  return {
    id: `sha256:${record.revision}`,
    kind: 'song',
    schemaVersion: record.song.schemaVersion,
    mediaType: 'application/vnd.syncshow.song+json',
    size: Buffer.byteLength(record.source, 'utf8'),
    sha256: record.revision,
    origin: {
      provider: OUTPUT_ONLY_SONG_PROVIDER,
      providerId: origin.providerId || null,
      itemId: origin.itemId || record.song.id,
      revision: record.revision
    },
    document: record.song
  };
}

function addReview(state, code, key, message, details = {}) {
  const identity = `${code}:${key}`;
  if (state.reviewKeys.has(identity)) return;
  state.reviewKeys.add(identity);
  if (state.reviewItems.length >= MAX_REVIEW_ITEMS) {
    state.omittedReviewItems += 1;
    return;
  }
  state.reviewItems.push({
    code,
    message,
    ...details
  });
}

function rankedText(values) {
  const byFoldedValue = new Map();
  for (const rawValue of values) {
    const value = String(rawValue || '').normalize('NFC').trim();
    if (!value) continue;
    const folded = normalizedLookupText(value);
    const record = byFoldedValue.get(folded) || {
      folded,
      count: 0,
      representations: new Map()
    };
    record.count += 1;
    record.representations.set(value, (record.representations.get(value) || 0) + 1);
    byFoldedValue.set(folded, record);
  }
  const choices = [...byFoldedValue.values()].sort((left, right) =>
    right.count - left.count || compareText(left.folded, right.folded));
  if (choices.length < 1) return { value: '', variants: [] };
  const selected = choices[0];
  const representations = [...selected.representations.entries()].sort((left, right) =>
    right[1] - left[1] || compareText(left[0], right[0]));
  return {
    value: representations[0][0],
    variants: choices.map(choice => choice.folded)
  };
}

function normalizedList(values) {
  const byFoldedValue = new Map();
  for (const value of values || []) {
    const normalized = String(value || '').normalize('NFC').trim();
    if (!normalized) continue;
    const folded = normalizedLookupText(normalized);
    const current = byFoldedValue.get(folded);
    if (!current || compareText(normalized, current) < 0) {
      byFoldedValue.set(folded, normalized);
    }
  }
  return [...byFoldedValue.values()].sort(compareText);
}

function mergeTags(documents) {
  return normalizedList(documents.flatMap(document => document.tags || []));
}

function mergeCreditList(documents, field, group, state) {
  const choices = new Map();
  for (const document of documents) {
    const values = normalizedList(document[field]);
    if (values.length < 1) continue;
    const key = values.map(normalizedLookupText).join('\u0000');
    const choice = choices.get(key) || {
      values,
      folded: new Set(values.map(normalizedLookupText)),
      count: 0
    };
    choice.count += 1;
    choices.set(key, choice);
  }
  if (choices.size < 1) return [];
  if (choices.size === 1) return [...choices.values()][0].values;

  const allChoices = [...choices.values()];
  const safeSupersets = allChoices.filter(candidate =>
    allChoices.every(other =>
      [...other.folded].every(value => candidate.folded.has(value))));
  if (safeSupersets.length > 0) {
    return safeSupersets.sort((left, right) =>
      right.count - left.count
      || right.values.length - left.values.length
      || compareText(left.values.join('\u0000'), right.values.join('\u0000')))[0].values;
  }

  const selected = allChoices.sort((left, right) =>
    right.count - left.count
    || right.values.length - left.values.length
    || compareText(left.values.join('\u0000'), right.values.join('\u0000')))[0];
  addReview(
    state,
    'SONG_CREDIT_CONFLICT',
    `${group.fingerprint}:${field}`,
    `Exact lyric matches disagree about ${field}; SyncShow preserved one deterministic value for review.`,
    {
      fingerprint: group.fingerprint,
      field,
      variants: allChoices.map(choice => choice.values).sort((left, right) =>
        compareText(left.join('\u0000'), right.join('\u0000')))
    }
  );
  return selected.values;
}

function mergeSingularMetadata(documents, field, group, state) {
  const selected = rankedText(documents.map(document => document[field]));
  if (selected.variants.length > 1) {
    addReview(
      state,
      'SONG_CREDIT_CONFLICT',
      `${group.fingerprint}:${field}`,
      `Exact lyric matches disagree about ${field}; SyncShow preserved one deterministic value for review.`,
      {
        fingerprint: group.fingerprint,
        field,
        variants: selected.variants
      }
    );
  }
  return selected.value;
}

function mergeExtraMetadata(documents, group, state) {
  const keys = new Set(documents.flatMap(document => Object.keys(document.extraMetadata || {})));
  const merged = {};
  for (const key of [...keys].sort(compareText)) {
    const selected = rankedText(documents.map(document => document.extraMetadata?.[key]));
    if (!selected.value) continue;
    merged[key] = selected.value;
    if (selected.variants.length > 1) {
      addReview(
        state,
        'SONG_METADATA_CONFLICT',
        `${group.fingerprint}:extraMetadata:${key}`,
        `Exact lyric matches disagree about metadata ${key}; SyncShow preserved one deterministic value for review.`,
        {
          fingerprint: group.fingerprint,
          field: `extraMetadata.${key}`,
          variants: selected.variants
        }
      );
    }
  }
  return merged;
}

function candidateIdentity(candidate) {
  return `${candidate.serviceId}:${candidate.resourceId}`;
}

function collectDirectUsage(project) {
  const usage = new Map();
  for (const itemId of Object.keys(project.items).sort(compareText)) {
    const item = project.items[itemId];
    if (item.kind !== 'song') continue;
    for (const channelId of project.channelIds) {
      const variant = item.variants[channelId];
      if (variant?.mode !== 'content') continue;
      const rows = usage.get(variant.resourceId) || [];
      rows.push({
        itemId,
        channelId,
        primary: item.primaryChannelId === channelId
      });
      usage.set(variant.resourceId, rows);
    }
  }
  return usage;
}

function collectService(rawService, index, state) {
  if (!isRecord(rawService)) {
    fail('INVALID_SERVICE', `Service ${index + 1} must be an object.`);
  }
  const plan = isRecord(rawService.plan) ? rawService.plan : rawService;
  const project = normalizeServiceProject(plan.project);
  const serviceId = String(rawService.id || project.id || '').trim();
  if (!SERVICE_ID_PATTERN.test(serviceId)) {
    fail('INVALID_SERVICE_ID', `Service ${index + 1} has an invalid stable id.`, { serviceId });
  }
  const directUsage = collectDirectUsage(project);
  const resourcesBySongId = new Map();
  for (const resource of Object.values(project.resources)) {
    if (resource.kind !== 'song') continue;
    const entries = resourcesBySongId.get(resource.document.id) || [];
    entries.push(resource);
    resourcesBySongId.set(resource.document.id, entries);
  }

  const includedResourceIds = new Set(directUsage.keys());
  const queue = [...includedResourceIds].sort(compareText);
  for (let index = 0; index < queue.length; index += 1) {
    const resource = project.resources[queue[index]];
    if (!resource?.document.translationOf) continue;
    for (const target of resourcesBySongId.get(resource.document.translationOf) || []) {
      if (target.origin?.provider === OUTPUT_ONLY_SONG_PROVIDER) continue;
      if (!includedResourceIds.has(target.id)) {
        includedResourceIds.add(target.id);
        queue.push(target.id);
      }
    }
  }
  state.referencedResources += includedResourceIds.size;
  if (state.referencedResources > MAX_REFERENCED_RESOURCES) {
    fail(
      'CATALOG_TOO_LARGE',
      `A reconciliation may inspect at most ${MAX_REFERENCED_RESOURCES} referenced song resources.`
    );
  }

  const candidates = new Map();
  for (const resourceId of [...includedResourceIds].sort(compareText)) {
    const resource = project.resources[resourceId];
    if (!resource || resource.kind !== 'song') {
      fail(
        'MISSING_SONG_RESOURCE',
        `Service ${serviceId} references unavailable song resource ${resourceId}.`,
        { serviceId, resourceId }
      );
    }
    const song = normalizeSongDocument(resource.document);
    const candidate = {
      serviceId,
      projectId: project.id,
      resourceId,
      song,
      fingerprint: songContentFingerprint(song),
      catalogEligible: resource.origin?.provider !== OUTPUT_ONLY_SONG_PROVIDER,
      directUsage: directUsage.get(resourceId) || []
    };
    candidates.set(resourceId, candidate);
  }
  const candidateFingerprintsBySongId = new Map();
  const excludedSongIds = new Set();
  for (const candidate of candidates.values()) {
    if (!candidate.catalogEligible) {
      excludedSongIds.add(candidate.song.id);
      continue;
    }
    const fingerprints = candidateFingerprintsBySongId.get(candidate.song.id) || new Set();
    fingerprints.add(candidate.fingerprint);
    candidateFingerprintsBySongId.set(candidate.song.id, fingerprints);
  }
  return {
    id: serviceId,
    plan,
    project,
    candidates,
    candidateFingerprintsBySongId,
    excludedSongIds
  };
}

function reviewIdentityCollisions(services, groups, state) {
  const fingerprintsByOriginalId = new Map();
  const fingerprintsByTitle = new Map();
  for (const group of groups.values()) {
    for (const candidate of group.candidates) {
      const byId = fingerprintsByOriginalId.get(candidate.song.id) || new Set();
      byId.add(group.fingerprint);
      fingerprintsByOriginalId.set(candidate.song.id, byId);
      const titleKey = `${normalizedLookupText(candidate.song.language)}\u0000${normalizedLookupText(candidate.song.title)}`;
      const byTitle = fingerprintsByTitle.get(titleKey) || new Set();
      byTitle.add(group.fingerprint);
      fingerprintsByTitle.set(titleKey, byTitle);
    }
  }
  for (const [songId, fingerprints] of [...fingerprintsByOriginalId.entries()].sort((left, right) =>
    compareText(left[0], right[0]))) {
    if (fingerprints.size < 2) continue;
    addReview(
      state,
      'SONG_TEXT_CONFLICT',
      songId,
      `Song id ${songId} resolves to different lyric content and was not overwritten or fuzzily merged.`,
      { songId, fingerprints: [...fingerprints].sort() }
    );
  }
  for (const [identity, fingerprints] of [...fingerprintsByTitle.entries()].sort((left, right) =>
    compareText(left[0], right[0]))) {
    if (fingerprints.size < 2) continue;
    const [language, title] = identity.split('\u0000');
    addReview(
      state,
      'SONG_TITLE_TEXT_VARIANTS',
      identity,
      `The same ${language} title appears with different lyric content; each version remains separate for review.`,
      { language, normalizedTitle: title, fingerprints: [...fingerprints].sort() }
    );
  }

  for (const service of services) {
    for (const [songId, fingerprints] of service.candidateFingerprintsBySongId) {
      if (fingerprints.size < 2) continue;
      addReview(
        state,
        'SERVICE_SONG_ID_CONFLICT',
        `${service.id}:${songId}`,
        `Service ${service.id} pins different lyric documents under song id ${songId}.`,
        { serviceId: service.id, songId, fingerprints: [...fingerprints].sort() }
      );
    }
  }
}

function declaredTranslationTarget(group, servicesById, state) {
  const relations = new Set();
  const details = [];
  for (const candidate of group.candidates) {
    const targetId = candidate.song.translationOf;
    if (!targetId) {
      relations.add('root');
      details.push({ serviceId: candidate.serviceId, relation: 'root' });
      continue;
    }
    const service = servicesById.get(candidate.serviceId);
    const targets = service.candidateFingerprintsBySongId.get(targetId);
    if (!targets || targets.size < 1) {
      const relation = service.excludedSongIds.has(targetId)
        ? `excluded:${targetId}`
        : `missing:${targetId}`;
      relations.add(relation);
      details.push({ serviceId: candidate.serviceId, relation });
      continue;
    }
    if (targets.size > 1) {
      const relation = `ambiguous:${targetId}`;
      relations.add(relation);
      details.push({ serviceId: candidate.serviceId, relation });
      continue;
    }
    const targetFingerprint = [...targets][0];
    const relation = targetFingerprint === group.fingerprint
      ? `self:${targetId}`
      : `target:${targetFingerprint}`;
    relations.add(relation);
    details.push({ serviceId: candidate.serviceId, relation });
  }

  if (relations.size === 1) {
    const relation = [...relations][0];
    if (relation === 'root') return null;
    if (relation.startsWith('target:')) return relation.slice('target:'.length);
  }
  addReview(
    state,
    'SONG_TRANSLATION_FAMILY_CONFLICT',
    group.fingerprint,
    'Exact lyric matches disagree about their translation family; SyncShow left the canonical song unlinked for review.',
    {
      fingerprint: group.fingerprint,
      relations: [...relations].sort(),
      occurrences: details.sort((left, right) =>
        compareText(left.serviceId, right.serviceId) || compareText(left.relation, right.relation))
    }
  );
  return null;
}

function removeTranslationCycles(targetByFingerprint, state) {
  const completed = new Set();
  for (const start of [...targetByFingerprint.keys()].sort()) {
    if (completed.has(start)) continue;
    const path = [];
    const indexByFingerprint = new Map();
    let current = start;
    while (current && targetByFingerprint.has(current) && !completed.has(current)) {
      if (indexByFingerprint.has(current)) {
        const cycle = path.slice(indexByFingerprint.get(current)).sort();
        for (const fingerprint of cycle) targetByFingerprint.set(fingerprint, null);
        addReview(
          state,
          'SONG_TRANSLATION_FAMILY_CYCLE',
          cycle.join(':'),
          'A declared song translation family contains a cycle; its canonical relationships were left unlinked.',
          { fingerprints: cycle }
        );
        break;
      }
      indexByFingerprint.set(current, path.length);
      path.push(current);
      current = targetByFingerprint.get(current);
    }
    path.forEach(fingerprint => completed.add(fingerprint));
  }
}

function collapseTranslationTargets(targetByFingerprint) {
  for (const fingerprint of [...targetByFingerprint.keys()].sort()) {
    let target = targetByFingerprint.get(fingerprint);
    const visited = new Set([fingerprint]);
    while (target && targetByFingerprint.get(target) && !visited.has(target)) {
      visited.add(target);
      target = targetByFingerprint.get(target);
    }
    targetByFingerprint.set(fingerprint, target || null);
  }
}

function canonicalDocumentForGroup(group, targetFingerprint, entriesByFingerprint, state) {
  const documents = group.candidates.map(candidate => candidate.song);
  const descriptor = contentDescriptor(documents[0]);
  const title = rankedText(documents.map(document => document.title)).value;
  const language = rankedText(documents.map(document => document.language)).value || descriptor.language;
  const target = targetFingerprint ? entriesByFingerprint.get(targetFingerprint) : null;
  const document = normalizeSongDocument({
    schemaVersion: 1,
    id: canonicalSongId(documents[0], group.fingerprint),
    title,
    language,
    translationOf: target?.song.id || null,
    license: mergeSingularMetadata(documents, 'license', group, state),
    tags: mergeTags(documents),
    authors: mergeCreditList(documents, 'authors', group, state),
    translators: mergeCreditList(documents, 'translators', group, state),
    composers: mergeCreditList(documents, 'composers', group, state),
    source: mergeSingularMetadata(documents, 'source', group, state),
    attribution: mergeSingularMetadata(documents, 'attribution', group, state),
    extraMetadata: mergeExtraMetadata(documents, group, state),
    sections: descriptor.sections.map(section => {
      const sourceSections = documents
        .map(document => document.sections.find(candidate => candidate.id === section.id))
        .filter(Boolean);
      return {
        ...section,
        marker: rankedText(sourceSections.map(sourceSection => sourceSection.marker)).value
          || section.id,
        label: rankedText(sourceSections.map(sourceSection => sourceSection.label)).value
          || section.id
      };
    })
  });
  return sourceRecord(document);
}

function translationOrder(fingerprints, targetByFingerprint) {
  const ordered = [];
  const visited = new Set();
  const visit = fingerprint => {
    if (visited.has(fingerprint)) return;
    const target = targetByFingerprint.get(fingerprint);
    if (target && fingerprints.has(target)) visit(target);
    visited.add(fingerprint);
    ordered.push(fingerprint);
  };
  [...fingerprints].sort().forEach(visit);
  return ordered;
}

function rewriteService(service, entriesByFingerprint, targetByFingerprint) {
  const raw = JSON.parse(serializeServiceProject(service.project));
  const resourceIdMappings = {};
  const sectionIdMappings = {};
  const usedFingerprints = new Set();
  const primaryFingerprints = new Set();

  for (const candidate of service.candidates.values()) {
    if (!candidate.catalogEligible) {
      const targetFingerprints = candidate.song.translationOf
        ? service.candidateFingerprintsBySongId.get(candidate.song.translationOf)
        : null;
      if (targetFingerprints?.size === 1) {
        const target = entriesByFingerprint.get([...targetFingerprints][0]);
        if (target) {
          const normalizedOutput = sourceRecord({
            ...candidate.song,
            translationOf: target.song.id
          });
          const resource = outputOnlyResource(
            normalizedOutput,
            service.project.resources[candidate.resourceId]?.origin
          );
          raw.resources[resource.id] = resource;
          resourceIdMappings[candidate.resourceId] = resource.id;
          sectionIdMappings[candidate.resourceId] = normalizedOutput.sectionIdMap;
        }
      }
      continue;
    }
    const entry = entriesByFingerprint.get(candidate.fingerprint);
    if (!entry) continue;
    const resource = canonicalResource(entry, candidate.fingerprint);
    raw.resources[resource.id] = resource;
    resourceIdMappings[candidate.resourceId] = resource.id;
    sectionIdMappings[candidate.resourceId] = entry.sectionIdMap;
    usedFingerprints.add(candidate.fingerprint);
    if (candidate.directUsage.some(usage => usage.primary)) {
      primaryFingerprints.add(candidate.fingerprint);
    }
  }
  for (const item of Object.values(raw.items)) {
    if (item.kind !== 'song') continue;
    const preferredVariant = item.variants[item.primaryChannelId];
    const preferredMapping = preferredVariant?.mode === 'content'
      ? sectionIdMappings[preferredVariant.resourceId]
      : null;
    const sectionIdMap = preferredMapping || Object.values(item.variants)
      .filter(variant => variant.mode === 'content')
      .map(variant => sectionIdMappings[variant.resourceId])
      .find(Boolean);
    if (sectionIdMap) {
      for (const entry of item.arrangement) {
        if (!Object.prototype.hasOwnProperty.call(sectionIdMap, entry.sectionId)) {
          fail(
            'ARRANGEMENT_SECTION_ROUND_TRIP_MISMATCH',
            `Song item ${item.id} arrangement section ${entry.sectionId} cannot be restored from its Markdown source.`,
            { serviceId: service.id, itemId: item.id, sectionId: entry.sectionId }
          );
        }
        entry.sectionId = sectionIdMap[entry.sectionId];
      }
    }
    for (const variant of Object.values(item.variants)) {
      if (variant.mode === 'content' && resourceIdMappings[variant.resourceId]) {
        variant.resourceId = resourceIdMappings[variant.resourceId];
      }
    }
  }
  for (const oldResourceId of Object.keys(resourceIdMappings)) {
    const replacement = resourceIdMappings[oldResourceId];
    if (replacement !== oldResourceId) delete raw.resources[oldResourceId];
  }
  const project = normalizeServiceProject(raw);
  const orderedFingerprints = translationOrder(usedFingerprints, targetByFingerprint);
  const orderedSongSources = orderedFingerprints.map(fingerprint => {
    const entry = entriesByFingerprint.get(fingerprint);
    return {
      song: entry.song,
      source: entry.source,
      revision: entry.revision,
      primary: primaryFingerprints.has(fingerprint),
      catalogEligible: true,
      contentFingerprint: fingerprint
    };
  });
  const songSources = new Map(orderedSongSources.map(entry => [entry.song.id, entry]));
  return {
    id: service.id,
    project,
    orderedSongSources,
    resourceIdMappings,
    plan: {
      ...service.plan,
      project,
      orderedSongSources,
      songSources
    }
  };
}

function reconcileServiceSongCatalog(rawServices) {
  if (!Array.isArray(rawServices) || rawServices.length < 1 || rawServices.length > MAX_SERVICES) {
    fail('INVALID_SERVICES', `Reconcile 1 to ${MAX_SERVICES} services at a time.`);
  }
  const state = {
    reviewKeys: new Set(),
    reviewItems: [],
    omittedReviewItems: 0,
    referencedResources: 0
  };
  const services = rawServices
    .map((service, index) => collectService(service, index, state))
    .sort((left, right) => compareText(left.id, right.id));
  if (new Set(services.map(service => service.id)).size !== services.length) {
    fail('DUPLICATE_SERVICE_ID', 'Every reconciled service needs a unique stable id.');
  }

  const groups = new Map();
  for (const service of services) {
    for (const candidate of service.candidates.values()) {
      if (!candidate.catalogEligible) continue;
      const group = groups.get(candidate.fingerprint) || {
        fingerprint: candidate.fingerprint,
        descriptor: contentDescriptor(candidate.song),
        candidates: []
      };
      group.candidates.push(candidate);
      groups.set(candidate.fingerprint, group);
    }
  }
  if (groups.size > MAX_CATALOG_SONGS) {
    fail('CATALOG_TOO_LARGE', `A catalog can contain at most ${MAX_CATALOG_SONGS} songs.`);
  }
  for (const group of groups.values()) {
    group.candidates.sort((left, right) => compareText(candidateIdentity(left), candidateIdentity(right)));
  }
  reviewIdentityCollisions(services, groups, state);

  const servicesById = new Map(services.map(service => [service.id, service]));
  const targetByFingerprint = new Map();
  for (const group of [...groups.values()].sort((left, right) =>
    compareText(left.fingerprint, right.fingerprint))) {
    targetByFingerprint.set(
      group.fingerprint,
      declaredTranslationTarget(group, servicesById, state)
    );
  }
  removeTranslationCycles(targetByFingerprint, state);
  collapseTranslationTargets(targetByFingerprint);

  const entriesByFingerprint = new Map();
  const creationOrder = translationOrder(new Set(groups.keys()), targetByFingerprint);
  for (const fingerprint of creationOrder) {
    const group = groups.get(fingerprint);
    const targetFingerprint = targetByFingerprint.get(fingerprint);
    const entry = canonicalDocumentForGroup(
      group,
      targetFingerprint,
      entriesByFingerprint,
      state
    );
    entriesByFingerprint.set(fingerprint, entry);
    if (targetFingerprint) {
      const target = entriesByFingerprint.get(targetFingerprint);
      const comparison = compareSongSections(target.song, entry.song);
      if (!comparison.compatible) {
        addReview(
          state,
          'SONG_TRANSLATION_STRUCTURE_REVIEW',
          `${fingerprint}:${targetFingerprint}`,
          'A declared translation family has different section or slide structure and needs review.',
          {
            fingerprint,
            targetFingerprint,
            ...comparison
          }
        );
      }
      if (normalizedLookupText(target.song.language) === normalizedLookupText(entry.song.language)) {
        addReview(
          state,
          'SONG_TRANSLATION_LANGUAGE_REVIEW',
          `${fingerprint}:${targetFingerprint}`,
          'A declared translation and its original use the same language tag and need review.',
          {
            fingerprint,
            targetFingerprint,
            language: entry.song.language
          }
        );
      }
    }
  }

  const reconciledServices = services.map(service =>
    rewriteService(service, entriesByFingerprint, targetByFingerprint));
  const catalogSongs = creationOrder.map(fingerprint => {
    const group = groups.get(fingerprint);
    const entry = entriesByFingerprint.get(fingerprint);
    return {
      id: entry.song.id,
      contentFingerprint: fingerprint,
      revision: entry.revision,
      translationOf: entry.song.translationOf,
      source: entry.source,
      document: entry.song,
      aliases: {
        ids: [...new Set(group.candidates.map(candidate => candidate.song.id))].sort(compareText),
        titles: [...new Set(group.candidates.map(candidate => candidate.song.title))].sort(compareText)
      },
      occurrences: group.candidates.map(candidate => ({
        serviceId: candidate.serviceId,
        projectId: candidate.projectId,
        sourceSongId: candidate.song.id,
        sourceResourceId: candidate.resourceId,
        primary: candidate.directUsage.some(usage => usage.primary)
      }))
    };
  });
  state.reviewItems.sort((left, right) =>
    compareText(left.code, right.code)
    || compareText(left.fingerprint || left.songId || left.serviceId || '', right.fingerprint || right.songId || right.serviceId || ''));

  const eligibleCandidateCount = [...groups.values()]
    .reduce((count, group) => count + group.candidates.length, 0);
  const outputOnlyCount = services.reduce((count, service) =>
    count + [...service.candidates.values()]
      .filter(candidate => !candidate.catalogEligible && candidate.directUsage.length > 0).length, 0);
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    catalog: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      songs: catalogSongs
    },
    services: reconciledServices,
    reviewItems: state.reviewItems,
    omittedReviewItems: state.omittedReviewItems,
    summary: {
      serviceCount: services.length,
      referencedResourceCount: state.referencedResources,
      catalogSongCount: catalogSongs.length,
      exactReuseCount: eligibleCandidateCount - catalogSongs.length,
      outputOnlyResourceCount: outputOnlyCount,
      reviewItemCount: state.reviewItems.length,
      omittedReviewItems: state.omittedReviewItems
    }
  };
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  MAX_CATALOG_SONGS,
  MAX_REFERENCED_RESOURCES,
  MAX_REVIEW_ITEMS,
  MAX_SERVICES,
  SongCatalogReconciliationError,
  canonicalSongId,
  contentDescriptor,
  reconcileServiceSongCatalog,
  songContentFingerprint
};
