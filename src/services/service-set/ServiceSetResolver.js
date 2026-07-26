'use strict';

const crypto = require('crypto');

const { isValidIsoDate } = require('./ServiceDate');

const SUPPORTED_EXTENSIONS = Object.freeze(['.pptx', '.ppt']);
const DATE_POLICIES = Object.freeze(['service-date', 'warn-if-stale', 'none']);
const MAX_INPUT_ROLES = 64;
const MAX_MATCHERS_PER_ROLE = 32;
const MAX_RESOLVER_FILES = 5000;
const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEMPORARY_FILE_PATTERNS = Object.freeze([
  /^~\$/,
  /^\./,
  /\.(?:tmp|temp|part|partial|crdownload|download)$/i
]);

class ServiceSetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ServiceSetError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ServiceSetError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

function matcherScore(fileName, matcher) {
  if (typeof fileName !== 'string' || typeof matcher !== 'string') return 0;
  const fileText = normalizeSearchText(fileName.replace(/\.[^.]+$/, ''));
  const matcherText = normalizeSearchText(matcher);
  if (!fileText || !matcherText) return 0;

  const fileTokens = fileText.split(/\s+/);
  const matcherTokens = matcherText.split(/\s+/);
  const phraseMatch = matcherTokens.length <= fileTokens.length
    && fileTokens.some((_, start) => matcherTokens.every(
      (token, offset) => fileTokens[start + offset] === token
    ));
  // Compact matching is useful for configured phrases such as "singer screen"
  // against SingerScreen, but a one-word matcher must not match inside an
  // unrelated word (for example "stage" in "backstage").
  const compactMatch = matcherTokens.length > 1
    && fileTokens.join('').includes(matcherTokens.join(''));
  const tokenPrefixMatch = matcherTokens.length === 1
    && matcherText.length >= 3
    && fileTokens.some(token => token.startsWith(matcherText));
  if (!phraseMatch && !compactMatch && !tokenPrefixMatch) return 0;
  return matcherText.length * 10
    + (phraseMatch ? 2000 : 0)
    + (compactMatch ? 1200 : 0)
    + (tokenPrefixMatch ? 800 : 0)
    + (fileTokens.includes(matcherText) ? 250 : 0);
}

function matchFileToRoles(fileName, inputRoles) {
  const scores = inputRoles.map(role => ({
    roleId: role.id,
    score: Math.max(0, ...(role.filenameMatchers || []).map(matcher => matcherScore(fileName, matcher)))
  })).filter(match => match.score > 0);
  if (scores.length === 0) return { roleIds: [], score: 0, ambiguous: false };
  const bestScore = Math.max(...scores.map(match => match.score));
  const roleIds = scores.filter(match => match.score === bestScore).map(match => match.roleId);
  return { roleIds, score: bestScore, ambiguous: roleIds.length > 1 };
}

function isTemporaryFileName(name) {
  return TEMPORARY_FILE_PATTERNS.some(pattern => pattern.test(name));
}

function extractVersionRank(fileName) {
  const normalized = normalizeSearchText(fileName);
  const versionMatches = [...normalized.matchAll(/\b(?:v|ver|version|rev|revision)\s*(\d{1,4})\b/g)];
  const explicit = versionMatches.length > 0
    ? Math.max(...versionMatches.map(match => Number(match[1])))
    : 0;
  const copyMatch = normalized.match(/\bcopy\s*(\d{1,4})\b/);
  const finalBonus = /\bfinal\b/.test(normalized) ? 100000 : 0;
  return finalBonus + Math.max(explicit, copyMatch ? Number(copyMatch[1]) : 0);
}

function compareCandidates(first, second) {
  if (first.available !== second.available) return first.available ? -1 : 1;
  if (first.versionRank !== second.versionRank) return second.versionRank - first.versionRank;
  if (first.modifiedTimeMs !== second.modifiedTimeMs) return second.modifiedTimeMs - first.modifiedTimeMs;
  return first.name.localeCompare(second.name, 'en', { numeric: true, sensitivity: 'base' });
}

