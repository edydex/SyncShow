'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { ensurePrivateDirectory, readFileNoFollow, atomicWriteFile } = require('../project/StorageSafety');
const { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } = require('../project/ServiceProjectStore');

class CommunityMediaCache {
  constructor(rootPath) { this.rootPath = path.resolve(rootPath); }
  async get(asset, fetchBytes) {
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.id !== `sha256:${asset.sha256}`
      || !['image', 'video'].includes(asset.kind) || !Number.isSafeInteger(asset.size) || asset.size < 1) throw new TypeError('Validated service media is required');
    const limit = asset.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (asset.size > limit) throw new TypeError('Service media is too large');
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    const target = path.join(this.rootPath, asset.sha256);
    const valid = bytes => bytes.length === asset.size && crypto.createHash('sha256').update(bytes).digest('hex') === asset.sha256;
    try {
      const { buffer } = await readFileNoFollow(target, limit);
      if (valid(buffer)) return buffer;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bytes = Buffer.from(await fetchBytes());
    if (!valid(bytes)) throw new Error('Downloaded service media does not match its fingerprint.');
    await atomicWriteFile(target, bytes, { rootPath: this.rootPath, maximumBytes: limit, mode: 0o600 });
    return bytes;
  }
}
module.exports = { CommunityMediaCache };
