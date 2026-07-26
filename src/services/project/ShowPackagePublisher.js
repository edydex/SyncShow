'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { compileServiceProject, normalizeCueTimeline } = require('./ServiceProject');
const { NATIVE_RENDERER_VERSION } = require('./NativePresetCatalog');
const { NativeSlideRenderer } = require('./NativeSlideRenderer');
const { MAX_IMAGE_BYTES } = require('./ServiceProjectStore');
const {
  MAX_NATIVE_SCENE_BYTES,
  compileNativeCueScene,
  normalizeNativeCueScene,
  sceneAssetIds,
  serializeNativeCueScene
} = require('../show/NativeCueScene');
const {
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  fsyncDirectory,
  hashFileNoFollow,
  pathIsInside,
  readFileNoFollow,
  withExclusiveFileLock
} = require('./StorageSafety');

const SHOW_PACKAGE_SCHEMA_VERSION = 2;
const SHOW_PACKAGE_PATTERN = /^show-[a-f0-9]{64}$/;
const SAFE_ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PACKAGE_CUES = 2000;
const MAX_PACKAGE_CHANNELS = 16;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_RASTER_ARTIFACT_BYTES = 20 * 1024 * 1024;
const SAFE_ASSET_PATH = /^assets\/[a-f0-9]{64}\.(?:png|jpe?g|webp)$/;

class ShowPackageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShowPackageError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ShowPackageError(code, message, details);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalJson(value) {
  return `${JSON.stringify(stableObject(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function roleDirectoryName(roleId) {
  return `channel-${sha256(roleId).slice(0, 24)}`;
}

function artifactMaximumBytes(relativePath) {
  if (SAFE_ASSET_PATH.test(relativePath)) return MAX_IMAGE_BYTES;
  if (/\/scene_\d+\.json$/.test(relativePath)) return MAX_NATIVE_SCENE_BYTES;
  if (relativePath.endsWith('.json')) return MAX_MANIFEST_BYTES;
  return MAX_RASTER_ARTIFACT_BYTES;
}

function requireRoleId(value, field) {
  if (typeof value !== 'string' || !SAFE_ROLE_ID.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail('INVALID_ROLE_MAPPING', `${field} has an invalid role or channel id.`);
  }
  return value;
}

async function syncRegularFile(filePath) {
  // Windows requires a writable handle for FlushFileBuffers, which is what
  // FileHandle.sync() uses. These thumbnail files were just created by the
  // publisher, so opening them read/write keeps the durability guarantee
  // without turning a supported Windows publish into EPERM.
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class ShowPackagePublisher {
  constructor(options = {}) {
    if (!options.projectStore) throw new TypeError('ShowPackagePublisher requires a ServiceProjectStore');
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('ShowPackagePublisher requires an absolute rootPath');
    }
    this.projectStore = options.projectStore;
    this.rootPath = path.resolve(options.rootPath);
    this.fontPath = options.fontPath
      ? path.resolve(options.fontPath)
      : path.join(__dirname, '../../../assets/fonts/NotoSans-Variable.ttf');
    this.fontConfigPath = path.resolve(options.fontConfigPath || path.join(path.dirname(this.fontPath), 'fonts.conf'));
    this.fontConfigCachePath = options.fontConfigCachePath
      ? path.resolve(options.fontConfigCachePath)
      : null;
    this.sharp = options.sharp || require('sharp');
    this.clock = options.clock || (() => new Date());
    this.randomUUID = options.randomUUID || crypto.randomUUID;
  }

  async initialize() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    this.fontConfigCachePath = this.fontConfigCachePath || path.join(this.rootPath, '.font-cache');
    if (!pathIsInside(this.rootPath, this.fontConfigCachePath)) {
      throw new TypeError('ShowPackagePublisher fontConfigCachePath must be inside rootPath');
    }
    return this;
  }

  _normalizeRoleMapping(project, rawMapping) {
    if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
      fail('INVALID_ROLE_MAPPING', 'Choose how project channels map to the current venue inputs.');
    }
    const entries = Object.entries(rawMapping);
    if (entries.length < 1 || entries.length > MAX_PACKAGE_CHANNELS) {
      fail('INVALID_ROLE_MAPPING', `A native Show package needs 1 to ${MAX_PACKAGE_CHANNELS} mapped channels.`);
    }
    const mapping = {};
    const seenChannels = new Set();
    for (const [rawRoleId, rawChannelId] of entries) {
      const roleId = requireRoleId(rawRoleId, 'Venue role');
      const channelId = requireRoleId(rawChannelId, `Channel for ${roleId}`);
      if (!project.channelIds.includes(channelId)) fail('UNKNOWN_PROJECT_CHANNEL', `Project channel ${channelId} does not exist.`);
      if (Object.prototype.hasOwnProperty.call(mapping, roleId)) fail('DUPLICATE_ROLE_MAPPING', `Venue role ${roleId} is mapped more than once.`);
      mapping[roleId] = channelId;
      seenChannels.add(channelId);
    }
    return mapping;
  }

  _packageIdentity(projectRead, timeline, roleMapping, renderOptions) {
    const identity = {
      schemaVersion: SHOW_PACKAGE_SCHEMA_VERSION,
      projectId: projectRead.project.id,
      projectRevisionId: projectRead.revisionId,
      projectContentHash: timeline.projectContentHash,
      timelineSha256: sha256(canonicalJson(timeline)),
      compilerVersion: timeline.compilerVersion,
      rendererVersion: NATIVE_RENDERER_VERSION,
      roleMapping,
      renderOptions,
      fontSha256: null
    };
    return identity;
  }

  async _verifyManifest(packagePath, expectedPackageId = null) {
    let manifest;
    try {
      const { buffer } = await readFileNoFollow(path.join(packagePath, 'manifest.json'), MAX_MANIFEST_BYTES);
      manifest = JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      fail('SHOW_PACKAGE_INVALID', `The native Show package manifest is unreadable: ${error.message}`);
    }
    if (!manifest
      || manifest.schemaVersion !== SHOW_PACKAGE_SCHEMA_VERSION
      || manifest.kind !== 'syncshow-show-package'
      || !SHOW_PACKAGE_PATTERN.test(manifest.id || '')
      || (expectedPackageId && manifest.id !== expectedPackageId)
      || typeof manifest.projectId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(manifest.projectId)
      || !/^[a-f0-9]{64}$/.test(manifest.projectRevisionId || '')
      || !/^[a-f0-9]{64}$/.test(manifest.projectContentHash || '')
      || !/^[a-f0-9]{64}$/.test(manifest.timelineSha256 || '')
      || manifest.compilerVersion !== 3
      || manifest.rendererVersion !== NATIVE_RENDERER_VERSION
      || !Number.isSafeInteger(manifest.cueCount)
      || manifest.cueCount < 1
      || manifest.cueCount > MAX_PACKAGE_CUES
      || !Array.isArray(manifest.cueIds)
      || manifest.cueIds.length !== manifest.cueCount
      || new Set(manifest.cueIds).size !== manifest.cueIds.length
      || manifest.cueIds.some(cueId => !/^cue-[a-f0-9]{24}$/.test(cueId))
      || !isRecord(manifest.roleMapping)
      || !Array.isArray(manifest.channels)
      || manifest.channels.length < 1
      || manifest.channels.length > MAX_PACKAGE_CHANNELS
      || Object.keys(manifest.roleMapping).length !== manifest.channels.length
      || !Array.isArray(manifest.assets)
      || manifest.assets.length > 2000
      || !Array.isArray(manifest.artifacts)
      || manifest.artifacts.length > MAX_PACKAGE_CUES * MAX_PACKAGE_CHANNELS * 2
        + MAX_PACKAGE_CHANNELS + manifest.assets.length + 4) {
      fail('SHOW_PACKAGE_INVALID', 'The native Show package manifest is invalid.');
    }

    if (!isRecord(manifest.renderOptions)
      || !Number.isSafeInteger(manifest.renderOptions.width)
      || !Number.isSafeInteger(manifest.renderOptions.height)
      || manifest.renderOptions.width < 640
      || manifest.renderOptions.height < 360
      || manifest.renderOptions.width * manifest.renderOptions.height > 3840 * 2160
      || !Number.isSafeInteger(manifest.renderOptions.thumbnailWidth)
      || manifest.renderOptions.thumbnailWidth < 100
      || manifest.renderOptions.thumbnailWidth > 1000
      || !Number.isSafeInteger(manifest.renderOptions.jpegQuality)
      || manifest.renderOptions.jpegQuality < 70
      || manifest.renderOptions.jpegQuality > 100
      || !isRecord(manifest.font)
      || !/^[a-f0-9]{64}$/.test(manifest.font.sha256 || '')) {
      fail('SHOW_PACKAGE_INVALID', 'The native Show package render identity is invalid.');
    }

    const normalizedMapping = {};
    for (const [rawRoleId, rawChannelId] of Object.entries(manifest.roleMapping)) {
      const roleId = requireRoleId(rawRoleId, 'Venue role');
      normalizedMapping[roleId] = requireRoleId(rawChannelId, `Channel for ${roleId}`);
    }
    const identity = {
      schemaVersion: SHOW_PACKAGE_SCHEMA_VERSION,
      projectId: manifest.projectId,
      projectRevisionId: manifest.projectRevisionId,
      projectContentHash: manifest.projectContentHash,
      timelineSha256: manifest.timelineSha256,
      compilerVersion: manifest.compilerVersion,
      rendererVersion: manifest.rendererVersion,
      roleMapping: normalizedMapping,
      renderOptions: manifest.renderOptions,
      fontSha256: manifest.font.sha256
    };
    if (`show-${sha256(canonicalJson(identity))}` !== manifest.id) {
      fail('SHOW_PACKAGE_CORRUPT', 'The native Show package identity no longer matches its contents.');
    }

    const expectedArtifactPaths = new Set(['timeline.json']);
    const packageAssets = new Map();
    for (const asset of manifest.assets) {
      if (!isRecord(asset)
        || typeof asset.id !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(asset.id)
        || typeof asset.path !== 'string'
        || !SAFE_ASSET_PATH.test(asset.path)
        || asset.path !== `assets/${asset.id.slice('sha256:'.length)}.${asset.path.split('.').at(-1)}`
        || typeof asset.mediaType !== 'string'
        || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType)
        || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')
        || asset.id !== `sha256:${asset.sha256}`
        || !Number.isSafeInteger(asset.size)
        || asset.size < 1
        || asset.size > MAX_IMAGE_BYTES
        || !Number.isSafeInteger(asset.width)
        || asset.width < 1
        || asset.width > 32768
        || !Number.isSafeInteger(asset.height)
        || asset.height < 1
        || asset.height > 32768
        || packageAssets.has(asset.id)) {
        fail('SHOW_PACKAGE_INVALID', 'A Show package picture asset is invalid.');
      }
      const expectedExtension = {
        'image/png': ['png'],
        'image/jpeg': ['jpg', 'jpeg'],
        'image/webp': ['webp']
      }[asset.mediaType];
      const extension = asset.path.split('.').at(-1);
      if (!expectedExtension.includes(extension)) {
        fail('SHOW_PACKAGE_INVALID', 'A Show package picture asset has an inconsistent file type.');
      }
      packageAssets.set(asset.id, asset);
      expectedArtifactPaths.add(asset.path);
    }
    const seenRoles = new Set();
    const referencedAssetIds = new Set();
    for (const channel of manifest.channels) {
      if (!isRecord(channel)) fail('SHOW_PACKAGE_INVALID', 'A Show package channel is invalid.');
      const roleId = requireRoleId(channel.roleId, 'Venue role');
      const channelId = requireRoleId(channel.channelId, `Channel for ${roleId}`);
      const directory = roleDirectoryName(roleId);
      if (seenRoles.has(roleId)
        || normalizedMapping[roleId] !== channelId
        || channel.directory !== directory
        || channel.renderer !== 'native-cue'
        || channel.metadataPath !== `${directory}/metadata.json`) {
        fail('SHOW_PACKAGE_INVALID', 'A Show package channel does not match its role mapping.');
      }
      seenRoles.add(roleId);
      expectedArtifactPaths.add(channel.metadataPath);
      for (let cueIndex = 0; cueIndex < manifest.cueCount; cueIndex += 1) {
        const number = String(cueIndex + 1).padStart(3, '0');
        expectedArtifactPaths.add(`${directory}/scene_${number}.json`);
        expectedArtifactPaths.add(`${directory}/slide_${number}_thumb.jpg`);
      }
    }
    if (seenRoles.size !== Object.keys(normalizedMapping).length
      || expectedArtifactPaths.size !== manifest.artifacts.length) {
      fail('SHOW_PACKAGE_INVALID', 'The Show package artifact inventory is incomplete.');
    }

    const seenArtifacts = new Set();
    const artifactByPath = new Map();
    for (const artifact of manifest.artifacts) {
      if (!artifact
        || typeof artifact.path !== 'string'
        || path.isAbsolute(artifact.path)
        || artifact.path.includes('\\')
        || !/^[A-Za-z0-9._/-]+$/.test(artifact.path)
        || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')
        || !Number.isSafeInteger(artifact.size)
        || artifact.size < 1
        || artifact.size > artifactMaximumBytes(artifact.path)
        || seenArtifacts.has(artifact.path)
        || !expectedArtifactPaths.has(artifact.path)) {
        fail('SHOW_PACKAGE_INVALID', 'The native Show package contains an invalid artifact record.');
      }
      seenArtifacts.add(artifact.path);
      const artifactPath = path.resolve(packagePath, artifact.path);
      if (!pathIsInside(packagePath, artifactPath)) fail('SHOW_PACKAGE_INVALID', 'A Show package artifact escaped its package.');
      let stats;
      try {
        stats = await fs.lstat(artifactPath);
      } catch (error) {
        fail('SHOW_PACKAGE_CORRUPT', `Show package artifact ${artifact.path} is missing or unreadable.`, {
          cause: error.message
        });
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== artifact.size) {
        fail('SHOW_PACKAGE_CORRUPT', `Show package artifact ${artifact.path} is missing or changed.`);
      }
      if (await hashFileNoFollow(artifactPath, artifact.size) !== artifact.sha256) {
        fail('SHOW_PACKAGE_CORRUPT', `Show package artifact ${artifact.path} failed its checksum.`);
      }
      artifactByPath.set(artifact.path, artifact);
    }
    for (const asset of packageAssets.values()) {
      const artifact = artifactByPath.get(asset.path);
      if (!artifact || artifact.size !== asset.size || artifact.sha256 !== asset.sha256) {
        fail('SHOW_PACKAGE_CORRUPT', `Show package picture asset ${asset.id} does not match its artifact.`);
      }
    }

    let timeline;
    let timelineSource;
    try {
      const { buffer } = await readFileNoFollow(path.join(packagePath, 'timeline.json'), MAX_MANIFEST_BYTES);
      timelineSource = buffer.toString('utf8');
      timeline = JSON.parse(timelineSource);
      normalizeCueTimeline(timeline);
    } catch (error) {
      fail('SHOW_PACKAGE_CORRUPT', `The Show timeline is invalid: ${error.message}`);
    }
    if (canonicalJson(timeline) !== timelineSource
      || sha256(timelineSource) !== manifest.timelineSha256
      || timeline.kind !== 'syncshow-cue-timeline'
      || timeline.projectId !== manifest.projectId
      || timeline.projectContentHash !== manifest.projectContentHash
      || timeline.compilerVersion !== manifest.compilerVersion
      || !sameArray(timeline.cueIds, manifest.cueIds)) {
      fail('SHOW_PACKAGE_CORRUPT', 'The Show timeline does not match its package manifest.');
    }

    for (const channel of manifest.channels) {
      let metadata;
      try {
        const { buffer } = await readFileNoFollow(path.join(packagePath, channel.metadataPath), MAX_MANIFEST_BYTES);
        metadata = JSON.parse(buffer.toString('utf8'));
      } catch (error) {
        fail('SHOW_PACKAGE_CORRUPT', `Channel metadata is invalid: ${error.message}`);
      }
      if (!isRecord(metadata)
        || metadata.schemaVersion !== 1
        || metadata.sourceType !== 'service-project'
        || metadata.projectId !== manifest.projectId
        || metadata.projectRevisionId !== manifest.projectRevisionId
        || metadata.channelId !== channel.channelId
        || metadata.roleId !== channel.roleId
        || metadata.slideCount !== manifest.cueCount
        || !Array.isArray(metadata.slides)
        || metadata.slides.length !== manifest.cueCount) {
        fail('SHOW_PACKAGE_CORRUPT', `Channel metadata for ${channel.roleId} does not match the package.`);
      }
      for (const [index, slide] of metadata.slides.entries()) {
        if (!isRecord(slide)
          || slide.cueId !== manifest.cueIds[index]
          || typeof slide.title !== 'string'
          || slide.title.length > 300
          || typeof slide.kind !== 'string'
          || !Array.isArray(slide.groupPath)
          || slide.groupPath.length > 32
          || slide.groupPath.some(part => typeof part !== 'string' || part.length > 160)
          || typeof slide.text !== 'string'
          || slide.text.length > 250000
          || typeof slide.firstLine !== 'string'
          || slide.firstLine.length > 2000) {
          fail('SHOW_PACKAGE_CORRUPT', `Slide metadata ${index + 1} for ${channel.roleId} is invalid.`);
        }
      }
      const scenes = [];
      for (let cueIndex = 0; cueIndex < manifest.cueCount; cueIndex += 1) {
        const number = String(cueIndex + 1).padStart(3, '0');
        const scenePath = path.join(packagePath, channel.directory, `scene_${number}.json`);
        let scene;
        try {
          const { buffer } = await readFileNoFollow(scenePath, MAX_NATIVE_SCENE_BYTES);
          const sceneSource = buffer.toString('utf8');
          scene = normalizeNativeCueScene(JSON.parse(sceneSource), {
            cueId: manifest.cueIds[cueIndex]
          });
          const cueId = manifest.cueIds[cueIndex];
          const nextCueId = manifest.cueIds[cueIndex + 1];
          const expectedScene = compileNativeCueScene(
            timeline.cues[cueId],
            channel.channelId,
            {
              width: manifest.renderOptions.width,
              height: manifest.renderOptions.height,
              nextCue: nextCueId ? timeline.cues[nextCueId] : null
            }
          );
          if (serializeNativeCueScene(expectedScene) !== sceneSource) {
            fail(
              'SHOW_PACKAGE_CORRUPT',
              `Native scene ${cueIndex + 1} for ${channel.roleId} no longer matches the Show timeline.`
            );
          }
        } catch (error) {
          if (error instanceof ShowPackageError) throw error;
          fail(
            'SHOW_PACKAGE_CORRUPT',
            `Native scene ${cueIndex + 1} for ${channel.roleId} is invalid: ${error.message}`
          );
        }
        for (const assetId of sceneAssetIds(scene)) {
          if (!packageAssets.has(assetId)) {
            fail('SHOW_PACKAGE_CORRUPT', `Native scene ${cueIndex + 1} refers to a missing picture asset.`);
          }
          referencedAssetIds.add(assetId);
        }
        scenes.push(scene);
      }
      channel.metadata = metadata;
      channel.scenes = scenes;
    }
    if (referencedAssetIds.size !== packageAssets.size
      || [...packageAssets.keys()].some(assetId => !referencedAssetIds.has(assetId))) {
      fail('SHOW_PACKAGE_INVALID', 'The Show package contains an unreferenced picture asset.');
    }
    return manifest;
  }

  _resultFromManifest(packagePath, manifest) {
    const presentations = {};
    for (const channel of manifest.channels) {
      const cacheDir = path.resolve(packagePath, channel.directory);
      if (!pathIsInside(packagePath, cacheDir)) fail('SHOW_PACKAGE_INVALID', 'A channel directory escaped its Show package.');
      presentations[channel.roleId] = {
        success: true,
        sourceType: 'service-project',
        renderer: 'native-cue',
        projectId: manifest.projectId,
        projectRevisionId: manifest.projectRevisionId,
        showPackageId: manifest.id,
        cacheDir,
        slideCount: manifest.cueCount,
        metadata: channel.metadata,
        scenes: channel.scenes,
        assetPaths: Object.fromEntries(manifest.assets.map(asset => [
          asset.id,
          path.resolve(packagePath, asset.path)
        ]))
      };
    }
    return { manifest, packagePath, presentations };
  }

  async publish(options = {}) {
    await this.initialize();
    if (typeof options.projectId !== 'string' || typeof options.revisionId !== 'string') {
      fail('INVALID_PROJECT_REVISION', 'Choose a saved project revision before publishing.');
    }
    const projectRead = await this.projectStore.read(options.projectId, { revisionId: options.revisionId });
    const timeline = compileServiceProject(projectRead.project);
    if (timeline.cueIds.length < 1) {
      fail('NO_CUES', 'Add something to Prepare before publishing this service.');
    }
    if (timeline.cueIds.length > MAX_PACKAGE_CUES) {
      fail('TOO_MANY_CUES', `A native Show package can contain at most ${MAX_PACKAGE_CUES} cues.`);
    }
    const roleMapping = this._normalizeRoleMapping(projectRead.project, options.roleMapping);
    const renderOptions = {
      width: Number.isSafeInteger(options.width) ? options.width : 1920,
      height: Number.isSafeInteger(options.height) ? options.height : 1080,
      thumbnailWidth: Number.isSafeInteger(options.thumbnailWidth) ? options.thumbnailWidth : 300,
      jpegQuality: Number.isSafeInteger(options.jpegQuality) ? options.jpegQuality : 92
    };
    if (renderOptions.width < 640
      || renderOptions.height < 360
      || renderOptions.width * renderOptions.height > 3840 * 2160) {
      fail('INVALID_RENDER_OPTIONS', 'Native Show output must be between 640×360 and 3840×2160 pixels.');
    }
    if (renderOptions.thumbnailWidth < 100 || renderOptions.thumbnailWidth > 1000) {
      fail('INVALID_RENDER_OPTIONS', 'Thumbnail width must be from 100 to 1000 pixels.');
    }
    if (renderOptions.jpegQuality < 70 || renderOptions.jpegQuality > 100) {
      fail('INVALID_RENDER_OPTIONS', 'JPEG quality must be from 70 to 100.');
    }
    const fontSha256 = await hashFileNoFollow(this.fontPath, 10 * 1024 * 1024);
    const identity = this._packageIdentity(projectRead, timeline, roleMapping, renderOptions);
    identity.fontSha256 = fontSha256;
    const packageId = `show-${sha256(canonicalJson(identity))}`;
    const packagePath = path.join(this.rootPath, packageId);
    const lockPath = path.join(this.rootPath, `.publish-${packageId}.lock`);

    return withExclusiveFileLock(lockPath, async () => {
      try {
        const stats = await fs.lstat(packagePath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) fail('SHOW_PACKAGE_INVALID', 'The existing Show package path is unsafe.');
        const manifest = await this._verifyManifest(packagePath, packageId);
        return this._resultFromManifest(packagePath, manifest);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (error instanceof ShowPackageError) throw error;
          throw error;
        }
      }

      const stagingPath = path.join(this.rootPath, `.staging-${packageId}-${this.randomUUID()}`);
      await ensureConfinedDirectory(this.rootPath, stagingPath);
      let published = false;
      try {
        this.fontConfigCachePath = await ensureConfinedDirectory(this.rootPath, this.fontConfigCachePath);
        const artifacts = [];
        const channels = [];
        const referencedAssetIds = new Set();
        const renderer = new NativeSlideRenderer({
          width: renderOptions.width,
          height: renderOptions.height,
          fontPath: this.fontPath,
          fontConfigPath: this.fontConfigPath,
          fontConfigCachePath: this.fontConfigCachePath,
          sharp: this.sharp,
          jpegQuality: renderOptions.jpegQuality,
          resolveAsset: async assetId => this.projectStore.resolveAssetPath(
            projectRead.project.id,
            projectRead.revisionId,
            assetId
          )
        });
        const mappingEntries = Object.entries(roleMapping);
        let completed = 0;
        const total = mappingEntries.length * timeline.cueIds.length;
        for (const [roleId, channelId] of mappingEntries) {
          const directory = roleDirectoryName(roleId);
          const channelPath = path.join(stagingPath, directory);
          await ensureConfinedDirectory(stagingPath, channelPath);
          const slides = [];
          for (const [cueIndex, cueId] of timeline.cueIds.entries()) {
            const number = String(cueIndex + 1).padStart(3, '0');
            const sceneName = `scene_${number}.json`;
            const thumbName = `slide_${number}_thumb.jpg`;
            const scenePath = path.join(channelPath, sceneName);
            const thumbPath = path.join(channelPath, thumbName);
            const cue = timeline.cues[cueId];
            const channel = cue.channels?.[channelId];
            const nextCueId = timeline.cueIds[cueIndex + 1];
            const nextCue = nextCueId ? timeline.cues[nextCueId] : null;
            const scene = compileNativeCueScene(cue, channelId, {
              width: renderOptions.width,
              height: renderOptions.height,
              nextCue
            });
            const serializedScene = serializeNativeCueScene(scene);
            await atomicWriteFile(scenePath, serializedScene, {
              maximumBytes: MAX_NATIVE_SCENE_BYTES,
              mode: 0o600,
              rootPath: stagingPath
            });
            for (const assetId of sceneAssetIds(scene)) referencedAssetIds.add(assetId);
            const rendered = channel?.mode === 'condensed' && channel.sourceChannelId
              ? await renderer.renderSingerPreview(
                  cue,
                  channel.sourceChannelId,
                  nextCue
                )
              : await renderer.renderCue(cue, channelId);
            await this.sharp(rendered.info.data)
              .resize(renderOptions.thumbnailWidth, null, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toFile(thumbPath);
            await syncRegularFile(thumbPath);
            for (const fileName of [sceneName, thumbName]) {
              const filePath = path.join(channelPath, fileName);
              const stats = await fs.stat(filePath);
              artifacts.push({
                path: `${directory}/${fileName}`,
                size: stats.size,
                sha256: await hashFileNoFollow(
                  filePath,
                  fileName.endsWith('.json') ? MAX_NATIVE_SCENE_BYTES : MAX_RASTER_ARTIFACT_BYTES
                )
              });
            }
            slides.push(rendered.metadata);
            completed += 1;
            options.onProgress?.({ completed, total, roleId, channelId, cueIndex, cueId });
          }
          const metadata = {
            schemaVersion: 1,
            sourceType: 'service-project',
            projectId: projectRead.project.id,
            projectRevisionId: projectRead.revisionId,
            channelId,
            roleId,
            slideCount: slides.length,
            slides
          };
          const metadataName = 'metadata.json';
          const metadataPath = path.join(channelPath, metadataName);
          await atomicWriteFile(metadataPath, canonicalJson(metadata), {
            maximumBytes: MAX_MANIFEST_BYTES,
            mode: 0o600,
            rootPath: stagingPath
          });
          const metadataStats = await fs.stat(metadataPath);
          artifacts.push({
            path: `${directory}/${metadataName}`,
            size: metadataStats.size,
            sha256: await hashFileNoFollow(metadataPath, MAX_MANIFEST_BYTES)
          });
          channels.push({
            roleId,
            channelId,
            renderer: 'native-cue',
            directory,
            metadataPath: `${directory}/${metadataName}`
          });
        }

        const packageAssets = [];
        if (referencedAssetIds.size > 0) {
          const assetDirectory = path.join(stagingPath, 'assets');
          await ensureConfinedDirectory(stagingPath, assetDirectory);
          for (const assetId of [...referencedAssetIds].sort()) {
            const resolved = await this.projectStore.resolveAssetPath(
              projectRead.project.id,
              projectRead.revisionId,
              assetId
            );
            const asset = resolved.asset;
            if (asset.id !== assetId || asset.kind !== 'image') {
              fail('SHOW_PACKAGE_INVALID', 'A native scene refers to an invalid project picture.');
            }
            const relativePath = `assets/${asset.storedName}`;
            const targetPath = path.join(stagingPath, relativePath);
            const { buffer } = await readFileNoFollow(resolved.assetPath, MAX_IMAGE_BYTES);
            await atomicWriteFile(targetPath, buffer, {
              maximumBytes: MAX_IMAGE_BYTES,
              mode: 0o600,
              rootPath: stagingPath
            });
            packageAssets.push({
              id: asset.id,
              path: relativePath,
              mediaType: asset.mediaType,
              sha256: asset.sha256,
              size: asset.size,
              width: asset.width,
              height: asset.height
            });
            artifacts.push({
              path: relativePath,
              size: asset.size,
              sha256: await hashFileNoFollow(targetPath, MAX_IMAGE_BYTES)
            });
          }
        }

        const timelinePath = path.join(stagingPath, 'timeline.json');
        await atomicWriteFile(timelinePath, canonicalJson(timeline), {
          maximumBytes: MAX_MANIFEST_BYTES,
          mode: 0o600,
          rootPath: stagingPath
        });
        const timelineStats = await fs.stat(timelinePath);
        artifacts.push({
          path: 'timeline.json',
          size: timelineStats.size,
          sha256: await hashFileNoFollow(timelinePath, MAX_MANIFEST_BYTES)
        });
        artifacts.sort((a, b) => a.path.localeCompare(b.path));
        const manifest = {
          schemaVersion: SHOW_PACKAGE_SCHEMA_VERSION,
          kind: 'syncshow-show-package',
          id: packageId,
          projectId: projectRead.project.id,
          projectRevisionId: projectRead.revisionId,
          projectRevision: projectRead.project.revision,
          projectContentHash: timeline.projectContentHash,
          timelineSha256: identity.timelineSha256,
          compilerVersion: timeline.compilerVersion,
          rendererVersion: NATIVE_RENDERER_VERSION,
          createdAt: this.clock().toISOString(),
          renderOptions,
          font: {
            family: 'Noto Sans',
            sha256: fontSha256,
            license: 'SIL Open Font License 1.1'
          },
          cueCount: timeline.cueIds.length,
          cueIds: timeline.cueIds,
          roleMapping,
          channels,
          assets: packageAssets,
          artifacts
        };
        await atomicWriteFile(path.join(stagingPath, 'manifest.json'), canonicalJson(manifest), {
          maximumBytes: MAX_MANIFEST_BYTES,
          mode: 0o600,
          rootPath: stagingPath
        });
        await fsyncDirectory(stagingPath).catch(error => {
          if (process.platform !== 'win32') throw error;
        });
        await fs.rename(stagingPath, packagePath);
        published = true;
        await fsyncDirectory(this.rootPath).catch(error => {
          if (process.platform !== 'win32') throw error;
        });
        const verified = await this._verifyManifest(packagePath, packageId);
        return this._resultFromManifest(packagePath, verified);
      } finally {
        if (!published) await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}

module.exports = {
  MAX_PACKAGE_CUES,
  SHOW_PACKAGE_SCHEMA_VERSION,
  ShowPackageError,
  ShowPackagePublisher,
  canonicalJson,
  roleDirectoryName
};