function buildSet(groupKey, candidates, inputRoles, requiredRoleIds) {
  const roleCandidates = new Map(inputRoles.map(role => [role.id, []]));
  const ambiguousFiles = [];
  for (const candidate of candidates) {
    if (candidate.ambiguousRoleMatch) {
      ambiguousFiles.push(candidate);
      continue;
    }
    const [roleId] = candidate.matchedRoleIds;
    if (roleId && roleCandidates.has(roleId)) roleCandidates.get(roleId).push(candidate);
  }

  const inputs = {};
  const alternates = {};
  const missingRoleIds = [];
  const unavailableRoleIds = [];
  for (const role of inputRoles) {
    const matches = roleCandidates.get(role.id).sort(compareCandidates);
    inputs[role.id] = matches[0] || null;
    alternates[role.id] = matches.slice(1);
    if (requiredRoleIds.has(role.id) && matches.length === 0) missingRoleIds.push(role.id);
    if (requiredRoleIds.has(role.id) && matches.length > 0 && !matches[0].available) {
      unavailableRoleIds.push(role.id);
    }
  }

  const warnings = [];
  if (missingRoleIds.length > 0) warnings.push({ code: 'MISSING_ROLES', roleIds: missingRoleIds });
  if (unavailableRoleIds.length > 0) warnings.push({ code: 'UNAVAILABLE_ROLES', roleIds: unavailableRoleIds });
  if (ambiguousFiles.length > 0) {
    warnings.push({
      code: 'AMBIGUOUS_ROLE_FILES',
      fileNames: ambiguousFiles.map(file => file.name)
    });
  }
  for (const [roleId, files] of Object.entries(alternates)) {
    if (files.length > 0) warnings.push({
      code: 'MULTIPLE_ROLE_FILES',
      roleId,
      selected: inputs[roleId].name,
      alternates: files.map(file => file.name)
    });
  }

  return {
    id: groupKey,
    serviceDate: groupKey === 'undated' ? null : groupKey,
    inputs,
    alternates,
    missingRoleIds,
    unavailableRoleIds,
    complete: missingRoleIds.length === 0 && unavailableRoleIds.length === 0,
    warnings
  };
}

function setSortKey(set) {
  return set.serviceDate || '0000-00-00';
}

function chooseRecommendedSet(sets, requestedDate) {
  const exact = sets.find(set => set.serviceDate === requestedDate);
  if (exact) return exact.id;
  const datedDescending = sets
    .filter(set => set.serviceDate)
    .sort((a, b) => setSortKey(b).localeCompare(setSortKey(a)));
  const past = datedDescending.filter(set => set.serviceDate < requestedDate);
  const future = datedDescending
    .filter(set => set.serviceDate > requestedDate)
    .reverse();
  const undated = sets.find(set => set.id === 'undated');
  const completePast = past.find(set => set.complete);
  if (completePast) return completePast.id;
  if (undated?.complete) return undated.id;
  const completeFuture = future.find(set => set.complete);
  if (completeFuture) return completeFuture.id;
  if (past[0]) return past[0].id;
  if (undated) return undated.id;
  return future[0]?.id || null;
}

