'use strict';

// Source-side data setup for the packaged application verifier. This module is
// deliberately not an Electron entrypoint and must never be passed to the
// packaged executable. It creates only the deterministic input data that the
// packaged Main/preload/renderer will review, mark Ready, publish, and restore.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nativeFs = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  analyzeServiceProjectReadiness,
  setServicePlanStatus
} = require('../../src/services/project');
const {
  ISOLATED_TEST_USER_DATA_MARKER
} = require('../../src/services/runtime/IsolatedTestUserData');
const {
  READY_PROJECT_ID,
  createTrackedNativeWeeklyService
} = require('../../test/fixtures/native-weekly-service');

const NATIVE_WEEKLY_TITLE = 'Native Weekly Service — August 9';
const PROFILE_MARKER_SOURCE = 'SyncShow isolated test user data v1\n';
const WEEKLY_CHECK_IDS = Object.freeze([
  'compilable-nonempty',
  'song-present',
  'exact-sermon-link',
  'linked-sermon-material',
  'sermon-reading-before-material',
  'channel-visible-content'
]);

function statIdentity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs
  });
}

async function readStableNoFollow(filePath, maximumBytes, label) {
  const before = await fs.lstat(filePath);
  assert.equal(before.isFile(), true, `${label} must be a regular file.`);
  assert.equal(before.isSymbolicLink(), false, `${label} must not be a symlink.`);
  assert.equal(before.size > 0 && before.size <= maximumBytes, true);
  assert.equal(await fs.realpath(filePath), filePath);
  const handle = await fs.open(
    filePath,
    nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW
  );
  try {
    const opened = await handle.stat();
    assert.deepEqual(statIdentity(opened), statIdentity(before));
    const bytes = await handle.readFile();
    assert.equal(bytes.length, before.size);
    assert.deepEqual(statIdentity(await handle.stat()), statIdentity(before));
    assert.deepEqual(statIdentity(await fs.lstat(filePath)), statIdentity(before));
    return Object.freeze({
      path: filePath,
      source: bytes.toString('utf8'),
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      mode: before.mode & 0o777,
      statIdentity: statIdentity(before)
    });
  } finally {
    await handle.close();
  }
}

