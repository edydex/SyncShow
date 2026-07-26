'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createOnlyRoleDecisions
} = require('../src/renderer/service-output-plan');
const {
  resolveLaunchPlan
} = require('../src/services/show');

const rendererDirectory = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rendererDirectory, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(rendererDirectory, 'app.js'), 'utf8');

function functionBlock(functionName) {
  const start = appSource.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `expected function ${functionName}()`);
  const next = appSource.indexOf('\nfunction ', start + 1);
  return appSource.slice(start, next === -1 ? appSource.length : next);
}

function midweekOutputs() {
  return [
    {
      id: 'russian-room',
      name: 'Russian Screen',
      kind: 'normal',
      displayId: 2,
      expectedRole: 'russian'
    },
    {
      id: 'english-room',
      name: 'English Screen',
      kind: 'normal',
      displayId: null,
      expectedRole: 'english'
    },
    {
      id: 'stage',
      name: 'Singers Screen',
      kind: 'singer',
      displayId: 3,
      expectedRole: 'media'
    }
  ];
}

test('one loaded deck can disable unrelated outputs for one service and still drive Singer', () => {
  const outputs = midweekOutputs();
  const savedVenueOutputs = structuredClone(outputs);
  const decisions = createOnlyRoleDecisions(outputs, 'russian');

  assert.deepEqual(decisions, {
    'russian-room': { mode: 'direct' },
    'english-room': { mode: 'disabled' },
    stage: { mode: 'disabled' }
  });

  decisions.stage = { mode: 'derive-next-text', sourceRole: 'russian' };
  const derivedPlan = resolveLaunchPlan({
    presentations: { russian: { slideCount: 14 } },
    outputs,
    decisions
  });

  assert.deepEqual(
    derivedPlan.outputs.map(output => [output.id, output.renderer, output.sourceRoleId]),
    [
      ['russian-room', 'slides', 'russian'],
      ['stage', 'singer-current-next', 'russian']
    ]
  );

  decisions.stage = { mode: 'mirror', sourceRole: 'russian' };
  const mirroredPlan = resolveLaunchPlan({
    presentations: { russian: { slideCount: 14 } },
    outputs,
    decisions
  });

  assert.deepEqual(
    mirroredPlan.outputs.map(output => [output.id, output.renderer, output.sourceRoleId]),
    [
      ['russian-room', 'slides', 'russian'],
      ['stage', 'slides', 'russian']
    ]
  );
  assert.deepEqual(outputs, savedVenueOutputs,
    'one-service output decisions must not alter the saved venue configuration');
});

test('Friendly Load exposes one-deck and Singer choices on the input cards', () => {
  const roleActions = functionBlock('renderRoleServiceActions');

  assert.match(html, /<body class="friendly-mode load-stage">/);
  assert.match(html, /id="loadEssentials"[\s\S]*id="inputCards"/);
  assert.match(roleActions, /Use only this slideshow today/);
  assert.match(roleActions, /Affects this service only—not Admin Settings\./);
  assert.match(roleActions, /getLoadedRoles\(\)/);
  assert.match(roleActions, /getLoadedRoles\(\{ requireExtractedText: true \}\)/);
  assert.match(roleActions, /`derive-next-text:\$\{sourceRole\}`/);
  assert.match(roleActions, /`mirror:\$\{sourceRole\}`/);
  assert.match(roleActions, /Turn off \$\{output\.name\} for this service/);
});

test('missing Singer input Start prompt keeps upload, derive, mirror, and disable together', () => {
  const startPresentation = functionBlock('startPresentation');
  const preflight = functionBlock('renderStartPreflight');

  assert.match(startPresentation, /questionIds: readiness\.needsChoices\.map\(output => output\.id\)/);
  assert.match(preflight, /What should the \$\{output\.name\} show\?/);
  assert.match(preflight,
    /No \$\{getRoleLabel\(output\.expectedRole\)\} slideshow was loaded/);
  assert.match(preflight, /value: 'upload'/);
  assert.match(preflight, /value: 'derive-next-text'/);
  assert.match(preflight, /value: 'mirror'/);
  assert.match(preflight, /value: 'disabled'/);
  assert.match(preflight, /createPreflightSourceSelect\('derive-next-text', textRoles/);
  assert.match(preflight, /createPreflightSourceSelect\('mirror', loadedRoles/);
});
