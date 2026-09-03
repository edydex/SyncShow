'use strict';

const {
  addProjectItem,
  bindProjectToServiceSet,
  createServiceProject,
  normalizeServiceProject
} = require('./ServiceProject');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SOURCES = 16;
const MAX_POSITIONS = 2000;
const MAX_IMAGE_ASSETS = 2000;
const MAX_IMAGE_BYTES = 75 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;

class CurrentServiceNativeDraftError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CurrentServiceNativeDraftError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CurrentServiceNativeDraftError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_NATIVE_DRAFT', `${label} is invalid.`);
  }
  return value;
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string') {
    fail('INVALID_NATIVE_DRAFT', `${label} is invalid.`);
  }
  const normalized = value.trim().normalize('NFC');
  if (!normalized
    || normalized.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    fail('INVALID_NATIVE_DRAFT', `${label} is invalid.`);
  }
  return normalized;
}

function normalizeBinding(raw) {
  if (!isRecord(raw)
    || !SHA256_PATTERN.test(raw.fingerprint || '')
    || typeof raw.serviceDate !== 'string'
    || !SERVICE_DATE_PATTERN.test(raw.serviceDate)) {
    fail(
      'INVALID_NATIVE_DRAFT_BINDING',
      'The exact PowerPoint service binding is invalid.'
    );
  }
  return {
    id: requiredId(raw.id, 'PowerPoint service id'),
    fingerprint: raw.fingerprint,
    serviceDate: raw.serviceDate,
    profileId: requiredId(raw.profileId, 'PowerPoint venue profile')
  };
}

function normalizeChannels(rawChannels) {
  if (!Array.isArray(rawChannels)
    || rawChannels.length < 1
    || rawChannels.length > MAX_SOURCES) {
    fail(
      'INVALID_NATIVE_DRAFT_CHANNELS',
      'The native draft needs between one and 16 presentation channels.'
    );
  }
  const seen = new Set();
  return rawChannels.map((rawChannel, index) => {
    if (!isRecord(rawChannel)) {
      fail(
        'INVALID_NATIVE_DRAFT_CHANNELS',
        `Presentation channel ${index + 1} is invalid.`
      );
    }
    const id = requiredId(rawChannel.id, `Presentation channel ${index + 1}`);
    if (seen.has(id)) {
      fail(
        'DUPLICATE_NATIVE_DRAFT_CHANNEL',
        `Presentation channel ${id} appears more than once.`
      );
    }
    seen.add(id);
    return {
      id,
      label: requiredText(
        rawChannel.label || id,
        `Presentation channel ${id} label`,
        120
      ),
      language: typeof rawChannel.language === 'string'
        && rawChannel.language.trim()
        ? rawChannel.language.trim()
        : 'und'
    };
  });
}

function normalizeSlideAsset(rawAsset, source, position) {
  if (!isRecord(rawAsset)
    || typeof rawAsset.sha256 !== 'string'
    || !SHA256_PATTERN.test(rawAsset.sha256)
    || rawAsset.assetId !== `sha256:${rawAsset.sha256}`
    || !Number.isSafeInteger(rawAsset.size)
    || rawAsset.size < 1
    || rawAsset.size > MAX_IMAGE_BYTES
    || !Number.isSafeInteger(rawAsset.width)
    || rawAsset.width < 1
    || rawAsset.width > 32768
    || !Number.isSafeInteger(rawAsset.height)
    || rawAsset.height < 1
    || rawAsset.height > 32768
    || rawAsset.width * rawAsset.height > 64 * 1000 * 1000
    || !Number.isSafeInteger(rawAsset.orientation)
    || rawAsset.orientation < 1
    || rawAsset.orientation > 8) {
    fail(
      'INVALID_NATIVE_DRAFT_IMAGE',
      `PowerPoint role ${source.roleId} position ${position + 1} has an invalid rendered image.`
    );
  }
  return {
    assetId: rawAsset.assetId,
    sha256: rawAsset.sha256,
    size: rawAsset.size,
    width: rawAsset.width,
    height: rawAsset.height,
    orientation: rawAsset.orientation
  };
}

