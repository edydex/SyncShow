'use strict';

// Electron-only entrypoint; keep this outside Node's automatic test discovery.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain
} = require('electron');

const {
  ShowPackagePublisher
} = require('../../src/services/project');
const {
  SHOW_REHEARSAL_RECEIPT_KIND,
  SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
  ShowRehearsalReceiptStore,
  normalizeShowRehearsalEvidence,
  resolveNativeCuePayload,
  resolveLaunchPlan,
  showRehearsalReceiptMatches
} = require('../../src/services/show');
const {
  configureIsolatedTestUserData
} = require('../../src/services/runtime/IsolatedTestUserData');
const {
  CONDENSED_SERMON_TEXT,
  SERMON_READING_OUTPUTS,
  createTrackedNativeWeeklyService
} = require('../../test/fixtures/native-weekly-service');
const packageJson = require('../../package.json');

const RESULT_PATH_ENV = 'SYNCSHOW_ELECTRON_REHEARSAL_RESULT';
const WIDTH_ENV = 'SYNCSHOW_ELECTRON_REHEARSAL_WIDTH';
const HEIGHT_ENV = 'SYNCSHOW_ELECTRON_REHEARSAL_HEIGHT';
const ROUTE_ENV = 'SYNCSHOW_ELECTRON_REHEARSAL_ROUTE';
const ROUTES = new Set(['direct', 'derived-singer']);
const DERIVED_SINGER_NEXT = Object.freeze([
  Object.freeze({
    state: 'text',
    text: 'Церковь возносит хвалу Христу'
  }),
  Object.freeze({
    state: 'text',
    text: 'Слава Христу во веки'
  }),
  Object.freeze({
    state: 'text',
    text: 'Добро пожаловать'
  }),
  Object.freeze({ state: 'blank', text: '' }),
  Object.freeze({
    state: 'text',
    text: '10 His purpose was that now, through the church, the manifold wisdom of God should be made known to the rulers and authorities in the heavenly realms,'
  }),
  Object.freeze({
    state: 'text',
    text: 'Церковь показывает Божью мудрость.'
  }),
  Object.freeze({
    state: 'text',
    text: 'Во Христе мы с дерзновением приходим к Богу.'
  }),
  Object.freeze({ state: 'blank', text: '' }),
  Object.freeze({ state: 'end', text: '' })
]);
const BSB_READING_BODY = [
  '10 His purpose was that now, through the church, the manifold wisdom of God should be made known to the rulers and authorities in the heavenly realms,',
  '11 according to the eternal purpose that He accomplished in Christ Jesus our Lord.',
  '12 In Him and through faith in Him we may enter God’s presence with boldness and confidence.'
].join('\n');
const LSV_READING_BODY = [
  '10 that there might be made known now to the principalities and the authorities in the heavenly [places], through the Assembly, the manifold wisdom of God,',
  '11 according to a purpose of the ages, which He made in Christ Jesus our Lord,',
  '12 in whom we have the freedom and the access in confidence through the faith of Him,'
].join('\n');
const BSB_READING_SHA256 =
  '96f81e43fa93a52726a565f8f26856ea99d0893d369beefbbe38ef3811273f08';
const LSV_READING_SHA256 =
  'a6b5b9fb98bfdeca7987e07fecb19dcba80092271e484e61b7021d24da642fb1';
const PRIMARY_SERMON_SOURCE_TEXT =
  'Церковь показывает Божью мудрость.';
const PUBLISH_NOW = '2026-08-09T17:00:00.000Z';
const FRAME_TIMEOUT_MS = 20_000;
const FONT_PATH = path.resolve(
  __dirname,
  '../../assets/fonts/NotoSans-Variable.ttf'
);
const DISPLAY_PAGE = path.resolve(
  __dirname,
  '../../src/renderer/display.html'
);
const PRELOAD_PATH = path.resolve(__dirname, '../../preload.js');

const isolation = configureIsolatedTestUserData({ app });

function resolutionDimension(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

const WINDOW_WIDTH = resolutionDimension(WIDTH_ENV, 1920, 640, 3840);
const WINDOW_HEIGHT = resolutionDimension(HEIGHT_ENV, 1080, 360, 2160);
if (WINDOW_WIDTH * WINDOW_HEIGHT > 3840 * 2160) {
  throw new Error('The Electron rehearsal resolution exceeds the native pixel limit.');
}
const ROUTE = process.env[ROUTE_ENV] || 'direct';
if (!ROUTES.has(ROUTE)) {
  throw new Error(`${ROUTE_ENV} must be direct or derived-singer.`);
}

function resultContract() {
  return ROUTE === 'derived-singer'
    ? 'syncshow-native-weekly-real-electron-derived-singer-rehearsal-v2'
    : 'syncshow-native-weekly-real-electron-rehearsal-v2';
}

function launchDecisions() {
  return ROUTE === 'derived-singer'
    ? {
        'singers-monitor': {
          mode: 'derive-next-text',
          sourceRole: 'front'
        }
      }
    : {};
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableJsonValue(value[key])])
  );
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJsonValue(value)))
    .digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function launchOutputs() {
  return [
    {
      id: 'front-projector',
      name: 'Front projector',
      kind: 'normal',
      displayId: 'hidden-browser-window-front',
      expectedRole: 'front',
      operatorPreview: false
    },
    {
      id: 'translation-projector',
      name: 'Translation projector',
      kind: 'normal',
      displayId: 'hidden-browser-window-translation',
      expectedRole: 'translation',
      operatorPreview: false
    },
    {
      id: 'singers-monitor',
      name: 'Singers monitor',
      kind: 'singer',
      displayId: 'hidden-browser-window-singers',
      expectedRole: 'singers',
      operatorPreview: true
    }
  ];
}

