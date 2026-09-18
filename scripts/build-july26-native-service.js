#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  LocalSermonSourceStore,
  ServiceProjectExchange,
  ServiceProjectStore,
  ShowPackagePublisher,
  addBibleItem,
  addSermonResource,
  analyzeServiceProjectReadiness,
  compileServiceProject,
  extractSermonSourceProposal,
  normalizeSermonDocument,
  removeProjectItemAndDescendants,
  setSermonSourceLink
} = require('../src/services/project');
const {
  createHeritageServiceDocument,
  heritageServiceDocumentRevision,
  serializeHeritageServiceDocument
} = require('../src/services/community/HeritageServiceDocument');
const {
  buildImportPlan,
  resolveSafeOutputRoot
} = require('./lib/service-deck-importer');

const APP_VERSION = require('../package.json').version;
const SERVICE_DATE = '2026-07-26';
const FIXED_BUILD_TIME = '2026-07-26T16:00:00.000Z';
const PROJECT_ID = 'wotbc-service-2026-07-26';
const SERMON_ID = 'wotbc-sermon-2026-07-26-prayer-transforms-church';
const PRIMARY_REFERENCE_ID = 'primary-eph-3-14-21';
const DEFAULT_OUTPUT_DIRECTORY = path.join('dist', 'pilot', '2026-07-26');
const SERVICE_BUNDLE_FILE = '2026-07-26-wotbc-native.syncshow-service';
const SERVICE_DOCUMENT_FILE = '2026-07-26-wotbc.heritage-service.json';
const BUILD_REPORT_FILE = '2026-07-26-wotbc-native-build-report.json';
const SHOW_PACKAGE_DIRECTORY = 'show-packages';

function usage() {
  return [
    'Usage:',
    '  node scripts/build-july26-native-service.js \\',
    '    --eng /absolute/07-26-2026-Service-ENG.pptx \\',
    '    --rus /absolute/07-26-2026-Service-RUS.pptx \\',
    '    --media /absolute/07-26-2026-Media.pptx \\',
    '    --manuscript /absolute/07-26-26-sermon.pdf \\',
    '    --media-sermon-title-image /absolute/rendered-media-slide-68.png \\',
    '    --work-root /absolute/new-private-work-root',
    '',
    'Optional:',
    '  --output-directory PATH   Defaults to dist/pilot/2026-07-26.',
    '',
    'The Media deck uses editable text and shapes for slide 68, while the other',
    'two decks contain a source-composed image there. Supply a visually reviewed',
    'render of Media slide 68 so the single native picture position remains',
    'one-for-one across all outputs. The three PPTX files are evidence only and',
    'are not embedded as editable or legacy-deck items.'
  ].join('\n');
}

function valueAfter(argumentsList, index, flag) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    const fieldByFlag = {
      '--eng': 'engPath',
      '--rus': 'rusPath',
      '--media': 'mediaPath',
      '--manuscript': 'manuscriptPath',
      '--media-sermon-title-image': 'mediaSermonTitleImagePath',
      '--work-root': 'workRoot',
      '--output-directory': 'outputDirectory'
    };
    const field = fieldByFlag[argument];
    if (!field) throw new Error(`Unknown option: ${argument}`);
    options[field] = path.resolve(valueAfter(argumentsList, index, argument));
    index += 1;
  }
  return options;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function range(bookId, chapter, verseStart, verseEnd = verseStart) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function serviceGroup(id, title, parentId = 'service', groupKind = 'section') {
  return { id, kind: 'group', title, groupKind, parentId };
}

function blank(id, slide, parentId) {
  return {
    id,
    kind: 'blank',
    title: `Intentional blank — source slide ${slide}`,
    parentId,
    operatorNotes: `Intentional black frame preserved from source position ${slide}.`
  };
}

function textItem(id, kind, slide, parentId, options = {}) {
  return {
    id,
    kind,
    title: options.title || `Source slide ${slide}`,
    parentId,
    ...(options.presetId ? { presetId: options.presetId } : {}),
    ...(options.operatorNotes ? { operatorNotes: options.operatorNotes } : {}),
    channels: {
      russian: { deck: 'rus', slides: slide },
      english: { deck: 'eng', slides: slide },
      media: { deck: 'media', slides: slide }
    }
  };
}

function pictureItem(id, title, slide, parentId, options = {}) {
  const channels = {
    russian: { deck: 'rus' },
    english: { deck: 'eng' },
    media: { deck: 'media' }
  };
  if (options.mediaImage) channels.media = { image: options.mediaImage };
  return {
    id,
    kind: 'picture',
    title,
    parentId,
    slide,
    imageIndex: 0,
    fit: 'fit',
    altText: options.altText || title,
    // Keep source provenance in operatorNotes and the build report. Attribution is
    // visible show content, so adding it here would alter the supplied composition.
    attribution: '',
    operatorNotes: options.operatorNotes || 'Reviewed source-composed picture position.',
    channels
  };
}

