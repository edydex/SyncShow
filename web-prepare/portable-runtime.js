// This adapter is built with the maintained desktop's pure format helpers.
(function (root) {
  'use strict';
  const core = root.SyncShowCore;
  const { crypto } = root.SyncShowSharedRuntime;
  const { MAX_PROJECT_JSON_BYTES, normalizeServiceProject, serializeServiceProject, isPowerPointCompanionProject } = core;
  const MAX_BROWSER_BYTES = 32 * 1024 * 1024;
  const encoder = new TextEncoder();
  class Bytes extends Uint8Array {
    static from(value) {
      return typeof value === 'string' ? new Bytes(encoder.encode(value)) : new Bytes(value);
    }
    static isBuffer(value) { return value instanceof Uint8Array; }
    readUInt16LE(offset) { return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint16(offset, true); }
    readUInt32LE(offset) { return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset, true); }
    toString() { return new TextDecoder('utf-8', { fatal: true }).decode(this); }
    equals(other) { return this.length === other.length && this.every((value, index) => value === other[index]); }
  }
  const Buffer = Bytes;
  /* DESKTOP_FORMAT_HELPERS */

  function readBundle(input) {
    if (!(input instanceof ArrayBuffer) && !(input instanceof Uint8Array)) throw new Error('Choose a portable SyncShow service file.');
    const bytes = input instanceof Uint8Array ? new Bytes(input.buffer, input.byteOffset, input.byteLength) : new Bytes(input);
    if (bytes.length > MAX_BROWSER_BYTES) throw new Error('This browser draft supports files up to 32 MiB. Open larger services in SyncShow desktop; your file has not changed.');
    const entries = inspectZipStructure(bytes);
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry || manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('A bounded portable-service manifest is required.');
    const get = name => {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Missing portable entry: ${name}`);
      return bytes.subarray(entry.dataOffset, entry.dataEnd);
    };
    const manifestBytes = get('manifest.json');
    const manifest = normalizeManifest(JSON.parse(decodeUtf8(manifestBytes, 'manifest.json')));
    assertCanonicalManifest(manifestBytes, manifest);
    const expected = ['manifest.json', 'project.json', ...manifest.assets.map(asset => asset.path)];
    if (expected.length !== entries.size || expected.some(name => !entries.has(name))) throw new Error('The service has undeclared or missing archive entries.');
    const source = get('project.json');
    if (source.length !== manifest.project.size || hashBuffer(source) !== manifest.project.sha256) throw new Error('The project checksum or size does not match.');
    const project = normalizeServiceProject(JSON.parse(decodeUtf8(source, 'project.json')));
    assertCanonicalProject(source, project); // Reject unknown fields instead of silently dropping them.
    if (isPowerPointCompanionProject(project)) throw new Error('This service is tied to a desktop PowerPoint set. Open it in desktop SyncShow.');
    assertPortablePresetPack(project);
    if (project.id !== manifest.project.id || project.schemaVersion !== manifest.project.schemaVersion) throw new Error('The project identity does not match its manifest.');
    const assetIds = Object.keys(project.assets).sort();
    if (JSON.stringify(assetIds) !== JSON.stringify(manifest.assets.map(asset => asset.id).sort())) throw new Error('The project asset inventory does not match.');
    const assets = new Map();
    for (const asset of manifest.assets) {
      assertAssetMatchesManifest(project.assets[asset.id], asset);
      const content = get(asset.path);
      assertImageContent(content, asset);
      assets.set(asset.id, content);
    }
    return { project, assets };
  }

  // STORE-only ZIPs match the desktop format: no compression, hidden entries,
  // data descriptors, directories or arbitrary extracted filesystem paths.
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function writeZip(files) {
    const total = files.reduce((size, [name, data]) => size + 30 + encoder.encode(name).length + data.length + 46 + encoder.encode(name).length, 22);
    if (total > MAX_BROWSER_BYTES) throw new Error('This service exceeds the browser draft’s 32 MiB export limit.');
    const output = new Bytes(total);
    const view = new DataView(output.buffer);
    const u16 = (at, value) => view.setUint16(at, value, true);
    const u32 = (at, value) => view.setUint32(at, value, true);
    const directory = [];
    let at = 0;
    for (const [name, data] of files) {
      const nameBytes = encoder.encode(name), checksum = crc32(data), offset = at;
      u32(at, ZIP_LOCAL_FILE); u16(at + 4, 20); u16(at + 6, ZIP_UTF8_FLAG);
      u16(at + 12, 33); u32(at + 14, checksum); u32(at + 18, data.length); u32(at + 22, data.length); u16(at + 26, nameBytes.length);
      output.set(nameBytes, at + 30); output.set(data, at + 30 + nameBytes.length);
      at += 30 + nameBytes.length + data.length;
      directory.push({ nameBytes, data, checksum, offset });
    }
    const centralOffset = at;
    for (const { nameBytes, data, checksum, offset } of directory) {
      u32(at, ZIP_CENTRAL_FILE); u16(at + 4, (3 << 8) | 20); u16(at + 6, 20); u16(at + 8, ZIP_UTF8_FLAG); u16(at + 14, 33);
      u32(at + 16, checksum); u32(at + 20, data.length); u32(at + 24, data.length); u16(at + 28, nameBytes.length);
      u32(at + 38, 0o100600 << 16); u32(at + 42, offset); output.set(nameBytes, at + 46);
      at += 46 + nameBytes.length;
    }
    u32(at, ZIP_END); u16(at + 8, files.length); u16(at + 10, files.length); u32(at + 12, at - centralOffset); u32(at + 16, centralOffset);
    inspectZipStructure(output);
    return output;
  }

  function writeBundle(rawProject, assets = new Map(), { fileExtension = LIBRESHOW_EXTENSION } = {}) {
    const project = normalizeServiceProject(rawProject);
    assertPortablePresetPack(project);
    if (isPowerPointCompanionProject(project)) throw new Error('PowerPoint companion services require the desktop app.');
    const projectBytes = Bytes.from(serializeServiceProject(project));
    const digest = hashBuffer(projectBytes);
    const inventory = Object.keys(project.assets).sort().map(id => manifestAssetFromProject(project.assets[id]));
    if (assets.size !== inventory.length) throw new Error('The complete asset inventory is required before saving.');
    for (const asset of inventory) {
      const bytes = assets.get(asset.id);
      if (!(bytes instanceof Uint8Array)) throw new Error('An original service asset is unavailable; export was stopped.');
      assertImageContent(new Bytes(bytes.buffer, bytes.byteOffset, bytes.byteLength), asset);
    }
    const manifest = manifestWithId({ kind: BUNDLE_KIND, schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdBy: { application: 'SyncShow', version: '2.1.0-browser-draft' },
      project: { path: 'project.json', id: project.id, schemaVersion: project.schemaVersion, revisionId: digest, sha256: digest, size: projectBytes.length },
      assets: inventory });
    const manifestBytes = Bytes.from(serializeManifest(manifest));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('The service manifest is too large.');
    const bytes = writeZip([['manifest.json', manifestBytes], ['project.json', projectBytes], ...inventory.map(asset => [asset.path, assets.get(asset.id)])]);
    readBundle(bytes); // Verify the full exported archive before download.
    return { bytes, fileName: suggestedFileName(project, fileExtension), revision: digest };
  }
  root.SyncShowPortable = Object.freeze({ readBundle, writeBundle, MAX_BROWSER_BYTES, BUNDLE_FILE_EXTENSIONS });
})(globalThis);