function roleMapping() {
  return {
    front: 'primary',
    translation: 'secondary',
    singers: 'media'
  };
}

function readingTreatmentForRole(outputs, roleId) {
  const channelId = roleMapping()[roleId];
  const treatment = outputs.find(output => output.channelId === channelId);
  assert.ok(treatment, `reading treatment for ${roleId} must exist`);
  return treatment;
}

function confinedResultPath() {
  const resultPath = process.env[RESULT_PATH_ENV];
  if (typeof resultPath !== 'string' || !path.isAbsolute(resultPath)) {
    throw new Error('The Electron rehearsal result path is unavailable.');
  }
  const profilePath = fs.realpathSync(app.getPath('userData'));
  const resultParent = fs.realpathSync(path.dirname(resultPath));
  if (
    resultParent !== profilePath
    || path.basename(resultPath) !== 'native-weekly-electron-rehearsal.json'
  ) {
    throw new Error('The Electron rehearsal result path escaped its isolated profile.');
  }
  return resultPath;
}

async function writeResult(payload) {
  const resultPath = confinedResultPath();
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify(payload)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    }
  );
}

function waitForFrame(win, outputId, cueIndex) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener('output:frameReady', onFrame);
      win.removeListener('closed', onClosed);
      win.webContents.removeListener('render-process-gone', onGone);
      callback(value);
    };
    const onFrame = (event, payload = {}) => {
      if (
        event.sender !== win.webContents
        || payload?.index !== cueIndex
      ) {
        return;
      }
      if (payload.ok === true && payload.kind === 'native-cue') {
        finish(resolve, {
          outputId,
          cueIndex,
          kind: payload.kind
        });
        return;
      }
      if (payload.ok === false) {
        finish(
          reject,
          new Error(
            `${outputId} rejected cue ${cueIndex + 1}: `
            + `${payload.error || 'unknown renderer error'}`
          )
        );
      }
    };
    const onClosed = () => {
      finish(
        reject,
        new Error(`${outputId} closed before cue ${cueIndex + 1} acknowledged.`)
      );
    };
    const onGone = (_event, details) => {
      finish(
        reject,
        new Error(
          `${outputId} renderer exited before cue ${cueIndex + 1} `
          + `acknowledged (${details?.reason || 'unknown'}).`
        )
      );
    };
    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(
          `${outputId} did not acknowledge cue ${cueIndex + 1} `
          + `within ${FRAME_TIMEOUT_MS / 1000} seconds.`
        )
      );
    }, FRAME_TIMEOUT_MS);

    ipcMain.on('output:frameReady', onFrame);
    win.once('closed', onClosed);
    win.webContents.once('render-process-gone', onGone);
  });
}

function waitForRejectedFrame(win, outputId, cueIndex) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener('output:frameReady', onFrame);
      win.removeListener('closed', onClosed);
      win.webContents.removeListener('render-process-gone', onGone);
      callback(value);
    };
    const onFrame = (event, payload = {}) => {
      if (event.sender !== win.webContents || payload?.index !== cueIndex) return;
      if (payload.ok === false && payload.kind === 'native-cue') {
        finish(resolve, {
          outputId,
          cueIndex,
          kind: payload.kind,
          error: payload.error || ''
        });
        return;
      }
      finish(
        reject,
        new Error(`${outputId} unexpectedly accepted overflow cue ${cueIndex}.`)
      );
    };
    const onClosed = () => {
      finish(
        reject,
        new Error(`${outputId} closed before rejecting overflow cue ${cueIndex}.`)
      );
    };
    const onGone = (_event, details) => {
      finish(
        reject,
        new Error(
          `${outputId} renderer exited before rejecting overflow cue ${cueIndex} `
          + `(${details?.reason || 'unknown'}).`
        )
      );
    };
    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(
          `${outputId} did not reject overflow cue ${cueIndex} `
          + `within ${FRAME_TIMEOUT_MS / 1000} seconds.`
        )
      );
    }, FRAME_TIMEOUT_MS);

    ipcMain.on('output:frameReady', onFrame);
    win.once('closed', onClosed);
    win.webContents.once('render-process-gone', onGone);
  });
}

function scenePayload(entry, cueIndex) {
  const payload = resolveNativeCuePayload({
    presentation: entry.presentation,
    cueIndex,
    variant: entry.output.nativeVariant || null
  });
  assert.ok(payload, `native scene ${cueIndex + 1} must resolve exactly`);
  assert.deepEqual(payload.scene.canvas, {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT
  });
  return payload;
}

async function createHiddenOutput(output, presentation) {
  assert.equal(presentation.renderer, 'native-cue');
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    backgroundColor: '#000000',
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: PRELOAD_PATH,
      backgroundThrottling: false
    }
  });
  win.setIgnoreMouseEvents(true);
  await win.loadFile(DISPLAY_PAGE);
  assert.equal(win.isVisible(), false);
  assert.equal(win.isFullScreen(), false);

  const rendererContract = await win.webContents.executeJavaScript(`(() => ({
    readyState: document.readyState,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    hasNativeRenderer: typeof window.SyncShowNativeCueRenderer?.buildScene === 'function',
    hasFrameBridge: typeof window.api?.reportOutputFrameReady === 'function',
    nativeLayerCount: document.querySelectorAll('.native-cue-layer').length
  }))()`);
  assert.equal(rendererContract.readyState, 'complete');
  assert.equal(rendererContract.viewportWidth, WINDOW_WIDTH);
  assert.equal(rendererContract.viewportHeight, WINDOW_HEIGHT);
  assert.equal(rendererContract.hasNativeRenderer, true);
  assert.equal(rendererContract.hasFrameBridge, true);
  assert.equal(rendererContract.nativeLayerCount, 2);

  win.webContents.send('display:init', {
    language: output.id,
    outputId: output.id,
    outputName: output.name,
    sourceRoleId: output.sourceRoleId,
    renderer: 'native-cue',
    displayId: output.displayId,
    fadeDuration: 0,
    syncMode: false,
    fontPath: FONT_PATH
  });

  return {
    output,
    presentation,
    rendererContract,
    win
  };
}

