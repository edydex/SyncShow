'use strict';

// Keep the complete first meaningful line. Each display fits its visible
// prefix to the available width at the current slide's actual font size.
// This is a scene-payload safety bound, not a presentation character limit.
const MAX_SINGER_LINE_LENGTH = 2000;

function singerNextLine(value) {
  const line = String(value || '').split(/\r\n|\r|\n/).map(part => part.trim()).find(Boolean) || '';
  if (line.length <= MAX_SINGER_LINE_LENGTH) return line;
  let bounded = '';
  for (const character of line) {
    if (bounded.length + character.length >= MAX_SINGER_LINE_LENGTH) break;
    bounded += character;
  }
  return bounded + '…';
}

function singerSourceCue(cue, sourceChannelId) {
  if (!cue) return cue;
  // Source blocks are captured before audience translation stacking. The
  // condensed cue still retains its original first-lines transform for other
  // consumers; singer displays must use this complete, unstacked source.
  const sources = Object.values(cue.channels || {}).filter(channel =>
    channel.mode === 'condensed' && channel.sourceBlocks);
  const derived = sources.find(channel => channel.sourceChannelId === sourceChannelId) || sources[0];
  if (!derived) return cue;
  return { ...cue,
    presetId: cue.presetId === 'wotbc-song-stacked' ? 'wotbc-song-lyrics' : cue.presetId,
    channels: { ...cue.channels, [sourceChannelId]: { mode: 'content', blocks: derived.sourceBlocks } }
  };
}

// Hints describe the concrete next slide; a contextual sermon heading is not
// useful when the next content is Scripture, a quotation, or a new point.
function nextSlideHint(cue, channelId) {
  if (!cue) return '';
  const source = cue.channels?.[channelId]?.mode === 'condensed' ? singerSourceCue(cue, channelId) : cue;
  const output = source.channels?.[channelId];
  if (!output || output.mode === 'hide') return '';
  const blocks = output.blocks || [];
  const bible = blocks.find(block => block.type === 'bible');
  if (bible) return require('./ReadingLabels').localizedReference(bible.displayReference || bible.reference, channelId === 'russian' || channelId === 'media' && ['SYNO','SYNO-W'].includes(bible.translationId) ? 'ru' : 'en');
  const body = blocks.find(block => block.type === 'text' && ['body','lyrics','caption'].includes(block.role));
  if (body) {
    const rows = require('./SermonContext').outlineRows(body.text);
    return singerNextLine(cue.presetId === 'wotbc-sermon' && rows.length ? rows.at(-1).text : body.text);
  }
  const text = blocks.map(block => block.type === 'text' ? block.text
    : block.type === 'canvas' ? require('./CanvasLayout').canvasText(block.objects)
      : block.type === 'image' && block.role !== 'background' ? block.altText : '').filter(Boolean).join('\n');
  return singerNextLine(text);
}

module.exports = { MAX_SINGER_LINE_LENGTH, singerNextLine, singerSourceCue, nextSlideHint };