function songItem({
  id,
  title,
  slideStart,
  slideEnd,
  parentId,
  languages,
  channelTitles = {},
  authors = [],
  composers = []
}) {
  const primarySongId = `${id}-ru`;
  const source = 'Reviewed from the supplied July 26, 2026 service presentations.';
  const license = 'Church-managed use; the hosting church is responsible for its licenses and permissions.';
  const song = (channelId, songId) => ({
    id: songId,
    title: channelTitles[channelId] || title,
    language: languages[channelId],
    ...(channelId === 'russian' ? {} : { translationOf: primarySongId }),
    authors,
    composers,
    license,
    source,
    // The historical source line is evidence, not part of the congregation-facing
    // title treatment. Rights and provenance remain on the resource below.
    attribution: '',
    catalog: channelId === 'russian'
  });
  return {
    id,
    kind: 'song',
    title,
    parentId,
    primaryChannelId: 'russian',
    channels: {
      russian: { deck: 'rus', song: song('russian', primarySongId) },
      english: {
        deck: 'eng',
        catalog: false,
        song: song('english', `${id}-english-output`)
      },
      media: {
        deck: 'media',
        catalog: false,
        song: song('media', `${id}-media-output`)
      }
    },
    sections: Array.from(
      { length: slideEnd - slideStart + 1 },
      (_unused, index) => ({
        id: `source-position-${slideStart + index}`,
        marker: String(index + 1),
        label: `Source position ${slideStart + index}`,
        slides: slideStart + index
      })
    ),
    operatorNotes: `Native editable song reconstructed from source positions ${slideStart - 1}–${slideEnd}.`
  };
}

