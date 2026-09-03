'use strict';

const crypto = require('crypto');

const {
  CommunityServicePlanError,
  normalizeCommunityServicePlanEnvelope,
  serializeCommunityServicePlan
} = require('./CommunityServicePlan');
const {
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  attachCommunityServicePlanning,
  bindCommunityServicePlanBaseline,
  bindCommunityServicePlanReconciliationReceipt,
  compareSongTranslations,
  createCommunityServicePlanReconciliationReceipt,
  createServiceProject,
  normalizeServiceProject
} = require('../project/ServiceProject');
const {
  communityServicePlanBaselineFromProject
} = require('./CommunityServicePlanBaseline');
const {
  CommunityServicePlanReconciliationError,
  buildCommunityServicePlanReconciliation,
  publicCommunityServicePlanReconciliation,
  reconciliationProjectSha256
} = require('./CommunityServicePlanReconciliation');
const {
  bibleRangeContains
} = require('../sermon/BibleRange');

const MAX_COMMUNITY_PLAN_IMPORT_BLOCKERS = 100;
const MAX_COMMUNITY_PLAN_DIFF_ITEMS = 50;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_REVISION_PATTERN = /^[a-f0-9]{64}$/;
const PREPARABLE_BLOCKER_KINDS = Object.freeze({
  LOCAL_SONG_MISSING: 'song',
  LOCAL_SONG_REMOTE_BEHIND: 'song',
  LOCAL_SERMON_MISSING: 'sermon',
  LOCAL_SERMON_REMOTE_BEHIND: 'sermon'
});

class CommunityServicePlanImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunityServicePlanImportError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunityServicePlanImportError(code, message, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactId(value, label) {
  if (typeof value !== 'string'
    || !ID_PATTERN.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const candidate = value instanceof Date ? value.toISOString() : value;
  if (typeof candidate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
    || Number.isNaN(Date.parse(candidate))
    || new Date(candidate).toISOString() !== candidate) {
    throw new TypeError(`${label} is invalid`);
  }
  return candidate;
}

function normalizeEnvelopeInput(raw) {
  if (!isPlainRecord(raw)) {
    throw new CommunityServicePlanError(
      'INVALID_SERVICE_PLAN',
      'Community service plan envelope must be an object.'
    );
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'plan')) {
    return normalizeCommunityServicePlanEnvelope(raw);
  }
  const expected = [
    'syncId',
    'syncVersion',
    'revision',
    'documentSource',
    'plan',
    'status',
    'changedAt'
  ].sort();
  const actual = Object.keys(raw).sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new CommunityServicePlanError(
      'INVALID_SERVICE_PLAN_FIELDS',
      'Normalized Community service plan envelope has unsupported fields.'
    );
  }
  const normalized = normalizeCommunityServicePlanEnvelope({
    syncId: raw.syncId,
    syncVersion: raw.syncVersion,
    revision: raw.revision,
    documentSource: raw.documentSource,
    status: raw.status,
    changedAt: raw.changedAt
  });
  let suppliedSource;
  try {
    suppliedSource = serializeCommunityServicePlan(raw.plan);
  } catch (_error) {
    suppliedSource = null;
  }
  if (suppliedSource !== normalized.documentSource) {
    throw new CommunityServicePlanError(
      'SERVICE_PLAN_SOURCE_MISMATCH',
      'Normalized Community service plan does not match its canonical source.'
    );
  }
  return normalized;
}

function localProjectId(serverId, planId) {
  const digest = crypto.createHash('sha256')
    .update(`${serverId}\u0000${planId}`)
    .digest('hex');
  return `community-plan-${digest.slice(0, 48)}`;
}

function entryItemId(entryId) {
  const digest = crypto.createHash('sha256').update(entryId).digest('hex');
  return `community-item-${digest.slice(0, 40)}`;
}

function arrangementItemId(entryId, sectionId, index) {
  const digest = crypto.createHash('sha256')
    .update(`${entryId}\u0000${sectionId}\u0000${index}`)
    .digest('hex');
  return `community-arr-${digest.slice(0, 40)}`;
}

function sourceMatches(project, serverId, planId) {
  const source = project?.planning?.source;
  return [2, 3].includes(project?.planning?.schemaVersion)
    && source?.kind === 'community-plan'
    && source.serverId === serverId
    && source.planId === planId;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function itemFingerprint(item) {
  const comparable = { ...item };
  delete comparable.createdAt;
  delete comparable.updatedAt;
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(comparable)))
    .digest('hex');
}

function flattenProjectItems(project) {
  const rows = [];
  const visit = (itemId, parentId, position) => {
    const item = project.items[itemId];
    if (!item) return;
    rows.push({
      itemId,
      parentId,
      position,
      kind: item.kind,
      title: item.title,
      fingerprint: itemFingerprint(item)
    });
    if (item.kind === 'group') {
      item.childIds.forEach((childId, index) => visit(childId, itemId, index));
    }
  };
  project.rootItemIds.forEach((itemId, index) => visit(itemId, null, index));
  return rows;
}

function diffCommunityPlanProjects(existing, candidate, {
  fromRevision,
  toRevision
}) {
  const before = new Map(
    flattenProjectItems(existing).map(row => [row.itemId, row])
  );
  const after = new Map(
    flattenProjectItems(candidate).map(row => [row.itemId, row])
  );
  const changes = [];
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  const itemIds = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const itemId of itemIds) {
    const left = before.get(itemId) || null;
    const right = after.get(itemId) || null;
    let change;
    if (!left) {
      change = 'added';
      addedCount += 1;
    } else if (!right) {
      change = 'removed';
      removedCount += 1;
    } else if (left.fingerprint !== right.fingerprint
      || left.parentId !== right.parentId
      || left.position !== right.position) {
      change = 'changed';
      changedCount += 1;
    } else {
      unchangedCount += 1;
      continue;
    }
    if (changes.length < MAX_COMMUNITY_PLAN_DIFF_ITEMS) {
      changes.push({
        itemId,
        change,
        before: left ? { kind: left.kind, title: left.title } : null,
        after: right ? { kind: right.kind, title: right.title } : null
      });
    }
  }
  const totalChanges = addedCount + removedCount + changedCount;
  return Object.freeze({
    fromRevision,
    toRevision,
    addedCount,
    removedCount,
    changedCount,
    unchangedCount,
    metadataChanges: Object.freeze({
      titleChanged: existing.title !== candidate.title,
      serviceDateChanged: existing.serviceDate !== candidate.serviceDate,
      startTimeChanged:
        existing.planning?.startTime !== candidate.planning?.startTime,
      teamNotesChanged:
        (existing.planning?.teamNotes || '')
          !== (candidate.planning?.teamNotes || '')
    }),
    changes: Object.freeze(changes.map(change => Object.freeze({
      ...change,
      before: change.before ? Object.freeze(change.before) : null,
      after: change.after ? Object.freeze(change.after) : null
    }))),
    truncated: totalChanges > changes.length
  });
}

