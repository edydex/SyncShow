'use strict';

const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX_COLOR_PATTERN = /^#[a-fA-F0-9]{6}$/;
const TEXT_KINDS = Object.freeze(['song', 'bible', 'sermon', 'notice']);
const RENDER_MODES = Object.freeze(['text', 'picture', 'blank', 'legacy']);
const TEXT_ALIGNMENTS = Object.freeze(['left', 'center', 'right']);
const TEXT_VERTICAL_POSITIONS = Object.freeze(['center', 'top']);

// Existing preset values intentionally remain byte-for-byte equivalent to the
// first native renderer. Adding a preset must not restyle a project that
// already points at one of these stable IDs.
const RAW_PRESETS = [
  {
    id: 'default-text',
    label: 'Safe text',
    description: 'Compatibility fallback for an older or unavailable text preset.',
    selectable: false,
    kinds: TEXT_KINDS,
    render: {
      mode: 'text',
      background: '#0b1220',
      bodySize: 62,
      bodyHeight: 690,
      bodyMinimumSize: 34,
      titleSize: 38,
      titleMinimumSize: 24,
      showTitle: true,
      bodyWeight: '500'
    }
  },
  {
    id: 'song-title',
    label: 'Song title',
    description: 'Large centered song title.',
    selectable: true,
    kinds: ['song'],
    render: {
      mode: 'text',
      background: '#04070d',
      bodySize: 82,
      bodyHeight: 690,
      bodyMinimumSize: 34,
      titleSize: 40,
      titleMinimumSize: 24,
      showTitle: true,
      bodyWeight: '500'
    }
  },
  {
    id: 'song-lyrics',
    label: 'Song lyrics',
    description: 'Normal lyrics with generous line capacity.',
    selectable: true,
    kinds: ['song'],
    render: {
      mode: 'text',
      background: '#04070d',
      bodySize: 76,
      bodyHeight: 760,
      bodyMinimumSize: 34,
      titleSize: 34,
      titleMinimumSize: 24,
      showTitle: false,
      bodyWeight: '600'
    }
  },
  {
    id: 'song-lyrics-large',
    label: 'Large song lyrics',
    description: 'Larger lyrics for short one- or two-line slides.',
    selectable: true,
    kinds: ['song'],
    render: {
      mode: 'text',
      background: '#04070d',
      bodySize: 94,
      bodyHeight: 760,
      bodyMinimumSize: 38,
      titleSize: 34,
      titleMinimumSize: 24,
      showTitle: false,
      bodyWeight: '600'
    }
  },
  {
    id: 'scripture-text',
    label: 'Scripture',
    description: 'Reference heading with readable multi-verse text.',
    selectable: true,
    kinds: ['bible'],
    render: {
      mode: 'text',
      background: '#071326',
      bodySize: 52,
      bodyHeight: 690,
      bodyMinimumSize: 28,
      titleSize: 42,
      titleMinimumSize: 24,
      showTitle: true,
      bodyWeight: '500'
    }
  },
  {
    id: 'scripture-large',
    label: 'Large Scripture',
    description: 'Larger text for a short Scripture passage.',
    selectable: true,
    kinds: ['bible'],
    render: {
      mode: 'text',
      background: '#071326',
      bodySize: 68,
      bodyHeight: 710,
      bodyMinimumSize: 32,
      titleSize: 42,
      titleMinimumSize: 24,
      showTitle: true,
      bodyWeight: '500'
    }
  },
  {
    id: 'sermon-title',
    label: 'Sermon title',
    description: 'Large title treatment for a sermon or major section.',
    selectable: true,
    kinds: ['sermon'],
    render: {
      mode: 'text',
      background: '#101a33',
      bodySize: 84,
      bodyHeight: 690,
      bodyMinimumSize: 38,
      titleSize: 42,
      titleMinimumSize: 24,
      showTitle: true,
      bodyWeight: '600'
    }
  },
  {
    id: 'sermon-point',
    label: 'Sermon point',
    description: 'Readable title and body for a teaching point.',
    selectable: true,
    kinds: ['sermon'],
    render: {
      mode: 'text',
      background: '#101a33',
      bodySize: 68,
      bodyHeight: 690,
      bodyMinimumSize: 34,
      titleSize: 38,
      titleMinimumSize: 24,
      showTitle: true,
      bodyWeight: '500'
    }
  },
  {
    id: 'sermon-notes',
    label: 'Sermon notes',
    description: 'Black teaching slide with a gold title, highlighted Scripture references, and a wide left-aligned body.',
    selectable: true,
    kinds: ['sermon'],
    render: {
      mode: 'text',
      background: '#000000',
      bodySize: 64,
      bodyHeight: 720,
      bodyMinimumSize: 28,
      titleSize: 64,
      titleMinimumSize: 32,
      showTitle: true,
      bodyWeight: '500',
      titleForeground: '#ffc000',
      bodyForeground: '#f8fafc',
      titleWeight: '700',
      titleAlign: 'left',
      bodyAlign: 'left',
      bodyWidthPercent: 96,
      titleTopPercent: 4,
      bodyTopPercent: 17,
      bodyPosition: 'top',
      lineSpacingPercent: 25,
      paragraphGap: true,
      leadingReferenceStyle: 'scripture',
      leadingReferenceForeground: '#ffc000',
      leadingReferenceWeight: '700'
    }
  },
  {
    id: 'notice-text',
    label: 'Notice',
    description: 'Simple title and text for an announcement.',
    selectable: true,
    kinds: ['notice'],
    render: {
      mode: 'text',
      background: '#15223f',
      bodySize: 62,
      bodyHeight: 690,
      bodyMinimumSize: 34,
      titleSize: 38,
      titleMinimumSize: 24,
      showTitle: true,
      bodyWeight: '500'
    }
  },
  {
    id: 'picture-fullscreen',
    label: 'Full-screen picture',
    description: 'Picture using its selected Fit, Fill, or Stretch behavior.',
    selectable: true,
    kinds: ['picture'],
    render: { mode: 'picture' }
  },
  {
    id: 'blank-black',
    label: 'Black',
    description: 'A fully black output frame.',
    selectable: true,
    kinds: ['blank'],
    render: { mode: 'blank' }
  },
  {
    id: 'legacy-slide',
    label: 'Imported slide',
    description: 'A rendered slide from an imported presentation.',
    selectable: false,
    kinds: ['slide'],
    render: { mode: 'legacy' }
  }
];

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeDeep);
  return Object.freeze(value);
}

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function validateTextRender(raw, presetId) {
  if (!HEX_COLOR_PATTERN.test(raw.background || '')) {
    throw new TypeError(`Native preset ${presetId} needs a six-digit background color.`);
  }
  const bodyWeight = String(raw.bodyWeight || '');
  if (!/^[1-9]00$/.test(bodyWeight)) {
    throw new TypeError(`Native preset ${presetId} has an invalid body weight.`);
  }
  const render = {
    mode: 'text',
    background: raw.background.toLowerCase(),
    bodySize: requireInteger(raw.bodySize, `${presetId} bodySize`, 14, 240),
    bodyHeight: requireInteger(raw.bodyHeight, `${presetId} bodyHeight`, 50, 1080),
    bodyMinimumSize: requireInteger(raw.bodyMinimumSize, `${presetId} bodyMinimumSize`, 14, raw.bodySize),
    titleSize: requireInteger(raw.titleSize, `${presetId} titleSize`, 14, 160),
    titleMinimumSize: requireInteger(raw.titleMinimumSize, `${presetId} titleMinimumSize`, 14, raw.titleSize),
    showTitle: raw.showTitle === true,
    bodyWeight
  };
  for (const field of ['titleForeground', 'bodyForeground']) {
    if (raw[field] === undefined) continue;
    if (!HEX_COLOR_PATTERN.test(raw[field])) {
      throw new TypeError(`Native preset ${presetId} has an invalid ${field} color.`);
    }
    render[field] = raw[field].toLowerCase();
  }
  if (raw.titleWeight !== undefined) {
    const titleWeight = String(raw.titleWeight);
    if (!/^[1-9]00$/.test(titleWeight)) {
      throw new TypeError(`Native preset ${presetId} has an invalid title weight.`);
    }
    render.titleWeight = titleWeight;
  }
  for (const field of ['titleAlign', 'bodyAlign']) {
    if (raw[field] === undefined) continue;
    if (!TEXT_ALIGNMENTS.includes(raw[field])) {
      throw new TypeError(`Native preset ${presetId} has an invalid ${field} alignment.`);
    }
    render[field] = raw[field];
  }
  if (raw.bodyWidthPercent !== undefined) {
    render.bodyWidthPercent = requireInteger(
      raw.bodyWidthPercent,
      `${presetId} bodyWidthPercent`,
      50,
      100
    );
  }
  for (const field of ['titleTopPercent', 'bodyTopPercent']) {
    if (raw[field] === undefined) continue;
    render[field] = requireInteger(raw[field], `${presetId} ${field}`, 0, 80);
  }
  if (raw.bodyPosition !== undefined) {
    if (!TEXT_VERTICAL_POSITIONS.includes(raw.bodyPosition)) {
      throw new TypeError(`Native preset ${presetId} has an invalid bodyPosition.`);
    }
    render.bodyPosition = raw.bodyPosition;
  }
  if (raw.lineSpacingPercent !== undefined) {
    render.lineSpacingPercent = requireInteger(
      raw.lineSpacingPercent,
      `${presetId} lineSpacingPercent`,
      0,
      200
    );
  }
  if (raw.paragraphGap !== undefined) {
    if (typeof raw.paragraphGap !== 'boolean') {
      throw new TypeError(`Native preset ${presetId} has an invalid paragraphGap.`);
    }
    render.paragraphGap = raw.paragraphGap;
  }
  if (raw.leadingReferenceStyle !== undefined) {
    if (raw.leadingReferenceStyle !== 'scripture') {
      throw new TypeError(`Native preset ${presetId} has an invalid leadingReferenceStyle.`);
    }
    if (!HEX_COLOR_PATTERN.test(raw.leadingReferenceForeground || '')) {
      throw new TypeError(`Native preset ${presetId} has an invalid leadingReferenceForeground color.`);
    }
    const leadingReferenceWeight = String(raw.leadingReferenceWeight || '');
    if (!/^[1-9]00$/.test(leadingReferenceWeight)) {
      throw new TypeError(`Native preset ${presetId} has an invalid leadingReferenceWeight.`);
    }
    render.leadingReferenceStyle = raw.leadingReferenceStyle;
    render.leadingReferenceForeground = raw.leadingReferenceForeground.toLowerCase();
    render.leadingReferenceWeight = leadingReferenceWeight;
  }
  return render;
}

