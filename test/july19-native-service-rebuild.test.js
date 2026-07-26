'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CATALOG_TO_SERVICE_CHANNEL,
  EXPECTED_KIND_COUNTS,
  SONG_ITEM_MAP,
  parseArguments,
  run,
  visibleCueDescriptor
} = require('../scripts/rebuild-july19-native-service');

test('July 19 rebuild contract keeps six stable service item mappings and Singer channel routing', () => {
  assert.equal(Object.keys(SONG_ITEM_MAP).length, 6);
  assert.deepEqual(CATALOG_TO_SERVICE_CHANNEL, {
    primary: 'primary',
    secondary: 'secondary',
    singer: 'media'
  });
  assert.deepEqual(EXPECTED_KIND_COUNTS, {
    blank: 9,
    group: 12,
    notice: 10,
    picture: 3,
    sermon: 31,
    song: 6
  });

  const projected = visibleCueDescriptor({
    kind: 'song',
    presetId: 'song-lyrics',
    channels: {
      singer: {
        mode: 'condensed',
        sourceChannelId: 'primary',
        blocks: [{ type: 'text', role: 'lyrics', text: 'Preview' }]
      }
    }
  }, CATALOG_TO_SERVICE_CHANNEL);
  assert.deepEqual(projected, {
    kind: 'song',
    presetId: 'song-lyrics',
    channels: {
      media: {
        mode: 'condensed',
        sourceChannelId: 'primary',
        blocks: [{ type: 'text', role: 'lyrics', text: 'Preview' }]
      }
    }
  });
});

test('July 19 rebuild arguments keep every local input and output explicit', () => {
  const parsed = parseArguments([
    '--template', '/tmp/template.syncshow-service',
    '--catalog', '/tmp/catalog.syncshow-service',
    '--work-root', '/tmp/work',
    '--output', '/tmp/output.syncshow-service',
    '--report', '/tmp/report.json'
  ]);
  assert.deepEqual(parsed, {
    templatePath: path.resolve('/tmp/template.syncshow-service'),
    catalogPath: path.resolve('/tmp/catalog.syncshow-service'),
    workRoot: path.resolve('/tmp/work'),
    outputPath: path.resolve('/tmp/output.syncshow-service'),
    reportPath: path.resolve('/tmp/report.json')
  });
});

const repositoryRoot = path.resolve(__dirname, '..');
const templatePath = path.join(
  repositoryRoot,
  'dist',
  '2026-07-19-native-service-template.pre-catalog.syncshow-service'
);
const catalogPath = path.join(
  repositoryRoot,
  'dist',
  'downloaded-song-library-2026-06-21-through-2026-07-19.syncshow-service'
);
const localArtifactsAvailable = fs.existsSync(templatePath) && fs.existsSync(catalogPath);

test('local reviewed artifacts rebuild and import catalog-first without duplicate songs', {
  skip: localArtifactsAvailable
    ? false
    : 'Ignored local review artifacts are not present in this checkout.'
}, async t => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncshow-july19-rebuild-test-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const result = await run({
    templatePath,
    catalogPath,
    workRoot: path.join(temporary, 'work'),
    outputPath: path.join(temporary, 'full.syncshow-service'),
    reportPath: path.join(temporary, 'report.json')
  });

  assert.equal(result.report.counts.semanticItems, 71);
  assert.equal(result.report.counts.sermonItems, 31);
  assert.equal(result.report.counts.assets, 7);
  assert.equal(result.report.counts.cuesPerOutput, 114);
  assert.equal(result.report.counts.catalogSongResources, 8);
  assert.equal(result.report.counts.outputOnlySingerResources, 2);
  assert.equal(
    result.report.cleanImportSequence.fullServiceSecondImport.added,
    0
  );
  assert.equal(
    result.report.cleanImportSequence.fullServiceSecondImport.unchanged,
    8
  );
  assert.equal(
    result.report.cleanImportSequence.fullServiceSecondImport.conflicts,
    0
  );
  assert.equal(
    result.report.cleanImportSequence.reusableLibrarySongsAfterFullService,
    42
  );
  assert.deepEqual(result.report.coverage.completeNativeServiceDates, ['2026-07-19']);
  assert.deepEqual(result.report.coverage.songOnlyServiceDates, [
    '2026-06-21',
    '2026-06-28',
    '2026-07-05',
    '2026-07-12'
  ]);
  assert.equal(result.report.coverage.psalm32CompleteNativeArtifact, false);
});