async function pathExists(candidatePath) {
  try {
    await fs.lstat(candidatePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function seedTrackedPlanningProfile(profilePath) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) {
    throw new TypeError('The packaged planning seed requires an absolute profile path.');
  }
  const profileStats = await fs.lstat(profilePath);
  assert.equal(profileStats.isDirectory(), true);
  assert.equal(profileStats.isSymbolicLink(), false);
  assert.equal(await fs.realpath(profilePath), profilePath);
  assert.equal(profileStats.mode & 0o777, 0o700);
  const baselineEntries = await fs.readdir(profilePath, { withFileTypes: true });
  assert.equal(
    baselineEntries.length,
    1,
    'The external seed requires an otherwise-empty isolated profile baseline.'
  );
  assert.equal(baselineEntries[0].name, ISOLATED_TEST_USER_DATA_MARKER);
  assert.equal(baselineEntries[0].isFile(), true);
  assert.equal(baselineEntries[0].isSymbolicLink(), false);
  const markerPath = path.join(profilePath, ISOLATED_TEST_USER_DATA_MARKER);
  const markerStats = await fs.lstat(markerPath);
  assert.equal(markerStats.isFile(), true);
  assert.equal(markerStats.isSymbolicLink(), false);
  assert.equal(markerStats.size, Buffer.byteLength(PROFILE_MARKER_SOURCE, 'utf8'));
  assert.equal(markerStats.mode & 0o777, 0o600);
  assert.equal(await fs.readFile(markerPath, 'utf8'), PROFILE_MARKER_SOURCE);
  assert.equal(
    await pathExists(path.join(profilePath, 'prepared-service')),
    false,
    'The external seed must not create or replace a prepared-service pointer.'
  );
  assert.equal(
    await pathExists(path.join(profilePath, 'show-packages')),
    false,
    'The external seed must not create a ShowPackage.'
  );

  const fixture = await createTrackedNativeWeeklyService(profilePath);
  const planningProject = setServicePlanStatus(
    fixture.ready.project,
    'planning'
  );
  const planningStored = await fixture.projectStore.save(planningProject, {
    expectedRevisionId: fixture.ready.revisionId,
    reason: 'packaged-operational-planning-external-seed'
  });
  const readiness = analyzeServiceProjectReadiness(planningStored.project);

  assert.equal(planningStored.project.id, READY_PROJECT_ID);
  assert.equal(planningStored.project.title, NATIVE_WEEKLY_TITLE);
  assert.equal(planningStored.project.revision, 3);
  assert.equal(planningStored.project.planning.status, 'planning');
  assert.match(planningStored.revisionId, /^[a-f0-9]{64}$/u);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.waivedChecks, []);
  assert.deepEqual(
    readiness.checks.map(check => [check.id, check.status]),
    WEEKLY_CHECK_IDS.map(checkId => [checkId, 'pass'])
  );
  assert.equal(
    await pathExists(path.join(profilePath, 'prepared-service')),
    false
  );
  assert.equal(
    await pathExists(path.join(profilePath, 'show-packages')),
    false
  );

  const projectStorageKey = crypto.createHash('sha256')
    .update(planningStored.project.id)
    .digest('hex');
  const planningPointerPath = path.join(
    profilePath,
    'service-projects',
    `project-${projectStorageKey}`,
    'current.json'
  );
  const planningPointer = await readStableNoFollow(
    planningPointerPath,
    64 * 1024,
    'seeded planning current pointer'
  );
  assert.equal(planningPointer.mode, 0o600);
  let planningPointerValue;
  try {
    planningPointerValue = JSON.parse(planningPointer.source);
  } catch (error) {
    assert.fail(`Seeded planning current pointer is not JSON: ${error.message}`);
  }
  assert.deepEqual(Object.keys(planningPointerValue).sort(), [
    'schemaVersion',
    'projectId',
    'revisionId',
    'projectRevision',
    'updatedAt',
    'reason'
  ].sort());
  assert.equal(planningPointerValue.schemaVersion, 1);
  assert.equal(planningPointerValue.projectId, planningStored.project.id);
  assert.equal(planningPointerValue.revisionId, planningStored.revisionId);
  assert.equal(planningPointerValue.projectRevision, 3);
  assert.equal(planningPointerValue.updatedAt, planningStored.project.updatedAt);
  assert.equal(
    planningPointerValue.reason,
    'packaged-operational-planning-external-seed'.slice(0, 40)
  );

  const planningRevisionPath = path.join(
    profilePath,
    'service-projects',
    `project-${projectStorageKey}`,
    'revisions',
    `${planningStored.revisionId}.json`
  );
  const planningRevision = await readStableNoFollow(
    planningRevisionPath,
    16 * 1024 * 1024,
    'seeded immutable planning revision'
  );
  assert.equal(planningRevision.mode, 0o600);
  assert.equal(planningRevision.sha256, planningStored.revisionId);
  let planningRevisionValue;
  try {
    planningRevisionValue = JSON.parse(planningRevision.source);
  } catch (error) {
    assert.fail(`Seeded immutable planning revision is not JSON: ${error.message}`);
  }
  assert.deepEqual(planningRevisionValue, planningStored.project);

  const expectedPlanningStorage = Object.freeze({
    pointer: Object.freeze({ ...planningPointer, value: planningPointerValue }),
    revision: Object.freeze({ ...planningRevision, value: planningRevisionValue })
  });

  return Object.freeze({
    planningStored: Object.freeze({
      project: planningStored.project,
      revisionId: planningStored.revisionId
    }),
    expectedPlanningPointer: Object.freeze({
      source: planningPointer.source,
      size: planningPointer.size,
      sha256: planningPointer.sha256,
      mode: planningPointer.mode,
      statIdentity: planningPointer.statIdentity,
      value: planningPointerValue
    }),
    expectedPlanningStorage,
    evidence: Object.freeze({
      provenance: 'external-test-seed',
      packagedBehavior: false,
      description:
        'Current-source test setup created a deterministic tracked project; the packaged app performs every asserted lifecycle transition and publish.',
      isolatedBaseline: Object.freeze({
        marker: ISOLATED_TEST_USER_DATA_MARKER,
        exactMarkerSource: true,
        profileMode: '0700',
        markerMode: '0600',
        otherEntries: 0
      }),
      projectId: planningStored.project.id,
      title: planningStored.project.title,
      projectRevision: planningStored.project.revision,
      revisionId: planningStored.revisionId,
      planningPointerSha256: planningPointer.sha256,
      planningRevisionSha256: planningRevision.sha256,
      rawPlanningStorageBound: true,
      planningStatus: planningStored.project.planning.status,
      readinessReady: readiness.ready,
      checkStatuses: readiness.checks.map(check => ({
        id: check.id,
        status: check.status
      })),
      preparedServiceAbsent: true,
      showPackagesAbsent: true
    })
  });
}

module.exports = {
  NATIVE_WEEKLY_TITLE,
  READY_PROJECT_ID,
  WEEKLY_CHECK_IDS,
  seedTrackedPlanningProfile
};
