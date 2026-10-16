'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {ensurePrivateDirectory, atomicWriteFile, readFileNoFollow} = require('../project/StorageSafety');
const {serializeSongDocument, parseSongDocument} = require('../project/SongDocument');
const ENDPOINT = '/api/community/service-documents/library/songs';
const ID = /^local-song-[a-f0-9-]{36}$/;
const MAX_BYTES = 256 * 1024;
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

/** A private desktop catalog. It is deliberately outside the Community sync library. */
class LocalPlannerSongs {
  constructor({rootPath}) { this.rootPath = rootPath; this.ready = ensurePrivateDirectory(rootPath).then(root => { this.rootPath = root; }); }

  async read(id) {
    await this.ready;
    if (!ID.test(id)) throw new Error('Invalid local song.');
    const {buffer} = await readFileNoFollow(path.join(this.rootPath, `${id}.json`), MAX_BYTES);
    const item = JSON.parse(buffer.toString('utf8'));
    if (item.syncId !== id || !Array.isArray(item.syncDocuments)) throw new Error('Invalid saved song.');
    for (const document of item.syncDocuments) {
      parseSongDocument(document.source, {fileName: `${document.id}.md`});
      if (document.revision !== crypto.createHash('sha256').update(document.source).digest('hex')) throw new Error('Saved song is damaged.');
    }
    return item;
  }

  async list() {
    await this.ready;
    const items = [];
    for (const name of await fs.readdir(this.rootPath)) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      const {syncDocuments, ...item} = await this.read(name.slice(0, -5));
      const previewSections = syncDocuments.map(document => {
        const song = parseSongDocument(document.source, {fileName: `${document.id}.md`});
        return {language: song.language, label: song.sections[0].label, lines: song.sections[0].slides[0].lines.slice(0, 4)};
      });
      items.push({...item, documentCount: syncDocuments.length, previewSections});
    }
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }

  async create(raw) {
    if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !['english', 'russian', 'authors'].includes(key))) throw new Error('Invalid song fields.');
    const syncId = `local-song-${crypto.randomUUID()}`;
    const languages = ['russian', 'english'].filter(key => raw[key]?.sections?.length);
    if (!languages.length) throw new Error('Add lyrics in at least one language.');
    const syncDocuments = languages.map((key, index) => {
      const value = raw[key], id = `${syncId}-${key === 'russian' ? 'ru' : 'en'}`;
      const source = serializeSongDocument({schemaVersion: 1, id, title: value.title || raw.english?.title || raw.russian?.title,
        language: key === 'russian' ? 'ru' : 'en', translationOf: index ? `${syncId}-ru` : null,
        authors: raw.authors || [], sections: value.sections.map((section, i) => ({id: `section-${i + 1}`, marker: String(i + 1),
          label: section.label, slides: section.lines.reduce((slides, line) => {
            if (!line.trim()) { if (slides.at(-1)?.lines.length) slides.push({lines: []}); }
            else { if (!slides.length) slides.push({lines: []}); slides.at(-1).lines.push(line); }
            return slides;
          }, []).filter(slide => slide.lines.length)}))});
      const parsed = parseSongDocument(source, {fileName: `${id}.md`});
      return {id: parsed.id, source, revision: crypto.createHash('sha256').update(source).digest('hex')};
    });
    const item = {syncId, syncVersion: 1, title: raw.english?.title || raw.russian?.title,
      russianTitle: raw.russian?.title || '', defaultSongLanguage: languages[0] === 'russian' ? 'ru' : 'en',
      rightsStatus: 'private', visibility: 'private', updatedAt: new Date().toISOString(), syncDocuments};
    const bytes = JSON.stringify(item);
    await this.ready;
    await atomicWriteFile(path.join(this.rootPath, `${syncId}.json`), bytes, {rootPath: this.rootPath, maximumBytes: MAX_BYTES});
    return item;
  }

  async request(request) {
    const url = new URL(request.url);
    const local = url.pathname === '/syncshow-local/songs';
    const match = new RegExp(`^${ENDPOINT}/(local-song-[a-f0-9-]{36})$`).exec(url.pathname);
    if (!local && !match) return null;
    try {
      if (request.method === 'GET') return local ? json({schemaVersion: 1, items: await this.list()}) : json({schemaVersion: 1, item: await this.read(match[1])});
      if (local && request.method === 'POST') {
        const text = await request.text();
        if (Buffer.byteLength(text) > MAX_BYTES) return json({error: 'This song is too large.'}, 413);
        return json({schemaVersion: 1, item: await this.create(JSON.parse(text))}, 201);
      }
      return json({error: 'This local song action is unavailable.'}, 405);
    } catch (error) { return json({error: error.message}, error.code === 'ENOENT' ? 404 : 400); }
  }
}
module.exports = {LocalPlannerSongs};
