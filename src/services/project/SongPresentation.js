'use strict';

// Service-local display choices. Song authorship/provenance stays in the pinned
// library document; a short, editable projection credit lives with this service.
function normalizeSongPresentation(raw, channelIds, variants) {
  if (raw === undefined) return null;
  const invalid = () => { const error = new TypeError('Invalid song presentation: choose two distinct content channels and a credit of at most 500 characters.'); error.code = 'INVALID_SONG_PRESENTATION'; throw error; };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.stackedTranslation !== 'boolean') invalid();
  const primaryChannelId = raw.primaryChannelId;
  const secondaryChannelId = raw.secondaryChannelId || null;
  for (const channelId of [primaryChannelId, secondaryChannelId].filter(Boolean)) {
    if (!channelIds.includes(channelId) || variants[channelId]?.mode !== 'content') invalid();
  }
  if (!primaryChannelId || primaryChannelId === secondaryChannelId || (raw.stackedTranslation && !secondaryChannelId)) invalid();
  if (typeof raw.credits !== 'string' || raw.credits.length > 500) invalid();
  return { stackedTranslation: raw.stackedTranslation, primaryChannelId, secondaryChannelId, credits: raw.credits.trim() };
}

function presentationTitleBlocks(item, resolvedByChannel, channelId) {
  const presentation = item.songPresentation;
  const resolved = resolvedByChannel[channelId];
  if (!presentation || resolved.mode === 'derive' || resolved.mode === 'hidden') return null;
  const primary = presentation.stackedTranslation
    ? resolvedByChannel[presentation.primaryChannelId].resource.document
    : resolved.resource.document;
  const secondary = presentation.stackedTranslation
    ? resolvedByChannel[presentation.secondaryChannelId].resource.document
    : null;
  const blocks = [{ type: 'text', role: 'title', text: primary.title }];
  if (secondary && secondary.title !== primary.title) blocks.push({ type: 'text', role: 'subtitle', text: secondary.title });
  if (presentation.credits) blocks.push({ type: 'text', role: 'credit', text: presentation.credits });
  return blocks;
}

function presentationLyricBlocks(item, resolvedByChannel, channelId, sectionId, slideIndex) {
  const presentation = item.songPresentation;
  if (!presentation?.stackedTranslation || ['derive', 'hidden'].includes(resolvedByChannel[channelId].mode)) return null;
  const lyrics = sourceChannel => resolvedByChannel[sourceChannel].resource.document.sections
    .find(section => section.id === sectionId).slides[slideIndex].lines.join('\n');
  const primary = lyrics(presentation.primaryChannelId);
  const secondary = lyrics(presentation.secondaryChannelId);
  const blocks = [{ type: 'text', role: 'lyrics', text: primary }];
  // A single-language song must not repeat the same words in another color.
  if (secondary.trim() && secondary.trim() !== primary.trim()) {
    blocks.push({ type: 'text', role: 'lyrics', text: secondary,
      spans: [{ start: 0, end: secondary.length, foreground: '#ffc000' }] });
  }
  return blocks;
}

module.exports = { normalizeSongPresentation, presentationTitleBlocks, presentationLyricBlocks };

