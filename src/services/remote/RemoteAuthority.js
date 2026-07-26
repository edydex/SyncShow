'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const { CommandSequencer } = require('./CommandSequencer');
const {
  COOKIE_NAME,
  PAIR_CODE_PATTERN,
  PAIR_TICKET_PATTERN,
  RemoteProtocolError
} = require('./RemoteProtocol');

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function timingSafeEqual(left, right) {
  return Buffer.isBuffer(left)
    && Buffer.isBuffer(right)
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function pairingOrigin(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (_error) {
    throw new TypeError('Pairing base URL must be a valid URL');
  }
  if (parsed.protocol !== 'http:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new TypeError('Pairing base URL must be a plain HTTP origin');
  }
  return parsed.origin;
}

function parseRemoteCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0 || cookieHeader.length > 4096) {
    return null;
  }
  const values = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }
  if (values.length !== 1) return null;
  const match = values[0].match(/^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  return { deviceId: match[1], secret: match[2] };
}

class RemoteAuthority extends EventEmitter {
  constructor({
    now = Date.now,
    randomBytes = crypto.randomBytes,
    randomInt = crypto.randomInt,
    pairingTtlMs = 90 * 1000,
    deviceTtlMs = 12 * 60 * 60 * 1000,
    maxDevices = 16,
    replayLimit = 64
  } = {}) {
    super();
    if (typeof now !== 'function' || typeof randomBytes !== 'function' || typeof randomInt !== 'function') {
      throw new TypeError('Remote authority requires clock and randomness functions');
    }
    if (!Number.isSafeInteger(pairingTtlMs) || pairingTtlMs < 1000 || pairingTtlMs > 10 * 60 * 1000) {
      throw new TypeError('Pairing lifetime must be between one second and ten minutes');
    }
    if (!Number.isSafeInteger(deviceTtlMs) || deviceTtlMs < 60 * 1000) {
      throw new TypeError('Device lifetime must be at least one minute');
    }
    if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 128) {
      throw new TypeError('Device limit must be between 1 and 128');
    }
    this.now = now;
    this.randomBytes = randomBytes;
    this.randomInt = randomInt;
    this.pairingTtlMs = pairingTtlMs;
    this.deviceTtlMs = deviceTtlMs;
    this.maxDevices = maxDevices;
    this.replayLimit = replayLimit;
    this.devices = new Map();
    this.pairingGrant = null;
    this._rotateEpoch();
  }

  openPairing({ baseUrl, ttlMs = this.pairingTtlMs } = {}) {
    const origin = pairingOrigin(baseUrl);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > this.pairingTtlMs) {
      throw new TypeError('Pairing lifetime is invalid');
    }
    const ticket = this.randomBytes(32).toString('base64url');
    const code = String(this.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = this.now() + ttlMs;
    this.pairingGrant = {
      ticketDigest: this._digest('pair-ticket', ticket),
      codeDigest: this._digest('pair-code', code),
      expiresAt
    };
    return Object.freeze({
      pairingUrl: `${origin}/#pair=${ticket}`,
      ticket,
      code,
      expiresAt
    });
  }

  closePairing() {
    const existed = this.pairingGrant !== null;
    this.pairingGrant = null;
    return existed;
  }

  redeem({ ticket, code, deviceName } = {}) {
    const grant = this.pairingGrant;
    if (!grant) {
      throw new RemoteProtocolError('PAIRING_CLOSED', 'Open pairing on the SyncShow computer first', 423);
    }
    if (this.now() >= grant.expiresAt) {
      this.pairingGrant = null;
      throw new RemoteProtocolError('PAIRING_EXPIRED', 'That pairing code expired', 410);
    }

    const hasTicket = typeof ticket === 'string';
    const hasCode = typeof code === 'string';
    if (hasTicket === hasCode
      || (hasTicket && !PAIR_TICKET_PATTERN.test(ticket))
      || (hasCode && !PAIR_CODE_PATTERN.test(code))) {
      throw new RemoteProtocolError('PAIRING_DENIED', 'The pairing credential is not valid', 401);
    }
    const candidateDigest = hasTicket
      ? this._digest('pair-ticket', ticket)
      : this._digest('pair-code', code);
    const expectedDigest = hasTicket ? grant.ticketDigest : grant.codeDigest;
    if (!timingSafeEqual(candidateDigest, expectedDigest)) {
      throw new RemoteProtocolError('PAIRING_DENIED', 'The pairing credential is not valid', 401);
    }

    this._pruneExpiredDevices();
    if (this.devices.size >= this.maxDevices) {
      throw new RemoteProtocolError(
        'DEVICE_LIMIT_REACHED',
        'Revoke an old remote device before pairing another one',
        409
      );
    }

    // Both the QR ticket and manual code are one-time views of the same grant.
    this.pairingGrant = null;
    const id = this._uniqueDeviceId();
    const secret = this.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const record = {
      id,
      name: String(deviceName || 'Remote').slice(0, 48),
      tokenDigest: this._digest(`device:${id}`, secret),
      epochId: this.epochId,
      createdAt,
      expiresAt: createdAt + this.deviceTtlMs,
      lastSeenAt: createdAt,
      sequencer: new CommandSequencer({ replayLimit: this.replayLimit })
    };
    this.devices.set(id, record);
    const device = this._publicDevice(record);
    this.emit('device-paired', device);
    return {
      cookieValue: `${id}.${secret}`,
      maxAgeSeconds: Math.max(1, Math.floor(this.deviceTtlMs / 1000)),
      device,
      nextSequence: record.sequencer.nextSequence
    };
  }

  authenticate(cookieHeader) {
    const credential = parseRemoteCookie(cookieHeader);
    if (!credential
      || !DEVICE_ID_PATTERN.test(credential.deviceId)
      || !DEVICE_SECRET_PATTERN.test(credential.secret)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Pair this device with SyncShow first', 401);
    }
    const record = this.devices.get(credential.deviceId);
    if (!record || record.epochId !== this.epochId) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'This remote device is no longer paired', 401);
    }
    if (this.now() >= record.expiresAt) {
      this.devices.delete(record.id);
      this.emit('device-expired', this._publicDevice(record));
      throw new RemoteProtocolError('AUTH_EXPIRED', 'This remote pairing expired', 401);
    }
    const candidate = this._digest(`device:${record.id}`, credential.secret);
    if (!timingSafeEqual(candidate, record.tokenDigest)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'This remote device is no longer paired', 401);
    }
    record.lastSeenAt = this.now();
    return Object.freeze({
      id: record.id,
      name: record.name,
      epochId: record.epochId
    });
  }

  isCurrentDevice(device) {
    if (!device || device.epochId !== this.epochId) return false;
    const record = this.devices.get(device.id);
    return Boolean(record && record.epochId === device.epochId && this.now() < record.expiresAt);
  }

  getSequencer(device) {
    if (!this.isCurrentDevice(device)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'This remote device is no longer paired', 401);
    }
    return this.devices.get(device.id).sequencer;
  }

  nextSequence(device) {
    return this.getSequencer(device).nextSequence;
  }

  revokeDevice(deviceId) {
    const record = this.devices.get(deviceId);
    if (!record) return false;
    this.devices.delete(deviceId);
    this.emit('device-revoked', this._publicDevice(record));
    return true;
  }

  revokeAll(reason = 'revoked-all') {
    const count = this.devices.size;
    this.devices.clear();
    this.pairingGrant = null;
    this._rotateEpoch();
    this.emit('revoked-all', { reason, count, epochId: this.epochId });
    return count;
  }

  listDevices() {
    this._pruneExpiredDevices();
    return [...this.devices.values()].map(record => this._publicDevice(record));
  }

  _publicDevice(record) {
    return Object.freeze({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastSeenAt: record.lastSeenAt
    });
  }

  _pruneExpiredDevices() {
    const now = this.now();
    for (const [id, record] of this.devices) {
      if (now >= record.expiresAt) this.devices.delete(id);
    }
  }

  _uniqueDeviceId() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.randomBytes(12).toString('base64url');
      if (!this.devices.has(id)) return id;
    }
    throw new Error('Unable to allocate a remote device ID');
  }

  _digest(scope, value) {
    return crypto
      .createHmac('sha256', this.epochSecret)
      .update(scope, 'utf8')
      .update('\u0000', 'utf8')
      .update(value, 'utf8')
      .digest();
  }

  _rotateEpoch() {
    this.epochSecret = this.randomBytes(32);
    this.epochId = this.randomBytes(12).toString('base64url');
  }
}

module.exports = {
  DEVICE_ID_PATTERN,
  DEVICE_SECRET_PATTERN,
  RemoteAuthority,
  parseRemoteCookie,
  timingSafeEqual
};
