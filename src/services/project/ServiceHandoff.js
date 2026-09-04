'use strict';

const crypto = require('crypto');

const { isValidIsoDate } = require('../service-set/ServiceDate');
const {
  CUE_KINDS,
  CUE_TIMELINE_KIND,
  MAX_GROUP_DEPTH,
  SERVICE_PLAN_STATUSES,
  compileServiceProject,
  normalizeCueTimeline,
  normalizeServiceProject,
  serializeServiceProject
} = require('./ServiceProject');
const {
  MAX_SERVICE_READINESS_WAIVERS,
  SERVICE_READINESS_CHECK_IDS,
  SERVICE_READINESS_REPORT_KIND,
  SERVICE_READINESS_SCHEMA_VERSION
} = require('./ServiceProjectReadiness');
const {
  SERVICE_PROJECT_SERVING_SCHEMA_VERSION,
  normalizeServiceProjectServing
} = require('./ServiceProjectServing');
const {
  SERVICE_RUN_SHEET_KIND,
  SERVICE_RUN_SHEET_SCHEMA_VERSION,
  buildServiceRunSheet
} = require('./ServiceProjectRunSheet');

const LEGACY_SERVICE_HANDOFF_SCHEMA_VERSION = 1;
const SERVICE_HANDOFF_SCHEMA_VERSION = 2;
const SERVICE_HANDOFF_SCHEMA_VERSIONS = Object.freeze([
  LEGACY_SERVICE_HANDOFF_SCHEMA_VERSION,
  SERVICE_HANDOFF_SCHEMA_VERSION
]);
const SERVICE_HANDOFF_KIND = 'syncshow-service-handoff';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CUE_ID_PATTERN = /^cue-[a-f0-9]{24}$/;
const START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const READINESS_STATUSES = Object.freeze(['pass', 'waived', 'blocker']);
const UNWAIVABLE_CHECK_IDS = new Set(['compilable-nonempty']);
const MAX_RUN_SHEET_ROWS = 5000;
const MAX_PLANNED_DURATION_SECONDS = 24 * 60 * 60;
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

class ServiceHandoffError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ServiceHandoffError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ServiceHandoffError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableObject(value[key])])
  );
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requireExactKeys(value, keys, field) {
  if (!isRecord(value)) {
    fail('INVALID_SERVICE_HANDOFF', `${field} must be an object.`, { field });
  }
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (!sameArray(actual, expected)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} must contain exactly the supported fields.`,
      { field, expected, actual }
    );
  }
}

function requireString(value, field, maximum, options = {}) {
  if (typeof value !== 'string') {
    fail('INVALID_SERVICE_HANDOFF', `${field} must be text.`, { field });
  }
  if (options.required && value.length < 1) {
    fail('INVALID_SERVICE_HANDOFF', `${field} is required.`, { field });
  }
  if (value.length > maximum) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} must be ${maximum} characters or fewer.`,
      { field, maximum }
    );
  }
  return value;
}

function requireProjectId(value, field) {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    fail('INVALID_SERVICE_HANDOFF', `${field} is invalid.`, { field });
  }
  return value;
}

function requireSha256(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} must be a lowercase SHA-256 digest.`,
      { field }
    );
  }
  return value;
}

function requireRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_SERVICE_HANDOFF', `${field} must be a non-negative integer.`, {
      field
    });
  }
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    fail('INVALID_SERVICE_HANDOFF', `${field} must be a boolean.`, { field });
  }
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
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} must be ${nullable ? 'null or ' : ''}an integer from ${minimum} to ${maximum}.`,
      { field, minimum, maximum }
    );
  }
  return value;
}

function requireDenseArray(value, maximum, field, { minimum = 0 } = {}) {
  if (!Array.isArray(value)
    || value.length < minimum
    || value.length > maximum) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} must contain ${minimum} to ${maximum} entries.`,
      { field, minimum, maximum }
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field} must be a dense array.`,
        { field, index }
      );
    }
  }
  return value;
}

