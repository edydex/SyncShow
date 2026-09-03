(function exposeNativeWorkflowContinuation(root, factory) {
  'use strict';

  const contract = factory();
  if (typeof module === 'object' && module.exports) module.exports = contract;
  if (root) root.SyncShowNativeWorkflowContinuation = contract;
}(typeof globalThis === 'object' ? globalThis : this, function createContract() {
  'use strict';

  const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const REVISION_ID_PATTERN = /^[a-f0-9]{64}$/u;
  const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f]/u;
  const PLANNING_STATUSES = new Set([
    'planning',
    'ready',
    'completed',
    'needs-follow-up'
  ]);
  const CONTEXT_KEYS = Object.freeze([
    'planningStatus',
    'primaryReadinessAction',
    'projectId',
    'projectRevision',
    'readinessReady',
    'revisionId'
  ]);
  const READINESS_ACTION_KEYS = Object.freeze([
    'actionLabel',
    'checkId',
    'detail',
    'label',
    'projectId',
    'projectRevision',
    'revisionId',
    'targetKind'
  ]);

  function fail(message) {
    throw new TypeError(message);
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function exactKeys(value, expected, field) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (
      actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])
    ) {
      fail(`${field} has an invalid contract.`);
    }
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

  function canonicalProjectRevision(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${field} must be a non-negative safe integer.`);
    }
    return value;
  }

  function canonicalRevisionId(value, field) {
    if (typeof value !== 'string' || !REVISION_ID_PATTERN.test(value)) {
      fail(`${field} must be a lowercase SHA-256 revision ID.`);
    }
    return value;
  }

  function boundedText(value, field, maximum) {
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

  function normalizedContext(value) {
    if (!isRecord(value)) {
      fail('Native workflow continuation context must be an object.');
    }
    exactKeys(value, CONTEXT_KEYS, 'Native workflow continuation context');
    const projectId = canonicalProjectId(value.projectId, 'Current project');
    const projectRevision = canonicalProjectRevision(
      value.projectRevision,
      'Current project revision'
    );
    const revisionId = canonicalRevisionId(
      value.revisionId,
      'Current project revision ID'
    );
    if (!PLANNING_STATUSES.has(value.planningStatus)) {
      fail('Planning status is invalid.');
    }
    if (typeof value.readinessReady !== 'boolean') {
      fail('Readiness ready state must be boolean.');
    }
    if (value.primaryReadinessAction === undefined) {
      fail('Primary readiness action must be an object or null.');
    }
    if (value.readinessReady && value.primaryReadinessAction !== null) {
      fail('A ready service cannot also expose a readiness blocker.');
    }
    return Object.freeze({
      projectId,
      projectRevision,
      revisionId,
      planningStatus: value.planningStatus,
      readinessReady: value.readinessReady,
      primaryReadinessAction: value.primaryReadinessAction
    });
  }

  function normalizedReadinessAction(value, context) {
    if (!isRecord(value)) {
      fail('Primary readiness action must be an object or null.');
    }
    exactKeys(value, READINESS_ACTION_KEYS, 'Primary readiness action');
    const projectId = canonicalProjectId(
      value.projectId,
      'Primary readiness action project'
    );
    const projectRevision = canonicalProjectRevision(
      value.projectRevision,
      'Primary readiness action project revision'
    );
    const revisionId = canonicalRevisionId(
      value.revisionId,
      'Primary readiness action revision ID'
    );
    if (
      projectId !== context.projectId
      || projectRevision !== context.projectRevision
      || revisionId !== context.revisionId
    ) {
      fail('Primary readiness action does not match the current project revision.');
    }
    return Object.freeze({
      checkId: canonicalProjectId(value.checkId, 'Primary readiness check'),
      label: boundedText(value.label, 'Primary readiness label', 80),
      actionLabel: boundedText(
        value.actionLabel,
        'Primary readiness action label',
        120
      ),
      targetKind: canonicalProjectId(
        value.targetKind,
        'Primary readiness target kind'
      ),
      projectId,
      projectRevision,
      revisionId,
      detail: boundedText(value.detail, 'Primary readiness action detail', 1000)
    });
  }

  function frozenDescriptor(context, values) {
    return Object.freeze({
      kind: values.kind,
      label: values.label,
      help: values.help,
      projectId: context.projectId,
      projectRevision: context.projectRevision,
      revisionId: context.revisionId,
      ...(values.readinessAction
        ? { readinessAction: values.readinessAction }
        : {})
    });
  }

  function resolveNativeWorkflowContinuation(rawContext) {
    const context = normalizedContext(rawContext);
    if (
      context.planningStatus === 'completed'
      || context.planningStatus === 'needs-follow-up'
    ) {
      return null;
    }
    if (
      context.primaryReadinessAction !== null
      && context.primaryReadinessAction !== undefined
    ) {
      const readinessAction = normalizedReadinessAction(
        context.primaryReadinessAction,
        context
      );
      return frozenDescriptor(context, {
        kind: 'readiness-blocker',
        label: `Continue setup · ${readinessAction.actionLabel}`,
        help: `${readinessAction.detail} Opening this step does not create content, waive a check, mark Ready, or prepare Load.`,
        readinessAction
      });
    }

    if (
      context.readinessReady === true
      && context.planningStatus === 'planning'
    ) {
      return frozenDescriptor(context, {
        kind: 'review-ready',
        label: 'Review & mark Ready',
        help: 'Review this exact saved service order and every stated exception. Nothing is marked Ready until a person confirms the review.'
      });
    }

    if (
      context.readinessReady === true
      && context.planningStatus === 'ready'
    ) {
      return frozenDescriptor(context, {
        kind: 'publish-load',
        label: 'Save & go to Load',
        help: 'Build and install Load from this exact Ready revision. This does not start Show or publish anything to Community.'
      });
    }

    return null;
  }

  return Object.freeze({
    resolveNativeWorkflowContinuation
  });
}));
