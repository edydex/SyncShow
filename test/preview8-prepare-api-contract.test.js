'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const prepareSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'prepare-controller.js'), 'utf8');
const rendererIndex = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

const PROJECT_REVISION = 'a'.repeat(64);
const SAVED_REVISION = 'b'.repeat(64);
const SONG_REVISION = 'c'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload: plain(payload) });
      return Promise.resolve({ ok: true });
    },
    send() {},
    on() {},
    removeListener() {},
    removeAllListeners() {}
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      if (name === 'api') api = value;
    }
  };

  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console
  }, { filename: path.join(root, 'preload.js') });

  assert.ok(api, 'preload must expose the renderer API');
  return { api, calls };
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function assertTrustedHandler(channel, { request = true } = {}) {
  const source = handlerSource(channel);
  assert.match(source, /requireControlSender\(event\)/,
    `${channel} must accept only the trusted control main frame`);
  if (request) {
    assert.match(source, /requirePrepareRequest\(request,/,
      `${channel} must bound and validate renderer input`);
  }
  return source;
}

function assertNoRendererNativeInput(source, channel) {
  assert.doesNotMatch(
    source,
    /request\.(?:path|filePath|sourcePath|targetPath|destinationPath|packagePath|cacheDir|fontPath|buffer|bytes|bundle|project|resources|assets)\b/,
    `${channel} must not accept paths, portable bytes, or project blobs from the renderer`
  );
}

function assertCasMutation(channel) {
  const source = assertTrustedHandler(channel);
  assert.match(source, /readExpectedProject\(request\)/,
    `${channel} must read through the expected-revision guard`);
  assert.match(source, /serviceProjectStore\.save\(/,
    `${channel} must commit through the project store`);
  assert.match(source, /expectedRevisionId:\s*current\.expectedRevisionId/,
    `${channel} must commit the revision that was checked before mutation`);
  assertNoRendererNativeInput(source, channel);
  return source;
}

test('Preview 8 preload keeps history, exchange, and native preview requests semantic', async () => {
  const { api, calls } = loadPreloadBridge();
  const hostile = {
    filePath: '/private/renderer-selected.syncshow-service',
    sourcePath: '/private/source.syncshow-service',
    destinationPath: '/private/export.syncshow-service',
    buffer: { type: 'Buffer', data: [80, 75, 3, 4] },
    bytes: [80, 75, 3, 4],
    bundle: { project: { hostile: true } },
    project: { hostile: true },
    resources: { hostile: true },
    assets: { hostile: true }
  };

  await api.listServiceProjectHistory({
    ...hostile,
    projectId: 'service-sunday',
    limit: 25
  });
  await api.restoreServiceProjectRevision({
    ...hostile,
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    targetRevisionId: SAVED_REVISION
  });
  await api.exportServiceProject({
    ...hostile,
    projectId: 'service-sunday',
    revisionId: PROJECT_REVISION
  });
  await api.importServiceProject(hostile);
  await api.previewServiceItem({
    ...hostile,
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'song-amazing-grace',
    channelId: 'media',
    cueOffset: 2
  });

  assert.deepEqual(calls, [
    {
      channel: 'prepare:projects:history',
      payload: { projectId: 'service-sunday', limit: 25 }
    },
    {
      channel: 'prepare:projects:restoreRevision',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: PROJECT_REVISION,
        targetRevisionId: SAVED_REVISION
      }
    },
    {
      channel: 'prepare:projects:export',
      payload: {
        projectId: 'service-sunday',
        revisionId: PROJECT_REVISION
      }
    },
    {
      channel: 'prepare:projects:import',
      payload: undefined
    },
    {
      channel: 'prepare:projects:previewItem',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'song-amazing-grace',
        channelId: 'media',
        cueOffset: 2
      }
    }
  ]);
});