function requireIsoDate(value, field) {
  const normalized = requireString(value, field, 10, { required: true });
  if (!isValidIsoDate(normalized)) {
    fail('INVALID_SERVICE_HANDOFF', `${field} must be an ISO date.`, { field });
  }
  return normalized;
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

function normalizeRunSheetClock(rawClock, field) {
  if (rawClock === null) return null;
  requireExactKeys(rawClock, ['date', 'time', 'dayOffset'], field);
  const date = requireIsoDate(rawClock.date, `${field}.date`);
  if (typeof rawClock.time !== 'string'
    || !CLOCK_TIME_PATTERN.test(rawClock.time)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field}.time must use HH:mm:ss.`,
      { field }
    );
  }
  return {
    date,
    time: rawClock.time,
    dayOffset: requireInteger(rawClock.dayOffset, `${field}.dayOffset`)
  };
}

function sameObject(left, right) {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

function normalizeRunSheetRow(rawRow, index, rowById) {
  const field = `runSheet.rows[${index}]`;
  const rawKind = rawRow?.kind;
  requireExactKeys(
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
      ...(rawKind === 'group'
        ? [
            'childDurationSeconds',
            'remainingSeconds',
            'overrunSeconds'
          ]
        : [])
    ],
    field
  );
  if (!RUN_SHEET_ITEM_KINDS.includes(rawKind)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field}.kind is invalid.`,
      { field, kind: rawKind }
    );
  }
  const itemId = requireProjectId(rawRow.itemId, `${field}.itemId`);
  if (rowById.has(itemId)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field}.itemId is duplicated.`,
      { field, itemId }
    );
  }
  const parentItemId = rawRow.parentItemId === null
    ? null
    : requireProjectId(rawRow.parentItemId, `${field}.parentItemId`);
  const depth = requireInteger(rawRow.depth, `${field}.depth`, {
    maximum: MAX_GROUP_DEPTH
  });
  if (parentItemId === null) {
    if (depth !== 0) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field}.depth must be zero for a root row.`,
        { field }
      );
    }
  } else {
    const parent = rowById.get(parentItemId);
    if (!parent || parent.kind !== 'group' || depth !== parent.depth + 1) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field} must follow one earlier parent group at the next depth.`,
        { field, parentItemId }
      );
    }
  }

  const plannedDurationSeconds = requireInteger(
    rawRow.plannedDurationSeconds,
    `${field}.plannedDurationSeconds`,
    { maximum: MAX_PLANNED_DURATION_SECONDS, nullable: true }
  );
  const effectiveDurationSeconds = requireInteger(
    rawRow.effectiveDurationSeconds,
    `${field}.effectiveDurationSeconds`,
    { nullable: true }
  );
  if (!RUN_SHEET_TIMING_SOURCES.includes(rawRow.timingSource)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field}.timingSource is invalid.`,
      { field, timingSource: rawRow.timingSource }
    );
  }
  if (
    (rawRow.timingSource === 'explicit'
      && (
        plannedDurationSeconds === null
        || effectiveDurationSeconds !== plannedDurationSeconds
      ))
    || (rawRow.timingSource === 'children'
      && (
        rawKind !== 'group'
        || plannedDurationSeconds !== null
        || effectiveDurationSeconds === null
      ))
    || (rawRow.timingSource === 'missing'
      && (
        plannedDurationSeconds !== null
        || effectiveDurationSeconds !== null
      ))
  ) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} timing fields are inconsistent.`,
      { field }
    );
  }

  const coveredByItemId = rawRow.coveredByItemId === null
    ? null
    : requireProjectId(rawRow.coveredByItemId, `${field}.coveredByItemId`);
  const expectedCoveredByItemId = parentItemId === null
    ? null
    : plannedDurationSecondsForRow(rowById.get(parentItemId)) !== null
      ? parentItemId
      : rowById.get(parentItemId).coveredByItemId;
  if (coveredByItemId !== expectedCoveredByItemId) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field}.coveredByItemId does not match its timed ancestor.`,
      { field, expectedCoveredByItemId, coveredByItemId }
    );
  }
  if (coveredByItemId !== null) {
    const coveredBy = rowById.get(coveredByItemId);
    if (!coveredBy
      || coveredBy.kind !== 'group'
      || coveredBy.plannedDurationSeconds === null) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field}.coveredByItemId must identify an earlier explicitly timed group.`,
        { field, coveredByItemId }
      );
    }
  }

  const startOffsetSeconds = requireInteger(
    rawRow.startOffsetSeconds,
    `${field}.startOffsetSeconds`,
    { nullable: true }
  );
  const endOffsetSeconds = requireInteger(
    rawRow.endOffsetSeconds,
    `${field}.endOffsetSeconds`,
    { nullable: true }
  );
  const expectedEndOffsetSeconds =
    startOffsetSeconds !== null && effectiveDurationSeconds !== null
      ? startOffsetSeconds + effectiveDurationSeconds
      : null;
  if (endOffsetSeconds !== expectedEndOffsetSeconds) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field}.endOffsetSeconds does not match its start and duration.`,
      { field, expectedEndOffsetSeconds, endOffsetSeconds }
    );
  }

  const row = {
    itemId,
    parentItemId,
    depth,
    kind: rawKind,
    title: requireString(rawRow.title, `${field}.title`, 200, {
      required: true
    }),
    plannedDurationSeconds,
    effectiveDurationSeconds,
    timingSource: rawRow.timingSource,
    coveredByItemId,
    startOffsetSeconds,
    endOffsetSeconds,
    start: normalizeRunSheetClock(rawRow.start, `${field}.start`),
    end: normalizeRunSheetClock(rawRow.end, `${field}.end`)
  };
  if (rawKind === 'group') {
    const childDurationSeconds = requireInteger(
      rawRow.childDurationSeconds,
      `${field}.childDurationSeconds`,
      { nullable: true }
    );
    const remainingSeconds = requireInteger(
      rawRow.remainingSeconds,
      `${field}.remainingSeconds`,
      { nullable: true }
    );
    const overrunSeconds = requireInteger(
      rawRow.overrunSeconds,
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
        fail(
          'INVALID_SERVICE_HANDOFF',
          `${field} untimed group totals are inconsistent.`,
          { field }
        );
      }
    } else if (childDurationSeconds === null) {
      if (remainingSeconds !== null || overrunSeconds !== null) {
        fail(
          'INVALID_SERVICE_HANDOFF',
          `${field} cannot calculate remaining or overrun time without a child total.`,
          { field }
        );
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
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field} remaining or overrun time is inconsistent.`,
        { field }
      );
    }
    row.childDurationSeconds = childDurationSeconds;
    row.remainingSeconds = remainingSeconds;
    row.overrunSeconds = overrunSeconds;
  }
  rowById.set(itemId, row);
  return row;
}

function plannedDurationSecondsForRow(row) {
  return row?.plannedDurationSeconds ?? null;
}

function normalizeRunSheetIdList(raw, field, rowById) {
  requireDenseArray(raw, MAX_RUN_SHEET_ROWS, field);
  const ids = raw.map((rawItemId, index) =>
    requireProjectId(rawItemId, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length
    || ids.some(itemId => !rowById.has(itemId))) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} must contain unique run-sheet item IDs.`,
      { field }
    );
  }
  return ids;
}