function july26Manifest() {
  const items = [
    { id: 'service', kind: 'group', title: 'July 26 Service', groupKind: 'service' },
    serviceGroup('welcome', 'Welcome'),
    pictureItem(
      'welcome-picture',
      'Welcome to Word of Truth Bible Church',
      1,
      'welcome',
      { altText: 'English, Russian, and Media welcome treatments.' }
    ),
    serviceGroup('opening-songs', 'Opening songs'),
    songItem({
      id: 'song-glorious-is-our-lord',
      title: 'Славен Господь наш',
      slideStart: 3,
      slideEnd: 9,
      parentId: 'opening-songs',
      languages: { russian: 'ru', english: 'ru', media: 'ru' }
    }),
    blank('blank-010', 10, 'opening-songs'),
    songItem({
      id: 'song-my-jesus-my-savior',
      title: 'Иисус, мой Спаситель / My Jesus, My Savior',
      slideStart: 12,
      slideEnd: 21,
      parentId: 'opening-songs',
      languages: { russian: 'und', english: 'und', media: 'und' },
      channelTitles: { media: 'Иисус, мой Спаситель' }
    }),
    blank('blank-022', 22, 'opening-songs'),
    serviceGroup('john-reading', 'Scripture reading — John 6:28–40'),
    textItem('john-reading-title', 'notice', 23, 'john-reading', {
      title: 'John 6:28–40',
      presetId: 'scripture-title'
    }),
    ...[24, 25, 26, 27].map(slide => textItem(
      `john-reading-placeholder-${slide}`,
      'notice',
      slide,
      'john-reading',
      { title: `John 6 reading — source slide ${slide}`, presetId: 'scripture-text' }
    )),
    blank('blank-028', 28, 'john-reading'),
    serviceGroup('pre-sermon-worship', 'Pre-sermon worship'),
    songItem({
      id: 'song-doxology-god-be-praised',
      title: 'Doxology (God Be Praised) / Славословие',
      slideStart: 30,
      slideEnd: 38,
      parentId: 'pre-sermon-worship',
      languages: { russian: 'und', english: 'und', media: 'en' },
      channelTitles: { media: 'Doxology (God Be Praised)' },
      authors: ['Todd Fields', 'Thomas Ken'],
      composers: ['Todd Fields', 'Thomas Ken']
    }),
    blank('blank-039', 39, 'pre-sermon-worship'),
    songItem({
      id: 'song-we-believe',
      title: 'Веруем',
      slideStart: 41,
      slideEnd: 51,
      parentId: 'pre-sermon-worship',
      languages: { russian: 'ru', english: 'ru', media: 'ru' }
    }),
    blank('blank-052', 52, 'pre-sermon-worship'),
    songItem({
      id: 'song-trust-and-obey',
      title: 'Слушайся, верь! / Trust and Obey',
      slideStart: 54,
      slideEnd: 61,
      parentId: 'pre-sermon-worship',
      languages: { russian: 'und', english: 'und', media: 'ru' },
      channelTitles: { media: 'Слушайся, верь!' }
    }),
    blank('blank-062', 62, 'pre-sermon-worship'),
    serviceGroup('sermon', 'The Prayer That Transforms the Church', 'service', 'sermon'),
    textItem('sermon-reading-title', 'notice', 63, 'sermon', {
      title: 'Ephesians 3:14–21',
      presetId: 'scripture-title'
    }),
    ...[64, 65, 66].map(slide => textItem(
      `sermon-reading-placeholder-${slide}`,
      'notice',
      slide,
      'sermon',
      { title: `Ephesians 3 reading — source slide ${slide}`, presetId: 'scripture-text' }
    )),
    blank('blank-067', 67, 'sermon'),
    pictureItem(
      'sermon-title-picture',
      'The Prayer That Transforms the Church — series title',
      68,
      'sermon',
      {
        mediaImage: 'media-sermon-title',
        altText: 'From Pain to Unity, sermon 9: The Prayer That Transforms the Church.',
        operatorNotes: 'Reviewed source-composed title; Media uses the reviewed full-slide render.'
      }
    ),
    serviceGroup('sermon-introduction', 'Sermon introduction', 'sermon', 'section'),
    ...[69, 70, 71].map(slide => textItem(
      `sermon-slide-${slide}`,
      'sermon',
      slide,
      'sermon-introduction',
      { title: `Sermon introduction — source slide ${slide}`, presetId: 'sermon-notes' }
    )),
    serviceGroup('sermon-foundation', 'I. The Foundation of the Prayer', 'sermon', 'point'),
    ...[72, 73, 74].map(slide => textItem(
      `sermon-slide-${slide}`,
      'sermon',
      slide,
      'sermon-foundation',
      { title: `Foundation — source slide ${slide}`, presetId: 'sermon-notes' }
    )),
    serviceGroup('sermon-content', 'II. The Content of the Prayer', 'sermon', 'section'),
    ...[75, 76].map(slide => textItem(
      `sermon-slide-${slide}`,
      'sermon',
      slide,
      'sermon-content',
      { title: `Content — source slide ${slide}`, presetId: 'sermon-notes' }
    )),
    serviceGroup('sermon-strengthened', 'A. To Be Strengthened by the Holy Spirit', 'sermon-content', 'point'),
    ...Array.from({ length: 10 }, (_unused, index) => 77 + index).map(slide => textItem(
      `sermon-slide-${slide}`,
      'sermon',
      slide,
      'sermon-strengthened',
      { title: `Strengthened — source slide ${slide}`, presetId: 'sermon-notes' }
    )),
    serviceGroup('sermon-know-love', 'B. To Know the Love of Christ', 'sermon-content', 'point'),
    ...[87, 88, 89].map(slide => textItem(
      `sermon-slide-${slide}`,
      'sermon',
      slide,
      'sermon-know-love',
      { title: `Know Christ's love — source slide ${slide}`, presetId: 'sermon-notes' }
    )),
    serviceGroup('sermon-fullness', 'C. To Be Filled with the Fullness of God', 'sermon-content', 'point'),
    ...[90, 91, 92, 93, 94].map(slide => textItem(
      `sermon-slide-${slide}`,
      'sermon',
      slide,
      'sermon-fullness',
      { title: `Filled with God's fullness — source slide ${slide}`, presetId: 'sermon-notes' }
    )),
    serviceGroup('sermon-confidence', 'III. The Confidence of the Prayer', 'sermon', 'point'),
    ...[95, 96, 97, 98, 99].map(slide => textItem(
      `sermon-slide-${slide}`,
      'sermon',
      slide,
      'sermon-confidence',
      { title: `Confidence — source slide ${slide}`, presetId: 'sermon-notes' }
    )),
    blank('blank-100', 100, 'sermon'),
    serviceGroup('closing', 'Closing'),
    songItem({
      id: 'song-love-of-god',
      title: 'Любовь Господня / The Love of God',
      slideStart: 102,
      slideEnd: 110,
      parentId: 'closing',
      languages: { russian: 'und', english: 'und', media: 'ru' },
      channelTitles: { media: 'Любовь Господня' }
    }),
    blank('blank-111', 111, 'closing'),
    pictureItem(
      'closing-picture',
      'Thank you for attending',
      112,
      'closing',
      { altText: 'English, Russian, and Media closing treatments.' }
    )
  ];

  return {
    schemaVersion: 1,
    project: {
      id: PROJECT_ID,
      title: 'Word of Truth Bible Church — July 26, 2026',
      serviceDate: SERVICE_DATE,
      preferredProfileId: 'main-sanctuary',
      createdAt: FIXED_BUILD_TIME,
      channels: [
        { id: 'russian', label: 'Russian', language: 'ru' },
        { id: 'english', label: 'English', language: 'en' },
        { id: 'media', label: 'Media', language: 'und' }
      ]
    },
    items
  };
}

