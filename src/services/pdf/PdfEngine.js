'use strict';

const path = require('path');

const PDFJS_PACKAGE = require('pdfjs-dist/package.json');

const PDF_RENDERER_ID = 'pdfjs-dist';
const PDF_RENDERER_ADAPTER_VERSION = 1;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const MAX_PDF_PAGES = 4096;
const MAX_RENDER_DIMENSION = 8192;
const MAX_SOURCE_IMAGE_PIXELS = 100_000_000;
const CANVAS_MAX_AREA_BYTES = 128 * 1024 * 1024;

const PDF_RENDERER_PROVENANCE = Object.freeze({
  id: PDF_RENDERER_ID,
  version: PDFJS_PACKAGE.version,
  adapterVersion: PDF_RENDERER_ADAPTER_VERSION
});

const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_RESOURCE_PATHS = Object.freeze({
  // PDF.js validates these as URL-like strings and requires a literal
  // trailing slash on every platform. Windows fs accepts the resulting
  // mixed-separator local path when the Node binary-data factory reads it.
  cMapUrl: `${path.join(PDFJS_ROOT, 'cmaps')}/`,
  iccUrl: `${path.join(PDFJS_ROOT, 'iccs')}/`,
  standardFontDataUrl: `${path.join(PDFJS_ROOT, 'standard_fonts')}/`,
  wasmUrl: `${path.join(PDFJS_ROOT, 'wasm')}/`
});

let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(error => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}

function copyPdfBytes(input) {
  let source;
  if (input instanceof ArrayBuffer) {
    source = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    source = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError('PDF data must be an ArrayBuffer or typed-array view.');
  }

  if (source.byteLength < 1) {
    throw new Error('PDF data is empty.');
  }
  if (source.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF data exceeds the ${MAX_PDF_BYTES}-byte safety limit.`);
  }

  // PDF.js transfers ownership of its input buffer to its fake worker. Always
  // give it an isolated copy so caller-owned Buffers cannot become detached.
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function validatePageIndex(pageIndex, pageCount) {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
    throw new RangeError(`PDF page index ${pageIndex} is outside 0-${pageCount - 1}.`);
  }
}

function validateRenderBound(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RENDER_DIMENSION) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${MAX_RENDER_DIMENSION}.`
    );
  }
  return value;
}

function contextualizePdfError(error, context) {
  const detail = error instanceof Error ? error.message : String(error);
  const contextualized = new Error(`${context}: ${detail}`, {
    cause: error instanceof Error ? error : undefined
  });
  if (error && typeof error.code === 'string') contextualized.code = error.code;
  return contextualized;
}

function safePrefix(value, maximumCharacters) {
  if (value.length <= maximumCharacters) return value;
  let end = maximumCharacters;
  if (end > 0) {
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function normalizePdfRendererProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PDF renderer provenance must be an object.');
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = ['adapterVersion', 'id', 'version'];
  if (keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('PDF renderer provenance contains unexpected fields.');
  }

  if (typeof value.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.id)) {
    throw new Error('PDF renderer provenance has an invalid id.');
  }
  if (typeof value.version !== 'string' ||
      !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(value.version)) {
    throw new Error('PDF renderer provenance has an invalid version.');
  }
  if (!Number.isSafeInteger(value.adapterVersion) ||
      value.adapterVersion < 1 ||
      value.adapterVersion > 10_000) {
    throw new Error('PDF renderer provenance has an invalid adapter version.');
  }

  return Object.freeze({
    id: value.id,
    version: value.version,
    adapterVersion: value.adapterVersion
  });
}

class PdfDocument {
  constructor(loadingTask, document, pdfjs) {
    this._loadingTask = loadingTask;
    this._document = document;
    this._pdfjs = pdfjs;
    this._closed = false;
    this.pageCount = document.numPages;
  }

  _assertOpen() {
    if (this._closed) throw new Error('The PDF document is already closed.');
  }

