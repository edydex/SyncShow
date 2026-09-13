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
