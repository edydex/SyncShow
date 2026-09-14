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

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, {
    filename: controllerPath
  });
  return window.SyncShowPrepare;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function linkedReadingFixture() {
  const sermonResourceId = `sha256:${'7'.repeat(64)}`;
  const referenceId = 'primary-eph-3';
  const item = {
    id: 'reading',
    kind: 'bible',
    title: 'Ephesians 3:14–18',
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 14 },
      end: { chapter: 3, verse: 18 }
    },
    sermonReading: {
      sermonResourceId,
      referenceId,
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 2
    }
  };
  const project = {
    resources: {
      [sermonResourceId]: {
        id: sermonResourceId,
        kind: 'sermon',
        document: {
          id: 'sermon-golden-v3',
          defaultLanguage: 'en',
          titles: {
            en: 'The Prayer That Transforms the Church'
          },
          references: [{
            id: referenceId,
            role: 'primary',
            reviewStatus: 'confirmed',
            enteredText: 'Ephesians 3:14–21',
            range: {
              schemaVersion: 1,
              bookId: 'Eph',
              start: { chapter: 3, verse: 14 },
              end: { chapter: 3, verse: 21 }
            }
          }]
        }
      }
    }
  };
  return { item, project, referenceId, sermonResourceId };
}

test('linked Bible cues summarize the human sermon, reviewed passage, and cue position', () => {
  const { sermonReadingInspectorSummary } = rendererExports();
  const fixture = linkedReadingFixture();
  const summary = plain(
    sermonReadingInspectorSummary(fixture.project, fixture.item)
  );

  assert.deepEqual(summary, {
    kind: 'ready',
    sermonTitle: 'The Prayer That Transforms the Church',
    passageLabel: 'Ephesians 3:14–21',
    cueTitle: 'Ephesians 3:14–18',
    translation: 'BSB',
    cuePosition: 'Cue 1 of 2',
    rundownLabel:
      'Reading for The Prayer That Transforms the Church · BSB · Cue 1 of 2',
    status:
      'This cue stays tied to the exact reviewed sermon packet saved with this service.'
  });

  const operatorCopy = JSON.stringify(summary);
  assert.doesNotMatch(operatorCopy, new RegExp(fixture.sermonResourceId));
  assert.doesNotMatch(operatorCopy, new RegExp(fixture.referenceId));
  assert.doesNotMatch(operatorCopy, /sermon-golden-v3/);
});

test('linked reading rundown rows name the sermon without exposing linkage IDs', () => {
  const { rundownRowPresentation } = rendererExports();
  const fixture = linkedReadingFixture();
  const presentation = plain(rundownRowPresentation(fixture.project, {
    item: fixture.item,
    parentTitles: ['Scripture and sermon']
  }));

  assert.equal(
    presentation.summary,
    'Scripture and sermon · Reading for The Prayer That Transforms the Church · BSB · Cue 1 of 2'
  );
  assert.match(
    presentation.accessibleName,
    /Reading for The Prayer That Transforms the Church/
  );
  assert.match(
    presentation.accessibleName,
    /Confirmed primary passage Ephesians 3:14–21/
  );
  assert.match(
    presentation.accessibleName,
    /Selected cue Ephesians 3:14–18/
  );
  assert.doesNotMatch(
    `${presentation.summary} ${presentation.accessibleName}`,
    new RegExp(fixture.sermonResourceId)
  );
  assert.doesNotMatch(
    `${presentation.summary} ${presentation.accessibleName}`,
    new RegExp(fixture.referenceId)
  );
});

test('dense linked readings summarize distinct visible translations and hidden outputs', () => {
  const { sermonReadingInspectorSummary } = rendererExports();
  const fixture = linkedReadingFixture();
  fixture.project.channelIds = ['wall', 'stream', 'confidence'];
  fixture.item.sermonReading = {
    sermonResourceId: fixture.sermonResourceId,
    referenceId: fixture.referenceId,
    outputs: [
      {
        channelId: 'wall',
        mode: 'translation',
        translationId: 'BSB'
      },
      {
        channelId: 'stream',
        mode: 'translation',
        translationId: 'LSV'
      },
      {
        channelId: 'confidence',
        mode: 'hidden'
      }
    ],
    chunkIndex: 0,
    chunkCount: 2
  };

  const summary = plain(
    sermonReadingInspectorSummary(fixture.project, fixture.item)
  );
  assert.equal(summary.translation, 'BSB + LSV; 1 hidden output');
  assert.equal(
    summary.rundownLabel,
    'Reading for The Prayer That Transforms the Church · BSB + LSV; 1 hidden output · Cue 1 of 2'
  );
  const operatorCopy = JSON.stringify(summary);
  assert.doesNotMatch(operatorCopy, new RegExp(fixture.sermonResourceId));
  assert.doesNotMatch(operatorCopy, new RegExp(fixture.referenceId));
  assert.doesNotMatch(operatorCopy, /(?:wall|stream|confidence)/);
});

test('the selected-item linkage card is read-only and fails closed when its packet is absent', () => {
  const { sermonReadingInspectorSummary } = rendererExports();
  const fixture = linkedReadingFixture();
  const unavailable = plain(
    sermonReadingInspectorSummary({ resources: {} }, fixture.item)
  );

  assert.equal(unavailable.kind, 'warning');
  assert.equal(unavailable.sermonTitle, 'Linked sermon unavailable');
  assert.equal(
    unavailable.passageLabel,
    'Confirmed primary passage unavailable'
  );
  assert.match(unavailable.status, /Reopen or re-import the service/);
  assert.equal(
    sermonReadingInspectorSummary(fixture.project, {
      ...fixture.item,
      sermonReading: undefined
    }),
    null
  );

  const start = htmlSource.indexOf(
    '<section id="prepareInspectorSermonReading"'
  );
  const end = htmlSource.indexOf('</section>', start);
  assert.ok(start >= 0 && end > start);
  const card = htmlSource.slice(start, end + '</section>'.length);
  for (const id of [
    'prepareInspectorSermonReadingBadge',
    'prepareInspectorSermonReadingSermon',
    'prepareInspectorSermonReadingPassage',
    'prepareInspectorSermonReadingCue',
    'prepareInspectorSermonReadingStatus'
  ]) {
    assert.match(card, new RegExp(`id="${id}"`));
  }
  assert.match(card, /<dl class="prepare-inspector-sermon-reading-details">/);
  assert.doesNotMatch(card, /<(?:input|select|textarea|button)\b/);
  assert.match(
    controllerSource,
    /const sermonReading = sermonReadingInspectorSummary\([\s\S]*?elements\.inspectorSermonReading\.hidden = !sermonReading/
  );
  assert.match(
    stylesheetSource,
    /\.prepare-inspector-sermon-reading\[hidden\]\s*\{\s*display: none;/
  );
});
