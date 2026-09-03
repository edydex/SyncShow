(function exposeWeeklyReadinessActions(root, factory) {
  'use strict';

  const contract = factory();
  if (typeof module === 'object' && module.exports) module.exports = contract;
  if (root) root.SyncShowWeeklyReadinessActions = contract;
}(typeof globalThis === 'object' ? globalThis : this, function createContract() {
  'use strict';

  const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const REVISION_ID_PATTERN = /^[a-f0-9]{64}$/u;
  const RESOURCE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
  const COMPILATION_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
  // This is the same human-text boundary as ServiceProjectReadiness. Interior
  // tabs and line breaks are allowed in a reviewed waiver reason; other C0
  // controls and DEL are not.
  const UNSAFE_TEXT_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  const MAX_PROJECT_ITEMS = 5000;
  const MAX_PROJECT_CHANNELS = 32;
  const EXACT_SERMON_OWNER_CONFLICT_MESSAGE =
    'Each exact sermon revision must have one unambiguous sermon material set.';

  const CHECK_SPECS = Object.freeze([
    Object.freeze({
      checkId: 'compilable-nonempty',
      label: 'Compilable service',
      waivable: false,
      actionLabel: 'Add projected content',
      targetKind: 'add-content',
      detail: 'Add at least one projected song, text, picture, Bible passage, or sermon cue.'
    }),
    Object.freeze({
      checkId: 'song-present',
      label: 'Communal singing',
      waivable: true,
      actionLabel: 'Open Song Library',
      targetKind: 'song-library',
      detail: 'Choose a saved song and add it to this service.'
    }),
    Object.freeze({
      checkId: 'exact-sermon-link',
      label: 'Exact sermon packet',
      waivable: true,
      actionLabel: 'Set up this week\u2019s sermon',
      targetKind: 'weekly-sermon',
      detail: 'Create or open the sermon section, then link one exact reviewed sermon packet.'
    }),
    Object.freeze({
      checkId: 'linked-sermon-material',
      label: 'Projected sermon material',
      waivable: true,
      actionLabel: 'Open sermon material',
      targetKind: 'sermon-material',
      detail: 'Add reviewed sermon material and build at least one projected native sermon cue.'
    }),
    Object.freeze({
      checkId: 'sermon-reading-before-material',
      label: 'Reading before the sermon',
      waivable: true,
      actionLabel: 'Add reading before sermon',
      targetKind: 'sermon-reading',
      detail: 'Use the linked sermon\u2019s reviewed primary passage before its projected material.'
    }),
    Object.freeze({
      checkId: 'channel-visible-content',
      label: 'Every output has content',
      waivable: true,
      actionLabel: 'Review output treatments',
      targetKind: 'output-treatments',
      detail: 'Make at least one projected cue visible on every configured output.'
    })
  ]);

  const WEEKLY_READINESS_CHECK_IDS = Object.freeze(
    CHECK_SPECS.map(spec => spec.checkId)
  );
  const WEEKLY_READINESS_TARGET_KINDS = Object.freeze(
    CHECK_SPECS.map(spec => spec.targetKind)
  );
  const CHECK_STATUSES = new Set(['pass', 'waived', 'blocker']);

  function fail(message) {
    throw new TypeError(message);
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function canonicalProjectId(value, field) {
    if (
      typeof value !== 'string'
      || !PROJECT_ID_PATTERN.test(value)
      || value === '__proto__'
      || value === 'prototype'
      || value === 'constructor'
      || Object.prototype.hasOwnProperty.call(Object.prototype, value)
    ) {
      fail(`${field} must be a canonical project ID.`);
    }
    return value;
  }

  function canonicalRevisionId(value, field) {
    if (typeof value !== 'string' || !REVISION_ID_PATTERN.test(value)) {
      fail(`${field} must be a lowercase SHA-256 revision ID.`);
    }
    return value;
  }

  function canonicalResourceId(value, field) {
    if (typeof value !== 'string' || !RESOURCE_ID_PATTERN.test(value)) {
      fail(`${field} must be a canonical SHA-256 resource ID.`);
    }
    return value;
  }

  function canonicalProjectRevision(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${field} must be a non-negative safe integer.`);
    }
    return value;
  }

  function boundedSafeText(value, field, maximum) {
    if (
      typeof value !== 'string'
      || value.length < 1
      || value.length > maximum
      || value !== value.trim()
      || value !== value.normalize('NFC')
      || UNSAFE_TEXT_PATTERN.test(value)
    ) {
      fail(`${field} must be normalized safe text of ${maximum} characters or fewer.`);
    }
    return value;
  }

  function exactKeys(value, expected, field) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (
      actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])
    ) {
      fail(`${field} has an invalid evidence contract.`);
    }
  }

  function evidenceCount(value, field, maximum = MAX_PROJECT_ITEMS) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      fail(`${field} must be a bounded non-negative integer.`);
    }
    return value;
  }

  function uniqueList(value, field, maximum, normalize) {
    if (!Array.isArray(value) || value.length > maximum) {
      fail(`${field} must be a bounded list.`);
    }
    const normalized = value.map((entry, index) =>
      normalize(entry, `${field}[${index}]`));
    if (new Set(normalized).size !== normalized.length) {
      fail(`${field} must not contain duplicates.`);
    }
    return normalized;
  }

  function projectIdList(value, field, maximum = MAX_PROJECT_ITEMS) {
    return uniqueList(value, field, maximum, canonicalProjectId);
  }

  function revisionIdList(value, field, maximum = MAX_PROJECT_ITEMS) {
    return uniqueList(value, field, maximum, canonicalRevisionId);
  }

  function resourceIdList(value, field, maximum = MAX_PROJECT_ITEMS) {
    return uniqueList(value, field, maximum, canonicalResourceId);
  }

  function validateCompilationEvidence(evidence) {
    exactKeys(evidence, ['cueCount', 'compilationCode'], 'Compilation evidence');
    const cueCount = evidenceCount(
      evidence.cueCount,
      'Compilation evidence cue count'
    );
    const compilationCode = evidence.compilationCode;
    if (
      compilationCode !== null
      && (
        typeof compilationCode !== 'string'
        || !COMPILATION_CODE_PATTERN.test(compilationCode)
      )
    ) {
      fail('Compilation evidence has an invalid failure code.');
    }
    const passed = cueCount > 0 && compilationCode === null;
    if (!passed && (cueCount !== 0 || compilationCode === null)) {
      fail('Compilation evidence is internally inconsistent.');
    }
    return { passed, cueCount, exactSermonOwnerConflict: false };
  }

  function validateCountedItemEvidence(evidence, field) {
    exactKeys(evidence, ['count', 'itemIds'], field);
    const count = evidenceCount(evidence.count, `${field} count`);
    const itemIds = projectIdList(evidence.itemIds, `${field} item IDs`);
    if (count !== itemIds.length) {
      fail(`${field} count does not match its item IDs.`);
    }
    return {
      passed: count > 0,
      exactSermonOwnerConflict: false
    };
  }

  function validateExactSermonEvidence(evidence) {
    exactKeys(
      evidence,
      ['count', 'sermonRevisionIds', 'ambiguousOwnerSets'],
      'Exact-sermon evidence'
    );
    const count = evidenceCount(evidence.count, 'Exact-sermon evidence count');
    const sermonRevisionIds = revisionIdList(
      evidence.sermonRevisionIds,
      'Exact-sermon revision IDs'
    );
    if (count !== sermonRevisionIds.length) {
      fail('Exact-sermon evidence count does not match its revision IDs.');
    }
    if (
      !Array.isArray(evidence.ambiguousOwnerSets)
      || evidence.ambiguousOwnerSets.length > MAX_PROJECT_ITEMS
    ) {
      fail('Exact-sermon ambiguous-owner evidence must be a bounded list.');
    }
    const ambiguousResourceIds = new Set();
    for (const [index, ownerSet] of evidence.ambiguousOwnerSets.entries()) {
      if (!isRecord(ownerSet)) {
        fail(`Exact-sermon ambiguous owner set ${index + 1} must be an object.`);
      }
      exactKeys(
        ownerSet,
        ['resourceId', 'itemIds'],
        `Exact-sermon ambiguous owner set ${index + 1}`
      );
      const resourceId = canonicalResourceId(
        ownerSet.resourceId,
        `Exact-sermon ambiguous owner set ${index + 1} resource`
      );
      const itemIds = projectIdList(
        ownerSet.itemIds,
        `Exact-sermon ambiguous owner set ${index + 1} item IDs`
      );
      if (itemIds.length < 2) {
        fail('Exact-sermon ambiguous owner evidence needs at least two material sets.');
      }
      if (ambiguousResourceIds.has(resourceId)) {
        fail('Exact-sermon ambiguous owner evidence repeats a resource.');
      }
      ambiguousResourceIds.add(resourceId);
      if (!sermonRevisionIds.includes(resourceId.slice('sha256:'.length))) {
        fail('Exact-sermon ambiguous owner evidence names an unknown revision.');
      }
    }
    const exactSermonOwnerConflict = ambiguousResourceIds.size > 0;
    return {
      passed: count > 0 && !exactSermonOwnerConflict,
      exactSermonOwnerConflict
    };
  }

  function validateReadingEvidence(evidence) {
    exactKeys(
      evidence,
      [
        'count',
        'itemIds',
        'requiredSermonResourceIds',
        'missingSermonResourceIds'
      ],
      'Sermon-reading evidence'
    );
    const count = evidenceCount(evidence.count, 'Sermon-reading evidence count');
    const itemIds = projectIdList(
      evidence.itemIds,
      'Sermon-reading evidence item IDs'
    );
    const required = resourceIdList(
      evidence.requiredSermonResourceIds,
      'Required sermon resource IDs'
    );
    const missing = resourceIdList(
      evidence.missingSermonResourceIds,
      'Missing sermon resource IDs'
    );
    if (count !== itemIds.length) {
      fail('Sermon-reading evidence count does not match its item IDs.');
    }
    if (missing.some(resourceId => !required.includes(resourceId))) {
      fail('Missing sermon resource IDs must be a subset of required sermons.');
    }
    return {
      passed: required.length > 0 && missing.length === 0,
      exactSermonOwnerConflict: false
    };
  }

  function validateChannelEvidence(evidence) {
    exactKeys(
      evidence,
      ['coveredChannelIds', 'missingChannelIds'],
      'Output-coverage evidence'
    );
    const covered = projectIdList(
      evidence.coveredChannelIds,
      'Covered output IDs',
      MAX_PROJECT_CHANNELS
    );
    const missing = projectIdList(
      evidence.missingChannelIds,
      'Missing output IDs',
      MAX_PROJECT_CHANNELS
    );
    if (covered.some(channelId => missing.includes(channelId))) {
      fail('Covered and missing output IDs must be disjoint.');
    }
    if (covered.length + missing.length < 1) {
      fail('Output-coverage evidence must describe at least one output.');
    }
    return {
      passed: missing.length === 0,
      exactSermonOwnerConflict: false
    };
  }

  function validateEvidence(rawCheck, spec) {
    if (rawCheck.evidence === undefined) return null;
    if (!isRecord(rawCheck.evidence)) {
      fail(`Readiness check ${spec.checkId} evidence must be an object.`);
    }
    switch (spec.checkId) {
      case 'compilable-nonempty':
        return validateCompilationEvidence(rawCheck.evidence);
      case 'song-present':
        return validateCountedItemEvidence(rawCheck.evidence, 'Song evidence');
      case 'exact-sermon-link':
        return validateExactSermonEvidence(rawCheck.evidence);
      case 'linked-sermon-material':
        return validateCountedItemEvidence(
          rawCheck.evidence,
          'Sermon-material evidence'
        );
      case 'sermon-reading-before-material':
        return validateReadingEvidence(rawCheck.evidence);
      case 'channel-visible-content':
        return validateChannelEvidence(rawCheck.evidence);
      default:
        fail(`Readiness check ${spec.checkId} is unsupported.`);
    }
  }

  function validateCheck(rawCheck, spec, index) {
    if (!isRecord(rawCheck)) {
      fail(`Readiness check ${index + 1} must be an object.`);
    }
    if (rawCheck.id !== spec.checkId) {
      fail('Readiness checks must use each canonical ID exactly once and in canonical order.');
    }
    if (rawCheck.label !== spec.label) {
      fail(`Readiness check ${spec.checkId} has an invalid label.`);
    }
    if (!CHECK_STATUSES.has(rawCheck.status)) {
      fail(`Readiness check ${spec.checkId} has an invalid status.`);
    }
    boundedSafeText(rawCheck.label, `${spec.checkId} label`, 80);
    boundedSafeText(rawCheck.message, `${spec.checkId} message`, 1000);

    const evidence = validateEvidence(rawCheck, spec);
    const exactSermonOwnerConflict = Boolean(
      spec.checkId === 'exact-sermon-link'
      && rawCheck.waivable === false
      && rawCheck.status === 'blocker'
      && evidence?.exactSermonOwnerConflict === true
      && rawCheck.message === EXACT_SERMON_OWNER_CONFLICT_MESSAGE
    );
    if (
      rawCheck.waivable !== spec.waivable
      && !exactSermonOwnerConflict
    ) {
      fail(`Readiness check ${spec.checkId} has an invalid waiver contract.`);
    }
    if (
      evidence?.exactSermonOwnerConflict === true
      && !exactSermonOwnerConflict
    ) {
      fail('Ambiguous exact-sermon ownership must remain a non-waivable blocker.');
    }
    if (evidence && (rawCheck.status === 'pass') !== evidence.passed) {
      fail(`Readiness check ${spec.checkId} status contradicts its evidence.`);
    }

    if (rawCheck.status === 'waived') {
      if (!rawCheck.waivable) {
        fail(`Readiness check ${spec.checkId} cannot be waived.`);
      }
      boundedSafeText(
        rawCheck.waiverReason,
        `${spec.checkId} waiver reason`,
        500
      );
    } else if (rawCheck.waiverReason !== undefined) {
      fail(`Readiness check ${spec.checkId} has an unexpected waiver reason.`);
    }

    return Object.freeze({
      check: rawCheck,
      exactSermonOwnerConflict,
      evidence
    });
  }

  function statusSummaryIds(value, field) {
    if (!Array.isArray(value) || value.length > CHECK_SPECS.length) {
      fail(`${field} must be a bounded list.`);
    }
    return value.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.id !== 'string') {
        fail(`${field}[${index}] must identify a readiness check.`);
      }
      return entry.id;
    });
  }

  function sameList(left, right) {
    return left.length === right.length
      && left.every((value, index) => value === right[index]);
  }

  function validateReportSummary(report, validatedChecks) {
    const blockerIds = validatedChecks
      .filter(entry => entry.check.status === 'blocker')
      .map(entry => entry.check.id);
    const waivedIds = validatedChecks
      .filter(entry => entry.check.status === 'waived')
      .map(entry => entry.check.id);
    if (typeof report.ready !== 'boolean'
      || report.ready !== (blockerIds.length === 0)) {
      fail('The readiness report ready state does not match its checks.');
    }
    const reportedBlockers = statusSummaryIds(
      report.blockers,
      'Readiness blockers'
    );
    const reportedWaivers = statusSummaryIds(
      report.waivedChecks,
      'Readiness waived checks'
    );
    if (!sameList(blockerIds, reportedBlockers)
      || !sameList(waivedIds, reportedWaivers)) {
      fail('The readiness report summaries do not match its checks.');
    }
  }

  function normalizedContext(value) {
    if (!isRecord(value)) {
      fail('Current project context must be an object.');
    }
    return Object.freeze({
      projectId: canonicalProjectId(value.projectId, 'Current project'),
      projectRevision: canonicalProjectRevision(
        value.projectRevision,
        'Current project revision'
      ),
      revisionId: canonicalRevisionId(
        value.revisionId,
        'Current project revision ID'
      )
    });
  }

  function actionDescriptor(spec, validatedCheck, context) {
    const conflict = validatedCheck.exactSermonOwnerConflict;
    return Object.freeze({
      checkId: spec.checkId,
      label: spec.label,
      actionLabel: conflict ? 'Review sermon sections' : spec.actionLabel,
      targetKind: spec.targetKind,
      projectId: context.projectId,
      projectRevision: context.projectRevision,
      revisionId: context.revisionId,
      detail: conflict
        ? 'This exact sermon revision appears in more than one sermon material set. Review the sermon sections and keep one unambiguous owner.'
        : spec.detail
    });
  }

  function resolveWeeklyReadinessActions(report, currentContext) {
    if (!isRecord(report)) {
      fail('A normalized readiness report is required.');
    }
    const context = normalizedContext(currentContext);
    const reportProjectId = canonicalProjectId(report.projectId, 'Report project');
    const reportProjectRevision = canonicalProjectRevision(
      report.projectRevision,
      'Report project revision'
    );
    if (
      reportProjectId !== context.projectId
      || reportProjectRevision !== context.projectRevision
    ) {
      fail('The readiness report does not match the current project revision.');
    }
    if (!Number.isSafeInteger(report.cueCount) || report.cueCount < 0) {
      fail('The readiness report cue count must be a non-negative safe integer.');
    }
    const projectContentHash = report.projectContentHash;
    if (projectContentHash !== null) {
      canonicalRevisionId(projectContentHash, 'Report project content hash');
      if (projectContentHash !== context.revisionId) {
        fail('The readiness report does not match the current project revision ID.');
      }
    }
    if ((report.cueCount === 0) !== (projectContentHash === null)) {
      fail('The readiness report cue count and content hash are inconsistent.');
    }
    if (
      !Array.isArray(report.checks)
      || report.checks.length !== CHECK_SPECS.length
    ) {
      fail(`A readiness report must contain exactly ${CHECK_SPECS.length} canonical checks.`);
    }

    const validatedChecks = CHECK_SPECS.map((spec, index) =>
      validateCheck(report.checks[index], spec, index));
    const compilationEvidence = validatedChecks[0].evidence;
    if (
      compilationEvidence
      && compilationEvidence.cueCount !== report.cueCount
    ) {
      fail('Compilation evidence does not match the readiness report cue count.');
    }
    validateReportSummary(report, validatedChecks);

    const actions = [];
    for (const [index, spec] of CHECK_SPECS.entries()) {
      const validatedCheck = validatedChecks[index];
      if (validatedCheck.check.status === 'blocker') {
        actions.push(actionDescriptor(spec, validatedCheck, context));
      }
    }
    const frozenActions = Object.freeze(actions);
    return Object.freeze({
      actions: frozenActions,
      primaryAction: frozenActions[0] || null
    });
  }

  return Object.freeze({
    WEEKLY_READINESS_CHECK_IDS,
    WEEKLY_READINESS_TARGET_KINDS,
    resolveWeeklyReadinessActions
  });
}));
