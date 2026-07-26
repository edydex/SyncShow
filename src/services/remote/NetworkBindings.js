'use strict';

const crypto = require('crypto');
const os = require('os');

function parseIpv4(address) {
  if (typeof address !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return null;
  const octets = address.split('.').map(Number);
  if (octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets;
}

function isPrivateIpv4(address) {
  const octets = parseIpv4(address);
  if (!octets) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function normalizePeerAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return 'unknown';
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped && parseIpv4(mapped[1])) return mapped[1];
  return address.toLowerCase();
}

function safeInterfaceLabel(value) {
  return String(value || 'Network')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .slice(0, 80) || 'Network';
}

class NetworkBindingCatalog {
  constructor({
    networkInterfaces = os.networkInterfaces,
    secret = crypto.randomBytes(32)
  } = {}) {
    if (typeof networkInterfaces !== 'function') {
      throw new TypeError('networkInterfaces must be a function');
    }
    if (!Buffer.isBuffer(secret) || secret.length < 16) {
      throw new TypeError('Binding ID secret must contain at least 16 bytes');
    }
    this.networkInterfaces = networkInterfaces;
    this.secret = Buffer.from(secret);
    this.bindings = new Map();
  }

  list() {
    const candidates = [{
      key: 'loopback\u0000127.0.0.1',
      interfaceName: 'Loopback',
      address: '127.0.0.1',
      kind: 'loopback'
    }];
    const interfaces = this.networkInterfaces() || {};

    for (const [interfaceName, records] of Object.entries(interfaces)) {
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        const family = record?.family;
        if (family !== 'IPv4' && family !== 4) continue;
        if (record.internal === true || !isPrivateIpv4(record.address)) continue;
        candidates.push({
          key: `${interfaceName}\u0000${record.address}`,
          interfaceName: safeInterfaceLabel(interfaceName),
          address: record.address,
          kind: 'lan'
        });
      }
    }

    const seenAddresses = new Set();
    const nextBindings = new Map();
    for (const candidate of candidates) {
      if (seenAddresses.has(candidate.address)) continue;
      seenAddresses.add(candidate.address);
      const id = this._idFor(candidate.key);
      nextBindings.set(id, Object.freeze({
        id,
        interfaceName: candidate.interfaceName,
        label: candidate.kind === 'loopback'
          ? 'This computer only'
          : `${candidate.interfaceName} — ${candidate.address}`,
        address: candidate.address,
        kind: candidate.kind
      }));
    }
    this.bindings = nextBindings;
    return [...nextBindings.values()].map(binding => ({ ...binding }));
  }

  resolve(id, { kind = null } = {}) {
    if (typeof id !== 'string' || id.length === 0) return null;
    this.list();
    const binding = this.bindings.get(id);
    if (!binding || (kind && binding.kind !== kind)) return null;
    return { ...binding };
  }

  loopback() {
    const binding = this.list().find(candidate => candidate.kind === 'loopback');
    return binding || null;
  }

  _idFor(key) {
    const digest = crypto.createHmac('sha256', this.secret).update(key, 'utf8').digest('base64url');
    return `binding_${digest.slice(0, 22)}`;
  }
}

module.exports = {
  NetworkBindingCatalog,
  isPrivateIpv4,
  normalizePeerAddress,
  parseIpv4
};