function mentionedReference(id, bookId, chapter, verseStart, verseEnd, enteredText, sectionId) {
  return {
    id,
    range: range(bookId, chapter, verseStart, verseEnd),
    role: 'mentioned',
    source: 'manuscript',
    reviewStatus: 'confirmed',
    enteredText,
    sourceId: 'pastor-manuscript',
    sectionId,
    startOffset: null,
    endOffset: null
  };
}

function july26Sermon(source, extraction) {
  const reviewedText = extraction.units
    .map(unit => unit.text)
    .filter(Boolean)
    .join('\n\n');
  requireCondition(reviewedText.length > 1000, 'The reviewed manuscript extraction is unexpectedly empty.');
  requireCondition(
    extraction.truncated.units === false && extraction.truncated.text === false,
    'The reviewed manuscript extraction is truncated and cannot become the canonical body.'
  );

  return normalizeSermonDocument({
    schemaVersion: 3,
    kind: 'syncshow-sermon',
    id: SERMON_ID,
    titles: {
      en: 'The Prayer That Transforms the Church',
      ru: 'Молитва, преображающая Церковь'
    },
    defaultLanguage: 'ru',
    speaker: { id: 'pavel-lvutin', name: 'Павел Львутин' },
    serviceDate: SERVICE_DATE,
    series: {
      id: 'from-pain-to-unity',
      titles: { en: 'From Pain to Unity', ru: 'От боли к единству' }
    },
    outline: [
      {
        id: 'foundation',
        parentId: null,
        kind: 'section',
        titles: { en: 'The Foundation of the Prayer', ru: 'Основание молитвы' }
      },
      {
        id: 'content',
        parentId: null,
        kind: 'section',
        titles: { en: 'The Content of the Prayer', ru: 'Содержание молитвы' }
      },
      {
        id: 'strengthened',
        parentId: 'content',
        kind: 'point',
        titles: { en: 'To Be Strengthened by the Holy Spirit', ru: 'Укрепились силой Святого Духа' }
      },
      {
        id: 'know-love',
        parentId: 'content',
        kind: 'point',
        titles: { en: 'To Know the Love of Christ', ru: 'Познали любовь Христову' }
      },
      {
        id: 'fullness',
        parentId: 'content',
        kind: 'point',
        titles: { en: 'To Be Filled with the Fullness of God', ru: 'Исполнились полнотой Божией' }
      },
      {
        id: 'confidence',
        parentId: null,
        kind: 'section',
        titles: { en: 'The Confidence of the Prayer', ru: 'Уверенность молитвы' }
      }
    ],
    sources: [source],
    references: [
      {
        id: PRIMARY_REFERENCE_ID,
        range: range('Eph', 3, 14, 21),
        role: 'primary',
        source: 'pastor',
        reviewStatus: 'confirmed',
        enteredText: 'Ephesians 3:14–21 / Ефесянам 3:14–21',
        sourceId: source.id,
        sectionId: null,
        startOffset: null,
        endOffset: null
      },
      mentionedReference('mentioned-eph-1-7', 'Eph', 1, 7, 7, 'Ephesians 1:7', 'strengthened'),
      mentionedReference('mentioned-eph-1-18', 'Eph', 1, 18, 18, 'Ephesians 1:18', 'strengthened'),
      mentionedReference('mentioned-eph-1-19-20', 'Eph', 1, 19, 20, 'Ephesians 1:19–20', 'confidence'),
      mentionedReference('mentioned-eph-2-1-6', 'Eph', 2, 1, 6, 'Ephesians 2:1–6', 'confidence'),
      mentionedReference('mentioned-eph-2-7', 'Eph', 2, 7, 7, 'Ephesians 2:7', 'strengthened'),
      mentionedReference('mentioned-eph-2-14-16', 'Eph', 2, 14, 16, 'Ephesians 2:14–16', 'confidence'),
      mentionedReference('mentioned-eph-3-7', 'Eph', 3, 7, 7, 'Ephesians 3:7', 'confidence'),
      mentionedReference('mentioned-eph-3-8', 'Eph', 3, 8, 8, 'Ephesians 3:8', 'strengthened'),
      mentionedReference('mentioned-eph-3-10', 'Eph', 3, 10, 10, 'Ephesians 3:10', 'confidence'),
      mentionedReference('mentioned-eph-4-13', 'Eph', 4, 13, 13, 'Ephesians 4:13', 'fullness'),
      mentionedReference('mentioned-eph-5-2', 'Eph', 5, 2, 2, 'Ephesians 5:2', 'foundation'),
      mentionedReference('mentioned-eph-5-25', 'Eph', 5, 25, 25, 'Ephesians 5:25', 'foundation'),
      mentionedReference('mentioned-rom-5-5-8', 'Rom', 5, 5, 8, 'Romans 5:5–8', 'strengthened')
    ],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    },
    body: [{
      id: 'reviewed-bilingual-manuscript',
      kind: 'manuscript',
      language: 'ru',
      sourceId: source.id,
      sectionId: null,
      text: reviewedText
    }]
  });
}