function normalizeRunSheetOverrun(raw, index, rowById) {
  const field = `runSheet.overruns[${index}]`;
  requireExactKeys(
    raw,
    [
      'groupItemId',
      'plannedDurationSeconds',
      'childDurationSeconds',
      'overrunSeconds'
    ],
    field
  );
  const groupItemId = requireProjectId(raw.groupItemId, `${field}.groupItemId`);
  const row = rowById.get(groupItemId);
  const plannedDurationSeconds = requireInteger(
    raw.plannedDurationSeconds,
    `${field}.plannedDurationSeconds`,
    { maximum: MAX_PLANNED_DURATION_SECONDS }
  );
  const childDurationSeconds = requireInteger(
    raw.childDurationSeconds,
    `${field}.childDurationSeconds`
  );
  const overrunSeconds = requireInteger(
    raw.overrunSeconds,
    `${field}.overrunSeconds`,
    { minimum: 1 }
  );
  if (!row
    || row.kind !== 'group'
    || row.plannedDurationSeconds !== plannedDurationSeconds
    || row.childDurationSeconds !== childDurationSeconds
    || row.overrunSeconds !== overrunSeconds
    || overrunSeconds !== childDurationSeconds - plannedDurationSeconds) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `${field} does not match its timed group row.`,
      { field, groupItemId }
    );
  }
  return {
    groupItemId,
    plannedDurationSeconds,
    childDurationSeconds,
    overrunSeconds
  };
}

