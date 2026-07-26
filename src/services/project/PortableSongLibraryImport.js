'use strict';

const crypto = require('crypto');

const {
  normalizeServiceProject,
  serializeServiceProject
} = require('./ServiceProject');
const { serializeSongDocument } = require('./SongDocument');

const MAX_IMPORT_WARNINGS = 100;
const OUTPUT_ONLY_SONG_PROVIDER = 'pptx-service-import-output-only';

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

function addWarning(summary, code, songId, message) {
  if (summary.warnings.length < MAX_IMPORT_WARNINGS) {
    summary.warnings.push({ code, songId, message });
  } else {
    summary.omittedWarnings += 1;
  }
}

function reachableSongResources(rawProject) {
  const project = normalizeServiceProject(rawProject);
  const eligibleResources = Object.values(project.resources)
    .filter(resource =>
      resource?.kind === 'song'
      && resource.origin?.provider !== OUTPUT_ONLY_SONG_PROVIDER);
  const resourcesBySongId = new Map();
  for (const resource of eligibleResources) {
    const resources = resourcesBySongId.get(resource.document.id) || [];
    resources.push(resource);
    resourcesBySongId.set(resource.document.id, resources);
  }
  const resourceIds = new Set();
  for (const item of Object.values(project.items)) {
    if (item.kind !== 'song') continue;
    for (const variant of Object.values(item.variants)) {
      if (variant.mode === 'content'
        && project.resources[variant.resourceId]?.origin?.provider !== OUTPUT_ONLY_SONG_PROVIDER) {
        resourceIds.add(variant.resourceId);
      }
    }
  }
  const queue = [...resourceIds].sort();
  for (let index = 0; index < queue.length; index += 1) {
    const resource = project.resources[queue[index]];
    const targetId = resource?.document.translationOf;
    if (!targetId) continue;
    for (const target of resourcesBySongId.get(targetId) || []) {
      if (resourceIds.has(target.id)) continue;
      resourceIds.add(target.id);
      queue.push(target.id);
    }
  }
  return [...resourceIds]
    .sort()
    .map(resourceId => project.resources[resourceId])
    .filter(resource =>
      resource?.kind === 'song'
      && resource.origin?.provider !== OUTPUT_ONLY_SONG_PROVIDER);
}