function normalizeSources(rawSources, channelIds) {
  if (!Array.isArray(rawSources)
    || rawSources.length < 1
    || rawSources.length > MAX_SOURCES) {
    fail(
      'INVALID_NATIVE_DRAFT_SOURCES',
      'The native draft needs between one and 16 reviewed PowerPoint sources.'
    );
  }
  const seenChannels = new Set();
  const sources = rawSources.map((rawSource, index) => {
    if (!isRecord(rawSource)) {
      fail(
        'INVALID_NATIVE_DRAFT_SOURCE',
        `PowerPoint source ${index + 1} is invalid.`
      );
    }
    const roleId = requiredId(
      rawSource.roleId,
      `PowerPoint source ${index + 1} role`
    );
    const channelId = requiredId(
      rawSource.channelId,
      `PowerPoint source ${index + 1} channel`
    );
    if (!channelIds.has(channelId)) {
      fail(
        'UNKNOWN_NATIVE_DRAFT_CHANNEL',
        `PowerPoint role ${roleId} does not map to a native output channel.`
      );
    }
    if (seenChannels.has(channelId)) {
      fail(
        'DUPLICATE_NATIVE_DRAFT_SOURCE_CHANNEL',
        `More than one PowerPoint source maps to channel ${channelId}.`
      );
    }
    seenChannels.add(channelId);
    const fileName = requiredText(
      rawSource.fileName,
      `PowerPoint role ${roleId} file name`,
      255
    );
    if (!Array.isArray(rawSource.slides)
      || rawSource.slides.length < 1
      || rawSource.slides.length > MAX_POSITIONS) {
      fail(
        'INVALID_NATIVE_DRAFT_SLIDE_COUNT',
        `PowerPoint role ${roleId} must contain 1 to ${MAX_POSITIONS} rendered slides.`
      );
    }
    const source = { roleId, channelId, fileName };
    return {
      ...source,
      slides: rawSource.slides.map((asset, position) =>
        normalizeSlideAsset(asset, source, position))
    };
  });
  if (sources.length !== channelIds.size
    || sources.some(source => !channelIds.has(source.channelId))) {
    fail(
      'INCOMPLETE_NATIVE_DRAFT_CHANNELS',
      'Every native presentation channel needs one reviewed PowerPoint source.'
    );
  }
  if (new Set(sources.map(source => source.slides.length)).size !== 1) {
    fail(
      'NATIVE_DRAFT_SLIDE_COUNT_MISMATCH',
      'Every PowerPoint source must have the same slide count before a synchronized native draft can be created.'
    );
  }
  const uniqueAssets = new Map();
  for (const source of sources) {
    for (const asset of source.slides) {
      const existing = uniqueAssets.get(asset.assetId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(asset)) {
        fail(
          'CONFLICTING_NATIVE_DRAFT_IMAGE',
          `Rendered image ${asset.assetId} has inconsistent metadata.`
        );
      }
      uniqueAssets.set(asset.assetId, asset);
    }
  }
  if (uniqueAssets.size > MAX_IMAGE_ASSETS) {
    fail(
      'NATIVE_DRAFT_TOO_LARGE',
      `A native draft can preserve at most ${MAX_IMAGE_ASSETS} distinct rendered slide images.`
    );
  }
  const totalBytes = [...uniqueAssets.values()].reduce(
    (sum, asset) => sum + asset.size,
    0
  );
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    fail(
      'NATIVE_DRAFT_TOO_LARGE',
      'The rendered PowerPoint service is too large for one safe native draft.'
    );
  }
  return sources;
}

function nativeDraftProjectId(fingerprint) {
  if (!SHA256_PATTERN.test(fingerprint || '')) {
    fail(
      'INVALID_NATIVE_DRAFT_BINDING',
      'The PowerPoint service fingerprint is invalid.'
    );
  }
  return `pptx-native-draft-${fingerprint.slice(0, 48)}`;
}

