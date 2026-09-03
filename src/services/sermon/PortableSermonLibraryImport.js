'use strict';

const crypto = require('crypto');

const { normalizeServiceProject } = require('../project/ServiceProject');
const { serializeSermonDocument } = require('./SermonDocument');

const MAX_IMPORT_WARNINGS = 100;

function emptySummary(available = true) {
  return {
    available,
    discovered: 0,
    added: 0,
    unchanged: 0,
    conflicts: 0,
    failed: 0,
    warnings: [],
    omittedWarnings: 0
  };
}

function addWarning(summary, code, sermonId, message) {
  if (summary.warnings.length < MAX_IMPORT_WARNINGS) {
    summary.warnings.push({ code, sermonId, message });
  } else {
    summary.omittedWarnings += 1;
  }
}

function candidateRecords(rawProject) {
  const project = normalizeServiceProject(rawProject);
  const grouped = new Map();
  for (const resource of Object.values(project.resources)
    .filter(candidate => candidate?.kind === 'sermon')
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const source = serializeSermonDocument(resource.document);
    const revision = crypto.createHash('sha256').update(source).digest('hex');
    const revisions = grouped.get(resource.document.id) || new Map();
    revisions.set(revision, {
      sermon: resource.document,
      source,
      revision
    });
    grouped.set(resource.document.id, revisions);
  }
  return grouped;
}

function safeCauseCode(error) {
  const code = String(error?.code || '');
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

async function readCurrentSermon(sermonLibrary, sermonId) {
  try {
    return { current: await sermonLibrary.read(sermonId), error: null };
  } catch (error) {
    if (error?.code === 'SERMON_NOT_FOUND') return { current: null, error: null };
    return { current: null, error };
  }
}

function markConflict(summary, sermonId, code, message) {
  summary.conflicts += 1;
  addWarning(summary, code, sermonId, message);
}

function markFailed(summary, sermonId, code, message) {
  summary.failed += 1;
  addWarning(summary, code, sermonId, message);
}

async function hydrateCandidate(sermonLibrary, sermonId, candidate, summary) {
  const checked = await readCurrentSermon(sermonLibrary, sermonId);
  if (checked.error) {
    markFailed(
      summary,
      sermonId,
      safeCauseCode(checked.error) || 'PORTABLE_SERMON_READ_FAILED',
      `Sermon ${sermonId} could not be checked in the local library; the portable service remains imported.`
    );
    return;
  }
  if (checked.current) {
    if (checked.current.revision === candidate.revision) {
      summary.unchanged += 1;
    } else {
      markConflict(
        summary,
        sermonId,
        'PORTABLE_SERMON_CONFLICT',
        `Sermon ${sermonId} already exists with a different current revision; the existing local sermon was preserved.`
      );
    }
    return;
  }

  try {
    const saved = await sermonLibrary.saveSource(candidate.source, {
      expectedSermonId: sermonId,
      expectedRevision: null
    });
    if (saved.revision !== candidate.revision) {
      markFailed(
        summary,
        sermonId,
        'PORTABLE_SERMON_REVISION_MISMATCH',
        `Sermon ${sermonId} could not be copied at the exact revision pinned by the portable service.`
      );
      return;
    }
    if (saved.unchanged === true) summary.unchanged += 1;
    else summary.added += 1;
  } catch (error) {
    if (error?.code === 'SERMON_CONFLICT') {
      const raced = await readCurrentSermon(sermonLibrary, sermonId);
      if (!raced.error
        && raced.current
        && raced.current.revision === candidate.revision) {
        summary.unchanged += 1;
        return;
      }
      markConflict(
        summary,
        sermonId,
        'PORTABLE_SERMON_CONFLICT',
        `Sermon ${sermonId} changed during import; the existing local sermon was preserved.`
      );
      return;
    }
    markFailed(
      summary,
      sermonId,
      safeCauseCode(error) || 'PORTABLE_SERMON_SAVE_FAILED',
      `Sermon ${sermonId} could not be copied to the local library; its exact revision remains pinned inside the imported service.`
    );
  }
}

async function importPortableProjectSermons(rawProject, sermonLibrary) {
  const grouped = candidateRecords(rawProject);
  const summary = emptySummary(Boolean(sermonLibrary));
  summary.discovered = grouped.size;
  if (!sermonLibrary) return summary;
  if (typeof sermonLibrary.read !== 'function'
    || typeof sermonLibrary.validateSource !== 'function'
    || typeof sermonLibrary.saveSource !== 'function') {
    throw new TypeError('Portable sermon import requires a LocalSermonLibrary');
  }

  for (const [sermonId, revisions] of grouped) {
    if (revisions.size !== 1) {
      markConflict(
        summary,
        sermonId,
        'PORTABLE_SERMON_AMBIGUOUS',
        `The portable service pins multiple different revisions of sermon ${sermonId}; the local current sermon was preserved.`
      );
      continue;
    }
    await hydrateCandidate(sermonLibrary, sermonId, [...revisions.values()][0], summary);
  }
  return summary;
}

function failedPortableSermonImportSummary(rawProject) {
  const summary = emptySummary(true);
  summary.discovered = candidateRecords(rawProject).size;
  summary.failed = summary.discovered;
  if (summary.failed > 0) {
    addWarning(
      summary,
      'PORTABLE_SERMON_LIBRARY_IMPORT_FAILED',
      null,
      'Pinned sermons could not be copied to the local library, but the portable service itself was imported successfully.'
    );
  }
  return summary;
}

module.exports = {
  MAX_IMPORT_WARNINGS,
  failedPortableSermonImportSummary,
  importPortableProjectSermons
};
