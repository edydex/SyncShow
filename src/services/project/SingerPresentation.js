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

module.exports = { MAX_SINGER_LINE_LENGTH, singerNextLine, singerSourceCue };