async function captureRenderedFrame(entry, cueIndex) {
  const surface = await entry.win.webContents.executeJavaScript(`(() => {
    const active = [...document.querySelectorAll('.native-cue-layer')]
      .find(layer => layer.classList.contains('active'));
    const noSlide = document.getElementById('noSlide');
    return {
      activeLayer: active?.id || null,
      childCount: active?.childElementCount || 0,
      textLength: active?.textContent?.length || 0,
      noSlideVisible: noSlide?.style?.display !== 'none'
    };
  })()`);
  assert.match(surface.activeLayer || '', /^native-layer-[01]$/);
  assert.equal(surface.childCount, 1);
  assert.equal(surface.noSlideVisible, false);

  const image = await entry.win.webContents.capturePage();
  const png = image.toPNG();
  const size = image.getSize();
  assert.equal(Buffer.isBuffer(png), true);
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(png.length > 500);
  assert.ok(size.width >= WINDOW_WIDTH);
  assert.ok(size.height >= WINDOW_HEIGHT);

  return {
    outputId: entry.output.id,
    cueIndex,
    pngBytes: png.length,
    pngSha256: sha256Buffer(png),
    width: size.width,
    height: size.height,
    textLength: surface.textLength
  };
}

function containsRectangle(outer, inner, tolerance = 2) {
  return inner.left >= outer.left - tolerance
    && inner.top >= outer.top - tolerance
    && inner.right <= outer.right + tolerance
    && inner.bottom <= outer.bottom + tolerance;
}

async function inspectRenderedDerivedSingerFrame(entry, cueIndex, scene) {
  const current = entry.presentation.scenes[cueIndex];
  const expectedNext = DERIVED_SINGER_NEXT[cueIndex];
  assert.equal(entry.output.id, 'singers-monitor');
  assert.equal(entry.output.sourceRoleId, 'front');
  assert.equal(entry.output.nativeVariant, 'singer-current-next');
  assert.equal(scene.layout, 'singer-current-next');
  assert.deepEqual(scene.current, current);
  assert.deepEqual(scene.next, expectedNext);

  const metrics = await entry.win.webContents.executeJavaScript(`(() => {
    const active = [...document.querySelectorAll('.native-cue-layer')]
      .find(layer => layer.classList.contains('active'));
    const outerHost = active?.querySelector(':scope > .native-scene-host');
    const outer = outerHost?.querySelector(':scope > .native-scene-surface');
    const currentRegion = outer?.querySelector(':scope > .native-singer-current');
    const next = outer?.querySelector(':scope > .native-singer-next');
    const currentHost = currentRegion?.querySelector(':scope > .native-scene-host');
    const currentSurface =
      currentHost?.querySelector(':scope > .native-scene-surface');
    const currentTitle = currentSurface?.querySelector('.native-scene-title');
    const currentBody = currentSurface?.querySelector('.native-scene-body');
    const rectangle = element => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height
      } : null;
    };
    const picture = currentSurface?.querySelector('.native-scene-picture');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      outerClass: outer?.className || '',
      currentClass: currentSurface?.className || '',
      currentChildCount: currentSurface?.childElementCount ?? -1,
      currentTitle: currentTitle?.textContent || '',
      currentBody: currentBody?.textContent || '',
      currentTitleScrollWidth: currentTitle?.scrollWidth || 0,
      currentTitleClientWidth: currentTitle?.clientWidth || 0,
      currentTitleScrollHeight: currentTitle?.scrollHeight || 0,
      currentTitleClientHeight: currentTitle?.clientHeight || 0,
      currentBodyScrollWidth: currentBody?.scrollWidth || 0,
      currentBodyClientWidth: currentBody?.clientWidth || 0,
      currentBodyScrollHeight: currentBody?.scrollHeight || 0,
      currentBodyClientHeight: currentBody?.clientHeight || 0,
      currentSongTitle:
        currentSurface?.querySelector('.native-song-title-text')?.textContent || '',
      currentPictureComplete: picture?.complete === true,
      currentPictureWidth: picture?.naturalWidth || 0,
      nextText: next?.textContent ?? null,
      nextState: next?.dataset.nextState || null,
      nextClasses: next ? [...next.classList] : [],
      nextScrollWidth: next?.scrollWidth || 0,
      nextClientWidth: next?.clientWidth || 0,
      nextScrollHeight: next?.scrollHeight || 0,
      nextClientHeight: next?.clientHeight || 0,
      outer: rectangle(outer),
      currentRegion: rectangle(currentRegion),
      currentSurface: rectangle(currentSurface),
      next: rectangle(next)
    };
  })()`);

  assert.deepEqual(metrics.viewport, {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT
  });
  assert.match(metrics.outerClass, /\bnative-scene-singer-current-next\b/);
  assert.match(
    metrics.currentClass,
    new RegExp(`\\bnative-scene-${current.layout}\\b`)
  );
  assert.equal(metrics.nextState, expectedNext.state);
  assert.equal(
    metrics.nextText,
    expectedNext.state === 'end' ? 'End of presentation' : expectedNext.text
  );
  assert.equal(metrics.nextClasses.includes('native-singer-next'), true);
  assert.deepEqual(
    metrics.nextClasses.filter(className =>
      ['native-singer-text', 'native-singer-blank', 'native-singer-end']
        .includes(className)),
    [`native-singer-${expectedNext.state}`]
  );
  assert.ok(metrics.nextScrollWidth <= metrics.nextClientWidth + 2);
  assert.ok(metrics.nextScrollHeight <= metrics.nextClientHeight + 2);
  assert.ok(containsRectangle(
    {
      left: 0,
      top: 0,
      right: WINDOW_WIDTH,
      bottom: WINDOW_HEIGHT
    },
    metrics.outer
  ));
  assert.ok(containsRectangle(metrics.outer, metrics.currentRegion));
  assert.ok(containsRectangle(metrics.outer, metrics.next));
  assert.ok(containsRectangle(metrics.currentRegion, metrics.currentSurface));
  assert.ok(metrics.currentRegion.bottom <= metrics.next.top + 2);

  if (current.layout === 'text') {
    assert.equal(metrics.currentTitle, current.title);
    assert.equal(metrics.currentBody, current.body);
    assert.ok(
      metrics.currentTitleScrollWidth <= metrics.currentTitleClientWidth + 2
    );
    assert.ok(
      metrics.currentTitleScrollHeight <= metrics.currentTitleClientHeight + 2
    );
    assert.ok(
      metrics.currentBodyScrollWidth <= metrics.currentBodyClientWidth + 2
    );
    assert.ok(
      metrics.currentBodyScrollHeight <= metrics.currentBodyClientHeight + 2
    );
  } else if (current.layout === 'song-title') {
    assert.equal(metrics.currentSongTitle, current.title);
  } else if (current.layout === 'picture') {
    assert.equal(metrics.currentPictureComplete, true);
    assert.ok(metrics.currentPictureWidth > 0);
  } else if (current.layout === 'blank') {
    assert.equal(metrics.currentChildCount, 0);
  } else {
    assert.fail(`Unexpected derived Singer current layout ${current.layout}.`);
  }

  return {
    outputId: entry.output.id,
    cueIndex,
    currentLayout: current.layout,
    next: expectedNext,
    nextClass: `native-singer-${expectedNext.state}`
  };
}

