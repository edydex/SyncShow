'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

function containingFunctionBlock(source, needle) {
  const needleIndex = source.indexOf(needle);
  assert.notEqual(needleIndex, -1, `expected ${needle}`);
  const functionIndex = source.lastIndexOf('function ', needleIndex);
  assert.notEqual(functionIndex, -1, `expected a function containing ${needle}`);
  const name = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(
    source.slice(functionIndex)
  )?.[1];
  assert.ok(name, `expected a named function containing ${needle}`);
  return functionBlock(source, name);
}

function callExpressionBlock(source, callee) {
  let start = -1;
  let parameters = -1;
  let offset = 0;
  while (offset < source.length) {
    const candidate = source.indexOf(callee, offset);
    if (candidate < 0) break;
    let cursor = candidate + callee.length;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === '(') {
      start = candidate;
      parameters = cursor;
      break;
    }
    offset = candidate + callee.length;
  }
  assert.notEqual(start, -1, `expected call to ${callee}`);
  let depth = 0;
  for (let index = parameters; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated call to ${callee}`);
}

function prepareExports() {
  const window = {};
  vm.runInNewContext(prepareSource, { console, window, URL }, {
    filename: 'prepare-controller.js'
  });
  return window.SyncShowPrepare;
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
    'btnSyncCommunitySongs',
    'communityLastSermonSyncSummary',
    'btnSyncCommunitySermons'
  ];
  for (const id of ids) assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);

  const adminStart = html.indexOf('<dialog id="advancedSetupDetails"');
  const adminEnd = html.indexOf('</dialog>', adminStart);
  const communityStart = html.indexOf('<section id="communityConnectionSection"');
  assert.ok(adminStart >= 0 && communityStart > adminStart && communityStart < adminEnd,
    'Community controls must live inside Admin Settings');
  assert.match(html.slice(communityStart, adminEnd), /Shared Community library/);
  assert.match(html.slice(communityStart, adminEnd), /private, shared now, or scheduled/);
  assert.match(html.slice(communityStart, adminEnd), /shared only when an operator explicitly saves one/);
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

test('sermon library sync is a separate capability-gated manual pull', () => {
  const section = html.slice(
    html.indexOf('<section id="communityConnectionSection"'),
    html.indexOf('</section>', html.indexOf('<section id="communityConnectionSection"')) + 10
  );
  assert.match(section, /<strong>Sermon sync<\/strong>/);
  assert.match(section, /Pull Community sermon updates/);
  assert.match(section, /Saving a local sermon remains an explicit action in Prepare/);
  assert.match(section, /id="btnSyncCommunitySermons"[^>]+disabled/);

  const render = functionBlock(appSource, 'renderCommunitySettings');
  assert.match(render, /canReadSongs = connected[\s\S]*canReadSongs === true/);
  assert.match(render, /canReadSermons = connected[\s\S]*canReadSermons === true/);
  assert.match(render, /canReadServiceDocuments = connected[\s\S]*canReadServiceDocuments === true/);
  assert.match(render, /canReadServicePlans = connected[\s\S]*canReadServicePlans === true/);
  assert.match(
    render,
    /btnSyncCommunitySongs\.disabled = !canReadSongs/
  );
  assert.match(
    render,
    /btnSyncCommunitySermons\.disabled = !canReadSermons[\s\S]*communitySermonSyncAvailable\(\)/
  );
  assert.match(render, /canReadSongs && canReadSermons/);
  assert.match(render, /includes the shared song library/);
  assert.match(render, /includes the shared sermon library/);
  assert.match(render, /Services prepared in Community are available from Load/);
  assert.match(render, /Use Open from Heritage Community in Load/);
  assert.match(render, /replaces the current Load service only after its offline package is complete/);
  assert.match(render, /No currently approved Community library resource/);
  assert.match(render, /Song synchronization is not available for this connection/);
  assert.match(render, /Sermon synchronization is not available for this connection/);
  assert.doesNotMatch(render, /Song sync still works/);

  const songSync = functionBlock(appSource, 'syncCommunitySongs');
  assert.match(songSync, /canReadSongs[\s\S]*!canReadSongs/);
  const statusChanged = functionBlock(appSource, 'handleCommunityStatusChanged');
  assert.match(statusChanged, /refreshSongs/);
  assert.match(statusChanged, /refreshSongCommunityState/);
  assert.match(statusChanged, /refreshSermonCommunityState/);

  const sync = functionBlock(appSource, 'syncCommunitySermons');
  assert.match(sync, /await window\.api\.syncCommunitySermons\(\)/);
  assert.match(sync, /prepareController\.refreshSermons\(\)/);
  assert.doesNotMatch(sync, /pushCommunitySermon|documentSource|sourceObjects/);
  assert.equal(
    (appSource.match(/syncCommunitySermons\(\)/g) || []).length,
    2,
    'sermon pull must appear only in its named handler and explicit bridge call'
  );
  assert.doesNotMatch(appSource, /scheduleCommunitySermon|setInterval\([^)]*syncCommunitySermons/);

  const projection = functionBlock(appSource, 'projectCommunityStatus');
  assert.match(projection, /lastSermonSync: status\.lastSermonSync/);
  assert.match(appSource, /state\.community\.lastSermonSync = lastSermonSync/);
});

test('Admin reports the separate public-song-link capability without creating links there', () => {
  for (const id of [
    'communitySongPublicLinkSummary',
    'communitySongPublicLinkBadge'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  const section = html.slice(
    html.indexOf('<section id="communityConnectionSection"'),
    html.indexOf(
      '</section>',
      html.indexOf('<section id="communityConnectionSection"')
    ) + 10
  );
  assert.match(section, /<strong>Public song links<\/strong>/);
  assert.match(section, /separate approval and exact-family review/);
  assert.match(section, /saved song in Prepare/);
  assert.doesNotMatch(
    section,
    /(?:Create|Revoke) public (?:song )?link<\/button>/i,
    'Admin reports capability; exact-family actions stay in Prepare'
  );

  const projection = functionBlock(appSource, 'projectCommunityConnection');
  assert.match(
    projection,
    /canReadSongPublicLinks:\s*connection\.canReadSongPublicLinks === true/
  );
  assert.match(
    projection,
    /canWriteSongPublicLinks:\s*connection\.canWriteSongPublicLinks === true/
  );
  const render = functionBlock(appSource, 'renderCommunitySettings');
  assert.match(render, /canReadSongPublicLinks/);
  assert.match(render, /canWriteSongPublicLinks/);
  assert.match(render, /can list, copy, create, and revoke anonymous song links/);
  assert.match(render, /can list and copy server-confirmed links/);
  assert.match(render, /existing links may still need Community admin/);
});

test('Prepare shares only the exact selected local sermon through an explicit CAS action', () => {
  for (const id of [
    'prepareSermonCommunity',
    'prepareSermonCommunityHeading',
    'prepareSermonCommunityBadge',
    'prepareSermonCommunityStatus',
    'prepareSermonCommunityPublicationStatus',
    'prepareSermonCommunityLiveStatus',
    'btnOpenCommunitySermonPublicationManager',
    'btnRefreshCommunitySermonPublication',
    'btnVerifyCommunitySermonPublication',
    'btnPushCommunitySermon'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  const block = html.slice(
    html.indexOf('<section id="prepareSermonCommunity"'),
    html.indexOf('</section>', html.indexOf('<section id="prepareSermonCommunity"')) + 10
  );
  assert.match(block, /Attached PDF, PowerPoint, and other private source files stay on this computer/);
  assert.match(block, /are not uploaded/);
  assert.match(block, /Community admin owns Publish and Withdraw/);
  assert.match(block, /exact Ready \(or currently Published\) revision/);
  assert.match(block, /Continue in Community opens that sermon in the manager review queue/);
  assert.match(block, /it does not publish or withdraw anything/);
  assert.match(block, /Draft sermons stay in SyncShow until they are marked Ready/);
  assert.match(block, /Manager changes do not arrive live on this card/);
  assert.match(block, /refresh the publication status after either action/);
  assert.match(block, /Synced does not mean published/);
  assert.match(block, /Current edits do not silently republish or replace an older live revision/);
  assert.match(
    block,
    /id="prepareSermonCommunityLiveStatus"[^>]+role="status"[^>]+aria-live="polite"[^>]+hidden/
  );
  assert.match(
    block,
    /id="btnOpenCommunitySermonPublicationManager"[^>]+aria-describedby="prepareSermonCommunityStatus prepareSermonCommunityPublicationStatus"[^>]+hidden disabled>Continue in Community/
  );
  assert.match(
    block,
    /id="btnRefreshCommunitySermonPublication"[^>]+aria-describedby="prepareSermonCommunityStatus prepareSermonCommunityPublicationStatus"[^>]+hidden disabled>Refresh publication status/
  );
  assert.match(
    block,
    /id="btnVerifyCommunitySermonPublication"[^>]+aria-describedby="prepareSermonCommunityPublicationStatus prepareSermonCommunityLiveStatus"[^>]+hidden disabled>Verify live sermon/
  );
  assert.doesNotMatch(block, /<button[^>]*>\s*(?:Publish|Withdraw)/i);
  assert.doesNotMatch(block, /remoteDocumentSource|sourceObjects/);

  const expectedVersion = functionBlock(prepareSource, 'communitySermonExpectedVersion');
  assert.match(expectedVersion, /exists === false[\s\S]*status === 'local-only'[\s\S]*return null/);
  assert.match(
    expectedVersion,
    /exists === true[\s\S]*Number\.isSafeInteger\(sermonState\.syncVersion\)[\s\S]*return sermonState\.syncVersion/
  );

  const push = functionBlock(prepareSource, 'pushSelectedSermonToCommunity');
  assert.match(
    push,
    /const expectedSyncVersion = communitySermonExpectedVersion\(sermonState\)/
  );
  assert.match(
    push,
    /api\.pushCommunitySermon\(\{\s*sermonId: context\.sermonId,\s*expectedSyncVersion,\s*expectedLocalRevision: context\.selectedRevision\s*\}\)/s
  );
  assert.match(push, /context\.selectionMatchesLinked/);
  assert.match(push, /sermonState\.localRevision !== context\.selectedRevision/);
  assert.match(push, /sermonState\.conflict/);
  assert.match(push, /communitySermonPushReportedConflict\(payload, projected\)/);
  assert.match(push, /Nothing was overwritten, and both revisions were preserved for review/);
  assert.ok(
    push.indexOf('communitySermonPushReportedConflict(payload, projected)')
      < push.indexOf('saved = true'),
    'a normal conflict result must be handled before the renderer can mark the push saved'
  );
  assert.doesNotMatch(push, /overwrite|documentSource|sourceObjects/);
  assert.equal(
    (prepareSource.match(/api\.pushCommunitySermon\(/g) || []).length,
    1,
    'the renderer must have exactly one explicit sermon push call site'
  );
  assert.match(
    push,
    /saved[\s\S]*btnOpenCommunitySermonPublicationManager\.focus\(\)/
  );

  const continueInCommunity = functionBlock(
    prepareSource,
    'continueSelectedSermonInCommunity'
  );
  assert.match(continueInCommunity, /context\.selectionMatchesLinked/);
  assert.match(continueInCommunity, /sermonState\.status !== 'synced'/);
  assert.match(continueInCommunity, /Boolean\(sermonState\.conflict\)/);
  assert.match(
    continueInCommunity,
    /sermonState\.localRevision !== context\.selectedRevision/
  );
  assert.match(
    continueInCommunity,
    /!\['ready', 'published'\]\.includes\(\s*postServiceContext\.postService\.publicationStatus\s*\)/s
  );
  assert.match(
    continueInCommunity,
    /api\.openCommunitySermonPublicationManager\(\{\s*sermonId: context\.sermonId,\s*expectedLocalRevision: context\.selectedRevision\s*\}\)/s
  );
  assert.match(
    continueInCommunity,
    /request !== state\.sermonCommunityManagerRequest[\s\S]*current\?\.key !== context\.key[\s\S]*state\.sermonCommunityManagerContextKey !== context\.key[\s\S]*currentState\?\.status !== 'synced'[\s\S]*currentState\.localRevision !== context\.selectedRevision/
  );
  assert.match(
    continueInCommunity,
    /currentPostServiceContext\.sermonRevisionId[\s\S]*\['ready', 'published'\]\.includes\(\s*currentPostServiceContext\.postService\.publicationStatus\s*\)/s
  );
  assert.match(
    continueInCommunity,
    /Object\.keys\(payload\)\.length !== 1[\s\S]*payload\.opened !== true/
  );
  assert.match(
    continueInCommunity,
    /Nothing was published or withdrawn; refresh publication status here after the manager decision/
  );
  assert.doesNotMatch(
    continueInCommunity,
    /baseUrl|accessToken|documentSource|sourceObjects|api\.(?:publish|withdraw)/
  );
  assert.equal(
    (
      prepareSource.match(
        /api\.openCommunitySermonPublicationManager\(/g
      ) || []
    ).length,
    1,
    'the renderer must have one exact selected-sermon manager handoff'
  );
  const resetManager = functionBlock(
    prepareSource,
    'resetSermonCommunityManager'
  );
  assert.match(
    resetManager,
    /state\.sermonCommunityManagerRequest \+= 1/
  );

  const bind = functionBlock(prepareSource, 'bindEvents');
  assert.match(
    bind,
    /btnPushCommunitySermon\.addEventListener\(\s*'click',\s*pushSelectedSermonToCommunity/s
  );
  assert.match(
    bind,
    /btnOpenCommunitySermonPublicationManager\.addEventListener\(\s*'click',\s*continueSelectedSermonInCommunity/s
  );
  assert.match(
    bind,
    /btnRefreshCommunitySermonPublication\.addEventListener\(\s*'click',\s*refreshSelectedCommunitySermonPublicationStatus/s
  );
  assert.match(
    bind,
    /btnVerifyCommunitySermonPublication\.addEventListener\(\s*'click',\s*verifySelectedCommunitySermonPublication/s
  );
  for (const operation of [
    'createSermonPacket',
    'attachSermonSource',
    'applySermonExtraction'
  ]) {
    assert.doesNotMatch(
      functionBlock(prepareSource, operation),
      /pushCommunitySermon/,
      `${operation} must not upload a sermon automatically`
    );
  }

  const render = functionBlock(prepareSource, 'renderSermonCommunityState');
  assert.match(
    render,
    /btnPushCommunitySermon\.hidden =\s*!sermonState\.canWriteSermons \|\| !pushApiAvailable/
  );
  assert.match(render, /status === 'conflict'/);
  assert.match(render, /status === 'remote-only'/);
  assert.match(render, /status === 'local-only'/);
  assert.match(render, /status === 'local-changed'/);
  assert.match(render, /status === 'synced'/);
  assert.match(
    render,
    /\['ready', 'published'\]\.includes\(\s*postServiceContext\.postService\.publicationStatus\s*\)/s
  );
  assert.match(
    render,
    /btnOpenCommunitySermonPublicationManager\.hidden = false/
  );
  assert.match(
    render,
    /state\.sermonCommunityManagerBusy[\s\S]*'Opening Community…'/
  );
  assert.match(
    render,
    /does not publish or withdraw it/
  );
  assert.match(render, /Synced does not mean published/);
  assert.match(render, /Pull Community sermon updates in Admin Settings/);
  assert.match(render, /service is pinned to an older local sermon revision/);
  assert.match(css, /\.prepare-sermon-community\[data-kind="conflict"\]/);
  assert.match(css, /\.prepare-sermon-community-publication-status/);
});

test('Prepare projects only bounded read-only sermon publication status', () => {
  const {
    communitySermonPublicationVerificationErrorMessage,
    communitySermonPublicationVerificationKey,
    communitySermonPublicationVerificationMatches,
    communitySermonPublicationVerificationStatusText,
    communitySermonPublicationStatusText,
    projectCommunitySermonState,
    projectCommunitySermonPublicationState,
    projectCommunitySermonPublicationVerification
  } = prepareExports();
  const base = {
    connected: true,
    canReadSermons: true,
    canWriteSermons: true,
    canReadSermonPublications: true,
    exists: true,
    status: 'synced',
    syncId: 'sermon-one',
    syncVersion: 7,
    localRevision: 'a'.repeat(64),
    conflict: null
  };
  const publication = {
    status: 'published-older',
    publicId: 'sermon-one',
    publishedAt: '2026-07-27T20:00:00.000Z',
    publicationVersion: 4,
    selectedBodyEntryIds: ['private-body'],
    selectedMediaIds: ['private-recording'],
    detailChecksum: 'b'.repeat(64),
    accessToken: 'secret'
  };
  const projected = projectCommunitySermonState({
    ...base,
    publication
  });
  assert.equal(projected.canReadSermonPublications, true);
  assert.equal(projected.publication.status, 'published-older');
  assert.equal(projected.publication.publicId, 'sermon-one');
  assert.equal(projected.publication.publicationVersion, 4);
  assert.deepEqual(
    Array.from(Object.keys(projected.publication)),
    ['status', 'publicId', 'publishedAt', 'publicationVersion']
  );
  assert.match(
    communitySermonPublicationStatusText(projected),
    /older Community revision remains live[\s\S]*Current edits are not public and do not silently republish/
  );
  assert.ok(communitySermonPublicationVerificationKey(projected));
  assert.equal(
    communitySermonPublicationVerificationKey({
      ...projected,
      canReadSermonPublications: false
    }),
    null
  );
  assert.equal(
    communitySermonPublicationVerificationKey({
      ...projected,
      publication: {
        status: 'never-published',
        publicId: null,
        publishedAt: null,
        publicationVersion: null
      }
    }),
    null
  );

  const verificationPayload = {
    status: 'verified-older',
    publicId: 'sermon-one',
    publishedAt: '2026-07-27T20:00:00.000Z',
    publicationVersion: 4,
    bodyEntryCount: 3,
    mediaCount: 1,
    primaryReferenceCount: 1,
    mentionedReferenceCount: 5
  };
  const verification = projectCommunitySermonPublicationVerification(
    verificationPayload
  );
  assert.deepEqual(
    Array.from(Object.keys(verification)),
    [
      'status',
      'publicId',
      'publishedAt',
      'publicationVersion',
      'bodyEntryCount',
      'mediaCount',
      'primaryReferenceCount',
      'mentionedReferenceCount'
    ]
  );
  assert.equal(
    communitySermonPublicationVerificationMatches(verification, projected),
    true
  );
  assert.match(
    communitySermonPublicationVerificationStatusText(verification),
    /Verified the older approved sermon[\s\S]*current edits remain private[\s\S]*mentioned passages: 5/
  );
  assert.match(
    communitySermonPublicationVerificationStatusText(
      null,
      'The public passage index no longer matches the approved sermon.'
    ),
    /passage index no longer matches[\s\S]*publication status above is unchanged/
  );
  assert.equal(
    communitySermonPublicationVerificationErrorMessage({
      message: 'Reconnect Heritage Community before verifying the live sermon.'
    }),
    'Reconnect Heritage Community before verifying the live sermon.'
  );
  assert.equal(
    communitySermonPublicationVerificationErrorMessage({
      message: 'x'.repeat(501)
    }),
    'The live sermon could not be verified'
  );
  assert.throws(
    () => projectCommunitySermonPublicationVerification({
      ...verificationPayload,
      sourcePath: '/private/sermons/sermon-one.json'
    }),
    /valid live sermon verification/
  );
  assert.throws(
    () => projectCommunitySermonPublicationVerification({
      ...verificationPayload,
      bodyEntryCount: -1
    }),
    /verification counts/
  );
  assert.throws(
    () => projectCommunitySermonPublicationVerification({
      ...verificationPayload,
      mentionedReferenceCount: 100_001
    }),
    /verification counts/
  );
  assert.throws(
    () => projectCommunitySermonPublicationVerification({
      ...verificationPayload,
      primaryReferenceCount: 0
    }),
    /verification counts/
  );
  assert.throws(
    () => projectCommunitySermonPublicationVerification({
      ...verificationPayload,
      status: 'verified'
    }),
    /unknown live sermon verification status/
  );
  assert.equal(
    communitySermonPublicationVerificationMatches({
      ...verification,
      publicationVersion: 5
    }, projected),
    false
  );

  const unsupported = projectCommunitySermonPublicationState(publication, {
    canReadSermonPublications: false
  });
  assert.equal(unsupported.status, 'unsupported');
  const malformed = projectCommunitySermonPublicationState({
    ...publication,
    publishedAt: 'not-a-time'
  }, {
    canReadSermonPublications: true
  });
  assert.equal(malformed.status, 'unavailable');
  const withdrawn = projectCommunitySermonPublicationState({
    status: 'withdrawn',
    publicId: null,
    publishedAt: null,
    publicationVersion: 5
  }, {
    canReadSermonPublications: true
  });
  assert.equal(withdrawn.status, 'withdrawn');
  const neverPublished = projectCommunitySermonPublicationState({
    status: 'never-published',
    publicId: null,
    publishedAt: null,
    publicationVersion: null
  }, {
    canReadSermonPublications: true
  });
  assert.equal(neverPublished.status, 'never-published');

  const loadStart = prepareSource.indexOf(
    'async function loadSelectedSermonCommunityState'
  );
  const loadEnd = prepareSource.indexOf(
    'function renderSermonCommunityState',
    loadStart
  );
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  const load = prepareSource.slice(loadStart, loadEnd);
  assert.match(
    load,
    /if \(state\.sermonCommunityContextKey !== context\.key\) \{\s*resetSermonCommunityManager\(\);\s*resetSermonCommunityVerification\(\);\s*\} else if \(force\) \{\s*resetSermonCommunityVerification\(\);/s
  );
  assert.ok(
    load.indexOf('request !== state.sermonCommunityRequest')
      < load.indexOf('state.sermonCommunityState = sermonState'),
    'publication status must preserve the selected-sermon request-race guard'
  );
  assert.equal(
    (prepareSource.match(/api\.getCommunitySermonState\(/g) || []).length,
    1,
    'publication state must ride the existing sermon-state request'
  );
  assert.doesNotMatch(
    prepareSource,
    /api\.(?:publish|withdraw)CommunitySermon/
  );

  const refresh = functionBlock(
    prepareSource,
    'refreshSelectedCommunitySermonPublicationStatus'
  );
  assert.match(
    refresh,
    /loadSelectedSermonCommunityState\(\{ force: true \}\)/
  );
  assert.match(
    refresh,
    /selectedSermonCommunityContext\(\)\?\.key === context\.key[\s\S]*state\.sermonCommunityContextKey === context\.key/
  );
  assert.match(
    refresh,
    /Publish and Withdraw remain in Community admin/
  );
  assert.doesNotMatch(
    refresh,
    /pushCommunitySermon|publishCommunitySermon|withdrawCommunitySermon|verifyCommunitySermonPublication/
  );

  const render = functionBlock(prepareSource, 'renderSermonCommunityState');
  assert.match(
    render,
    /btnRefreshCommunitySermonPublication\.hidden = false/
  );
  assert.match(
    render,
    /const stateApiAvailable =\s*typeof api\.getCommunitySermonState === 'function'/
  );
  assert.match(
    render,
    /btnPushCommunitySermon\.hidden =\s*!sermonState\.canWriteSermons \|\| !pushApiAvailable/
  );
  assert.match(
    render,
    /btnRefreshCommunitySermonPublication\.disabled = locked/
  );
  assert.match(render, /Refreshing status…/);
});

test('Prepare verifies only an eligible exact live sermon publication', () => {
  const render = functionBlock(prepareSource, 'renderSermonCommunityState');
  assert.match(
    render,
    /const verificationAvailable = Boolean\(\s*verificationPublicationKey\s*&& typeof api\.verifyCommunitySermonPublication === 'function'\s*\)/s
  );
  assert.match(
    render,
    /sermonCommunityLiveStatus\.hidden = !verificationAvailable/
  );
  assert.match(
    render,
    /btnVerifyCommunitySermonPublication\.hidden =\s*!verificationAvailable/
  );
  assert.match(render, /sermonCommunityVerificationContextKey === context\.key/);
  assert.match(
    render,
    /sermonCommunityVerificationPublicationKey\s*=== verificationPublicationKey/
  );
  assert.match(render, /Verifying live sermon…/);

  const verify = functionBlock(
    prepareSource,
    'verifySelectedCommunitySermonPublication'
  );
  assert.match(
    verify,
    /api\.verifyCommunitySermonPublication\(\{\s*sermonId: context\.sermonId\s*\}\)/s
  );
  assert.match(
    verify,
    /Object\.keys\(payload\)\.length !== 1[\s\S]*hasOwnProperty\.call\(payload, 'verification'\)/
  );
  assert.match(
    verify,
    /projectCommunitySermonPublicationVerification\(payload\.verification\)/
  );
  assert.match(
    verify,
    /communitySermonPublicationVerificationErrorMessage\(error\)/
  );
  assert.match(
    verify,
    /request !== state\.sermonCommunityVerificationRequest[\s\S]*currentContext\?\.key !== context\.key[\s\S]*currentPublicationKey !== publicationKey/
  );
  assert.ok(
    verify.indexOf('currentPublicationKey !== publicationKey')
      < verify.indexOf('state.sermonCommunityVerification = verification'),
    'a stale publication verification must be discarded before it can render'
  );
  assert.doesNotMatch(
    verify,
    /errorMessage|error\.message|sourcePath|accessToken|publishCommunitySermon|withdrawCommunitySermon/
  );
  assert.equal(
    (prepareSource.match(/api\.verifyCommunitySermonPublication\(/g) || []).length,
    1,
    'live sermon verification must have exactly one explicit call site'
  );

  const reset = functionBlock(
    prepareSource,
    'resetSermonCommunityVerification'
  );
  assert.match(reset, /sermonCommunityVerification = null/);
  assert.match(reset, /sermonCommunityVerificationContextKey = null/);
  assert.match(reset, /sermonCommunityVerificationPublicationKey = null/);
  assert.match(reset, /sermonCommunityVerificationRequest \+= 1/);

  const loadStart = prepareSource.indexOf(
    'async function loadSelectedSermonCommunityState'
  );
  const loadEnd = prepareSource.indexOf(
    'function renderSermonCommunityState',
    loadStart
  );
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  const load = prepareSource.slice(loadStart, loadEnd);
  assert.match(
    load,
    /sermonCommunityContextKey !== context\.key[\s\S]*resetSermonCommunityVerification\(\)/
  );
  assert.match(
    load,
    /sermonCommunityVerificationPublicationKey[\s\S]*!== verificationPublicationKey[\s\S]*resetSermonCommunityVerification\(\)/
  );
});

test('Community sermon CAS projection distinguishes exact create and update versions', () => {
  const {
    communitySermonExpectedVersion,
    communitySermonPushReportedConflict,
    projectCommunitySermonState
  } = prepareExports();
  const localOnly = projectCommunitySermonState({
    connected: true,
    canReadSermons: true,
    canWriteSermons: true,
    exists: false,
    status: 'local-only',
    syncId: 'sermon-one',
    syncVersion: null,
    localRevision: 'a'.repeat(64),
    conflict: null
  });
  assert.equal(communitySermonExpectedVersion(localOnly), null);

  const changed = projectCommunitySermonState({
    connected: true,
    canReadSermons: true,
    canWriteSermons: true,
    exists: true,
    status: 'local-changed',
    syncId: 'sermon-one',
    syncVersion: 7,
    localRevision: 'b'.repeat(64),
    conflict: null
  });
  assert.equal(communitySermonExpectedVersion(changed), 7);
  assert.equal(
    communitySermonExpectedVersion({ ...changed, conflict: { code: 'DIVERGED' } }),
    undefined
  );
  assert.throws(
    () => projectCommunitySermonState({
      ...changed,
      exists: false
    }),
    /inconsistent Community sermon status/
  );
  assert.equal(
    communitySermonPushReportedConflict({
      summary: { status: 'conflict', operation: null }
    }, changed),
    true
  );
  assert.equal(
    communitySermonPushReportedConflict({
      summary: { status: 'synced', operation: 'conflict' }
    }, changed),
    true
  );
  assert.equal(
    communitySermonPushReportedConflict({
      summary: { status: 'synced', operation: 'updated' }
    }, { ...changed, status: 'conflict', conflict: { code: 'DIVERGED' } }),
    true
  );
  assert.equal(
    communitySermonPushReportedConflict({
      summary: { status: 'synced', operation: 'updated' }
    }, changed),
    false
  );
});

test('sermon conflict review is accessible, bounded, and never renders private source details', () => {
  for (const id of [
    'btnReviewCommunitySermonConflict',
    'sermonCommunityConflictDialog',
    'sermonCommunityConflictTitle',
    'sermonCommunityConflictDescription',
    'sermonCommunityLocalRecord',
    'sermonCommunityRemoteRecord',
    'sermonCommunityConflictStatus',
    'btnCloseSermonCommunityConflict',
    'btnKeepLocalSermonConflict',
    'btnKeepCommunitySermonConflict'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  const dialog = html.slice(
    html.indexOf('<dialog id="sermonCommunityConflictDialog"'),
    html.indexOf('</dialog>', html.indexOf('<dialog id="sermonCommunityConflictDialog"')) + 9
  );
  assert.match(dialog, /aria-labelledby="sermonCommunityConflictTitle"/);
  assert.match(dialog, /aria-describedby="sermonCommunityConflictDescription"/);
  assert.match(dialog, /<h3 id="sermonCommunityLocalHeading">This Mac<\/h3>/);
  assert.match(dialog, /<h3 id="sermonCommunityRemoteHeading">Community<\/h3>/);
  assert.match(dialog, /service stays pinned to its exact saved revision/i);
  assert.match(dialog, /explicitly link another revision/i);

  const safeRender = functionBlock(
    prepareSource,
    'renderCommunitySermonConflictCopy'
  );
  assert.match(safeRender, /container\.replaceChildren\(\)/);
  assert.match(safeRender, /createElement\(/);
  assert.doesNotMatch(
    safeRender,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function/
  );
  assert.doesNotMatch(
    safeRender,
    /documentSource|remoteDocumentSource|fileName|provenance|canonicalUrl/
  );

  const projection = functionBlock(
    prepareSource,
    'projectCommunitySermonConflictCopy'
  );
  for (const field of [
    'revision',
    'title',
    'titles',
    'defaultLanguage',
    'speaker',
    'serviceDate',
    'series',
    'outline',
    'references',
    'publication',
    'sourceCount',
    'mediaCount',
    'media'
  ]) {
    assert.match(projection, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(
    projection,
    /documentSource|remoteDocumentSource|fileName|provenance|canonicalUrl|\bsourceObjects\b/
  );
  assert.match(css, /\.prepare-sermon-conflict-record/);
  assert.match(css, /\.prepare-sermon-conflict-service-note/);
});

test('sermon conflict review targets only the selected current revision', () => {
  const statusRender = functionBlock(prepareSource, 'renderSermonCommunityState');
  assert.match(
    statusRender,
    /typeof api\.getCommunitySermonConflict === 'function'[\s\S]*typeof api\.resolveCommunitySermonConflict === 'function'/
  );
  assert.match(
    statusRender,
    /sermonState\.conflict[\s\S]*sermonState\.localRevision === context\.selectedRevision[\s\S]*conflictReviewAvailable/
  );
  assert.match(
    statusRender,
    /btnReviewCommunitySermonConflict\.hidden =\s*!conflictMatchesSelectedRevision/
  );
  assert.match(
    statusRender,
    /Conflict on current revision[\s\S]*Select the current local revision above to review it\. This service stays pinned\./
  );
  assert.match(
    statusRender,
    /Review the current local and Community records without changing this service\.[\s\S]*explicitly link a different revision only if you want the service to use it/
  );
  assert.ok(
    statusRender.indexOf('if (!sermonState.canReadSermons)')
      < statusRender.indexOf('const conflictReviewAvailable'),
    'sermon conflict controls must remain unavailable without effective read access'
  );
  assert.match(statusRender, /Other advertised Community resources remain independent/);
  assert.doesNotMatch(statusRender, /Song sync still works/);
  const stateLoadStart = prepareSource.indexOf(
    'async function loadSelectedSermonCommunityState'
  );
  const stateLoadEnd = prepareSource.indexOf(
    'function renderSermonCommunityState',
    stateLoadStart
  );
  assert.ok(
    stateLoadStart >= 0 && stateLoadEnd > stateLoadStart,
    'expected the selected-sermon Community state loader'
  );
  const stateLoad = prepareSource.slice(stateLoadStart, stateLoadEnd);
  assert.match(
    stateLoad,
    /!sermonState\.canReadSermons[\s\S]*resetSermonCommunityConflict\(\{ closeDialog: true \}\)/
  );

  const open = functionBlock(prepareSource, 'openCommunitySermonConflict');
  assert.match(open, /sermonState\.canReadSermons !== true/);
  assert.match(
    open,
    /sermonState\.localRevision !== context\.selectedRevision/
  );
  assert.match(
    open,
    /api\.getCommunitySermonConflict\(\{ sermonId: context\.sermonId \}\)/
  );
  assert.match(open, /projectCommunitySermonConflict/);
  assert.match(open, /conflict\.syncId !== context\.sermonId/);
  assert.match(
    open,
    /conflict\.expectedLocalRevision !== context\.selectedRevision/
  );
  assert.match(
    open,
    /conflict\.expectedSyncVersion !== sermonState\.syncVersion/
  );
});

test('sermon conflict choices require read access and keep network-write guards distinct', () => {
  const dialog = functionBlock(
    prepareSource,
    'renderCommunitySermonConflictDialog'
  );
  assert.match(
    dialog,
    /const exactConflict = Boolean\([\s\S]*conflict\.expectedLocalRevision === context\.selectedRevision[\s\S]*Number\.isSafeInteger\(conflict\.expectedSyncVersion\)[\s\S]*conflict\.expectedSyncVersion >= 1[\s\S]*\);/
  );
  assert.match(dialog, /canReadCommunity = sermonState\?\.canReadSermons === true/);
  assert.match(dialog, /&& canReadCommunity/);
  assert.match(
    dialog,
    /canReadCommunity \? \(conflict\?\.community \|\| null\) : null/
  );
  assert.match(
    dialog,
    /const liveConflictMatches = Boolean\([\s\S]*sermonState\?\.connected === true[\s\S]*sermonState\.canWriteSermons === true[\s\S]*Boolean\(sermonState\.conflict\)[\s\S]*sermonState\.localRevision === conflict\.expectedLocalRevision[\s\S]*sermonState\.syncVersion === conflict\.expectedSyncVersion/
  );
  assert.match(
    dialog,
    /btnKeepLocalSermonConflict\.disabled = locked\s*\|\| !liveConflictMatches/
  );
  assert.match(
    dialog,
    /btnKeepCommunitySermonConflict\.disabled = locked/
  );
  assert.match(dialog, /requires current Community sermon-library read access/);

  const resolve = functionBlock(prepareSource, 'resolveCommunitySermonConflict');
  assert.match(
    resolve,
    /const keepLocalAllowed = Boolean\([\s\S]*sermonState\?\.connected === true[\s\S]*sermonState\.canWriteSermons === true[\s\S]*Boolean\(sermonState\.conflict\)[\s\S]*sermonState\.localRevision === conflict\.expectedLocalRevision[\s\S]*sermonState\.syncVersion === conflict\.expectedSyncVersion/
  );
  assert.doesNotMatch(
    `${dialog}\n${resolve}`,
    /sermonState\.conflict === true/
  );
  assert.match(
    resolve,
    /const keepRemoteAllowed = Boolean\([\s\S]*exactConflict[\s\S]*sermonState\?\.canReadSermons === true/
  );
  assert.match(
    resolve,
    /exactConflict[\s\S]*sermonState\?\.canReadSermons === true[\s\S]*state\.sermonCommunityConflictContextKey/
  );
  assert.match(resolve, /window\.confirm\(confirmation\)/);
  assert.match(
    resolve,
    /api\.resolveCommunitySermonConflict\(\{\s*sermonId: context\.sermonId,\s*strategy,\s*expectedSyncVersion: conflict\.expectedSyncVersion,\s*expectedLocalRevision: conflict\.expectedLocalRevision\s*\}\)/s
  );
  assert.match(resolve, /resolution\?\.resolved !== true/);
  assert.match(resolve, /Nothing was overwritten, and both sermon revisions remain preserved/);
  assert.ok(
    resolve.indexOf('resolution?.resolved !== true')
      < resolve.indexOf('resolvedSuccessfully = true'),
    'a retained conflict must be handled before success'
  );
  assert.match(resolve, /await loadSermons\(\)/);
  assert.match(
    resolve,
    /await loadSelectedSermonCommunityState\(\{ force: true \}\)/
  );
  assert.match(resolve, /explicitly link the current revision/);
  assert.doesNotMatch(
    resolve,
    /mutateProject|sourceSermonForServiceItem|pushCommunitySermon|documentSource|remoteDocumentSource/
  );
});

test('sermon conflict projection accepts only bounded safe copies and exact guards', () => {
  const { projectCommunitySermonConflict } = prepareExports();
  const revisionA = 'a'.repeat(64);
  const revisionB = 'b'.repeat(64);
  const link = (fingerprint, parametersHidden = false) => ({
    origin: 'https://church.example',
    pathDisplay: '/sermons/reviewed',
    parametersHidden,
    fingerprint
  });
  const copy = (revision, title, fingerprint = 'ABCD-1234-EF56') => ({
    revision,
    title,
    titles: { en: title, ru: `${title} RU` },
    defaultLanguage: 'en',
    speaker: { id: 'speaker-one', name: 'Pastor One' },
    serviceDate: '2026-07-27',
    series: { id: 'series-one', titles: { en: 'Romans' } },
    outline: [{
      id: 'section-one',
      parentId: null,
      kind: 'point',
      titles: { en: 'Grace' }
    }],
    references: [{
      id: 'reference-one',
      range: {
        bookId: 'Romans',
        start: { chapter: 1, verse: 1 },
        end: { chapter: 1, verse: 2 }
      },
      role: 'primary',
      reviewStatus: 'confirmed',
      enteredText: 'Romans 1:1-2',
      sectionId: 'section-one'
    }],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalLink: link(fingerprint, true)
    },
    sourceCount: 2,
    mediaCount: 1,
    media: {
      total: 1,
      shown: 1,
      truncated: false,
      setFingerprint: '1111-2222-3333',
      items: [{
        kind: 'audio',
        status: 'ready',
        title: 'Sermon audio',
        language: 'en',
        link: link(fingerprint, true)
      }]
    }
  });
  const projected = projectCommunitySermonConflict({
    syncId: 'sermon-one',
    code: 'DIVERGED',
    detectedAt: '2026-07-27T12:00:00.000Z',
    expectedSyncVersion: 4,
    expectedLocalRevision: revisionA,
    local: copy(revisionA, 'Local title'),
    community: copy(revisionB, 'Community title'),
    remoteDocumentSource: 'must not survive'
  });
  assert.equal(projected.expectedSyncVersion, 4);
  assert.equal(projected.expectedLocalRevision, revisionA);
  assert.equal(projected.local.title, 'Local title');
  assert.equal(projected.community.references[0].label, 'Romans 1:1–2');
  assert.equal(Object.hasOwn(projected, 'remoteDocumentSource'), false);
  assert.equal(Object.hasOwn(projected.local, 'canonicalUrl'), false);
  assert.equal(
    projected.local.publication.canonicalLink.fingerprint,
    'ABCD-1234-EF56'
  );
  assert.equal(projected.local.publication.canonicalLink.parametersHidden, true);
  assert.equal(projected.local.media.items[0].link.origin, 'https://church.example');
  assert.equal(Object.hasOwn(projected.local.media.items[0].link, 'href'), false);

  assert.throws(
    () => projectCommunitySermonConflict({
      syncId: 'sermon-one',
      expectedSyncVersion: 4,
      expectedLocalRevision: revisionA,
      local: {
        ...copy(revisionA, 'Local title'),
        outline: Array.from({ length: 501 }, () => ({
          kind: 'point',
          titles: { en: 'Too many' }
        }))
      },
      community: copy(revisionB, 'Community title')
    }),
    /invalid local sermon outline/
  );
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
  assert.match(connect, /normalizeCommunityServerAddress\(elements\.communityServerUrl\.value\)/);
  assert.doesNotMatch(connect, /\bpassword\b|\btoken\b/i);
  assert.match(functionBlock(appSource, 'communityCheckedResult'), /details\?\.message/);
  assert.match(functionBlock(appSource, 'communityCheckedResult'), /details\?\.code/);
});

test('Community server addresses accept a bare hostname and normalize pasted links to HTTPS origins', () => {
  const addressInput = /<input id="communityServerUrl"[^>]+>/.exec(html)?.[0] || '';
  assert.match(addressInput, /type="text"/);
  assert.match(addressInput, /inputmode="url"/);
  assert.match(addressInput, /placeholder="community\.example\.org"/);
  assert.doesNotMatch(addressInput, /type="url"/);

  const source = `${functionBlock(appSource, 'normalizeCommunityServerAddress')}; normalizeCommunityServerAddress`;
  const normalize = vm.runInNewContext(source, { URL }, {
    filename: 'community-server-address.js'
  });
  assert.equal(normalize('wotbc.heritage.faith'), 'https://wotbc.heritage.faith');
  assert.equal(normalize('  https://wotbc.heritage.faith/  '), 'https://wotbc.heritage.faith');
  assert.equal(
    normalize('wotbc.heritage.faith/community/services/august-23?view=prepare#top'),
    'https://wotbc.heritage.faith'
  );
  assert.equal(normalize('http://localhost:3000/admin'), 'http://localhost:3000');
  assert.throws(() => normalize('http://wotbc.heritage.faith'), /HTTPS/);
  assert.throws(() => normalize('https://user:secret@wotbc.heritage.faith'), /credentials/);
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

test('song sharing is a separate exact-family review and local save has no Community mutation', () => {
  for (const id of [
    'songDocumentCommunityState',
    'btnReviewSongCommunitySharing',
    'btnRestrictSongCommunity',
    'songCommunitySharingReviewDialog',
    'songCommunitySharingReviewTitle',
    'songCommunitySharingReviewDescription',
    'songCommunitySharingReviewForm',
    'songCommunitySharingFamilyInstructions',
    'songCommunitySharingFamily',
    'songCommunitySharingVisibility',
    'songCommunitySharingPublishAtField',
    'songCommunitySharingPublishAt',
    'songCommunitySharingPublishAtHelp',
    'songCommunitySharingBasis',
    'songCommunitySharingEvidence',
    'songCommunitySharingReviewNote',
    'songCommunitySharingValidUntil',
    'songCommunitySharingConfirmed',
    'songCommunitySharingStatus',
    'songCommunitySharingError',
    'btnCancelSongCommunitySharing',
    'btnRefreshSongCommunitySharing',
    'btnApplySongCommunitySharing'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  for (const removedId of [
    'songDocumentCommunityVisibility',
    'songDocumentPublishAtField',
    'songDocumentPublishAt'
  ]) {
    assert.equal(uniqueIdCount(removedId), 0, `${removedId} must not remain in local editing`);
  }
  assert.match(html, /Saving lyrics stays local/);
  assert.match(
    html,
    /Submitting to Community separately confirms the exact original, every linked translation, and the intended access/
  );
  assert.match(
    html,
    /option value="private">Community admins only/
  );
  assert.match(html, /Review and submit/);
  assert.match(html, /Review every original and translation below/);
  assert.match(
    html,
    /SyncShow does not require a license number or rights evidence/
  );

  const documentSource = functionBlock(prepareSource, 'currentSongDocumentSource');
  assert.doesNotMatch(documentSource, /Community|visibility|publishAt|syncVersion/,
    'Community policy must not alter the immutable SongDocument source');

  const localSave = functionBlock(prepareSource, 'saveSongDraft');
  assert.match(localSave, /api\.saveSongDocument\(\{/);
  assert.doesNotMatch(
    localSave,
    /saveSongCommunityVisibility|setCommunitySongVisibility|beginCommunitySongSharingReview|applyCommunitySongSharingReview/,
    'saving a local immutable revision must never trigger a Community mutation or review'
  );
  assert.match(localSave, /saved locally|Library updated/i);

  const familyRender = functionBlock(prepareSource, 'renderSongSharingFamily');
  assert.match(familyRender, /family\.documents|proposal\.family\.documents/);
  assert.match(familyRender, /\.title/);
  assert.match(familyRender, /\.language/);
  assert.match(familyRender, /\.textContent\s*=/);
  assert.doesNotMatch(
    familyRender,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function/,
    'untrusted family metadata must be rendered as text'
  );

  assert.match(prepareSource, /api\.beginCommunitySongSharingReview\(\{\s*songId/s);
  const applyCall = callExpressionBlock(
    prepareSource,
    'api.applyCommunitySongSharingReview'
  );
  for (const field of [
    'proposalToken',
    'visibility',
    'publishAt',
    'basis',
    'evidence',
    'validUntil',
    'confirmed'
  ]) {
    assert.match(
      applyCall,
      new RegExp(`\\b${field}\\b(?:\\s*:|\\s*[,}])`),
      `${field} must be sent`
    );
  }
  assert.doesNotMatch(
    applyCall,
    /\b(?:songId|familyId|familyRevision|reviewedAt|expectedSyncVersion)\s*:/,
    'review apply must send only the opaque proposal and operator-entered intent'
  );

  assert.match(css, /\.prepare-song-community-state\[data-kind="conflict"\]/);
  assert.match(css, /\.prepare-song-sync-badge\.conflict/);
  const songCommunityState = functionBlock(prepareSource, 'renderSongCommunityState');
  assert.match(songCommunityState, /pendingVisibility/);
  assert.match(songCommunityState, /confirmedVisibility/);
  assert.match(songCommunityState, /communityEffectiveAccessDescription/);
  assert.match(
    songCommunityState,
    /const confirmedMemberVisible = effectiveVisibility === 'public'/
  );
  assert.doesNotMatch(
    songCommunityState,
    /btnRestrictSongCommunity\.disabled\s*=[^;]*conflict/,
    'a content conflict must not block a visibility-only admin restriction'
  );
  const restrictAction = functionBlock(prepareSource, 'restrictSongCommunity');
  assert.match(
    restrictAction,
    /else \{[\s\S]*await loadSongCommunityState\(songId\)[\s\S]*state\.songCommunityError = message/,
    'a failed demotion must reload any server or conflict state saved during the attempt'
  );
  const syncSummary = functionBlock(appSource, 'formatCommunitySyncSummary');
  assert.match(syncSummary, /\['reviewRequired'\]/);
  assert.match(syncSummary, /song famil(?:y needs|ies need).*sharing review/);
});

test('song sharing review is accessible, time-bounded, and delegates schedule authority', () => {
  const dialogStart = html.indexOf('<dialog id="songCommunitySharingReviewDialog"');
  const dialog = html.slice(dialogStart, html.indexOf('</dialog>', dialogStart) + 9);
  assert.match(
    dialog,
    /aria-labelledby="songCommunitySharingReviewTitle" aria-describedby="songCommunitySharingReviewDescription songCommunitySharingFamilyInstructions"/
  );
  assert.match(dialog, /id="songCommunitySharingReviewTitle" tabindex="-1"/);
  assert.match(
    dialog,
    /id="songCommunitySharingFamily"[^>]+role="list"[^>]+aria-labelledby="songCommunitySharingFamilyHeading"[^>]+aria-describedby="songCommunitySharingFamilyInstructions"/
  );
  assert.match(dialog, /id="songCommunitySharingFamily"[^>]+tabindex="0"/);
  assert.match(
    dialog,
    /id="songCommunitySharingPublishAt"[^>]+type="datetime-local"[^>]+aria-describedby="songCommunitySharingPublishAtHelp"/
  );
  assert.match(
    dialog,
    /id="songCommunitySharingPublishAtHelp"[^>]*>Choose a date and time\. Heritage Community will confirm whether the schedule is allowed/
  );
  assert.match(
    dialog,
    /id="songCommunitySharingBasis" type="hidden" value="church-managed"/
  );
  assert.match(
    dialog,
    /id="songCommunitySharingEvidence" type="hidden" value=""/
  );
  assert.match(dialog, /id="songCommunitySharingStatus"[^>]+aria-atomic="true"/);
  assert.match(dialog, /id="btnRefreshSongCommunitySharing"[^>]+hidden/);

  const {
    communityScheduledPublishIsFuture,
    futureLocalDateTimeMinimum,
    songCommunitySharingProposalExpired
  } = prepareExports();
  const now = Date.parse('2026-07-27T18:00:00.000Z');
  const minimum = futureLocalDateTimeMinimum(now);
  assert.match(minimum, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(new Date(minimum).getTime(), now + 60_000);
  assert.equal(
    communityScheduledPublishIsFuture('2026-07-27T18:00:00.001Z', now),
    true
  );
  assert.equal(
    communityScheduledPublishIsFuture('2026-07-27T18:00:00.000Z', now),
    false
  );
  assert.equal(communityScheduledPublishIsFuture('not-a-date', now), false);
  assert.equal(
    songCommunitySharingProposalExpired({
      expiresAt: '2026-07-27T18:00:00.001Z'
    }, now),
    false
  );
  assert.equal(
    songCommunitySharingProposalExpired({
      expiresAt: '2026-07-27T18:00:00.000Z'
    }, now),
    true
  );
  assert.equal(songCommunitySharingProposalExpired({ expiresAt: 'invalid' }, now), true);

  const familyRender = functionBlock(prepareSource, 'renderSongSharingFamily');
  assert.match(familyRender, /setAttribute\('role', 'listitem'\)/);
  assert.match(familyRender, /document\.createElement\('h4'\)/);
  assert.match(familyRender, /setAttribute\('aria-labelledby', title\.id\)/);

  const dialogRender = functionBlock(
    prepareSource,
    'renderSongCommunitySharingReviewDialog'
  );
  assert.match(dialogRender, /songCommunitySharingPublishAt\.removeAttribute\('min'\)/);
  assert.doesNotMatch(
    dialogRender,
    /songCommunitySharingPublishAt\.min = futureLocalDateTimeMinimum\(\)/
  );
  assert.match(dialogRender, /songCommunitySharingProposalExpired\(proposal\)/);
  assert.match(dialogRender, /review window expires at/);
  assert.match(dialogRender, /btnRefreshSongCommunitySharing\.hidden/);

  const openReview = functionBlock(prepareSource, 'openSongCommunitySharingReview');
  assert.match(openReview, /songCommunitySharingProposalExpired\(proposal\)/);
  assert.match(openReview, /scheduleSongCommunitySharingExpiry/);
  assert.match(openReview, /songCommunitySharingReviewTitle\.focus\(\)/);
  assert.match(openReview, /songCommunityRemoteState\?\.canWriteSongs !== true/);

  const applyReview = functionBlock(prepareSource, 'applySongCommunitySharingReview');
  assert.match(applyReview, /songCommunityRemoteState\?\.canWriteSongs !== true/);
  assert.match(applyReview, /!Number\.isFinite\(Date\.parse\(publishAt\)\)/);
  assert.doesNotMatch(applyReview, /communityScheduledPublishIsFuture\(publishAt\)/);
  assert.match(
    applyReview,
    /Heritage Community will decide whether the schedule is allowed/
  );
  assert.match(applyReview, /receipt\?\.timeZone/);
  assert.match(applyReview, /receipt\.validThrough/);
  assert.match(applyReview, /songState\?\.effectiveVisibility === 'public'/);
  assert.match(applyReview, /refreshSongCommunitySharingReview\(\)/);
  assert.match(applyReview, /fieldCorrectionCanRetry/);
  assert.match(applyReview, /INVALID_SHARING_REVIEW/);
  assert.match(
    functionBlock(prepareSource, 'restrictSongCommunity'),
    /songCommunityRemoteState\?\.canWriteSongs !== true/
  );

  const refreshReview = functionBlock(prepareSource, 'refreshSongCommunitySharingReview');
  assert.match(refreshReview, /invalidateSongCommunitySharingProposal\(\)/);
  assert.match(refreshReview, /openSongCommunitySharingReview\(\)/);

  const stateRender = functionBlock(prepareSource, 'renderSongCommunityState');
  assert.match(stateRender, /exists === false[\s\S]*No Community copy is confirmed yet/);
  assert.match(stateRender, /pendingVisibility\?\.visibility === 'private'/);
  assert.match(
    stateRender,
    /communityVisibilityIsMemberVisible\(\s*pendingVisibility\?\.visibility\s*\)/
  );
  assert.match(stateRender, /older local member-sharing choice is not server authority/i);
  assert.match(stateRender, /Admin-only restriction is queued; content conflict remains/);
  assert.match(stateRender, /const canReadSongs = connected/);
  assert.match(stateRender, /const canWriteSongs = canReadSongs/);
  assert.match(stateRender, /const laneUnavailable = connected && !canReadSongs/);
  assert.match(stateRender, /\|\| !canWriteSongs/);
  assert.match(stateRender, /other Community resources remain independent/);
  assert.match(stateRender, /\|\| !state\.songCommunityLoaded/);

  assert.match(
    css,
    /\.prepare-song-sharing-family-rights\s*\{[^}]*font-size:\s*0\.72rem/s
  );
  assert.match(
    css,
    /\.prepare-song-sharing-family-document header h4\s*\{[^}]*font-size:\s*0\.8rem/s
  );
  assert.match(css, /\.prepare-song-sharing-family-list:focus-visible/);
});

test('anonymous song links are a separate accessible Community scope with an exact rights review', () => {
  for (const id of [
    'songPublicLinkCard',
    'songPublicLinkHeading',
    'songPublicLinkState',
    'btnManageSongPublicLinks',
    'songPublicLinksDialog',
    'songPublicLinksForm',
    'songPublicLinksTitle',
    'songPublicLinksDescription',
    'songPublicLinksActiveHeading',
    'songPublicLinksActiveHelp',
    'songPublicLinksList',
    'btnRefreshSongPublicLinks',
    'songPublicLinkCreateSection',
    'songPublicLinkCreateBlocked',
    'songPublicLinkFamily',
    'songPublicLinkLabel',
    'songPublicLinkExpiresAt',
    'songPublicLinkBasis',
    'songPublicLinkEvidence',
    'songPublicLinkValidUntil',
    'songPublicLinkConfirmed',
    'songPublicLinksStatus',
    'songPublicLinksError',
    'btnCloseSongPublicLinks',
    'btnCreateSongPublicLink'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }

  const sharingStart = html.indexOf('<fieldset class="prepare-song-community-sharing"');
  const sharing = html.slice(
    sharingStart,
    html.indexOf('</fieldset>', sharingStart) + 11
  );
  assert.match(sharing, /Signed-in church members/);
  assert.match(sharing, /Anyone with the link/);
  assert.match(sharing, /No Community sign-in is required/);
  assert.match(
    sharing,
    /A member-sharing review does not authorize an anonymous link/
  );
  assert.match(sharing, /id="btnManageSongPublicLinks"[^>]+hidden[^>]+disabled/);

  const dialogStart = html.indexOf('<dialog id="songPublicLinksDialog"');
  const dialog = html.slice(
    dialogStart,
    html.indexOf('</dialog>', dialogStart) + 9
  );
  assert.match(
    dialog,
    /aria-labelledby="songPublicLinksTitle" aria-describedby="songPublicLinksDescription"/
  );
  assert.match(dialog, /id="songPublicLinksTitle" tabindex="-1"/);
  assert.match(
    dialog,
    /id="songPublicLinksList"[^>]+role="list"[^>]+tabindex="0"[^>]+aria-labelledby="songPublicLinksActiveHeading"[^>]+aria-describedby="songPublicLinksActiveHelp"/
  );
  assert.match(
    dialog,
    /id="songPublicLinkFamily"[^>]+role="list"[^>]+tabindex="0"[^>]+aria-labelledby="songPublicLinkFamilyHeading"[^>]+aria-describedby="songPublicLinkFamilyInstructions"/
  );
  assert.match(dialog, /exact saved song-family snapshot without signing in/);
  assert.match(dialog, /Editing this song never silently changes an existing link/);

  assert.match(
    dialog,
    /id="songPublicLinkBasis" type="hidden" value="church-managed"/
  );
  assert.match(dialog, /id="songPublicLinkEvidence" type="hidden" value=""/);
  assert.match(dialog, /id="songPublicLinkConfirmed"[^>]+required/);
  assert.match(
    dialog,
    /SyncShow does not require a license number or rights evidence/
  );
  for (const optionalId of [
    'songPublicLinkLabel',
    'songPublicLinkExpiresAt'
  ]) {
    const tag = dialog.match(new RegExp(`<input id="${optionalId}"[^>]*>`))?.[0];
    assert.ok(tag, `${optionalId} must exist`);
    assert.doesNotMatch(tag, /\brequired\b/, `${optionalId} must stay optional`);
  }

  assert.match(
    css,
    /\.prepare-song-public-links-list\s*\{[^}]*max-height:[^}]*overflow:\s*auto/s
  );
  assert.match(
    css,
    /\.prepare-song-public-link-url\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s
  );
  assert.match(
    css,
    /\.prepare-song-public-link-actions\s*\{[^}]*flex-wrap:\s*wrap/s
  );
  assert.match(css, /\.prepare-song-community-sections,[\s\S]*grid-template-columns:\s*1fr/);
});

test('anonymous song-link timing and server projections reject unsafe or inconsistent data', () => {
  const {
    normalizeSongPublicLink,
    normalizeSongPublicLinkList,
    songPublicLinkProposalExpired,
    songPublicLinkTiming
  } = prepareExports();
  const now = Date.parse('2026-07-27T18:00:00.000Z');

  assert.deepEqual(
    JSON.parse(JSON.stringify(songPublicLinkTiming({}, now))),
    { expiresAt: null, validUntil: null }
  );
  const bounded = songPublicLinkTiming({
    expiresAt: '2030-01-01T12:00',
    validUntil: '2030-01-01'
  }, now);
  assert.equal(bounded.expiresAt, new Date('2030-01-01T12:00').toISOString());
  assert.equal(bounded.validUntil, '2030-01-01');
  assert.ok(Object.isFrozen(bounded));
  assert.throws(
    () => songPublicLinkTiming({ expiresAt: '2020-01-01T12:00' }, now),
    /future link expiry/
  );
  assert.throws(
    () => songPublicLinkTiming({ validUntil: '2030-01-01' }, now),
    /Choose a link expiry/
  );
  assert.throws(
    () => songPublicLinkTiming({
      expiresAt: '2030-01-02T00:00',
      validUntil: '2030-01-01'
    }, now),
    /no later than the end/
  );
  assert.equal(
    songPublicLinkProposalExpired({
      expiresAt: '2026-07-27T18:00:00.001Z'
    }, now),
    false
  );
  assert.equal(
    songPublicLinkProposalExpired({
      expiresAt: '2026-07-27T18:00:00.000Z'
    }, now),
    true
  );

  const validLink = {
    actionToken: 'a'.repeat(48),
    status: 'active',
    label: 'Tuesday home group',
    createdAt: '2026-07-27T18:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    familyRevision: 'b'.repeat(64),
    olderVersion: false,
    shareUrl: 'https://community.example.org/community/songs/shared/example'
  };
  const normalized = normalizeSongPublicLink(validLink);
  assert.equal(normalized.actionToken, validLink.actionToken);
  assert.equal(normalized.shareUrl, validLink.shareUrl);
  assert.ok(Object.isFrozen(normalized));
  assert.throws(
    () => normalizeSongPublicLink({
      ...validLink,
      actionToken: 'short'
    }),
    /invalid public song link/
  );
  assert.throws(
    () => normalizeSongPublicLink({
      ...validLink,
      actionToken: null
    }),
    /invalid public song link/
  );
  assert.throws(
    () => normalizeSongPublicLink({
      ...validLink,
      shareUrl: null
    }),
    /without a share URL/
  );
  assert.throws(
    () => normalizeSongPublicLink({
      ...validLink,
      olderVersion: 'false'
    }),
    /invalid public song link/
  );
  assert.throws(
    () => normalizeSongPublicLink({
      ...validLink,
      shareUrl: 'http://community.example.org/shared/example'
    }),
    /unsafe public song link URL/
  );
  assert.throws(
    () => normalizeSongPublicLink({
      ...validLink,
      shareUrl: `${validLink.shareUrl}?secret=client-built`
    }),
    /unsafe public song link URL/
  );
  assert.throws(
    () => normalizeSongPublicLink({
      ...validLink,
      status: 'revoked',
      actionToken: null,
      shareUrl: null
    }),
    /inconsistent public song link/
  );
  const revokedHistory = normalizeSongPublicLink({
    ...validLink,
    actionToken: null,
    status: 'revoked',
    revokedAt: '2026-07-28T18:00:00.000Z',
    shareUrl: null
  });
  assert.equal(revokedHistory.actionToken, null);
  assert.equal(revokedHistory.status, 'revoked');
  const list = normalizeSongPublicLinkList({ links: [validLink] });
  assert.equal(list.length, 1);
  assert.ok(Object.isFrozen(list));
  assert.equal(
    normalizeSongPublicLinkList({
      links: Array.from({ length: 200 }, () => validLink)
    }).length,
    200
  );
  assert.throws(
    () => normalizeSongPublicLinkList({
      links: Array.from({ length: 201 }, () => validLink)
    }),
    /invalid public song-link list/
  );
});

test('anonymous song-link renderer uses optional APIs, opaque actions, and confirmed mutations', () => {
  const requiredStart = prepareSource.indexOf('const requiredApi = [');
  const requiredEnd = prepareSource.indexOf('];', requiredStart);
  const requiredApi = prepareSource.slice(requiredStart, requiredEnd + 2);
  for (const optionalMethod of [
    'listCommunitySongPublicLinks',
    'beginCommunitySongPublicLinkReview',
    'createCommunitySongPublicLink',
    'copyCommunitySongPublicLink',
    'revokeCommunitySongPublicLink'
  ]) {
    assert.doesNotMatch(
      requiredApi,
      new RegExp(optionalMethod),
      `${optionalMethod} must not disable core Prepare`
    );
    assert.match(prepareSource, new RegExp(`api\\.${optionalMethod}\\(`));
  }

  const stateRender = functionBlock(prepareSource, 'renderSongPublicLinkState');
  assert.match(
    functionBlock(prepareSource, 'songPublicLinkCanRead'),
    /canReadSongPublicLinks/
  );
  assert.match(
    functionBlock(prepareSource, 'songPublicLinkCanWrite'),
    /canWriteSongPublicLinks/
  );
  assert.match(stateRender, /btnManageSongPublicLinks\.hidden = !readApi/);
  assert.match(stateRender, /Public song-link access is not approved/);
  assert.match(stateRender, /There is no inactive link control to apply/);
  const clearForAuthorization = functionBlock(
    prepareSource,
    'clearSongPublicLinkStateForAuthorizationError'
  );
  for (const code of [
    'AUTH_REQUIRED',
    'AUTHORIZATION_EXPIRED',
    'COMMUNITY_RECONNECT_REQUIRED',
    'PERMISSION_DENIED',
    'SONG_PUBLIC_LINKS_UNAVAILABLE'
  ]) {
    assert.match(clearForAuthorization, new RegExp(`'${code}'`));
  }
  assert.match(
    clearForAuthorization,
    /clearSongPublicLinkProtectedState\(\{\s*closeDialog:\s*true\s*\}\)/
  );
  const dialogRender = functionBlock(prepareSource, 'renderSongPublicLinksDialog');
  assert.match(dialogRender, /songPublicLinkCreateSection\.hidden = !canWrite/);
  assert.match(dialogRender, /btnCreateSongPublicLink\.hidden = !canWrite/);

  const list = functionBlock(prepareSource, 'listSongPublicLinks');
  assert.match(list, /listCommunitySongPublicLinks\(\{\s*songId\s*\}\)/);
  assert.match(list, /previouslyLoaded \? previousLinks : \[\]/);
  const begin = functionBlock(prepareSource, 'beginSongPublicLinkProposal');
  assert.match(begin, /beginCommunitySongPublicLinkReview\(\{\s*songId\s*\}\)/);
  assert.doesNotMatch(
    begin,
    /state\.songPublicLinks\s*=/,
    'a failed create review must preserve the independently listed links'
  );
  const open = functionBlock(prepareSource, 'openSongPublicLinksDialog');
  assert.ok(
    open.indexOf('await listSongPublicLinks') < open.indexOf('await beginSongPublicLinkProposal'),
    'existing links must be listed before a new create review begins'
  );
  assert.match(list, /songPublicLinksTitle\.focus\(\)/);

  const createCall = callExpressionBlock(
    prepareSource,
    'api.createCommunitySongPublicLink'
  );
  for (const field of [
    'proposalToken',
    'label',
    'basis',
    'evidence',
    'validUntil',
    'expiresAt',
    'confirmed'
  ]) {
    assert.match(
      createCall,
      new RegExp(`\\b${field}\\b(?:\\s*:|\\s*[,}])`),
      `${field} must be sent`
    );
  }
  assert.doesNotMatch(
    createCall,
    /\b(?:songId|family|familyRevision|shareUrl|actionToken)\s*:/,
    'create must send only the opaque proposal and operator-entered intent'
  );
  const create = functionBlock(prepareSource, 'createSongPublicLink');
  assert.match(create, /normalizeSongPublicLink\(result\?\.link\)/);
  assert.match(create, /created\.status !== 'active' \|\| !created\.shareUrl/);
  assert.match(create, /data-public-link-copy-created/);
  assert.match(create, /SONG_PUBLIC_LINK_CREATE_UNCONFIRMED/);
  assert.match(create, /state\.songPublicLinkRecoveryPending = true/);
  assert.match(create, /Retry uses the exact same request and idempotency key/);
  const refresh = functionBlock(prepareSource, 'refreshSongPublicLinks');
  assert.match(
    refresh,
    /const recovering = state\.songPublicLinkRecoveryPending[\s\S]*if \(!recovering\)[\s\S]*invalidateSongPublicLinkProposal/
  );
  const closePublicLinks = functionBlock(
    prepareSource,
    'closeSongPublicLinksDialog'
  );
  assert.match(
    closePublicLinks,
    /if \(!state\.songPublicLinkRecoveryPending\)[\s\S]*invalidateSongPublicLinkProposal/
  );
  assert.match(dialogRender, /Retry same link request/);

  const copy = functionBlock(prepareSource, 'copySongPublicLink');
  assert.match(copy, /copyCommunitySongPublicLink\(\{\s*actionToken\s*\}\)/);
  assert.match(copy, /result\?\.copied !== true/);
  assert.doesNotMatch(copy, /navigator\.clipboard|writeText|shareUrl\s*:/);
  const revoke = functionBlock(prepareSource, 'revokeSongPublicLink');
  assert.match(revoke, /revokeCommunitySongPublicLink\(\{\s*actionToken\s*\}\)/);
  assert.match(revoke, /result\?\.revoked !== true/);
  assert.match(revoke, /returned\.status !== 'revoked'/);
  assert.ok(
    revoke.indexOf("result?.revoked !== true") < revoke.indexOf('state.songPublicLinks.splice'),
    'the list must not change until Community confirms revocation'
  );
  assert.match(revoke, /The link may still work until Heritage Community confirms revocation/);
  for (const operation of [list, begin, create, copy, revoke]) {
    assert.match(
      operation,
      /clearSongPublicLinkStateForAuthorizationError\(error\)/,
      'authorization loss must purge protected URLs and opaque action state'
    );
  }

  const listRender = functionBlock(prepareSource, 'renderSongPublicLinksList');
  assert.match(listRender, /link\.shareUrl/);
  assert.match(
    listRender,
    /link\.status === 'active' && link\.actionToken && link\.shareUrl/
  );
  assert.match(
    listRender,
    /link\.status === 'active' && link\.actionToken && canWrite/
  );
  assert.match(listRender, /\.textContent/);
  assert.doesNotMatch(
    listRender,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|navigator\.clipboard|new URL/
  );
  const dirty = functionBlock(prepareSource, 'markSongDraftDirty');
  assert.match(dirty, /invalidateSongPublicLinkProposal/);
  assert.match(dirty, /Existing links are unchanged/);
  assert.doesNotMatch(dirty, /state\.songPublicLinks\s*=/);
  const close = functionBlock(prepareSource, 'closeSongPublicLinksDialog');
  assert.match(close, /btnManageSongPublicLinks\.focus\(\)/);
  assert.match(prepareSource, /state\.songPublicLinksBusy[\s\S]*isBusy:/);
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
  assert.match(review, /songCommunityRemoteState\?\.canReadSongs !== true/);
  const load = functionBlock(prepareSource, 'loadSongCommunityConflict');
  assert.match(load, /songCommunityRemoteState\?\.canReadSongs !== true/);
  assert.match(load, /songCommunityConflictRequest/);
  assert.match(load, /getCommunitySongConflict\(\{ songId \}\)/);
  assert.match(load, /localDocuments/);
  assert.match(load, /communityDocuments/);
  const renderDialog = functionBlock(
    prepareSource,
    'renderSongCommunityConflictDialog'
  );
  assert.match(
    renderDialog,
    /canReplaceCommunity = state\.songCommunityRemoteState\?\.canWriteSongs === true/
  );
  assert.match(
    renderDialog,
    /canReadCommunity =\s*state\.songCommunityRemoteState\?\.canReadSongs === true/
  );
  assert.match(
    renderDialog,
    /btnKeepLocalSongConflict\.disabled = busy[\s\S]*!canReplaceCommunity/
  );
  assert.doesNotMatch(
    renderDialog,
    /btnKeepCommunitySongConflict\.disabled = [^;]*canReplaceCommunity/
  );

  const resolve = functionBlock(prepareSource, 'resolveSongCommunityConflict');
  assert.match(resolve, /canReadCommunity/);
  assert.match(resolve, /canWriteCommunity/);
  assert.match(resolve, /strategy === 'keep-local' && !canWriteCommunity/);
  assert.match(resolve, /strategy === 'keep-remote' && !canReadCommunity/);
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
  assert.doesNotMatch(
    communityRender,
    /btnSaveSong\.disabled[\s\S]{0,220}\|\| conflict/,
    'a Community conflict must not block saving local song work'
  );
  assert.match(
    communityRender,
    /btnReviewSongCommunityConflict\.hidden = !conflict \|\| !canReadSongs/
  );
  const songStateLoad = functionBlock(prepareSource, 'loadSongCommunityState');
  assert.match(
    songStateLoad,
    /canReadSongs !== true[\s\S]*resetSongCommunityConflict\(\{ closeDialog: true \}\)/
  );
  assert.match(
    prepareSource,
    /refreshSongCommunityState:[\s\S]*loadSongCommunityState\(state\.songEditingId\)/
  );
  assert.match(css, /\.prepare-conflict-document pre/);
});