function parseVerses(text, expectedNumbers, label) {
  const source = String(text || '').trim();
  const expression = /(?:^|\s)(\d{1,3})[\u00a0\u202f ]+/gu;
  const matches = [...source.matchAll(expression)];
  const byNumber = new Map();

  if (matches.length > 0 && matches[0].index > 0) {
    const prefix = source.slice(0, matches[0].index).trim();
    if (prefix) byNumber.set(expectedNumbers[0], prefix);
  }
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const number = Number(match[1]);
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    const value = source.slice(start, end).trim();
    if (value) {
      byNumber.set(
        number,
        byNumber.has(number) ? `${byNumber.get(number)} ${value}` : value
      );
    }
  }

  const missing = expectedNumbers.filter(number => !byNumber.has(number));
  requireCondition(missing.length === 0, `${label} is missing verse text for ${missing.join(', ')}.`);
  requireCondition(
    [...byNumber.keys()].every(number => expectedNumbers.includes(number)),
    `${label} contains an unexpected verse number.`
  );
  return expectedNumbers.map(number => ({ number, text: byNumber.get(number) }));
}

function parentAndIndex(project, itemId) {
  for (const [candidateId, item] of Object.entries(project.items)) {
    if (item.kind !== 'group') continue;
    const index = item.childIds.indexOf(itemId);
    if (index >= 0) return { parentId: candidateId, index };
  }
  const index = project.rootItemIds.indexOf(itemId);
  if (index >= 0) return { parentId: null, index };
  throw new Error(`Project item ${itemId} is not in the service order.`);
}

async function replaceReadingPlaceholder(project, extractors, specification, sermonResourceId = null) {
  const { placeholderId, outputSlides, bookId, chapter, verseStart, verseEnd, reference } = specification;
  const location = parentAndIndex(project, placeholderId);
  const expectedNumbers = Array.from(
    { length: verseEnd - verseStart + 1 },
    (_unused, index) => verseStart + index
  );
  const outputDecks = { russian: 'rus', english: 'eng', media: 'media' };
  const translations = { russian: 'RST', english: 'LSB', media: 'RST' };
  const passagesByChannel = {};

  for (const [channelId, deckKey] of Object.entries(outputDecks)) {
    const slide = outputSlides[channelId];
    const paragraphs = await extractors[deckKey].extractSlideText(slide);
    passagesByChannel[channelId] = {
      reference: channelId === 'english' ? reference.en : reference.ru,
      translationId: translations[channelId],
      attribution: channelId === 'english'
        ? 'Legacy Standard Bible wording pinned from the supplied service presentation.'
        : 'Исправленный синодальный перевод; wording pinned from the supplied service presentation.',
      verses: parseVerses(
        paragraphs.join('\n'),
        expectedNumbers,
        `${channelId} source slide ${slide}`
      )
    };
  }

  let next = removeProjectItemAndDescendants(project, placeholderId);
  next = addBibleItem(next, {
    id: placeholderId.replace('-placeholder', ''),
    title: `${reference.en} / ${reference.ru}`,
    range: range(bookId, chapter, verseStart, verseEnd),
    passagesByChannel,
    parentId: location.parentId,
    index: location.index,
    presetId: 'scripture-text',
    operatorNotes: `Exact reviewed text from aligned source position ${outputSlides.english}.`,
    ...(sermonResourceId
      ? {
          sermonReading: {
            sermonResourceId,
            referenceId: PRIMARY_REFERENCE_ID,
            outputs: [
              { channelId: 'russian', mode: 'translation', translationId: 'RST' },
              { channelId: 'english', mode: 'translation', translationId: 'LSB' },
              { channelId: 'media', mode: 'translation', translationId: 'RST' }
            ],
            chunkIndex: specification.chunkIndex,
            chunkCount: specification.chunkCount
          }
        }
      : {}),
    now: FIXED_BUILD_TIME
  });
  return next;
}

