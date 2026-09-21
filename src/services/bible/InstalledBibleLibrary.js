'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BibleImportError, MAX_BIBLE_IMPORT_BYTES, parseBibleImport } = require('../../../packages/bible-import');
const { bibleBooks } = require('./BibleBooks');
const { ensurePrivateDirectory, readFileNoFollow, atomicWriteFile, withExclusiveFileLock } = require('../project/StorageSafety');

const BOOKS = bibleBooks.map(book => ({ id: book.abbr, name: book.name, chapters: book.chapters }));
const MAX_RECORD_BYTES = MAX_BIBLE_IMPORT_BYTES * 2 + 4096;
const safeId = value => typeof value === 'string' && /^[A-Z][A-Z0-9-]{1,31}$/.test(value);
const digestOf = value => crypto.createHash('sha256').update(value).digest('hex');

class InstalledBibleLibrary {
  constructor({ rootPath }) { this.rootPath = path.resolve(rootPath); }

  async _read(id) {
    if (!safeId(id)) throw new BibleImportError('INVALID_BIBLE_ID', 'Choose an installed Bible edition.');
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    let raw;
    try { raw = (await readFileNoFollow(path.join(this.rootPath, `${id}.json`), MAX_RECORD_BYTES)).buffer.toString('utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new BibleImportError('BIBLE_STORAGE', `${id} could not be read safely. Restore a verified backup of this edition.`); }
    try {
      const record = JSON.parse(raw);
      const parsed = parseBibleImport(record.source, BOOKS);
      if (record.version !== 1 || record.permissionConfirmed !== true || typeof record.permissionReference !== 'string'
        || !record.permissionReference.trim() || parsed.summary.id !== id || record.digest !== digestOf(parsed.source)) throw new Error('invalid');
      return { ...parsed, digest: record.digest, installedAt: record.installedAt };
    } catch { throw new BibleImportError('BIBLE_INTEGRITY', `${id} failed its integrity check. Restore a verified backup of this edition.`); }
  }

  async list() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    const editions = [], warnings = [];
    for (const entry of await fs.readdir(this.rootPath)) {
      if (!entry.endsWith('.json') || !safeId(entry.slice(0, -5))) continue;
      try {
        const parsed = await this._read(entry.slice(0, -5));
        if (parsed) editions.push(this._metadata(parsed));
      } catch (error) { warnings.push(error.message); }
    }
    editions.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { editions, warnings };
  }

  _metadata(parsed) {
    const { sample, ...metadata } = parsed.summary;
    return { ...metadata, abbr: metadata.id, builtin: false, digest: parsed.digest, attributionRequired: true };
  }

  async translation(id) { const parsed = await this._read(id); return parsed ? this._metadata(parsed) : null; }
  async book(id, name) {
    const parsed = await this._read(id);
    const canonical = BOOKS.find(book => book.name === name);
    const book = parsed?.document.books.find(book => book.id === canonical?.id);
    return book ? { name, chapters: book.chapters } : null;
  }

  async preview(source) {
    const parsed = parseBibleImport(source, BOOKS);
    const digest = digestOf(parsed.source);
    const existing = await this._read(parsed.summary.id);
    return { preview: parsed.summary, digest, installed: existing?.digest === digest, conflict: Boolean(existing && existing.digest !== digest) };
  }

  async install({ source, digest, permissionConfirmed, permissionReference }) {
    const parsed = parseBibleImport(source, BOOKS);
    if (digestOf(parsed.source) !== digest) throw new BibleImportError('BIBLE_IMPORT_CHANGED', 'The preview changed. Choose and review the file again.');
    if (permissionConfirmed !== true || typeof permissionReference !== 'string' || !permissionReference.trim() || permissionReference.length > 1000) {
      throw new BibleImportError('BIBLE_IMPORT_PERMISSION', 'Confirm permission and enter its license or reference.');
    }
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    return withExclusiveFileLock(path.join(this.rootPath, '.install.lock'), async () => {
      const existing = await this._read(parsed.summary.id);
      if (existing && existing.digest !== digest) throw new BibleImportError('BIBLE_EDITION_CONFLICT', 'This ID belongs to a different installed edition. Use a new ID.');
      if (!existing) await atomicWriteFile(path.join(this.rootPath, `${parsed.summary.id}.json`), JSON.stringify({
        version: 1, source: parsed.source, digest, permissionConfirmed: true, permissionReference: permissionReference.trim(), installedAt: new Date().toISOString()
      }), { rootPath: this.rootPath, maximumBytes: MAX_RECORD_BYTES, mode: 0o600 });
      return { installed: true, id: parsed.summary.id, digest };
    });
  }
}

module.exports = { InstalledBibleLibrary };