function lifecycleBlocker(status) {
  const byStatus = {
    draft: {
      code: 'PLAN_NOT_READY',
      message: 'The Community plan is still a draft and cannot be imported.'
    },
    archived: {
      code: 'PLAN_ARCHIVED',
      message: 'The Community plan is archived and cannot be imported.'
    },
    cancelled: {
      code: 'PLAN_CANCELLED',
      message: 'The Community plan is cancelled and cannot be imported.'
    }
  };
  return byStatus[status] || null;
}

function observedPinRelation(state, entry) {
  const observedVersion = state?.syncVersion;
  const observedRevision = state?.remoteRevision;
  if (observedVersion === null && observedRevision === null) {
    return 'unobserved';
  }
  if (!Number.isSafeInteger(observedVersion) || observedVersion < 1) {
    return 'invalid';
  }
  if (observedVersion > entry.expectedSyncVersion) return 'stale-plan';
  if (observedVersion === entry.expectedSyncVersion) {
    return observedRevision === entry.expectedRevision
      ? 'exact'
      : 'stale-plan';
  }
  return typeof observedRevision === 'string' && observedRevision.length > 0
    ? 'behind'
    : 'invalid';
}

function publicProposal(proposal) {
  return Object.freeze(Object.fromEntries(
    Object.entries(proposal).filter(([key]) => !key.startsWith('_'))
  ));
}

function preparationDependencies(envelope, proposal) {
  if (
    proposal.status !== 'blocked'
    || proposal.remoteStatus !== 'ready'
    || proposal.existingProject
    || proposal.blockersTruncated
    || proposal.blockerCount < 1
    || proposal.blockerCount !== proposal.blockers.length
  ) {
    return Object.freeze([]);
  }
  const entries = new Map(
    envelope.plan.entries.map((entry, index) => [
      entry.id,
      { entry, index }
    ])
  );
  const dependencies = new Map();
  for (const blocker of proposal.blockers) {
    const kind = PREPARABLE_BLOCKER_KINDS[blocker.code];
    const located = entries.get(blocker.entryId);
    if (!kind || located?.entry.kind !== kind) {
      return Object.freeze([]);
    }
    const entry = located.entry;
    const key = `${kind}\u0000${entry.syncId}`;
    const existing = dependencies.get(key);
    if (
      existing
      && (
        existing.expectedSyncVersion !== entry.expectedSyncVersion
        || existing.expectedRevision !== entry.expectedRevision
      )
    ) {
      return Object.freeze([]);
    }
    if (existing) {
      existing.entryIds.push(entry.id);
      if (!existing.blockerCodes.includes(blocker.code)) {
        existing.blockerCodes.push(blocker.code);
      }
      existing.firstEntryIndex = Math.min(
        existing.firstEntryIndex,
        located.index
      );
    } else {
      dependencies.set(key, {
        kind,
        syncId: entry.syncId,
        expectedSyncVersion: entry.expectedSyncVersion,
        expectedRevision: entry.expectedRevision,
        entryIds: [entry.id],
        blockerCodes: [blocker.code],
        firstEntryIndex: located.index
      });
    }
  }
  return Object.freeze(
    [...dependencies.values()]
      .sort((left, right) =>
        left.firstEntryIndex - right.firstEntryIndex
        || left.kind.localeCompare(right.kind)
        || left.syncId.localeCompare(right.syncId))
      .map(dependency => Object.freeze({
        kind: dependency.kind,
        syncId: dependency.syncId,
        expectedSyncVersion: dependency.expectedSyncVersion,
        expectedRevision: dependency.expectedRevision,
        entryIds: Object.freeze([...dependency.entryIds]),
        blockerCodes: Object.freeze([...dependency.blockerCodes].sort())
      }))
  );
}

class CommunityServicePlanImportCoordinator {
  constructor({
    serverId,
    connectionId,
    syncStateStore,
    songLibrary,
    sermonLibrary,
    projectStore,
    bibleResolver,
    clock = () => new Date()
  } = {}) {
    this.serverId = exactId(serverId, 'Community server ID');
    this.connectionId = exactId(connectionId, 'Community connection ID');
    if (!syncStateStore
      || typeof syncStateStore.getSongState !== 'function'
      || typeof syncStateStore.getSermonState !== 'function'
      || !songLibrary
      || typeof songLibrary.withCurrentSnapshot !== 'function'
      || !sermonLibrary
      || typeof sermonLibrary.readRevision !== 'function'
      || !projectStore
      || typeof projectStore.read !== 'function'
      || typeof projectStore.create !== 'function'
      || typeof projectStore.save !== 'function'
      || typeof bibleResolver !== 'function'
      || typeof clock !== 'function') {
      throw new TypeError('Community service-plan import dependencies are invalid');
    }
    this.syncStateStore = syncStateStore;
    this.songLibrary = songLibrary;
    this.sermonLibrary = sermonLibrary;
    this.projectStore = projectStore;
    this.bibleResolver = bibleResolver;
    this.clock = clock;
  }

  _now() {
    return canonicalTimestamp(this.clock(), 'Community plan import clock');
  }

  async _readExisting(projectId) {
    try {
      return await this.projectStore.read(projectId);
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND') return null;
      throw error;
    }
  }

