'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  NativeSlideRenderer,
  addProjectItem,
  compileServiceProject,
  createServiceProject,
  updateTextItem
} = require('../src/services/project');

const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');

function baseProject() {
  return createServiceProject({
    id: 'localized-sermon-service',
    title: 'Localized sermon service',
    serviceDate: '2026-07-19',
    profileId: 'default',
    channels: [
      { id: 'russian', label: 'Russian', language: 'ru' },
      { id: 'english', label: 'English', language: 'en' },
      { id: 'media', label: 'Singers', language: 'ru' }
    ],
    now: new Date('2026-07-23T12:00:00.000Z')
  });
}

test('sermon items compile distinct projected titles and bodies per output', () => {
  const project = addProjectItem(baseProject(), {
    id: 'sermon-mystery',
    kind: 'sermon',
    title: 'The Mystery of the Church',
    titlesByChannel: {
      russian: 'II. Тайна Церкви',
      english: 'II. The Mystery of the Church'
    },
    textByChannel: {
      russian: 'Еф.3:6\nЧтобы и язычникам быть сонаследниками.',
      english: 'Eph.3:6\nThat the Gentiles are fellow heirs.'
    },
    presetId: 'sermon-notes',
    operatorNotes: ''
  });

  const timeline = compileServiceProject(project);
  const cue = timeline.cues[timeline.cueIds[0]];
  assert.deepEqual(cue.channels.russian.blocks, [
    { type: 'text', role: 'title', text: 'II. Тайна Церкви' },
    {
      type: 'text',
      role: 'body',
      text: 'Еф.3:6\nЧтобы и язычникам быть сонаследниками.'
    }
  ]);
  assert.deepEqual(cue.channels.english.blocks, [
    { type: 'text', role: 'title', text: 'II. The Mystery of the Church' },
    {
      type: 'text',
      role: 'body',
      text: 'Eph.3:6\nThat the Gentiles are fellow heirs.'
    }
  ]);
  assert.deepEqual(cue.channels.media, { mode: 'hide', blocks: [] });
});

test('text edits preserve localized titles unless explicitly replacing them', () => {
  const project = addProjectItem(baseProject(), {
    id: 'sermon-purpose',
    kind: 'sermon',
    title: 'Purpose',
    titlesByChannel: {
      russian: 'IV. Предназначение Церкви',
      english: 'IV. The Purpose of the Church'
    },
    textByChannel: {
      russian: 'Русский текст',
      english: 'English text'
    },
    presetId: 'sermon-notes',
    operatorNotes: ''
  });
  const edited = updateTextItem(project, {
    itemId: 'sermon-purpose',
    textByChannel: {
      russian: 'Обновленный текст',
      english: 'Updated text'
    },
    now: '2026-07-23T12:05:00.000Z'
  });

  assert.deepEqual(
    edited.items['sermon-purpose'].titlesByChannel,
    project.items['sermon-purpose'].titlesByChannel
  );
});

test('text edits can omit an output and explicitly clear every projected title', () => {
  const project = addProjectItem(baseProject(), {
    id: 'sermon-clear-headings',
    kind: 'sermon',
    title: 'Operator-only rundown title',
    titlesByChannel: {
      russian: 'Заголовок',
      english: 'Heading'
    },
    textByChannel: {
      russian: 'Русский текст',
      english: 'English text'
    },
    presetId: 'sermon-notes',
    operatorNotes: ''
  });
  const edited = updateTextItem(project, {
    itemId: 'sermon-clear-headings',
    titlesByChannel: null,
    textByChannel: {
      english: 'English-only midweek service'
    },
    now: '2026-07-23T12:06:00.000Z'
  });

  assert.deepEqual(edited.items['sermon-clear-headings'].textByChannel, {
    english: 'English-only midweek service'
  });
  assert.equal(
    Object.hasOwn(edited.items['sermon-clear-headings'], 'titlesByChannel'),
    false
  );
  const timeline = compileServiceProject(edited);
  const cue = timeline.cues[timeline.cueIds[0]];
  assert.deepEqual(cue.channels.russian, { mode: 'hide', blocks: [] });
  assert.deepEqual(cue.channels.english.blocks, [{
    type: 'text',
    role: 'body',
    text: 'English-only midweek service'
  }]);
});

test('the renderer treats a per-channel title block as the heading, not duplicated body text', async () => {
  const renderer = new NativeSlideRenderer({
    width: 640,
    height: 360,
    fontPath: FONT_PATH,
    jpegQuality: 88
  });
  const cue = compileServiceProject(addProjectItem(baseProject(), {
    id: 'sermon-glory',
    kind: 'sermon',
    title: 'Operator title',
    titlesByChannel: { english: 'V. The Glory of the Church' },
    textByChannel: { english: 'Eph.3:13\nDo not lose heart.' },
    presetId: 'sermon-notes',
    operatorNotes: ''
  }));
  const rendered = await renderer.renderCue(cue.cues[cue.cueIds[0]], 'english');

  assert.equal(rendered.metadata.text, 'Eph.3:13\nDo not lose heart.');
  assert.equal(rendered.metadata.firstLine, 'Eph.3:13');
  assert.equal(rendered.info.width, 640);
  assert.equal(rendered.info.height, 360);
});