async function inspectRenderedBibleFrame(entry, cueIndex, treatment) {
  const expected = entry.presentation.scenes[cueIndex];
  assert.equal(expected.sourceKind, 'bible');
  assert.ok(treatment);
  if (treatment.mode === 'hidden') {
    assert.equal(expected.layout, 'blank');
    const metrics = await entry.win.webContents.executeJavaScript(`(() => {
      const active = [...document.querySelectorAll('.native-cue-layer')]
        .find(layer => layer.classList.contains('active'));
      const surface = active?.querySelector('.native-scene-surface');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        surfaceClass: surface?.className || '',
        childCount: surface?.childElementCount ?? -1,
        text: surface?.textContent || ''
      };
    })()`);
    assert.deepEqual(metrics.viewport, {
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT
    });
    assert.match(metrics.surfaceClass, /\bnative-scene-blank\b/);
    assert.equal(metrics.childCount, 0);
    assert.equal(metrics.text, '');
    return {
      outputId: entry.output.id,
      cueIndex,
      mode: 'hidden',
      translationId: null,
      layout: expected.layout,
      bodyText: '',
      bodySha256: null
    };
  }

  assert.equal(treatment.mode, 'translation');
  assert.equal(expected.layout, 'text');
  const metrics = await entry.win.webContents.executeJavaScript(`(() => {
    const active = [...document.querySelectorAll('.native-cue-layer')]
      .find(layer => layer.classList.contains('active'));
    const surface = active?.querySelector('.native-scene-surface');
    const title = active?.querySelector('.native-scene-title');
    const bodyRegion = active?.querySelector('.native-scene-body-region');
    const body = active?.querySelector('.native-scene-body');
    const rectangle = element => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height
      } : null;
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      titleText: title?.textContent || '',
      bodyText: body?.textContent || '',
      bodyFontSize: Number.parseFloat(getComputedStyle(body).fontSize),
      titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
      titleScrollWidth: title?.scrollWidth || 0,
      titleClientWidth: title?.clientWidth || 0,
      titleScrollHeight: title?.scrollHeight || 0,
      titleClientHeight: title?.clientHeight || 0,
      bodyScrollWidth: body?.scrollWidth || 0,
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollHeight: body?.scrollHeight || 0,
      bodyClientHeight: body?.clientHeight || 0,
      surface: rectangle(surface),
      title: rectangle(title),
      bodyRegion: rectangle(bodyRegion),
      body: rectangle(body)
    };
  })()`);

  assert.deepEqual(metrics.viewport, {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT
  });
  assert.equal(metrics.titleText, expected.title);
  assert.equal(metrics.bodyText, expected.body);
  assert.ok(
    metrics.titleScrollWidth <= metrics.titleClientWidth + 2,
    `${entry.output.id} Bible title width overflow: ${JSON.stringify(metrics)}`
  );
  assert.ok(
    metrics.titleScrollHeight <= metrics.titleClientHeight + 2,
    `${entry.output.id} Bible title height overflow: ${JSON.stringify(metrics)}`
  );
  assert.ok(
    metrics.bodyScrollWidth <= metrics.bodyClientWidth + 2,
    `${entry.output.id} Bible body width overflow: ${JSON.stringify(metrics)}`
  );
  assert.ok(
    metrics.bodyScrollHeight <= metrics.bodyClientHeight + 2,
    `${entry.output.id} Bible body height overflow: ${JSON.stringify(metrics)}`
  );
  assert.ok(containsRectangle(
    {
      left: 0,
      top: 0,
      right: WINDOW_WIDTH,
      bottom: WINDOW_HEIGHT
    },
    metrics.surface
  ));
  assert.ok(containsRectangle(metrics.surface, metrics.title));
  assert.ok(containsRectangle(metrics.surface, metrics.bodyRegion));
  assert.ok(containsRectangle(metrics.bodyRegion, metrics.body));

  const resolutionScale = Math.min(
    1,
    WINDOW_WIDTH / 1920,
    WINDOW_HEIGHT / 1080
  );
  const expectedBodyMinimum = Math.max(
    14,
    Math.round(expected.style.bodyMinimumSize * resolutionScale)
  );
  const expectedTitleMinimum = Math.max(
    14,
    Math.round(expected.style.titleMinimumSize * resolutionScale)
  );
  assert.ok(Number.isFinite(metrics.bodyFontSize));
  assert.ok(Number.isFinite(metrics.titleFontSize));
  assert.ok(metrics.bodyFontSize >= expectedBodyMinimum - 0.25);
  assert.ok(metrics.bodyFontSize <= expected.style.bodySize + 0.25);
  assert.ok(metrics.titleFontSize >= expectedTitleMinimum - 0.25);
  assert.ok(metrics.titleFontSize <= expected.style.titleSize + 0.25);

  return {
    outputId: entry.output.id,
    cueIndex,
    mode: treatment.mode,
    translationId: treatment.translationId,
    layout: expected.layout,
    title: expected.title,
    bodyText: expected.body,
    bodySha256: sha256Buffer(Buffer.from(expected.body, 'utf8')),
    bodyFontSize: metrics.bodyFontSize,
    titleFontSize: metrics.titleFontSize,
    bodyScrollWidth: metrics.bodyScrollWidth,
    bodyClientWidth: metrics.bodyClientWidth,
    bodyScrollHeight: metrics.bodyScrollHeight,
    bodyClientHeight: metrics.bodyClientHeight
  };
}