  _createBase(envelope, options, importedAt, existingProject = null) {
    try {
      const base = createServiceProject({
        id: localProjectId(this.serverId, envelope.syncId),
        title: envelope.plan.title,
        serviceDate: envelope.plan.serviceDate,
        profileId:
          existingProject?.preferredProfileId || options.profileId,
        preferredProfileId:
          existingProject?.preferredProfileId
            || options.preferredProfileId
            || options.profileId,
        channels: existingProject
          ? existingProject.channelIds.map(channelId =>
              existingProject.channels[channelId])
          : options.channels,
        presetPackId:
          existingProject?.presetPack.id || options.presetPackId,
        presetPackVersion:
          existingProject?.presetPack.version || options.presetPackVersion,
        now: importedAt
      });
      if (!existingProject) return base;
      return normalizeServiceProject({
        ...base,
        preferredProfileId: existingProject.preferredProfileId,
        channelIds: [...existingProject.channelIds],
        channels: existingProject.channels,
        presetPack: existingProject.presetPack
      });
    } catch (error) {
      if (error instanceof ServiceProjectError) {
        fail(
          'INVALID_IMPORT_OPTIONS',
          'The selected local venue profile cannot create this service project.',
          { cause: error.code }
        );
      }
      throw error;
    }
  }

  async _resolveEntries(envelope, baseProject) {
    const blockers = [];
    const blockedEntryIds = new Set();
    let blockerCount = 0;
    const resolutions = new Map();
    const entryIndex = new Map(
      envelope.plan.entries.map((entry, index) => [entry.id, index])
    );
    const block = (entry, code, message) => {
      blockerCount += 1;
      if (entry?.id) blockedEntryIds.add(entry.id);
      if (blockers.length < MAX_COMMUNITY_PLAN_IMPORT_BLOCKERS) {
        blockers.push({
          entryId: entry?.id || null,
          kind: entry?.kind || 'plan',
          code,
          message
        });
      }
    };

    const songEntries = envelope.plan.entries.filter(entry => entry.kind === 'song');
    const songStates = new Map();
    const songPinRelations = new Map();
    for (const entry of songEntries) {
      let state;
      try {
        state = await this.syncStateStore.getSongState(
          this.connectionId,
          entry.syncId
        );
      } catch (_error) {
        block(
          entry,
          'LOCAL_SONG_STATE_UNAVAILABLE',
          'The exact local song synchronization state is unavailable.'
        );
        continue;
      }
      const pinRelation = observedPinRelation(state, entry);
      if (pinRelation === 'stale-plan') {
        block(
          entry,
          'SERVICE_PLAN_SONG_PIN_STALE',
          'This Ready service plan points to an older or inconsistent Community song revision. Refresh and review the plan in Community before preparing it locally.'
        );
      } else if (pinRelation === 'invalid'
        || (pinRelation === 'unobserved' && state.localFamilyId)) {
        block(
          entry,
          'LOCAL_SONG_STATE_UNAVAILABLE',
          'The exact local song synchronization state is unavailable.'
        );
      } else if (!state.localFamilyId || state.metadataOnly) {
        block(
          entry,
          'LOCAL_SONG_MISSING',
          'The referenced song family is not fully available in the local library.'
        );
      } else if (state.conflict) {
        block(
          entry,
          'LOCAL_SONG_CONFLICT',
          'The referenced song family has an unresolved synchronization conflict.'
        );
      } else if (state.archived) {
        block(
          entry,
          'LOCAL_SONG_ARCHIVED',
          'The referenced song family is archived.'
        );
      } else {
        songStates.set(entry.id, state);
        songPinRelations.set(entry.id, pinRelation);
      }
    }

    if (songStates.size > 0) {
      try {
        await this.songLibrary.withCurrentSnapshot(async session => {
          for (const entry of songEntries) {
            const state = songStates.get(entry.id);
            if (!state) continue;
            let snapshot;
            try {
              snapshot = await session.snapshotFamily(state.localFamilyId);
            } catch (_error) {
              block(
                entry,
                'LOCAL_SONG_REVISION_UNAVAILABLE',
                'The exact local song-family revision is unavailable.'
              );
              continue;
            }
            const trackedDocuments = isPlainRecord(state.documents)
              ? state.documents
              : null;
            const snapshotIds = Array.isArray(snapshot.documents)
              ? snapshot.documents.map(document => document.songId).sort()
              : [];
            const trackedIds = trackedDocuments
              ? Object.keys(trackedDocuments).sort()
              : [];
            const documentVectorMatches = trackedDocuments !== null
              && snapshotIds.length === trackedIds.length
              && snapshotIds.every((songId, index) =>
                songId === trackedIds[index])
              && snapshot.documents.every(document => {
                const tracked = trackedDocuments[document.songId];
                return isPlainRecord(tracked)
                  && tracked.localRevision === document.revision
                  && typeof tracked.remoteRevision === 'string'
                  && SHA256_REVISION_PATTERN.test(tracked.remoteRevision);
              });
            if (snapshot.familyId !== state.localFamilyId
              || !documentVectorMatches) {
              block(
                entry,
                'LOCAL_SONG_CHANGED',
                'The local song family no longer matches its exact synchronized document vector.'
              );
              continue;
            }
            if (songPinRelations.get(entry.id) === 'behind') {
              block(
                entry,
                'LOCAL_SONG_REMOTE_BEHIND',
                'The clean local song family is behind the exact revision selected by this service plan.'
              );
              continue;
            }
            const root = snapshot.documents.find(document =>
              document.songId === snapshot.familyId
              && document.translationOf === null);
            if (!root) {
              block(
                entry,
                'LOCAL_SONG_ROOT_MISSING',
                'The local song family has no exact root document.'
              );
              continue;
            }
            const documents = [];
            let readFailed = false;
            for (const descriptor of snapshot.documents) {
              try {
                const read = await session.readRevision(
                  descriptor.songId,
                  descriptor.revision
                );
                if (read.revision !== descriptor.revision
                  || read.song.id !== descriptor.songId) {
                  throw new Error('revision mismatch');
                }
                documents.push({
                  songId: descriptor.songId,
                  revision: descriptor.revision,
                  translationOf: descriptor.translationOf,
                  song: read.song
                });
              } catch (_error) {
                readFailed = true;
                break;
              }
            }
            if (readFailed) {
              block(
                entry,
                'LOCAL_SONG_REVISION_UNAVAILABLE',
                'An exact local song document revision is unavailable.'
              );
              continue;
            }
            const rootDocument = documents.find(document =>
              document.songId === root.songId);
            const selectedByChannel = {};
            let variantBlocked = false;
            for (const channelId of baseProject.channelIds) {
              const channel = baseProject.channels[channelId];
              if (channelId === baseProject.channelIds[0]
                || channel.language === 'und'
                || channel.language === rootDocument.song.language) {
                selectedByChannel[channelId] = rootDocument.songId;
                continue;
              }
              const matching = documents.filter(document =>
                document.song.language === channel.language);
              if (matching.length > 1) {
                block(
                  entry,
                  'AMBIGUOUS_LOCAL_SONG_VARIANT',
                  `More than one exact local song variant matches channel ${channelId}.`
                );
                variantBlocked = true;
                break;
              }
              if (matching.length === 1) {
                const comparison = compareSongTranslations(
                  rootDocument.song,
                  matching[0].song
                );
                if (!comparison.compatible) {
                  block(
                    entry,
                    'LOCAL_SONG_VARIANT_CHANGED',
                    `The local song variant for channel ${channelId} is not structurally aligned.`
                  );
                  variantBlocked = true;
                  break;
                }
                selectedByChannel[channelId] = matching[0].songId;
              } else {
                selectedByChannel[channelId] = rootDocument.songId;
              }
            }
            if (!variantBlocked) {
              resolutions.set(entry.id, {
                kind: 'song',
                localFamilyId: state.localFamilyId,
                rootSongId: rootDocument.songId,
                documents,
                selectedByChannel
              });
            }
          }
        });
      } catch (_error) {
        for (const entry of songEntries) {
          if (songStates.has(entry.id)
            && !resolutions.has(entry.id)
            && !blockedEntryIds.has(entry.id)) {
            block(
              entry,
              'LOCAL_SONG_SNAPSHOT_UNAVAILABLE',
              'The local song library could not provide one stable snapshot.'
            );
          }
        }
      }
    }

    for (const entry of envelope.plan.entries) {
      if (entry.kind === 'sermon') {
        let state;
        try {
          state = await this.syncStateStore.getSermonState(
            this.connectionId,
            entry.syncId
          );
        } catch (_error) {
          block(
            entry,
            'LOCAL_SERMON_STATE_UNAVAILABLE',
            'The exact local sermon synchronization state is unavailable.'
          );
          continue;
        }
        const pinRelation = observedPinRelation(state, entry);
        if (pinRelation === 'stale-plan') {
          block(
            entry,
            'SERVICE_PLAN_SERMON_PIN_STALE',
            'This Ready service plan points to an older or inconsistent Community sermon revision. Refresh and review the plan in Community before preparing it locally.'
          );
        } else if (pinRelation === 'invalid'
          || (pinRelation === 'unobserved' && state.localSermonId)) {
          block(
            entry,
            'LOCAL_SERMON_STATE_UNAVAILABLE',
            'The exact local sermon synchronization state is unavailable.'
          );
        } else if (!state.localSermonId) {
          block(
            entry,
            'LOCAL_SERMON_MISSING',
            'The referenced sermon is not available in the local library.'
          );
        } else if (state.conflict) {
          block(
            entry,
            'LOCAL_SERMON_CONFLICT',
            'The referenced sermon has an unresolved synchronization conflict.'
          );
        } else if (pinRelation === 'behind'
          && state.localRevision !== state.remoteRevision) {
          block(
            entry,
            'LOCAL_SERMON_CHANGED',
            'The local sermon no longer matches its last synchronized revision.'
          );
        } else if (pinRelation === 'behind') {
          block(
            entry,
            'LOCAL_SERMON_REMOTE_BEHIND',
            'The clean local sermon is behind the exact revision selected by this service plan.'
          );
        } else if (state.localRevision !== entry.expectedRevision) {
          block(
            entry,
            'LOCAL_SERMON_CHANGED',
            'The local sermon no longer matches the planned revision.'
          );
        } else {
          try {
            const read = await this.sermonLibrary.readRevision(
              state.localSermonId,
              entry.expectedRevision
            );
            if (read.revision !== entry.expectedRevision
              || read.sermon.id !== state.localSermonId) {
              throw new Error('revision mismatch');
            }
            if (read.sermon.publication.status === 'archived') {
              block(
                entry,
                'LOCAL_SERMON_ARCHIVED',
                'The referenced sermon is archived.'
              );
            } else {
              resolutions.set(entry.id, {
                kind: 'sermon',
                localSermonId: state.localSermonId,
                revision: read.revision,
                sermon: read.sermon
              });
            }
          } catch (_error) {
            block(
              entry,
              'LOCAL_SERMON_REVISION_UNAVAILABLE',
              'The exact local sermon revision is unavailable.'
            );
          }
        }
      } else if (entry.kind === 'scripture') {
        try {
          const result = await this.bibleResolver({
            range: entry.range,
            translationId: entry.translationId,
            channelIds: baseProject.channelIds,
            channels: baseProject.channels
          });
          if (!isPlainRecord(result)
            || Object.keys(result).length !== 1
            || !isPlainRecord(result.passagesByChannel)) {
            throw new Error('invalid Bible resolver result');
          }
          const passageChannelIds =
            Object.keys(result.passagesByChannel).sort();
          const expectedChannelIds = [...baseProject.channelIds].sort();
          if (passageChannelIds.length !== expectedChannelIds.length
            || passageChannelIds.some((channelId, index) =>
              channelId !== expectedChannelIds[index])) {
            throw new Error('incomplete Bible resolver result');
          }
          addBibleItem(baseProject, {
            id: entryItemId(entry.id),
            title: entry.title,
            range: entry.range,
            passagesByChannel: result.passagesByChannel,
            now: baseProject.createdAt
          });
          resolutions.set(entry.id, {
            kind: 'scripture',
            passagesByChannel: result.passagesByChannel
          });
        } catch (_error) {
          block(
            entry,
            'SCRIPTURE_TEXT_UNAVAILABLE',
            'The exact requested Bible text is not available for every local output.'
          );
        }
      }
    }

    const entriesById = new Map(
      envelope.plan.entries.map(entry => [entry.id, entry])
    );
    for (const entry of envelope.plan.entries) {
      if (entry.kind !== 'scripture' || !entry.sermonReading) continue;
      const sermonEntry = entriesById.get(entry.sermonReading.sermonEntryId);
      const scriptureIndex = entryIndex.get(entry.id);
      const sermonIndex = entryIndex.get(sermonEntry?.id);
      if (sermonEntry?.kind !== 'sermon'
        || !Number.isSafeInteger(scriptureIndex)
        || !Number.isSafeInteger(sermonIndex)
        || scriptureIndex >= sermonIndex) {
        block(
          entry,
          'SERVICE_PLAN_SERMON_READING_TARGET_UNAVAILABLE',
          'The congregational reading does not identify one later exact sermon entry in this service plan.'
        );
        continue;
      }
      const sermonResolution = resolutions.get(sermonEntry.id);
      if (!sermonResolution) {
        // The exact sermon entry already carries its own actionable blocker.
        // Never substitute a different local sermon merely to satisfy this link.
        continue;
      }
      const reference = sermonResolution.sermon.references.find(candidate =>
        candidate.id === entry.sermonReading.referenceId);
      if (!reference) {
        block(
          entry,
          'SERVICE_PLAN_SERMON_READING_REFERENCE_MISSING',
          'The exact pinned sermon no longer contains the selected reading reference.'
        );
        continue;
      }
      if (reference.role !== 'primary') {
        block(
          entry,
          'SERVICE_PLAN_SERMON_READING_REFERENCE_NOT_PRIMARY',
          'The selected sermon reference is not marked as the primary preaching passage.'
        );
        continue;
      }
      if (reference.reviewStatus !== 'confirmed') {
        block(
          entry,
          'SERVICE_PLAN_SERMON_READING_REFERENCE_UNCONFIRMED',
          'The selected primary sermon reference has not been confirmed by a person.'
        );
        continue;
      }
      if (!bibleRangeContains(reference.range, entry.range)) {
        block(
          entry,
          'SERVICE_PLAN_SERMON_READING_RANGE_MISMATCH',
          'The congregational reading is outside the confirmed primary passage in the exact pinned sermon.'
        );
      }
    }

    blockers.sort((left, right) =>
      (entryIndex.get(left.entryId) ?? -1)
        - (entryIndex.get(right.entryId) ?? -1)
      || left.code.localeCompare(right.code));
    return {
      blockers,
      blockerCount,
      blockersTruncated: blockerCount > blockers.length,
      resolutions
    };
  }