  async renderPageToPng(pageIndex, options = {}) {
    this._assertOpen();
    validatePageIndex(pageIndex, this.pageCount);
    const maximumWidth = validateRenderBound(options.maximumWidth, 'maximumWidth');
    const maximumHeight = validateRenderBound(options.maximumHeight, 'maximumHeight');

    let page;
    let canvasAndContext;
    try {
      page = await this._document.getPage(pageIndex + 1);
      const baseViewport = page.getViewport({ scale: 1 });
      if (!Number.isFinite(baseViewport.width) ||
          !Number.isFinite(baseViewport.height) ||
          baseViewport.width <= 0 ||
          baseViewport.height <= 0) {
        throw new Error('PDF page has invalid dimensions.');
      }

      const scale = Math.min(
        maximumWidth / baseViewport.width,
        maximumHeight / baseViewport.height
      );
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error('PDF page could not be scaled to the requested bounds.');
      }

      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.min(maximumWidth, Math.round(viewport.width)));
      const height = Math.max(1, Math.min(maximumHeight, Math.round(viewport.height)));
      canvasAndContext = this._document.canvasFactory.create(width, height);

      await page.render({
        canvasContext: canvasAndContext.context,
        canvas: canvasAndContext.canvas,
        viewport,
        annotationMode: this._pdfjs.AnnotationMode.ENABLE,
        background: 'rgba(0, 0, 0, 0)'
      }).promise;

      return {
        width,
        height,
        png: canvasAndContext.canvas.toBuffer('image/png')
      };
    } catch (error) {
      throw contextualizePdfError(
        error,
        `Could not render PDF page ${pageIndex + 1}`
      );
    } finally {
      if (canvasAndContext) {
        this._document.canvasFactory.destroy(canvasAndContext);
      }
      if (page) page.cleanup();
    }
  }

  async extractPageText(pageIndex, options = {}) {
    this._assertOpen();
    validatePageIndex(pageIndex, this.pageCount);
    const maximumCharacters = options.maximumCharacters;
    if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 0) {
      throw new RangeError('maximumCharacters must be a non-negative integer.');
    }
    if (maximumCharacters === 0) {
      return { text: '', truncated: true };
    }

    let page;
    let reader;
    const chunks = [];
    let length = 0;
    let truncated = false;

    const append = value => {
      if (!value) return;
      const remaining = maximumCharacters - length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const prefix = safePrefix(value, remaining);
      chunks.push(prefix);
      length += prefix.length;
      if (prefix.length < value.length) truncated = true;
    };

    try {
      page = await this._document.getPage(pageIndex + 1);
      reader = page.streamTextContent({
        includeMarkedContent: false,
        disableNormalization: false
      }).getReader();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (truncated) continue;
        for (const item of value.items || []) {
          if (!item || typeof item.str !== 'string') continue;
          append(item.str);
          if (!truncated && item.hasEOL) append('\n');
          if (truncated) break;
        }
      }

      return {
        text: chunks.join(''),
        truncated
      };
    } catch (error) {
      throw contextualizePdfError(
        error,
        `Could not extract text from PDF page ${pageIndex + 1}`
      );
    } finally {
      if (reader) reader.releaseLock();
      if (page) page.cleanup();
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    const loadingTask = this._loadingTask;
    this._document = null;
    this._loadingTask = null;
    await loadingTask.destroy();
  }
}

async function openPdf(input) {
  const pdfjs = await getPdfjs();
  const data = copyPdfBytes(input);
  const loadingTask = pdfjs.getDocument({
    data,
    ...PDFJS_RESOURCE_PATHS,
    cMapPacked: true,
    useWorkerFetch: false,
    useWasm: true,
    stopAtErrors: true,
    maxImageSize: MAX_SOURCE_IMAGE_PIXELS,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    canvasMaxAreaInBytes: CANVAS_MAX_AREA_BYTES,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: pdfjs.VerbosityLevel.WARNINGS
  });

  try {
    const document = await loadingTask.promise;
    if (!Number.isSafeInteger(document.numPages) ||
        document.numPages < 1 ||
        document.numPages > MAX_PDF_PAGES) {
      throw new Error(
        `PDF page count must be between 1 and ${MAX_PDF_PAGES}; received ${document.numPages}.`
      );
    }
    return new PdfDocument(loadingTask, document, pdfjs);
  } catch (error) {
    await loadingTask.destroy().catch(() => {});
    throw error;
  }
}

module.exports = {
  CANVAS_MAX_AREA_BYTES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  MAX_RENDER_DIMENSION,
  MAX_SOURCE_IMAGE_PIXELS,
  PDF_RENDERER_ADAPTER_VERSION,
  PDF_RENDERER_ID,
  PDF_RENDERER_PROVENANCE,
  PDFJS_RESOURCE_PATHS,
  normalizePdfRendererProvenance,
  openPdf
};