async function inspectRenderedSermonFrame(entry, cueIndex, treatment) {
  const expected = entry.presentation.scenes[cueIndex];
  assert.equal(expected.sourceKind, 'sermon');
  assert.ok(treatment);
  if (treatment.mode === 'hidden') {
    assert.equal(expected.layout, 'blank');
    const metrics = await entry.win.webContents.executeJavaScript(`(() => {
      const active = [...document.querySelectorAll('.native-cue-layer')]
        .find(layer => layer.classList.contains('active'));
      const surface = active?.querySelector('.native-scene-surface');
      return {
        surfaceClass: surface?.className || '',
        childCount: surface?.childElementCount ?? -1,
        text: surface?.textContent || ''
      };
    })()`);
    assert.match(metrics.surfaceClass, /\bnative-scene-blank\b/);
    assert.equal(metrics.childCount, 0);
    assert.equal(metrics.text, '');
    return {
      outputId: entry.output.id,
      cueIndex,
      mode: 'hidden',
      layout: expected.layout,
      bodyText: '',
      bodySha256: null
    };
  }

  assert.equal(expected.layout, 'text');
  assert.equal(expected.body, treatment.text);
  const metrics = await entry.win.webContents.executeJavaScript(`(() => {
    const active = [...document.querySelectorAll('.native-cue-layer')]
      .find(layer => layer.classList.contains('active'));
    const body = active?.querySelector('.native-scene-body');
    return {
      bodyText: body?.textContent || '',
      bodyScrollWidth: body?.scrollWidth || 0,
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollHeight: body?.scrollHeight || 0,
      bodyClientHeight: body?.clientHeight || 0
    };
  })()`);
  assert.equal(metrics.bodyText, treatment.text);
  assert.ok(metrics.bodyScrollWidth <= metrics.bodyClientWidth + 2);
  assert.ok(metrics.bodyScrollHeight <= metrics.bodyClientHeight + 2);
  return {
    outputId: entry.output.id,
    cueIndex,
    mode: treatment.mode,
    layout: expected.layout,
    bodyText: metrics.bodyText,
    bodySha256: sha256Buffer(Buffer.from(metrics.bodyText, 'utf8'))
  };
}

function sermonTreatmentForRole(roleId) {
  if (roleId === 'front') {
    return {
      mode: 'exact',
      text: PRIMARY_SERMON_SOURCE_TEXT
    };
  }
  if (roleId === 'translation') {
    return {
      mode: 'condensed',
      text: CONDENSED_SERMON_TEXT
    };
  }
  return { mode: 'hidden' };
}

async function runOverflowProbe(entry, sourceScene) {
  const cueIndex = 9001;
  const overflowBody = 'Overflow '.repeat(1300).trim();
  assert.ok(overflowBody.length < 12000);
  const overflowScene = {
    ...sourceScene,
    body: overflowBody,
    bodySpans: []
  };
  const pending = waitForRejectedFrame(
    entry.win,
    entry.output.id,
    cueIndex
  );
  entry.win.webContents.send('native-cue:goto', {
    index: cueIndex,
    timestamp: Date.now(),
    revealAt: Date.now(),
    syncMode: false,
    outputId: entry.output.id,
    sourceRoleId: entry.output.sourceRoleId,
    scene: overflowScene,
    assetPaths: {}
  });
  const rejection = await pending;
  assert.equal(
    rejection.error,
    'Native cue text does not fit the selected preset'
  );
  const state = await entry.win.webContents.executeJavaScript(`(() => ({
    activeLayerCount: document.querySelectorAll('.native-cue-layer.active').length,
    inactiveChildCounts: [...document.querySelectorAll('.native-cue-layer:not(.active)')]
      .map(layer => layer.childElementCount),
    overflowTextPresent: [...document.querySelectorAll('.native-scene-body')]
      .some(body => body.textContent?.startsWith('Overflow Overflow'))
  }))()`);
  assert.equal(state.activeLayerCount, 1);
  assert.deepEqual(state.inactiveChildCounts, [0]);
  assert.equal(state.overflowTextPresent, false);
  return {
    outputId: entry.output.id,
    cueIndex,
    error: rejection.error,
    candidateRemoved: true
  };
}

