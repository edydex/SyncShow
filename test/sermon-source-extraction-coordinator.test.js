'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SermonSourceExtractionCoordinator,
  SermonSourceExtractionQueueError
} = require('../src/services/sermon/SermonSourceExtractionCoordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('source extraction coordinator shares an exact in-flight Promise', async () => {
  const gate = deferred();
  const calls = [];
  const coordinator = new SermonSourceExtractionCoordinator({
    async extractSource(buffer, metadata) {
      calls.push({ buffer, metadata });
      await gate.promise;
      return Object.freeze({ id: 'proposal' });
    }
  });
  const buffer = Buffer.from('sermon');
  const metadata = { sha256: 'a'.repeat(64) };

  const first = coordinator.extract(`sha256:${metadata.sha256}`, buffer, metadata);
  const duplicate = coordinator.extract(
    `sha256:${metadata.sha256}`,
    Buffer.from('must not replace first input'),
    { sha256: 'b'.repeat(64) }
  );
  assert.equal(duplicate, first);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].buffer, buffer);
  assert.equal(calls[0].metadata, metadata);

  gate.resolve();
  assert.equal(await first, await duplicate);

  const later = coordinator.extract(`sha256:${metadata.sha256}`, buffer, metadata);
  assert.notEqual(later, first);
  await later;
  assert.equal(calls.length, 2);
});

test('source extraction coordinator globally serializes distinct source work', async () => {
  const firstGate = deferred();
  const order = [];
  const coordinator = new SermonSourceExtractionCoordinator();
  const first = coordinator.run('source-a', async () => {
    order.push('a:start');
    await firstGate.promise;
    order.push('a:end');
  });
  const second = coordinator.run('source-b', async () => {
    order.push('b:start');
    order.push('b:end');
  });

  await Promise.resolve();
  assert.deepEqual(order, ['a:start']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('source extraction coordinator cleans failures and continues its queue', async () => {
  const failure = new Error('expected extraction failure');
  const order = [];
  const coordinator = new SermonSourceExtractionCoordinator();
  const first = coordinator.run('source-a', async () => {
    order.push('a:first');
    throw failure;
  });
  const duplicate = coordinator.run('source-a', () => {
    assert.fail('duplicate work must not run');
  });
  const queued = coordinator.run('source-b', async () => {
    order.push('b');
    return 'recovered';
  });

  assert.equal(duplicate, first);
  await assert.rejects(first, error => error === failure);
  assert.equal(await queued, 'recovered');

  const rerun = coordinator.run('source-a', async () => {
    order.push('a:second');
    return 'fresh';
  });
  assert.notEqual(rerun, first);
  assert.equal(await rerun, 'fresh');
  assert.deepEqual(order, ['a:first', 'b', 'a:second']);
});

test('source extraction coordinator rejects unbounded or invalid keys', () => {
  const coordinator = new SermonSourceExtractionCoordinator();
  assert.throws(() => coordinator.run('', () => {}), /key is invalid/);
  assert.throws(() => coordinator.run('x'.repeat(257), () => {}), /key is invalid/);
  assert.throws(() => coordinator.run('source', null), /operation must be a function/);
  assert.throws(
    () => new SermonSourceExtractionCoordinator({ maxPendingDistinct: 0 }),
    /maxPendingDistinct/
  );
  assert.throws(
    () => new SermonSourceExtractionCoordinator({ maxPendingDistinct: 65 }),
    /maxPendingDistinct/
  );
});

test('source extraction coordinator bounds distinct queued work but still shares duplicates', async () => {
  const firstGate = deferred();
  const coordinator = new SermonSourceExtractionCoordinator({
    maxPendingDistinct: 2
  });
  const first = coordinator.run('source-a', async () => {
    await firstGate.promise;
    return 'a';
  });
  const duplicate = coordinator.run('source-a', () => {
    assert.fail('an exact duplicate must share the first operation');
  });
  const second = coordinator.run('source-b', async () => 'b');

  assert.equal(duplicate, first);
  assert.throws(
    () => coordinator.run('source-c', async () => 'c'),
    error => {
      assert.ok(error instanceof SermonSourceExtractionQueueError);
      assert.equal(error.code, 'EXTRACTION_QUEUE_FULL');
      return true;
    }
  );

  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, duplicate, second]), ['a', 'a', 'b']);
  assert.equal(await coordinator.run('source-c', async () => 'c'), 'c');
});
