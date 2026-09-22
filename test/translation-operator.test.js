'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { operatorRequestHeaders, audioPermission, operatorPage } = require('../src/services/translation/TranslationOperatorWindow');
const { CommunityClient } = require('../src/services/community/CommunityClient');
const origin = 'https://church.example.test';
const descriptor = { schemaVersion: 1, scopes: ['syncshow:translation:control'],
  operatorPath: '/admin/live-translation', accessPath: '/api/community/translation/access', eventsPath: '/translation/api/public/events' };

test('permanent device token is sent only to this window’s exact POST lease exchange', () => {
  const base = { url: `${origin}/api/community/translation/access`, webContentsId: 12, method: 'POST', requestHeaders: { Accept: 'application/json' } };
  assert.equal(operatorRequestHeaders(base, origin, 'private-token', 12).Authorization, 'SyncShow private-token');
  for (const changes of [{ method: 'GET' }, { webContentsId: 13 },
    { url: `${origin}/api/community/translation/access?redirect=1` },
    { url: `${origin}/api/community/translation/access/extra` },
    { url: 'https://other.example.test/api/community/translation/access' }]) {
    const actual = operatorRequestHeaders({ ...base, ...changes, requestHeaders: { Authorization: 'SyncShow private-token' } }, origin, 'private-token', 12);
    assert.equal(actual.Authorization, undefined);
  }
});

test('scoped lease survives processor requests but cannot follow an external redirect', () => {
  const base = { url: `${origin}/translation/api/sessions/current`, webContentsId: 12, method: 'GET', requestHeaders: { authorization: 'Bearer mlg1.synthetic' } };
  assert.equal(operatorRequestHeaders(base, origin, 'private-token', 12).authorization, 'Bearer mlg1.synthetic');
  for (const url of ['https://other.example.test/translation/api/sessions', `${origin}/other`]) {
    assert.equal(operatorRequestHeaders({ ...base, url }, origin, 'private-token', 12).authorization, undefined);
  }
});

test('only the owned top-level translation page can request audio; camera and frames are denied', () => {
  const owner = { isDestroyed: () => false, getURL: () => `${origin}/admin/live-translation` };
  const request = { webContents: owner, owner, permission: 'media', origin,
    details: { requestingUrl: owner.getURL(), isMainFrame: true, mediaTypes: ['audio'] } };
  assert.equal(audioPermission(request), true);
  for (const changes of [{ mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] },
    { isMainFrame: false }, { requestingUrl: `${origin}/admin/other` }, { mediaTypes: [] }]) {
    assert.equal(audioPermission({ ...request, details: { ...request.details, ...changes } }), false);
  }
  assert.equal(audioPermission({ ...request, webContents: {} }), false);
  assert.equal(operatorPage('file:///admin/live-translation', origin), false);
});

test('discovery adds explicitly advertised translation control without granting it to older servers', async () => {
  async function discover(translation) {
    const client = new CommunityClient({ baseUrl: origin, fetchImpl: async () => Response.json({
      schemaVersion: 1, id: 'church-test', name: 'Test Church', integrations: { syncShow: {
        schemaVersion: 2, deviceAuthorization: true, apiBaseUrl: `${origin}/api/community/syncshow/v1`, resources: {
          songs: { schemaVersion: 1, endpoint: 'songs', scopes: ['syncshow:songs:read'] },
          ...(translation ? { translation } : {})
        }
      } }
    }) });
    return client.discover();
  }
  assert.equal((await discover()).scopes.includes('syncshow:translation:control'), false);
  const enabled = await discover(descriptor);
  assert.equal(enabled.capabilities.translation, true);
  assert.equal(enabled.scopes.includes('syncshow:translation:control'), true);
  const archives = { schemaVersion: 1, scope: 'syncshow:translation:archives:read' };
  assert.equal(enabled.scopes.includes(archives.scope), false);
  assert.equal((await discover({ ...descriptor, archiveReview: archives })).scopes.includes(archives.scope), true);
  await assert.rejects(discover({ ...descriptor, archiveReview: { ...archives, scope: 'syncshow:songs:write' } }));
  await assert.rejects(discover({ ...descriptor, accessPath: 'https://other.example.test/access' }));
});

test('prepared-service credentials stay on exact owned Community reads and writes', () => {
  const base = { url: `${origin}/api/community/translation/plans`, method: 'GET', webContentsId: 12, requestHeaders: {} };
  for (const changes of [{}, { method: 'PUT' }, { url: `${base.url}?serviceId=service-2026:morning` }]) {
    assert.equal(operatorRequestHeaders({ ...base, ...changes }, origin, 'private-token', 12).Authorization, 'SyncShow private-token');
  }
  for (const changes of [{ method: 'POST' }, { method: 'DELETE' }, { webContentsId: 13 },
    { url: `${base.url}?redirect=1` }, { url: `${base.url}?serviceId=one&serviceId=two` },
    { url: `${base.url}?serviceId=../other` }, { url: `${base.url}/extra` },
    { method: 'PUT', url: `${base.url}?serviceId=one` },
    { url: 'https://other.example/api/community/translation/plans' }]) {
    const headers = operatorRequestHeaders({ ...base, ...changes, requestHeaders: { authorization: 'SyncShow private-token' } }, origin, 'private-token', 12);
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.authorization, undefined);
  }
});


test('cue shutdown waits for its own Stop acknowledgement and clears connection state', async () => {
  const { TranslationOperatorWindow } = require('../src/services/translation/TranslationOperatorWindow');
  const sent = []; let destroyed = false;
  const operator = new TranslationOperatorWindow({ BrowserWindow: null, stopTimeoutMs: 100 });
  const contents = { send: (_channel, command) => sent.push(command), getURL: () => `${origin}/admin/live-translation` };
  contents.mainFrame = {};
  operator.window = { webContents: contents, isDestroyed: () => destroyed, destroy: () => { destroyed = true; } };
  operator.origin = origin; operator.connectionId = 'test'; operator.ready = true;
  operator.dispatch({ serviceId: 'one', serviceRevision: 'abc', segmentId: 'first', phase: 'live' });
  assert.equal(operator.owns({ sender: contents, senderFrame: {} }), false);
  assert.equal(operator.owns({ sender: contents, senderFrame: contents.mainFrame }), true);
  const stopped = operator.shutdown();
  assert.equal(sent.at(-1).phase, 'idle');
  assert.equal(destroyed, false);
  operator.report({ phase: 'idle' });
  await stopped;
  assert.equal(destroyed, true); assert.equal(operator.command, null);
  assert.equal(operator.origin, null); assert.equal(operator.ready, false);
});

test('an unavailable processor reports a bounded readiness failure; ready cancels it', async () => {
  const { TranslationOperatorWindow } = require('../src/services/translation/TranslationOperatorWindow');
  const failures = [];
  const operator = new TranslationOperatorWindow({ BrowserWindow: null, readyTimeoutMs: 5, failed: message => failures.push(message) });
  operator.dispatch({ phase: 'prepare' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(failures.length, 1);
  operator.dispatch({ phase: 'prepare' }); operator.markReady();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(failures.length, 1); operator.close();
});