function candidateRecords(rawProject) {
  const grouped = new Map();
  for (const resource of reachableSongResources(rawProject)) {
    const source = serializeSongDocument(resource.document);
    const revision = crypto.createHash('sha256').update(source).digest('hex');
    const revisions = grouped.get(resource.document.id) || new Map();
    revisions.set(revision, {
      song: resource.document,
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

async function readCurrentSong(songLibrary, songId) {
  try {
    return { current: await songLibrary.read(songId), error: null };
  } catch (error) {
    if (error?.code === 'SONG_NOT_FOUND') return { current: null, error: null };
    return { current: null, error };
  }
}

async function currentMatchesCandidate(songLibrary, current, candidate) {
  if (current.revision === candidate.revision) return true;
  try {
    const validated = await songLibrary.validateSource(candidate.source, {
      fileName: `${candidate.song.id}.md`
    });
    return validated.revision === current.revision;
  } catch (_error) {
    return false;
  }
}

function markConflict(summary, record, code, message) {
  if (record.status === 'conflict') return;
  record.status = 'conflict';
  summary.conflicts += 1;
  addWarning(summary, code, record.songId, message);
}

function markFailed(summary, record, code, message) {
  if (record.status === 'failed') return;
  record.status = 'failed';
  summary.failed += 1;
  addWarning(summary, code, record.songId, message);
}

async function classifyCandidates(songLibrary, grouped, summary) {
  const records = new Map();
  for (const [songId, revisions] of grouped) {
    summary.discovered += 1;
    if (revisions.size !== 1) {
      const record = { songId, candidate: null, status: 'pending' };
      records.set(songId, record);
      markConflict(
        summary,
        record,
        'PORTABLE_SONG_AMBIGUOUS',
        `The portable service pins multiple different revisions of song ${songId}; none replaced the local library song.`
      );
      continue;
    }
    const candidate = [...revisions.values()][0];
    const record = { songId, candidate, status: 'pending' };
    records.set(songId, record);
    const checked = await readCurrentSong(songLibrary, songId);
    if (checked.error) {
      markFailed(
        summary,
        record,
        safeCauseCode(checked.error) || 'PORTABLE_SONG_READ_FAILED',
        `Song ${songId} could not be checked in the local library; the portable service remains imported.`
      );
      continue;
    }
    if (!checked.current) continue;
    if (await currentMatchesCandidate(songLibrary, checked.current, candidate)) {
      record.status = 'unchanged';
      summary.unchanged += 1;
    } else {
      markConflict(
        summary,
        record,
        'PORTABLE_SONG_CONFLICT',
        `Song ${songId} already exists with different content; the existing local library song was preserved.`
      );
    }
  }
  return records;
}

async function externalTargetStatus(songLibrary, songId, cache) {
  if (cache.has(songId)) return cache.get(songId);
  const checked = await readCurrentSong(songLibrary, songId);
  const status = checked.error ? 'failed' : checked.current ? 'available' : 'missing';
  cache.set(songId, status);
  return status;
}

async function saveCandidate(songLibrary, record, summary) {
  try {
    const saved = await songLibrary.saveSource(record.candidate.source, {
      fileName: `${record.songId}.md`,
      expectedRevision: null
    });
    record.status = saved.unchanged === true ? 'unchanged' : 'added';
    if (record.status === 'unchanged') summary.unchanged += 1;
    else summary.added += 1;
    return;
  } catch (error) {
    if (error?.code === 'SONG_CONFLICT') {
      const checked = await readCurrentSong(songLibrary, record.songId);
      if (!checked.error
        && checked.current
        && await currentMatchesCandidate(songLibrary, checked.current, record.candidate)) {
        record.status = 'unchanged';
        summary.unchanged += 1;
        return;
      }
      markConflict(
        summary,
        record,
        'PORTABLE_SONG_CONFLICT',
        `Song ${record.songId} changed during import; the existing local library song was preserved.`
      );
      return;
    }
    markFailed(
      summary,
      record,
      safeCauseCode(error) || 'PORTABLE_SONG_SAVE_FAILED',
      `Song ${record.songId} could not be copied to the local library; it remains pinned inside the imported service.`
    );
  }
}

async function importPortableProjectSongs(rawProject, songLibrary) {
  const grouped = candidateRecords(rawProject);
  const summary = emptySummary(Boolean(songLibrary));
  if (!songLibrary) {
    summary.discovered = grouped.size;
    return summary;
  }
  if (typeof songLibrary.read !== 'function'
    || typeof songLibrary.validateSource !== 'function'
    || typeof songLibrary.saveSource !== 'function') {
    throw new TypeError('Portable song import requires a LocalSongLibrary');
  }

  const records = await classifyCandidates(songLibrary, grouped, summary);
  const externalTargets = new Map();
  let pending = [...records.values()].filter(record => record.status === 'pending');
  while (pending.length > 0) {
    let progressed = false;
    for (const record of pending) {
      const targetId = record.candidate.song.translationOf;
      if (targetId) {
        const target = records.get(targetId);
        if (target?.status === 'pending') continue;
        if (target && !['added', 'unchanged'].includes(target.status)) {
          markConflict(
            summary,
            record,
            'PORTABLE_SONG_TRANSLATION_TARGET_CONFLICT',
            `Song ${record.songId} was not copied because its original song ${targetId} conflicts with or is unavailable in the local library.`
          );
          progressed = true;
          continue;
        }
        if (!target) {
          const targetStatus = await externalTargetStatus(songLibrary, targetId, externalTargets);
          if (targetStatus !== 'available') {
            markFailed(
              summary,
              record,
              targetStatus === 'missing'
                ? 'PORTABLE_SONG_TRANSLATION_TARGET_MISSING'
                : 'PORTABLE_SONG_TRANSLATION_TARGET_UNAVAILABLE',
              `Song ${record.songId} was not copied because its original song ${targetId} is unavailable in the local library.`
            );
            progressed = true;
            continue;
          }
        }
      }
      await saveCandidate(songLibrary, record, summary);
      progressed = true;
    }
    pending = pending.filter(record => record.status === 'pending');
    if (!progressed) {
      for (const record of pending) {
        markFailed(
          summary,
          record,
          'PORTABLE_SONG_TRANSLATION_CYCLE',
          `Song ${record.songId} was not copied because the portable service contains a circular translation relationship.`
        );
      }
      pending = [];
    }
  }
  return summary;
}

function failedPortableSongImportSummary(rawProject) {
  const summary = emptySummary(true);
  summary.discovered = candidateRecords(rawProject).size;
  summary.failed = summary.discovered;
  if (summary.failed > 0) {
    addWarning(
      summary,
      'PORTABLE_SONG_LIBRARY_IMPORT_FAILED',
      null,
      'Pinned songs could not be copied to the local library, but the portable service itself was imported successfully.'
    );
  }
  return summary;
}

module.exports = {
  MAX_IMPORT_WARNINGS,
  OUTPUT_ONLY_SONG_PROVIDER,
  failedPortableSongImportSummary,
  importPortableProjectSongs,
  reachableSongResources
};
