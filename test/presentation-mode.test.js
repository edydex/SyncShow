'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const modes = require('../src/renderer/presentation-mode');
const { resolveLaunchPlan } = require('../src/services/show');
const roles = [
  { id: 'english', label: 'English', enabled: true, kind: 'deck' },
  { id: 'russian', label: 'Russian', enabled: true, kind: 'deck' },
  { id: 'media', label: 'Stage-Facing Screen', enabled: true, kind: 'deck' }
];
const displays = [{ id: 1, isControl: true }, { id: 2, isControl: false }];
const outputs = roles.map((role, index) => ({ id: `output-${role.id}`, name: role.label,
  enabled: true, kind: index === 2 ? 'singer' : 'normal', expectedRoleId: role.id, displayId: index + 3 }));
const presentations = Object.fromEntries(roles.map(role => [role.id, {
  loaded: true, slideCount: 3, renderer: 'native-cue', sourceType: 'service-project', assetPaths: {},
  scenes: Array.from({ length: 3 }, (_, index) => ({ cueId: `cue-${index}`, language: role.id }))
}]));
function build(roleId, extra = {}) {
  return modes.singleScreenOutput({ roleId, displayId: 2, roles, displays, outputs, presentations, ...extra });
}

test('automatic mode follows connected audience screens without changing saved routes', () => {
  assert.equal(modes.presentationMode(displays), 'single');
  assert.equal(modes.presentationMode([displays[0]]), 'single');
  assert.equal(modes.presentationMode([...displays, { id: 3, isControl: false }]), 'configured');
  assert.equal(modes.presentationMode(displays, 'configured'), 'configured');
  assert.equal(modes.presentationMode([...displays, { id: 3 }], 'single'), 'single');
});

test('language choices include both loaded audiences and exclude the dedicated stage deck', () => {
  assert.deepEqual(modes.singleScreenRoles(roles, presentations, outputs).map(role => role.id), ['english', 'russian']);
  assert.equal(modes.singleScreenRoles(roles, { english: { slideCount: 3, pending: true } }, outputs).length, 0);
});

for (const language of ['english', 'russian']) {
  test(`one-screen ${language} keeps its native scene, cue count and translation output identity`, () => {
    const original = JSON.stringify(outputs);
    const output = build(language);
    const plan = resolveLaunchPlan({ presentations, outputs: [output], decisions: {}, preferredTimelineRoleId: language });
    assert.equal(plan.outputs.length, 1);
    assert.equal(plan.outputs[0].id, `output-${language}`);
    assert.equal(plan.outputs[0].sourceRoleId, language);
    assert.equal(plan.outputs[0].renderer, 'native-cue');
    assert.equal(plan.outputs[0].displayId, 2);
    assert.equal(plan.timelineRoleId, language);
    assert.equal(plan.totalSlides, 3);
    assert.equal(JSON.stringify(outputs), original);
  });
}

test('one legacy PowerPoint can use a temporary screen without venue assignments', () => {
  const single = { english: { loaded: true, slideCount: 17 } };
  const output = build('english', { outputs: [], presentations: single });
  const plan = resolveLaunchPlan({ presentations: single, outputs: [output], decisions: {} });
  assert.equal(plan.outputs[0].renderer, 'slides');
  assert.equal(plan.totalSlides, 17);
});

test('operator screen, unplugged screen and unavailable language are rejected before launch', () => {
  assert.throws(() => build('english', { displayId: 1 }), /external screen/);
  assert.throws(() => build('english', { displays: [displays[0]] }), /no longer connected/);
  assert.throws(() => build('russian', { presentations: { english: presentations.english } }), /no longer loaded/);
  assert.throws(() => build('media'), /no longer loaded/);
});

