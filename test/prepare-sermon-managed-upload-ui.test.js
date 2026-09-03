'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const stylesSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test('Prepare shows an explicit private Community recording card', () => {
  for (const id of [
    'prepareSermonManagedUpload',
    'prepareSermonManagedUploadBadge',
    'prepareSermonManagedUploadStatus',
    'prepareSermonManagedUploadProgress',
    'btnEnableSermonManagedUpload',
    'btnUploadSermonManagedRecording',
    'btnResumeSermonManagedRecording',
    'btnCancelSermonManagedRecording'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /Private Community recording/);
  assert.match(htmlSource, /Upload starts only when you click the button/);
  assert.match(
    htmlSource,
    /never publishes the sermon or creates a public URL/
  );
  assert.match(
    htmlSource,
    /A Community manager must separately review and publish it/
  );
  assert.match(
    htmlSource,
    /Local playback and reviewed external recording links|Review local recording/
  );
  assert.match(stylesSource, /\.prepare-sermon-managed-upload-progress/);
  assert.match(
    stylesSource,
    /\.prepare-sermon-managed-upload\[data-kind="complete"\]/
  );
});

test('approval is separate from upload and opens the existing trusted flow', () => {
  const approval = functionBlock(
    controllerSource,
    'enableSelectedSermonManagedUpload'
  );
  assert.match(
    approval,
    /enableCommunitySermonMediaForServiceItem/
  );
  assert.match(approval, /openCommunityApproval/);
  assert.match(approval, /pollSermonManagedUploadApproval/);
  assert.match(approval, /no upload starts during approval/i);
  assert.doesNotMatch(
    approval,
    /uploadCommunitySermonMediaForServiceItem/
  );
});

test('Start, Resume, and Cancel remain distinct human actions', () => {
  const run = functionBlock(
    controllerSource,
    'runSelectedSermonManagedUpload'
  );
  assert.match(run, /resumeCommunitySermonMediaForServiceItem/);
  assert.match(run, /uploadCommunitySermonMediaForServiceItem/);
  assert.match(run, /window\.confirm/);
  assert.match(run, /does not publish the sermon or create a public URL/);
  assert.match(
    run,
    /Community’s authoritative received-chunk state/
  );

  const cancel = functionBlock(
    controllerSource,
    'cancelSelectedSermonManagedUpload'
  );
  assert.match(cancel, /window\.confirm/);
  assert.match(cancel, /cancelCommunitySermonMediaForServiceItem/);
  assert.match(cancel, /verified local recording remains on this computer/i);
});

test('live progress makes mid-stream cancellation reachable and respects restart state', () => {
  const progress = functionBlock(
    controllerSource,
    'handleCommunitySermonMediaProgress'
  );
  assert.match(progress, /payload\?\.canCancel === true/);
  assert.match(progress, /payload\?\.canResume === true/);
  assert.match(progress, /payload\?\.canUpload === true/);
  assert.match(progress, /receivedChunks/);
  assert.match(progress, /A manager must still review and publish/);
  assert.match(progress, /progress\?\.phase === 'finalizing'/);
  assert.match(progress, /cancellation is unavailable during finalization/);

  assert.match(
    controllerSource,
    /onCommunitySermonMediaProgress\(\s*handleCommunitySermonMediaProgress/
  );
  assert.match(
    controllerSource,
    /btnCancelSermonManagedRecording\.addEventListener/
  );
});

test('servers without the capability keep local playback and external links available', () => {
  const render = functionBlock(
    controllerSource,
    'renderSermonManagedUploadState'
  );
  assert.match(render, /This SyncShow build cannot use managed upload/);
  assert.match(render, /Local playback and reviewed external recording links/);
  assert.match(render, /upload\.status/);
  assert.match(render, /upload\.canEnable/);
  assert.match(render, /upload\.canUpload/);
  assert.match(render, /upload\.canResume/);
  assert.match(render, /upload\.canCancel/);
  assert.match(render, /upload\.progress\?\.phase === 'finalizing'/);
  assert.match(render, /'Securing'/);
});
