'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function handlerBlock(channel, nextChannel) {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `expected ${channel}`);
  const end = nextChannel
    ? mainSource.indexOf(`ipcMain.handle('${nextChannel}'`, start)
    : mainSource.length;
  assert.ok(end > start, `expected boundary after ${channel}`);
  return mainSource.slice(start, end);
}

test('anonymous song-link channels are trusted and remain separate from member visibility', () => {
  const channels = [
    'community:songs:listPublicLinks',
    'community:songs:beginPublicLinkReview',
    'community:songs:createPublicLink',
    'community:songs:copyPublicLink',
    'community:songs:revokePublicLink'
  ];
  for (const channel of channels) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1);
    assert.match(mainSource.slice(start, start + 260), /requireControlSender\(event\)/u);
  }

  const create = handlerBlock(
    'community:songs:createPublicLink',
    'community:songs:copyPublicLink'
  );
  const member = handlerBlock(
    'community:songs:applySharingReview',
    'community:songs:setVisibility'
  );
  assert.doesNotMatch(member, /PublicLink|publicLink/u);
  assert.doesNotMatch(create, /runCommunitySongSync|setSongVisibility/u);
  assert.match(create, /createSongPublicLinkReview/u);
  assert.match(create, /scope:\s*'public-link'|confirmedReview/u);
});

