(function exposeCommunityServicePlanReviewContract() {
  'use strict';

  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const REVISION = /^[a-f0-9]{64}$/u;
  const REVIEW_TOKEN =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  const STATUSES = Object.freeze([
    'draft',
    'ready',
    'archived',
    'cancelled'
  ]);
  const PROPOSAL_STATUSES = Object.freeze([
    'blocked',
    'ready-to-import',
    'already-imported',
    'newer-revision'
  ]);
  const PREPARABLE_BLOCKER_KINDS = Object.freeze({
    LOCAL_SONG_MISSING: 'song',
    LOCAL_SONG_REMOTE_BEHIND: 'song',
    LOCAL_SERMON_MISSING: 'sermon',
    LOCAL_SERMON_REMOTE_BEHIND: 'sermon'
  });

  function exact(value, required, label, optional = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`SyncShow returned an invalid ${label}.`);
    }
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    if (
      required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
      || keys.some(key => !allowed.has(key))
    ) {
      throw new Error(`SyncShow returned unsupported ${label} details.`);
    }
  }

  function text(
    value,
    label,
    maximum,
    { required = true, pattern = null, multiline = false } = {}
  ) {
    if (typeof value !== 'string') {
      throw new Error(`SyncShow returned an invalid ${label}.`);
    }
    const normalized = multiline
      ? value.replace(/\r\n?/gu, '\n').normalize('NFC')
      : value.trim().normalize('NFC');
    const controlPattern = multiline
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
      : /[\u0000-\u001f\u007f]/u;
    if (
      (required && !normalized)
      || normalized.length > maximum
      || controlPattern.test(normalized)
      || (pattern && !pattern.test(normalized))
    ) {
      throw new Error(`SyncShow returned an invalid ${label}.`);
    }
    return normalized;
  }

  function timestamp(value, label) {
    const normalized = String(value || '');
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)
      || !Number.isFinite(Date.parse(normalized))
      || new Date(normalized).toISOString() !== normalized
    ) {
      throw new Error(`SyncShow returned an invalid ${label}.`);
    }
    return normalized;
  }

  function stableReceiptValue(value) {
    if (Array.isArray(value)) return value.map(stableReceiptValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [
        key,
        stableReceiptValue(value[key])
      ])
    );
  }

  // The receipt body is deliberately ASCII-only (hex revisions, bounded IDs,
  // fixed choices, and an ISO timestamp), so the renderer can verify its
  // checksum synchronously without expanding the trusted preload API.
  function sha256Ascii(source) {
    if (
      typeof source !== 'string'
      || [...source].some(character => character.charCodeAt(0) > 0x7f)
    ) {
      throw new Error(
        'SyncShow returned a non-canonical Community reconciliation receipt.'
      );
    }
    const rotateRight = (value, count) =>
      (value >>> count) | (value << (32 - count));
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
      0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
      0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
      0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const state = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const bytes = [...source].map(character => character.charCodeAt(0));
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const highLength = Math.floor(bitLength / 0x100000000);
    const lowLength = bitLength >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8) {
      bytes.push((highLength >>> shift) & 0xff);
    }
    for (let shift = 24; shift >= 0; shift -= 8) {
      bytes.push((lowLength >>> shift) & 0xff);
    }
    const words = new Array(64);
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        const byteOffset = offset + (index * 4);
        words[index] = (
          (bytes[byteOffset] << 24)
          | (bytes[byteOffset + 1] << 16)
          | (bytes[byteOffset + 2] << 8)
          | bytes[byteOffset + 3]
        ) >>> 0;
      }
      for (let index = 16; index < 64; index += 1) {
        const previous = words[index - 15];
        const beforePrevious = words[index - 2];
        const sigmaZero = (
          rotateRight(previous, 7)
          ^ rotateRight(previous, 18)
          ^ (previous >>> 3)
        ) >>> 0;
        const sigmaOne = (
          rotateRight(beforePrevious, 17)
          ^ rotateRight(beforePrevious, 19)
          ^ (beforePrevious >>> 10)
        ) >>> 0;
        words[index] = (
          words[index - 16]
          + sigmaZero
          + words[index - 7]
          + sigmaOne
        ) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = state;
      for (let index = 0; index < 64; index += 1) {
        const sumOne = (
          rotateRight(e, 6)
          ^ rotateRight(e, 11)
          ^ rotateRight(e, 25)
        ) >>> 0;
        const choose = ((e & f) ^ (~e & g)) >>> 0;
        const temporaryOne = (
          h + sumOne + choose + constants[index] + words[index]
        ) >>> 0;
        const sumZero = (
          rotateRight(a, 2)
          ^ rotateRight(a, 13)
          ^ rotateRight(a, 22)
        ) >>> 0;
        const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const temporaryTwo = (sumZero + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temporaryOne) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temporaryOne + temporaryTwo) >>> 0;
      }
      state[0] = (state[0] + a) >>> 0;
      state[1] = (state[1] + b) >>> 0;
      state[2] = (state[2] + c) >>> 0;
      state[3] = (state[3] + d) >>> 0;
      state[4] = (state[4] + e) >>> 0;
      state[5] = (state[5] + f) >>> 0;
      state[6] = (state[6] + g) >>> 0;
      state[7] = (state[7] + h) >>> 0;
    }
    return state.map(word =>
      word.toString(16).padStart(8, '0')).join('');
  }

  function reconciliationReceiptSha256(receipt) {
    const body = {
      schemaVersion: receipt.schemaVersion,
      kind: receipt.kind,
      mode: receipt.mode,
      previousPlanRevision: receipt.previousPlanRevision,
      candidatePlanRevision: receipt.candidatePlanRevision,
      previousBaselineProjectionSha256:
        receipt.previousBaselineProjectionSha256,
      candidateProjectionSha256: receipt.candidateProjectionSha256,
      mergeResultSha256: receipt.mergeResultSha256,
      previousLocalRevisionId: receipt.previousLocalRevisionId,
      conflictCount: receipt.conflictCount,
      decisions: receipt.decisions,
      appliedAt: receipt.appliedAt
    };
    return sha256Ascii(JSON.stringify(stableReceiptValue(body)));
  }

  function connection(value) {
    exact(
      value,
      ['id', 'serverId', 'serverName'],
      'Community service-plan connection'
    );
    return Object.freeze({
      id: text(value.id, 'Community connection ID', 100, { pattern: ID }),
      serverId: text(
        value.serverId,
        'Community server ID',
        128,
        { pattern: ID }
      ),
      serverName: text(value.serverName, 'Community server name', 200)
    });
  }

  function summary(value) {
    exact(
      value,
      [
        'syncId',
        'syncVersion',
        'revision',
        'status',
        'title',
        'serviceDate',
        'startTime',
        'changedAt'
      ],
      'Community service-plan summary'
    );
    if (
      !Number.isSafeInteger(value.syncVersion)
      || value.syncVersion < 1
      || !STATUSES.includes(value.status)
    ) {
      throw new Error(
        'SyncShow returned an invalid Community service-plan summary.'
      );
    }
    return Object.freeze({
      syncId: text(value.syncId, 'service-plan sync ID', 128, {
        pattern: ID
      }),
      syncVersion: value.syncVersion,
      revision: text(value.revision, 'service-plan revision', 64, {
        pattern: REVISION
      }),
      status: value.status,
      title: text(value.title, 'service-plan title', 200),
      serviceDate: text(value.serviceDate, 'service-plan date', 10, {
        pattern: /^\d{4}-\d{2}-\d{2}$/u
      }),
      startTime: text(value.startTime, 'service-plan start time', 5, {
        pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/u
      }),
      changedAt: timestamp(value.changedAt, 'service-plan change time')
    });
  }

  function normalizePage(value) {
    exact(
      value,
      ['connection', 'items', 'nextCursor', 'hasMore'],
      'Community service-plan page'
    );
    if (
      !Array.isArray(value.items)
      || value.items.length > 50
      || typeof value.hasMore !== 'boolean'
    ) {
      throw new Error('SyncShow returned an invalid service-plan page.');
    }
    const items = value.items.map(summary);
    if (new Set(items.map(item => item.syncId)).size !== items.length) {
      throw new Error('SyncShow returned duplicate service-plan summaries.');
    }
    const nextCursor = value.nextCursor === null
      ? null
      : text(value.nextCursor, 'service-plan cursor', 2048);
    if (value.hasMore !== (nextCursor !== null)) {
      throw new Error('SyncShow returned an inconsistent service-plan cursor.');
    }
    return Object.freeze({
      connection: connection(value.connection),
      items: Object.freeze(items),
      nextCursor,
      hasMore: value.hasMore
    });
  }

  function range(value) {
    exact(
      value,
      ['schemaVersion', 'bookId', 'start', 'end'],
      'service-plan Scripture range'
    );
    exact(value.start, ['chapter', 'verse'], 'Scripture range start');
    exact(value.end, ['chapter', 'verse'], 'Scripture range end');
    const numbers = [
      value.start.chapter,
      value.start.verse,
      value.end.chapter,
      value.end.verse
    ];
    if (
      value.schemaVersion !== 1
      || !ID.test(String(value.bookId || ''))
      || numbers.some(number =>
        !Number.isSafeInteger(number) || number < 1 || number > 999)
      || value.end.chapter < value.start.chapter
      || (
        value.end.chapter === value.start.chapter
        && value.end.verse < value.start.verse
      )
    ) {
      throw new Error('SyncShow returned an invalid Scripture range.');
    }
    return Object.freeze({
      schemaVersion: 1,
      bookId: String(value.bookId),
      start: Object.freeze({ ...value.start }),
      end: Object.freeze({ ...value.end })
    });
  }

  function sermonReading(value) {
    if (value === null) return null;
    exact(
      value,
      ['sermonEntryId', 'referenceId'],
      'service-plan sermon reading'
    );
    return Object.freeze({
      sermonEntryId: text(
        value.sermonEntryId,
        'service-plan sermon-reading target',
        128,
        { pattern: ID }
      ),
      referenceId: text(
        value.referenceId,
        'service-plan sermon-reading reference',
        128,
        { pattern: ID }
      )
    });
  }

  function entry(value, schemaVersion) {
    const kind = String(value?.kind || '');
    const common = ['id', 'kind', 'title'];
    const fields = kind === 'section'
      ? common
      : kind === 'scripture'
        ? [
            ...common,
            'range',
            'translationId',
            ...(schemaVersion === 2 ? ['sermonReading'] : [])
          ]
        : ['song', 'sermon'].includes(kind)
          ? [
              ...common,
              'syncId',
              'expectedRevision',
              'expectedSyncVersion'
            ]
          : null;
    if (!fields) throw new Error('SyncShow returned an unsupported plan entry.');
    exact(value, fields, 'Community service-plan entry');
    const result = {
      id: text(value.id, 'service-plan entry ID', 128, { pattern: ID }),
      kind,
      title: text(value.title, 'service-plan entry title', 200)
    };
    if (kind === 'scripture') {
      result.range = range(value.range);
      result.translationId = text(
        value.translationId,
        'service-plan translation',
        32,
        { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u }
      );
      if (schemaVersion === 2) {
        result.sermonReading = sermonReading(value.sermonReading);
      }
    } else if (kind !== 'section') {
      if (
        !Number.isSafeInteger(value.expectedSyncVersion)
        || value.expectedSyncVersion < 1
      ) {
        throw new Error('SyncShow returned an invalid resource version.');
      }
      result.syncId = text(value.syncId, 'resource sync ID', 128, {
        pattern: ID
      });
      result.expectedRevision = text(
        value.expectedRevision,
        'resource revision',
        kind === 'sermon' ? 64 : 256,
        {
          pattern: kind === 'sermon'
            ? REVISION
            : /^[A-Za-z0-9][A-Za-z0-9._:"/-]{0,255}$/u
        }
      );
      result.expectedSyncVersion = value.expectedSyncVersion;
    }
    return Object.freeze(result);
  }

  function blocker(value, entryIds) {
    exact(
      value,
      ['entryId', 'kind', 'code', 'message'],
      'service-plan blocker'
    );
    const entryId = value.entryId === null
      ? null
      : text(value.entryId, 'blocker entry ID', 128, { pattern: ID });
    if (entryId !== null && !entryIds.has(entryId)) {
      throw new Error('SyncShow returned a blocker for an unknown entry.');
    }
    return Object.freeze({
      entryId,
      kind: text(value.kind, 'blocker kind', 32, {
        pattern: /^[a-z][a-z-]{0,31}$/u
      }),
      code: text(value.code, 'blocker code', 80, {
        pattern: /^[A-Z][A-Z0-9_]{2,79}$/u
      }),
      message: text(value.message, 'blocker message', 1000)
    });
  }

  function preparationBlockerProjection({
    blockers,
    blockersTruncated,
    blockerCount,
    entries
  }) {
    if (
      blockersTruncated
      || blockerCount !== blockers.length
    ) {
      return null;
    }
    const entryById = new Map(entries.map(item => [item.id, item]));
    const dependencies = new Map();
    for (const item of blockers) {
      const kind = PREPARABLE_BLOCKER_KINDS[item.code];
      const planEntry = entryById.get(item.entryId);
      if (
        !kind
        || item.kind !== kind
        || planEntry?.kind !== kind
      ) {
        return null;
      }
      const key = `${kind}\u0000${planEntry.syncId}`;
      const existing = dependencies.get(key);
      if (
        existing
        && (
          existing.expectedSyncVersion !== planEntry.expectedSyncVersion
          || existing.expectedRevision !== planEntry.expectedRevision
        )
      ) {
        return null;
      }
      if (!existing) {
        dependencies.set(key, {
          kind,
          expectedSyncVersion: planEntry.expectedSyncVersion,
          expectedRevision: planEntry.expectedRevision
        });
      }
    }
    const projected = [...dependencies.values()];
    return Object.freeze({
      itemCount: projected.length,
      songCount: projected.filter(item => item.kind === 'song').length,
      sermonCount: projected.filter(item => item.kind === 'sermon').length
    });
  }

  function preparation(value, {
    proposalStatus,
    remoteStatus,
    blockerCount,
    blockersTruncated,
    blockers,
    entries,
    reviewToken,
    existingProject
  }) {
    if (value === null) return null;
    exact(
      value,
      ['token', 'expiresAt', 'itemCount', 'songCount', 'sermonCount'],
      'service-plan item preparation'
    );
    const counts = [
      value.itemCount,
      value.songCount,
      value.sermonCount
    ];
    if (
      counts.some(count =>
        !Number.isSafeInteger(count) || count < 0 || count > 100)
      || value.itemCount < 1
      || value.songCount + value.sermonCount !== value.itemCount
      || value.itemCount > blockerCount
      || proposalStatus !== 'blocked'
      || remoteStatus !== 'ready'
      || reviewToken !== null
      || existingProject
    ) {
      throw new Error(
        'SyncShow returned inconsistent service-plan preparation authority.'
      );
    }
    const projected = preparationBlockerProjection({
      blockers,
      blockersTruncated,
      blockerCount,
      entries
    });
    if (
      !projected
      || projected.itemCount !== value.itemCount
      || projected.songCount !== value.songCount
      || projected.sermonCount !== value.sermonCount
    ) {
      throw new Error(
        'SyncShow returned inconsistent service-plan preparation authority.'
      );
    }
    return Object.freeze({
      token: text(value.token, 'service-plan preparation token', 36, {
        pattern: REVIEW_TOKEN
      }),
      expiresAt: timestamp(
        value.expiresAt,
        'service-plan preparation expiry'
      ),
      itemCount: value.itemCount,
      songCount: value.songCount,
      sermonCount: value.sermonCount
    });
  }

  function diffSide(value, label) {
    if (value === null) return null;
    exact(value, ['kind', 'title'], `${label} difference item`);
    return Object.freeze({
      kind: text(value.kind, `${label} difference kind`, 32),
      title: text(value.title, `${label} difference title`, 200)
    });
  }

  function diff(value, planRevision) {
    exact(
      value,
      [
        'fromRevision',
        'toRevision',
        'addedCount',
        'removedCount',
        'changedCount',
        'unchangedCount',
        'metadataChanges',
        'changes',
        'truncated'
      ],
      'service-plan difference'
    );
    exact(
      value.metadataChanges,
      [
        'titleChanged',
        'serviceDateChanged',
        'startTimeChanged',
        'teamNotesChanged'
      ],
      'service-plan metadata difference'
    );
    const counts = [
      value.addedCount,
      value.removedCount,
      value.changedCount,
      value.unchangedCount
    ];
    if (
      value.toRevision !== planRevision
      || !REVISION.test(value.fromRevision)
      || counts.some(count =>
        !Number.isSafeInteger(count) || count < 0 || count > 500)
      || Object.values(value.metadataChanges).some(flag =>
        typeof flag !== 'boolean')
      || !Array.isArray(value.changes)
      || value.changes.length > 50
      || typeof value.truncated !== 'boolean'
    ) {
      throw new Error('SyncShow returned an invalid service-plan difference.');
    }
    const changes = value.changes.map(change => {
      exact(
        change,
        ['itemId', 'change', 'before', 'after'],
        'service-plan item difference'
      );
      if (!['added', 'removed', 'changed'].includes(change.change)) {
        throw new Error('SyncShow returned an invalid item difference.');
      }
      return Object.freeze({
        itemId: text(change.itemId, 'difference item ID', 128, {
          pattern: ID
        }),
        change: change.change,
        before: diffSide(change.before, 'prior'),
        after: diffSide(change.after, 'new')
      });
    });
    return Object.freeze({
      fromRevision: value.fromRevision,
      toRevision: value.toRevision,
      addedCount: value.addedCount,
      removedCount: value.removedCount,
      changedCount: value.changedCount,
      unchangedCount: value.unchangedCount,
      metadataChanges: Object.freeze({ ...value.metadataChanges }),
      changes: Object.freeze(changes),
      truncated: value.truncated
    });
  }

  function optionalRevision(value, label) {
    return value === null
      ? null
      : text(value, label, 64, { pattern: REVISION });
  }

  function reconciliationSide(value, expectedChoice, label) {
    exact(
      value,
      ['choice', 'summary'],
      `${label} service-plan reconciliation choice`
    );
    if (value.choice !== expectedChoice) {
      throw new Error(
        'SyncShow returned an invalid service-plan reconciliation choice.'
      );
    }
    return Object.freeze({
      choice: expectedChoice,
      summary: text(
        value.summary,
        `${label} reconciliation summary`,
        1000,
        { multiline: true }
      )
    });
  }

  function reconciliationConflict(value) {
    exact(
      value,
      [
        'conflictId',
        'kind',
        'itemId',
        'entryId',
        'title',
        'local',
        'community'
      ],
      'service-plan reconciliation conflict'
    );
    const nullableId = (candidate, label) => candidate === null
      ? null
      : text(candidate, label, 128, { pattern: ID });
    return Object.freeze({
      conflictId: text(
        value.conflictId,
        'service-plan reconciliation conflict ID',
        128,
        { pattern: ID }
      ),
      kind: text(
        value.kind,
        'service-plan reconciliation conflict kind',
        100,
        { pattern: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u }
      ),
      itemId: nullableId(
        value.itemId,
        'service-plan reconciliation item ID'
      ),
      entryId: nullableId(
        value.entryId,
        'service-plan reconciliation entry ID'
      ),
      title: text(
        value.title,
        'service-plan reconciliation conflict title',
        200
      ),
      local: reconciliationSide(value.local, 'keep-local', 'local'),
      community: reconciliationSide(
        value.community,
        'use-community',
        'Community'
      )
    });
  }

  function reconciliation(value, planRevision, priorPlanRevision) {
    exact(
      value,
      [
        'schemaVersion',
        'mode',
        'applicable',
        'baselinePlanRevision',
        'baselineProjectionSha256',
        'candidatePlanRevision',
        'candidateProjectionSha256',
        'mergeResultSha256',
        'preservedLocalItemCount',
        'appliedCommunityItemCount',
        'autoMergedItemCount',
        'conflictCount',
        'conflictsTruncated',
        'conflicts'
      ],
      'service-plan reconciliation'
    );
    const mode = String(value.mode || '');
    const counts = [
      value.preservedLocalItemCount,
      value.appliedCommunityItemCount,
      value.autoMergedItemCount,
      value.conflictCount
    ];
    if (
      value.schemaVersion !== 1
      || !['three-way', 'legacy-full-replace'].includes(mode)
      || typeof value.applicable !== 'boolean'
      || value.baselinePlanRevision !== priorPlanRevision
      || value.candidatePlanRevision !== planRevision
      || !REVISION.test(String(value.candidateProjectionSha256 || ''))
      || counts.some(count =>
        !Number.isSafeInteger(count) || count < 0 || count > 5000)
      || typeof value.conflictsTruncated !== 'boolean'
      || !Array.isArray(value.conflicts)
      || value.conflicts.length > 500
    ) {
      throw new Error('SyncShow returned an invalid service-plan reconciliation.');
    }
    const baselineProjectionSha256 = optionalRevision(
      value.baselineProjectionSha256,
      'service-plan reconciliation baseline projection'
    );
    const mergeResultSha256 = optionalRevision(
      value.mergeResultSha256,
      'service-plan reconciliation result'
    );
    const conflicts = value.conflicts.map(reconciliationConflict);
    if (
      new Set(conflicts.map(conflict => conflict.conflictId)).size
        !== conflicts.length
      || (
        value.conflictsTruncated
          ? value.conflictCount <= conflicts.length
          : value.conflictCount !== conflicts.length
      )
    ) {
      throw new Error(
        'SyncShow returned an inconsistent service-plan reconciliation.'
      );
    }
    if (
      mode === 'three-way'
        ? (
            baselineProjectionSha256 === null
            || (
              value.applicable
                ? (
                    value.conflictsTruncated
                    || mergeResultSha256 === null
                  )
                : (
                    !value.conflictsTruncated
                    || mergeResultSha256 !== null
                  )
            )
          )
        : (
            value.applicable !== true
            || baselineProjectionSha256 !== null
            || mergeResultSha256 === null
            || value.preservedLocalItemCount !== 0
            || value.autoMergedItemCount !== 0
            || value.conflictCount !== 1
            || conflicts.length !== 1
            || value.conflictsTruncated
          )
    ) {
      throw new Error(
        'SyncShow returned an inconsistent service-plan reconciliation mode.'
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      mode,
      applicable: value.applicable,
      baselinePlanRevision: value.baselinePlanRevision,
      baselineProjectionSha256,
      candidatePlanRevision: value.candidatePlanRevision,
      candidateProjectionSha256: value.candidateProjectionSha256,
      mergeResultSha256,
      preservedLocalItemCount: value.preservedLocalItemCount,
      appliedCommunityItemCount: value.appliedCommunityItemCount,
      autoMergedItemCount: value.autoMergedItemCount,
      conflictCount: value.conflictCount,
      conflictsTruncated: value.conflictsTruncated,
      conflicts: Object.freeze(conflicts)
    });
  }

  function normalizeReview(value) {
    exact(
      value,
      [
        'connection',
        'servicePlan',
        'proposal',
        'reviewToken',
        'reviewExpiresAt',
        'replacementToken',
        'replacementExpiresAt',
        'preparation'
      ],
      'Community service-plan review'
    );
    exact(
      value.servicePlan,
      [
        'syncId',
        'syncVersion',
        'revision',
        'status',
        'changedAt',
        'plan'
      ],
      'Community service plan'
    );
    exact(
      value.servicePlan.plan,
      [
        'schemaVersion',
        'id',
        'title',
        'serviceDate',
        'startTime',
        'teamNotes',
        'entries'
      ],
      'Community service-plan document'
    );
    if (![1, 2].includes(value.servicePlan.plan.schemaVersion)) {
      throw new Error(
        'SyncShow returned an unsupported Community service-plan document.'
      );
    }
    const schemaVersion = value.servicePlan.plan.schemaVersion;
    const planSummary = summary({
      syncId: value.servicePlan.syncId,
      syncVersion: value.servicePlan.syncVersion,
      revision: value.servicePlan.revision,
      status: value.servicePlan.status,
      title: value.servicePlan.plan.title,
      serviceDate: value.servicePlan.plan.serviceDate,
      startTime: value.servicePlan.plan.startTime,
      changedAt: value.servicePlan.changedAt
    });
    if (
      value.servicePlan.plan.id !== planSummary.syncId
      || !Array.isArray(value.servicePlan.plan.entries)
      || value.servicePlan.plan.entries.length < 1
      || value.servicePlan.plan.entries.length > 500
    ) {
      throw new Error('SyncShow returned an invalid Community service plan.');
    }
    const entries = value.servicePlan.plan.entries.map(item =>
      entry(item, schemaVersion));
    const entryIds = new Set(entries.map(item => item.id));
    if (entryIds.size !== entries.length) {
      throw new Error('SyncShow returned duplicate service-plan entries.');
    }
    if (schemaVersion === 2) {
      const entryById = new Map(
        entries.map((item, index) => [item.id, { item, index }])
      );
      const readingTargets = new Set();
      for (const [index, item] of entries.entries()) {
        if (item.kind !== 'scripture' || item.sermonReading === null) {
          continue;
        }
        const target = entryById.get(item.sermonReading.sermonEntryId);
        const verseCount = item.range.end.verse - item.range.start.verse + 1;
        if (
          !target
          || target.item.kind !== 'sermon'
          || target.index <= index
          || readingTargets.has(target.item.id)
          || item.range.start.chapter !== item.range.end.chapter
          || verseCount < 1
          || verseCount > 8
          || item.translationId !== item.translationId.toUpperCase()
        ) {
          throw new Error(
            'SyncShow returned an invalid service-plan sermon reading.'
          );
        }
        readingTargets.add(target.item.id);
      }
    }

    exact(
      value.proposal,
      [
        'status',
        'projectId',
        'planId',
        'planRevision',
        'remoteStatus',
        'blockerCount',
        'blockersTruncated',
        'blockers',
        'diff',
        'existingProject'
      ],
      'service-plan import proposal',
      ['revisionId', 'reconciliation']
    );
    const proposalStatus = String(value.proposal.status || '');
    if (
      !PROPOSAL_STATUSES.includes(proposalStatus)
      || value.proposal.planId !== planSummary.syncId
      || value.proposal.planRevision !== planSummary.revision
      || value.proposal.remoteStatus !== planSummary.status
      || typeof value.proposal.existingProject !== 'boolean'
      || typeof value.proposal.blockersTruncated !== 'boolean'
      || !Number.isSafeInteger(value.proposal.blockerCount)
      || value.proposal.blockerCount < 0
      || value.proposal.blockerCount > 500
      || !Array.isArray(value.proposal.blockers)
      || value.proposal.blockers.length > 100
      || value.proposal.blockers.length > value.proposal.blockerCount
    ) {
      throw new Error('SyncShow returned an inconsistent import proposal.');
    }
    const blockers = value.proposal.blockers.map(item =>
      blocker(item, entryIds));
    const revisionId = value.proposal.revisionId === undefined
      ? null
      : text(value.proposal.revisionId, 'local project revision', 64, {
          pattern: REVISION
        });
    const proposal = {
      status: proposalStatus,
      projectId: text(value.proposal.projectId, 'local project ID', 128, {
        pattern: ID
      }),
      planId: planSummary.syncId,
      planRevision: planSummary.revision,
      remoteStatus: planSummary.status,
      blockerCount: value.proposal.blockerCount,
      blockersTruncated: value.proposal.blockersTruncated,
      blockers: Object.freeze(blockers),
      diff: proposalStatus === 'newer-revision'
        ? diff(value.proposal.diff, planSummary.revision)
        : null,
      reconciliation: proposalStatus === 'newer-revision'
        ? reconciliation(
            value.proposal.reconciliation,
            planSummary.revision,
            value.proposal.diff?.fromRevision
          )
        : null,
      existingProject: value.proposal.existingProject,
      ...(revisionId ? { revisionId } : {})
    };
    if (
      proposalStatus !== 'newer-revision'
      && value.proposal.diff !== null
    ) {
      throw new Error('SyncShow returned an unexpected plan difference.');
    }
    if (
      proposalStatus === 'newer-revision'
        ? !Object.prototype.hasOwnProperty.call(
            value.proposal,
            'reconciliation'
          )
        : Object.prototype.hasOwnProperty.call(
            value.proposal,
            'reconciliation'
          )
    ) {
      throw new Error(
        'SyncShow returned unexpected service-plan reconciliation details.'
      );
    }

    const reviewToken = value.reviewToken === null
      ? null
      : text(value.reviewToken, 'service-plan review token', 36, {
          pattern: REVIEW_TOKEN
        });
    const reviewExpiresAt = value.reviewExpiresAt === null
      ? null
      : timestamp(value.reviewExpiresAt, 'service-plan review expiry');
    const replacementToken = value.replacementToken === null
      ? null
      : text(
          value.replacementToken,
          'service-plan replacement token',
          36,
          { pattern: REVIEW_TOKEN }
        );
    const replacementExpiresAt = value.replacementExpiresAt === null
      ? null
      : timestamp(
          value.replacementExpiresAt,
          'service-plan replacement expiry'
        );
    const importable = ['ready-to-import', 'already-imported']
      .includes(proposalStatus);
    const replaceable = proposalStatus === 'newer-revision'
      && proposal.reconciliation.applicable
      && !proposal.reconciliation.conflictsTruncated;
    if (
      (importable && (!reviewToken || !reviewExpiresAt))
      || (!importable && (reviewToken !== null || reviewExpiresAt !== null))
      || (
        replaceable
          ? (!replacementToken || !replacementExpiresAt)
          : (
              replacementToken !== null
              || replacementExpiresAt !== null
            )
      )
      || (proposalStatus === 'blocked'
        && (proposal.blockerCount < 1 || blockers.length < 1))
      || (proposalStatus !== 'blocked'
        && (proposal.blockerCount !== 0 || blockers.length !== 0))
      || (proposalStatus === 'ready-to-import'
        && proposal.existingProject)
      || (['already-imported', 'newer-revision'].includes(proposalStatus)
        && (!proposal.existingProject || !revisionId))
      || (['blocked', 'ready-to-import'].includes(proposalStatus)
        && revisionId !== null)
      || (proposalStatus !== 'blocked' && planSummary.status !== 'ready')
      || (
        value.proposal.blockersTruncated
          ? proposal.blockerCount <= blockers.length
          : proposal.blockerCount !== blockers.length
      )
    ) {
      throw new Error('SyncShow returned inconsistent review authority.');
    }
    const itemPreparation = preparation(value.preparation, {
      proposalStatus,
      remoteStatus: planSummary.status,
      blockerCount: proposal.blockerCount,
      blockersTruncated: proposal.blockersTruncated,
      blockers,
      entries,
      reviewToken,
      existingProject: proposal.existingProject
    });
    return Object.freeze({
      connection: connection(value.connection),
      servicePlan: Object.freeze({
        syncId: planSummary.syncId,
        syncVersion: planSummary.syncVersion,
        revision: planSummary.revision,
        status: planSummary.status,
        changedAt: planSummary.changedAt,
        plan: Object.freeze({
          schemaVersion,
          id: planSummary.syncId,
          title: planSummary.title,
          serviceDate: planSummary.serviceDate,
          startTime: planSummary.startTime,
          teamNotes: text(
            value.servicePlan.plan.teamNotes,
            'service-plan team notes',
            4000,
            { required: false, multiline: true }
          ),
          entries: Object.freeze(entries)
        })
      }),
      proposal: Object.freeze(proposal),
      reviewToken,
      reviewExpiresAt,
      replacementToken,
      replacementExpiresAt,
      preparation: itemPreparation
    });
  }

  function validateProjectReconciliationBaseline(
    value,
    sourceRevision,
    { requireLatest = false } = {}
  ) {
    exact(
      value,
      [
        'schemaVersion',
        'kind',
        'planRevision',
        'projectionSha256',
        'channelContractSha256',
        'metadata',
        'entries',
        'containers'
      ],
      'Community service-plan reconciliation baseline'
    );
    const schemaVersion = value.schemaVersion;
    if (
      ![1, 2].includes(schemaVersion)
      || (requireLatest && schemaVersion !== 2)
      || value.kind !== 'syncshow-community-service-plan-baseline'
      || value.planRevision !== sourceRevision
      || !REVISION.test(String(value.projectionSha256 || ''))
      || !REVISION.test(String(value.channelContractSha256 || ''))
      || !Array.isArray(value.entries)
      || value.entries.length < 1
      || value.entries.length > 500
      || !Array.isArray(value.containers)
      || value.containers.length < 1
      || value.containers.length > 501
    ) {
      throw new Error(
        'SyncShow returned an invalid Community reconciliation baseline.'
      );
    }
    exact(
      value.metadata,
      ['title', 'serviceDate', 'startTime', 'teamNotes'],
      'Community service-plan baseline metadata'
    );
    text(value.metadata.title, 'Community baseline title', 200);
    text(
      value.metadata.serviceDate,
      'Community baseline service date',
      10,
      { pattern: /^\d{4}-\d{2}-\d{2}$/u }
    );
    text(
      value.metadata.startTime,
      'Community baseline start time',
      5,
      { pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/u }
    );
    text(
      value.metadata.teamNotes,
      'Community baseline team notes',
      4000,
      { required: false, multiline: true }
    );

    const itemKindByEntryKind = Object.freeze({
      section: 'group',
      song: 'song',
      scripture: 'bible',
      sermon: 'group'
    });
    const entries = value.entries.map((entryValue, index) => {
      exact(
        entryValue,
        [
          'entryId',
          'itemId',
          'entryKind',
          'itemKind',
          'sourceSha256',
          'contentSha256',
          'stateSha256',
          ...(schemaVersion === 2
            ? [
                'contentSpecSha256',
                'relationshipSha256',
                'dependentStateSha256',
                'titleSha256'
              ]
            : [])
        ],
        `Community service-plan baseline entry ${index + 1}`
      );
      const entryId = text(
        entryValue.entryId,
        `Community baseline entry ${index + 1} ID`,
        128,
        { pattern: ID }
      );
      const itemId = text(
        entryValue.itemId,
        `Community baseline item ${index + 1} ID`,
        128,
        { pattern: ID }
      );
      const entryKind = text(
        entryValue.entryKind,
        `Community baseline entry ${index + 1} kind`,
        20
      );
      const itemKind = text(
        entryValue.itemKind,
        `Community baseline item ${index + 1} kind`,
        20
      );
      if (itemKindByEntryKind[entryKind] !== itemKind) {
        throw new Error(
          'SyncShow returned an inconsistent Community reconciliation baseline entry.'
        );
      }
      for (const hashKey of [
        'sourceSha256',
        'contentSha256',
        'stateSha256',
        ...(schemaVersion === 2
          ? [
              'contentSpecSha256',
              'relationshipSha256',
              'dependentStateSha256',
              'titleSha256'
            ]
          : [])
      ]) {
        text(
          entryValue[hashKey],
          `Community baseline entry ${index + 1} ${hashKey}`,
          64,
          { pattern: REVISION }
        );
      }
      return { entryId, itemId, itemKind };
    });
    const entryIds = new Set(entries.map(entryValue => entryValue.entryId));
    const itemIds = new Set(entries.map(entryValue => entryValue.itemId));
    if (
      entryIds.size !== entries.length
      || itemIds.size !== entries.length
    ) {
      throw new Error(
        'SyncShow returned duplicate Community reconciliation baseline entries.'
      );
    }
    const groupItemIds = new Set(
      entries
        .filter(entryValue => entryValue.itemKind === 'group')
        .map(entryValue => entryValue.itemId)
    );
    const containers = value.containers.map((container, index) => {
      exact(
        container,
        ['parentItemId', 'childItemIds'],
        `Community service-plan baseline container ${index + 1}`
      );
      const parentItemId = container.parentItemId === null
        ? null
        : text(
            container.parentItemId,
            `Community baseline container ${index + 1} parent`,
            128,
            { pattern: ID }
          );
      if (parentItemId !== null && !groupItemIds.has(parentItemId)) {
        throw new Error(
          'SyncShow returned an invalid Community reconciliation baseline container.'
        );
      }
      if (
        !Array.isArray(container.childItemIds)
        || container.childItemIds.length > 500
      ) {
        throw new Error(
          'SyncShow returned an invalid Community reconciliation baseline container.'
        );
      }
      const childItemIds = container.childItemIds.map(
        (itemId, childIndex) => text(
          itemId,
          `Community baseline container ${index + 1} child ${
            childIndex + 1
          }`,
          128,
          { pattern: ID }
        )
      );
      if (
        new Set(childItemIds).size !== childItemIds.length
        || childItemIds.some(itemId => !itemIds.has(itemId))
      ) {
        throw new Error(
          'SyncShow returned an invalid Community reconciliation baseline container.'
        );
      }
      return { parentItemId, childItemIds };
    });
    const parentIds = containers.map(container =>
      container.parentItemId === null
        ? '\u0000root'
        : container.parentItemId);
    const placedItemIds = containers.flatMap(container =>
      container.childItemIds);
    if (
      new Set(parentIds).size !== parentIds.length
      || !parentIds.includes('\u0000root')
      || placedItemIds.length !== entries.length
      || new Set(placedItemIds).size !== entries.length
      || placedItemIds.some(itemId => !itemIds.has(itemId))
    ) {
      throw new Error(
        'SyncShow returned an inconsistent Community reconciliation baseline layout.'
      );
    }
  }

  function validateProjectReconciliationReceipt(
    value,
    source,
    baseline
  ) {
    exact(
      value,
      [
        'schemaVersion',
        'kind',
        'mode',
        'previousPlanRevision',
        'candidatePlanRevision',
        'previousBaselineProjectionSha256',
        'candidateProjectionSha256',
        'mergeResultSha256',
        'previousLocalRevisionId',
        'conflictCount',
        'decisions',
        'appliedAt',
        'receiptSha256'
      ],
      'Community reconciliation receipt'
    );
    if (
      value.schemaVersion !== 1
      || value.kind
        !== 'community-service-plan-reconciliation-receipt'
      || !['three-way', 'legacy-full-replace'].includes(value.mode)
      || !Number.isSafeInteger(value.conflictCount)
      || value.conflictCount < 0
      || value.conflictCount > 500
      || !Array.isArray(value.decisions)
      || value.decisions.length !== value.conflictCount
      || value.candidatePlanRevision !== source.planRevision
      || value.candidateProjectionSha256 !== baseline.projectionSha256
      || value.appliedAt !== source.importedAt
      || (
        value.mode === 'three-way'
        && value.previousBaselineProjectionSha256 === null
      )
    ) {
      throw new Error(
        'SyncShow returned an inconsistent Community reconciliation receipt.'
      );
    }
    for (const field of [
      'previousPlanRevision',
      'candidatePlanRevision',
      'candidateProjectionSha256',
      'mergeResultSha256',
      'previousLocalRevisionId',
      'receiptSha256'
    ]) {
      text(value[field], `Community receipt ${field}`, 64, {
        pattern: REVISION
      });
    }
    if (value.previousBaselineProjectionSha256 !== null) {
      text(
        value.previousBaselineProjectionSha256,
        'Community receipt previous baseline',
        64,
        { pattern: REVISION }
      );
    }
    timestamp(value.appliedAt, 'Community receipt applied time');
    const conflictIds = new Set();
    value.decisions.forEach((decision, index) => {
      exact(
        decision,
        ['conflictId', 'choice'],
        `Community reconciliation receipt decision ${index + 1}`
      );
      const conflictId = text(
        decision.conflictId,
        `Community receipt decision ${index + 1} conflict ID`,
        128,
        { pattern: ID }
      );
      if (
        conflictIds.has(conflictId)
        || !['keep-local', 'use-community'].includes(decision.choice)
      ) {
        throw new Error(
          'SyncShow returned an invalid Community reconciliation receipt decision.'
        );
      }
      conflictIds.add(conflictId);
    });
    if (
      value.mode === 'legacy-full-replace'
      && (
        value.decisions.length !== 1
        || value.decisions[0].choice !== 'use-community'
      )
    ) {
      throw new Error(
        'SyncShow returned an invalid legacy reconciliation receipt.'
      );
    }
    if (reconciliationReceiptSha256(value) !== value.receiptSha256) {
      throw new Error(
        'SyncShow returned a Community reconciliation receipt with an invalid checksum.'
      );
    }
  }

  function normalizeImportResult(
    value,
    review,
    { allowReconciledPlanning = false } = {}
  ) {
    exact(
      value,
      [
        'project',
        'revisionId',
        'unchanged',
        'recovery',
        'readiness',
        'importStatus'
      ],
      'Community service-plan import result'
    );
    if (
      !review
      || !review.proposal
      || !['imported', 'already-imported'].includes(value.importStatus)
      || typeof value.unchanged !== 'boolean'
      || !REVISION.test(String(value.revisionId || ''))
      || value.recovery !== null
      || !value.readiness
      || typeof value.readiness !== 'object'
      || Array.isArray(value.readiness)
    ) {
      throw new Error('SyncShow returned an invalid service-plan import result.');
    }
    exact(
      value.project,
      [
        'schemaVersion',
        'kind',
        'id',
        'title',
        'serviceDate',
        'preferredProfileId',
        'channelIds',
        'channels',
        'rootItemIds',
        'items',
        'resources',
        'assets',
        'presetPack',
        'planning',
        'revision',
        'createdAt',
        'updatedAt'
      ],
      'imported service project'
    );
    exact(
      value.project.planning,
      [
        'schemaVersion',
        'status',
        'startTime',
        'teamNotes',
        'source'
      ],
      'imported service planning',
      [
        'readinessWaivers',
        'reconciliationBaseline',
        'lastReconciliationReceipt',
        'localCollisionBoundaryItemIds'
      ]
    );
    exact(
      value.project.planning.source,
      ['kind', 'serverId', 'planId', 'planRevision', 'importedAt'],
      'imported Community service-plan source'
    );
    const source = value.project.planning.source;
    const planningSchemaVersion = value.project.planning.schemaVersion;
    const hasReconciliationBaseline = Object.prototype.hasOwnProperty.call(
      value.project.planning,
      'reconciliationBaseline'
    );
    const hasReconciliationReceipt = Object.prototype.hasOwnProperty.call(
      value.project.planning,
      'lastReconciliationReceipt'
    );
    const hasLocalCollisionBoundaries =
      Object.prototype.hasOwnProperty.call(
        value.project.planning,
        'localCollisionBoundaryItemIds'
      );
    if (
      (planningSchemaVersion === 3 && !hasReconciliationBaseline)
      || (
        planningSchemaVersion === 2
        && (
          hasReconciliationBaseline
          || hasReconciliationReceipt
          || hasLocalCollisionBoundaries
        )
      )
    ) {
      throw new Error(
        'SyncShow returned inconsistent Community reconciliation metadata.'
      );
    }
    if (planningSchemaVersion === 3) {
      validateProjectReconciliationBaseline(
        value.project.planning.reconciliationBaseline,
        source.planRevision,
        { requireLatest: value.importStatus === 'imported' }
      );
      if (hasReconciliationReceipt) {
        validateProjectReconciliationReceipt(
          value.project.planning.lastReconciliationReceipt,
          source,
          value.project.planning.reconciliationBaseline
        );
      }
      if (hasLocalCollisionBoundaries) {
        const boundaryItemIds =
          value.project.planning.localCollisionBoundaryItemIds;
        if (
          !Array.isArray(boundaryItemIds)
          || boundaryItemIds.length < 1
          || boundaryItemIds.length > 500
        ) {
          throw new Error(
            'SyncShow returned invalid local collision boundaries.'
          );
        }
        const normalizedBoundaryItemIds =
          boundaryItemIds.map((itemId, index) =>
            text(
              itemId,
              `local collision boundary ${index + 1}`,
              128,
              { pattern: ID }
            ));
        if (
          new Set(normalizedBoundaryItemIds).size
            !== normalizedBoundaryItemIds.length
          || normalizedBoundaryItemIds.some(
            (itemId, index) =>
              index > 0
              && normalizedBoundaryItemIds[index - 1]
                .localeCompare(itemId) >= 0
          )
          || !value.project.items
          || typeof value.project.items !== 'object'
          || Array.isArray(value.project.items)
          || normalizedBoundaryItemIds.some(itemId =>
            !Object.prototype.hasOwnProperty.call(
              value.project.items,
              itemId
            ))
        ) {
          throw new Error(
            'SyncShow returned inconsistent local collision boundaries.'
          );
        }
      }
    }
    if (
      value.project.schemaVersion !== 1
      || value.project.kind !== 'syncshow-service-project'
      || value.project.id !== review.proposal.projectId
      || ![2, 3].includes(planningSchemaVersion)
      || source.kind !== 'community-plan'
      || source.serverId !== review.connection.serverId
      || source.planId !== review.servicePlan.syncId
      || source.planRevision !== review.servicePlan.revision
      || (value.importStatus === 'already-imported' && !value.unchanged)
      || (value.importStatus === 'imported' && (
        value.unchanged
        || planningSchemaVersion !== 3
        || value.project.planning.status !== 'planning'
        || (!allowReconciledPlanning && (
          value.project.title !== review.servicePlan.plan.title
          || value.project.serviceDate !== review.servicePlan.plan.serviceDate
          || value.project.planning.startTime
            !== review.servicePlan.plan.startTime
          || value.project.planning.teamNotes
            !== review.servicePlan.plan.teamNotes
        ))
      ))
    ) {
      throw new Error(
        'SyncShow returned a Planning project for a different Community revision.'
      );
    }
    return Object.freeze({
      project: Object.freeze({
        id: text(value.project.id, 'imported service-project ID', 128, {
          pattern: ID
        }),
        title: text(value.project.title, 'imported service-project title', 200)
      }),
      revisionId: value.revisionId,
      unchanged: value.unchanged,
      importStatus: value.importStatus
    });
  }

  function normalizeReplacementResult(
    value,
    review,
    expectedDecisions
  ) {
    exact(
      value,
      [
        'project',
        'revisionId',
        'unchanged',
        'recovery',
        'readiness',
        'replacementStatus',
        'previousRevisionId'
      ],
      'Community service-plan reconciliation result'
    );
    const previousRevisionId = text(
      value.previousRevisionId,
      'previous local project revision',
      64,
      { pattern: REVISION }
    );
    const expectedStatus =
      review?.proposal?.reconciliation?.mode === 'three-way'
        ? 'reconciled'
        : 'replaced';
    if (
      review?.proposal?.status !== 'newer-revision'
      || !review.replacementToken
      || value.replacementStatus !== expectedStatus
      || previousRevisionId !== review.proposal.revisionId
      || value.unchanged !== false
      || value.revisionId === previousRevisionId
      || value.project?.planning?.schemaVersion !== 3
      || value.project.planning.reconciliationBaseline?.projectionSha256
        !== review.proposal.reconciliation.candidateProjectionSha256
    ) {
      throw new Error(
        'SyncShow returned an invalid service-plan reconciliation result.'
      );
    }
    const reconciliation = review.proposal.reconciliation;
    const receipt = value.project.planning.lastReconciliationReceipt;
    if (
      !receipt
      || !Array.isArray(expectedDecisions)
      || expectedDecisions.length !== reconciliation.conflicts.length
      || expectedDecisions.some((decision, index) =>
        !decision
        || typeof decision !== 'object'
        || Array.isArray(decision)
        || Object.keys(decision).length !== 2
        || decision.conflictId
          !== reconciliation.conflicts[index].conflictId
        || !['keep-local', 'use-community'].includes(decision.choice))
    ) {
      throw new Error(
        'SyncShow returned an unbound service-plan reconciliation receipt.'
      );
    }
    const normalized = normalizeImportResult({
      project: value.project,
      revisionId: value.revisionId,
      unchanged: value.unchanged,
      recovery: value.recovery,
      readiness: value.readiness,
      importStatus: 'imported'
    }, review, { allowReconciledPlanning: true });
    // The proposal's mergeResultSha256 is the deterministic no-decision
    // (Keep Local) preview used for stale-review authority. Explicit reviewed
    // choices can legitimately produce another result hash. Main binds that
    // actual semantic hash into this checksum-verified receipt; the renderer
    // therefore binds the candidate and exact choices, not the preview hash.
    if (
      receipt.mode !== reconciliation.mode
      || receipt.previousPlanRevision
        !== reconciliation.baselinePlanRevision
      || receipt.candidatePlanRevision
        !== reconciliation.candidatePlanRevision
      || receipt.previousBaselineProjectionSha256
        !== reconciliation.baselineProjectionSha256
      || receipt.candidateProjectionSha256
        !== reconciliation.candidateProjectionSha256
      || receipt.previousLocalRevisionId !== previousRevisionId
      || receipt.conflictCount !== reconciliation.conflictCount
      || receipt.decisions.length !== reconciliation.conflicts.length
      || receipt.decisions.some((decision, index) =>
        decision.conflictId
          !== reconciliation.conflicts[index].conflictId
        || decision.conflictId
          !== expectedDecisions[index].conflictId
        || decision.choice !== expectedDecisions[index].choice)
    ) {
      throw new Error(
        'SyncShow returned an unbound service-plan reconciliation receipt.'
      );
    }
    return Object.freeze({
      project: normalized.project,
      previousRevisionId,
      revisionId: normalized.revisionId,
      unchanged: false,
      replacementStatus: expectedStatus
    });
  }

  function entryPositionLabel(entry, entries) {
    const position = Array.isArray(entries)
      ? entries.findIndex(candidate => candidate?.id === entry?.id)
      : -1;
    return position < 0 ? 'Item ?' : `Item ${position + 1}`;
  }

  function entryDisplayLabel(entry, entries = []) {
    const positionLabel = entryPositionLabel(entry, entries);
    if (entry?.kind !== 'scripture') {
      const kindLabel = entry?.kind === 'section'
        ? 'Section'
        : ({
            song: 'Song',
            sermon: 'Sermon'
          })[entry?.kind] || entry?.kind || 'Item';
      return `${entry?.title || 'Untitled'} · ${kindLabel} · ${positionLabel}`;
    }
    const scriptureRange = entry.range;
    const reference = scriptureRange
      ? `${scriptureRange.bookId} ${scriptureRange.start?.chapter}:${
          scriptureRange.start?.verse
        }${
          scriptureRange.start?.chapter === scriptureRange.end?.chapter
            ? (
                scriptureRange.start?.verse === scriptureRange.end?.verse
                  ? ''
                  : `–${scriptureRange.end?.verse}`
              )
            : `–${scriptureRange.end?.chapter}:${
                scriptureRange.end?.verse
              }`
        }`
      : 'Scripture';
    const linkedSermon = entry.sermonReading
      ? entries.find(candidate =>
          candidate.id === entry.sermonReading.sermonEntryId
          && candidate.kind === 'sermon')
      : null;
    return `${entry.title || reference} · ${reference} · ${
      entry.translationId || ''
    } · ${positionLabel}${
      linkedSermon
        ? ` · Reading for ${linkedSermon.title} (${
            entryPositionLabel(linkedSermon, entries)
          })`
        : ''
    }`;
  }

  window.SyncShowCommunityServicePlans = Object.freeze({
    entryDisplayLabel,
    normalizeImportResult,
    normalizePage,
    normalizeReplacementResult,
    normalizeReview
  });
})();
