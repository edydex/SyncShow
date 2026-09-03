'use strict';

/**
 * Browser-side renderer for the constrained native cue scene contract.
 *
 * This file intentionally accepts no markup, CSS, URLs, or font names from a
 * scene. Every node is created with DOM APIs, text is inserted with text nodes,
 * and the only styles accepted from the package are bounded numeric layout
 * tokens plus validated colors/weights/alignment.
 */
(function exposeNativeCueRenderer(global) {
  const SCHEMA_VERSION = 3;
  const KIND = 'syncshow-native-cue-scene';
  const LAYOUTS = new Set(['blank', 'text', 'song-title', 'picture', 'video', 'singer-current-next']);
  const SOURCE_KINDS = new Set(['song', 'bible', 'sermon', 'picture', 'video', 'notice', 'blank', 'slide']);
  const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const ASSET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
  const COLOR_PATTERN = /^#[a-f0-9]{6}$/;
  const WEIGHTS = new Set(['400', '500', '600', '650', '700']);
  const ALIGNMENTS = new Set(['left', 'center', 'right']);
  const POSITIONS = new Set(['center', 'top']);
  const FITS = new Set(['fit', 'fill', 'stretch']);
  const SINGER_NEXT_STATES = new Set(['text', 'blank', 'end']);

  function record(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function exactKeys(value, expected, field) {
    if (!record(value)) throw new TypeError(`${field} must be an object`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
      throw new TypeError(`${field} has unsupported or missing fields`);
    }
  }

  function string(value, field, maximum, required = false) {
    if (typeof value !== 'string' || value.length > maximum || (required && value.length < 1)) {
      throw new TypeError(`${field} is invalid`);
    }
    return value;
  }

  function integer(value, field, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`${field} is invalid`);
    }
    return value;
  }

  function number(value, field, minimum, maximum) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new TypeError(`${field} is invalid`);
    }
    return value;
  }

  function singerNext(value) {
    exactKeys(value, ['state', 'text'], 'scene.next');
    const state = string(value.state, 'scene.next.state', 12, true);
    const text = string(value.text, 'scene.next.text', 2000);
    if (!SINGER_NEXT_STATES.has(state)) {
      throw new TypeError('scene.next.state is invalid');
    }
    if (state === 'text') {
      if (!text.trim() || text !== text.trim() || /[\r\n]/.test(text)) {
        throw new TypeError('scene.next.text must be one nonblank trimmed line');
      }
    } else if (text !== '') {
      throw new TypeError(`scene.next.text must be empty for ${state} state`);
    }
    return { state, text };
  }

  function color(value, field) {
    if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
      throw new TypeError(`${field} is invalid`);
    }
    return value;
  }

  function canvas(value) {
    exactKeys(value, ['height', 'width'], 'scene.canvas');
    const width = integer(value.width, 'scene.canvas.width', 640, 3840);
    const height = integer(value.height, 'scene.canvas.height', 360, 2160);
    if (width * height > 3840 * 2160) throw new TypeError('scene.canvas is too large');
    return { width, height };
  }

  function splitsSurrogatePair(value, index) {
    if (index <= 0 || index >= value.length) return false;
    const previous = value.charCodeAt(index - 1);
    const next = value.charCodeAt(index);
    return previous >= 0xD800
      && previous <= 0xDBFF
      && next >= 0xDC00
      && next <= 0xDFFF;
  }

  function spans(value, text) {
    if (!Array.isArray(value) || value.length > 256) throw new TypeError('scene.bodySpans is invalid');
    let previousEnd = 0;
    return value.map((candidate, index) => {
      if (!record(candidate)) throw new TypeError(`scene.bodySpans[${index}] is invalid`);
      const keys = Object.keys(candidate).sort();
      if (keys.some(key => !['end', 'foreground', 'start', 'weight', 'fontScale', 'italic', 'underline'].includes(key))) {
        throw new TypeError(`scene.bodySpans[${index}] has an unsupported field`);
      }
      const start = integer(candidate.start, `scene.bodySpans[${index}].start`, 0, text.length);
      const end = integer(candidate.end, `scene.bodySpans[${index}].end`, 1, text.length);
      if (start < previousEnd
        || end <= start
        || splitsSurrogatePair(text, start)
        || splitsSurrogatePair(text, end)) {
        throw new TypeError('scene.bodySpans overlap or split text characters');
      }
      const normalized = { start, end };
      if (candidate.foreground !== undefined) {
        normalized.foreground = color(candidate.foreground, `scene.bodySpans[${index}].foreground`);
      }
      if (candidate.weight !== undefined) {
        if (!WEIGHTS.has(candidate.weight)) throw new TypeError('scene body span weight is invalid');
        normalized.weight = candidate.weight;
      }
      if (candidate.fontScale !== undefined) {
        if (!Number.isFinite(candidate.fontScale) || candidate.fontScale < 0.5 || candidate.fontScale > 2) throw new TypeError('scene body span font scale is invalid');
        normalized.fontScale = candidate.fontScale;
      }
      for (const key of ['italic', 'underline']) {
        if (candidate[key] !== undefined) {
          if (typeof candidate[key] !== 'boolean') throw new TypeError('Invalid inline text style');
          normalized[key] = candidate[key];
        }
      }
      if (!normalized.foreground && !normalized.weight && !normalized.fontScale && normalized.italic === undefined && normalized.underline === undefined) throw new TypeError('scene body span has no style');
      previousEnd = end;
      return normalized;
    });
  }

  function textStyle(value) {
    exactKeys(value, [
      'bodyAlign',
      'bodyForeground',
      'bodyHeight',
      'bodyMinimumSize',
      'bodyPosition',
      'bodyRegionHeightPercent',
      'bodySize',
      'bodyTopPercent',
      'bodyWeight',
      'bodyWidthPercent',
      'lineSpacingPercent',
      'paragraphGap',
      'showTitle',
      'titleAlign',
      'titleForeground',
      'titleMinimumSize',
      'titleSize',
      'titleTopPercent',
      'titleWeight',
      'titleWidthPercent'
    ], 'scene.style');
    if (typeof value.showTitle !== 'boolean' || typeof value.paragraphGap !== 'boolean') {
      throw new TypeError('scene style booleans are invalid');
    }
    if (!ALIGNMENTS.has(value.titleAlign)
      || !ALIGNMENTS.has(value.bodyAlign)
      || !POSITIONS.has(value.bodyPosition)
      || !WEIGHTS.has(value.titleWeight)
      || !WEIGHTS.has(value.bodyWeight)) {
      throw new TypeError('scene text style contains an unsupported value');
    }
    const titleSize = integer(value.titleSize, 'scene.style.titleSize', 14, 160);
    const titleMinimumSize = integer(
      value.titleMinimumSize,
      'scene.style.titleMinimumSize',
      14,
      160
    );
    const bodySize = integer(value.bodySize, 'scene.style.bodySize', 14, 240);
    const bodyMinimumSize = integer(
      value.bodyMinimumSize,
      'scene.style.bodyMinimumSize',
      14,
      240
    );
    if (titleMinimumSize > titleSize || bodyMinimumSize > bodySize) {
      throw new TypeError('scene style minimum sizes are invalid');
    }
    return {
      showTitle: value.showTitle,
      titleSize,
      titleMinimumSize,
      titleForeground: color(value.titleForeground, 'scene.style.titleForeground'),
      titleWeight: value.titleWeight,
      titleAlign: value.titleAlign,
      titleWidthPercent: integer(value.titleWidthPercent, 'scene.style.titleWidthPercent', 50, 100),
      titleTopPercent: integer(value.titleTopPercent, 'scene.style.titleTopPercent', 0, 80),
      bodySize,
      bodyMinimumSize,
      bodyForeground: color(value.bodyForeground, 'scene.style.bodyForeground'),
      bodyWeight: value.bodyWeight,
      bodyAlign: value.bodyAlign,
      bodyWidthPercent: integer(value.bodyWidthPercent, 'scene.style.bodyWidthPercent', 50, 100),
      bodyHeight: integer(value.bodyHeight, 'scene.style.bodyHeight', 50, 1080),
      bodyTopPercent: integer(value.bodyTopPercent, 'scene.style.bodyTopPercent', 0, 80),
      bodyRegionHeightPercent: integer(
        value.bodyRegionHeightPercent,
        'scene.style.bodyRegionHeightPercent',
        10,
        90
      ),
      bodyPosition: value.bodyPosition,
      lineSpacingPercent: integer(value.lineSpacingPercent, 'scene.style.lineSpacingPercent', 0, 200),
      paragraphGap: value.paragraphGap
    };
  }

  function songTitleStyle(value) {
    exactKeys(value, [
      'creditBottomPercent',
      'creditForeground',
      'creditMinimumSize',
      'creditRightPercent',
      'creditSize',
      'creditWeight',
      'creditWidthPercent',
      'titleForeground',
      'titleMinimumSize',
      'titleRegionHeightPercent',
      'titleSize',
      'titleTopPercent',
      'titleWeight',
      'titleWidthPercent',
      'subtitleForeground',
      'subtitleMinimumSize',
      'subtitleSize',
      'subtitleWeight',
      'subtitleWidthPercent'
    ], 'scene.style');
    const titleSize = integer(value.titleSize, 'scene.style.titleSize', 14, 240);
    const titleMinimumSize = integer(
      value.titleMinimumSize,
      'scene.style.titleMinimumSize',
      14,
      240
    );
    const creditSize = integer(value.creditSize, 'scene.style.creditSize', 14, 96);
    const creditMinimumSize = integer(
      value.creditMinimumSize,
      'scene.style.creditMinimumSize',
      14,
      96
    );
    const subtitleSize = integer(value.subtitleSize, 'scene.style.subtitleSize', 14, 160);
    const subtitleMinimumSize = integer(
      value.subtitleMinimumSize,
      'scene.style.subtitleMinimumSize',
      14,
      160
    );
    if (titleMinimumSize > titleSize
      || subtitleMinimumSize > subtitleSize
      || creditMinimumSize > creditSize) {
      throw new TypeError('scene style minimum sizes are invalid');
    }
    if (!WEIGHTS.has(value.titleWeight)
      || !WEIGHTS.has(value.subtitleWeight)
      || !WEIGHTS.has(value.creditWeight)) {
      throw new TypeError('scene song-title style contains an unsupported weight');
    }
    return {
      titleSize,
      titleMinimumSize,
      titleForeground: color(value.titleForeground, 'scene.style.titleForeground'),
      titleWeight: value.titleWeight,
      titleWidthPercent: integer(value.titleWidthPercent, 'scene.style.titleWidthPercent', 50, 96),
      titleTopPercent: integer(value.titleTopPercent, 'scene.style.titleTopPercent', 0, 60),
      titleRegionHeightPercent: integer(
        value.titleRegionHeightPercent,
        'scene.style.titleRegionHeightPercent',
        20,
        80
      ),
      subtitleSize,
      subtitleMinimumSize,
      subtitleForeground: color(value.subtitleForeground, 'scene.style.subtitleForeground'),
      subtitleWeight: value.subtitleWeight,
      subtitleWidthPercent: integer(
        value.subtitleWidthPercent,
        'scene.style.subtitleWidthPercent',
        50,
        96
      ),
      creditSize,
      creditMinimumSize,
      creditForeground: color(value.creditForeground, 'scene.style.creditForeground'),
      creditWeight: value.creditWeight,
      creditWidthPercent: integer(value.creditWidthPercent, 'scene.style.creditWidthPercent', 25, 80),
      creditRightPercent: integer(value.creditRightPercent, 'scene.style.creditRightPercent', 0, 20),
      creditBottomPercent: integer(value.creditBottomPercent, 'scene.style.creditBottomPercent', 0, 20)
    };
  }

  function validateScene(raw, expectedCueId = null) {
    if (!record(raw)
      || raw.schemaVersion !== SCHEMA_VERSION
      || raw.kind !== KIND
      || !LAYOUTS.has(raw.layout)
      || !ID_PATTERN.test(raw.cueId || '')
      || !SOURCE_KINDS.has(raw.sourceKind)) {
      throw new TypeError('Native cue scene identity is invalid');
    }
    if (expectedCueId && raw.cueId !== expectedCueId) throw new TypeError('Native cue scene is stale');
    const common = {
      schemaVersion: SCHEMA_VERSION,
      kind: KIND,
      cueId: raw.cueId,
      sourceKind: raw.sourceKind,
      canvas: canvas(raw.canvas),
      layout: raw.layout,
      background: color(raw.background, 'scene.background')
    };
    if (raw.layout === 'blank') {
      exactKeys(raw, ['background', 'canvas', 'cueId', 'kind', 'layout', 'schemaVersion', 'sourceKind'], 'scene');
      return common;
    }
    if (raw.layout === 'text') {
      exactKeys(raw, [
        ...(raw.backgroundAssetId !== undefined ? ['backgroundAssetId'] : []),
        ...(raw.titleSpans !== undefined ? ['titleSpans'] : []),
        'background',
        'body',
        'bodySpans',
        'canvas',
        'cueId',
        'kind',
        'layout',
        'schemaVersion',
        'sourceKind',
        'style',
        'title'
      ], 'scene');
      const body = string(raw.body, 'scene.body', 12000, true);
      if (raw.backgroundAssetId !== undefined && !ASSET_ID_PATTERN.test(raw.backgroundAssetId)) throw new TypeError('Invalid slide background image');
      if (body.split(/\r\n|\r|\n/).length > 240) throw new TypeError('scene.body has too many lines');
      return {
        ...common,
        title: string(raw.title, 'scene.title', 500),
        body,
        bodySpans: spans(raw.bodySpans, body),
        ...(raw.titleSpans !== undefined ? { titleSpans: spans(raw.titleSpans, raw.title) } : {}),
        ...(raw.backgroundAssetId !== undefined ? { backgroundAssetId: raw.backgroundAssetId } : {}),
        style: textStyle(raw.style)
      };
    }
    if (raw.layout === 'song-title') {
      exactKeys(raw, [
        'background',
        'canvas',
        'credit',
        'cueId',
        'kind',
        'layout',
        'schemaVersion',
        'sourceKind',
        'style',
        'subtitle',
        'title'
      ], 'scene');
      return {
        ...common,
        title: string(raw.title, 'scene.title', 500, true),
        subtitle: string(raw.subtitle, 'scene.subtitle', 500),
        credit: string(raw.credit, 'scene.credit', 2048),
        style: songTitleStyle(raw.style)
      };
    }
    if (raw.layout === 'picture') {
      exactKeys(raw, [
        'background',
        'canvas',
        'cueId',
        'kind',
        'layout',
        'picture',
        'schemaVersion',
        'sourceKind'
      ], 'scene');
      exactKeys(raw.picture, ['altText', 'assetId', 'attribution', 'fit', 'focalPoint'], 'scene.picture');
      exactKeys(raw.picture.focalPoint, ['x', 'y'], 'scene.picture.focalPoint');
      if (!ASSET_ID_PATTERN.test(raw.picture.assetId || '') || !FITS.has(raw.picture.fit)) {
        throw new TypeError('scene.picture is invalid');
      }
      return {
        ...common,
        picture: {
          assetId: raw.picture.assetId,
          fit: raw.picture.fit,
          focalPoint: {
            x: number(raw.picture.focalPoint.x, 'scene.picture.focalPoint.x', 0, 1),
            y: number(raw.picture.focalPoint.y, 'scene.picture.focalPoint.y', 0, 1)
          },
          altText: string(raw.picture.altText, 'scene.picture.altText', 500, true),
          attribution: string(raw.picture.attribution, 'scene.picture.attribution', 500)
        }
      };
    }
    if (raw.layout === 'video') {
      exactKeys(raw, [
        'background',
        'canvas',
        'cueId',
        'kind',
        'layout',
        'schemaVersion',
        'sourceKind',
        'video'
      ], 'scene');
      exactKeys(raw.video, ['assetId', 'fit', 'muted'], 'scene.video');
      if (!ASSET_ID_PATTERN.test(raw.video.assetId || '')
        || !FITS.has(raw.video.fit)
        || typeof raw.video.muted !== 'boolean') {
        throw new TypeError('scene.video is invalid');
      }
      return {
        ...common,
        video: {
          assetId: raw.video.assetId,
          fit: raw.video.fit,
          muted: raw.video.muted
        }
      };
    }
    exactKeys(raw, [
      'background',
      'canvas',
      'cueId',
      'current',
      'kind',
      'layout',
      'next',
      'schemaVersion',
      'sourceKind'
    ], 'scene');
    const current = validateScene(raw.current, raw.cueId);
    if (current.layout === 'singer-current-next'
      || current.sourceKind !== common.sourceKind
      || current.canvas.width !== common.canvas.width
      || current.canvas.height !== common.canvas.height) {
      throw new TypeError('Nested Singer scene identity is inconsistent');
    }
    return {
      ...common,
      current,
      next: singerNext(raw.next)
    };
  }

  function appendStyledText(target, text, textSpans, paragraphGap) {
    let offset = 0;
    const append = (value, span = null) => {
      const rendered = paragraphGap ? value.replace(/\r\n|\r|\n/g, '\n\n') : value;
      if (!span) {
        target.appendChild(document.createTextNode(rendered));
        return;
      }
      const element = document.createElement('span');
      if (span.foreground) element.style.color = span.foreground;
      if (span.weight) element.style.fontWeight = span.weight;
      if (span.italic !== undefined) element.style.fontStyle = span.italic ? 'italic' : 'normal';
      if (span.underline !== undefined) element.style.textDecoration = span.underline ? 'underline' : 'none';
      if (span.fontScale) element.style.fontSize = `${span.fontScale}em`;
      element.appendChild(document.createTextNode(rendered));
      target.appendChild(element);
    };
    for (const span of textSpans) {
      if (span.start > offset) append(text.slice(offset, span.start));
      append(text.slice(span.start, span.end), span);
      offset = span.end;
    }
    if (offset < text.length) append(text.slice(offset));
  }

  function fitSurface(host, surface, logicalCanvas) {
    const bounds = host.getBoundingClientRect();
    const scale = Math.min(bounds.width / logicalCanvas.width, bounds.height / logicalCanvas.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Native cue output has no display area');
    surface.style.width = `${Math.floor(logicalCanvas.width * scale)}px`;
    surface.style.height = `${Math.floor(logicalCanvas.height * scale)}px`;
    return scale;
  }

  function logicalCanvasScale(logicalCanvas) {
    return Math.min(
      logicalCanvas.width / 1920,
      logicalCanvas.height / 1080
    );
  }

  function scaledTextMinimum(minimum, logicalCanvas) {
    return Math.max(
      14,
      Math.round(minimum * Math.min(1, logicalCanvasScale(logicalCanvas)))
    );
  }

  function scaledSongTextRange(preferred, minimum, logicalCanvas) {
    const logicalScale = logicalCanvasScale(logicalCanvas);
    const selectedPreferred = Math.max(18, Math.round(preferred * logicalScale));
    return {
      preferred: selectedPreferred,
      minimum: Math.max(
        14,
        Math.min(selectedPreferred, Math.round(minimum * logicalScale))
      )
    };
  }

  function fitText(element, preferred, minimum, scale) {
    const fits = () => (
      element.scrollWidth <= element.clientWidth + 2
      && element.scrollHeight <= element.clientHeight + 2
    );
    for (let size = preferred; size > minimum; size -= 2) {
      element.style.fontSize = `${size * scale}px`;
      if (fits()) return size;
    }
    element.style.fontSize = `${minimum * scale}px`;
    if (!fits()) {
      throw new Error('Native cue text does not fit the selected preset');
    }
    return minimum;
  }

  function settleFittedTextHeight(element, maximumHeight) {
    element.style.height = 'auto';
    element.style.maxHeight = 'none';
    const naturalHeight = element.scrollHeight;
    const boundedMaximum = Math.max(0, Math.ceil(maximumHeight));
    element.style.height = `${Math.min(naturalHeight, boundedMaximum)}px`;
    element.style.maxHeight = `${boundedMaximum}px`;
  }

  function imageReady(image) {
    if (image.complete) {
      return image.naturalWidth > 0
        ? Promise.resolve()
        : Promise.reject(new Error('Native cue picture could not be decoded'));
    }
    return new Promise((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('Native cue picture could not be loaded')), {
        once: true
      });
    });
  }

  function videoReady(video) {
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('Native cue video could not be loaded')), {
        once: true
      });
    });
  }

  function buildScene(rawScene, options = {}) {
    const scene = validateScene(rawScene);
    const host = document.createElement('div');
    host.className = 'native-scene-host';
    const surface = document.createElement('div');
    surface.className = `native-scene-surface native-scene-${scene.layout}`;
    surface.style.backgroundColor = scene.background;
    host.appendChild(surface);
    const children = [];
    const images = [];
    const videos = [];
    let videoState = scene.layout === 'video' ? 'armed' : 'not-video';

    function publishVideoState(nextState, error = '') {
      if (scene.layout !== 'video') return;
      videoState = nextState;
      options.onVideoState?.({
        cueId: scene.cueId,
        state: nextState,
        error
      });
    }

    if (scene.layout === 'text') {
      if (scene.backgroundAssetId) {
        const source = options.resolveAssetUrl?.(scene.backgroundAssetId);
        if (!source) throw new Error('Slide background image is unavailable');
        const background = document.createElement('img');
        background.className = 'native-scene-background';
        background.alt = '';
        background.src = source;
        surface.appendChild(background);
        images.push(background);
      }
      const style = scene.style;
      const titleMinimumSize = scaledTextMinimum(
        style.titleMinimumSize,
        scene.canvas
      );
      const bodyMinimumSize = scaledTextMinimum(
        style.bodyMinimumSize,
        scene.canvas
      );
      let title = null;
      if (style.showTitle && scene.title) {
        title = document.createElement('div');
        title.className = 'native-scene-title';
        appendStyledText(title, scene.title, scene.titleSpans || [], false);
        title.style.color = style.titleForeground;
        title.style.fontWeight = style.titleWeight;
        title.style.textAlign = style.titleAlign;
        surface.appendChild(title);
      }
      const bodyRegion = document.createElement('div');
      bodyRegion.className = 'native-scene-body-region';
      bodyRegion.classList.toggle('native-scene-body-top', style.bodyPosition === 'top');
      const body = document.createElement('div');
      body.className = 'native-scene-body';
      body.style.color = style.bodyForeground;
      body.style.fontWeight = style.bodyWeight;
      body.style.textAlign = style.bodyAlign;
      appendStyledText(body, scene.body, scene.bodySpans, style.paragraphGap);
      bodyRegion.appendChild(body);
      surface.appendChild(bodyRegion);
      children.push({
        relayout(scale) {
          let titleBottom = 0;
          if (title) {
            title.style.left = `${(100 - style.titleWidthPercent) / 2}%`;
            title.style.top = `${style.titleTopPercent}%`;
            title.style.width = `${style.titleWidthPercent}%`;
            const titleMaximumHeight = scene.canvas.height * 0.16 * scale;
            title.style.height = `${titleMaximumHeight}px`;
            title.style.lineHeight = '1.18';
            fitText(title, style.titleSize, titleMinimumSize, scale);
            settleFittedTextHeight(title, titleMaximumHeight);
            titleBottom = (title.offsetTop + title.offsetHeight) / scale;
          }
          const configuredBodyTop = scene.canvas.height * style.bodyTopPercent / 100;
          const logicalTop = style.bodyPosition === 'top' && titleBottom > 0
            ? Math.max(configuredBodyTop, titleBottom + scene.canvas.height * 0.04)
            : configuredBodyTop;
          const logicalRegionHeight = style.bodyPosition === 'top'
            ? Math.min(
                style.bodyHeight,
                Math.max(50, scene.canvas.height - logicalTop - scene.canvas.height * 0.06)
              )
            : scene.canvas.height * style.bodyRegionHeightPercent / 100;
          const logicalFitHeight = style.bodyPosition === 'top'
            ? logicalRegionHeight
            : Math.min(
                style.bodyHeight,
                scene.canvas.height * (style.showTitle
                  ? style.bodyRegionHeightPercent
                  : Math.max(10, style.bodyRegionHeightPercent - 2)) / 100
              );
          bodyRegion.style.left = `${(100 - style.bodyWidthPercent) / 2}%`;
          bodyRegion.style.top = `${logicalTop * scale}px`;
          bodyRegion.style.width = `${style.bodyWidthPercent}%`;
          bodyRegion.style.height = `${logicalRegionHeight * scale}px`;
          body.style.lineHeight = String(1 + style.lineSpacingPercent / 100);
          const bodyMaximumHeight = logicalFitHeight * scale;
          body.style.height = `${bodyMaximumHeight}px`;
          fitText(body, style.bodySize, bodyMinimumSize, scale);
          settleFittedTextHeight(body, bodyMaximumHeight);
        }
      });
    } else if (scene.layout === 'song-title') {
      const style = scene.style;
      const titleSizes = scaledSongTextRange(
        style.titleSize,
        style.titleMinimumSize,
        scene.canvas
      );
      const subtitleSizes = scaledSongTextRange(
        style.subtitleSize,
        style.subtitleMinimumSize,
        scene.canvas
      );
      const creditSizes = scaledSongTextRange(
        style.creditSize,
        style.creditMinimumSize,
        scene.canvas
      );
      const titleRegion = document.createElement('div');
      titleRegion.className = 'native-song-title-region';
      const title = document.createElement('div');
      title.className = 'native-song-title-text';
      title.textContent = scene.title;
      title.style.color = style.titleForeground;
      title.style.fontWeight = style.titleWeight;
      titleRegion.appendChild(title);
      let subtitle = null;
      if (scene.subtitle) {
        subtitle = document.createElement('div');
        subtitle.className = 'native-song-title-subtitle';
        subtitle.textContent = scene.subtitle;
        subtitle.style.color = style.subtitleForeground;
        subtitle.style.fontWeight = style.subtitleWeight;
        titleRegion.appendChild(subtitle);
      }
      surface.appendChild(titleRegion);
      let credit = null;
      if (scene.credit) {
        credit = document.createElement('div');
        credit.className = 'native-song-title-credit';
        credit.textContent = scene.credit;
        credit.style.color = style.creditForeground;
        credit.style.fontWeight = style.creditWeight;
        surface.appendChild(credit);
      }
      children.push({
        relayout(scale) {
          titleRegion.style.left = '0';
          titleRegion.style.top = `${style.titleTopPercent}%`;
          titleRegion.style.width = '100%';
          titleRegion.style.height = `${style.titleRegionHeightPercent}%`;
          titleRegion.style.gap = `${scene.canvas.height * 0.025 * scale}px`;
          const titleShare = subtitle ? 0.58 : 1;
          title.style.width = `${style.titleWidthPercent}%`;
          const titleMaximumHeight =
            scene.canvas.height * style.titleRegionHeightPercent / 100
            * titleShare * scale;
          title.style.height = `${titleMaximumHeight}px`;
          fitText(title, titleSizes.preferred, titleSizes.minimum, scale);
          settleFittedTextHeight(title, titleMaximumHeight);
          if (subtitle) {
            subtitle.style.width = `${style.subtitleWidthPercent}%`;
            const subtitleMaximumHeight =
              scene.canvas.height * style.titleRegionHeightPercent / 100
              * 0.36 * scale;
            subtitle.style.height = `${subtitleMaximumHeight}px`;
            fitText(
              subtitle,
              subtitleSizes.preferred,
              subtitleSizes.minimum,
              scale
            );
            settleFittedTextHeight(subtitle, subtitleMaximumHeight);
          }
          if (credit) {
            credit.style.right = `${style.creditRightPercent}%`;
            credit.style.bottom = `${style.creditBottomPercent}%`;
            credit.style.width = `${style.creditWidthPercent}%`;
            const creditMaximumHeight = scene.canvas.height * 0.18 * scale;
            credit.style.height = `${creditMaximumHeight}px`;
            fitText(credit, creditSizes.preferred, creditSizes.minimum, scale);
            settleFittedTextHeight(credit, creditMaximumHeight);
          }
        }
      });
    } else if (scene.layout === 'picture') {
      const source = options.resolveAssetUrl?.(scene.picture.assetId);
      if (typeof source !== 'string' || !source.startsWith('file:')) {
        throw new Error('Native cue picture asset is unavailable');
      }
      const image = document.createElement('img');
      image.className = 'native-scene-picture';
      image.alt = scene.picture.altText;
      image.src = source;
      image.style.objectFit = scene.picture.fit === 'stretch'
        ? 'fill'
        : scene.picture.fit === 'fill' ? 'cover' : 'contain';
      image.style.objectPosition = `${scene.picture.focalPoint.x * 100}% ${scene.picture.focalPoint.y * 100}%`;
      surface.appendChild(image);
      images.push(image);
      if (scene.picture.attribution) {
        const attribution = document.createElement('div');
        attribution.className = 'native-scene-attribution';
        attribution.textContent = scene.picture.attribution;
        surface.appendChild(attribution);
        children.push({
          relayout(scale) {
            attribution.style.fontSize = `${24 * scale}px`;
          }
        });
      }
    } else if (scene.layout === 'video') {
      const source = options.resolveAssetUrl?.(scene.video.assetId);
      if (typeof source !== 'string' || !source.startsWith('file:')) {
        throw new Error('Native cue video asset is unavailable');
      }
      const video = document.createElement('video');
      video.className = 'native-scene-video';
      video.src = source;
      video.preload = 'auto';
      video.playsInline = true;
      video.controls = false;
      video.muted = scene.video.muted;
      video.style.objectFit = scene.video.fit === 'stretch'
        ? 'fill'
        : scene.video.fit === 'fill' ? 'cover' : 'contain';
      video.addEventListener('playing', () => publishVideoState('playing'));
      video.addEventListener('pause', () => {
        if (!video.ended && videoState !== 'armed') publishVideoState('paused');
      });
      video.addEventListener('ended', () => publishVideoState('ended'));
      video.addEventListener('error', () => publishVideoState('error', 'Video playback failed'));
      surface.appendChild(video);
      videos.push(video);
    } else if (scene.layout === 'singer-current-next') {
      const currentHost = document.createElement('div');
      currentHost.className = 'native-singer-current';
      const current = buildScene(scene.current, options);
      currentHost.appendChild(current.element);
      const next = document.createElement('div');
      next.className = 'native-singer-next';
      const nextText = document.createElement('span');
      nextText.className = 'native-singer-next-text';
      next.appendChild(nextText);
      next.classList.add(`native-singer-${scene.next.state}`);
      next.dataset.nextState = scene.next.state;
      nextText.textContent = scene.next.state === 'text'
        ? scene.next.text
        : scene.next.state === 'end' ? 'End of presentation' : '';
      next.style.color = scene.next.state === 'end' ? '#6b7280' : '#f8fafc';
      next.style.fontWeight = scene.next.state === 'end' ? '400' : '500';
      surface.append(currentHost, next);
      children.push(current);
      children.push({
        relayout(scale) {
          next.style.borderTopWidth = `${Math.max(4, scene.canvas.height * 0.011 * scale)}px`;
          // The current scene has already fitted its text. Keep that exact
          // on-screen typography and let CSS ellipsize the next line's prefix.
          const primary = currentHost.querySelector('.native-scene-body')
            || currentHost.querySelector('.native-song-title-text')
            || currentHost.querySelector('.native-scene-title');
          const typography = primary ? global.getComputedStyle(primary) : null;
          nextText.style.fontSize = typography?.fontSize || `${scene.canvas.height * 0.075 * scale}px`;
          nextText.style.fontWeight = typography?.fontWeight || '600';
          nextText.style.fontFamily = typography?.fontFamily || 'inherit';
        }
      });
    }

    function relayout() {
      const scale = fitSurface(host, surface, scene.canvas);
      for (const child of children) {
        if (typeof child.relayout === 'function') child.relayout(scale);
      }
      return scale;
    }

    async function prepare() {
      await Promise.all([
        ...images.map(imageReady),
        ...videos.map(videoReady)
      ]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      relayout();
      await Promise.all(children
        .filter(child => typeof child.prepare === 'function')
        .map(child => child.prepare()));
      relayout();
      if (scene.layout === 'video') publishVideoState('armed');
    }

    async function playVideo() {
      if (scene.layout !== 'video') {
        const nested = children.find(child => child.videoState?.() !== 'not-video');
        return nested ? nested.playVideo() : false;
      }
      const video = videos[0];
      if (video.ended) video.currentTime = 0;
      try {
        await video.play();
        publishVideoState('playing');
        return true;
      } catch (error) {
        publishVideoState('error', error instanceof Error ? error.message : 'Video playback failed');
        throw error;
      }
    }

    function pauseVideo() {
      if (scene.layout !== 'video') {
        const nested = children.find(child => child.videoState?.() !== 'not-video');
        return nested ? nested.pauseVideo() : false;
      }
      const video = videos[0];
      video.pause();
      if (!video.ended && videoState !== 'armed') publishVideoState('paused');
      return true;
    }

    function stopVideo() {
      if (scene.layout !== 'video') {
        const nested = children.find(child => child.videoState?.() !== 'not-video');
        return nested ? nested.stopVideo() : false;
      }
      const video = videos[0];
      video.pause();
      try {
        video.currentTime = 0;
      } catch (_error) {
        // A media element may reject seeking while it is being detached.
      }
      publishVideoState('armed');
      return true;
    }

    function destroy() {
      for (const video of videos) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      for (const child of children) child.destroy?.();
    }

    return {
      element: host,
      scene,
      prepare,
      relayout,
      videoState: () => {
        if (scene.layout === 'video') return videoState;
        const nested = children.find(child => child.videoState?.() !== 'not-video');
        return nested ? nested.videoState() : 'not-video';
      },
      playVideo,
      pauseVideo,
      stopVideo,
      destroy
    };
  }

  global.SyncShowNativeCueRenderer = Object.freeze({
    buildScene,
    validateScene
  });
})(window);
