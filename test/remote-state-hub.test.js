'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { RemoteStateHub } = require('../src/services/remote');

class FakeResponse extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.writeResults = [...writeResults];
    this.writes = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  write(value) {
    this.writes.push(String(value));
    return this.writeResults.length > 0 ? this.writeResults.shift() : true;
  }

  end() {
    this.writableEnded = true;
  }
}

function state(revision) {
  return { protocolVersion: 1, revision, phase: 'live' };
}

function addConnection(hub, response, deviceId = 'device-1') {
  return hub.add({
    response,
    device: { id: deviceId },
    nextSequence: () => 1,
    isAuthorized: () => true,
    initialState: state(1)
  });
}

test('SSE backpressure keeps the connection and coalesces to the newest state', () => {
  const hub = new RemoteStateHub({ heartbeatMs: 60_000 });
  const response = new FakeResponse([false, true]);
  try {
    addConnection(hub, response);
    assert.equal(hub.connections.size, 1);
    assert.equal(response.writes.length, 1);

    hub.publish(state(2));
    hub.publish(state(3));
    assert.equal(response.writes.length, 1, 'states wait while the socket buffer drains');

    response.emit('drain');
    assert.equal(hub.connections.size, 1);
    assert.equal(response.writes.length, 2);
    assert.match(response.writes[1], /id: 3/);
    assert.doesNotMatch(response.writes[1], /"revision":2/);
  } finally {
    hub.destroy();
  }
});

test('one paired device cannot occupy every SSE connection', () => {
  const hub = new RemoteStateHub({
    heartbeatMs: 60_000,
    maxConnections: 8,
    maxConnectionsPerDevice: 2
  });
  try {
    addConnection(hub, new FakeResponse(), 'same-device');
    addConnection(hub, new FakeResponse(), 'same-device');
    assert.throws(
      () => addConnection(hub, new FakeResponse(), 'same-device'),
      error => error?.code === 'REMOTE_DEVICE_CONNECTION_LIMIT' && error?.status === 429
    );
    addConnection(hub, new FakeResponse(), 'another-device');
    assert.equal(hub.connectedDeviceCount, 2);
  } finally {
    hub.destroy();
  }
});
