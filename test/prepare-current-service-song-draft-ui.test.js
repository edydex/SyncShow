'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, {
    filename: controllerPath
  });
  return window.SyncShowPrepare;
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function rawSource() {
  const lanes = (all, white = '', yellow = '') => ({
    all: { preview: all, lineCount: all ? all.split('\n').length : 0 },
    white: { preview: white, lineCount: white ? white.split('\n').length : 0 },
    yellow: { preview: yellow, lineCount: yellow ? yellow.split('\n').length : 0 }
  });
  return {
    proposalToken: 'p'.repeat(32),
    expiresAt: '2026-07-28T18:00:00.000Z',
    serviceSet: {
      name: 'Sunday Service',
      serviceDate: '2026-07-26'
    },
    source: {
      roleId: 'english',
      roleLabel: 'English',
      fileName: '07-26-2026 Service ENG.pptx',
      sha256: 'a'.repeat(64)
    },
    slideCount: 3,
    slides: [
      { number: 1, lanes: lanes('Title', 'Title') },
      { number: 2, lanes: lanes('Line one\nСтрока один', 'Line one', 'Строка один') },
      { number: 3, lanes: lanes('Line two\nСтрока два', 'Line two', 'Строка два') }
    ],
    candidates: [{
      id: 'slides-1-2-3',
      kind: 'syncshow-current-service-song-review-range',
      titleSlide: 1,
      startSlide: 2,
      endSlide: 3,
      evidence: {
        kind: 'template-text-shape-run',
        bodySlideCount: 2
      }
    }]
  };
}

test('PowerPoint song source projection is strict, path-free, ordered, and frozen', () => {
  const { normalizeCurrentServiceSongSource } = rendererExports();
  const normalized = normalizeCurrentServiceSongSource(rawSource());

  assert.equal(normalized.source.fileName, '07-26-2026 Service ENG.pptx');
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.slides[1].lanes.white)),
    { preview: 'Line one', lineCount: 1 }
  );
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.slides), true);
  assert.equal(Object.isFrozen(normalized.slides[0].lanes), true);
  assert.equal(Object.isFrozen(normalized.candidates), true);
  assert.equal(Object.isFrozen(normalized.candidates[0].evidence), true);
  assert.equal(JSON.stringify(normalized).includes('/Users/'), false);

  assert.throws(
    () => normalizeCurrentServiceSongSource({
      ...rawSource(),
      source: { ...rawSource().source, fileName: '/private/service.pptx' }
    }),
    /incomplete/
  );
  assert.throws(
    () => normalizeCurrentServiceSongSource({
      ...rawSource(),
      slides: [
        rawSource().slides[0],
        { ...rawSource().slides[1], number: 3 },
        rawSource().slides[2]
      ]
    }),
    /slide was invalid/
  );
  assert.throws(
    () => normalizeCurrentServiceSongSource({
      ...rawSource(),
      slides: rawSource().slides.map((slide, index) => index === 0
        ? {
            ...slide,
            lanes: {
              ...slide.lanes,
              all: { preview: 7, lineCount: 1 }
            }
          }
        : slide)
    }),
    /text lane was invalid/
  );
});

test('structural song-review suggestions remain advisory exact ranges', () => {
  const {
    currentServiceSongReviewCandidate,
    normalizeCurrentServiceSongSource
  } = rendererExports();
  const normalized = normalizeCurrentServiceSongSource(rawSource());

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      currentServiceSongReviewCandidate(normalized, 'slides-1-2-3')
    )),
    rawSource().candidates[0]
  );
  assert.equal(
    currentServiceSongReviewCandidate(normalized, 'slides-2-3-4'),
    null
  );
  assert.throws(
    () => normalizeCurrentServiceSongSource({
      ...rawSource(),
      candidates: [{
        ...rawSource().candidates[0],
        endSlide: 4
      }]
    }),
    /suggestion was invalid/
  );
});

test('PowerPoint song selection requires at most 200 consecutive in-range slides', () => {
  const {
    currentServiceSongSelection,
    normalizeCurrentServiceSongSource
  } = rendererExports();
  const normalized = normalizeCurrentServiceSongSource(rawSource());

  const selection = currentServiceSongSelection(normalized, 'white', 2, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(selection)),
    JSON.parse(JSON.stringify({
      startSlide: 2,
      endSlide: 3,
      slides: [normalized.slides[1], normalized.slides[2]],
      slideLanes: ['white', 'white'],
      emptySlideNumbers: []
    }))
  );
  assert.equal(Object.isFrozen(selection.slideLanes), true);

  const mixedSelection = currentServiceSongSelection(
    normalized,
    'all',
    2,
    3,
    ['white', 'yellow']
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(mixedSelection)),
    JSON.parse(JSON.stringify({
      startSlide: 2,
      endSlide: 3,
      slides: [normalized.slides[1], normalized.slides[2]],
      slideLanes: ['white', 'yellow'],
      emptySlideNumbers: []
    }))
  );
  assert.equal(
    currentServiceSongSelection(normalized, 'white', 2, 3, ['white']),
    null
  );
  assert.equal(
    currentServiceSongSelection(
      normalized,
      'white',
      2,
      3,
      ['white', 'blue']
    ),
    null
  );
  assert.equal(currentServiceSongSelection(normalized, 'white', 3, 2), null);
  assert.equal(currentServiceSongSelection(normalized, 'blue', 2, 3), null);

  const oneLane = {
    all: { preview: 'Line', lineCount: 1 },
    white: { preview: 'Line', lineCount: 1 },
    yellow: { preview: '', lineCount: 0 }
  };
  const large = normalizeCurrentServiceSongSource({
    ...rawSource(),
    slideCount: 201,
    slides: Array.from({ length: 201 }, (_value, index) => ({
      number: index + 1,
      lanes: oneLane
    }))
  });
  assert.equal(
    currentServiceSongSelection(large, 'white', 1, 200).slides.length,
    200
  );
  assert.equal(currentServiceSongSelection(large, 'white', 1, 201), null);
  assert.equal(currentServiceSongSelection(large, 'white', 2, 202), null);

  const withEmptyYellow = normalizeCurrentServiceSongSource({
    ...rawSource(),
    slides: [
      rawSource().slides[0],
      rawSource().slides[1],
      {
        ...rawSource().slides[2],
        lanes: {
          ...rawSource().slides[2].lanes,
          yellow: { preview: '', lineCount: 0 }
        }
      }
    ]
  });
  assert.deepEqual(
    Array.from(
      currentServiceSongSelection(
        withEmptyYellow,
        'all',
        2,
        3,
        ['white', 'yellow']
      )
        .emptySlideNumbers
    ),
    [3]
  );
});

