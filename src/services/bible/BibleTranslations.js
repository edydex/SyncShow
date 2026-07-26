'use strict';

const path = require('path');

const DEFAULT_TRANSLATION_ID = 'BSB';
const TRANSLATION_DATA_ROOT = path.join(__dirname, 'data');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Rights and provenance travel with the bundled text. Keep this metadata
 * available to the renderer/About surface instead of treating it as build-only
 * documentation.
 */
const translations = deepFreeze([
  {
    id: 'BSB',
    abbr: 'BSB',
    name: 'Berean Standard Bible',
    description: 'Clear and accurate modern English',
    language: 'English',
    versification: 'western',
    license: 'Public Domain (CC0)',
    licenseUrl: 'https://berean.bible/licensing.htm',
    attribution: null,
    suggestedCredit: 'The Holy Bible, Berean Standard Bible (BSB), produced in cooperation with Bible Hub, Discovery Bible, OpenBible.com, and the Berean Bible Translation Committee. Dedicated to the public domain (CC0). https://berean.bible',
    attributionRequired: false,
    source: {
      repository: 'https://github.com/edydex/heritage_study_bible',
      revision: 'f3cd93ca949a7189db8bade49501a30023e6343c',
      heritageMonolithicDataSha256: '8afd83b240d4ac4168127d4d039896a2245883d431e9125899b6adcbd5b32285',
      note: 'Copied from Heritage Study Bible per-book JSON without changing the Bible text. Heritage does not record the revision of its older BSB source artifact; do not describe this copy as the newer eBible.org edition.'
    }
  },
  {
    id: 'LSV',
    abbr: 'LSV',
    name: 'Literal Standard Version',
    description: 'Modern literal translation (2020)',
    language: 'English',
    versification: 'western',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    attribution: 'Literal Standard Version (LSV), copyright © 2020 Covenant Press and the Covenant Christian Coalition. Licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/. Source: https://ebible.org/Scriptures/englsv_vpl.zip.',
    attributionRequired: true,
    source: {
      repository: 'https://github.com/edydex/heritage_study_bible',
      revision: 'f3cd93ca949a7189db8bade49501a30023e6343c',
      sourceUrl: 'https://ebible.org/Scriptures/englsv_vpl.zip',
      sourceVplSha256: 'c00947f8555a6ed1cd9a878b59946a3af0b1b604526252c8f7b89f78ff8af1c6',
      heritageMonolithicDataSha256: '2916927946cab7f1066a6432b2fea5dd7b1822e712796cec94445b1cce08d71b',
      modification: 'Converted from eBible.org VPL to normalized JSON; verse-boundary whitespace was normalized; no intentional wording changes.'
    }
  }
]);

function normalizeTranslationId(translationId) {
  return String(translationId || '').trim().toUpperCase();
}

function getTranslationById(translationId) {
  const normalizedId = normalizeTranslationId(translationId);
  return translations.find(translation => translation.id === normalizedId) || null;
}

module.exports = {
  DEFAULT_TRANSLATION_ID,
  TRANSLATION_DATA_ROOT,
  getTranslationById,
  normalizeTranslationId,
  translations
};