function rendererFixture(extra = {}) {
  const state = { profile: { inputRoles: roles, outputs }, presentations, displays,
    presentationMode: 'auto', testOutput: { enabled: true, displayId: '2' },
    serviceFolder: { staleRoleIds: [] }, ...extra };
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const scope = vm.createContext({ state, window: { SyncShowPresentationMode: modes }, elements: {},
    presentationElements: Object.fromEntries(roles.map(role => [role.id, {}])),
    resolveOutputDisplay: () => null, isEditableOutputRoute: () => true,
    getServiceOutputDecision: () => ({ mode: 'disabled' }),
    decisionSourceRole: output => output.expectedRole,
    getRoleLabel: role => role });
  vm.runInContext(source.slice(source.indexOf('function getConfiguredOutputs()'), source.indexOf('function confirmPreparedServiceDate()')), scope);
  return { state, read: testOutput => vm.runInContext(`getReadinessState(${Boolean(testOutput)})`, scope) };
}

test('production readiness ignores stale three-screen assignments and old per-service disable choices in one-screen mode', () => {
  const { read } = rendererFixture();
  const ready = read();
  assert.equal(ready.isReady, true);
  assert.equal(ready.singleScreen, true);
  assert.equal(ready.activeOutputs.length, 1);
  assert.equal(ready.hasDisplayConflict, false);
  assert.equal(ready.missingDisplays.length, 0);
});

test('one-screen readiness is blocked by disconnection, conversion or no loaded audience language', () => {
  assert.equal(rendererFixture({ displays: [displays[0]] }).read().isReady, false);
  assert.equal(rendererFixture({ presentations: {} }).read().isReady, false);
  assert.equal(rendererFixture({ presentations: { english: { ...presentations.english, pending: true } } }).read().isReady, false);
});

test('saved setup and Test Output retain their own per-service output decisions', () => {
  const { read } = rendererFixture({ presentationMode: 'configured' });
  assert.equal(read().singleScreen, false);
  assert.equal(read().activeOutputs.length, 0);
  const demo = rendererFixture().read(true);
  assert.equal(demo.singleScreen, false);
  assert.equal(demo.activeOutputs.length, 0);
});

test('choosing one language does not require unrelated loaded decks to have the same slide count', () => {
  const { read } = rendererFixture({ presentations: { ...presentations, russian: { ...presentations.russian, slideCount: 8 } } });
  assert.equal(read().isReady, true);
});

function chooserFixture(roleId, connected = displays) {
  let launches = 0;
  const attempt = { snapshot: { singleScreen: true, outputs: [] }, decisions: {} };
  const state = { startAttempt: attempt };
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const scope = vm.createContext({ state,
    elements: { preflightChoices: { querySelector: () => roleId ? { value: roleId } : null } },
    document: { getElementById: () => ({ value: '2' }) },
    buildSingleScreenOutput: (role, displayId) => build(role, { displayId, displays: connected }),
    launchStartAttempt: async () => { launches++; }, renderStartPreflight: () => {} });
  vm.runInContext(source.slice(source.indexOf('async function handlePreflightSubmit('), source.indexOf('async function uploadForPreflight(')), scope);
  return { state, attempt, launches: () => launches,
    submit: () => vm.runInContext('handlePreflightSubmit({ preventDefault() {} })', scope) };
}

for (const language of ['english', 'russian']) {
  test(`the actual chooser submission launches only the selected ${language} output`, async () => {
    const fixture = chooserFixture(language);
    await fixture.submit();
    assert.equal(fixture.launches(), 1);
    assert.equal(fixture.attempt.snapshot.outputs.length, 1);
    assert.equal(fixture.attempt.snapshot.outputs[0].expectedRole, language);
    assert.equal(fixture.attempt.snapshot.preferredTimelineRoleId, language);
    assert.equal(fixture.state.lastSingleScreenRole, language);
  });
}

test('the chooser cannot launch without a language or after its screen disconnects', async () => {
  for (const fixture of [chooserFixture(null), chooserFixture('english', [displays[0]])]) {
    await fixture.submit();
    assert.equal(fixture.launches(), 0);
    assert.ok(fixture.attempt.error);
    assert.equal(fixture.attempt.snapshot.outputs.length, 0);
  }
});
