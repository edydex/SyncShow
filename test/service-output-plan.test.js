'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOnlyRoleDecisions,
  decisionToRouteValue,
  filterDecisionsForOutputs,
  resolveDecision,
  routeValueToDecision
} = require('../src/renderer/service-output-plan');
const { resolveLaunchPlan } = require('../src/services/show');

function configuredOutputs() {
  return [
    { id: 'russian-room', expectedRole: 'russian', kind: 'normal' },
    { id: 'english-room', expectedRole: 'english', kind: 'normal' },
    { id: 'stage', expectedRole: 'media', kind: 'singer' }
  ];
}

test('one-slideshow preset enables only outputs assigned to that input role', () => {
  const outputs = configuredOutputs();
  const before = structuredClone(outputs);

  assert.deepEqual(createOnlyRoleDecisions(outputs, 'english'), {
    'russian-room': { mode: 'disabled' },
    'english-room': { mode: 'direct' },
    stage: { mode: 'disabled' }
  });
  assert.deepEqual(outputs, before, 'service choices must not mutate the venue profile');
});

test('one-slideshow preset launches even when disabled service outputs have no file or display', () => {
  const outputs = [
    {
      id: 'russian-room',
      name: 'Russian Screen',
      kind: 'normal',
      expectedRole: 'russian',
      displayId: 2
    },
    {
      id: 'english-room',
      name: 'English Screen',
      kind: 'normal',
      expectedRole: 'english',
      displayId: null
    },
    {
      id: 'stage',
      name: 'Singers Screen',
      kind: 'singer',
      expectedRole: 'media',
      displayId: null
    }
  ];

  const plan = resolveLaunchPlan({
    presentations: { russian: { slideCount: 14 } },
    outputs,
    decisions: createOnlyRoleDecisions(outputs, 'russian')
  });

  assert.equal(plan.timelineRoleId, 'russian');
  assert.deepEqual(plan.outputs.map(output => output.id), ['russian-room']);
});

test('effective decisions prefer service overrides and otherwise use a loaded expected role', () => {
  const [russian, english] = configuredOutputs();
  const presentations = {
    russian: { loaded: true },
    english: { loaded: false }
  };

  assert.deepEqual(resolveDecision(russian, presentations, {}), { mode: 'direct' });
  assert.equal(resolveDecision(english, presentations, {}), null);
  assert.deepEqual(resolveDecision(russian, presentations, {
    'russian-room': { mode: 'disabled' }
  }), { mode: 'disabled' });
});

test('Singer route values round-trip custom role IDs without losing colons', () => {
  const decision = routeValueToDecision('derive-next-text:language:uk');
  assert.deepEqual(decision, {
    mode: 'derive-next-text',
    sourceRole: 'language:uk'
  });
  assert.equal(decisionToRouteValue(decision), 'derive-next-text:language:uk');
  assert.deepEqual(routeValueToDecision('mirror:russian'), {
    mode: 'mirror',
    sourceRole: 'russian'
  });
  assert.deepEqual(routeValueToDecision('disabled'), { mode: 'disabled' });
  assert.equal(routeValueToDecision('default'), null);
});

test('launch decisions are filtered to current outputs and malformed routes are dropped', () => {
  assert.deepEqual(filterDecisionsForOutputs(configuredOutputs(), {
    'russian-room': { mode: 'direct' },
    'english-room': { mode: 'mirror', sourceRole: 'russian' },
    stage: { mode: 'derive-next-text' },
    removed: { mode: 'disabled' }
  }), {
    'russian-room': { mode: 'direct' },
    'english-room': { mode: 'mirror', sourceRole: 'russian' }
  });
});