test('Preview 8 preload narrows song authoring and item mutation payloads', async () => {
  const { api, calls } = loadPreloadBridge();
  const hostile = {
    fileName: '../../hostile.md',
    filePath: '/private/hostile.md',
    sourcePath: '/private/hostile.md',
    project: { hostile: true },
    resources: { hostile: true },
    buffer: { type: 'Buffer', data: [1, 2, 3] }
  };
  const documentSource = '# Amazing Grace\n\n^1\nAmazing grace\n';

  await api.readSongDocument({
    ...hostile,
    songId: 'amazing-grace',
    revisionId: SONG_REVISION
  });
  await api.validateSongDocument({
    ...hostile,
    documentSource,
    editingSongId: 'amazing-grace'
  });
  await api.saveSongDocument({
    ...hostile,
    songId: 'amazing-grace',
    expectedRevisionId: SONG_REVISION,
    documentSource
  });
  await api.updateServiceItem({
    ...hostile,
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'notice-welcome',
    title: 'Welcome',
    groupKind: 'section',
    textByChannel: [
      { channelId: 'primary', text: 'Welcome', resourceId: 'hostile' },
      { channelId: 'media', text: 'Welcome singers', filePath: '/private/hostile' }
    ],
    titlesByChannel: [
      { channelId: 'primary', title: 'Welcome title', resourceId: 'hostile' },
      { channelId: 'media', title: '', filePath: '/private/hostile' }
    ],
    spansByChannel: [
      {
        channelId: 'primary',
        spans: [{
          start: 0,
          end: 7,
          gold: true,
          foreground: '#ff00ff',
          weight: '999',
          markup: '<span>hostile</span>'
        }]
      },
      {
        channelId: 'media',
        spans: [{ start: 8, end: 15, gold: false, color: 'renderer-controlled' }]
      }
    ],
    presetId: 'notice',
    altText: 'Welcome notice',
    fit: 'fit',
    attribution: 'Heritage Church',
    operatorNotes: 'Advance after announcements',
    plannedDurationSeconds: 300,
    childIds: ['hostile-child']
  });
  await api.updatePictureOutput({
    ...hostile,
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'welcome-picture',
    channelId: 'media',
    action: 'choose',
    assetId: `sha256:${'f'.repeat(64)}`
  });
  await api.duplicateServiceItem({
    ...hostile,
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'notice-welcome',
    targetParentId: 'renderer-selected-parent',
    targetIndex: 999
  });

  assert.deepEqual(calls, [
    {
      channel: 'prepare:songs:read',
      payload: {
        songId: 'amazing-grace',
        revisionId: SONG_REVISION
      }
    },
    {
      channel: 'prepare:songs:validate',
      payload: {
        documentSource,
        editingSongId: 'amazing-grace'
      }
    },
    {
      channel: 'prepare:songs:save',
      payload: {
        songId: 'amazing-grace',
        expectedRevisionId: SONG_REVISION,
        documentSource
      }
    },
    {
      channel: 'prepare:projects:updateItem',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'notice-welcome',
        title: 'Welcome',
        groupKind: 'section',
        textByChannel: [
          { channelId: 'primary', text: 'Welcome' },
          { channelId: 'media', text: 'Welcome singers' }
        ],
        titlesByChannel: [
          { channelId: 'primary', title: 'Welcome title' },
          { channelId: 'media', title: '' }
        ],
        spansByChannel: [
          {
            channelId: 'primary',
            spans: [{ start: 0, end: 7, gold: true }]
          },
          {
            channelId: 'media',
            spans: [{ start: 8, end: 15, gold: false }]
          }
        ],
        presetId: 'notice',
        altText: 'Welcome notice',
        fit: 'fit',
        attribution: 'Heritage Church',
        operatorNotes: 'Advance after announcements',
        plannedDurationSeconds: 300
      }
    },
    {
      channel: 'prepare:projects:updatePictureOutput',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'welcome-picture',
        channelId: 'media',
        action: 'choose'
      }
    },
    {
      channel: 'prepare:projects:duplicateItem',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'notice-welcome'
      }
    }
  ]);
});

test('Prepare preload preserves explicit projected-title clearing', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.updateServiceItem({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-point',
    title: 'Operator title',
    textByChannel: [
      { channelId: 'primary', text: 'Only body remains' },
      { channelId: 'media', text: '' }
    ],
    titlesByChannel: null,
    spansByChannel: null
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:updateItem',
    payload: {
      projectId: 'service-sunday',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-point',
      title: 'Operator title',
      textByChannel: [
        { channelId: 'primary', text: 'Only body remains' },
        { channelId: 'media', text: '' }
      ],
      titlesByChannel: null,
      spansByChannel: null
    }
  }]);
});

