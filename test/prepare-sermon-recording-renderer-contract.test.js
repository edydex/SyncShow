'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const html = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const css = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function prepareExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, URL, window }, {
    filename: 'prepare-controller.js'
  });
  return window.SyncShowPrepare;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueIdCount(id) {
  return (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
}

test('post-service recording intake explains private preservation and reviewed URLs', () => {
  for (const id of [
    'prepareSermonPostServiceRecordingState',
    'prepareSermonPostServiceRecordingDetail',
    'prepareSermonPostServiceRecordingPrivacy',
    'btnChooseSermonRecording',
    'btnPlaySermonRecording'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }

  const cardStart = html.indexOf('id="prepareSermonPostService"');
  const cardEnd = html.indexOf('</section>', cardStart);
  const card = html.slice(cardStart, cardEnd);
  assert.match(card, />Choose recording file…<\/button>/);
  assert.match(card, />Review local recording<\/button>/);
  assert.match(
    card,
    /copied into SyncShow’s private local storage on this computer/
  );
  assert.match(
    card,
    /bytes and local path are not uploaded, published, or sent to Community/
  );
  assert.match(
    card,
    /verified filename, type, hash, and size are saved in the sermon record and may later sync to Community/
  );
  assert.match(card, /Automatic recording cleanup is not available yet/);
  assert.match(
    card,
    /aria-describedby="prepareSermonPostServiceStatus prepareSermonPostServiceRecordingPrivacy prepareSermonPostServiceRecordingDetail"/
  );

  const dialogStart = html.indexOf('<dialog id="sermonPostServiceDialog"');
  const dialogEnd = html.indexOf('</dialog>', dialogStart);
  const dialog = html.slice(dialogStart, dialogEnd);
  assert.match(
    dialog,
    /Adding a recording URL keeps any recording already preserved/
  );
  assert.match(
    dialog,
    /Leaving a Waiting recording URL blank keeps any locally preserved recording; it does not erase or upload that private file/
  );
  assert.match(css, /\.prepare-sermon-post-service-recording-detail/);
  assert.match(css, /\.prepare-sermon-post-service-privacy/);
});

test('renderer derives a safe local recording summary and preserves a blank pending slot', () => {
  const {
    sermonPostServiceLocalRecording,
    sermonPostServiceSlotIntent
  } = prepareExports();
  const localMedia = {
    kind: 'audio',
    status: 'pending',
    url: null,
    fileName: '/private/inbox/Sunday <sermon>.mp3',
    sizeBytes: 4 * 1024 * 1024,
    sha256: 'a'.repeat(64)
  };
  const local = plain(sermonPostServiceLocalRecording(
    localMedia,
    { status: 'verified' }
  ));
  assert.deepEqual(local, {
    recorded: true,
    preserved: true,
    available: false,
    uploadNeeded: true,
    restoreNeeded: false,
    healthStatus: 'verified',
    kind: '',
    label: 'Preserved locally · upload needed',
    detail: 'Sunday <sermon>.mp3 · 4.0 MB'
  });

  const available = sermonPostServiceLocalRecording({
    status: 'ready',
    url: 'https://media.example/sermon.mp3',
    fileName: 'Sunday.mp3',
    sizeBytes: 1024,
    sha256: 'b'.repeat(64)
  }, { status: 'verified' });
  assert.equal(available.available, true);
  assert.equal(available.uploadNeeded, false);
  assert.equal(available.label, 'Available · preserved locally');

  const checking = sermonPostServiceLocalRecording(localMedia);
  assert.equal(checking.recorded, true);
  assert.equal(checking.preserved, false);
  assert.equal(checking.label, 'Checking local copy…');

  const missing = sermonPostServiceLocalRecording(
    localMedia,
    { status: 'missing' }
  );
  assert.equal(missing.preserved, false);
  assert.equal(missing.restoreNeeded, true);
  assert.equal(missing.kind, 'error');
  assert.equal(missing.label, 'Local copy missing · choose file again');

  const corrupt = sermonPostServiceLocalRecording(
    localMedia,
    { status: 'corrupt' }
  );
  assert.equal(corrupt.restoreNeeded, true);
  assert.equal(
    corrupt.label,
    'Local copy failed verification · replace file'
  );
  const invalidMetadata = sermonPostServiceLocalRecording(
    localMedia,
    { status: 'corrupt', restorable: false }
  );
  assert.equal(invalidMetadata.restoreNeeded, false);
  assert.equal(
    invalidMetadata.label,
    'Recording metadata failed verification'
  );

  assert.deepEqual(
    plain(sermonPostServiceSlotIntent(
      'audio',
      'pending',
      '',
      { preserveLocal: true }
    )),
    { kind: 'audio', status: 'pending', url: '' }
  );
  assert.equal(
    sermonPostServiceSlotIntent('audio', 'pending', ''),
    null
  );
});

test('recording picker uses exact identities, refreshes state, and restores post-show focus', () => {
  const start = controllerSource.indexOf(
    'async function attachSelectedSermonRecording'
  );
  const end = controllerSource.indexOf(
    'function sermonPostServiceDraftSnapshot',
    start
  );
  assert.ok(start > -1 && end > start);
  const operation = controllerSource.slice(start, end);
  assert.match(operation, /api\.attachSermonRecordingForServiceItem\(\{/);
  for (const field of [
    'projectId: context.projectId',
    'expectedRevisionId: context.projectRevisionId',
    'itemId: context.itemId',
    'sermonId: context.sermonId',
    'expectedSermonRevisionId: context.sermonRevisionId'
  ]) {
    assert.match(operation, new RegExp(field.replace('.', '\\.')));
  }
  assert.match(operation, /await loadSermons\(\)/);
  assert.match(
    operation,
    /await loadSelectedSermonCommunityState\(\{ force: true \}\)/
  );
  assert.match(operation, /elements\.btnChooseSermonRecording/);
  assert.match(operation, /elements\.sermonPostService\?\.scrollIntoView/);
  assert.match(
    operation,
    /It was not uploaded, published, or sent to Community/
  );

  const controlsStart = controllerSource.indexOf(
    'const postServiceContext = selectedSermonPostServiceContext()'
  );
  const controlsEnd = controllerSource.indexOf(
    'elements.btnAttachSermonSource.disabled',
    controlsStart
  );
  const controls = controllerSource.slice(controlsStart, controlsEnd);
  assert.match(
    controls,
    /elements\.btnChooseSermonRecording\.disabled =\s+postServiceLocked \|\| \(!postServiceEditable && !postServiceRestoreOnly\)/
  );
  assert.match(controls, /'Restore exact local recording…'/);
  assert.match(controls, /'Replace local recording…'/);
  assert.match(controls, /'Choose recording file…'/);
  assert.match(
    controls,
    /elements\.sermonPostServiceRecordingKind\.disabled =\s+postServiceLocked \|\| localRecording\.recorded/
  );
  assert.match(
    controls,
    /The recording type comes from the verified local file/
  );
});

test('local recording review opens only an exact verified path-free player binding', () => {
  const start = controllerSource.indexOf(
    'async function reviewSelectedSermonRecording'
  );
  const end = controllerSource.indexOf(
    'async function attachSelectedSermonRecording',
    start
  );
  assert.ok(start > -1 && end > start);
  const operation = controllerSource.slice(start, end);
  assert.match(
    operation,
    /localRecording\.preserved/
  );
  assert.match(
    operation,
    /api\.playSermonRecordingForServiceItem\(\{\s*projectId: context\.projectId,\s*expectedRevisionId: context\.projectRevisionId,\s*itemId: context\.itemId/
  );
  for (const binding of [
    'projectId',
    'projectRevisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'recordingId'
  ]) {
    assert.match(
      operation,
      new RegExp(`binding\\.${binding} ===`)
    );
  }
  assert.match(operation, /payload\.sha256 === recording\?\.sha256/);
  assert.match(operation, /payload\.sizeBytes === recording\?\.sizeBytes/);
  assert.match(
    operation,
    /api\.stopSermonRecordingPlayback\(\)\.catch/
  );
  assert.doesNotMatch(
    operation,
    /(?:playbackUrl|sourcePath|filePath|localPath|objectId)/
  );

  const controlsStart = controllerSource.indexOf(
    'const postServiceContext = selectedSermonPostServiceContext()'
  );
  const controlsEnd = controllerSource.indexOf(
    'elements.btnAttachSermonSource.disabled',
    controlsStart
  );
  const controls = controllerSource.slice(controlsStart, controlsEnd);
  assert.match(
    controls,
    /elements\.btnPlaySermonRecording\.disabled =[\s\S]*!localRecording\.preserved/
  );
  assert.match(controls, /'Review local recording'/);
  assert.match(
    controllerSource,
    /elements\.btnPlaySermonRecording\.addEventListener\(\s*'click',\s*reviewSelectedSermonRecording/
  );
});

test('recording health is exact-bound, inherited-resource cached, and stale-safe', () => {
  const contextStart = controllerSource.indexOf(
    'function selectedSermonRecordingHealthContext'
  );
  const ensureStart = controllerSource.indexOf(
    'async function ensureSelectedSermonRecordingHealth',
    contextStart
  );
  const renderStart = controllerSource.indexOf(
    'function renderSermonPostServiceState',
    ensureStart
  );
  assert.ok(contextStart > -1 && ensureStart > contextStart);
  assert.ok(renderStart > ensureStart);
  const context = controllerSource.slice(contextStart, ensureStart);
  const ensure = controllerSource.slice(ensureStart, renderStart);
  assert.match(
    context,
    /const healthKey = JSON\.stringify\(\[\s*context\.linked\.resourceId,\s*context\.sermonRevisionId,\s*recording\.id,\s*sha256/
  );
  assert.match(
    ensure,
    /sermonRecordingHealthCache\.get\(context\.healthKey\)/
  );
  assert.match(
    ensure,
    /sermonRecordingHealthCache\.set\(context\.healthKey,/
  );
  assert.match(
    ensure,
    /request !== state\.sermonRecordingHealthRequest/
  );
  assert.match(
    ensure,
    /current\?\.requestKey !== context\.requestKey/
  );
  for (const binding of [
    'projectId',
    'revisionId',
    'itemId',
    'resourceId',
    'sermonId',
    'sermonRevisionId',
    'recordingId'
  ]) {
    assert.match(
      ensure,
      new RegExp(`payload\\?\\.${binding} !== context\\.${binding}`)
    );
  }
});