  _populateProject(baseProject, envelope, resolutions, importedAt) {
    let project = baseProject;
    let parentId = null;
    const sermonResourceIds = new Map();
    for (const entry of envelope.plan.entries) {
      if (entry.kind !== 'sermon') continue;
      const resolution = resolutions.get(entry.id);
      const added = addSermonResource(project, resolution.sermon, {
        provider: 'local-sermon-library',
        providerId: this.serverId,
        itemId: resolution.localSermonId,
        revision: resolution.revision
      });
      project = added.project;
      sermonResourceIds.set(entry.id, added.resourceId);
    }
    for (const entry of envelope.plan.entries) {
      const itemId = entryItemId(entry.id);
      if (entry.kind === 'section') {
        project = addGroupItem(project, {
          id: itemId,
          title: entry.title,
          groupKind: 'section',
          now: importedAt
        });
        parentId = itemId;
      } else if (entry.kind === 'song') {
        const resolution = resolutions.get(entry.id);
        const resourceIds = new Map();
        for (const document of resolution.documents) {
          if (!Object.values(resolution.selectedByChannel)
            .includes(document.songId)) {
            continue;
          }
          const added = addSongResource(project, document.song, {
            provider: 'local-song-library',
            providerId: resolution.localFamilyId,
            itemId: document.songId,
            revision: document.revision
          });
          project = added.project;
          resourceIds.set(document.songId, added.resourceId);
        }
        const primaryChannelId = project.channelIds[0];
        const variants = {};
        for (const channelId of project.channelIds) {
          const selectedSongId = resolution.selectedByChannel[channelId];
          variants[channelId] = selectedSongId === resolution.rootSongId
            && channelId !== primaryChannelId
            ? { mode: 'inherit', from: primaryChannelId }
            : { mode: 'content', resourceId: resourceIds.get(selectedSongId) };
        }
        const root = resolution.documents.find(document =>
          document.songId === resolution.rootSongId);
        project = addProjectItem(project, {
          id: itemId,
          kind: 'song',
          title: entry.title,
          variants,
          primaryChannelId,
          arrangement: root.song.sections.map((section, index) => ({
            id: arrangementItemId(entry.id, section.id, index),
            sectionId: section.id
          })),
          titlePresetId: 'song-title',
          lyricsPresetId: 'song-lyrics',
          operatorNotes: ''
        }, {
          parentId,
          now: importedAt
        });
      } else if (entry.kind === 'scripture') {
        const resolution = resolutions.get(entry.id);
        project = addBibleItem(project, {
          id: itemId,
          title: entry.title,
          range: entry.range,
          passagesByChannel: resolution.passagesByChannel,
          ...(entry.sermonReading
            ? {
                sermonReading: {
                  sermonResourceId: sermonResourceIds.get(
                    entry.sermonReading.sermonEntryId
                  ),
                  referenceId: entry.sermonReading.referenceId,
                  translationId: entry.translationId,
                  chunkIndex: 0,
                  chunkCount: 1
                }
              }
            : {}),
          parentId,
          now: importedAt
        });
      } else if (entry.kind === 'sermon') {
        project = addGroupItem(project, {
          id: itemId,
          title: entry.title,
          groupKind: 'sermon',
          sermonResourceId: sermonResourceIds.get(entry.id),
          parentId,
          now: importedAt
        });
      }
    }
    return attachCommunityServicePlanning(project, {
      serverId: this.serverId,
      planId: envelope.syncId,
      planRevision: envelope.revision,
      importedAt,
      startTime: envelope.plan.startTime,
      teamNotes: envelope.plan.teamNotes
    });
  }