test('project history restore and portable exchange stay trusted and revision-pinned in main', () => {
  const history = assertTrustedHandler('prepare:projects:history');
  assert.match(history, /prepareId\(request\.projectId/);
  assert.match(history, /serviceProjectStore\.listRevisions\(projectId,/);
  assertNoRendererNativeInput(history, 'prepare:projects:history');

  const restore = assertTrustedHandler('prepare:projects:restoreRevision');
  assert.match(restore, /serviceProjectStore\.restoreRevision\(/);
  assert.match(restore, /expectedRevisionId:\s*prepareRevision\(request\.expectedRevisionId/);
  assert.match(restore, /targetRevisionId:\s*prepareRevision\(request\.targetRevisionId/);
  assertNoRendererNativeInput(restore, 'prepare:projects:restoreRevision');

  const exportHandler = assertTrustedHandler('prepare:projects:export');
  assert.match(exportHandler, /prepareId\(request\.projectId/);
  assert.match(exportHandler, /prepareRevision\(request\.revisionId/);
  assert.match(
    exportHandler,
    /serviceProjectExchange\.exportBundle\(\s*projectId,\s*revisionId\s*\)/
  );
  assert.match(exportHandler, /dialog\.showSaveDialog\(/);
  assert.match(exportHandler, /writePortableExport\(targetPath,\s*exported\.buffer\)/);
  assertNoRendererNativeInput(exportHandler, 'prepare:projects:export');

  const importHandler = assertTrustedHandler('prepare:projects:import', { request: false });
  assert.match(importHandler, /dialog\.showOpenDialog\(/);
  assert.match(importHandler, /readFileNoFollow\(sourcePath,\s*MAX_BUNDLE_BYTES\)/,
    'main must use its bounded no-follow reader for the dialog-selected file');
  assert.match(importHandler, /serviceProjectExchange\.importBundle\(read\.buffer\)/);
  assert.match(importHandler, /songLibrary:\s*imported\.songLibrary/,
    'portable import must return bounded library hydration counts and warnings');
  assert.match(importHandler, /sermonLibrary:\s*imported\.sermonLibrary/,
    'portable import must return bounded sermon hydration counts and warnings');
  assert.doesNotMatch(importHandler, /\brequest\b/,
    'portable import must not accept any renderer-selected path or bytes');

  assert.match(
    mainSource,
    /new ServiceProjectExchange\(\{\s*projectStore:\s*serviceProjectStore,\s*songLibrary:\s*localSongLibrary,\s*sermonLibrary:\s*localSermonLibrary,/,
    'the trusted main process must inject both local content libraries into portable imports'
  );

  const importProjectStart = prepareSource.indexOf('async function importProject');
  const importProjectEnd = prepareSource.indexOf('async function exportProject', importProjectStart);
  const rendererImport = prepareSource.slice(importProjectStart, importProjectEnd);
  assert.match(rendererImport, /loadSongs\(\)/,
    'portable imports must refresh the visible local Song Library');
  assert.match(rendererImport, /loadSermons\(\)/,
    'portable imports must refresh the visible local Sermon Library');
  assert.match(rendererImport, /songImport\.conflicts/);
  assert.match(rendererImport, /imported service keeps its own pinned copy/);
  assert.match(rendererImport, /sermonImport\.conflicts/);
  assert.match(rendererImport, /imported service keeps its own exact pinned packet/);

  const writerStart = mainSource.indexOf('async function writePortableExport');
  const writerEnd = mainSource.indexOf('function prepareId', writerStart);
  const writer = mainSource.slice(writerStart, writerEnd);
  assert.match(writer, /handle\.sync\(\)/);
  assert.match(writer, /statIdentityMatches\(previous, current\)/);
  assert.match(writer, /fs\.promises\.rename\(temporaryPath, targetPath\)/);
  assert.match(writer, /fsyncDirectory\(directoryPath\)/);
});

test('native item preview pins the checked revision, renders 1920x1080, then downsamples', () => {
  const preview = assertTrustedHandler('prepare:projects:previewItem');
  assert.match(preview, /readExpectedProject\(request\)/);
  assert.match(preview, /compileServiceProject\(current\.project,/);
  assert.match(preview, /resolveAssetPath\(\s*current\.projectId,\s*current\.expectedRevisionId,/);
  assert.match(preview, /new NativeSlideRenderer\(\{\s*width:\s*CONFIG\.displayWidth,\s*height:\s*CONFIG\.displayHeight,/);
  assert.match(preview, /\.resize\(640,\s*360,/);
  assert.match(preview, /dataUrl:\s*`data:image\/jpeg;base64,/);
  assert.match(preview, /channelVariant\?\.mode === 'derive'/);
  assert.match(preview, /renderer\.renderSingerPreview\(\s*cues\[boundedOffset\],\s*channelVariant\.from,\s*cues\[boundedOffset \+ 1\] \|\| null/);
  assertNoRendererNativeInput(preview, 'prepare:projects:previewItem');

  assert.match(mainSource, /displayWidth:\s*1920/);
  assert.match(mainSource, /displayHeight:\s*1080/);

  const expectedRead = mainSource.slice(
    mainSource.indexOf('async function readExpectedProject('),
    mainSource.indexOf('function projectResult(', mainSource.indexOf('async function readExpectedProject('))
  );
  assert.match(expectedRead, /serviceProjectStore\.read\(projectId\)/);
  assert.match(expectedRead, /current\.revisionId\s*!==\s*expectedRevisionId/);
  assert.match(expectedRead, /'PROJECT_CONFLICT'/);
});

test('Prepare exposes separated song credits, semantic groups, and direct rundown reordering', () => {
  for (const id of [
    'songDocumentAuthors',
    'songDocumentTranslators',
    'songDocumentComposers'
  ]) {
    assert.match(rendererIndex, new RegExp(`id="${id}"`));
    assert.match(prepareSource, new RegExp(`byId\\('${id}'\\)`));
  }
  assert.match(rendererIndex, /Words \/ lyrics by/);
  assert.match(rendererIndex, /Translation by/);
  assert.match(rendererIndex, /Music by/);
  assert.match(prepareSource, /translators:\s*splitCommaList\(elements\.songTranslators\.value\)/);
  assert.match(prepareSource, /composers:\s*splitCommaList\(elements\.songComposers\.value\)/);

  assert.match(rendererIndex, /Add a titled separator/);
  assert.match(rendererIndex, /id="addServiceGroupKind" type="hidden" value="section"/);
  assert.match(prepareSource, /section:\s*'Section'/);
  assert.match(prepareSource, /sermon:\s*'Sermon packet'/);
  assert.match(prepareSource, /point:\s*'Sermon point'/);
  assert.match(prepareSource, /subpoint:\s*'Sermon subpoint'/);
  assert.match(
    prepareSource,
    /createElement\('span', 'prepare-item-kind', presentation\.kindLabel\)/
  );
  assert.match(prepareSource, /Exact sermon packet linked/);
  assert.match(prepareSource, /Anchor not projected/);

  assert.match(prepareSource, /listItem\.draggable = !locked/);
  assert.match(prepareSource, /moveItemRelative\(sourceItemId, row\.item\.id, placement\)/);
  assert.match(prepareSource, /Move \$\{row\.item\.title\} up/);
  assert.match(prepareSource, /Move \$\{row\.item\.title\} down/);
});

test('Prepare separates rundown titles from per-output projection fields and explains picture routing', () => {
  assert.match(rendererIndex, /Rundown title/);
  assert.match(rendererIndex, /Projected title and body on each output/);
  assert.match(rendererIndex, /Leave both fields blank to hide this item on an output/);
  assert.match(prepareSource, /titleInput\.dataset\.channelTitle/);
  assert.match(prepareSource, /textarea\.dataset\.channelText/);
  assert.match(prepareSource, /titlesByChannel:\s*titlesByChannel\.length > 0 \? titlesByChannel : undefined/);
  assert.match(prepareSource, /has a projected title but no body/);
  assert.match(prepareSource, /Show this item on at least one output by adding body text/);
  assert.match(prepareSource, /Gold emphasis/);
  assert.match(prepareSource, /Editing the body clears its emphasis so it cannot move to the wrong words/);
  assert.match(prepareSource, /textarea\.addEventListener\('input',[\s\S]*editor\.ranges = \[\][\s\S]*editor\.dirty = true/);
  assert.match(prepareSource, /spansByChannel:\s*emphasisChanged \? spansByChannel : undefined/);
  assert.match(prepareSource, /createElement\('span', 'prepare-emphasis-snippet'/,
    'emphasis snippets must be inserted as literal text, never HTML');

  assert.match(rendererIndex, /id="editServiceItemPictureOutputs"/);
  assert.match(rendererIndex, /Picture on each output/);
  assert.match(rendererIndex, /Choose replaces the picture only on that output/);
  assert.match(rendererIndex, /id="customizeServicePictureOutputs"/);
  assert.match(rendererIndex, /Set different pictures per output next/);
  assert.match(prepareSource, /item\.assetIdsByChannel\?\.\[channelId\]/);
  assert.match(prepareSource, /Output-specific picture/);
  assert.match(prepareSource, /Shared picture/);
  assert.match(prepareSource, /No picture on this output/);
  assert.match(prepareSource, /api\.updatePictureOutput\(\{/);
  assert.match(prepareSource, /action === 'choose'/);
  assert.match(prepareSource, /visibleCount <= 1/);
  assert.match(prepareSource, /Keep the picture on at least one output/);
  assert.match(prepareSource, /customizeOutputs && added[\s\S]*openEditItemDialog\(\)/);
});

test('song read, validate, and save keep trusted reads and revision checks in main', () => {
  const read = assertTrustedHandler('prepare:songs:read');
  assert.match(read, /prepareId\(request\.songId/);
  assert.match(read, /prepareRevision\(request\.revisionId/);
  assert.match(read, /localSongLibrary\.read\(songId,/);
  assertNoRendererNativeInput(read, 'prepare:songs:read');

  const validate = assertTrustedHandler('prepare:songs:validate');
  assert.match(validate, /requirePrepareRequest\(request,\s*MAX_SOURCE_BYTES\s*\+\s*64\s*\*\s*1024\)/);
  assert.match(validate, /prepareDocumentSource\(request\.documentSource\)/);
  assert.match(validate, /localSongLibrary\.validateSource\(documentSource,/);
  assert.doesNotMatch(validate, /request\.fileName\b/);
  assertNoRendererNativeInput(validate, 'prepare:songs:validate');

  const save = assertTrustedHandler('prepare:songs:save');
  assert.match(save, /prepareDocumentSource\(request\.documentSource\)/);
  assert.match(save, /prepareRevision\(request\.expectedRevisionId/);
  assert.match(save, /(?:localSongLibrary|library)\.saveSource\(documentSource,/);
  assert.match(save, /expectedRevision/);
  assert.doesNotMatch(save, /request\.fileName\b/);
  assertNoRendererNativeInput(save, 'prepare:songs:save');
});

test('per-output picture changes choose files in main and accept no renderer asset or path', () => {
  const update = assertCasMutation('prepare:projects:updatePictureOutput');
  assert.match(update, /\['choose', 'remove'\]\.includes\(action\)/);
  assert.match(update, /dialog\.showOpenDialog\(controlWindow,/);
  assert.match(update, /serviceProjectStore\.importImageAndUpdateProject\(/);
  assert.match(update, /\(project, asset\) => updatePictureChannelAsset\(project,/);
  assert.match(update, /assetId:\s*asset\.id/);
  assert.match(update, /updatePictureChannelAsset\(current\.project,/);
  assert.doesNotMatch(update, /request\.(?:assetId|sourcePath|filePath|path|altText|attribution)\b/);
});

test('item update and duplicate are narrow CAS mutations', () => {
  const update = assertCasMutation('prepare:projects:updateItem');
  assert.match(update, /prepareId\(request\.itemId/);
  assert.match(update, /prepareText\(request\.title/);
  assert.match(update, /prepareText\(request\.altText,\s*'Picture description'/);
  assert.match(update, /update(?:Group|Text|Presentation)Item\(/);
  assert.match(update, /request\.titlesByChannel/);
  assert.match(update, /titlesByChannel\s*=\s*Object\.keys\(projectedTitles\)\.length > 0 \? projectedTitles : null/);
  assert.match(update, /A projected title needs body text on the same output/);
  assert.match(update, /prepareSpansByChannel\(\s*request\.spansByChannel/);
  assert.match(update, /updateProjectItemTiming\(next,/);
  assert.match(update, /plannedDurationSeconds:\s*request\.plannedDurationSeconds/);
  assert.doesNotMatch(update, /request\.(?:childIds|variants|arrangement|resourceId)\b/);

  const spansStart = mainSource.indexOf('function prepareSpansByChannel');
  const spansEnd = mainSource.indexOf('function prepareDocumentSource', spansStart);
  const spans = mainSource.slice(spansStart, spansEnd);
  assert.match(spans, /PREPARE_MAX_EMPHASIS_SPANS/);
  assert.match(spans, /PREPARE_GOLD_EMPHASIS_FOREGROUND/);
  assert.doesNotMatch(spans, /PREPARE_GOLD_EMPHASIS_WEIGHT|weight:\s*['"]700['"]/,
    'manual Gold emphasis must inherit the normal body weight');
  assert.match(spans, /!?\['start', 'end', 'gold'\]\.includes\(key\)/);
  assert.doesNotMatch(spans, /candidate\.(?:foreground|weight|color|markup|html)/,
    'main must construct the fixed gold style instead of accepting renderer style values');

  const duplicate = assertCasMutation('prepare:projects:duplicateItem');
  assert.match(duplicate, /prepareId\(request\.itemId/);
  assert.match(duplicate, /duplicateProjectItem\(current\.project,\s*\{\s*itemId\s*\}\)/);
  assert.doesNotMatch(duplicate, /request\.(?:targetParentId|targetIndex|parentId|index)\b/);
});

test('editing a translation preserves an off-page or search-filtered original', () => {
  const start = prepareSource.indexOf('function populateSongFamilyChoices');
  const end = prepareSource.indexOf('function fillSongEditor', start);
  const source = prepareSource.slice(start, end);
  assert.match(source, /if \(selectedId && !selectedFound/);
  assert.match(source, /appendOption\(\s*elements\.songTranslationOf,\s*selectedId,/);
  assert.match(source, /preserved\.selected = true/);
});

test('song save locks before validation and persists the exact validated snapshot', () => {
  const start = prepareSource.indexOf('async function saveSongDraft');
  const end = prepareSource.indexOf('async function addSong', start);
  const source = prepareSource.slice(start, end);
  const lockIndex = source.indexOf('state.mutationBusy = true');
  const captureIndex = source.indexOf('const documentSource = currentSongDocumentSource()');
  const validationIndex = source.indexOf('await validateSongDraft({ documentSource })');

  assert.ok(lockIndex >= 0 && lockIndex < validationIndex,
    'song Save must acquire the shared mutation lock before asynchronous validation');
  assert.ok(captureIndex >= 0 && captureIndex < validationIndex,
    'song Save must capture one draft before asynchronous validation');
  assert.match(source, /setSongFormBusy\(true\)/,
    'song Save must lock every editor control while its captured snapshot is being saved');
  assert.match(source, /documentSource:\s*validation\.documentSource\s*\|\|\s*validation\.source\s*\|\|\s*documentSource/,
    'song Save must persist the canonical result from that validation, not rebuild the live form');
  assert.match(source, /finally\s*\{[\s\S]*state\.mutationBusy = false[\s\S]*setSongFormBusy\(false\)/,
    'song Save must always release both its global and editor locks');
});

test('song editor marks later edits unsaved and guards every close path', () => {
  const closeStart = prepareSource.indexOf('function closeSongEditor');
  const closeEnd = prepareSource.indexOf('async function validateSongDraft', closeStart);
  const closeSource = prepareSource.slice(closeStart, closeEnd);
  const bindingStart = prepareSource.indexOf('elements.songForm.addEventListener');
  const bindingEnd = prepareSource.indexOf("document.addEventListener('keydown'", bindingStart);
  const bindings = prepareSource.slice(bindingStart, bindingEnd);

  assert.match(closeSource, /if \(state\.songSaveBusy\) return false/);
  assert.match(closeSource, /songDraftIsDirty\(\)/);
  assert.match(closeSource, /window\.confirm\('Discard the unsaved changes in this song\?'\)/);
  assert.match(closeSource, /state\.songValidationRequest \+= 1[\s\S]*closeDialog\(/,
    'closing the editor must invalidate any in-flight Check result');
  const fillStart = prepareSource.indexOf('function fillSongEditor');
  const fillEnd = prepareSource.indexOf('async function openSongEditor', fillStart);
  assert.match(prepareSource.slice(fillStart, fillEnd), /state\.songValidationRequest \+= 1/,
    'opening a different song must invalidate any earlier Check result');
  assert.match(bindings, /songForm\.addEventListener\('input',\s*markSongDraftDirty\)/);
  assert.match(bindings, /songForm\.addEventListener\('change',\s*markSongDraftDirty\)/);
  assert.match(bindings, /btnCancelSong\.addEventListener\('click',\s*closeSongEditor\)/);
  assert.match(bindings, /songDialog\.addEventListener\('cancel'/);
  assert.match(bindings, /window\.addEventListener\('beforeunload',\s*guardSongDraftBeforeUnload\)/);
  assert.match(prepareSource, /function guardSongDraftBeforeUnload[\s\S]*songSaveBusy[\s\S]*songDraftIsDirty\(\)[\s\S]*event\.returnValue = false/,
    'closing SyncShow must wait for an active save and guard an unsaved song draft');
});

test('service-item editor saves explicitly and guards unsaved edits on every close path', () => {
  const openStart = prepareSource.indexOf('function openEditItemDialog');
  const saveStart = prepareSource.indexOf('async function saveEditedItem', openStart);
  const openSource = prepareSource.slice(openStart, saveStart);
  const closeStart = prepareSource.indexOf('function closeEditItemEditor', openStart);
  const closeSource = prepareSource.slice(closeStart, saveStart);
  const bindingStart = prepareSource.indexOf("elements.editItemForm.addEventListener('submit'");
  const bindingEnd = prepareSource.indexOf("elements.songForm.addEventListener('submit'", bindingStart);
  const bindings = prepareSource.slice(bindingStart, bindingEnd);

  assert.doesNotMatch(rendererIndex, /Changes are autosaved as a new recoverable revision/);
  assert.match(rendererIndex, /Choose Save changes when you are done/);
  assert.match(openSource, /state\.editItemBaselineSource = currentEditItemDraftSource\(\)/);
  assert.match(closeSource, /editItemDraftIsDirty\(\)/);
  assert.match(closeSource, /window\.confirm\('Discard the unsaved changes to this service item\?'\)/);
  assert.match(bindings, /editItemForm\.addEventListener\('input',\s*markEditItemDraftDirty\)/);
  assert.match(bindings, /editItemForm\.addEventListener\('change',\s*markEditItemDraftDirty\)/);
  assert.match(bindings, /btnCancelEditItem\.addEventListener\('click',\s*closeEditItemEditor\)/);
  assert.match(bindings, /editItemDialog\.addEventListener\('cancel'/);
  assert.match(
    prepareSource,
    /function guardEditItemDraftBeforeUnload[\s\S]*editItemDraftIsDirty\(\)[\s\S]*event\.returnValue = false/
  );
  assert.match(
    prepareSource,
    /window\.addEventListener\('beforeunload',\s*guardEditItemDraftBeforeUnload\)/
  );
});

test('history conflicts reopen the latest saved revision instead of leaving stale UI', () => {
  const start = prepareSource.indexOf('async function restoreHistory');
  const end = prepareSource.indexOf('function toggleSelectedGroupCollapse', start);
  const source = prepareSource.slice(start, end);

  assert.match(source, /isProjectConflict\(error,\s*message\)/);
  assert.match(source, /applyProjectResult\(await api\.openServiceProject\(\{ projectId \}\)\)/);
  assert.match(source, /loadProjectHistory\(\{ seedUndo: true \}\)/);
  assert.match(source, /The newest saved version is open now; review it and try again\./);
});

test('Prepare activation preserves a recovery warning from the project opener', () => {
  const start = prepareSource.indexOf('async function activate');
  const end = prepareSource.indexOf('function initialize', start);
  const source = prepareSource.slice(start, end);

  assert.match(
    source,
    /\['error', 'warning'\]\.includes\(elements\.notice\.dataset\.kind\)/,
    'successful activation must not overwrite a recovery or corruption warning'
  );
});
