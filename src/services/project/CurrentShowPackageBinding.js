'use strict';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHOW_PACKAGE_ID_PATTERN = /^show-[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const POISON_IDS = new Set(['__proto__', 'prototype', 'constructor']);

class CurrentShowPackageBindingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CurrentShowPackageBindingError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new CurrentShowPackageBindingError(code, message, details);
}

function safeId(value, field, code) {
  if (
    typeof value !== 'string'
    || !SAFE_ID_PATTERN.test(value)
    || POISON_IDS.has(value)
  ) {
    fail(code, `${field} is invalid.`, { field });
  }
  return value;
}

function sha256(value, field, code) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} is invalid.`, { field });
  }
  return value;
}

function projectRevision(value, field, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${field} is invalid.`, { field });
  }
  return value;
}

function sortedUniqueRoleIds(value, field, code) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    fail(code, `${field} must contain 1 to 16 roles.`, { field });
  }
  const roleIds = value.map((roleId, index) =>
    safeId(roleId, `${field}[${index}]`, code));
  if (new Set(roleIds).size !== roleIds.length) {
    fail(code, `${field} cannot repeat a role.`, { field });
  }
  return roleIds.sort();
}

function sameStringList(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Rebinds no data and opens no files. It proves that one already-validated
 * current pointer, ShowPackage, handoff, and venue still name the same exact
 * prepared service before main installs any presentation into Friendly Load.
 */
function validateCurrentShowPackageBinding({
  pointer,
  manifest,
  manifestSha256,
  serviceHandoff,
  venueProfileId,
  venueProfileRevisionId,
  enabledRoleIds,
  presentationRoleIds
} = {}) {
  const invalidCode = 'CURRENT_SHOW_PACKAGE_BINDING_INVALID';
  if (
    !pointer
    || typeof pointer !== 'object'
    || Array.isArray(pointer)
    || !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || !serviceHandoff
    || typeof serviceHandoff !== 'object'
    || Array.isArray(serviceHandoff)
  ) {
    fail(
      invalidCode,
      'Prepared-service binding requires a pointer, manifest, and service handoff.'
    );
  }

  const packageId = typeof pointer.packageId === 'string'
    && SHOW_PACKAGE_ID_PATTERN.test(pointer.packageId)
    ? pointer.packageId
    : fail(invalidCode, 'Prepared-service package id is invalid.');
  const projectId = safeId(pointer.projectId, 'pointer.projectId', invalidCode);
  const expectedManifestSha256 = sha256(
    pointer.packageManifestSha256,
    'pointer.packageManifestSha256',
    invalidCode
  );
  const openedManifestSha256 = sha256(
    manifestSha256,
    'manifestSha256',
    invalidCode
  );
  const projectRevisionId = sha256(
    pointer.projectRevisionId,
    'pointer.projectRevisionId',
    invalidCode
  );
  const revision = projectRevision(
    pointer.projectRevision,
    'pointer.projectRevision',
    invalidCode
  );
  const activationId = safeId(
    pointer.activationId,
    'pointer.activationId',
    invalidCode
  );
  const profileId = safeId(
    venueProfileId,
    'venueProfileId',
    invalidCode
  );
  const expectedProfileRevisionId = sha256(
    pointer.venueProfileRevisionId,
    'pointer.venueProfileRevisionId',
    invalidCode
  );
  const activeProfileRevisionId = sha256(
    venueProfileRevisionId,
    'venueProfileRevisionId',
    invalidCode
  );
  const activeRoleIds = sortedUniqueRoleIds(
    enabledRoleIds,
    'enabledRoleIds',
    invalidCode
  );
  const installedRoleIds = sortedUniqueRoleIds(
    presentationRoleIds,
    'presentationRoleIds',
    invalidCode
  );
  const manifestRoleIds = sortedUniqueRoleIds(
    Object.keys(manifest.roleMapping || {}),
    'manifest.roleMapping',
    invalidCode
  );
  const handoffProject = serviceHandoff.project;
  if (!handoffProject || typeof handoffProject !== 'object') {
    fail(
      'CURRENT_SHOW_PACKAGE_BINDING_CORRUPT',
      'The prepared service handoff has no project identity.'
    );
  }

  if (
    manifest.id !== packageId
    || openedManifestSha256 !== expectedManifestSha256
    || manifest.projectId !== projectId
    || manifest.projectRevisionId !== projectRevisionId
    || manifest.projectRevision !== revision
    || handoffProject.id !== projectId
    || handoffProject.revisionId !== projectRevisionId
    || handoffProject.revision !== revision
    || handoffProject.serviceDate !== pointer.serviceDate
  ) {
    fail(
      'CURRENT_SHOW_PACKAGE_BINDING_CORRUPT',
      'The prepared-service pointer no longer matches its verified package and handoff.'
    );
  }

  if (
    pointer.venueProfileId !== profileId
    || expectedProfileRevisionId !== activeProfileRevisionId
    || !sameStringList(activeRoleIds, manifestRoleIds)
    || !sameStringList(activeRoleIds, installedRoleIds)
  ) {
    fail(
      'CURRENT_SHOW_PACKAGE_PROFILE_INCOMPATIBLE',
      'The prepared service was built for a different venue profile or presentation-role set.',
      {
        pointerVenueProfileId: pointer.venueProfileId,
        activeVenueProfileId: profileId
      }
    );
  }

  return Object.freeze({
    packageId,
    packageManifestSha256: expectedManifestSha256,
    projectId,
    projectRevisionId,
    projectRevision: revision,
    serviceDate: pointer.serviceDate,
    venueProfileId: profileId,
    venueProfileRevisionId: activeProfileRevisionId,
    activationId,
    activatedAt: pointer.activatedAt,
    roleIds: Object.freeze([...activeRoleIds])
  });
}

module.exports = {
  CurrentShowPackageBindingError,
  validateCurrentShowPackageBinding
};
