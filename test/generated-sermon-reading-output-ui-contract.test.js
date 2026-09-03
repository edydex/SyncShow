'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
);
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const stylesheetSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function functionSource(name, nextName) {
  const start = controllerSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = controllerSource.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(end, -1, `${name} must have a bounded source section`);
  return controllerSource.slice(start, end);
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, {
    filename: controllerPath
  });
  return window.SyncShowPrepare;
}

test('both native generated-reading entry points expose explicit dense output treatments', () => {
  for (const id of [
    'prepareSermonReadingOutputTreatments',
    'prepareSermonReadingOutputs',
    'createSermonPacketReadingOutputTreatments',
    'createSermonPacketReadingOutputs',
    'createSermonPacketReadingOutputStatus'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(htmlSource, /id="prepareSermonReadingTranslation"/);
  assert.match(htmlSource, /Choose BSB, LSV, or Hidden for every output/);
  assert.match(htmlSource, /Output names never decide the translation/);
  assert.doesNotMatch(htmlSource, /SyncShow uses BSB and splits longer readings/);

  const denseRenderer = functionSource(
    'renderDenseBibleOutputSelections',
    'selectedSermonReadingOutputContext'
  );
  assert.match(denseRenderer, /for \(const channelId of project\.channelIds\)/);
  assert.match(denseRenderer, /treatmentMode:\s*'translation'/);
  assert.match(denseRenderer, /treatmentMode:\s*'hidden'/);
  assert.match(denseRenderer, /Hidden for this reading/);
  assert.doesNotMatch(denseRenderer, /media|singer|stage/i);

  assert.match(
    stylesheetSource,
    /\.prepare-sermon-reading-output-treatments\[hidden\]\s*\{\s*display: none;/
  );
});

test('manual generated readings send only the dense semantic output plan', () => {
  const add = functionSource(
    'addSelectedSermonReading',
    'resetSermonPacketReference'
  );
  assert.match(add, /api\.addSermonReadingToService\(\{/);
  assert.match(
    add,
    /outputs:\s*cloneBibleOutputSelections\(outputs\)/
  );
  assert.match(
    add,
    /visibleBibleOutputSelections\(outputs\)\.length < 1/
  );
  assert.doesNotMatch(add, /\btranslationId\s*[,}]/);
  assert.doesNotMatch(add, /\b(?:passage|verses|passagesByChannel)\s*:/);

  const controls = functionSource(
    'updateControlStates',
    'communityPlanReviewButton'
  );
  assert.match(controls, /'invalid-outputs',\s*'all-hidden'/);
  assert.match(
    controls,
    /\[data-sermon-reading-output-treatment\]/
  );
});

test('direct and reviewed packet creation both bind readingOutputs', () => {
  const create = functionSource(
    'createSermonPacket',
    'selectedLinkedSermonServiceSourcesContext'
  );
  assert.match(create, /addPrimaryReading/);
  assert.match(
    create,
    /readingOutputs:\s*cloneBibleOutputSelections\(readingOutputs\)/
  );
  assert.match(
    create,
    /visibleBibleOutputSelections\(readingOutputs\)\.length < 1/
  );
  assert.doesNotMatch(create, /\b(?:passage|verses|passagesByChannel)\s*:/);

  const propose = functionSource(
    'proposeServiceSermonPacket',
    'openSermonPacketDialog'
  );
  assert.match(
    propose,
    /readingOutputs:\s*cloneBibleOutputSelections\(readingOutputs\)/
  );
  assert.match(
    propose,
    /visibleBibleOutputSelections\(readingOutputs\)\.length < 1/
  );
  assert.match(propose, /readingMode:\s*addPrimaryReading/);

  assert.match(controllerSource, /sermonPacketReadingAllHidden/);
  assert.match(
    controllerSource,
    /all-hidden reading cannot be created/
  );
});

test('dense output helpers preserve channel order and reject incomplete or all-hidden plans at the action boundary', () => {
  const {
    defaultSermonReadingOutputs,
    normalizeSermonReadingOutputs,
    sermonReadingOutputPlansEqual
  } = rendererExports();
  const project = {
    channelIds: ['wall', 'stream', 'confidence']
  };
  const defaults = defaultSermonReadingOutputs(project);
  assert.deepEqual(
    JSON.parse(JSON.stringify(defaults)),
    [
      { channelId: 'wall', mode: 'translation', translationId: 'BSB' },
      { channelId: 'stream', mode: 'translation', translationId: 'BSB' },
      { channelId: 'confidence', mode: 'translation', translationId: 'BSB' }
    ]
  );
  const mixed = normalizeSermonReadingOutputs(project, [
    { channelId: 'confidence', mode: 'hidden' },
    { channelId: 'wall', mode: 'translation', translationId: 'BSB' },
    { channelId: 'stream', mode: 'translation', translationId: 'LSV' }
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(mixed)),
    [
      { channelId: 'wall', mode: 'translation', translationId: 'BSB' },
      { channelId: 'stream', mode: 'translation', translationId: 'LSV' },
      { channelId: 'confidence', mode: 'hidden' }
    ]
  );
  assert.equal(
    normalizeSermonReadingOutputs(project, mixed.slice(0, 2)),
    null
  );
  assert.equal(sermonReadingOutputPlansEqual(mixed, mixed), true);
  assert.equal(sermonReadingOutputPlansEqual(defaults, mixed), false);
});