function validateRunSheetRowSchedule(rows, serviceDate, startTime) {
  const childrenByParent = new Map();
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
    if (!sameObject(row.start, expectedStart) || !sameObject(row.end, expectedEnd)) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `Run-sheet row ${row.itemId} wall-clock values do not match its offsets.`,
        { itemId: row.itemId }
      );
    }
  }

  for (const [parentItemId, children] of childrenByParent.entries()) {
    let expectedStartOffsetSeconds = parentItemId === null
      ? 0
      : rows.find(row => row.itemId === parentItemId).startOffsetSeconds;
    for (const child of children) {
      if (child.startOffsetSeconds !== expectedStartOffsetSeconds) {
        fail(
          'INVALID_SERVICE_HANDOFF',
          `Run-sheet row ${child.itemId} does not follow its preceding sibling.`,
          { itemId: child.itemId, expectedStartOffsetSeconds }
        );
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
  requireExactKeys(
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
  if (rawRunSheet.schemaVersion !== SERVICE_RUN_SHEET_SCHEMA_VERSION
    || rawRunSheet.kind !== SERVICE_RUN_SHEET_KIND
    || rawRunSheet.projectId !== project.id
    || rawRunSheet.projectRevision !== project.revision
    || rawRunSheet.serviceDate !== project.serviceDate
    || rawRunSheet.startTime !== planningStartTime) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'runSheet does not belong to the exact planned service revision.'
    );
  }
  if (!RUN_SHEET_STATUSES.includes(rawRunSheet.status)) {
    fail('INVALID_SERVICE_HANDOFF', 'runSheet.status is invalid.');
  }
  const complete = requireBoolean(rawRunSheet.complete, 'runSheet.complete');
  const breakdownComplete = requireBoolean(
    rawRunSheet.breakdownComplete,
    'runSheet.breakdownComplete'
  );
  const totalDurationSeconds = requireInteger(
    rawRunSheet.totalDurationSeconds,
    'runSheet.totalDurationSeconds',
    { nullable: true }
  );
  const expectedFinish = normalizeRunSheetClock(
    rawRunSheet.expectedFinish,
    'runSheet.expectedFinish'
  );
  requireDenseArray(
    rawRunSheet.rows,
    MAX_RUN_SHEET_ROWS,
    'runSheet.rows',
    { minimum: 1 }
  );
  const rowById = new Map();
  const rows = rawRunSheet.rows.map((row, index) =>
    normalizeRunSheetRow(row, index, rowById));
  validateRunSheetRowSchedule(rows, project.serviceDate, planningStartTime);

  const missingItemIds = normalizeRunSheetIdList(
    rawRunSheet.missingItemIds,
    'runSheet.missingItemIds',
    rowById
  );
  const unestimatedItemIds = normalizeRunSheetIdList(
    rawRunSheet.unestimatedItemIds,
    'runSheet.unestimatedItemIds',
    rowById
  );
  requireDenseArray(
    rawRunSheet.overruns,
    MAX_RUN_SHEET_ROWS,
    'runSheet.overruns'
  );
  const overruns = rawRunSheet.overruns.map((overrun, index) =>
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
  if (!sameArray(missingItemIds, expectedMissingItemIds)
    || !sameArray(unestimatedItemIds, expectedUnestimatedItemIds)
    || !sameObject(overruns, expectedOverruns)
    || complete !== scheduleComplete
    || breakdownComplete !== (unestimatedItemIds.length === 0)
    || totalDurationSeconds !== expectedTotalDurationSeconds
    || !sameObject(expectedFinish, expectedFinishClock)
    || rawRunSheet.status !== expectedStatus) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'runSheet summary does not match its canonical rows.'
    );
  }

  return {
    schemaVersion: SERVICE_RUN_SHEET_SCHEMA_VERSION,
    kind: SERVICE_RUN_SHEET_KIND,
    projectId: project.id,
    projectRevision: project.revision,
    serviceDate: project.serviceDate,
    startTime: planningStartTime,
    status: rawRunSheet.status,
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

function normalizeWaivers(rawWaivers) {
  if (!Array.isArray(rawWaivers)
    || rawWaivers.length > MAX_SERVICE_READINESS_WAIVERS) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `planning.readinessWaivers must contain at most ${MAX_SERVICE_READINESS_WAIVERS} entries.`
    );
  }
  const byCheckId = new Map();
  for (const [index, rawWaiver] of rawWaivers.entries()) {
    const field = `planning.readinessWaivers[${index}]`;
    requireExactKeys(rawWaiver, ['checkId', 'reason'], field);
    if (!SERVICE_READINESS_CHECK_IDS.includes(rawWaiver.checkId)
      || UNWAIVABLE_CHECK_IDS.has(rawWaiver.checkId)
      || byCheckId.has(rawWaiver.checkId)) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field}.checkId must identify one unique waivable readiness check.`,
        { field, checkId: rawWaiver.checkId }
      );
    }
    const reason = requireString(rawWaiver.reason, `${field}.reason`, 500, {
      required: true
    });
    if (reason !== reason.trim().normalize('NFC')) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field}.reason must use canonical trimmed text.`,
        { field }
      );
    }
    byCheckId.set(rawWaiver.checkId, {
      checkId: rawWaiver.checkId,
      reason
    });
  }
  return SERVICE_READINESS_CHECK_IDS
    .filter(checkId => byCheckId.has(checkId))
    .map(checkId => byCheckId.get(checkId));
}

function normalizeHandoffServing(rawServing, itemIds) {
  let serving;
  try {
    serving = normalizeServiceProjectServing(rawServing, {
      itemIds: [...itemIds]
    });
  } catch (error) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'planning.serving is not a valid sanitized serving plan.',
      { cause: error?.code || error?.name }
    );
  }
  if (!sameObject(serving, rawServing)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'planning.serving must already use canonical sanitized values.'
    );
  }
  return serving;
}