  async _propose(rawEnvelope, options = {}) {
    const envelope = normalizeEnvelopeInput(rawEnvelope);
    const projectId = localProjectId(this.serverId, envelope.syncId);
    const existingRecord = await this._readExisting(projectId);
    if (existingRecord && !sourceMatches(
      existingRecord.project,
      this.serverId,
      envelope.syncId
    )) {
      return {
        status: 'blocked',
        projectId,
        planId: envelope.syncId,
        planRevision: envelope.revision,
        remoteStatus: envelope.status,
        blockerCount: 1,
        blockersTruncated: false,
        blockers: Object.freeze([Object.freeze({
          entryId: null,
          kind: 'plan',
          code: 'LOCAL_PROJECT_ID_CONFLICT',
          message: 'A different local project already uses this Community plan identity.'
        })]),
        diff: null,
        existingProject: true,
        _existingRecord: existingRecord
      };
    }

    const lifecycle = lifecycleBlocker(envelope.status);
    if (lifecycle) {
      return {
        status: 'blocked',
        projectId,
        planId: envelope.syncId,
        planRevision: envelope.revision,
        remoteStatus: envelope.status,
        blockerCount: 1,
        blockersTruncated: false,
        blockers: Object.freeze([Object.freeze({
          entryId: null,
          kind: 'plan',
          ...lifecycle
        })]),
        diff: null,
        existingProject: Boolean(existingRecord),
        _existingRecord: existingRecord
      };
    }

    if (existingRecord
      && existingRecord.project.planning.source.planRevision
        === envelope.revision) {
      return {
        status: 'already-imported',
        projectId,
        planId: envelope.syncId,
        planRevision: envelope.revision,
        remoteStatus: envelope.status,
        blockerCount: 0,
        blockersTruncated: false,
        blockers: Object.freeze([]),
        diff: null,
        existingProject: true,
        revisionId: existingRecord.revisionId,
        _existingRecord: existingRecord
      };
    }

    const importedAt = this._now();
    const baseProject = this._createBase(
      envelope,
      options,
      importedAt,
      existingRecord?.project || null
    );
    const resolved = await this._resolveEntries(envelope, baseProject);
    if (resolved.blockerCount > 0) {
      const blocked = {
        status: 'blocked',
        projectId,
        planId: envelope.syncId,
        planRevision: envelope.revision,
        remoteStatus: envelope.status,
        blockerCount: resolved.blockerCount,
        blockersTruncated: resolved.blockersTruncated,
        blockers: Object.freeze(
          resolved.blockers.map(blocker => Object.freeze(blocker))
        ),
        diff: null,
        existingProject: Boolean(existingRecord),
        _existingRecord: existingRecord,
        _resolutions: resolved.resolutions
      };
      blocked._preparationDependencies = preparationDependencies(
        envelope,
        blocked
      );
      return blocked;
    }

    let candidate;
    let candidateBaseline;
    try {
      candidate = this._populateProject(
        baseProject,
        envelope,
        resolved.resolutions,
        importedAt
      );
      candidateBaseline = communityServicePlanBaselineFromProject(
        candidate,
        envelope.plan.entries
      );
      candidate = bindCommunityServicePlanBaseline(
        candidate,
        candidateBaseline
      );
    } catch (error) {
      if (!(error instanceof ServiceProjectError)) throw error;
      return {
        status: 'blocked',
        projectId,
        planId: envelope.syncId,
        planRevision: envelope.revision,
        remoteStatus: envelope.status,
        blockerCount: 1,
        blockersTruncated: false,
        blockers: Object.freeze([Object.freeze({
          entryId: null,
          kind: 'plan',
          code: 'LOCAL_CONTENT_INCOMPATIBLE',
          message: 'The exact local resources cannot form a valid native service project.'
        })]),
        diff: null,
        existingProject: Boolean(existingRecord),
        _existingRecord: existingRecord,
        _resolutions: resolved.resolutions
      };
    }

    if (existingRecord) {
      let reconciliation;
      if (
        existingRecord.project.planning.schemaVersion === 3
        && existingRecord.project.planning.reconciliationBaseline
        && existingRecord.project.planning.reconciliationBaseline
          .schemaVersion === 2
      ) {
        try {
          reconciliation = buildCommunityServicePlanReconciliation({
            baseline:
              existingRecord.project.planning.reconciliationBaseline,
            localProject: existingRecord.project,
            communityProject: candidate,
            communityBaseline: candidateBaseline
          });
        } catch (error) {
          if (
            !(error instanceof CommunityServicePlanReconciliationError)
          ) {
            throw error;
          }
          return {
            status: 'blocked',
            projectId,
            planId: envelope.syncId,
            planRevision: envelope.revision,
            remoteStatus: envelope.status,
            blockerCount: 1,
            blockersTruncated: false,
            blockers: Object.freeze([Object.freeze({
              entryId: null,
              kind: 'plan',
              code: error.code,
              message: error.message
            })]),
            diff: null,
            existingProject: true,
            _existingRecord: existingRecord,
            _candidate: candidate,
            _candidateBaseline: candidateBaseline,
            _resolutions: resolved.resolutions
          };
        }
      } else {
        const conflictId = `reconcile-${crypto.createHash('sha256')
          .update([
            existingRecord.project.planning.source.planRevision,
            envelope.revision,
            existingRecord.revisionId,
            'legacy-full-replace'
          ].join('\u0000'))
          .digest('hex')
          .slice(0, 40)}`;
        reconciliation = Object.freeze({
          schemaVersion: 1,
          mode: 'legacy-full-replace',
          applicable: true,
          baselinePlanRevision:
            existingRecord.project.planning.source.planRevision,
          baselineProjectionSha256: null,
          candidatePlanRevision: envelope.revision,
          candidateProjectionSha256: candidateBaseline.projectionSha256,
          mergeResultSha256: reconciliationProjectSha256(candidate),
          preservedLocalItemCount: 0,
          appliedCommunityItemCount:
            Object.keys(candidate.items).length,
          autoMergedItemCount: 0,
          conflictCount: 1,
          conflictsTruncated: false,
          conflicts: Object.freeze([Object.freeze({
            conflictId,
            kind: 'RECONCILIATION_BASELINE_UNAVAILABLE',
            itemId: null,
            entryId: null,
            title: 'Legacy imported project',
            local: Object.freeze({
              choice: 'keep-local',
              summary:
                'Keep the current local Planning project unchanged.'
            }),
            community: Object.freeze({
              choice: 'use-community',
              summary:
                'Replace the active Planning contents with the exact Community revision. The current revision remains recoverable in history, and future updates will reconcile safely.'
            })
          })])
        });
      }
      return {
        status: 'newer-revision',
        projectId,
        planId: envelope.syncId,
        planRevision: envelope.revision,
        remoteStatus: envelope.status,
        blockerCount: 0,
        blockersTruncated: false,
        blockers: Object.freeze([]),
        diff: diffCommunityPlanProjects(
          existingRecord.project,
          candidate,
          {
            fromRevision:
              existingRecord.project.planning.source.planRevision,
            toRevision: envelope.revision
          }
        ),
        reconciliation:
          publicCommunityServicePlanReconciliation(reconciliation),
        existingProject: true,
        revisionId: existingRecord.revisionId,
        _candidate: candidate,
        _candidateBaseline: candidateBaseline,
        _reconciliation: reconciliation,
        _existingRecord: existingRecord,
        _resolutions: resolved.resolutions
      };
    }

    return {
      status: 'ready-to-import',
      projectId,
      planId: envelope.syncId,
      planRevision: envelope.revision,
      remoteStatus: envelope.status,
      blockerCount: 0,
      blockersTruncated: false,
      blockers: Object.freeze([]),
      diff: null,
      existingProject: false,
      _candidate: candidate,
      _candidateBaseline: candidateBaseline,
      _existingRecord: null,
      _resolutions: resolved.resolutions,
      _importedAt: importedAt,
      _envelope: envelope
    };
  }