function scanFingerprint(files) {
  const canonical = files
    .map(file => [file.relativePath, file.size, file.modifiedTimeMs, file.available])
    .sort((first, second) => String(first[0]).localeCompare(String(second[0])))
    .map(tuple => JSON.stringify(tuple))
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function validateInputRoles(inputRoles, requiredRoleIds) {
  if (!Array.isArray(inputRoles) || inputRoles.length > MAX_INPUT_ROLES) {
    fail('INVALID_INPUT_ROLES', `Input roles must be an array with at most ${MAX_INPUT_ROLES} entries.`);
  }
  if (!Array.isArray(requiredRoleIds)) {
    fail('INVALID_REQUIRED_ROLES', 'Required role IDs must be an array.');
  }
  const roleIds = new Set();
  const roleMap = new Map();
  for (const [index, role] of inputRoles.entries()) {
    if (!isRecord(role)
      || typeof role.id !== 'string'
      || !ROLE_ID_PATTERN.test(role.id)
      || !Array.isArray(role.filenameMatchers)
      || role.filenameMatchers.length > MAX_MATCHERS_PER_ROLE) {
      fail('INVALID_INPUT_ROLE', `Input role ${index + 1} needs a valid ID and at most ${MAX_MATCHERS_PER_ROLE} filename matchers.`);
    }
    if (roleIds.has(role.id)) fail('DUPLICATE_INPUT_ROLE', `Input role "${role.id}" appears twice.`);
    const datePolicy = role.datePolicy || 'service-date';
    if (!DATE_POLICIES.includes(datePolicy)) {
      fail('INVALID_DATE_POLICY', `Input role "${role.id}" has an unsupported date policy.`);
    }
    for (const matcher of role.filenameMatchers) {
      if (typeof matcher !== 'string'
        || matcher.length > 128
        || normalizeSearchText(matcher).length === 0) {
        fail('INVALID_FILENAME_MATCHER', `Input role "${role.id}" has an invalid filename matcher.`);
      }
    }
    roleIds.add(role.id);
    roleMap.set(role.id, { ...role, datePolicy });
  }
  const required = new Set(requiredRoleIds);
  for (const roleId of required) {
    if (typeof roleId !== 'string' || !roleIds.has(roleId)) {
      fail('UNKNOWN_REQUIRED_ROLE', `Required role "${roleId}" is not configured.`);
    }
  }
  return { required, roleMap };
}

function validateFiles(files, roleMap) {
  if (!Array.isArray(files) || files.length > MAX_RESOLVER_FILES) {
    fail('INVALID_SCAN_FILES', `Scan files must be an array with at most ${MAX_RESOLVER_FILES} entries.`);
  }
  const relativePaths = new Set();
  for (const [index, file] of files.entries()) {
    if (!isRecord(file)
      || typeof file.name !== 'string'
      || typeof file.relativePath !== 'string'
      || file.relativePath.length === 0
      || file.relativePath.includes('\0')
      || !Array.isArray(file.matchedRoleIds)
      || typeof file.available !== 'boolean') {
      fail('INVALID_SCAN_FILE', `Scanned file ${index + 1} is malformed.`);
    }
    if (relativePaths.has(file.relativePath)) {
      fail('DUPLICATE_SCAN_FILE', `Scanned path "${file.relativePath}" appears twice.`);
    }
    relativePaths.add(file.relativePath);
    if (file.serviceDate !== null
      && file.serviceDate !== undefined
      && !isValidIsoDate(file.serviceDate)) {
      fail('INVALID_FILE_DATE', `Scanned file "${file.name}" has an invalid service date.`);
    }
    for (const roleId of file.matchedRoleIds) {
      if (!roleMap.has(roleId)) {
        fail('UNKNOWN_MATCHED_ROLE', `Scanned file "${file.name}" matched unknown role "${roleId}".`);
      }
    }
    if (file.ambiguousRoleMatch === true && file.matchedRoleIds.length < 2) {
      fail('INVALID_ROLE_MATCH', `Scanned file "${file.name}" has an invalid ambiguous role match.`);
    }
    if (file.matchedRoleIds.length > 1 && file.ambiguousRoleMatch !== true) {
      fail('INVALID_ROLE_MATCH', `Scanned file "${file.name}" has multiple roles without an ambiguity marker.`);
    }
  }
}

function candidateIsDateNeutral(file, roleMap) {
  if (file.matchedRoleIds.length !== 1) return false;
  return roleMap.get(file.matchedRoleIds[0])?.datePolicy === 'none';
}

function addDateWarning(set, requestedDate) {
  if (set.serviceDate === requestedDate) {
    set.dateStatus = 'matches';
    return;
  }
  if (set.serviceDate === null) {
    const selectedInputs = Object.values(set.inputs).filter(Boolean);
    if (selectedInputs.length > 0
      && selectedInputs.every(input => input.datePolicy === 'none' || input.dateNeutral === true)) {
      set.dateStatus = 'not-applicable';
      return;
    }
    set.dateStatus = 'unknown';
    set.warnings.push({ code: 'SERVICE_DATE_UNKNOWN', requestedDate });
    return;
  }
  set.dateStatus = 'different';
  set.warnings.push({
    code: 'SERVICE_DATE_MISMATCH',
    requestedDate,
    selectedDate: set.serviceDate
  });
}

function resolveServiceSets({ files, inputRoles, requiredRoleIds = [], requestedDate }) {
  if (!isValidIsoDate(requestedDate)) {
    fail('INVALID_SERVICE_DATE', 'A service date in YYYY-MM-DD form is required.');
  }
  const { required, roleMap } = validateInputRoles(inputRoles, requiredRoleIds);
  validateFiles(files, roleMap);

  const groups = new Map();
  const dateNeutralFiles = [];
  for (const file of files) {
    if (candidateIsDateNeutral(file, roleMap)) {
      dateNeutralFiles.push(file);
      continue;
    }
    const key = file.serviceDate || 'undated';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  if (groups.size === 0 && dateNeutralFiles.length > 0) groups.set('undated', []);
  const sets = [...groups.entries()]
    .map(([key, candidates]) => buildSet(
      key,
      [...candidates, ...dateNeutralFiles],
      inputRoles,
      required
    ))
    .sort((a, b) => setSortKey(b).localeCompare(setSortKey(a)));
  for (const set of sets) addDateWarning(set, requestedDate);
  const recommendedSetId = chooseRecommendedSet(sets, requestedDate);
  return {
    requestedDate,
    sets,
    recommendedSetId,
    scanFingerprint: scanFingerprint(files)
  };
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  DATE_POLICIES,
  MAX_INPUT_ROLES,
  MAX_MATCHERS_PER_ROLE,
  MAX_RESOLVER_FILES,
  ServiceSetError,
  compareCandidates,
  extractVersionRank,
  isTemporaryFileName,
  matchFileToRoles,
  matcherScore,
  resolveServiceSets,
  scanFingerprint,
  validateInputRoles
};
