'use strict';

const path = require('path');

const MAX_SONG_BATCH_IMPORT_FILES = 50;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

class SongBatchImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SongBatchImportError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SongBatchImportError(code, message, details);
}

function safeFileName(filePath) {
  const fileName = path.basename(String(filePath || '')).trim();
  return fileName ? fileName.slice(0, 255) : 'Unnamed song file';
}

function publicFailure(error) {
  const code = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : 'SONG_IMPORT_FAILED';
  const messages = {
    EMPTY_SONG: 'This file does not contain any song lyrics.',
    INVALID_IMPORT: 'This file could not be read as safe Markdown or plain text.',
    INVALID_SONG: 'This file is not a valid SyncShow song document.',
    INVALID_SONG_ID: 'This file has an invalid song id.',
    INVALID_TEXT: 'This file contains text that SyncShow cannot safely import.',
    INVALID_UTF8: 'This file is not valid UTF-8 text.',
    MISSING_TEXT: 'This file does not contain the required song text.',
    SOURCE_TOO_LARGE: 'This song file is too large to import.',
    TRANSLATION_CYCLE: 'This song would create a circular translation relationship.',
    TRANSLATION_SELF_REFERENCE: 'A song cannot be its own translation.',
    TRANSLATION_TARGET_NOT_FOUND: 'The original song for this translation is not in the local library or this import selection.',
    WRITE_LOCKED: 'The local song library stayed busy while this file was being imported.'
  };
  return {
    code,
    message: messages[code] || 'This file could not be imported. Check its song formatting and try again.'
  };
}

function importStatus(imported) {
  if (imported?.unchanged === true) return 'unchanged';
  if (imported?.forked === true) return 'forked';
  return 'added';
}

async function importSongFilesSequentially(filePaths, importFile, options = {}) {
  if (!Array.isArray(filePaths)) {
    fail('INVALID_SONG_IMPORT_SELECTION', 'Choose one or more song files to import.');
  }
  if (filePaths.length > MAX_SONG_BATCH_IMPORT_FILES) {
    fail(
      'TOO_MANY_SONG_IMPORT_FILES',
      `Choose at most ${MAX_SONG_BATCH_IMPORT_FILES} song files at a time.`,
      { maximum: MAX_SONG_BATCH_IMPORT_FILES, selected: filePaths.length }
    );
  }
  if (typeof importFile !== 'function') {
    throw new TypeError('Song batch import requires an importFile function');
  }

  const files = new Array(filePaths.length);
  const summary = {
    selected: filePaths.length,
    added: 0,
    unchanged: 0,
    forked: 0,
    failed: 0
  };

  function recordSuccess(index, fileName, imported) {
    const status = importStatus(imported);
    summary[status] += 1;
    files[index] = {
      fileName,
      status,
      songId: String(imported?.song?.id || imported?.summary?.id || ''),
      title: String(imported?.song?.title || imported?.summary?.title || fileName)
    };
  }

  function recordFailure(index, fileName, error) {
    summary.failed += 1;
    files[index] = {
      fileName,
      status: 'failed',
      error: publicFailure(error)
    };
  }

  let pendingTranslations = [];
  for (const [index, filePath] of filePaths.entries()) {
    const entry = { index, filePath, fileName: safeFileName(filePath), error: null };
    try {
      const imported = await importFile(filePath, options);
      recordSuccess(index, entry.fileName, imported);
    } catch (error) {
      if (error?.code === 'TRANSLATION_TARGET_NOT_FOUND') {
        pendingTranslations.push({ ...entry, error });
      } else {
        recordFailure(index, entry.fileName, error);
      }
    }
  }

  // Native file pickers do not promise a dependency-aware selection order.
  // Retry translations after the first pass so selecting a translation before
  // its original (or a short translation chain) still imports the whole batch.
  while (pendingTranslations.length > 0) {
    const unresolved = [];
    let importedThisPass = 0;
    for (const entry of pendingTranslations) {
      try {
        const imported = await importFile(entry.filePath, options);
        recordSuccess(entry.index, entry.fileName, imported);
        importedThisPass += 1;
      } catch (error) {
        if (error?.code === 'TRANSLATION_TARGET_NOT_FOUND') {
          unresolved.push({ ...entry, error });
        } else {
          recordFailure(entry.index, entry.fileName, error);
        }
      }
    }
    if (unresolved.length === 0) break;
    if (importedThisPass === 0) {
      for (const entry of unresolved) {
        recordFailure(entry.index, entry.fileName, entry.error);
      }
      break;
    }
    pendingTranslations = unresolved;
  }

  return { summary, files };
}

module.exports = {
  MAX_SONG_BATCH_IMPORT_FILES,
  SongBatchImportError,
  importSongFilesSequentially,
  publicFailure,
  safeFileName
};
