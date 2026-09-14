'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const evidence = process.env.SYNCSHOW_TRANSLATION_EVIDENCE;
const phase = process.env.SYNCSHOW_TRANSLATION_PHASE;
require('../../main');
app.whenReady().then(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    let win;
    for (let attempt = 0; attempt < 100; attempt++) {
      win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'));
      if (win && !win.webContents.isLoading()) break;
      await pause(100);
    }
    assert.ok(win);
    await pause(250);
    const state = await win.webContents.executeJavaScript('window.api.getTranslationState()');
    assert.equal(state.success, true);
    assert.ok(state.data.outputs.length > 0);
    const id = state.data.outputs[0].id;
    if (phase === 'write') {
      const configured = await win.webContents.executeJavaScript(`window.api.configureTranslationOutput(${JSON.stringify({ outputId: id, settings: { language: 'ru', layout: 'ticker', fontScale: 1.25 } })})`);
      assert.equal(configured.success, true);
      const manual = await win.webContents.executeJavaScript(`window.api.overrideTranslationOutput(${JSON.stringify({ outputId: id, text: 'Тест настройки экрана' })})`);
      assert.equal(manual.success, true);
      assert.equal(manual.data.outputs[0].phrases[0].text, 'Тест настройки экрана');
      const invalid = await win.webContents.executeJavaScript(`window.api.configureTranslationOutput(${JSON.stringify({ outputId: 'unconfigured-screen', settings: { layout: 'full-screen' } })})`);
      assert.equal(invalid.success, false);
    } else {
      assert.equal(state.data.outputs[0].language, 'ru');
      assert.equal(state.data.outputs[0].layout, 'ticker');
      assert.equal(state.data.outputs[0].fontScale, 1.25);
      assert.equal(state.data.outputs[0].manual, false, 'manual captions do not persist after restart');
    }
    await win.webContents.executeJavaScript("document.querySelector('[data-open-translation]').click()");
    await pause(400);
    const ui = await win.webContents.executeJavaScript(`({ open: document.getElementById('translationDialog').open,
      rows: document.querySelectorAll('.translation-row').length,
      language: document.querySelector('.translation-row [data-field="language"]').value,
      error: document.getElementById('translationError').textContent })`);
    assert.equal(ui.open, true); assert.equal(ui.rows, state.data.outputs.length); assert.equal(ui.language, 'ru');
    assert.match(ui.error, /Connect Heritage Community/);
    fs.writeFileSync(path.join(evidence, `controls-${phase}.png`), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(evidence, `controls-${phase}.json`), JSON.stringify({ passed: true, phase, ui }, null, 2));
    console.log(JSON.stringify({ passed: true, phase, ui }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