test('Current PowerPoint card opens a separate reviewed local-song draft workflow', () => {
  for (const id of [
    'btnReviewCurrentServiceSongs',
    'currentServiceSongDialog',
    'currentServiceSongRole',
    'currentServiceSongSuggestedRange',
    'currentServiceSongLane',
    'currentServiceSongStartSlide',
    'currentServiceSongEndSlide',
    'currentServiceSongTitle',
    'currentServiceSongLanguage',
    'currentServiceSongConfirmed',
    'btnBuildCurrentServiceSongDraft'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /does not change the PowerPoint or share anything with Community/
  );
  assert.match(
    htmlSource,
    /confirm Verse\/Chorus\/Bridge labels, repeats, credits, and source wording/
  );
  assert.match(
    htmlSource,
    /Suggestions use exact title-placeholder and lyric-textbox runs/
  );
  assert.match(
    htmlSource,
    /White and yellow are source color lanes, not language labels/
  );

  assert.match(
    controllerSource,
    /api\.inspectCurrentServiceSongSource\(\{\s*inspectionToken,\s*roleId: requestedRoleId\s*\}\)/
  );
  assert.match(
    controllerSource,
    /api\.buildCurrentServiceSongDraft\(\{\s*proposalToken: source\.proposalToken,\s*lane,\s*startSlide: selection\.startSlide,\s*endSlide: selection\.endSlide,\s*slideLanes: selection\.slideLanes,\s*title,\s*language,\s*confirmed: true\s*\}\)/
  );
  assert.match(
    controllerSource,
    /fillSongEditor\(result\.song,\s*\{\s*newDraft: true/
  );
  assert.match(
    controllerSource,
    /state\.songEditingId = newDraft \? null/
  );
  assert.match(
    controllerSource,
    /Nothing is saved or shared yet/
  );
  assert.match(
    controllerSource,
    /CURRENT_SERVICE_SONG_LANGUAGE_PATTERN\.test\(language\)/
  );
  assert.match(
    controllerSource,
    /applyCurrentServiceSongSuggestion/
  );
  assert.doesNotMatch(
    controllerSource,
    /buildCurrentServiceSongDraft\([\s\S]{0,1200}(?:sourcePath|pinnedPath)/
  );
});

test('a failed confirmed build refreshes its consumed proposal before retry', () => {
  const buildSource = sourceBetween(
    controllerSource,
    'async function buildCurrentServiceSongDraft(event)',
    'function renderProjectList()'
  );
  assert.match(
    buildSource,
    /retryMessage = errorMessage\([\s\S]*state\.currentServiceSongBuildBusy = false;[\s\S]*await loadCurrentServiceCompanion\(\);[\s\S]*await inspectCurrentServiceSongRole\(retryRoleId\)/
  );
  assert.match(
    buildSource,
    /currentServiceSongStartSlide\.value =\s*String\(selection\.startSlide\)[\s\S]*currentServiceSongEndSlide\.value =\s*String\(selection\.endSlide\)/
  );
  assert.match(
    buildSource,
    /state\.currentServiceSongSlideLanes = new Map\(\s*selection\.slideLanes[\s\S]*\.filter\(\(\[_slideNumber, selectedLane\]\) =>\s*selectedLane !== lane\)\s*\)/
  );
  assert.match(
    buildSource,
    /const retryCandidate =[\s\S]*candidate\.id === retryCandidateId[\s\S]*candidate\.startSlide === selection\.startSlide[\s\S]*candidate\.endSlide === selection\.endSlide[\s\S]*currentServiceSongSuggestedRange\.value =\s*retryCandidate\?\.id \|\| ''/
  );
  assert.match(
    buildSource,
    /const sameSource = refreshed[\s\S]*state\.currentServiceSongSource\?\.source\?\.sha256[\s\S]*=== retrySourceSha256/
  );
  assert.match(
    buildSource,
    /The exact presentation was rechecked; review the restored selection and confirm it again/
  );
  assert.match(
    buildSource,
    /That presentation changed while the draft was being built[\s\S]*choose the lyric range again/
  );
});

test('the default lane preserves explicit per-slide exceptions', () => {
  assert.match(
    controllerSource,
    /if \(laneSelect\.value === elements\.currentServiceSongLane\.value\) \{\s*state\.currentServiceSongSlideLanes\.delete\(slide\.number\)/
  );
  assert.match(
    controllerSource,
    /elements\.currentServiceSongLane\.addEventListener\(\s*'change',\s*updateCurrentServiceSongDraft\s*\)/
  );
  assert.doesNotMatch(
    controllerSource,
    /function resetCurrentServiceSongSlideLanes/
  );
});
