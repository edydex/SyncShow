'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ERROR_LENGTH = 1000;
const MAX_LABEL_LENGTH = 200;
const MAX_FONT_BYTES = 16 * 1024 * 1024;

function boundedText(value, maximum = MAX_LABEL_LENGTH) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum)
    : '';
}

function redactedText(value, maximum) {
  return boundedText(value, maximum)
    .replace(/\bfile:\/\/\/?[^\s"'<>]+/giu, '[path]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/gu, '[path]')
    .replace(/\\\\[^\s"'<>]+/gu, '[path]')
    .replace(/(^|[\s("'=])\/(?!\/)[^\s"'<>]+/gu, '$1[path]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/\b(bearer|password|token)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]');
}

function safeError(error) {
  if (!error) return null;
  return {
    name: redactedText(error.name || 'Error', 80),
    message: redactedText(error.message || String(error), MAX_ERROR_LENGTH),
    ...(typeof error.code === 'string'
      ? { code: redactedText(error.code, 100) }
      : {})
  };
}

function safeFileName(value) {
  if (typeof value !== 'string' || value.length < 1) return 'unknown';
  return boundedText(path.basename(value.replace(/\\/g, '/')), 255) || 'unknown';
}

function sanitizeRendererFontDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = ['loading', 'loaded'].includes(value.fontSetStatus)
    ? value.fontSetStatus
    : 'unknown';
  const faces = Array.isArray(value.faces)
    ? value.faces.slice(0, 8).map(face => ({
        fileName: safeFileName(face?.fileName),
        weight: boundedText(face?.weight, 30),
        style: ['normal', 'italic'].includes(face?.style) ? face.style : 'unknown',
        status: ['pending', 'loaded', 'failed'].includes(face?.status)
          ? face.status
          : 'unknown',
        ...(face?.error ? { error: safeError(face.error) } : {})
      }))
    : [];
  return {
    family: value.family === 'SyncShow Presentation'
      ? value.family
      : 'unknown',
    documentProtocol: value.documentProtocol === 'file:' ? 'file:' : 'unknown',
    fontSetStatus: status,
    cssCheck: value.cssCheck === true,
    available: value.available === true,
    faces,
    ...(value.error ? { error: safeError(value.error) } : {})
  };
}

async function inspectFontFaces(font, source) {
  const faces = Array.isArray(font?.faces) ? font.faces.slice(0, 8) : [];
  return {
    family: boundedText(font?.family, 100) || 'unknown',
    source: source === 'system' ? 'system' : 'bundled',
    faces: await Promise.all(faces.map(async face => {
      const summary = {
        fileName: safeFileName(face?.path),
        weight: boundedText(face?.weight, 30),
        style: ['normal', 'italic'].includes(face?.style) ? face.style : 'unknown',
        readable: false
      };
      try {
        const stat = await fs.stat(face.path);
        summary.file = stat.isFile();
        summary.size = stat.size;
        if (!stat.isFile()) return summary;
        if (stat.size > MAX_FONT_BYTES) {
          summary.error = { name: 'Error', message: 'Font file exceeds the diagnostic read limit' };
          return summary;
        }
        const bytes = await fs.readFile(face.path);
        summary.readable = true;
        summary.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        summary.error = safeError(error);
      }
      return summary;
    }))
  };
}

function sanitizeGpuInfo(value) {
  const devices = Array.isArray(value?.gpuDevice) ? value.gpuDevice.slice(0, 8) : [];
  return {
    devices: devices.map(device => ({
      active: device?.active === true,
      vendorId: Number.isFinite(device?.vendorId) ? device.vendorId : null,
      deviceId: Number.isFinite(device?.deviceId) ? device.deviceId : null,
      vendorString: boundedText(device?.vendorString, 160),
      deviceString: boundedText(device?.deviceString, 160),
      driverVendor: boundedText(device?.driverVendor, 160),
      driverVersion: boundedText(device?.driverVersion, 160)
    }))
  };
}

function diagnosticFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `SyncShow-diagnostics-${stamp}.json`;
}

module.exports = {
  diagnosticFileName,
  inspectFontFaces,
  safeError,
  sanitizeGpuInfo,
  sanitizeRendererFontDiagnostics
};