function normalizePlanning(rawPlanning, schemaVersion, itemIds = new Set()) {
  if (rawPlanning === null) return null;
  requireExactKeys(
    rawPlanning,
    [
      'status',
      'startTime',
      'teamNotes',
      'readinessWaivers',
      ...(schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION ? ['serving'] : [])
    ],
    'planning'
  );
  if (!SERVICE_PLAN_STATUSES.includes(rawPlanning.status)) {
    fail('INVALID_SERVICE_HANDOFF', 'planning.status is invalid.', {
      status: rawPlanning.status
    });
  }
  if (typeof rawPlanning.startTime !== 'string'
    || !START_TIME_PATTERN.test(rawPlanning.startTime)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'planning.startTime must use 24-hour local venue time as HH:mm.'
    );
  }
  const planning = {
    status: rawPlanning.status,
    startTime: rawPlanning.startTime,
    teamNotes: requireString(rawPlanning.teamNotes, 'planning.teamNotes', 4000),
    readinessWaivers: normalizeWaivers(rawPlanning.readinessWaivers)
  };
  if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
    planning.serving = normalizeHandoffServing(rawPlanning.serving, itemIds);
  }
  return planning;
}

function normalizeReadiness(rawReadiness, planning) {
  requireExactKeys(
    rawReadiness,
    ['ready', 'checks', 'waivedCheckIds'],
    'readiness'
  );
  if (typeof rawReadiness.ready !== 'boolean') {
    fail('INVALID_SERVICE_HANDOFF', 'readiness.ready must be a boolean.');
  }
  if (!Array.isArray(rawReadiness.checks)
    || rawReadiness.checks.length !== SERVICE_READINESS_CHECK_IDS.length) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'readiness.checks must contain every readiness check in contract order.'
    );
  }
  const checks = rawReadiness.checks.map((rawCheck, index) => {
    const field = `readiness.checks[${index}]`;
    requireExactKeys(rawCheck, ['id', 'status'], field);
    if (rawCheck.id !== SERVICE_READINESS_CHECK_IDS[index]
      || !READINESS_STATUSES.includes(rawCheck.status)) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field} does not match the readiness contract.`,
        { field, id: rawCheck.id, status: rawCheck.status }
      );
    }
    return { id: rawCheck.id, status: rawCheck.status };
  });
  const expectedWaivedCheckIds = checks
    .filter(check => check.status === 'waived')
    .map(check => check.id);
  if (!sameArray(rawReadiness.waivedCheckIds, expectedWaivedCheckIds)) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'readiness.waivedCheckIds must exactly match waived checks.'
    );
  }
  const expectedReady = !checks.some(check => check.status === 'blocker');
  if (rawReadiness.ready !== expectedReady) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'readiness.ready must match the absence of blocking checks.'
    );
  }

  const waiverIds = new Set(
    planning?.readinessWaivers.map(waiver => waiver.checkId) || []
  );
  for (const check of checks) {
    if (check.status === 'waived' && !waiverIds.has(check.id)) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `Readiness check ${check.id} has no reviewed planning waiver.`
      );
    }
    if (check.status === 'blocker' && waiverIds.has(check.id)) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `Readiness check ${check.id} ignores its reviewed planning waiver.`
      );
    }
  }
  if (!planning && expectedWaivedCheckIds.length > 0) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'An unplanned service cannot carry readiness waivers.'
    );
  }

  return {
    ready: rawReadiness.ready,
    checks,
    waivedCheckIds: [...rawReadiness.waivedCheckIds]
  };
}

function normalizeCueRecord(rawCue, cueId, schemaVersion, runSheet = null) {
  const field = `cues.${cueId}`;
  requireExactKeys(
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
  if (rawCue.id !== cueId || !CUE_ID_PATTERN.test(cueId)) {
    fail('INVALID_SERVICE_HANDOFF', `${field}.id is invalid.`, { cueId });
  }
  if (!CUE_KINDS.includes(rawCue.kind)) {
    fail('INVALID_SERVICE_HANDOFF', `${field}.kind is invalid.`, {
      cueId,
      kind: rawCue.kind
    });
  }
  if (!Array.isArray(rawCue.groupPath)
    || rawCue.groupPath.length > MAX_GROUP_DEPTH) {
    fail('INVALID_SERVICE_HANDOFF', `${field}.groupPath is invalid.`, {
      cueId
    });
  }
  if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
    requireDenseArray(rawCue.groupPath, MAX_GROUP_DEPTH, `${field}.groupPath`);
  }
  if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
    requireDenseArray(
      rawCue.itemPathIds,
      MAX_GROUP_DEPTH + 1,
      `${field}.itemPathIds`,
      { minimum: 1 }
    );
  }
  const itemId = requireProjectId(rawCue.itemId, `${field}.itemId`);
  const groupPath = rawCue.groupPath.map((part, index) =>
    requireString(part, `${field}.groupPath[${index}]`, 160, {
      required: true
    }));
  const normalized = {
    id: cueId,
    itemId,
    title: requireString(rawCue.title, `${field}.title`, 200, { required: true }),
    kind: rawCue.kind,
    groupPath,
    operatorNotes: requireString(
      rawCue.operatorNotes,
      `${field}.operatorNotes`,
      4000
    )
  };
  if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
    const itemPathIds = rawCue.itemPathIds.map((pathItemId, index) =>
      requireProjectId(pathItemId, `${field}.itemPathIds[${index}]`));
    if (new Set(itemPathIds).size !== itemPathIds.length
      || itemPathIds[itemPathIds.length - 1] !== itemId) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        `${field}.itemPathIds must contain each ancestor followed by itemId.`,
        { field }
      );
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
          fail(
            'INVALID_SERVICE_HANDOFF',
            `${field}.itemPathIds do not match the canonical run-sheet hierarchy.`,
            { field, index }
          );
        }
      }
    }
    normalized.itemPathIds = itemPathIds;
  }
  return normalized;
}

function normalizeServiceHandoff(raw) {
  if (!isRecord(raw)
    || !SERVICE_HANDOFF_SCHEMA_VERSIONS.includes(raw.schemaVersion)
    || raw.kind !== SERVICE_HANDOFF_KIND) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      `Service handoff must be a ${SERVICE_HANDOFF_KIND} schema v1 or v${SERVICE_HANDOFF_SCHEMA_VERSION} document.`
    );
  }
  const schemaVersion = raw.schemaVersion;
  requireExactKeys(
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
    'Service handoff'
  );

  requireExactKeys(
    raw.project,
    ['id', 'revisionId', 'revision', 'contentHash', 'title', 'serviceDate'],
    'project'
  );
  const project = {
    id: requireProjectId(raw.project.id, 'project.id'),
    revisionId: requireSha256(raw.project.revisionId, 'project.revisionId'),
    revision: requireRevision(raw.project.revision, 'project.revision'),
    contentHash: requireSha256(raw.project.contentHash, 'project.contentHash'),
    title: requireString(raw.project.title, 'project.title', 200, {
      required: true
    }),
    serviceDate: requireString(
      raw.project.serviceDate,
      'project.serviceDate',
      10,
      { required: true }
    )
  };
  if (!isValidIsoDate(project.serviceDate)) {
    fail('INVALID_SERVICE_HANDOFF', 'project.serviceDate must be an ISO date.');
  }

  let runSheet = null;
  let servingItemIds = new Set();
  if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
    if ((raw.planning === null) !== (raw.runSheet === null)) {
      fail(
        'INVALID_SERVICE_HANDOFF',
        'runSheet must be null exactly when planning is null.'
      );
    }
    if (raw.planning !== null) {
      if (!isRecord(raw.planning)
        || typeof raw.planning.startTime !== 'string'
        || !START_TIME_PATTERN.test(raw.planning.startTime)) {
        fail(
          'INVALID_SERVICE_HANDOFF',
          'planning.startTime must use 24-hour local venue time as HH:mm.'
        );
      }
      runSheet = normalizeRunSheet(
        raw.runSheet,
        project,
        raw.planning.startTime
      );
      servingItemIds = new Set(runSheet.rows.map(row => row.itemId));
    }
  }
  const planning = normalizePlanning(raw.planning, schemaVersion, servingItemIds);
  const readiness = normalizeReadiness(raw.readiness, planning);

  if (!Array.isArray(raw.cueIds)
    || raw.cueIds.length < 1
    || raw.cueIds.length > 2000
    || new Set(raw.cueIds).size !== raw.cueIds.length
    || raw.cueIds.some(cueId =>
      typeof cueId !== 'string' || !CUE_ID_PATTERN.test(cueId))) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'cueIds must contain 1 to 2000 unique compiled cue IDs.'
    );
  }
  if (!isRecord(raw.cues)
    || Object.keys(raw.cues).length !== raw.cueIds.length
    || Object.keys(raw.cues).some(cueId => !raw.cueIds.includes(cueId))) {
    fail(
      'INVALID_SERVICE_HANDOFF',
      'cueIds and cues must contain exactly the same cue IDs.'
    );
  }
  const cues = {};
  for (const cueId of raw.cueIds) {
    cues[cueId] = normalizeCueRecord(
      raw.cues[cueId],
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
    cueIds: [...raw.cueIds],
    cues
  };
  if (schemaVersion === SERVICE_HANDOFF_SCHEMA_VERSION) {
    normalized.runSheet = runSheet;
  }
  return deepFreeze(normalized);
}

function validateReadinessReport(readiness, project, timeline, planning) {
  if (!isRecord(readiness)
    || readiness.schemaVersion !== SERVICE_READINESS_SCHEMA_VERSION
    || readiness.kind !== SERVICE_READINESS_REPORT_KIND
    || readiness.projectId !== project.id
    || readiness.projectRevision !== project.revision
    || readiness.projectContentHash !== timeline.projectContentHash
    || readiness.cueCount !== timeline.cueIds.length
    || !isRecord(readiness.planning)
    || readiness.planning.present !== Boolean(project.planning)
    || readiness.planning.status !== (project.planning?.status || null)
    || typeof readiness.ready !== 'boolean'
    || !Array.isArray(readiness.checks)
    || !Array.isArray(readiness.blockers)
    || !Array.isArray(readiness.waivedChecks)) {
    fail(
      'SERVICE_HANDOFF_SOURCE_MISMATCH',
      'The readiness report does not belong to the exact compiled project.'
    );
  }

  const checks = readiness.checks.map((check, index) => {
    if (!isRecord(check)
      || check.id !== SERVICE_READINESS_CHECK_IDS[index]
      || !READINESS_STATUSES.includes(check.status)) {
      fail(
        'SERVICE_HANDOFF_SOURCE_MISMATCH',
        'The readiness report does not contain the fixed readiness contract.'
      );
    }
    return { id: check.id, status: check.status };
  });
  if (checks.length !== SERVICE_READINESS_CHECK_IDS.length) {
    fail(
      'SERVICE_HANDOFF_SOURCE_MISMATCH',
      'The readiness report does not contain every readiness check.'
    );
  }

  const blockerIds = checks
    .filter(check => check.status === 'blocker')
    .map(check => check.id);
  const reportBlockerIds = readiness.blockers.map(blocker => blocker?.checkId);
  const waivedCheckIds = checks
    .filter(check => check.status === 'waived')
    .map(check => check.id);
  const reportWaivedIds = readiness.waivedChecks.map(waiver => waiver?.checkId);
  if (!sameArray(blockerIds, reportBlockerIds)
    || !sameArray(waivedCheckIds, reportWaivedIds)
    || readiness.ready !== (blockerIds.length === 0)) {
    fail(
      'SERVICE_HANDOFF_SOURCE_MISMATCH',
      'The readiness report summary does not match its checks.'
    );
  }

  const waiverByCheckId = new Map(
    (planning?.readinessWaivers || []).map(waiver => [waiver.checkId, waiver])
  );
  for (const [index, reportWaiver] of readiness.waivedChecks.entries()) {
    const reviewed = waiverByCheckId.get(reportWaiver?.checkId);
    if (!reviewed || reportWaiver.reason !== reviewed.reason) {
      fail(
        'SERVICE_HANDOFF_SOURCE_MISMATCH',
        `Readiness waiver ${index + 1} does not match the reviewed planning decision.`
      );
    }
  }
  for (const check of checks) {
    if (check.status === 'blocker' && waiverByCheckId.has(check.id)) {
      fail(
        'SERVICE_HANDOFF_SOURCE_MISMATCH',
        `Readiness check ${check.id} ignores its reviewed planning waiver.`
      );
    }
  }
  return {
    ready: readiness.ready,
    checks,
    waivedCheckIds
  };
}

function deriveServiceHandoff(options = {}) {
  if (!isRecord(options)
    || Object.keys(options).some(key =>
      !['project', 'revisionId', 'timeline', 'readiness'].includes(key))) {
    fail(
      'INVALID_SERVICE_HANDOFF_SOURCE',
      'Service handoff derivation requires only project, revisionId, timeline, and readiness.'
    );
  }
  const project = normalizeServiceProject(options.project, { now: new Date(0) });
  const revisionId = requireSha256(options.revisionId, 'revisionId');
  const serializedProject = serializeServiceProject(project);
  const expectedRevisionId = crypto
    .createHash('sha256')
    .update(serializedProject)
    .digest('hex');
  if (revisionId !== expectedRevisionId) {
    fail(
      'SERVICE_HANDOFF_SOURCE_MISMATCH',
      'The revision ID does not identify the exact normalized project bytes.',
      { expectedRevisionId, revisionId }
    );
  }

  if (!isRecord(options.timeline)) {
    fail('INVALID_SERVICE_HANDOFF_SOURCE', 'The compiled timeline is required.');
  }
  const timeline = normalizeCueTimeline(options.timeline, { now: new Date(0) });
  if (options.timeline.kind !== CUE_TIMELINE_KIND
    || !Number.isSafeInteger(options.timeline.compilerVersion)
    || options.timeline.projectId !== project.id
    || options.timeline.projectRevision !== project.revision
    || options.timeline.projectContentHash !== expectedRevisionId
    || timeline.id !== `compiled:${project.id}`
    || timeline.title !== project.title
    || timeline.serviceDate !== project.serviceDate
    || timeline.revision !== project.revision) {
    fail(
      'SERVICE_HANDOFF_SOURCE_MISMATCH',
      'The compiled timeline does not belong to the exact saved project.'
    );
  }
  const expectedTimeline = compileServiceProject(project);
  if (serializeCueTimeline(options.timeline) !== serializeCueTimeline(expectedTimeline)) {
    fail(
      'SERVICE_HANDOFF_SOURCE_MISMATCH',
      'The supplied timeline is not the deterministic compilation of the saved project.'
    );
  }

  const planning = project.planning
    ? {
        status: project.planning.status,
        startTime: project.planning.startTime,
        teamNotes: project.planning.teamNotes || '',
        readinessWaivers: (project.planning.readinessWaivers || []).map(waiver => ({
          checkId: waiver.checkId,
          reason: waiver.reason
        })),
        serving: normalizeServiceProjectServing(
          project.planning.serving || {
            schemaVersion: SERVICE_PROJECT_SERVING_SCHEMA_VERSION,
            assignments: []
          },
          { itemIds: Object.keys(project.items) }
        )
      }
    : null;
  const runSheet = project.planning ? buildServiceRunSheet(project) : null;
  const readiness = validateReadinessReport(
    options.readiness,
    project,
    options.timeline,
    planning
  );
  const cues = {};
  const itemPathIds = itemId => {
    const path = [];
    const seen = new Set();
    let currentItemId = itemId;
    while (currentItemId !== null) {
      if (!project.items[currentItemId]
        || seen.has(currentItemId)
        || path.length > MAX_GROUP_DEPTH) {
        fail(
          'SERVICE_HANDOFF_SOURCE_MISMATCH',
          `Compiled cue item ${itemId} has no canonical project ancestry.`
        );
      }
      seen.add(currentItemId);
      path.unshift(currentItemId);
      currentItemId = project._index.parentByItemId[currentItemId];
      if (currentItemId === undefined) {
        fail(
          'SERVICE_HANDOFF_SOURCE_MISMATCH',
          `Compiled cue item ${itemId} has no canonical project ancestry.`
        );
      }
    }
    return path;
  };
  for (const cueId of timeline.cueIds) {
    const cue = timeline.cues[cueId];
    if (!cue.itemId) {
      fail(
        'SERVICE_HANDOFF_SOURCE_MISMATCH',
        `Compiled cue ${cueId} does not identify its source service item.`
      );
    }
    cues[cueId] = {
      id: cue.id,
      itemId: cue.itemId,
      title: cue.title,
      kind: cue.kind,
      groupPath: [...cue.groupPath],
      operatorNotes: cue.operatorNotes,
      itemPathIds: itemPathIds(cue.itemId)
    };
  }

  return normalizeServiceHandoff({
    schemaVersion: SERVICE_HANDOFF_SCHEMA_VERSION,
    kind: SERVICE_HANDOFF_KIND,
    project: {
      id: project.id,
      revisionId,
      revision: project.revision,
      contentHash: options.timeline.projectContentHash,
      title: project.title,
      serviceDate: project.serviceDate
    },
    planning,
    readiness,
    runSheet,
    cueIds: [...timeline.cueIds],
    cues
  });
}

function serializeCueTimeline(timeline) {
  return `${JSON.stringify(stableObject(timeline), null, 2)}\n`;
}

function serializeServiceHandoff(raw) {
  return `${JSON.stringify(stableObject(normalizeServiceHandoff(raw)), null, 2)}\n`;
}

module.exports = {
  LEGACY_SERVICE_HANDOFF_SCHEMA_VERSION,
  SERVICE_HANDOFF_KIND,
  SERVICE_HANDOFF_SCHEMA_VERSION,
  SERVICE_HANDOFF_SCHEMA_VERSIONS,
  ServiceHandoffError,
  deriveServiceHandoff,
  normalizeServiceHandoff,
  serializeServiceHandoff
};
