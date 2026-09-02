'use strict';

// Match the existing singer window: a full single-language current slide and
// only the first meaningful line of the next cue (70 characters by default).
const DEFAULT_SINGER_CHAR_LIMIT = 70;

function singerNextLine(value, charLimit = DEFAULT_SINGER_CHAR_LIMIT) {
  const limit = Number.isInteger(charLimit) ? Math.max(10, Math.min(500, charLimit)) : DEFAULT_SINGER_CHAR_LIMIT;
  const line = String(value || '').split(/\r\n|\r|\n/).map(part => part.trim()).find(Boolean) || '';
  const characters = Array.from(line);
  return characters.length > limit ? characters.slice(0, limit).join('') + '…' : line;
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

module.exports = { DEFAULT_SINGER_CHAR_LIMIT, singerNextLine, singerSourceCue };
