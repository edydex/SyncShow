'use strict';

const RUSSIAN_BOOK_NAMES = {
  Genesis: 'Бытие',
  Exodus: 'Исход',
  Leviticus: 'Левит',
  Numbers: 'Числа',
  Deuteronomy: 'Второзаконие',
  Joshua: 'Иисус Навин',
  Judges: 'Судьи',
  Ruth: 'Руфь',
  '1 Samuel': '1 Царств',
  '2 Samuel': '2 Царств',
  '1 Kings': '3 Царств',
  '2 Kings': '4 Царств',
  '1 Chronicles': '1 Паралипоменон',
  '2 Chronicles': '2 Паралипоменон',
  Ezra: 'Ездра',
  Nehemiah: 'Неемия',
  Esther: 'Есфирь',
  Job: 'Иов',
  Psalms: 'Псалтирь',
  Proverbs: 'Притчи',
  Ecclesiastes: 'Екклесиаст',
  'Song of Solomon': 'Песнь Песней',
  Isaiah: 'Исаия',
  Jeremiah: 'Иеремия',
  Lamentations: 'Плач Иеремии',
  Ezekiel: 'Иезекииль',
  Daniel: 'Даниил',
  Hosea: 'Осия',
  Joel: 'Иоиль',
  Amos: 'Амос',
  Obadiah: 'Авдий',
  Jonah: 'Иона',
  Micah: 'Михей',
  Nahum: 'Наум',
  Habakkuk: 'Аввакум',
  Zephaniah: 'Софония',
  Haggai: 'Аггей',
  Zechariah: 'Захария',
  Malachi: 'Малахия',
  Matthew: 'Матфея',
  Mark: 'Марка',
  Luke: 'Луки',
  John: 'Иоанна',
  Acts: 'Деяния',
  Romans: 'Римлянам',
  '1 Corinthians': '1 Коринфянам',
  '2 Corinthians': '2 Коринфянам',
  Galatians: 'Галатам',
  Ephesians: 'Ефесянам',
  Philippians: 'Филиппийцам',
  Colossians: 'Колоссянам',
  '1 Thessalonians': '1 Фессалоникийцам',
  '2 Thessalonians': '2 Фессалоникийцам',
  '1 Timothy': '1 Тимофею',
  '2 Timothy': '2 Тимофею',
  Titus: 'Титу',
  Philemon: 'Филимону',
  Hebrews: 'Евреям',
  James: 'Иакова',
  '1 Peter': '1 Петра',
  '2 Peter': '2 Петра',
  '1 John': '1 Иоанна',
  '2 John': '2 Иоанна',
  '3 John': '3 Иоанна',
  Jude: 'Иуды',
  Revelation: 'Откровение',
}


function localizedReference(value, language) {
  if (String(language).split('-')[0] !== 'ru') return value;
  return String(value).replace(/^(.+?)(\s+\d[\s\S]*)$/, (_match, book, rest) => (RUSSIAN_BOOK_NAMES[book] || book) + rest);
}
function localizedEdition(value, language) {
  if (String(language).split('-')[0] !== 'ru') return value;
  return ['Russian Synodal Bible', 'SYNO-W', 'SYNO'].includes(value) ? 'Синодальный перевод' : value;
}
function localizedReadingText(value, language) {
  return String(value).split('\n').map(line => localizedEdition(localizedReference(line, language), language)).join('\n');
}
// Only generated reading labels are localized; the topic and authored wording
// stay intact. Span offsets follow the changed label rather than the old name.
function localizeReadingBlocks(blocks, language) {
  const {remapTextSpans} = require('./SlideFormatting');
  const remap = (before, after, spans = []) => spans.length === 1 && spans[0].start === 0 && spans[0].end === before.length
    ? [{...spans[0], end: after.length}] : remapTextSpans(before, after, spans);
  return blocks.map(block => {
    if (block.type === 'canvas') return {...block, objects: block.objects.map(object => {
      if (object.type !== 'text' || !['reading-reference','reading-edition'].includes(object.id)) return object;
      const text = localizedReadingText(object.text, language);
      return {...object, text, spans: remap(object.text, text, object.spans || [])};
    })};
    if (block.type !== 'text') return block;
    const text = localizedReadingText(block.text, language);
    return {...block, text, ...(block.spans ? {spans: remap(block.text, text, block.spans)} : {})};
  });
}
module.exports = {localizedReference, localizedEdition, localizedReadingText, localizeReadingBlocks};
