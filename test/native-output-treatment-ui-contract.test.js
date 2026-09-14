'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const source = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName
    ? source.indexOf(`function ${nextName}(`, start + 1)
    : source.indexOf('\n    function ', start + 1);
  assert.notEqual(end, -1, `${name} must have a bounded source section`);
  return source.slice(start, end);
}

test('Prepare makes song behavior explicit for every output', () => {
  assert.match(html, /id="prepareSongOutputTreatments"/);
  assert.match(html, />Output treatments</);
  assert.match(html, /Output names never decide behavior\./);
  assert.match(html, />Pin an exact saved version</);
  assert.doesNotMatch(html, />Use normal</);

  const render = functionSource(
    'renderSongOutputTreatments',
    'renderSongInspector'
  );
  assert.match(render, /for \(const channelId of state\.currentProject\.channelIds\)/);
  assert.match(render, /treatmentMode:\s*'inherit'/);
  assert.match(render, /treatmentMode:\s*'derive-next-text'/);
  assert.match(render, /treatmentMode:\s*'hidden'/);
  assert.match(render, /Current \+ next lyrics from/);
  assert.match(render, /songVariantWouldDependOn\(/);
  assert.match(render, /songVariantResolvesToContent\(/);
  assert.doesNotMatch(render, /media\|singer\|stage/i);

  const mutate = functionSource(
    'setSelectedSongOutputTreatment',
    'resetSelectedSongTranslation'
  );
  assert.match(mutate, /api\.setSongOutputTreatment\(/);
  assert.match(mutate, /\['inherit', 'derive-next-text', 'hidden'\]/);
  assert.match(mutate, /sourceChannelId/);
  assert.doesNotMatch(mutate, /resourceId|document|song\s*:/);
});

test('Prepare sends a dense Bible output plan without renderer-owned verse text', () => {
  for (const id of [
    'prepareBibleOutputTreatments',
    'prepareBibleOutputs'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Choose a translation or hide the passage on every output/);

  const render = functionSource(
    'renderBibleOutputTreatments',
    'resetBibleLookup'
  );
  assert.match(render, /for \(const channelId of project\.channelIds\)/);
  assert.match(render, /treatmentMode:\s*'translation'/);
  assert.match(render, /treatmentMode:\s*'hidden'/);
  assert.match(render, /all-hidden passage cannot be added/);

  const lookup = functionSource('lookupPrepareBible', 'addPreparedBible');
  assert.match(
    lookup,
    /outputs:\s*state\.currentProject\.channelIds\.map\(channelId => \(\{/
  );
  assert.match(lookup, /mode:\s*'translation'/);

  const add = functionSource(
    'addPreparedBible',
    'saveSelectedSongArrangement'
  );
  assert.match(add, /outputs:\s*prepared\.outputs\.map\(output => \(\{ \.\.\.output \}\)\)/);
  assert.doesNotMatch(add, /\bpassage\s*:/);
  assert.doesNotMatch(add, /\bverses\s*:/);
  assert.doesNotMatch(add, /\battribution\s*:/);
});