function showPackageEvidence(opened, launchPlan) {
  const manifest = opened.manifest;
  const sourceAssets = new Map();
  const assets = manifest.channels.map(channel => {
    const assetId = `channel-${channel.roleId}`;
    sourceAssets.set(channel.roleId, assetId);
    const prefix = `${channel.directory}/`;
    return {
      assetId,
      revisionId: sha256Json({
        roleId: channel.roleId,
        renderer: channel.renderer,
        artifacts: manifest.artifacts
          .filter(artifact => artifact.path.startsWith(prefix))
          .map(artifact => ({
            path: artifact.path,
            sha256: artifact.sha256,
            size: artifact.size
          }))
      })
    };
  });
  if (manifest.assets.length > 0) {
    assets.push({
      assetId: 'show-pictures',
      revisionId: sha256Json(
        manifest.assets.map(asset => ({
          id: asset.id,
          sha256: asset.sha256,
          size: asset.size
        }))
      )
    });
  }

  return normalizeShowRehearsalEvidence({
    show: {
      kind: 'show-package',
      packageId: manifest.id,
      manifestRevisionId: opened.manifestSha256,
      assets
    },
    venueProfile: {
      id: 'electron-hidden-rehearsal',
      revisionId: sha256Json({
        contract: 'syncshow-electron-hidden-native-rehearsal-v1',
        syncShowVersion: packageJson.version,
        electronVersion: process.versions.electron,
        renderer: 'native-cue',
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT
      })
    },
    routing: launchPlan.outputs.map(output => ({
      outputId: output.id,
      displayId: output.displayId,
      decision: output.nativeVariant === 'singer-current-next'
        ? 'derive-next-text'
        : 'direct',
      sourceRoleId: output.sourceRoleId,
      sourceAssetId: sourceAssets.get(output.sourceRoleId),
      renderer: output.renderer,
      nativeVariant: output.nativeVariant || null,
      operatorPreview: output.operatorPreview === true
    })),
    cueCount: manifest.cueCount,
    cueIds: [...manifest.cueIds]
  });
}

