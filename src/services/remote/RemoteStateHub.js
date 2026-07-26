'use strict';

const { EventEmitter } = require('events');
const { RemoteProtocolError } = require('./RemoteProtocol');

class RemoteStateHub extends EventEmitter {
  constructor({ heartbeatMs = 15000, maxConnections = 16, maxConnectionsPerDevice = 2 } = {}) {
    super();
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10) {
      throw new TypeError('SSE heartbeat must be at least 10ms');
    }
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 128) {
      throw new TypeError('SSE connection limit is invalid');
    }
    if (!Number.isSafeInteger(maxConnectionsPerDevice)
      || maxConnectionsPerDevice < 1
      || maxConnectionsPerDevice > 4) {
      throw new TypeError('Per-device SSE connection limit is invalid');
    }
    this.heartbeatMs = heartbeatMs;
    this.maxConnections = maxConnections;
    this.maxConnectionsPerDevice = maxConnectionsPerDevice;
    this.connections = new Map();
    this.nextConnectionId = 1;
    this.heartbeatTimer = setInterval(() => this._heartbeat(), heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  add({ response, device, nextSequence, isAuthorized, initialState }) {
    if (!response || typeof response.write !== 'function' || typeof response.end !== 'function') {
      throw new TypeError('An HTTP response is required');
    }
    if (!device || typeof device.id !== 'string') throw new TypeError('A paired device is required');
    if (typeof nextSequence !== 'function' || typeof isAuthorized !== 'function') {
      throw new TypeError('SSE authorization callbacks are required');
    }
    this.assertCanAdd(device);

    const id = this.nextConnectionId++;
    const entry = {
      id,
      response,
      device,
      nextSequence,
      isAuthorized,
      backpressured: false,
      pendingState: null,
      handleDrain: null
    };
    this.connections.set(id, entry);
    const handleClose = () => this.remove(id, { end: false });
    entry.handleClose = handleClose;
    entry.handleDrain = () => this._handleDrain(id);
    response.once('close', handleClose);
    response.once('error', handleClose);
    this._emitCount();

    if (!this._writeState(entry, initialState)) {
      this.remove(id);
      throw new RemoteProtocolError('REMOTE_STREAM_FAILED', 'The remote state stream closed', 503);
    }
    return id;
  }

  assertCanAdd(device) {
    if (!device || typeof device.id !== 'string') throw new TypeError('A paired device is required');
    if (this.connections.size >= this.maxConnections) {
      throw new RemoteProtocolError(
        'REMOTE_CONNECTION_LIMIT',
        'Too many remote devices are connected',
        503
      );
    }
    const sameDeviceConnections = [...this.connections.values()]
      .filter(entry => entry.device.id === device.id).length;
    if (sameDeviceConnections >= this.maxConnectionsPerDevice) {
      throw new RemoteProtocolError(
        'REMOTE_DEVICE_CONNECTION_LIMIT',
        'This remote device already has an active state connection',
        429
      );
    }
  }

  publish(state) {
    if (this.connections.size === 0) return;
    const serializedState = JSON.stringify(state);
    for (const entry of [...this.connections.values()]) {
      if (!this._entryAuthorized(entry) || !this._writeState(entry, state, serializedState)) {
        this.remove(entry.id);
      }
    }
  }

  remove(id, { end = true } = {}) {
    const entry = this.connections.get(id);
    if (!entry) return false;
    this.connections.delete(id);
    entry.response.removeListener?.('close', entry.handleClose);
    entry.response.removeListener?.('error', entry.handleClose);
    entry.response.removeListener?.('drain', entry.handleDrain);
    if (end && !entry.response.writableEnded) entry.response.end();
    this._emitCount();
    return true;
  }

  closeAll() {
    for (const id of [...this.connections.keys()]) this.remove(id);
  }

  destroy() {
    clearInterval(this.heartbeatTimer);
    this.closeAll();
    this.removeAllListeners();
  }

  get connectedDeviceCount() {
    return new Set([...this.connections.values()].map(entry => entry.device.id)).size;
  }

  _writeState(entry, state, serializedState = null) {
    if (entry.response.writableEnded || entry.response.destroyed) return false;
    if (entry.backpressured) {
      // Keep only the newest authoritative state while the socket buffer
      // drains. Remote commands never rely on receiving every intermediate
      // state, and this prevents a slow phone from affecting Show timing.
      entry.pendingState = { state, serializedState: serializedState ?? JSON.stringify(state) };
      return true;
    }
    let nextSequence;
    try {
      nextSequence = entry.nextSequence();
    } catch (_error) {
      return false;
    }
    const stateJson = serializedState ?? JSON.stringify(state);
    const payload = `{"state":${stateJson},"nextSequence":${JSON.stringify(nextSequence)}}`;
    const eventId = Number.isSafeInteger(state?.revision) ? `id: ${state.revision}\n` : '';
    try {
      const accepted = entry.response.write(`${eventId}event: state\ndata: ${payload}\n\n`);
      if (!accepted) {
        entry.backpressured = true;
        entry.response.once('drain', entry.handleDrain);
      }
      // response.write(false) means buffered, not failed.
      return true;
    } catch (_error) {
      return false;
    }
  }

  _handleDrain(id) {
    const entry = this.connections.get(id);
    if (!entry) return;
    entry.backpressured = false;
    const pending = entry.pendingState;
    entry.pendingState = null;
    if (pending && (!this._entryAuthorized(entry)
      || !this._writeState(entry, pending.state, pending.serializedState))) {
      this.remove(id);
    }
  }

  _entryAuthorized(entry) {
    try {
      return entry.isAuthorized() === true;
    } catch (_error) {
      return false;
    }
  }

  _heartbeat() {
    for (const entry of [...this.connections.values()]) {
      if (!this._entryAuthorized(entry)
        || entry.response.writableEnded
        || entry.response.destroyed) {
        this.remove(entry.id);
        continue;
      }
      if (entry.backpressured) continue;
      try {
        if (entry.response.write(': heartbeat\n\n') === false) {
          entry.backpressured = true;
          entry.response.once('drain', entry.handleDrain);
        }
      } catch (_error) {
        this.remove(entry.id);
      }
    }
  }

  _emitCount() {
    this.emit('count-changed', this.connectedDeviceCount);
  }
}

module.exports = { RemoteStateHub };