/**
 * Assemble runnable native picture cues from the exact JPEGs already rendered
 * for the reviewed PowerPoint ServiceSet. Physical installation remains a
 * ServiceProjectStore responsibility; this function never receives paths.
 */
function buildCurrentServiceNativeDraft(options = {}) {
  const binding = normalizeBinding(options.binding);
  const channels = normalizeChannels(options.channels);
  const sources = normalizeSources(
    options.sources,
    new Set(channels.map(channel => channel.id))
  );
  if (typeof options.createdAt !== 'string'
    || !Number.isFinite(Date.parse(options.createdAt))
    || new Date(options.createdAt).toISOString() !== options.createdAt) {
    fail(
      'INVALID_NATIVE_DRAFT_TIMESTAMP',
      'The native-draft review timestamp is invalid.'
    );
  }
  const createdAt = options.createdAt;
  const renderRevisionId = typeof options.renderRevisionId === 'string'
    && SHA256_PATTERN.test(options.renderRevisionId)
    ? options.renderRevisionId
    : fail(
        'INVALID_NATIVE_DRAFT_RENDER_REVISION',
        'The reviewed PowerPoint render revision is invalid.'
      );
  const title = requiredText(options.title, 'Native draft title', 200);
  const projectId = nativeDraftProjectId(binding.fingerprint);
  let project = createServiceProject({
    id: projectId,
    title,
    serviceDate: binding.serviceDate,
    profileId: binding.profileId,
    channels,
    now: createdAt
  });

  const rawProject = JSON.parse(JSON.stringify(project));
  for (const source of sources) {
    for (const [index, image] of source.slides.entries()) {
      if (rawProject.assets[image.assetId]) continue;
      rawProject.assets[image.assetId] = {
        id: image.assetId,
        kind: 'image',
        sha256: image.sha256,
        fileName: `${source.roleId}-slide-${String(index + 1).padStart(4, '0')}.jpg`,
        storedName: `${image.sha256}.jpg`,
        mediaType: 'image/jpeg',
        size: image.size,
        createdAt,
        attribution: '',
        altText: `${source.fileName}, slide ${index + 1}`,
        width: image.width,
        height: image.height,
        orientation: image.orientation
      };
    }
  }
  project = normalizeServiceProject(rawProject, { now: new Date(createdAt) });
  project = bindProjectToServiceSet(project, binding);

  const positionCount = sources[0].slides.length;
  for (let position = 0; position < positionCount; position += 1) {
    const assetIdsByChannel = Object.fromEntries(
      sources
        .filter(source => position < source.slides.length)
        .map(source => [
          source.channelId,
          source.slides[position].assetId
        ])
    );
    project = addProjectItem(project, {
      id: `powerpoint-position-${String(position + 1).padStart(4, '0')}`,
      kind: 'picture',
      title: `PowerPoint position ${position + 1}`,
      operatorNotes: position === 0
        ? `Source-faithful fallback revision sha256:${renderRevisionId}. Replace only ranges reviewed against the original presentations.`
        : '',
      assetIdsByChannel,
      fit: 'fit',
      focalPoint: { x: 0.5, y: 0.5 },
      altText: `Source-faithful PowerPoint position ${position + 1}`,
      attribution: '',
      presetId: 'picture-fullscreen',
      sourceVisualReview: {
        schemaVersion: 1,
        kind: 'powerpoint-render',
        serviceSetId: binding.id,
        serviceSetFingerprint: binding.fingerprint,
        renderRevisionId,
        position: position + 1,
        assetIdsByChannel
      },
      createdAt,
      updatedAt: createdAt
    }, { now: createdAt });
  }

  return Object.freeze({
    project,
    projectId,
    sourceItemId: project.rootItemIds[0],
    positionCount,
    countsMatch: true,
    assetIds: Object.freeze(Object.keys(project.assets).sort())
  });
}

module.exports = {
  CurrentServiceNativeDraftError,
  buildCurrentServiceNativeDraft,
  nativeDraftProjectId
};