async function runRehearsal() {
  assert.equal(isolation.active, true);
  assert.equal(fs.existsSync(FONT_PATH), true);
  assert.equal(fs.existsSync(DISPLAY_PAGE), true);
  assert.equal(fs.existsSync(PRELOAD_PATH), true);

  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const profilePath = fs.realpathSync(app.getPath('userData'));
  const workspace = path.join(profilePath, 'native-weekly-workspace');
  const fixture = await createTrackedNativeWeeklyService(workspace);
  const publisher = new ShowPackagePublisher({
    projectStore: fixture.projectStore,
    rootPath: path.join(profilePath, 'show-packages'),
    fontPath: FONT_PATH,
    clock: () => new Date(PUBLISH_NOW)
  });
  const published = await publisher.publish({
    projectId: fixture.ready.project.id,
    revisionId: fixture.ready.revisionId,
    roleMapping: roleMapping(),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    thumbnailWidth: 100,
    jpegQuality: 82
  });
  const opened = await publisher.open(published.manifest.id);
  const readingItem =
    fixture.ready.project.items['native-sermon-reading-1'];
  assert.deepEqual(readingItem.sermonReading.outputs, SERMON_READING_OUTPUTS);
  assert.equal(readingItem.sermonReading.translationId, undefined);
  assert.deepEqual(Object.keys(readingItem.passagesByChannel), [
    'primary',
    'secondary'
  ]);
  assert.equal(readingItem.passagesByChannel.primary.translationId, 'BSB');
  assert.equal(readingItem.passagesByChannel.secondary.translationId, 'LSV');
  const sermonItem = fixture.ready.project.items['native-sermon-slide-1'];
  assert.equal(sermonItem.sourceBodyProjection.schemaVersion, 2);
  assert.equal(sermonItem.sourceBodyProjection.channels.primary.mode, 'exact');
  assert.equal(
    sermonItem.sourceBodyProjection.channels.secondary.mode,
    'condensed'
  );

  const bibleCueIndexes = opened.presentations.front.scenes
    .flatMap((scene, index) => scene.sourceKind === 'bible' ? [index] : []);
  assert.deepEqual(bibleCueIndexes, [5]);
  const bibleCueIndex = bibleCueIndexes[0];
  const sermonCueIndexes = opened.presentations.front.scenes
    .flatMap((scene, index) => scene.sourceKind === 'sermon' ? [index] : []);
  assert.deepEqual(sermonCueIndexes, [6, 7]);
  const sermonCueIndex = sermonCueIndexes[0];
  for (const roleId of ['front', 'translation']) {
    assert.equal(
      opened.presentations[roleId].scenes[bibleCueIndex].sourceKind,
      'bible'
    );
  }
  const frontBibleScene = opened.presentations.front.scenes[bibleCueIndex];
  const translationBibleScene =
    opened.presentations.translation.scenes[bibleCueIndex];
  const singersBibleScene = opened.presentations.singers.scenes[bibleCueIndex];
  assert.equal(frontBibleScene.layout, 'text');
  assert.equal(frontBibleScene.title, 'Ephesians 3:10–12');
  assert.equal(frontBibleScene.body, BSB_READING_BODY);
  assert.equal(translationBibleScene.layout, 'text');
  assert.equal(translationBibleScene.title, 'Ephesians 3:10–12');
  assert.equal(translationBibleScene.body, LSV_READING_BODY);
  assert.notEqual(frontBibleScene.body, translationBibleScene.body);
  assert.equal(singersBibleScene.layout, 'blank');
  assert.equal(singersBibleScene.sourceKind, 'bible');
  assert.equal('body' in singersBibleScene, false);
  assert.equal(
    sha256Buffer(Buffer.from(frontBibleScene.body, 'utf8')),
    BSB_READING_SHA256
  );
  assert.equal(
    sha256Buffer(Buffer.from(translationBibleScene.body, 'utf8')),
    LSV_READING_SHA256
  );
  const packagedTimeline = JSON.parse(await fsPromises.readFile(
    path.join(opened.packagePath, 'timeline.json'),
    'utf8'
  ));
  const packagedBibleCue = packagedTimeline.cues[
    opened.manifest.cueIds[bibleCueIndex]
  ];
  assert.deepEqual(
    [...packagedBibleCue.sourceReference.outputs]
      .sort((left, right) => left.channelId.localeCompare(right.channelId)),
    [...SERMON_READING_OUTPUTS]
      .sort((left, right) => left.channelId.localeCompare(right.channelId))
  );
  assert.equal(
    packagedBibleCue.channels.primary.blocks[0].translationId,
    'BSB'
  );
  assert.equal(
    packagedBibleCue.channels.secondary.blocks[0].translationId,
    'LSV'
  );
  assert.deepEqual(packagedBibleCue.channels.media, {
    blocks: [],
    mode: 'hide'
  });
  const packagedSermonCue = packagedTimeline.cues[
    opened.manifest.cueIds[sermonCueIndex]
  ];
  assert.equal(packagedSermonCue.channels.primary.mode, 'content');
  assert.equal(
    packagedSermonCue.channels.primary.blocks[0].text,
    PRIMARY_SERMON_SOURCE_TEXT
  );
  assert.equal(packagedSermonCue.channels.secondary.mode, 'condensed');
  assert.equal(
    packagedSermonCue.channels.secondary.blocks[0].text,
    CONDENSED_SERMON_TEXT
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      packagedSermonCue.channels.secondary,
      'sourceChannelId'
    ),
    false
  );
  assert.deepEqual(packagedSermonCue.channels.media, {
    blocks: [],
    mode: 'hide'
  });
  console.log('[Electron rehearsal] Native package opened and verified.');
  const decisions = launchDecisions();
  const plan = resolveLaunchPlan({
    presentations: opened.presentations,
    outputs: launchOutputs(),
    decisions,
    preferredTimelineRoleId: 'front'
  });
  assert.equal(plan.totalSlides, 9);
  assert.equal(plan.outputs.length, 3);
  assert.equal(
    plan.outputs.every(output => output.renderer === 'native-cue'),
    true
  );
  assert.deepEqual(
    plan.outputs.map(output => [
      output.id,
      output.sourceRoleId,
      output.nativeVariant || null
    ]),
    ROUTE === 'derived-singer'
      ? [
          ['front-projector', 'front', null],
          ['translation-projector', 'translation', null],
          ['singers-monitor', 'front', 'singer-current-next']
        ]
      : [
          ['front-projector', 'front', null],
          ['translation-projector', 'translation', null],
          ['singers-monitor', 'singers', null]
        ]
  );

  const entries = [];
  const acknowledgements = [];
  const captures = [];
  const bibleChecks = [];
  const sermonChecks = [];
  const derivedSingerChecks = [];
  let overflowProbe = null;
  try {
    for (const output of plan.outputs) {
      entries.push(await createHiddenOutput(
        output,
        opened.presentations[output.sourceRoleId]
      ));
    }
    assert.equal(BrowserWindow.getAllWindows().length, plan.outputs.length);
    assert.equal(entries.every(entry => !entry.win.isVisible()), true);
    console.log('[Electron rehearsal] Three hidden BrowserWindows are ready.');

    for (let cueIndex = 0; cueIndex < plan.totalSlides; cueIndex += 1) {
      const pending = entries.map(entry =>
        waitForFrame(entry.win, entry.output.id, cueIndex));
      const payloads = new Map();
      for (const entry of entries) {
        const payload = scenePayload(entry, cueIndex);
        payloads.set(entry.output.id, payload);
        entry.win.webContents.send('native-cue:goto', {
          index: cueIndex,
          timestamp: Date.now(),
          revealAt: Date.now(),
          syncMode: false,
          outputId: entry.output.id,
          sourceRoleId: entry.output.sourceRoleId,
          scene: payload.scene,
          assetPaths: payload.assetPaths
        });
      }
      const cueAcks = await Promise.all(pending);
      assert.equal(cueAcks.length, plan.outputs.length);
      acknowledgements.push({
        cueId: opened.manifest.cueIds[cueIndex],
        outputIds: cueAcks.map(ack => ack.outputId)
      });
      if (
        ROUTE === 'direct'
        && (
          cueIndex === 0
          || cueIndex === bibleCueIndex
          || cueIndex === sermonCueIndex
        )
      ) {
        captures.push(...await Promise.all(
          entries.map(entry => captureRenderedFrame(entry, cueIndex))
        ));
      }
      if (ROUTE === 'derived-singer') {
        const singerEntry = entries.find(
          entry => entry.output.id === 'singers-monitor'
        );
        assert.ok(singerEntry);
        derivedSingerChecks.push(
          await inspectRenderedDerivedSingerFrame(
            singerEntry,
            cueIndex,
            payloads.get(singerEntry.output.id).scene
          )
        );
        captures.push(await captureRenderedFrame(singerEntry, cueIndex));
      }
      if (cueIndex === bibleCueIndex) {
        bibleChecks.push(...await Promise.all(
          entries
            .filter(entry => !entry.output.nativeVariant)
            .map(entry => inspectRenderedBibleFrame(
              entry,
              cueIndex,
              readingTreatmentForRole(
                readingItem.sermonReading.outputs,
                entry.output.sourceRoleId
              )
            ))
        ));
      }
      if (cueIndex === sermonCueIndex) {
        sermonChecks.push(...await Promise.all(
          entries
            .filter(entry => !entry.output.nativeVariant)
            .map(entry => inspectRenderedSermonFrame(
              entry,
              cueIndex,
              sermonTreatmentForRole(entry.output.sourceRoleId)
            ))
        ));
      }
      console.log(
        `[Electron rehearsal] Cue ${cueIndex + 1}/${plan.totalSlides} `
        + 'acknowledged by every output.'
      );
    }

    if (
      ROUTE === 'direct'
      && WINDOW_WIDTH === 640
      && WINDOW_HEIGHT === 360
    ) {
      const target = entries.find(
        entry => entry.output.id === 'front-projector'
      );
      assert.ok(target);
      overflowProbe = await runOverflowProbe(target, frontBibleScene);
      console.log('[Electron rehearsal] Minimum-resolution overflow probe rejected.');
    }

    const evidence = showPackageEvidence(opened, plan);
    const receipt = {
      schemaVersion: SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
      kind: SHOW_REHEARSAL_RECEIPT_KIND,
      ...evidence,
      acknowledgements
    };
    const receiptStore = new ShowRehearsalReceiptStore({
      rootPath: path.join(profilePath, 'show-readiness')
    });
    const savedReceipt = await receiptStore.write(receipt);
    const reopenedReceipt = await new ShowRehearsalReceiptStore({
      rootPath: path.join(profilePath, 'show-readiness')
    }).read();
    assert.deepEqual(reopenedReceipt, savedReceipt);
    assert.equal(showRehearsalReceiptMatches(reopenedReceipt, evidence), true);
    assert.equal(
      reopenedReceipt.acknowledgements.length,
      opened.manifest.cueCount
    );
    let receiptRejectsDirectEvidence = null;
    if (ROUTE === 'derived-singer') {
      const directPlan = resolveLaunchPlan({
        presentations: opened.presentations,
        outputs: launchOutputs(),
        decisions: {},
        preferredTimelineRoleId: 'front'
      });
      const directEvidence = showPackageEvidence(opened, directPlan);
      receiptRejectsDirectEvidence =
        !showRehearsalReceiptMatches(reopenedReceipt, directEvidence);
      assert.equal(receiptRejectsDirectEvidence, true);
    }
    console.log('[Electron rehearsal] Exact receipt persisted and reopened.');

    return {
      ok: true,
      contract: resultContract(),
      route: ROUTE,
      isolatedProfile: true,
      physicalDisplayRoutingUsed: false,
      visibleWindowCount: entries.filter(entry => entry.win.isVisible()).length,
      browserWindowCount: entries.length,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      packageId: opened.manifest.id,
      manifestSha256: opened.manifestSha256,
      cueCount: opened.manifest.cueCount,
      outputIds: plan.outputs.map(output => output.id),
      routes: plan.outputs.map(output => ({
        outputId: output.id,
        sourceRoleId: output.sourceRoleId,
        renderer: output.renderer,
        nativeVariant: output.nativeVariant || null
      })),
      acknowledgementCount: acknowledgements.reduce(
        (count, acknowledgement) =>
          count + acknowledgement.outputIds.length,
        0
      ),
      captureCount: captures.length,
      captureDigests: captures.map(capture => capture.pngSha256),
      minimumCaptureBytes: Math.min(
        ...captures.map(capture => capture.pngBytes)
      ),
      bibleCueIndex,
      sermonCueIndex,
      bibleSourceOutputs: readingItem.sermonReading.outputs,
      bibleBodySha256ByRole: {
        front: sha256Buffer(Buffer.from(frontBibleScene.body, 'utf8')),
        translation: sha256Buffer(
          Buffer.from(translationBibleScene.body, 'utf8')
        ),
        singers: null
      },
      bibleChecks,
      sermonChecks,
      derivedSingerChecks,
      derivedSingerNextStates:
        derivedSingerChecks.map(check => check.next.state),
      overflowProbe,
      receiptPersistedAndReopened: true,
      receiptRejectsDirectEvidence
    };
  } finally {
    for (const entry of entries) {
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
  }
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const result = await runRehearsal();
    await writeResult(result);
  } catch (error) {
    exitCode = 1;
    const failure = {
      ok: false,
      contract: resultContract(),
      route: ROUTE,
      isolatedProfile: isolation.active === true,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    };
    try {
      await writeResult(failure);
    } catch (writeError) {
      console.error('[Electron rehearsal] Could not write failure result:', writeError);
    }
    console.error('[Electron rehearsal] Failed:', error);
  } finally {
    app.exit(exitCode);
  }
}).catch(error => {
  console.error('[Electron rehearsal] App readiness failed:', error);
  app.exit(1);
});
