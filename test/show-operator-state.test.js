'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const rendererIndex = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const rendererStyles = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('Show exposes an always-visible authoritative output state', () => {
  assert.match(
    rendererIndex,
    /id="showOutputState"[^>]*data-phase="idle"[^>]*role="status"[^>]*aria-live="polite"/
  );
  assert.match(rendererIndex, /id="showOutputStateTitle">Outputs idle</);
  assert.match(rendererIndex, /id="showOutputStateDetail">Start Show from Load/);
  assert.match(rendererStyles, /\.show-output-state\[data-phase="live"\]/);
  assert.match(rendererStyles, /\.show-output-state\[data-phase="cleared"\]/);
  assert.match(rendererStyles, /\.show-output-state\[data-phase="error"\]/);

  const stateStart = rendererSource.indexOf('function renderShowOutputState');
  const stateEnd = rendererSource.indexOf('function showOutputActionError', stateStart);
  const stateSource = rendererSource.slice(stateStart, stateEnd);
  assert.match(stateSource, /live:[\s\S]*Outputs live/);
  assert.match(stateSource, /cleared:[\s\S]*Outputs black/);
  assert.match(stateSource, /hidden:[\s\S]*Outputs stopped/);
  assert.match(stateSource, /interrupted:[\s\S]*Outputs interrupted/);
  assert.match(rendererSource, /handleShowStateChanged[\s\S]*renderShowOutputState\(next\)/);
});

test('every local live-output action reports rejection to the operator', () => {
  for (const [functionName, actionCopy] of [
    ['showDisplays', 'Could not restore the outputs'],
    ['clearDisplays', 'Could not clear the outputs'],
    ['stopDisplays', 'Could not stop the outputs'],
    ['backToSetup', 'Could not return to Load safely'],
    ['navigateSlide', 'Could not change slides'],
    ['goToSlide', 'Could not change slides']
  ]) {
    const start = rendererSource.indexOf(`async function ${functionName}`);
    assert.notEqual(start, -1, `${functionName} must exist`);
    const nextFunction = rendererSource.indexOf('\nasync function ', start + 1);
    const fallbackNext = rendererSource.indexOf('\nfunction ', start + 1);
    const candidates = [nextFunction, fallbackNext].filter(index => index > start);
    const end = candidates.length > 0 ? Math.min(...candidates) : rendererSource.length;
    const source = rendererSource.slice(start, end);
    assert.match(source, /catch \(error\)/, `${functionName} must catch rejected live actions`);
    assert.match(
      source,
      new RegExp(`showOutputActionError\\('${actionCopy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `${functionName} must surface its failure`
    );
  }
  assert.match(
    rendererSource,
    /function showOutputActionError[\s\S]*dataset\.phase = 'error'[\s\S]*setStatus\(/
  );
});

test('local cue navigation is acknowledged, relative, and returns authoritative state', () => {
  assert.match(preloadSource, /navigateToSlide: \(slideIndex\) => ipcRenderer\.invoke\('show:navigateTo', slideIndex\)/);
  assert.match(preloadSource, /nextSlide: \(\) => ipcRenderer\.invoke\('show:navigateBy', 1\)/);
  assert.match(preloadSource, /prevSlide: \(\) => ipcRenderer\.invoke\('show:navigateBy', -1\)/);
  assert.doesNotMatch(preloadSource, /ipcRenderer\.send\('slide:(?:navigate|next|prev)'/);
  assert.doesNotMatch(mainSource, /ipcMain\.on\('slide:(?:navigate|next|prev)'/);

  for (const channel of ['show:navigateTo', 'show:navigateBy']) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, `${channel} must exist`);
    const end = mainSource.indexOf("ipcMain.handle('", start + 20);
    const source = mainSource.slice(start, end === -1 ? mainSource.length : end);
    assert.match(source, /requireControlSender\(event\)/);
    assert.match(source, /accepted === false[\s\S]*failMainOperation/);
    assert.match(source, /showState: showGateway\.getState\(\)/);
  }

  const relativeStart = rendererSource.indexOf('async function navigateSlide');
  const relativeEnd = rendererSource.indexOf('async function goToSlide', relativeStart);
  const relativeSource = rendererSource.slice(relativeStart, relativeEnd);
  assert.match(relativeSource, /window\.api\.prevSlide\(\)/);
  assert.match(relativeSource, /window\.api\.nextSlide\(\)/);
  assert.doesNotMatch(relativeSource, /state\.currentSlide \+ delta/);

  const relativeHandlerStart = mainSource.indexOf("ipcMain.handle('show:navigateBy'");
  const relativeHandlerEnd = mainSource.indexOf("ipcMain.handle('", relativeHandlerStart + 20);
  const relativeHandler = mainSource.slice(relativeHandlerStart, relativeHandlerEnd);
  assert.match(
    relativeHandler,
    /AT_FIRST_CUE' \|\| result\?\.code === 'AT_LAST_CUE'[\s\S]*applied: false/
  );
});

test('older Show action completions cannot overwrite a newer authoritative result', () => {
  assert.match(rendererSource, /showActionRequest: 0/);
  assert.match(
    rendererSource,
    /function beginShowOutputAction[\s\S]*state\.showActionRequest \+= 1/
  );
  assert.match(
    rendererSource,
    /function applyShowOutputActionResult[\s\S]*action\.id === state\.showActionRequest && stateApplied/
  );
  assert.match(
    rendererSource,
    /function showOutputActionCanReportError[\s\S]*currentRevision <= action\.revision/
  );
  assert.match(
    rendererSource,
    /function handleShowStateChanged[\s\S]*next\.revision < state\.showState\.revision\) return false[\s\S]*return true/
  );
});
