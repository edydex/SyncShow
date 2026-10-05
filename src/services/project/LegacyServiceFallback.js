'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { compileServiceProject } = require('./ServiceProject');
const { compileNativeCueScene, sceneAssetIds } = require('../show/NativeCueScene');
const { cueMetadataForChannel, singerCueMetadata } = require('./NativeSlideRenderer');
const { imagePowerPoint } = require('./ImagePowerPoint');
const { Converter } = require('../converter');
const { ensurePrivateDirectory, ensureConfinedDirectory, atomicWriteFile } = require('./StorageSafety');

class LegacyServiceFallback {
  constructor({ rootPath, cacheRoot, projectStore, rendererFactory, sharp, converter }) {
    this.rootPath = rootPath;
    this.cacheRoot = cacheRoot;
    this.projectStore = projectStore;
    this.rendererFactory = rendererFactory;
    this.sharp = sharp || require('sharp');
    this.converter = converter || new Converter();
  }
  async build({ projectId, revisionId, roleMapping, onProgress }) {
    const selected = await this.projectStore.read(projectId);
    if (selected.revisionId !== revisionId) throw new Error('The selected service changed. Load it again before converting.');
    const timeline = compileServiceProject(selected.project);
    const scenes = Object.entries(roleMapping).map(([roleId, channelId]) => ({
      roleId, channelId, scenes: timeline.cueIds.map((cueId, index) =>
        compileNativeCueScene(timeline.cues[cueId], channelId, { width: 1920, height: 1080, nextCue: timeline.cues[timeline.cueIds[index + 1]] || null }))
    }));
    for (const role of scenes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(role.roleId)
        || ['__proto__', 'constructor', 'prototype'].includes(role.roleId)) throw new Error('Invalid fallback screen role.');
      for (const scene of role.scenes) {
        for (const assetId of sceneAssetIds(scene)) {
          if (selected.project.assets[assetId]?.kind === 'video') throw new Error('This fallback cannot preserve video playback. Edit the affected native slide instead.');
        }
        if (scene.layout === 'video' || scene.current?.layout === 'video') throw new Error('This fallback cannot preserve video playback.');
      }
    }
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    const directory = path.join(this.rootPath, crypto.randomUUID());
    await ensureConfinedDirectory(this.rootPath, directory);
    const renderer = this.rendererFactory({
      width: 1920, height: 1080, sharp: this.sharp,
      resolveAsset: assetId => this.projectStore.resolveAssetPath(projectId, revisionId, assetId)
    });
    const presentations = {};
    let complete = false, completed = 0;
    const total = scenes.length * timeline.cueIds.length;
    try {
      for (const { roleId, channelId, scenes: channelScenes } of scenes) {
        const cacheDir = path.join(directory, roleId);
        await ensureConfinedDirectory(directory, cacheDir);
        const images = [], metadataSlides = [];
        let imageBytes = 0;
        for (let index = 0; index < channelScenes.length; index += 1) {
          const cue = timeline.cues[timeline.cueIds[index]];
          const nextCue = timeline.cues[timeline.cueIds[index + 1]] || null;
          const rendered = await renderer.renderScene(channelScenes[index], { fitOverflow: true });
          const image = rendered.info.data;
          imageBytes += image.length;
          if (imageBytes > 512 * 1024 * 1024) throw new Error('This output is too large for PowerPoint fallback. Split the service before converting.');
          const number = String(index + 1).padStart(3, '0');
          await atomicWriteFile(path.join(cacheDir, `slide_${number}.jpg`), image, { rootPath: directory, mode: 0o600, maximumBytes: 20 * 1024 * 1024 });
          const thumb = await this.sharp(image).resize(300).jpeg({ quality: 85 }).toBuffer();
          await atomicWriteFile(path.join(cacheDir, `slide_${number}_thumb.jpg`), thumb, { rootPath: directory, mode: 0o600, maximumBytes: 20 * 1024 * 1024 });
          images.push({ image, title: cue.title });
          const channel = cue.channels[channelId];
          metadataSlides.push(channel.mode === 'condensed' ? singerCueMetadata(cue, channel.sourceChannelId, nextCue) : cueMetadataForChannel(cue, channelId));
          onProgress?.({ completed: ++completed, total, roleId, cueIndex: index });
        }
        const filename = `Service-${selected.project.serviceDate}-${roleId}.pptx`;
        const filePath = path.join(directory, filename);
        await atomicWriteFile(filePath, await imagePowerPoint(images), { rootPath: directory, mode: 0o600, maximumBytes: 1024 * 1024 * 1024 });
        const metadata = { sourceFile: filename, originalFile: filePath, slideCount: images.length,
          convertedAt: new Date().toISOString(), generatedAt: new Date().toISOString(),
          restoreContext: { schemaVersion: 1, groupId: path.basename(directory), sourceKind: 'manual', roleId },
          slides: metadataSlides, nativeFallback: { projectId, revisionId, title: selected.project.title } };
        await atomicWriteFile(path.join(cacheDir, 'metadata.json'), JSON.stringify(metadata), { rootPath: directory, mode: 0o600, maximumBytes: 8 * 1024 * 1024 });
        await this.converter.validateGeneration(cacheDir, images.length);
        presentations[roleId] = { success: true, cacheDir, slideCount: images.length, metadata };
      }
      const current = await this.projectStore.read(projectId);
      if (current.revisionId !== revisionId) throw new Error('The service changed during conversion. Load its latest version again.');
      complete = true;
      return { directory, presentations, projectId, revisionId, title: selected.project.title };
    } finally {
      await renderer.dispose();
      if (!complete) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  // Every deck is ready before the active caches change. Roll back all roles
  // on filesystem failure, including roles whose previous cache was absent.
  async activate(built) {
    this.cacheRoot = await ensurePrivateDirectory(this.cacheRoot);
    // Exports and caches can live on different drives. Copy and validate all
    // new decks beside the active caches before using same-volume renames.
    const staging = path.join(this.cacheRoot, `.fallback-stage-${crypto.randomUUID()}`);
    await ensureConfinedDirectory(this.cacheRoot, staging);
    const backups = [], installed = [];
    try {
      for (const [roleId, presentation] of Object.entries(built.presentations)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(roleId)
          || ['__proto__', 'constructor', 'prototype'].includes(roleId)) throw new Error('Invalid fallback screen role.');
        const prepared = path.join(staging, roleId);
        await fs.cp(presentation.cacheDir, prepared, { recursive: true, force: false, errorOnExist: true });
        await this.converter.validateGeneration(prepared, presentation.slideCount);
      }
      for (const [roleId, presentation] of Object.entries(built.presentations)) {
        const target = path.join(this.cacheRoot, roleId);
        const backup = path.join(this.cacheRoot, `.fallback-backup-${crypto.randomUUID()}`);
        const targetStats = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (targetStats && (!targetStats.isDirectory() || targetStats.isSymbolicLink())) throw new Error('The active slideshow cache is unsafe.');
        try { await fs.rename(target, backup); backups.push({ target, backup }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const prepared = path.join(staging, roleId);
        await fs.rename(prepared, target);
        installed.push({ presentation, target, original: prepared });
      }
      for (const { presentation, target } of installed) presentation.cacheDir = target;
    } catch (error) {
      for (const { target, original } of installed.reverse()) await fs.rename(target, original);
      for (const { target, backup } of backups.reverse()) await fs.rename(backup, target);
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    for (const { backup } of backups) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    return built;
  }
}
module.exports = { LegacyServiceFallback };
