(function exposeServiceHandoff(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowServiceHandoff = api;
}(typeof globalThis === 'object' ? globalThis : this, function createApi() {
  'use strict';

  const LEGACY_SERVICE_HANDOFF_SCHEMA_VERSION = 1;
  const SERVICE_HANDOFF_SCHEMA_VERSION = 2;
  const SERVICE_HANDOFF_SCHEMA_VERSIONS = Object.freeze([
    LEGACY_SERVICE_HANDOFF_SCHEMA_VERSION,
    SERVICE_HANDOFF_SCHEMA_VERSION
  ]);
  const SERVICE_HANDOFF_KIND = 'syncshow-service-handoff';
  const MAX_CUES = 2000;
  const MAX_GROUP_DEPTH = 32;
  const MAX_READINESS_WAIVERS = 5;
  const MAX_SERVING_ASSIGNMENTS = 250;
  const MAX_RUN_SHEET_ROWS = 5000;
  const MAX_PLANNED_DURATION_SECONDS = 24 * 60 * 60;
  const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const CUE_ID_PATTERN = /^cue-[a-f0-9]{24}$/;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  const START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
  const SERVICE_PLAN_STATUSES = Object.freeze([
    'planning',
    'ready',
    'completed',
    'needs-follow-up'
  ]);
  const CUE_KINDS = Object.freeze([
    'song',
    'bible',
    'sermon',
    'picture',
    'video',
    'notice',
    'blank',
    'slide'
  ]);
  const READINESS_STATUSES = Object.freeze(['pass', 'waived', 'blocker']);
  const SERVING_STATUSES = Object.freeze([
    'open',
    'assigned',
    'confirmed',
    'declined'
  ]);
  const RUN_SHEET_STATUSES = Object.freeze([
    'complete',
    'incomplete',
    'conflict'
  ]);
  const RUN_SHEET_TIMING_SOURCES = Object.freeze([
    'explicit',
    'children',
    'missing'
  ]);
  const RUN_SHEET_ITEM_KINDS = Object.freeze([
    'group',
    'song',
    'bible',
    'sermon',
    'notice',
    'picture',
    'video',
    'blank',
    'imported-deck'
  ]);
  const READINESS_CHECK_IDS = Object.freeze([
    'compilable-nonempty',
    'song-present',
    'exact-sermon-link',
    'linked-sermon-material',
    'sermon-reading-before-material',
    'channel-visible-content'
  ]);
  const UNWAIVABLE_CHECK_IDS = new Set(['compilable-nonempty']);
  const DISALLOWED_TEXT_CONTROLS =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

  function invalid(message) {
    throw new TypeError(`Invalid service handoff: ${message}`);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function requireExactObject(value, expectedKeys, field) {
    if (!isPlainObject(value)) invalid(`${field} must be a plain object`);
    const actualKeys = Reflect.ownKeys(value);
    if (actualKeys.some(key => typeof key !== 'string')) {
      invalid(`${field} must not contain symbol properties`);
    }
    const expected = [...expectedKeys].sort();
    const actual = actualKeys.sort();
    if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
      invalid(`${field} must contain exactly the supported fields`);
    }
    for (const key of actual) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        invalid(`${field}.${key} must be an own data property`);
      }
    }
    return value;
  }

  function requireDenseArray(value, maximum, field, { minimum = 0 } = {}) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      invalid(`${field} must be a plain array`);
    }
    if (!Number.isSafeInteger(value.length)
      || value.length < minimum
      || value.length > maximum) {
      invalid(`${field} must contain ${minimum} to ${maximum} entries`);
    }
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_unused, index) => String(index)),
      'length'
    ];
    if (ownKeys.length !== expectedKeys.length
      || expectedKeys.some(key => !ownKeys.includes(key))) {
      invalid(`${field} must be dense and must not contain extra properties`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        invalid(`${field}[${index}] must be an own data property`);
      }
    }
    return value;
  }

  function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function requireText(value, field, maximum, { required = false } = {}) {
    if (typeof value !== 'string'
      || value.length > maximum
      || DISALLOWED_TEXT_CONTROLS.test(value)
      || hasUnpairedSurrogate(value)
      || (required && value.trim().length === 0)) {
      invalid(`${field} must be safe bounded text`);
    }
    return value;
  }

  function requireIdentifier(value, field) {
    if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
      invalid(`${field} must be a canonical identifier`);
    }
    return value;
  }

  function requireSha256(value, field) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
      invalid(`${field} must be a lowercase SHA-256 digest`);
    }
    return value;
  }

  function requireRevision(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      invalid('project.revision must be a non-negative safe integer');
    }
    return value;
  }

  function requireIsoDate(value) {
    if (typeof value !== 'string'
      || !/^(\d{4})-(\d{2})-(\d{2})$/u.test(value)) {
      invalid('project.serviceDate must use YYYY-MM-DD');
    }
    const [, rawYear, rawMonth, rawDay] =
      /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    const year = Number(rawYear);
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day) {
      invalid('project.serviceDate must be a real calendar date');
    }
    return value;
  }

  function requireBoolean(value, field) {
    if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
    return value;
  }

  function requireInteger(value, field, {
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
    nullable = false
  } = {}) {
    if (nullable && value === null) return null;
    if (!Number.isSafeInteger(value)
      || value < minimum
      || value > maximum) {
      invalid(`${field} must be a bounded safe integer`);
    }
    return value;
  }

  function requireCanonicalSingleLine(value, field, maximum) {
    const text = requireText(value, field, maximum, { required: true });
    if (text !== text.trim().normalize('NFC')
      || /[\r\n\t]/u.test(text)) {
      invalid(`${field} must be canonical single-line text`);
    }
    return text;
  }

  function requireCanonicalMultiline(value, field, maximum) {
    const text = requireText(value, field, maximum);
    if (text !== text.replace(/\r\n?/gu, '\n').normalize('NFC')
      || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text)) {
      invalid(`${field} must be canonical multiline text`);
    }
    return text;
  }

  function wallClockAtOffset(serviceDate, startTime, offsetSeconds) {
    const [year, month, day] = serviceDate.split('-').map(Number);
    const [hour, minute] = startTime.split(':').map(Number);
    const secondsPerDay = 24 * 60 * 60;
    const totalSeconds = (hour * 60 * 60) + (minute * 60) + offsetSeconds;
    const dayOffset = Math.floor(totalSeconds / secondsPerDay);
    const secondsInDay = totalSeconds % secondsPerDay;
    const clockHour = Math.floor(secondsInDay / 3600);
    const clockMinute = Math.floor((secondsInDay % 3600) / 60);
    const clockSecond = secondsInDay % 60;
    return {
      date: new Date(Date.UTC(year, month - 1, day + dayOffset))
        .toISOString()
        .slice(0, 10),
      time: [
        String(clockHour).padStart(2, '0'),
        String(clockMinute).padStart(2, '0'),
        String(clockSecond).padStart(2, '0')
      ].join(':'),
      dayOffset
    };
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function normalizeRunSheetClock(rawClock, field) {
    if (rawClock === null) return null;
    const clock = requireExactObject(
      rawClock,
      ['date', 'time', 'dayOffset'],
      field
    );
    const date = requireIsoDate(clock.date);
    if (typeof clock.time !== 'string'
      || !CLOCK_TIME_PATTERN.test(clock.time)) {
      invalid(`${field}.time must use HH:mm:ss`);
    }
    return {
      date,
      time: clock.time,
      dayOffset: requireInteger(clock.dayOffset, `${field}.dayOffset`)
    };
  }

  function normalizeWaivers(rawWaivers) {
    requireDenseArray(
      rawWaivers,
      MAX_READINESS_WAIVERS,
      'planning.readinessWaivers'
    );
    const byCheckId = new Map();
    for (let index = 0; index < rawWaivers.length; index += 1) {
      const rawWaiver = requireExactObject(
        rawWaivers[index],
        ['checkId', 'reason'],
        `planning.readinessWaivers[${index}]`
      );
      const checkId = requireText(
        rawWaiver.checkId,
        `planning.readinessWaivers[${index}].checkId`,
        128,
        { required: true }
      );
      if (!READINESS_CHECK_IDS.includes(checkId)
        || UNWAIVABLE_CHECK_IDS.has(checkId)
        || byCheckId.has(checkId)) {
        invalid(
          `planning.readinessWaivers[${index}].checkId must identify one unique waivable check`
        );
      }
      const reason = requireText(
        rawWaiver.reason,
        `planning.readinessWaivers[${index}].reason`,
        500,
        { required: true }
      );
      if (reason !== reason.trim().normalize('NFC')) {
        invalid(
          `planning.readinessWaivers[${index}].reason must be canonical trimmed text`
        );
      }
      byCheckId.set(checkId, { checkId, reason });
    }
    return READINESS_CHECK_IDS
      .filter(checkId => byCheckId.has(checkId))
      .map(checkId => byCheckId.get(checkId));
  }

  function normalizeServing(rawServing, itemIds) {
    const serving = requireExactObject(
      rawServing,
      ['schemaVersion', 'assignments'],
      'planning.serving'
    );
    if (serving.schemaVersion !== 1) {
      invalid('planning.serving must use schema v1');
    }
    requireDenseArray(
      serving.assignments,
      MAX_SERVING_ASSIGNMENTS,
      'planning.serving.assignments'
    );
    const assignmentIds = new Set();
    const assignments = serving.assignments.map((rawAssignment, index) => {
      const field = `planning.serving.assignments[${index}]`;
      const assignment = requireExactObject(
        rawAssignment,
        [
          'id',
          'role',
          'personName',
          'scope',
          'status',
          'required',
          'callTime',
          'note'
        ],
        field
      );
      const id = requireIdentifier(assignment.id, `${field}.id`);
      if (assignmentIds.has(id)) {
        invalid(`${field}.id must be unique`);
      }
      assignmentIds.add(id);
      if (!SERVING_STATUSES.includes(assignment.status)) {
        invalid(`${field}.status is unsupported`);
      }
      const personName = assignment.personName === null
        ? null
        : requireCanonicalSingleLine(
            assignment.personName,
            `${field}.personName`,
            120
          );
      if ((assignment.status === 'open') !== (personName === null)) {
        invalid(`${field}.personName does not match its status`);
      }
      if (typeof assignment.required !== 'boolean') {
        invalid(`${field}.required must be a boolean`);
      }
      if (assignment.callTime !== null
        && (
          typeof assignment.callTime !== 'string'
          || !START_TIME_PATTERN.test(assignment.callTime)
        )) {
        invalid(`${field}.callTime must be null or HH:mm`);
      }
      const scope = requireExactObject(
        assignment.scope,
        ['kind', 'itemId'],
        `${field}.scope`
      );
      let normalizedScope;
      if (scope.kind === 'service') {
        if (scope.itemId !== null) {
          invalid(`${field}.scope.itemId must be null for service scope`);
        }
        normalizedScope = { kind: 'service', itemId: null };
      } else if (scope.kind === 'item') {
        const itemId = requireIdentifier(
          scope.itemId,
          `${field}.scope.itemId`
        );
        if (!itemIds.has(itemId)) {
          invalid(`${field}.scope.itemId must identify a run-sheet item`);
        }
        normalizedScope = { kind: 'item', itemId };
      } else {
        invalid(`${field}.scope.kind is unsupported`);
      }
      return {
        id,
        role: requireCanonicalSingleLine(
          assignment.role,
          `${field}.role`,
          120
        ),
        personName,
        scope: normalizedScope,
        status: assignment.status,
        required: assignment.required,
        callTime: assignment.callTime,
        note: requireCanonicalMultiline(
          assignment.note,
          `${field}.note`,
          500
        )
      };
    });
    return {
      schemaVersion: 1,
      assignments
    };
  }

  function normalizePlanning(rawPlanning, schemaVersion, itemIds = new Set()) {
    if (rawPlanning === null) return null;
    const planning = requireExactObject(
      rawPlanning,
      [
        'status',
        'startTime',
        'teamNotes',
        'readinessWaivers',
        ...(schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION
          ? ['serving']
          : [])
      ],
      'planning'
    );
    if (!SERVICE_PLAN_STATUSES.includes(planning.status)) {
      invalid('planning.status is unsupported');
    }
    if (typeof planning.startTime !== 'string'
      || !START_TIME_PATTERN.test(planning.startTime)) {
      invalid('planning.startTime must use 24-hour venue time as HH:mm');
    }
    const normalized = {
      status: planning.status,
      startTime: planning.startTime,
      teamNotes: requireText(planning.teamNotes, 'planning.teamNotes', 4000),
      readinessWaivers: normalizeWaivers(planning.readinessWaivers)
    };
    if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
      normalized.serving = normalizeServing(planning.serving, itemIds);
    }
    return normalized;
  }

  function normalizeReadiness(rawReadiness, planning) {
    const readiness = requireExactObject(
      rawReadiness,
      ['ready', 'checks', 'waivedCheckIds'],
      'readiness'
    );
    if (typeof readiness.ready !== 'boolean') {
      invalid('readiness.ready must be a boolean');
    }
    requireDenseArray(
      readiness.checks,
      READINESS_CHECK_IDS.length,
      'readiness.checks',
      { minimum: READINESS_CHECK_IDS.length }
    );
    const checks = readiness.checks.map((rawCheck, index) => {
      const check = requireExactObject(
        rawCheck,
        ['id', 'status'],
        `readiness.checks[${index}]`
      );
      if (check.id !== READINESS_CHECK_IDS[index]
        || !READINESS_STATUSES.includes(check.status)) {
        invalid(`readiness.checks[${index}] does not match the fixed contract`);
      }
      return { id: check.id, status: check.status };
    });
    requireDenseArray(
      readiness.waivedCheckIds,
      MAX_READINESS_WAIVERS,
      'readiness.waivedCheckIds'
    );
    const expectedWaivedCheckIds = checks
      .filter(check => check.status === 'waived')
      .map(check => check.id);
    if (readiness.waivedCheckIds.length !== expectedWaivedCheckIds.length
      || readiness.waivedCheckIds.some(
        (checkId, index) => checkId !== expectedWaivedCheckIds[index]
      )) {
      invalid('readiness.waivedCheckIds must exactly match waived checks');
    }
    const expectedReady = checks.every(check => check.status !== 'blocker');
    if (readiness.ready !== expectedReady) {
      invalid('readiness.ready must match the absence of blockers');
    }

    const waiverIds = new Set(
      planning?.readinessWaivers.map(waiver => waiver.checkId) || []
    );
    for (const check of checks) {
      if (check.status === 'waived' && !waiverIds.has(check.id)) {
        invalid(`readiness check ${check.id} has no reviewed planning waiver`);
      }
      if (check.status === 'blocker' && waiverIds.has(check.id)) {
        invalid(`readiness check ${check.id} ignores its planning waiver`);
      }
    }
    if (!planning && expectedWaivedCheckIds.length > 0) {
      invalid('an unplanned service cannot contain waived readiness checks');
    }
    return {
      ready: readiness.ready,
      checks,
      waivedCheckIds: [...expectedWaivedCheckIds]
    };
  }

  function normalizeRunSheetRow(rawRow, index, rowById) {
    const field = `runSheet.rows[${index}]`;
    const kind = rawRow?.kind;
    const row = requireExactObject(
      rawRow,
      [
        'itemId',
        'parentItemId',
        'depth',
        'kind',
        'title',
        'plannedDurationSeconds',
        'effectiveDurationSeconds',
        'timingSource',
        'coveredByItemId',
        'startOffsetSeconds',
        'endOffsetSeconds',
        'start',
        'end',
        ...(kind === 'group'
          ? [
              'childDurationSeconds',
              'remainingSeconds',
              'overrunSeconds'
            ]
          : [])
      ],
      field
    );
    if (!RUN_SHEET_ITEM_KINDS.includes(kind)) {
      invalid(`${field}.kind is unsupported`);
    }
    const itemId = requireIdentifier(row.itemId, `${field}.itemId`);
    if (rowById.has(itemId)) invalid(`${field}.itemId must be unique`);
    const parentItemId = row.parentItemId === null
      ? null
      : requireIdentifier(row.parentItemId, `${field}.parentItemId`);
    const depth = requireInteger(row.depth, `${field}.depth`, {
      maximum: MAX_GROUP_DEPTH
    });
    if (parentItemId === null) {
      if (depth !== 0) invalid(`${field}.depth must be zero for a root row`);
    } else {
      const parent = rowById.get(parentItemId);
      if (!parent || parent.kind !== 'group' || depth !== parent.depth + 1) {
        invalid(`${field} must follow one earlier parent group`);
      }
    }
    const plannedDurationSeconds = requireInteger(
      row.plannedDurationSeconds,
      `${field}.plannedDurationSeconds`,
      { maximum: MAX_PLANNED_DURATION_SECONDS, nullable: true }
    );
    const effectiveDurationSeconds = requireInteger(
      row.effectiveDurationSeconds,
      `${field}.effectiveDurationSeconds`,
      { nullable: true }
    );
    if (!RUN_SHEET_TIMING_SOURCES.includes(row.timingSource)) {
      invalid(`${field}.timingSource is unsupported`);
    }
    if (
      (row.timingSource === 'explicit'
        && (
          plannedDurationSeconds === null
          || effectiveDurationSeconds !== plannedDurationSeconds
        ))
      || (row.timingSource === 'children'
        && (
          kind !== 'group'
          || plannedDurationSeconds !== null
          || effectiveDurationSeconds === null
        ))
      || (row.timingSource === 'missing'
        && (
          plannedDurationSeconds !== null
          || effectiveDurationSeconds !== null
        ))
    ) {
      invalid(`${field} timing fields are inconsistent`);
    }
    const coveredByItemId = row.coveredByItemId === null
      ? null
      : requireIdentifier(row.coveredByItemId, `${field}.coveredByItemId`);
    const expectedCoveredByItemId = parentItemId === null
      ? null
      : rowById.get(parentItemId).plannedDurationSeconds !== null
        ? parentItemId
        : rowById.get(parentItemId).coveredByItemId;
    if (coveredByItemId !== expectedCoveredByItemId) {
      invalid(`${field}.coveredByItemId does not match its timed ancestor`);
    }
    if (coveredByItemId !== null) {
      const coveredBy = rowById.get(coveredByItemId);
      if (!coveredBy
        || coveredBy.kind !== 'group'
        || coveredBy.plannedDurationSeconds === null) {
        invalid(`${field}.coveredByItemId must identify a timed group`);
      }
    }
    const startOffsetSeconds = requireInteger(
      row.startOffsetSeconds,
      `${field}.startOffsetSeconds`,
      { nullable: true }
    );
    const endOffsetSeconds = requireInteger(
      row.endOffsetSeconds,
      `${field}.endOffsetSeconds`,
      { nullable: true }
    );
    const expectedEndOffsetSeconds =
      startOffsetSeconds !== null && effectiveDurationSeconds !== null
        ? startOffsetSeconds + effectiveDurationSeconds
        : null;
    if (endOffsetSeconds !== expectedEndOffsetSeconds) {
      invalid(`${field}.endOffsetSeconds does not match its duration`);
    }
    const normalized = {
      itemId,
      parentItemId,
      depth,
      kind,
      title: requireText(row.title, `${field}.title`, 200, { required: true }),
      plannedDurationSeconds,
      effectiveDurationSeconds,
      timingSource: row.timingSource,
      coveredByItemId,
      startOffsetSeconds,
      endOffsetSeconds,
      start: normalizeRunSheetClock(row.start, `${field}.start`),
      end: normalizeRunSheetClock(row.end, `${field}.end`)
    };
    if (kind === 'group') {
      const childDurationSeconds = requireInteger(
        row.childDurationSeconds,
        `${field}.childDurationSeconds`,
        { nullable: true }
      );
      const remainingSeconds = requireInteger(
        row.remainingSeconds,
        `${field}.remainingSeconds`,
        { nullable: true }
      );
      const overrunSeconds = requireInteger(
        row.overrunSeconds,
        `${field}.overrunSeconds`,
        { nullable: true }
      );
      if (plannedDurationSeconds === null) {
        if (
          remainingSeconds !== null
          || overrunSeconds !== null
          || (
            childDurationSeconds !== null
            && effectiveDurationSeconds !== childDurationSeconds
          )
        ) {
          invalid(`${field} untimed group totals are inconsistent`);
        }
      } else if (childDurationSeconds === null) {
        if (remainingSeconds !== null || overrunSeconds !== null) {
          invalid(`${field} cannot calculate remaining or overrun time`);
        }
      } else if (
        remainingSeconds !== Math.max(
          0,
          plannedDurationSeconds - childDurationSeconds
        )
        || overrunSeconds !== Math.max(
          0,
          childDurationSeconds - plannedDurationSeconds
        )
      ) {
        invalid(`${field} remaining or overrun time is inconsistent`);
      }
      normalized.childDurationSeconds = childDurationSeconds;
      normalized.remainingSeconds = remainingSeconds;
      normalized.overrunSeconds = overrunSeconds;
    }
    rowById.set(itemId, normalized);
    return normalized;
  }

  function normalizeRunSheetIdList(raw, field, rowById) {
    requireDenseArray(raw, MAX_RUN_SHEET_ROWS, field);
    const ids = raw.map((itemId, index) =>
      requireIdentifier(itemId, `${field}[${index}]`));
    if (new Set(ids).size !== ids.length
      || ids.some(itemId => !rowById.has(itemId))) {
      invalid(`${field} must contain unique run-sheet item IDs`);
    }
    return ids;
  }

  function normalizeRunSheetOverrun(rawOverrun, index, rowById) {
    const field = `runSheet.overruns[${index}]`;
    const overrun = requireExactObject(
      rawOverrun,
      [
        'groupItemId',
        'plannedDurationSeconds',
        'childDurationSeconds',
        'overrunSeconds'
      ],
      field
    );
    const groupItemId = requireIdentifier(
      overrun.groupItemId,
      `${field}.groupItemId`
    );
    const plannedDurationSeconds = requireInteger(
      overrun.plannedDurationSeconds,
      `${field}.plannedDurationSeconds`,
      { maximum: MAX_PLANNED_DURATION_SECONDS }
    );
    const childDurationSeconds = requireInteger(
      overrun.childDurationSeconds,
      `${field}.childDurationSeconds`
    );
    const overrunSeconds = requireInteger(
      overrun.overrunSeconds,
      `${field}.overrunSeconds`,
      { minimum: 1 }
    );
    const row = rowById.get(groupItemId);
    if (!row
      || row.kind !== 'group'
      || row.plannedDurationSeconds !== plannedDurationSeconds
      || row.childDurationSeconds !== childDurationSeconds
      || row.overrunSeconds !== overrunSeconds
      || overrunSeconds !== childDurationSeconds - plannedDurationSeconds) {
      invalid(`${field} does not match its timed group row`);
    }
    return {
      groupItemId,
      plannedDurationSeconds,
      childDurationSeconds,
      overrunSeconds
    };
  }

  function validateRunSheetSchedule(rows, serviceDate, startTime) {
    const childrenByParent = new Map();
    const rowById = new Map(rows.map(row => [row.itemId, row]));
    for (const row of rows) {
      const parentKey = row.parentItemId || null;
      if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
      childrenByParent.get(parentKey).push(row);
      const expectedStart = row.startOffsetSeconds === null
        ? null
        : wallClockAtOffset(serviceDate, startTime, row.startOffsetSeconds);
      const expectedEnd = row.endOffsetSeconds === null
        ? null
        : wallClockAtOffset(serviceDate, startTime, row.endOffsetSeconds);
      if (!sameValue(row.start, expectedStart)
        || !sameValue(row.end, expectedEnd)) {
        invalid(`run-sheet row ${row.itemId} has inconsistent wall-clock values`);
      }
    }
    for (const [parentItemId, children] of childrenByParent.entries()) {
      let expectedStartOffsetSeconds = parentItemId === null
        ? 0
        : rowById.get(parentItemId).startOffsetSeconds;
      for (const child of children) {
        if (child.startOffsetSeconds !== expectedStartOffsetSeconds) {
          invalid(`run-sheet row ${child.itemId} does not follow its sibling`);
        }
        expectedStartOffsetSeconds =
          expectedStartOffsetSeconds !== null
          && child.effectiveDurationSeconds !== null
            ? expectedStartOffsetSeconds + child.effectiveDurationSeconds
            : null;
      }
    }
  }

  function normalizeRunSheet(rawRunSheet, project, planningStartTime) {
    if (rawRunSheet === null) return null;
    const runSheet = requireExactObject(
      rawRunSheet,
      [
        'schemaVersion',
        'kind',
        'projectId',
        'projectRevision',
        'serviceDate',
        'startTime',
        'status',
        'complete',
        'breakdownComplete',
        'totalDurationSeconds',
        'expectedFinish',
        'missingItemIds',
        'unestimatedItemIds',
        'overruns',
        'rows'
      ],
      'runSheet'
    );
    if (runSheet.schemaVersion !== 1
      || runSheet.kind !== 'syncshow-service-run-sheet'
      || runSheet.projectId !== project.id
      || runSheet.projectRevision !== project.revision
      || runSheet.serviceDate !== project.serviceDate
      || runSheet.startTime !== planningStartTime) {
      invalid('runSheet must belong to the exact planned service revision');
    }
    if (!RUN_SHEET_STATUSES.includes(runSheet.status)) {
      invalid('runSheet.status is unsupported');
    }
    const complete = requireBoolean(runSheet.complete, 'runSheet.complete');
    const breakdownComplete = requireBoolean(
      runSheet.breakdownComplete,
      'runSheet.breakdownComplete'
    );
    const totalDurationSeconds = requireInteger(
      runSheet.totalDurationSeconds,
      'runSheet.totalDurationSeconds',
      { nullable: true }
    );
    const expectedFinish = normalizeRunSheetClock(
      runSheet.expectedFinish,
      'runSheet.expectedFinish'
    );
    requireDenseArray(
      runSheet.rows,
      MAX_RUN_SHEET_ROWS,
      'runSheet.rows',
      { minimum: 1 }
    );
    const rowById = new Map();
    const rows = runSheet.rows.map((row, index) =>
      normalizeRunSheetRow(row, index, rowById));
    validateRunSheetSchedule(rows, project.serviceDate, planningStartTime);
    const missingItemIds = normalizeRunSheetIdList(
      runSheet.missingItemIds,
      'runSheet.missingItemIds',
      rowById
    );
    const unestimatedItemIds = normalizeRunSheetIdList(
      runSheet.unestimatedItemIds,
      'runSheet.unestimatedItemIds',
      rowById
    );
    requireDenseArray(
      runSheet.overruns,
      MAX_RUN_SHEET_ROWS,
      'runSheet.overruns'
    );
    const overruns = runSheet.overruns.map((overrun, index) =>
      normalizeRunSheetOverrun(overrun, index, rowById));

    const expectedMissingItemIds = rows
      .filter(row =>
        row.kind !== 'group'
        && row.timingSource === 'missing'
        && row.coveredByItemId === null)
      .map(row => row.itemId);
    const expectedUnestimatedItemIds = rows
      .filter(row =>
        row.kind !== 'group'
        && row.plannedDurationSeconds === null)
      .map(row => row.itemId);
    const expectedOverruns = rows
      .filter(row => row.kind === 'group' && row.overrunSeconds > 0)
      .map(row => ({
        groupItemId: row.itemId,
        plannedDurationSeconds: row.plannedDurationSeconds,
        childDurationSeconds: row.childDurationSeconds,
        overrunSeconds: row.overrunSeconds
      }));
    const roots = rows.filter(row => row.parentItemId === null);
    const scheduleComplete = roots.every(row =>
      row.effectiveDurationSeconds !== null);
    const expectedTotalDurationSeconds = scheduleComplete
      ? roots.reduce((sum, row) => sum + row.effectiveDurationSeconds, 0)
      : null;
    const expectedFinishClock = expectedTotalDurationSeconds === null
      ? null
      : wallClockAtOffset(
          project.serviceDate,
          planningStartTime,
          expectedTotalDurationSeconds
        );
    const expectedStatus = expectedOverruns.length > 0
      ? 'conflict'
      : scheduleComplete
        ? 'complete'
        : 'incomplete';
    if (!sameValue(missingItemIds, expectedMissingItemIds)
      || !sameValue(unestimatedItemIds, expectedUnestimatedItemIds)
      || !sameValue(overruns, expectedOverruns)
      || complete !== scheduleComplete
      || breakdownComplete !== (unestimatedItemIds.length === 0)
      || totalDurationSeconds !== expectedTotalDurationSeconds
      || !sameValue(expectedFinish, expectedFinishClock)
      || runSheet.status !== expectedStatus) {
      invalid('runSheet summary must match its canonical rows');
    }
    return {
      schemaVersion: 1,
      kind: 'syncshow-service-run-sheet',
      projectId: project.id,
      projectRevision: project.revision,
      serviceDate: project.serviceDate,
      startTime: planningStartTime,
      status: runSheet.status,
      complete,
      breakdownComplete,
      totalDurationSeconds,
      expectedFinish,
      missingItemIds,
      unestimatedItemIds,
      overruns,
      rows
    };
  }

  function normalizeCue(rawCue, cueId, schemaVersion, runSheet = null) {
    const field = `cues.${cueId}`;
    const cue = requireExactObject(
      rawCue,
      [
        'id',
        'itemId',
        'title',
        'kind',
        'groupPath',
        'operatorNotes',
        ...(schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION
          ? ['itemPathIds']
          : [])
      ],
      field
    );
    if (cue.id !== cueId || !CUE_ID_PATTERN.test(cueId)) {
      invalid(`${field}.id must match its cue-map key`);
    }
    if (!CUE_KINDS.includes(cue.kind)) {
      invalid(`${field}.kind is unsupported`);
    }
    requireDenseArray(cue.groupPath, MAX_GROUP_DEPTH, `${field}.groupPath`);
    const itemId = requireIdentifier(cue.itemId, `${field}.itemId`);
    const groupPath = cue.groupPath.map((part, index) =>
      requireText(part, `${field}.groupPath[${index}]`, 160, {
        required: true
      }));
    const normalized = {
      id: cueId,
      itemId,
      title: requireText(cue.title, `${field}.title`, 200, { required: true }),
      kind: cue.kind,
      groupPath,
      operatorNotes: requireText(
        cue.operatorNotes,
        `${field}.operatorNotes`,
        4000
      )
    };
    if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
      requireDenseArray(
        cue.itemPathIds,
        MAX_GROUP_DEPTH + 1,
        `${field}.itemPathIds`,
        { minimum: 1 }
      );
      const itemPathIds = cue.itemPathIds.map((pathItemId, index) =>
        requireIdentifier(pathItemId, `${field}.itemPathIds[${index}]`));
      if (new Set(itemPathIds).size !== itemPathIds.length
        || itemPathIds[itemPathIds.length - 1] !== itemId) {
        invalid(`${field}.itemPathIds must end in itemId after its ancestors`);
      }
      if (runSheet) {
        const rowById = new Map(runSheet.rows.map(row => [row.itemId, row]));
        for (let index = 0; index < itemPathIds.length; index += 1) {
          const row = rowById.get(itemPathIds[index]);
          const expectedParentId = index === 0 ? null : itemPathIds[index - 1];
          if (!row
            || row.parentItemId !== expectedParentId
            || (index < itemPathIds.length - 1
              && (
                row.kind !== 'group'
                || row.title !== groupPath[index]
              ))) {
            invalid(`${field}.itemPathIds must match the run-sheet hierarchy`);
          }
        }
      }
      normalized.itemPathIds = itemPathIds;
    }
    return normalized;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }

  function normalizeServiceHandoff(raw) {
    if (!isPlainObject(raw)
      || !SERVICE_HANDOFF_SCHEMA_VERSIONS.includes(raw.schemaVersion)
      || raw.kind !== SERVICE_HANDOFF_KIND) {
      invalid(
        `expected ${SERVICE_HANDOFF_KIND} schema v1 or v${SERVICE_HANDOFF_SCHEMA_VERSION}`
      );
    }
    const schemaVersion = raw.schemaVersion;
    const handoff = requireExactObject(
      raw,
      [
        'schemaVersion',
        'kind',
        'project',
        'planning',
        'readiness',
        ...(schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION
          ? ['runSheet']
          : []),
        'cueIds',
        'cues'
      ],
      'service handoff'
    );

    const rawProject = requireExactObject(
      handoff.project,
      ['id', 'revisionId', 'revision', 'contentHash', 'title', 'serviceDate'],
      'project'
    );
    const project = {
      id: requireIdentifier(rawProject.id, 'project.id'),
      revisionId: requireSha256(rawProject.revisionId, 'project.revisionId'),
      revision: requireRevision(rawProject.revision),
      contentHash: requireSha256(rawProject.contentHash, 'project.contentHash'),
      title: requireText(rawProject.title, 'project.title', 200, {
        required: true
      }),
      serviceDate: requireIsoDate(rawProject.serviceDate)
    };
    let runSheet = null;
    let servingItemIds = new Set();
    if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
      if ((handoff.planning === null) !== (handoff.runSheet === null)) {
        invalid('runSheet must be null exactly when planning is null');
      }
      if (handoff.planning !== null) {
        if (!isPlainObject(handoff.planning)
          || typeof handoff.planning.startTime !== 'string'
          || !START_TIME_PATTERN.test(handoff.planning.startTime)) {
          invalid('planning.startTime must use 24-hour venue time as HH:mm');
        }
        runSheet = normalizeRunSheet(
          handoff.runSheet,
          project,
          handoff.planning.startTime
        );
        servingItemIds = new Set(runSheet.rows.map(row => row.itemId));
      }
    }
    const planning = normalizePlanning(
      handoff.planning,
      schemaVersion,
      servingItemIds
    );
    const readiness = normalizeReadiness(handoff.readiness, planning);

    requireDenseArray(handoff.cueIds, MAX_CUES, 'cueIds', { minimum: 1 });
    const cueIds = [];
    const seenCueIds = new Set();
    for (let index = 0; index < handoff.cueIds.length; index += 1) {
      const cueId = handoff.cueIds[index];
      if (typeof cueId !== 'string'
        || !CUE_ID_PATTERN.test(cueId)
        || seenCueIds.has(cueId)) {
        invalid(`cueIds[${index}] must be one unique compiled cue ID`);
      }
      seenCueIds.add(cueId);
      cueIds.push(cueId);
    }

    if (!isPlainObject(handoff.cues)) invalid('cues must be a plain object');
    const cueMapKeys = Reflect.ownKeys(handoff.cues);
    if (cueMapKeys.some(key => typeof key !== 'string')
      || cueMapKeys.length !== cueIds.length
      || cueMapKeys.some(cueId => !seenCueIds.has(cueId))) {
      invalid('cueIds and cues must contain exactly the same cue IDs');
    }
    for (const cueId of cueMapKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(handoff.cues, cueId);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        invalid(`cues.${cueId} must be an own data property`);
      }
    }
    const cues = {};
    for (const cueId of cueIds) {
      cues[cueId] = normalizeCue(
        handoff.cues[cueId],
        cueId,
        schemaVersion,
        runSheet
      );
    }

    const normalized = {
      schemaVersion,
      kind: SERVICE_HANDOFF_KIND,
      project,
      planning,
      readiness,
      cueIds,
      cues
    };
    if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
      normalized.runSheet = runSheet;
    }
    return deepFreeze(normalized);
  }

  function cueContextAtIndex(rawHandoff, slideIndex) {
    if (!Number.isSafeInteger(slideIndex)) {
      throw new TypeError('Service handoff slide index must be a safe integer');
    }
    const handoff = normalizeServiceHandoff(rawHandoff);
    if (slideIndex < 0 || slideIndex >= handoff.cueIds.length) return null;
    const currentCueId = handoff.cueIds[slideIndex];
    const nextCueId = handoff.cueIds[slideIndex + 1] || null;
    return Object.freeze({
      slideIndex,
      cueCount: handoff.cueIds.length,
      currentCue: handoff.cues[currentCueId],
      nextCue: nextCueId ? handoff.cues[nextCueId] : null
    });
  }

  return Object.freeze({
    cueContextAtIndex,
    normalizeServiceHandoff
  });
}));