  async propose(rawEnvelope, options = {}) {
    return publicProposal(await this._propose(rawEnvelope, options));
  }

  async review(rawEnvelope, options = {}) {
    const inspected = await this._propose(rawEnvelope, options);
    return Object.freeze({
      proposal: publicProposal(inspected),
      preparationDependencies:
        inspected._preparationDependencies || Object.freeze([])
    });
  }

  async importPlan(rawEnvelope, options = {}) {
    const proposal = await this._propose(rawEnvelope, options);
    if (proposal.status === 'already-imported') {
      return Object.freeze({
        status: 'already-imported',
        projectId: proposal.projectId,
        revisionId: proposal.revisionId,
        project: proposal._existingRecord.project,
        unchanged: true
      });
    }
    if (proposal.status === 'newer-revision') {
      fail(
        'PLAN_REVISION_REVIEW_REQUIRED',
        'A newer Community plan revision requires explicit local review before replacing the imported project.',
        { projectId: proposal.projectId, diff: proposal.diff }
      );
    }
    if (proposal.status !== 'ready-to-import') {
      fail(
        'PLAN_IMPORT_BLOCKED',
        'The Community plan cannot be imported until every blocker is resolved.',
        {
          projectId: proposal.projectId,
          blockers: proposal.blockers,
          blockerCount: proposal.blockerCount
        }
      );
    }

    let created;
    try {
      created = await this.projectStore.create({
        id: proposal.projectId,
        title: proposal._envelope.plan.title,
        serviceDate: proposal._envelope.plan.serviceDate,
        profileId: options.profileId,
        preferredProfileId: options.preferredProfileId || options.profileId,
        channels: options.channels,
        presetPackId: options.presetPackId,
        presetPackVersion: options.presetPackVersion
      }, {
        prepareProject: () => proposal._candidate
      });
    } catch (error) {
      if (error?.code !== 'PROJECT_CONFLICT') throw error;
      const raced = await this._readExisting(proposal.projectId);
      if (raced
        && sourceMatches(
          raced.project,
          this.serverId,
          proposal.planId
        )
        && raced.project.planning.source.planRevision
          === proposal.planRevision) {
        return Object.freeze({
          status: 'already-imported',
          projectId: proposal.projectId,
          revisionId: raced.revisionId,
          project: raced.project,
          unchanged: true
        });
      }
      fail(
        'LOCAL_PROJECT_CONFLICT',
        'Another local project claimed this Community plan identity during import.',
        { projectId: proposal.projectId }
      );
    }
    return Object.freeze({
      status: 'imported',
      projectId: proposal.projectId,
      revisionId: created.revisionId,
      project: created.project,
      unchanged: created.unchanged === true
    });
  }

