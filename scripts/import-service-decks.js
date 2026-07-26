#!/usr/bin/env node
'use strict';

const path = require('path');

const {
  ServiceDeckImportError,
  importServiceDecks,
  readImportManifest
} = require('./lib/service-deck-importer');

function usage() {
  return [
    'Usage:',
    '  node scripts/import-service-decks.js --manifest /absolute/manifest.json \\',
    '    --rus /absolute/RUS.pptx --eng /absolute/ENG.pptx --media /absolute/Media.pptx',
    '',
    'The command is a dry run unless --apply is present.',
    '',
    'Options:',
    '  --manifest PATH                 Non-lyric JSON manifest (required)',
    '  --rus PATH                      Register the RUS deck as "rus"',
    '  --eng PATH                      Register the ENG deck as "eng"',
    '  --media PATH                    Register the Media deck as "media"',
    '  --deck KEY=PATH                 Register another explicit deck key/path',
    '  --image KEY=PATH                Register a rendered PNG/JPEG/WebP',
    '  --apply                         Write the validated import',
    '  --output-root PATH              Separate SyncShow-compatible data root',
    '  --live-user-data-approved       Required for SyncShow’s real user-data root',
    '  --help                          Show this help'
  ].join('\n');
}

function valueAfter(argumentsList, index, flag) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArguments(argumentsList) {
  const options = {
    apply: false,
    decks: {},
    images: {}
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') {
      options.help = true;
    } else if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--live-user-data-approved') {
      options.liveUserDataApproved = true;
    } else if (argument === '--manifest') {
      options.manifestPath = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (argument === '--output-root') {
      options.outputRoot = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (['--rus', '--eng', '--media'].includes(argument)) {
      options.decks[argument.slice(2)] = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (argument === '--deck') {
      const value = valueAfter(argumentsList, index, argument);
      const equalsIndex = value.indexOf('=');
      if (equalsIndex < 1 || equalsIndex === value.length - 1) {
        throw new Error('--deck must use KEY=/absolute/path.pptx.');
      }
      options.decks[value.slice(0, equalsIndex)] = value.slice(equalsIndex + 1);
      index += 1;
    } else if (argument === '--image') {
      const value = valueAfter(argumentsList, index, argument);
      const equalsIndex = value.indexOf('=');
      if (equalsIndex < 1 || equalsIndex === value.length - 1) {
        throw new Error('--image must use KEY=/absolute/path.png.');
      }
      options.images[value.slice(0, equalsIndex)] = value.slice(equalsIndex + 1);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.manifestPath) throw new Error('--manifest is required.');
  const manifestPath = path.resolve(options.manifestPath);
  const decks = Object.fromEntries(
    Object.entries(options.decks).map(([key, filePath]) => [key, path.resolve(filePath)])
  );
  const images = Object.fromEntries(
    Object.entries(options.images).map(([key, filePath]) => [key, path.resolve(filePath)])
  );
  const manifest = await readImportManifest(manifestPath);
  const result = await importServiceDecks({
    manifest,
    decks,
    images,
    dryRun: !options.apply,
    outputRoot: options.outputRoot ? path.resolve(options.outputRoot) : null,
    liveUserDataApproved: options.liveUserDataApproved === true
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  const code = error instanceof ServiceDeckImportError ? error.code : 'IMPORT_FAILED';
  process.stderr.write(`${code}: ${error.message}\n`);
  if (process.env.SYNCSHOW_IMPORT_DEBUG === '1' && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