function validatePreset(raw, seenIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Every native preset must be an object.');
  }
  const presetId = String(raw.id || '');
  if (!PRESET_ID_PATTERN.test(presetId) || seenIds.has(presetId)) {
    throw new TypeError(`Native preset id ${presetId || '(empty)'} is invalid or duplicated.`);
  }
  seenIds.add(presetId);
  const label = String(raw.label || '').trim();
  const description = String(raw.description || '').trim();
  if (!label || label.length > 120 || !description || description.length > 300) {
    throw new TypeError(`Native preset ${presetId} needs a concise label and description.`);
  }
  if (!Array.isArray(raw.kinds) || raw.kinds.length < 1 || new Set(raw.kinds).size !== raw.kinds.length) {
    throw new TypeError(`Native preset ${presetId} needs unique supported cue kinds.`);
  }
  const kinds = raw.kinds.map(kind => String(kind));
  const mode = raw.render?.mode;
  if (!RENDER_MODES.includes(mode)) throw new TypeError(`Native preset ${presetId} has an invalid render mode.`);
  if (mode === 'text' && kinds.some(kind => !TEXT_KINDS.includes(kind))) {
    throw new TypeError(`Native text preset ${presetId} supports a non-text cue kind.`);
  }
  return {
    id: presetId,
    label,
    description,
    selectable: raw.selectable === true,
    kinds,
    render: mode === 'text' ? validateTextRender(raw.render, presetId) : { mode }
  };
}