  async replacePlanRevision(rawEnvelope, options = {}, {
    expectedRevisionId,
    decisions = null,
    expectedReconciliation = null
  } = {}) {
    if (typeof expectedRevisionId !== 'string'
      || !SHA256_REVISION_PATTERN.test(expectedRevisionId)) {
      fail(
        'INVALID_PLAN_REPLACEMENT',
        'The reviewed local service-project revision is invalid.'
      );
    }

    const proposal = await this._propose(rawEnvelope, options);
    if (proposal.remoteStatus !== 'ready') {
      fail(
        'PLAN_REPLACEMENT_NOT_READY',
        'Only an exact Ready Community plan revision can replace the local Planning project.',
        {
          projectId: proposal.projectId,
          remoteStatus: proposal.remoteStatus
        }
      );
    }
    if (proposal.status === 'blocked') {
      fail(
        'PLAN_REPLACEMENT_BLOCKED',
        'The reviewed Community revision can no longer form an exact local Planning project.',
        {
          projectId: proposal.projectId,
          blockers: proposal.blockers,
          blockerCount: proposal.blockerCount
        }
      );
    }
    if (proposal.status !== 'newer-revision') {
      fail(
        'PLAN_REPLACEMENT_STALE',
        'The local or Community revision changed after review. Check the Community revision again before replacing anything.',
        {
          projectId: proposal.projectId,
          proposalStatus: proposal.status
        }
      );
    }
    if (proposal.revisionId !== expectedRevisionId) {
      fail(
        'LOCAL_PROJECT_CHANGED',
        'The local Planning project changed after this Community revision was reviewed.',
        {
          projectId: proposal.projectId,
          expectedRevisionId,
          currentRevisionId: proposal.revisionId
        }
      );
    }
    if (expectedReconciliation !== null) {
      const expectedKeys = [
        'mode',
        'baselineProjectionSha256',
        'candidateProjectionSha256',
        'mergeResultSha256'
      ].sort();
      const actualKeys = isPlainRecord(expectedReconciliation)
        ? Object.keys(expectedReconciliation).sort()
        : [];
      if (
        !isPlainRecord(expectedReconciliation)
        || actualKeys.length !== expectedKeys.length
        || actualKeys.some((key, index) => key !== expectedKeys[index])
        || !['three-way', 'legacy-full-replace'].includes(
          expectedReconciliation.mode
        )
        || (
          expectedReconciliation.baselineProjectionSha256 !== null
          && !SHA256_REVISION_PATTERN.test(
            expectedReconciliation.baselineProjectionSha256
          )
        )
        || !SHA256_REVISION_PATTERN.test(
          expectedReconciliation.candidateProjectionSha256 || ''
        )
        || !SHA256_REVISION_PATTERN.test(
          expectedReconciliation.mergeResultSha256 || ''
        )
      ) {
        fail(
          'INVALID_PLAN_REPLACEMENT',
          'The reviewed Community reconciliation authority is invalid.'
        );
      }
      const current = proposal.reconciliation;
      if (
        !current
        || current.mode !== expectedReconciliation.mode
        || current.baselineProjectionSha256
          !== expectedReconciliation.baselineProjectionSha256
        || current.candidateProjectionSha256
          !== expectedReconciliation.candidateProjectionSha256
        || current.mergeResultSha256
          !== expectedReconciliation.mergeResultSha256
      ) {
        fail(
          'PLAN_RECONCILIATION_STALE',
          'The reviewed Community reconciliation changed before it could be applied.'
        );
      }
    }

    let replacementProject = proposal._candidate;
    let saveReason = 'community-plan-replace';
    let resultStatus = 'replaced';
    let appliedReconciliation = proposal._reconciliation;
    if (proposal._reconciliation?.mode === 'three-way') {
      let reconciliation;
      try {
        reconciliation = buildCommunityServicePlanReconciliation({
          baseline:
            proposal._existingRecord.project.planning.reconciliationBaseline,
          localProject: proposal._existingRecord.project,
          communityProject: proposal._candidate,
          communityBaseline: proposal._candidateBaseline,
          decisions,
          requireDecisions: true
        });
      } catch (error) {
        if (!(error instanceof CommunityServicePlanReconciliationError)) {
          throw error;
        }
        fail(error.code, error.message, error.details);
      }
      if (
        reconciliation.applicable !== true
        || reconciliation.baselineProjectionSha256
          !== proposal._reconciliation.baselineProjectionSha256
        || reconciliation.candidateProjectionSha256
          !== proposal._reconciliation.candidateProjectionSha256
      ) {
        fail(
          'PLAN_RECONCILIATION_STALE',
          'The reviewed Community reconciliation changed before it could be applied.'
        );
      }
      replacementProject = reconciliation.project;
      appliedReconciliation = reconciliation;
      saveReason = 'community-plan-reconcile';
      resultStatus = 'reconciled';
    } else if (
      proposal._reconciliation?.mode === 'legacy-full-replace'
    ) {
      const conflicts = proposal._reconciliation.conflicts;
      const expectedConflictId = conflicts[0]?.conflictId;
      if (
        !Array.isArray(decisions)
        || decisions.length !== 1
        || decisions[0]?.conflictId !== expectedConflictId
        || decisions[0]?.choice !== 'use-community'
        || Object.keys(decisions[0]).length !== 2
      ) {
        fail(
          'LEGACY_PLAN_REPLACEMENT_CONFIRMATION_REQUIRED',
          'This older imported project has no safe three-way baseline. Choose Community explicitly to replace its active contents, or keep the local project unchanged.'
        );
      }
    } else {
      fail(
        'PLAN_RECONCILIATION_UNAVAILABLE',
        'This Community revision no longer has a valid reconciliation proposal.'
      );
    }

    const decisionsByConflictId = new Map(
      (Array.isArray(decisions) ? decisions : []).map(decision => [
        decision.conflictId,
        decision.choice
      ])
    );
    const receiptDecisions = appliedReconciliation.conflicts.map(
      conflict => ({
        conflictId: conflict.conflictId,
        choice: decisionsByConflictId.get(conflict.conflictId)
      })
    );
    if (receiptDecisions.some(decision =>
      !['keep-local', 'use-community'].includes(decision.choice))) {
      fail(
        'PLAN_RECONCILIATION_DECISIONS_REQUIRED',
        'Every reviewed Community conflict needs an exact recorded choice.'
      );
    }
    const mergeResultSha256 =
      reconciliationProjectSha256(replacementProject);
    const receipt = createCommunityServicePlanReconciliationReceipt({
      mode: appliedReconciliation.mode,
      previousPlanRevision:
        proposal._existingRecord.project.planning.source.planRevision,
      candidatePlanRevision: proposal.planRevision,
      previousBaselineProjectionSha256:
        appliedReconciliation.baselineProjectionSha256,
      candidateProjectionSha256:
        appliedReconciliation.candidateProjectionSha256,
      mergeResultSha256,
      previousLocalRevisionId: expectedRevisionId,
      conflictCount: appliedReconciliation.conflictCount,
      decisions: receiptDecisions,
      appliedAt: replacementProject.planning.source.importedAt
    });
    replacementProject =
      bindCommunityServicePlanReconciliationReceipt(
        replacementProject,
        receipt
      );
    if (
      reconciliationProjectSha256(replacementProject)
        !== mergeResultSha256
    ) {
      fail(
        'PLAN_RECONCILIATION_STALE',
        'The durable reconciliation receipt changed the reviewed merge result.'
      );
    }

    let saved;
    try {
      saved = await this.projectStore.save(replacementProject, {
        expectedRevisionId,
        reason: saveReason
      });
    } catch (error) {
      if (error?.code !== 'PROJECT_CONFLICT') throw error;
      fail(
        'LOCAL_PROJECT_CHANGED',
        'The local Planning project changed while the reviewed Community revision was being saved.',
        {
          projectId: proposal.projectId,
          expectedRevisionId,
          currentRevisionId: error.details?.currentRevisionId || null
        }
      );
    }
    if (saved.unchanged === true
      || saved.revisionId === expectedRevisionId) {
      fail(
        'PLAN_REPLACEMENT_STALE',
        'The reviewed Community revision did not create a distinct local Planning revision.',
        { projectId: proposal.projectId }
      );
    }
    return Object.freeze({
      status: resultStatus,
      projectId: proposal.projectId,
      previousRevisionId: expectedRevisionId,
      revisionId: saved.revisionId,
      project: saved.project,
      unchanged: false
    });
  }
}

module.exports = {
  CommunityServicePlanImportCoordinator,
  CommunityServicePlanImportError,
  MAX_COMMUNITY_PLAN_DIFF_ITEMS,
  MAX_COMMUNITY_PLAN_IMPORT_BLOCKERS,
  diffCommunityPlanProjects,
  localProjectId
};
