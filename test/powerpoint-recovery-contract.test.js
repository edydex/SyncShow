'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs
  .readFileSync(path.join(root, relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

const mainSource = read('main.js');
const converterSource = read('src/services/converter/Converter.js');
const preloadSource = read('preload.js');
const powerPointSource = read(
  'src/services/converter/strategies/PowerPointStrategy.js'
);
const rendererSource = read('src/renderer/app.js');

test('conversion IPC returns a structured failure after all fallback attempts', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('pptx:convert'");
  const handlerEnd = mainSource.indexOf(
    "ipcMain.handle('slides:getList'",
    handlerStart
  );
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /try \{[\s\S]*await new Promise\(/);
  assert.match(handler, /catch \(error\) \{\s*return serializeConversionFailure\(error\)/);
  assert.match(
    converterSource,
    /error\.code = 'PRESENTATION_CONVERSION_FALLBACK_FAILED'/
  );
  assert.match(converterSource, /error\.powerPointError = powerPointError/);
});

test('both PowerPoint process guards preserve the retry classification', () => {
  assert.match(
    powerPointSource,
    /detail\.includes\(POWERPOINT_IN_USE_MARKER\)[\s\S]*detail\.includes\(POWERPOINT_OWNERSHIP_UNCERTAIN_MARKER\)/
  );
  assert.match(
    powerPointSource,
    /if \(powerPointInUse\) \{\s*conversionError\.code = POWERPOINT_IN_USE_CODE/
  );
});

test('Load shows a role-local exact retry and never asks main to close PowerPoint', () => {
  assert.match(rendererSource, /'I closed PowerPoint — retry'/);
  assert.match(
    rendererSource,
    /state\.presentationConversionRecovery\[language\][\s\S]*filePath[\s\S]*options/
  );
  assert.match(
    rendererSource,
    /return loadPresentationFile\(language, request\.filePath, request\.options\)/
  );
  assert.match(
    rendererSource,
    /normalizePresentationConversionFailure\([\s\S]*conversionError\.recoveryAction/
  );
  assert.doesNotMatch(rendererSource, /closePowerPoint|killPowerPoint|taskkill/i);
  assert.match(
    preloadSource,
    /convertPptx:[\s\S]*ipcRenderer\.invoke\('pptx:convert'/
  );
  assert.doesNotMatch(preloadSource, /closePowerPoint|killPowerPoint|taskkill/i);
});

test('a successful role retry clears only that service-set conversion failure', () => {
  assert.match(
    rendererSource,
    /conversionFailedRoleIds:\s*\[\]/
  );
  assert.match(
    rendererSource,
    /state\.serviceFolder\.conversionFailedRoleIds[\s\S]*\.filter\(roleId => roleId !== language\)[\s\S]*refreshServiceFolderConversionError\(\)/
  );
  assert.match(
    rendererSource,
    /source === 'folder'[\s\S]*new Set\(\[[\s\S]*language[\s\S]*refreshServiceFolderConversionError\(\)/
  );
  assert.match(
    rendererSource,
    /function serviceFolderErrorMessage\(\)[\s\S]*conversionError/
  );
  assert.match(
    rendererSource,
    /humanizeIpcError\([\s\S]*'The presentation could not be converted\.'/
  );
});
