'use strict';

const {
  POWERPOINT_COMPANION_WORKFLOW_MODE,
  ServiceProjectError,
  normalizeServiceProject
} = require('./ServiceProject');

const SERVICE_RUN_SHEET_SCHEMA_VERSION = 1;
const SERVICE_RUN_SHEET_KIND = 'syncshow-service-run-sheet';
const SECONDS_PER_DAY = 24 * 60 * 60;

function fail(code, message, details = {}) {
  throw new ServiceProjectError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function hasPlannedDuration(item) {
  return Object.prototype.hasOwnProperty.call(
    item,
    'plannedDurationSeconds'
  );
}

function addDurations(values) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Convert a non-negative offset to venue wall-clock fields. Service projects
 * intentionally store a local service date and HH:mm rather than a timezone,
 * so this calculation must not manufacture a UTC instant.
 */
function wallClockAtOffset(serviceDate, startTime, offsetSeconds) {
  const [year, month, day] = serviceDate.split('-').map(Number);
  const [hour, minute] = startTime.split(':').map(Number);
  const totalSeconds = (hour * 60 * 60) + (minute * 60) + offsetSeconds;
  const dayOffset = Math.floor(totalSeconds / SECONDS_PER_DAY);
  const secondsInDay = totalSeconds % SECONDS_PER_DAY;
  const clockHour = Math.floor(secondsInDay / 3600);
  const clockMinute = Math.floor((secondsInDay % 3600) / 60);
  const clockSecond = secondsInDay % 60;
  const date = new Date(Date.UTC(year, month - 1, day + dayOffset))
    .toISOString()
    .slice(0, 10);
  return {
    date,
    time: [
      String(clockHour).padStart(2, '0'),
      String(clockMinute).padStart(2, '0'),
      String(clockSecond).padStart(2, '0')
    ].join(':'),
    dayOffset
  };
}

/**
 * Derive the operator's semantic run sheet without persisting calculated
 * clocks. An explicitly timed group owns one outer service slot. Its children
 * may describe an internal breakdown, but they are never added to that slot a
 * second time. An untimed group derives its slot only when every child slot is
 * known.
 */
function buildServiceRunSheet(rawProject) {
  const project = normalizeServiceProject(rawProject, { now: new Date(0) });
  if (project.workflowMode === POWERPOINT_COMPANION_WORKFLOW_MODE) {
    fail(
      'SERVICE_RUN_SHEET_NOT_NATIVE',
      'A timed run sheet requires a native SyncShow service.'
    );
  }
  if (!project.planning) {
    fail(
      'SERVICE_PLAN_REQUIRED',
      'A timed run sheet requires a planned service.'
    );
  }

  const summaries = new Map();
  const unestimatedItemIds = [];

  const summarize = itemId => {
    const item = project.items[itemId];
    const explicit = hasPlannedDuration(item);
    if (item.kind !== 'group') {
      if (!explicit) unestimatedItemIds.push(item.id);
      const summary = {
        effectiveDurationSeconds: explicit
          ? item.plannedDurationSeconds
          : null,
        childDurationSeconds: null,
        timingSource: explicit ? 'explicit' : 'missing',
        blockingMissingItemIds: explicit ? [] : [item.id],
        remainingSeconds: null,
        overrunSeconds: null
      };
      summaries.set(item.id, summary);
      return summary;
    }

    const childSummaries = item.childIds.map(summarize);
    const childrenKnown = childSummaries.every(summary =>
      summary.effectiveDurationSeconds !== null);
    const childDurationSeconds = childrenKnown
      ? addDurations(childSummaries.map(summary =>
          summary.effectiveDurationSeconds))
      : null;
    const effectiveDurationSeconds = explicit
      ? item.plannedDurationSeconds
      : childDurationSeconds;
    const blockingMissingItemIds = effectiveDurationSeconds === null
      ? childSummaries.flatMap(summary => summary.blockingMissingItemIds)
      : [];
    const remainingSeconds = explicit && childDurationSeconds !== null
      ? Math.max(0, item.plannedDurationSeconds - childDurationSeconds)
      : null;
    const overrunSeconds = explicit && childDurationSeconds !== null
      ? Math.max(0, childDurationSeconds - item.plannedDurationSeconds)
      : null;
    const summary = {
      effectiveDurationSeconds,
      childDurationSeconds,
      timingSource: explicit
        ? 'explicit'
        : childrenKnown
          ? 'children'
          : 'missing',
      blockingMissingItemIds,
      remainingSeconds,
      overrunSeconds
    };
    summaries.set(item.id, summary);
    return summary;
  };

  const rootSummaries = project.rootItemIds.map(summarize);
  const scheduleComplete = rootSummaries.every(summary =>
    summary.effectiveDurationSeconds !== null);
  const totalDurationSeconds = scheduleComplete
    ? addDurations(rootSummaries.map(summary =>
        summary.effectiveDurationSeconds))
    : null;
  const missingItemIds = rootSummaries.flatMap(summary =>
    summary.blockingMissingItemIds);
  const rows = [];
  const overruns = [];

  const appendRow = (
    itemId,
    parentItemId,
    depth,
    startOffsetSeconds,
    coveredByItemId
  ) => {
    const item = project.items[itemId];
    const summary = summaries.get(itemId);
    const explicit = hasPlannedDuration(item);
    const endOffsetSeconds =
      startOffsetSeconds !== null
      && summary.effectiveDurationSeconds !== null
        ? startOffsetSeconds + summary.effectiveDurationSeconds
        : null;
    const row = {
      itemId,
      parentItemId,
      depth,
      kind: item.kind,
      title: item.title,
      plannedDurationSeconds: explicit
        ? item.plannedDurationSeconds
        : null,
      effectiveDurationSeconds: summary.effectiveDurationSeconds,
      timingSource: summary.timingSource,
      coveredByItemId,
      startOffsetSeconds,
      endOffsetSeconds,
      start: startOffsetSeconds === null
        ? null
        : wallClockAtOffset(
            project.serviceDate,
            project.planning.startTime,
            startOffsetSeconds
          ),
      end: endOffsetSeconds === null
        ? null
        : wallClockAtOffset(
            project.serviceDate,
            project.planning.startTime,
            endOffsetSeconds
          )
    };
    if (item.kind === 'group') {
      row.childDurationSeconds = summary.childDurationSeconds;
      row.remainingSeconds = summary.remainingSeconds;
      row.overrunSeconds = summary.overrunSeconds;
      if (summary.overrunSeconds > 0) {
        overruns.push({
          groupItemId: item.id,
          plannedDurationSeconds: item.plannedDurationSeconds,
          childDurationSeconds: summary.childDurationSeconds,
          overrunSeconds: summary.overrunSeconds
        });
      }
    }
    rows.push(row);

    if (item.kind !== 'group') return;
    let childStartOffsetSeconds = startOffsetSeconds;
    const childCoveredByItemId = explicit ? item.id : coveredByItemId;
    for (const childId of item.childIds) {
      appendRow(
        childId,
        item.id,
        depth + 1,
        childStartOffsetSeconds,
        childCoveredByItemId
      );
      const childDurationSeconds =
        summaries.get(childId).effectiveDurationSeconds;
      childStartOffsetSeconds =
        childStartOffsetSeconds !== null
        && childDurationSeconds !== null
          ? childStartOffsetSeconds + childDurationSeconds
          : null;
    }
  };

  let rootStartOffsetSeconds = 0;
  for (const rootItemId of project.rootItemIds) {
    appendRow(rootItemId, null, 0, rootStartOffsetSeconds, null);
    const rootDurationSeconds =
      summaries.get(rootItemId).effectiveDurationSeconds;
    rootStartOffsetSeconds =
      rootStartOffsetSeconds !== null
      && rootDurationSeconds !== null
        ? rootStartOffsetSeconds + rootDurationSeconds
        : null;
  }

  const status = overruns.length > 0
    ? 'conflict'
    : scheduleComplete
      ? 'complete'
      : 'incomplete';
  return deepFreeze({
    schemaVersion: SERVICE_RUN_SHEET_SCHEMA_VERSION,
    kind: SERVICE_RUN_SHEET_KIND,
    projectId: project.id,
    projectRevision: project.revision,
    serviceDate: project.serviceDate,
    startTime: project.planning.startTime,
    status,
    complete: scheduleComplete,
    breakdownComplete: unestimatedItemIds.length === 0,
    totalDurationSeconds,
    expectedFinish: totalDurationSeconds === null
      ? null
      : wallClockAtOffset(
          project.serviceDate,
          project.planning.startTime,
          totalDurationSeconds
        ),
    missingItemIds,
    unestimatedItemIds,
    overruns,
    rows
  });
}

module.exports = {
  SERVICE_RUN_SHEET_KIND,
  SERVICE_RUN_SHEET_SCHEMA_VERSION,
  buildServiceRunSheet
};