test('public-link create authority is main-owned and rechecks exact local and remote state', () => {
  const begin = handlerBlock(
    'community:songs:beginPublicLinkReview',
    'community:songs:createPublicLink'
  );
  const create = handlerBlock(
    'community:songs:createPublicLink',
    'community:songs:copyPublicLink'
  );
  assert.match(begin, /resolveCommunitySongFamily\(songId\)/u);
  assert.match(begin, /exactCommunitySongForPublicLink/u);
  assert.match(begin, /songSyncVersion:\s*remote\.syncVersion/u);
  assert.match(begin, /expectedReviewRevision:\s*songPublicLinkReviewRevision\(review\)/u);
  assert.match(begin, /holdSongPublicLinkReviewProposal/u);

  assert.match(create, /requireSongPublicLinkReviewProposal\(\s*request\.proposalToken/su);
  assert.match(create, /resolveCommunitySongFamily\(entry\.songId\)/u);
  assert.match(
    create,
    /local\.familyRevision !== entry\.familyRevision/u
  );
  assert.match(
    create,
    /songPublicLinkReviewRevision\(currentReview\)[\s\S]*entry\.expectedReviewRevision/u
  );
  assert.match(create, /exactCommunitySongForPublicLink/u);
  assert.match(create, /expectedSyncVersion:\s*entry\.songSyncVersion/u);
  assert.match(create, /confirmSongPublicLinkReview/u);
  assert.match(
    create,
    /validThrough:\s*preflightReview\.validThrough/u,
    'the main process must persist its exact operator-local review boundary'
  );
  assert.match(create, /idempotencyKey:\s*entry\.idempotencyKey/u);
  assert.match(create, /entry\.createIntent/u);
  assert.match(create, /entry\.confirmedReviewRevision/u);
  assert.match(create, /entry\.createRequestStarted = true/u);
  assert.match(
    create,
    /const recoveringCreate = entry\.createRequestStarted === true[\s\S]*if \(recoveringCreate\)[\s\S]*songPublicLinkReviewForRetry\(\s*entry\.confirmedReview/su,
    'an ambiguous retry must reuse its held review instead of re-deriving the timezone boundary'
  );
  assert.match(
    create,
    /const createIntent = entry\.createIntent \|\| Object\.freeze\(/u,
    'an ambiguous retry must retain the exact first request intent'
  );
  assert.match(create, /ambiguousCommunitySongPublicLinkCreateError\(error\)/u);
  assert.match(create, /SONG_PUBLIC_LINK_CREATE_UNCONFIRMED/u);
  assert.match(
    create,
    /else if \(!outcomeUnconfirmed\)\s*\{\s*songPublicLinkReviewProposals\.delete\(proposalToken\)/su,
    'an ambiguous POST failure must retain the exact proposal and idempotency key'
  );
  assert.ok(
    create.indexOf('songPublicLinkReviewProposals.delete(proposalToken)')
      > create.indexOf('await client.createSongPublicLink'),
    'the proposal must be consumed only after the create request is confirmed'
  );
  assert.doesNotMatch(
    create,
    /request\.(?:songId|songSyncId|songSyncVersion|familyId|familyRevision|validThrough|reviewedAt|reviewRevision|shareUrl|url)/u,
    'the renderer provides review intent, never canonical identity, hashes, time, or URL'
  );
  assert.doesNotMatch(create, /\bqueued\s*:/u);
});

test('public-link authorization loss purges main-held authority and notifies the renderer', () => {
  const reconnect = mainSource.slice(
    mainSource.indexOf('function requireCommunityReconnectFor('),
    mainSource.indexOf('function terminalCommunityAuthorizationError(')
  );
  for (const code of [
    'AUTH_REQUIRED',
    'AUTHORIZATION_EXPIRED',
    'PERMISSION_DENIED'
  ]) {
    assert.match(reconnect, new RegExp(`'${code}'`, 'u'));
  }
  assert.match(reconnect, /songPublicLinkReviewProposals\.clear\(\)/u);
  assert.match(reconnect, /songPublicLinkActions\.clear\(\)/u);

  const refresh = mainSource.slice(
    mainSource.indexOf('async function refreshCommunityConnectionCapabilities('),
    mainSource.indexOf('function beginCommunityAuthRequest(')
  );
  assert.match(
    refresh,
    /canReadSongPublicLinks[\s\S]*songPublicLinkActions\.clear\(\)[\s\S]*await notifyCommunityStatusChanged\(\)/u
  );

  for (const [channel, next] of [
    ['community:songs:listPublicLinks', 'community:songs:beginPublicLinkReview'],
    ['community:songs:beginPublicLinkReview', 'community:songs:createPublicLink'],
    ['community:songs:createPublicLink', 'community:songs:copyPublicLink'],
    ['community:songs:revokePublicLink', 'community:songs:beginSharingReview']
  ]) {
    const block = handlerBlock(channel, next);
    assert.match(block, /requireCommunityReconnectFor\(error\)/u);
    assert.match(block, /await notifyCommunityStatusChanged\(\)/u);
  }
});

test('public-link aggregation rejects duplicate identities across pages', () => {
  const list = handlerBlock(
    'community:songs:listPublicLinks',
    'community:songs:beginPublicLinkReview'
  );
  assert.match(list, /const seenLinkIds = new Set\(\)/u);
  assert.match(list, /seenLinkIds\.has\(link\.linkId\)/u);
  assert.match(list, /seenLinkIds\.add\(link\.linkId\)/u);
  assert.match(list, /duplicate public-link identity/u);
});

test('copy and revoke consume opaque actions without renderer URLs or CAS fields', () => {
  const copy = handlerBlock(
    'community:songs:copyPublicLink',
    'community:songs:revokePublicLink'
  );
  const revoke = handlerBlock(
    'community:songs:revokePublicLink',
    'community:songs:beginSharingReview'
  );
  assert.match(copy, /requireSongPublicLinkAction\(request\.actionToken\)/u);
  assert.match(copy, /clipboard\.writeText\(entry\.link\.shareUrl\)/u);
  assert.doesNotMatch(copy, /request\.(?:shareUrl|url|linkId|linkVersion)/u);

  assert.match(revoke, /requireSongPublicLinkAction/u);
  assert.match(revoke, /linkId:\s*entry\.link\.linkId/u);
  assert.match(revoke, /expectedLinkVersion:\s*entry\.link\.linkVersion/u);
  assert.match(revoke, /idempotencyKey:\s*entry\.revokeIdempotencyKey/u);
  assert.match(revoke, /PUBLIC_LINK_REVOCATION_NOT_CONFIRMED/u);
  assert.doesNotMatch(
    revoke,
    /request\.(?:linkId|linkVersion|idempotencyKey|shareUrl|url)/u
  );
  assert.doesNotMatch(revoke, /\bqueued\s*:/u);
});

test('preload exposes only song ID, opaque tokens, and operator review intent', () => {
  const start = preloadSource.indexOf('listCommunitySongPublicLinks:');
  const end = preloadSource.indexOf('getCommunitySongConflict:', start);
  assert.ok(start >= 0 && end > start);
  const bridge = preloadSource.slice(start, end);
  for (const method of [
    'listCommunitySongPublicLinks',
    'beginCommunitySongPublicLinkReview',
    'createCommunitySongPublicLink',
    'copyCommunitySongPublicLink',
    'revokeCommunitySongPublicLink'
  ]) {
    assert.match(bridge, new RegExp(`${method}:`, 'u'));
  }
  for (const field of [
    'proposalToken',
    'label',
    'basis',
    'evidence',
    'validUntil',
    'expiresAt',
    'confirmed',
    'actionToken'
  ]) {
    assert.match(bridge, new RegExp(`${field}: request\\?\\.${field}`, 'u'));
  }
  assert.doesNotMatch(
    bridge,
    /\b(?:linkId|linkVersion|songSyncId|songSyncVersion|familyId|familyRevision|validThrough|reviewRevision|reviewedAt|shareUrl|url|accessToken)\s*:/u
  );
});
