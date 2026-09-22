'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readFileNoFollow, atomicWriteFile } = require('../project/StorageSafety');
const { normalizeOutput } = require('./TranslationProjection');

class TranslationPreferences {
  constructor(directory) { this.directory = directory; }
  file(venueId) {
    if (typeof venueId !== 'string' || !venueId || venueId.length > 128) throw new Error('Choose a venue before configuring translation.');
    return path.join(this.directory, `${createHash('sha256').update(venueId).digest('hex')}.json`);
  }
  async readInput(venueId) {
    try {
      const { buffer } = await readFileNoFollow(this.file(venueId).replace(/\.json$/, '-input.json'), 8192);
      return this.normalizeInput(JSON.parse(buffer.toString('utf8')));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  normalizeInput(input) {
    if (!input || Object.keys(input).sort().join(',') !== 'id,label' || typeof input.id !== 'string'
      || !input.id || input.id.length > 256 || ['default', 'communications'].includes(input.id)
      || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 512
      || /[\x00-\x1f]/.test(input.id + input.label)) throw new Error('Choose a named mixer input.');
    return { id: input.id, label: input.label };
  }
  async writeInput(venueId, input) {
    await atomicWriteFile(this.file(venueId).replace(/\.json$/, '-input.json'), JSON.stringify(this.normalizeInput(input)) + '\n', { maximumBytes: 8192 });
  }
  async read(venueId) {
    try {
      const { buffer } = await readFileNoFollow(this.file(venueId), 32768);
      const data = JSON.parse(buffer.toString('utf8'));
      if (data.schemaVersion !== 1 || data.venueId !== venueId || !Array.isArray(data.outputs) || data.outputs.length > 64) throw new Error('Saved translation settings are invalid.');
      const outputs = new Map();
      for (const [id, settings] of data.outputs) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) || outputs.has(id)) throw new Error('Saved translation outputs are invalid.');
        outputs.set(id, normalizeOutput(settings));
      }
      return outputs;
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw error;
    }
  }
  async write(venueId, outputs) {
    if (outputs.size > 64) throw new Error('Too many translation outputs.');
    const entries = [...outputs].map(([id, settings]) => [id, normalizeOutput(settings)]);
    await atomicWriteFile(this.file(venueId), JSON.stringify({ schemaVersion: 1, venueId, outputs: entries }, null, 2) + '\n', { maximumBytes: 32768 });
  }
}
module.exports = { TranslationPreferences };