const seenIds = new Set();
const NATIVE_PRESETS = freezeDeep(RAW_PRESETS.map(raw => validatePreset(raw, seenIds)));
const NATIVE_PRESET_BY_ID = freezeDeep(Object.fromEntries(
  NATIVE_PRESETS.map(preset => [preset.id, preset])
));
const DEFAULT_NATIVE_TEXT_PRESET_ID = 'default-text';
const NATIVE_PRESET_CATALOG_VERSION = 3;
const NATIVE_RENDERER_VERSION = 6;

function getNativePreset(presetId) {
  return typeof presetId === 'string' ? NATIVE_PRESET_BY_ID[presetId] || null : null;
}

function isNativePresetAllowed(presetId, kind) {
  const preset = getNativePreset(presetId);
  return Boolean(preset?.selectable && preset.kinds.includes(kind));
}

function listNativePresets(kind = null) {
  return NATIVE_PRESETS.filter(preset =>
    preset.selectable && (kind === null || preset.kinds.includes(kind)));
}

function resolveNativeTextPreset(presetId) {
  const preset = getNativePreset(presetId);
  if (preset?.render.mode === 'text') return preset;
  return NATIVE_PRESET_BY_ID[DEFAULT_NATIVE_TEXT_PRESET_ID];
}

module.exports = {
  DEFAULT_NATIVE_TEXT_PRESET_ID,
  NATIVE_PRESET_CATALOG_VERSION,
  NATIVE_PRESETS,
  NATIVE_RENDERER_VERSION,
  getNativePreset,
  isNativePresetAllowed,
  listNativePresets,
  resolveNativeTextPreset
};
