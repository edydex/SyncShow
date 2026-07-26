'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ServiceProjectError,
  addProjectItem,
  addSongResource,
  compileServiceProject,
  createServiceProject,
  createSongCues,
  deterministicCueId,
  moveProjectItem,
  normalizeCue,
  normalizeCueTimeline,
  normalizeServiceProject,
  serializeServiceProject,
  validateProjectTree
} = require('../src/services/project/ServiceProject');
const { parseSongDocument } = require('../src/services/project/SongDocument');

const NOW = '2026-07-19T16:00:00.000Z';
const IMAGE_HASH = 'a'.repeat(64);
const IMAGE_ID = `sha256:${IMAGE_HASH}`;

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError, `expected ServiceProjectError, received ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function freshProject(options = {}) {
  return createServiceProject({
    id: options.id || 'sunday-2026-07-19',
    title: options.title || 'Sunday Service',
    serviceDate: '2026-07-19',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: options.channels || [
      { id: 'primary', label: 'Main Auditorium', language: 'en' },
      { id: 'secondary', label: 'Другий екран', language: 'uk' },
      { id: 'media', label: 'Singers', language: 'en' }
    ]
  });
}

function rawProject(options = {}) {
  return JSON.parse(serializeServiceProject(freshProject(options)));
}

function notice(id, title = id) {
  return {
    id,
    kind: 'notice',
    title,
    textByChannel: { primary: `Text for ${title}` },
    operatorNotes: '',
    createdAt: NOW,
    updatedAt: NOW,
    presetId: 'notice-text'
  };
}

function group(id, childIds = [], groupKind = 'section', title = id) {
  return {
    id,
    kind: 'group',
    title,
    groupKind,
    childIds,
    operatorNotes: '',
    createdAt: NOW,
    updatedAt: NOW
  };
}

function imageAsset(overrides = {}) {
  return {
    id: IMAGE_ID,
    kind: 'image',
    sha256: IMAGE_HASH,
    fileName: 'baptism.png',
    storedName: `${IMAGE_HASH}.png`,
    mediaType: 'image/png',
    size: 4096,
    createdAt: NOW,
    attribution: 'Church archive',
    altText: 'A baptism',
    width: 4000,
    height: 3000,
    orientation: 1,
    ...overrides
  };
}

function pictureItem(overrides = {}) {
  return {
    id: 'picture-one',
    kind: 'picture',
    title: 'Baptism',
    assetId: IMAGE_ID,
    channelIds: ['primary'],
    fit: 'fill',
    focalPoint: { x: 0.25, y: 0.75 },
    altText: 'A baptism',
    attribution: 'Church archive',
    presetId: 'picture-fullscreen',
    operatorNotes: '',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function sourceSong() {
  return parseSongDocument([
    '---',
    'id: grace-en',
    'title: Grace',
    'language: en',
    'license: Public Domain',
    '---',
    '^1',
    'Verse one',
    '^chorus',
    'Chorus first half',
    '---',
    'Chorus second half',
    '^2',
    'Verse two'
  ].join('\n'));
}

function translatedSong({ aligned = true } = {}) {
  return parseSongDocument([
    '---',
    'id: grace-uk',
    'title: Благодать',
    'language: uk',
    'translationOf: grace-en',
    '---',
    '^1',
    'Куплет один',
    '^chorus',
    'Приспів перша частина',
    ...(aligned ? ['---', 'Приспів друга частина'] : []),
    '^2',
    'Куплет два'
  ].join('\n'));
}

function songItem(resourceIds, overrides = {}) {
  return {
    id: 'song-grace',
    kind: 'song',
    title: 'Grace',
    variants: {
      primary: { mode: 'content', resourceId: resourceIds.primary },
      secondary: { mode: 'content', resourceId: resourceIds.secondary },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      }
    },
    arrangement: [
      { id: 'entry-v1', sectionId: 'verse-1' },
      { id: 'entry-c1', sectionId: 'chorus' },
      { id: 'entry-v2', sectionId: 'verse-2' },
      { id: 'entry-c2', sectionId: 'chorus' }
    ],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: 'Repeat the final chorus softly',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function projectWithRepeatedSong() {
  let project = freshProject();
  const source = addSongResource(project, sourceSong(), { provider: 'local', itemId: 'grace-en', revision: '7' });
  project = source.project;
  const translation = addSongResource(project, translatedSong(), { provider: 'local', itemId: 'grace-uk', revision: '3' });
  project = translation.project;
  project = addProjectItem(project, group('worship', [], 'section', 'Worship'), { now: NOW });
  project = addProjectItem(project, songItem({
    primary: source.resourceId,
    secondary: translation.resourceId
  }), { parentId: 'worship', now: NOW });
  project = addProjectItem(project, notice('welcome', 'Welcome'), { parentId: 'worship', now: NOW });
  return project;
}

function cloneProject(project) {
  return JSON.parse(serializeServiceProject(project));
}

test('semantic tree accepts each item exactly once and compiles only leaves with their group path', () => {
  const raw = rawProject();
  raw.rootItemIds = ['service-group'];
  raw.items = {
    'service-group': group('service-group', ['sermon-group'], 'service', 'Sunday Morning'),
    'sermon-group': group('sermon-group', ['point-group'], 'sermon', 'The Sermon'),
    'point-group': group('point-group', ['welcome'], 'point', 'First Point'),
    welcome: notice('welcome', 'Welcome everyone')
  };

  const normalized = normalizeServiceProject(raw, { now: NOW });
  const index = validateProjectTree(normalized);
  assert.equal(index.parentByItemId['service-group'], null);
  assert.equal(index.parentByItemId.welcome, 'point-group');
  assert.deepEqual(index.groupPathByItemId.welcome.map(entry => entry.title), [
    'Sunday Morning', 'The Sermon', 'First Point'
  ]);
  assert.equal(Object.prototype.propertyIsEnumerable.call(normalized, '_index'), false);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.items.welcome));

  const compiled = compileServiceProject(normalized);
  assert.equal(compiled.cueIds.length, 1);
  assert.equal(compiled.cues[compiled.cueIds[0]].kind, 'notice');
  assert.deepEqual(compiled.cues[compiled.cueIds[0]].groupPath, [
    'Sunday Morning', 'The Sermon', 'First Point'
  ]);
});

test('inline text spans preserve literal text and compile as constrained style data', () => {
  const literal = 'Before <span weight="999999">& 😀 after';
  const emphasisStart = literal.indexOf('<span');
  const emphasisEnd = literal.indexOf(' 😀');
  const raw = rawProject();
  raw.rootItemIds = ['notice-one'];
  raw.items = {
    'notice-one': {
      ...notice('notice-one'),
      textByChannel: { primary: literal },
      spansByChannel: {
        primary: [{
          start: emphasisStart,
          end: emphasisEnd,
          foreground: '#FFC000',
          weight: '700'
        }]
      }
    }
  };

  const project = normalizeServiceProject(raw, { now: NOW });
  assert.equal(project.items['notice-one'].textByChannel.primary, literal);
  assert.deepEqual(project.items['notice-one'].spansByChannel.primary, [{
    start: emphasisStart,
    end: emphasisEnd,
    foreground: '#ffc000',
    weight: '700'
  }]);
  const timeline = compileServiceProject(project);
  const block = timeline.cues[timeline.cueIds[0]].channels.primary.blocks[0];
  assert.equal(block.text, literal);
  assert.deepEqual(block.spans, project.items['notice-one'].spansByChannel.primary);

  const legacyRaw = rawProject();
  legacyRaw.rootItemIds = ['legacy-notice'];
  legacyRaw.items = { 'legacy-notice': notice('legacy-notice') };
  const legacyBlock = compileServiceProject(
    normalizeServiceProject(legacyRaw, { now: NOW })
  ).cues[deterministicCueId(legacyRaw.id, 'legacy-notice', 'self')]
    .channels.primary.blocks[0];
  assert.equal(legacyBlock.spans, undefined);
});

test('inline text spans reject malformed, overlapping, unsafe, and excessive ranges', () => {
  const candidate = (spans, value = 'A😀BCD') => {
    const raw = rawProject();
    raw.rootItemIds = ['notice-one'];
    raw.items = {
      'notice-one': {
        ...notice('notice-one'),
        textByChannel: { primary: value },
        spansByChannel: { primary: spans }
      }
    };
    return raw;
  };
  const style = { foreground: '#ffc000' };
  const invalid = [
    candidate(null),
    candidate([{ start: -1, end: 1, ...style }]),
    candidate([{ start: 1, end: 1, ...style }]),
    candidate([{ start: 0, end: 99, ...style }]),
    candidate([
      { start: 0, end: 3, ...style },
      { start: 2, end: 4, ...style }
    ]),
    candidate([
      { start: 4, end: 5, ...style },
      { start: 0, end: 1, ...style }
    ]),
    candidate([{ start: 2, end: 3, ...style }]),
    candidate([{ start: 0, end: 1 }]),
    candidate([{ start: 0, end: 1, foreground: '#ffc000\"><span' }]),
    candidate([{ start: 0, end: 1, weight: 'bold' }]),
    candidate([{ start: 0, end: 1, ...style, markup: '<span>' }]),
    candidate(
      Array.from(
        { length: 257 },
        (_unused, index) => ({ start: index * 2, end: index * 2 + 1, ...style })
      ),
      'x'.repeat(514)
    )
  ];
  for (const raw of invalid) {
    expectCode('INVALID_TEXT_SPANS', () => normalizeServiceProject(raw, { now: NOW }));
  }

  const missingText = rawProject();
  missingText.rootItemIds = ['notice-one'];
  missingText.items = {
    'notice-one': {
      ...notice('notice-one'),
      spansByChannel: {
        secondary: [{ start: 0, end: 1, ...style }]
      }
    }
  };
  expectCode('INVALID_TEXT_SPANS', () => normalizeServiceProject(missingText, { now: NOW }));

  expectCode('INVALID_TEXT_SPANS', () => normalizeCue({
    id: 'unsafe-inline-cue',
    kind: 'notice',
    title: 'Unsafe',
    groupPath: [],
    channels: {
      primary: {
        mode: 'content',
        blocks: [{
          type: 'text',
          role: 'caption',
          text: 'Safe text',
          spans: [{ start: 0, end: 4, foreground: 'red' }]
        }]
      }
    },
    presetId: 'notice-text'
  }));
});

test('semantic tree rejects missing nodes, orphans, cycles, multiple parents, and excessive depth', () => {
  const missing = rawProject();
  missing.rootItemIds = ['missing'];
  expectCode('MISSING_PROJECT_ITEM', () => normalizeServiceProject(missing, { now: NOW }));

  const orphan = rawProject();
  orphan.items = { orphan: notice('orphan') };
  expectCode('ORPHAN_PROJECT_ITEMS', () => normalizeServiceProject(orphan, { now: NOW }));

  const cycle = rawProject();
  cycle.rootItemIds = ['a'];
  cycle.items = { a: group('a', ['b']), b: group('b', ['a']) };
  expectCode('PROJECT_TREE_CYCLE', () => normalizeServiceProject(cycle, { now: NOW }));

  const multipleParents = rawProject();
  multipleParents.rootItemIds = ['a', 'b'];
  multipleParents.items = {
    a: group('a', ['leaf']),
    b: group('b', ['leaf']),
    leaf: notice('leaf')
  };
  expectCode('PROJECT_ITEM_MULTIPLE_PARENTS', () => normalizeServiceProject(multipleParents, { now: NOW }));

  const tooDeep = rawProject();
  tooDeep.rootItemIds = ['group-0'];
  tooDeep.items = {};
  for (let index = 0; index <= 32; index += 1) {
    tooDeep.items[`group-${index}`] = group(`group-${index}`, [index === 32 ? 'leaf' : `group-${index + 1}`]);
  }
  tooDeep.items.leaf = notice('leaf');
  expectCode('PROJECT_TREE_TOO_DEEP', () => normalizeServiceProject(tooDeep, { now: NOW }));
});

test('moving a parent into its descendant fails closed instead of corrupting the semantic tree', () => {
  const raw = rawProject();
  raw.rootItemIds = ['outer'];
  raw.items = {
    outer: group('outer', ['inner']),
    inner: group('inner', ['leaf']),
    leaf: notice('leaf')
  };
  const project = normalizeServiceProject(raw, { now: NOW });
  expectCode('PROJECT_TREE_CYCLE', () => moveProjectItem(project, {
    itemId: 'outer',
    targetParentId: 'inner',
    targetIndex: 0
  }));
});

test('moving service items reorders siblings and moves leaves between the root and titled sections', () => {
  const raw = rawProject();
  raw.rootItemIds = ['opening', 'worship', 'closing'];
  raw.items = {
    opening: notice('opening', 'Opening'),
    worship: group('worship', ['song', 'reading'], 'section', 'Worship'),
    song: notice('song', 'Song'),
    reading: notice('reading', 'Reading'),
    closing: notice('closing', 'Closing')
  };
  let project = normalizeServiceProject(raw, { now: NOW });

  project = moveProjectItem(project, {
    itemId: 'closing',
    targetParentId: null,
    targetIndex: 0
  });
  assert.deepEqual(project.rootItemIds, ['closing', 'opening', 'worship']);

  project = moveProjectItem(project, {
    itemId: 'reading',
    targetParentId: 'worship',
    targetIndex: 0
  });
  assert.deepEqual(project.items.worship.childIds, ['reading', 'song']);

  project = moveProjectItem(project, {
    itemId: 'opening',
    targetParentId: 'worship',
    targetIndex: 1
  });
  assert.deepEqual(project.rootItemIds, ['closing', 'worship']);
  assert.deepEqual(project.items.worship.childIds, ['reading', 'opening', 'song']);
  assert.equal(project._index.parentByItemId.opening, 'worship');
});

test('aligned translations compile; a missing section or mismatched slide break is rejected before publish', () => {
  const valid = projectWithRepeatedSong();
  assert.equal(compileServiceProject(valid).cueIds.length, 8);

  let project = freshProject();
  const source = addSongResource(project, sourceSong());
  project = source.project;
  const translation = addSongResource(project, translatedSong({ aligned: false }));
  project = translation.project;
  expectCode('TRANSLATION_MISMATCH', () => addProjectItem(project, songItem({
    primary: source.resourceId,
    secondary: translation.resourceId
  }), { now: NOW }));

  expectCode('TRANSLATION_MISMATCH', () => createSongCues({
    song: sourceSong(),
    translation: translatedSong({ aligned: false }),
    arrangement: ['1', 'chorus', '2']
  }));
});

test('songs compile one stable bilingual public title cue and a simplified derived title before lyrics', () => {
  let project = freshProject({
    channels: [
      { id: 'primary', label: 'Main Auditorium', language: 'en' },
      { id: 'localized', label: 'Українська', language: 'uk' },
      { id: 'inherited', label: 'Overflow', language: 'uk' },
      { id: 'media', label: 'Singers', language: 'en' },
      { id: 'hidden', label: 'Hidden', language: 'en' }
    ]
  });
  const source = addSongResource(project, sourceSong(), {
    provider: 'local',
    itemId: 'grace-en',
    revision: '7'
  });
  project = source.project;
  const translation = addSongResource(project, translatedSong(), {
    provider: 'local',
    itemId: 'grace-uk',
    revision: '3'
  });
  project = translation.project;
  project = addProjectItem(project, songItem({
    primary: source.resourceId,
    secondary: translation.resourceId
  }, {
    title: 'Operator-facing song label',
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: source.resourceId },
      localized: { mode: 'content', resourceId: translation.resourceId },
      inherited: { mode: 'inherit', from: 'localized', titleCardMode: 'simple' },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      },
      hidden: { mode: 'hidden' }
    },
    arrangement: [{ id: 'entry-v1', sectionId: 'verse-1' }]
  }), { now: NOW });

  const timeline = compileServiceProject(project);
  assert.equal(timeline.cueIds.length, 2);
  const titleCue = timeline.cues[timeline.cueIds[0]];
  const lyricCue = timeline.cues[timeline.cueIds[1]];

  assert.equal(titleCue.id, deterministicCueId(project.id, 'song-grace', 'title'));
  assert.equal(titleCue.presetId, 'song-title');
  assert.equal(titleCue.title, 'Operator-facing song label');
  assert.deepEqual(titleCue.groupPath, ['Operator-facing song label']);
  assert.deepEqual(titleCue.sourceReference, {
    type: 'project-item',
    id: 'song-grace',
    revision: String(project.revision),
    sectionId: null
  });
  assert.deepEqual(titleCue.channels.primary, {
    mode: 'content',
    blocks: [
      { type: 'text', role: 'title', text: 'Grace' },
      { type: 'text', role: 'subtitle', text: 'Благодать' }
    ]
  });
  assert.deepEqual(titleCue.channels.localized, {
    mode: 'content',
    blocks: [
      { type: 'text', role: 'title', text: 'Grace' },
      { type: 'text', role: 'subtitle', text: 'Благодать' }
    ]
  });
  assert.deepEqual(titleCue.channels.inherited, {
    mode: 'content',
    blocks: [{ type: 'text', role: 'title', text: 'Благодать' }]
  });
  assert.deepEqual(titleCue.channels.media, {
    mode: 'condensed',
    sourceChannelId: 'primary',
    blocks: [{ type: 'text', role: 'title', text: 'Grace' }]
  });
  assert.deepEqual(titleCue.channels.hidden, { mode: 'hide', blocks: [] });
  assert.equal(lyricCue.presetId, 'song-lyrics');
  assert.equal(lyricCue.sourceReference.sectionId, 'verse-1');
  assert.deepEqual(lyricCue.channels.primary.blocks, [
    { type: 'text', role: 'lyrics', text: 'Verse one' }
  ]);
});

test('song title credits preserve exact wording and generate localized structured fallbacks', () => {
  let project = freshProject();
  const exactSource = JSON.parse(JSON.stringify(sourceSong()));
  exactSource.authors = ['Words Author'];
  exactSource.composers = ['Music Composer'];
  exactSource.attribution = 'Exact source wording; Second source line';
  const source = addSongResource(project, exactSource);
  project = source.project;

  const translated = JSON.parse(JSON.stringify(translatedSong()));
  translated.authors = [];
  translated.composers = [];
  translated.translators = ['Перекладач'];
  translated.attribution = '';
  const translation = addSongResource(project, translated);
  project = translation.project;
  project = addProjectItem(project, songItem({
    primary: source.resourceId,
    secondary: translation.resourceId
  }, {
    arrangement: [{ id: 'entry-v1', sectionId: 'verse-1' }]
  }), { now: NOW });

  const titleCue = compileServiceProject(project).cues[
    deterministicCueId(project.id, 'song-grace', 'title')
  ];
  assert.deepEqual(titleCue.channels.primary.blocks, [
    { type: 'text', role: 'title', text: 'Grace' },
    { type: 'text', role: 'subtitle', text: 'Благодать' },
    { type: 'text', role: 'credit', text: 'Exact source wording\nSecond source line' }
  ]);
  assert.deepEqual(titleCue.channels.secondary.blocks, [
    { type: 'text', role: 'title', text: 'Grace' },
    { type: 'text', role: 'subtitle', text: 'Благодать' },
    {
      type: 'text',
      role: 'credit',
      text: 'Слова: Words Author\nМузика: Music Composer\nПереклад: Перекладач'
    }
  ]);
  assert.deepEqual(titleCue.channels.media.blocks, [
    { type: 'text', role: 'title', text: 'Grace' }
  ]);
});

test('repeated choruses compile as distinct cues without duplicating the source section', () => {
  const project = projectWithRepeatedSong();
  const timeline = compileServiceProject(project);
  const chorusCues = timeline.cueIds
    .map(cueId => timeline.cues[cueId])
    .filter(cue => cue.sourceReference?.sectionId === 'chorus');

  assert.equal(chorusCues.length, 4);
  assert.equal(new Set(chorusCues.map(cue => cue.id)).size, 4);
  assert.deepEqual(
    chorusCues.map(cue => cue.channels.primary.blocks[0].text),
    ['Chorus first half', 'Chorus second half', 'Chorus first half', 'Chorus second half']
  );
  assert.equal(sourceSong().sections.filter(section => section.id === 'chorus').length, 1);
});

test('cue identities survive title renames and semantic reordering while timeline order follows the project', () => {
  const project = projectWithRepeatedSong();
  const original = compileServiceProject(project);

  const renamedRaw = cloneProject(project);
  renamedRaw.title = 'Renamed Service';
  renamedRaw.channels.primary.label = 'Center Screen';
  renamedRaw.items.worship.title = 'Songs';
  renamedRaw.items['song-grace'].title = 'Amazing Grace';
  renamedRaw.items.welcome.title = 'Opening Welcome';
  const renamed = compileServiceProject(normalizeServiceProject(renamedRaw, { now: NOW }));
  assert.deepEqual(renamed.cueIds, original.cueIds);
  assert.notEqual(renamed.projectContentHash, original.projectContentHash);

  const reorderedRaw = cloneProject(project);
  reorderedRaw.items.worship.childIds.reverse();
  reorderedRaw.items['song-grace'].arrangement = [
    reorderedRaw.items['song-grace'].arrangement[2],
    reorderedRaw.items['song-grace'].arrangement[3],
    reorderedRaw.items['song-grace'].arrangement[0],
    reorderedRaw.items['song-grace'].arrangement[1]
  ];
  const reordered = compileServiceProject(normalizeServiceProject(reorderedRaw, { now: NOW }));
  assert.deepEqual(new Set(reordered.cueIds), new Set(original.cueIds));
  assert.notDeepEqual(reordered.cueIds, original.cueIds);
  assert.notEqual(reordered.projectContentHash, original.projectContentHash);

  const roundTripped = compileServiceProject(normalizeServiceProject(cloneProject(project), { now: NOW }));
  assert.deepEqual(roundTripped.cueIds, original.cueIds);
  assert.equal(roundTripped.projectContentHash, original.projectContentHash);
  assert.equal(
    deterministicCueId(project.id, 'song-grace', 'entry-c1/chorus-slide-1'),
    original.cueIds[2]
  );
});

test('cue-channel and semantic song-channel inheritance cycles are rejected', () => {
  expectCode('CHANNEL_INHERITANCE_CYCLE', () => normalizeCue({
    id: 'cycle-cue',
    kind: 'notice',
    title: 'Cycle',
    groupPath: [],
    channels: {
      primary: { mode: 'inherit', from: 'secondary' },
      secondary: { mode: 'inherit', from: 'primary' }
    },
    presetId: 'notice-text'
  }));

  expectCode('MISSING_INHERITED_CHANNEL', () => normalizeCue({
    id: 'missing-channel-cue',
    kind: 'notice',
    title: 'Missing channel',
    groupPath: [],
    channels: { primary: { mode: 'inherit', from: 'secondary' } },
    presetId: 'notice-text'
  }));

  let project = freshProject();
  const resource = addSongResource(project, sourceSong());
  project = resource.project;
  const cyclicItem = songItem({ primary: resource.resourceId, secondary: resource.resourceId }, {
    variants: {
      primary: { mode: 'inherit', from: 'secondary' },
      secondary: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      },
      media: { mode: 'hidden' }
    }
  });
  expectCode('CHANNEL_INHERITANCE_CYCLE', () => addProjectItem(project, cyclicItem, { now: NOW }));
});

test('prototype-reserved identifiers are rejected at every object-map boundary without pollution', () => {
  delete Object.prototype.polluted;
  expectCode('RESERVED_ID', () => createServiceProject({
    id: 'constructor', serviceDate: '2026-07-19', profileId: 'main-sanctuary', now: NOW
  }));

  const badChannel = rawProject();
  badChannel.channelIds = ['constructor'];
  badChannel.channels = JSON.parse('{"constructor":{"id":"constructor","label":"Bad","language":"en"}}');
  expectCode('RESERVED_ID', () => normalizeServiceProject(badChannel, { now: NOW }));

  const badItem = rawProject();
  badItem.rootItemIds = ['toString'];
  badItem.items = JSON.parse(`{"toString":${JSON.stringify(notice('toString'))}}`);
  expectCode('RESERVED_ID', () => normalizeServiceProject(badItem, { now: NOW }));

  expectCode('RESERVED_ID', () => normalizeCue({
    id: 'hasOwnProperty',
    kind: 'blank',
    title: 'Bad cue',
    groupPath: [],
    channels: { primary: { mode: 'content', blocks: [{ type: 'blank' }] } },
    presetId: 'blank-black'
  }));

  const injected = rawProject();
  injected.rootItemIds = ['__proto__'];
  injected.items = JSON.parse('{"__proto__":{"id":"__proto__","kind":"notice","title":"Bad","textByChannel":{"primary":"x"}}}');
  expectCode('INVALID_ID', () => normalizeServiceProject(injected, { now: NOW }));
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(Object.keys({}), []);
});

test('picture assets preserve fit/focal metadata and compile into only their selected channels', () => {
  const raw = rawProject();
  raw.assets[IMAGE_ID] = imageAsset();
  raw.rootItemIds = ['picture-one'];
  raw.items = { 'picture-one': pictureItem() };
  const project = normalizeServiceProject(raw, { now: NOW });
  const timeline = compileServiceProject(project);
  const cue = timeline.cues[timeline.cueIds[0]];

  assert.deepEqual(cue.channels.primary.blocks[0], {
    type: 'image',
    assetId: IMAGE_ID,
    fit: 'fill',
    focalPoint: { x: 0.25, y: 0.75 },
    altText: 'A baptism',
    attribution: 'Church archive'
  });
  assert.deepEqual(cue.channels.secondary, { mode: 'hide', blocks: [] });
  assert.deepEqual(cue.channels.media, { mode: 'hide', blocks: [] });
  assert.ok(Object.isFrozen(project.assets[IMAGE_ID]));
});

test('image metadata validates aggregate pixel safety, MIME/extension consistency, focal points, and references', () => {
  const exactLimit = rawProject();
  exactLimit.assets[IMAGE_ID] = imageAsset({ width: 8000, height: 8000 });
  exactLimit.rootItemIds = ['picture-one'];
  exactLimit.items = { 'picture-one': pictureItem() };
  assert.equal(normalizeServiceProject(exactLimit, { now: NOW }).assets[IMAGE_ID].width, 8000);

  const tooManyPixels = structuredClone(exactLimit);
  tooManyPixels.assets[IMAGE_ID].width = 8001;
  expectCode('IMAGE_PIXEL_LIMIT', () => normalizeServiceProject(tooManyPixels, { now: NOW }));

  const typeMismatch = structuredClone(exactLimit);
  typeMismatch.assets[IMAGE_ID].mediaType = 'image/jpeg';
  expectCode('IMAGE_TYPE_MISMATCH', () => normalizeServiceProject(typeMismatch, { now: NOW }));

  const badFocalPoint = structuredClone(exactLimit);
  badFocalPoint.items['picture-one'].focalPoint.x = 1.01;
  expectCode('INVALID_FOCAL_POINT', () => normalizeServiceProject(badFocalPoint, { now: NOW }));

  const missingAsset = rawProject();
  missingAsset.rootItemIds = ['picture-one'];
  missingAsset.items = { 'picture-one': pictureItem() };
  expectCode('MISSING_ASSET', () => normalizeServiceProject(missingAsset, { now: NOW }));

  const unknownChannel = structuredClone(exactLimit);
  unknownChannel.items['picture-one'].channelIds = ['balcony'];
  expectCode('UNKNOWN_PROJECT_CHANNEL', () => normalizeServiceProject(unknownChannel, { now: NOW }));
});

test('cue timelines validate aggregate block limits and asset kind/reference integrity', () => {
  const base = {
    id: 'cue-one',
    kind: 'picture',
    title: 'Picture',
    groupPath: [],
    channels: {
      primary: { mode: 'content', blocks: Array.from({ length: 64 }, () => ({ type: 'blank' })) }
    },
    presetId: 'picture-fullscreen'
  };
  assert.equal(normalizeCue(base).channels.primary.blocks.length, 64);
  expectCode('INVALID_BLOCKS', () => normalizeCue({
    ...base,
    channels: {
      primary: { mode: 'content', blocks: Array.from({ length: 65 }, () => ({ type: 'blank' })) }
    }
  }));

  const timeline = {
    schemaVersion: 1,
    id: 'compiled:test',
    title: 'Test',
    serviceDate: '2026-07-19',
    profileId: 'main-sanctuary',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 0,
    cueIds: ['image-cue'],
    cues: {
      'image-cue': {
        id: 'image-cue',
        kind: 'picture',
        title: 'Picture',
        groupPath: [],
        channels: {
          primary: {
            mode: 'content',
            blocks: [{ type: 'image', assetId: IMAGE_ID, altText: 'Required' }]
          }
        },
        presetId: 'picture-fullscreen'
      }
    },
    assets: {},
    libraryReferences: [],
    presetPackVersion: 'main-sanctuary@1'
  };
  expectCode('MISSING_ASSET', () => normalizeCueTimeline(timeline, { now: NOW }));

  timeline.assets[IMAGE_ID] = {
    ...imageAsset(),
    kind: 'deck',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  delete timeline.assets[IMAGE_ID].width;
  delete timeline.assets[IMAGE_ID].height;
  delete timeline.assets[IMAGE_ID].orientation;
  expectCode('WRONG_ASSET_KIND', () => normalizeCueTimeline(timeline, { now: NOW }));
});

test('aggregate project JSON size is enforced after normalized semantic content is assembled', () => {
  const raw = rawProject();
  const maximumText = 'x'.repeat(20000);
  raw.rootItemIds = [];
  raw.items = {};
  for (let index = 0; index < 840; index += 1) {
    const itemId = `notice-${index}`;
    raw.rootItemIds.push(itemId);
    raw.items[itemId] = {
      ...notice(itemId),
      textByChannel: { primary: maximumText }
    };
  }
  expectCode('PROJECT_TOO_LARGE', () => normalizeServiceProject(raw, { now: NOW }));

  const single = rawProject();
  single.rootItemIds = ['notice-one'];
  single.items = {
    'notice-one': { ...notice('notice-one'), textByChannel: { primary: 'x'.repeat(20001) } }
  };
  expectCode('TEXT_TOO_LONG', () => normalizeServiceProject(single, { now: NOW }));
});

test('content-addressed song resources reject document tampering even when map IDs are unchanged', () => {
  const added = addSongResource(freshProject(), sourceSong());
  const raw = cloneProject(added.project);
  raw.resources[added.resourceId].document.title = 'Tampered after hashing';
  expectCode('RESOURCE_HASH_MISMATCH', () => normalizeServiceProject(raw, { now: NOW }));
});