function itemKindCounts(project) {
  const counts = {};
  for (const item of Object.values(project.items)) {
    counts[item.kind] = (counts[item.kind] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function readRegularFile(filePath, label, maximumBytes = 600 * 1024 * 1024) {
  const stats = await fs.lstat(filePath);
  requireCondition(
    stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= maximumBytes,
    `${label} must be a bounded regular file.`
  );
  const buffer = await fs.readFile(filePath);
  requireCondition(buffer.length === stats.size, `${label} changed while reading.`);
  return buffer;
}

async function writePrivateFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

async function run(options) {
  for (const [field, label] of [
    ['engPath', '--eng'],
    ['rusPath', '--rus'],
    ['mediaPath', '--media'],
    ['manuscriptPath', '--manuscript'],
    ['mediaSermonTitleImagePath', '--media-sermon-title-image'],
    ['workRoot', '--work-root']
  ]) {
    if (!options[field]) throw new Error(`${label} is required.`);
  }

  const workRoot = await resolveSafeOutputRoot(options.workRoot);
  try {
    await fs.lstat(workRoot);
    throw new Error('--work-root must not already exist.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(workRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(workRoot, 0o700);

  const outputDirectory = options.outputDirectory
    || path.resolve(process.cwd(), DEFAULT_OUTPUT_DIRECTORY);
  const sourceFiles = {
    eng: await readRegularFile(options.engPath, 'English deck'),
    rus: await readRegularFile(options.rusPath, 'Russian deck'),
    media: await readRegularFile(options.mediaPath, 'Media deck'),
    manuscript: await readRegularFile(options.manuscriptPath, 'Pastor manuscript'),
    mediaSermonTitle: await readRegularFile(
      options.mediaSermonTitleImagePath,
      'Media sermon title render',
      75 * 1024 * 1024
    )
  };

  const sourceStore = new LocalSermonSourceStore({
    rootPath: path.join(workRoot, 'private-sermon-sources')
  });
  const importedSource = await sourceStore.importFile({
    sourcePath: options.manuscriptPath,
    id: 'pastor-manuscript',
    kind: 'manuscript',
    languages: ['ru', 'en'],
    providedBy: 'Павел Львутин',
    receivedAt: '2026-07-24T18:30:00.000Z',
    sourceSystem: 'historical-pilot-input',
    externalId: path.basename(options.manuscriptPath)
  });
  const extraction = await extractSermonSourceProposal(
    sourceFiles.manuscript,
    importedSource.source
  );
  const sermon = july26Sermon(importedSource.source, extraction);

  const importPlan = await buildImportPlan({
    manifest: july26Manifest(),
    decks: {
      eng: options.engPath,
      rus: options.rusPath,
      media: options.mediaPath
    },
    images: { 'media-sermon-title': options.mediaSermonTitleImagePath }
  });
  let project = importPlan.project;
  const pinned = addSermonResource(project, sermon, {
    provider: 'heritage-community',
    providerId: 'wotbc-historical-pilot',
    itemId: sermon.id,
    revision: sha256(Buffer.from(JSON.stringify(sermon), 'utf8'))
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon',
    sermonResourceId: pinned.resourceId,
    now: FIXED_BUILD_TIME
  });
  for (const [itemId, sermonSectionId] of [
    ['sermon-foundation', 'foundation'],
    ['sermon-content', 'content'],
    ['sermon-strengthened', 'strengthened'],
    ['sermon-know-love', 'know-love'],
    ['sermon-fullness', 'fullness'],
    ['sermon-confidence', 'confidence']
  ]) {
    project = setSermonSourceLink(project, {
      itemId,
      sermonSectionId,
      now: FIXED_BUILD_TIME
    });
  }

  const johnChunks = [
    { slide: 24, verseStart: 28, verseEnd: 31 },
    { slide: 25, verseStart: 32, verseEnd: 35 },
    { slide: 26, verseStart: 36, verseEnd: 39 },
    { slide: 27, verseStart: 40, verseEnd: 40 }
  ];
  for (const chunk of johnChunks) {
    project = await replaceReadingPlaceholder(project, importPlan.extractors, {
      placeholderId: `john-reading-placeholder-${chunk.slide}`,
      outputSlides: { russian: chunk.slide, english: chunk.slide, media: chunk.slide },
      bookId: 'John',
      chapter: 6,
      verseStart: chunk.verseStart,
      verseEnd: chunk.verseEnd,
      reference: {
        en: `John 6:${chunk.verseStart}${chunk.verseEnd === chunk.verseStart ? '' : `–${chunk.verseEnd}`}`,
        ru: `Иоанна 6:${chunk.verseStart}${chunk.verseEnd === chunk.verseStart ? '' : `–${chunk.verseEnd}`}`
      }
    });
  }

  const sermonChunks = [
    { slide: 64, verseStart: 14, verseEnd: 17 },
    { slide: 65, verseStart: 18, verseEnd: 19 },
    { slide: 66, verseStart: 20, verseEnd: 21 }
  ];
  for (const [chunkIndex, chunk] of sermonChunks.entries()) {
    project = await replaceReadingPlaceholder(project, importPlan.extractors, {
      placeholderId: `sermon-reading-placeholder-${chunk.slide}`,
      outputSlides: { russian: chunk.slide, english: chunk.slide, media: chunk.slide },
      bookId: 'Eph',
      chapter: 3,
      verseStart: chunk.verseStart,
      verseEnd: chunk.verseEnd,
      reference: {
        en: `Ephesians 3:${chunk.verseStart}–${chunk.verseEnd}`,
        ru: `Ефесянам 3:${chunk.verseStart}–${chunk.verseEnd}`
      },
      chunkIndex,
      chunkCount: sermonChunks.length
    }, pinned.resourceId);
  }

  const store = new ServiceProjectStore({
    rootPath: path.join(workRoot, 'service-projects'),
    clock: () => new Date(FIXED_BUILD_TIME)
  });
  await store.initialize();
  const installed = await store.importPortableProject(project, importPlan.assetBuffers, {
    reason: 'july26-canonical-native-rehearsal'
  });
  const exchange = new ServiceProjectExchange({
    projectStore: store,
    appVersion: APP_VERSION
  });
  const exported = await exchange.exportBundle(installed.project.id, installed.revisionId);
  const timeline = compileServiceProject(installed.project);
  const readiness = analyzeServiceProjectReadiness(installed.project);
  const serviceDocument = createHeritageServiceDocument(installed.project);
  const documentSource = serializeHeritageServiceDocument(serviceDocument);
  const documentRevision = heritageServiceDocumentRevision(documentSource);

  requireCondition(timeline.cueIds.length === 112, 'The historical service must compile to exactly 112 cues.');
  requireCondition(
    Object.values(installed.project.items).every(item =>
      item.kind !== 'imported-deck' && item.kind !== 'legacy-deck'),
    'The historical service contains a legacy or imported PowerPoint item.'
  );
  requireCondition(
    timeline.cueIds.every(cueId =>
      installed.project.channelIds.every(channelId =>
        timeline.cues[cueId].channels[channelId]?.mode !== 'hide')),
    'Every historical source position must have an explicit treatment on every logical output.'
  );
  requireCondition(readiness.ready === true, 'The historical service readiness report has blockers.');
  requireCondition(
    extraction.truncated.units === false && extraction.truncated.text === false,
    'The pastor manuscript body extraction was not complete.'
  );

  const outputPath = path.join(outputDirectory, SERVICE_BUNDLE_FILE);
  const documentPath = path.join(outputDirectory, SERVICE_DOCUMENT_FILE);
  const reportPath = path.join(outputDirectory, BUILD_REPORT_FILE);
  await writePrivateFile(outputPath, exported.buffer);
  await writePrivateFile(documentPath, Buffer.from(documentSource, 'utf8'));

  const showPublisher = new ShowPackagePublisher({
    projectStore: store,
    rootPath: path.join(outputDirectory, SHOW_PACKAGE_DIRECTORY),
    clock: () => new Date(FIXED_BUILD_TIME)
  });
  const showPackage = await showPublisher.publish({
    projectId: installed.project.id,
    revisionId: installed.revisionId,
    roleMapping: {
      russian: 'russian',
      english: 'english',
      media: 'media'
    },
    width: 1920,
    height: 1080,
    thumbnailWidth: 300,
    jpegQuality: 92
  });
  requireCondition(
    showPackage.manifest.cueCount === 112
      && showPackage.manifest.channels.length === 3
      && showPackage.serviceHandoff.readiness.ready === true,
    'The exact historical revision did not produce a complete ready ShowPackage.'
  );

  const counts = itemKindCounts(installed.project);
  const report = {
    schemaVersion: 1,
    kind: 'syncshow-july26-canonical-native-build-report',
    appVersion: APP_VERSION,
    serviceDate: SERVICE_DATE,
    serviceDocument: {
      id: serviceDocument.id,
      revision: documentRevision,
      fileName: SERVICE_DOCUMENT_FILE,
      size: Buffer.byteLength(documentSource, 'utf8')
    },
    showSource: {
      projectId: installed.project.id,
      projectRevisionId: installed.revisionId,
      bundleFileName: SERVICE_BUNDLE_FILE,
      bundleSize: exported.buffer.length,
      bundleSha256: sha256(exported.buffer)
    },
    showPackage: {
      id: showPackage.manifest.id,
      schemaVersion: showPackage.manifest.schemaVersion,
      projectRevisionId: showPackage.manifest.projectRevisionId,
      manifestSha256: showPackage.manifestSha256,
      cueCount: showPackage.manifest.cueCount,
      roles: showPackage.manifest.channels.map(channel => ({
        roleId: channel.roleId,
        channelId: channel.channelId
      })),
      directory: path.relative(outputDirectory, showPackage.packagePath)
    },
    privatePastorSource: {
      objectId: importedSource.objectId,
      fileName: importedSource.source.fileName,
      sha256: importedSource.source.sha256,
      size: importedSource.source.sizeBytes,
      extraction: extraction.extractor,
      unitCount: extraction.units.length,
      complete: extraction.truncated.units === false && extraction.truncated.text === false,
      previewTruncated: extraction.truncated.preview,
      storePath: path.relative(workRoot, path.join(workRoot, 'private-sermon-sources'))
    },
    sourceEvidence: {
      decks: Object.fromEntries(['eng', 'rus', 'media'].map(key => [key, {
        fileName: path.basename(options[`${key}Path`]),
        size: sourceFiles[key].length,
        sha256: sha256(sourceFiles[key]),
        slideCount: importPlan.extractors[key].slideCount
      }])),
      mediaSermonTitleRender: {
        fileName: path.basename(options.mediaSermonTitleImagePath),
        size: sourceFiles.mediaSermonTitle.length,
        sha256: sha256(sourceFiles.mediaSermonTitle)
      }
    },
    counts: {
      semanticItems: Object.keys(installed.project.items).length,
      itemKinds: counts,
      assets: Object.keys(installed.project.assets).length,
      songResources: Object.values(installed.project.resources)
        .filter(resource => resource.kind === 'song').length,
      sermonResources: Object.values(installed.project.resources)
        .filter(resource => resource.kind === 'sermon').length,
      sermonReferences: sermon.references.length,
      sermonBodyEntries: sermon.body.length,
      cuesPerOutput: timeline.cueIds.length
    },
    readiness,
    validation: {
      exact112PositionTimeline: true,
      allThreeOutputsExplicitAtEveryPosition: true,
      sixNativeEditableSongs: counts.song === 6,
      twoNativeScriptureReadings: counts.bible === 7,
      thirtyOneNativeSermonCues: counts.sermon === 31,
      intentionalBlanksPreserved: counts.blank === 9,
      sourceComposedPicturesPreserved: counts.picture === 3,
      exactSermonRevisionPinned: true,
      completePrivatePastorOriginalRetained: true,
      deterministicReviewedBodyRetained: true,
      readinessBlockers: readiness.blockers.length,
      pptxOrLegacyItems: 0,
      automaticPublication: false,
      exactRevisionShowPackage: showPackage.manifest.projectRevisionId
        === installed.revisionId
    }
  };
  await writePrivateFile(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
  return { outputPath, documentPath, reportPath, report };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await run(options);
  process.stdout.write(`${JSON.stringify({
    serviceDocument: result.report.serviceDocument,
    showSource: result.report.showSource,
    showPackage: result.report.showPackage,
    counts: result.report.counts,
    validation: result.report.validation,
    readiness: {
      ready: result.report.readiness.ready,
      blockers: result.report.readiness.blockers
    },
    files: {
      serviceBundle: result.outputPath,
      serviceDocument: result.documentPath,
      report: result.reportPath
    }
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`JULY26_NATIVE_SERVICE_BUILD_FAILED: ${error.message}\n`);
    if (process.env.SYNCSHOW_IMPORT_DEBUG === '1' && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  BUILD_REPORT_FILE,
  DEFAULT_OUTPUT_DIRECTORY,
  PRIMARY_REFERENCE_ID,
  PROJECT_ID,
  SERMON_ID,
  SERVICE_BUNDLE_FILE,
  SERVICE_DATE,
  SERVICE_DOCUMENT_FILE,
  SHOW_PACKAGE_DIRECTORY,
  july26Manifest,
  july26Sermon,
  parseArguments,
  parseVerses,
  run
};
