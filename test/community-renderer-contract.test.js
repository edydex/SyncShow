'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const prepareSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);

function uniqueIdCount(id) {
  return (html.match(new RegExp(`\\bid="${id}"`, 'g')) || []).length;
}

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected function ${name}`);
  let brace = source.indexOf('{', start);
  assert.notEqual(brace, -1, `expected body for ${name}`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test('Heritage Community connection stays in Admin Settings with a plain, complete control surface', () => {
  const ids = [
    'communityConnectionSection',
    'communityConnectionForm',
    'communityServerUrl',
    'communityAdminEmail',
    'btnConnectCommunity',
    'btnCancelCommunityConnection',
    'btnDisconnectCommunity',
    'communityConnectionStatus',
    'communityLastSyncSummary',
    'btnSyncCommunitySongs'
  ];
  for (const id of ids) assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);

  const adminStart = html.indexOf('<dialog id="advancedSetupDetails"');
  const adminEnd = html.indexOf('</dialog>', adminStart);
  const communityStart = html.indexOf('<section id="communityConnectionSection"');
  assert.ok(adminStart >= 0 && communityStart > adminStart && communityStart < adminEnd,
    'Community controls must live inside Admin Settings');
  assert.match(html.slice(communityStart, adminEnd), /Shared song library/);
  assert.match(html.slice(communityStart, adminEnd), /private, shared now, or scheduled/);
  assert.doesNotMatch(
    html.slice(communityStart, adminEnd),
    /client secret|device secret|access token|refresh token/i,
    'the renderer must not ask an operator to handle credentials'
  );

  for (const selector of [
    '.community-settings-section',
    '.community-connection-form',
    '.community-status-card',
    '.community-sync-row'
  ]) {
    assert.match(css, new RegExp(selector.replace('.', '\\.')));
  }
});

test('Community approval polling is bounded, cancellable, and renderer-secret-free', () => {
  const communityStart = appSource.indexOf('const COMMUNITY_POLL_INTERVAL_MS');
  const communityEnd = appSource.indexOf('function renderPrivateDriveOAuthDialog', communityStart);
  const source = appSource.slice(communityStart, communityEnd);

  assert.match(source, /COMMUNITY_POLL_INTERVAL_MS = 2000/);
  assert.match(source, /COMMUNITY_POLL_TIMEOUT_MS = 15 \* 60 \* 1000/);
  assert.match(source, /COMMUNITY_MAX_POLL_BACKOFF_MS = 30 \* 1000/);
  assert.match(source, /pollCommunityConnection\(\{ authorizationId \}\)/);
  assert.match(source, /cancelCommunityConnection\(\{ authorizationId \}\)/);
  assert.match(source, /function resumeCommunityAuthorizationPolling/);
  assert.match(source, /communityAuthorizationIdOf\(state\.community\.status\)/);
  assert.match(source, /2 \*\* Math\.min\(consecutiveFailures, 4\)/);
  assert.doesNotMatch(source, /consecutiveFailures >=[\s\S]{0,120}clearAuthorization: true/,
    'temporary polling failures must retain the cancellable main-process authorization');
  assert.match(appSource, /beforeunload', disposeCommunityConnectionUi/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/,
    'Community traffic must remain behind preload/main');
  assert.doesNotMatch(source, /accessToken|refreshToken|deviceSecret|clientSecret/,
    'authorization secrets must never enter renderer state');

  const connect = functionBlock(appSource, 'startCommunityConnection');
  assert.match(connect, /startCommunityConnection\(\{ serverUrl, email \}\)/);
  assert.doesNotMatch(connect, /\bpassword\b|\btoken\b/i);
  assert.match(functionBlock(appSource, 'communityCheckedResult'), /details\?\.message/);
  assert.match(functionBlock(appSource, 'communityCheckedResult'), /details\?\.code/);
});

test('pending Community approval has an email-first public recovery path', () => {
  for (const id of [
    'communityApprovalRecovery',
    'communityApprovalCode',
    'btnOpenCommunityApproval',
    'btnCopyCommunityApprovalCode',
    'communityApprovalActionStatus'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  const connectionSection = html.slice(
    html.indexOf('<section id="communityConnectionSection"'),
    html.indexOf('</section>', html.indexOf('<section id="communityConnectionSection"')) + 10
  );
  assert.ok(
    connectionSection.indexOf('approval link to the admin email')
      < connectionSection.indexOf('Didn’t get the email?'),
    'the recovery code must remain secondary to the admin email'
  );
  assert.match(connectionSection, /public one-time code/);
  assert.doesNotMatch(
    connectionSection,
    /device secret|access token|refresh token|client secret/i
  );

  const projection = functionBlock(appSource, 'projectCommunityStatus');
  assert.match(projection, /userCode:\s*communityUserCodeOf\(status\)/);
  assert.doesNotMatch(projection, /verificationUri|approvalUrl|deviceSecret|accessToken|refreshToken/);

  const render = functionBlock(appSource, 'renderCommunitySettings');
  assert.match(render, /communityApprovalRecovery\.hidden = !pending/);
  assert.match(render, /btnOpenCommunityApproval\.hidden = !pending/);
  assert.match(render, /btnCopyCommunityApprovalCode\.hidden = !pending/);
  assert.match(render, /communityApprovalCode\.textContent/);
  assert.match(render, /email link is still the simplest option/);

  const open = functionBlock(appSource, 'openCommunityApproval');
  assert.match(open, /openCommunityApproval\(\{ authorizationId \}\)/);
  assert.doesNotMatch(open, /verificationUri|shell\.openExternal|\bfetch\s*\(/);

  const copy = functionBlock(appSource, 'copyCommunityApprovalCode');
  assert.match(copy, /copyCommunityApprovalCode\(\{ authorizationId \}\)/);
  assert.doesNotMatch(copy, /navigator\.clipboard|clipboard\.writeText|verificationUri/);
  assert.match(css, /\.community-approval-recovery\[hidden\]/);
});

test('song sharing defaults private, remains sidecar metadata, and uses compare-and-set conflict safety', () => {
  for (const id of [
    'songDocumentCommunityVisibility',
    'songDocumentPublishAtField',
    'songDocumentPublishAt',
    'songDocumentCommunityState'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  assert.match(html, /<option value="private" selected>Private — Community admins only<\/option>/);
  assert.match(html, /<option value="public">Public — Community members now<\/option>/);
  assert.match(html, /<option value="scheduled-public">Scheduled — Community members later<\/option>/);

  const documentSource = functionBlock(prepareSource, 'currentSongDocumentSource');
  assert.doesNotMatch(documentSource, /Community|visibility|publishAt|syncVersion/,
    'Community policy must not alter the immutable SongDocument source');

  const communitySave = functionBlock(prepareSource, 'saveSongCommunityVisibility');
  assert.match(communitySave, /setCommunitySongVisibility\(\{/);
  assert.match(communitySave, /songId,\s*visibility,\s*publishAt,\s*expectedSyncVersion:/s);
  assert.match(communitySave, /communitySongHasConflict/);
  assert.match(communitySave, /neither copy was overwritten/);
  assert.doesNotMatch(communitySave, /force|overwrite:\s*true|expectedSyncVersion:\s*undefined/);

  const localSave = functionBlock(prepareSource, 'saveSongDraft');
  assert.ok(
    localSave.indexOf('api.saveSongDocument') < localSave.indexOf('saveSongCommunityVisibility'),
    'the local immutable revision must save before applying Community visibility'
  );
  assert.match(localSave, /Community visibility updated/);
  assert.match(css, /\.prepare-song-community-state\[data-kind="conflict"\]/);
  assert.match(css, /\.prepare-song-sync-badge\.conflict/);
});

test('song conflict review renders untrusted sources as text and resolves with both CAS guards', () => {
  for (const id of [
    'btnReviewSongCommunityConflict',
    'songCommunityConflictDialog',
    'songCommunityLocalDocuments',
    'songCommunityRemoteDocuments',
    'songCommunityConflictStatus',
    'btnKeepLocalSongConflict',
    'btnKeepCommunitySongConflict'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  assert.match(html, /Neither copy is overwritten until you explicitly choose one/);
  assert.match(html, /Keep this Mac’s copy/);
  assert.match(html, /Keep Community copy/);

  const safeRender = functionBlock(prepareSource, 'renderCommunityConflictDocuments');
  assert.match(safeRender, /sourcePreview\.textContent = preview/);
  assert.match(safeRender, /document\.title/);
  assert.match(safeRender, /document\.language/);
  assert.doesNotMatch(
    safeRender,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function/
  );

  const review = functionBlock(prepareSource, 'openSongCommunityConflict');
  assert.match(review, /getCommunitySongConflict|loadSongCommunityConflict/);
  const load = functionBlock(prepareSource, 'loadSongCommunityConflict');
  assert.match(load, /getCommunitySongConflict\(\{ songId \}\)/);
  assert.match(load, /localDocuments/);
  assert.match(load, /communityDocuments/);

  const resolve = functionBlock(prepareSource, 'resolveSongCommunityConflict');
  assert.match(resolve, /window\.confirm\(confirmation\)/);
  assert.match(resolve, /resolveCommunitySongConflict\(\{\s*songId,\s*strategy,\s*expectedSyncVersion:\s*conflict\.expectedSyncVersion,\s*expectedLocalRevision:\s*conflict\.expectedLocalRevision/s);
  assert.match(resolve, /'keep-local', 'keep-remote'/);
  assert.match(resolve, /resolution\?\.resolved !== true/);
  assert.match(resolve, /RETAINED_LOCAL_DOCUMENTS/);
  assert.match(resolve, /The conflict remains/);
  assert.ok(
    resolve.indexOf('resolution?.resolved !== true') < resolve.indexOf('closeSongCommunityConflict()'),
    'an unresolved guarded response must be handled before the review can close'
  );

  const editorRefresh = functionBlock(
    prepareSource,
    'refreshSongEditorAfterConflictResolution'
  );
  assert.match(editorRefresh, /await refreshSongsAfterCommunityConflict\(\)/);
  assert.match(
    functionBlock(prepareSource, 'refreshSongsAfterCommunityConflict'),
    /return loadSongs\(\)/
  );
  assert.match(editorRefresh, /api\.readSongDocument\(\{ songId \}\)/);
  assert.match(editorRefresh, /await loadSongCommunityState\(songId\)/);

  const communityRender = functionBlock(prepareSource, 'renderSongCommunityState');
  assert.match(communityRender, /btnSaveSong\.disabled[\s\S]*\|\| conflict/);
  assert.match(communityRender, /btnReviewSongCommunityConflict\.hidden = !conflict/);
  assert.match(css, /\.prepare-conflict-document pre/);
});
