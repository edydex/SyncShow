'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CommunityPlannerHandoff } = require('../src/services/community/CommunityPlannerHandoff');
const origin = 'https://church.example';
const request = (id, method = 'GET', service = 'sept20') => ({ id, method, webContentsId: 12, url: `${origin}/api/community/service-documents/${service}` });

test('Prepare hands off the selected service only after its in-flight Save completes', async () => {
  const h = new CommunityPlannerHandoff({ origin, webContentsId: 12 });
  h.begin(request(1)); h.finish({ id: 1, statusCode: 200 });
  h.begin(request(2, 'PUT'));
  let ready = false;
  const result = h.ready().then(value => { ready = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ready, false);
  h.finish({ id: 2, statusCode: 200 });
  assert.deepEqual(await result, { serviceId: 'sept20' });
  h.begin(request(3, 'GET', 'another')); h.finish({ id: 3, statusCode: 200 });
  assert.deepEqual(await h.ready(), { serviceId: 'another' });
});

test('failed and timed-out saves cannot silently launch the stale package', async () => {
  const h = new CommunityPlannerHandoff({ origin, webContentsId: 12, timeoutMs: 10 });
  h.begin(request(1, 'PUT')); h.finish({ id: 1, statusCode: 412 });
  await assert.rejects(h.ready(), /did not save/);
  h.begin(request(2, 'PUT'));
  await assert.rejects(h.ready(), /still saving/);
  h.finish({ id: 2, statusCode: 200 });
  assert.deepEqual(await h.ready(), { serviceId: 'sept20' });
});

test('unrelated pages, assets, list fetches and origins cannot change the selected service', async () => {
  const h = new CommunityPlannerHandoff({ origin, webContentsId: 12 });
  for (const changes of [{ webContentsId: 99 }, { method: 'DELETE' },
    { url: `${origin}/api/community/service-documents` },
    { url: `${origin}/api/community/service-documents/sept20/assets/image` },
    { url: 'https://other.example/api/community/service-documents/sept20' }]) h.begin({ ...request(1), ...changes });
  assert.deepEqual(await h.ready(), { serviceId: null });
});

test('cancelled and cached reads allow Load to retry, but cannot conceal a failed Save', async () => {
  const h = new CommunityPlannerHandoff({ origin, webContentsId: 12 });
  h.begin(request(1)); h.finish({ id: 1, error: 'net::ERR_ABORTED' });
  assert.deepEqual(await h.ready(), { serviceId: 'sept20' });
  h.begin(request(2)); h.finish({ id: 2, statusCode: 304 });
  assert.deepEqual(await h.ready(), { serviceId: 'sept20' });
  h.begin(request(3, 'PUT')); h.finish({ id: 3, statusCode: 412 });
  h.begin(request(4)); h.finish({ id: 4, statusCode: 200 });
  await assert.rejects(h.ready(), /did not save/);
});
