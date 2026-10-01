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
  if (raw.showTitleTranslation !== undefined && typeof raw.showTitleTranslation !== 'boolean') invalid();
  if (raw.audienceLanguage !== undefined && raw.audienceLanguage !== 'both'
    && (!channelIds.includes(raw.audienceLanguage) || variants[raw.audienceLanguage]?.mode !== 'content')) invalid();
  const slidePrimaryChannelIds = {};
  if (raw.slidePrimaryChannelIds !== undefined) {
    if (!raw.slidePrimaryChannelIds || typeof raw.slidePrimaryChannelIds !== 'object' || Array.isArray(raw.slidePrimaryChannelIds)
      || Object.keys(raw.slidePrimaryChannelIds).length > 1000) invalid();
    for (const [key, channelId] of Object.entries(raw.slidePrimaryChannelIds)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/.test(key) || key.length > 300
        || ['__proto__','constructor','prototype'].includes(key)
        || !channelIds.includes(channelId) || variants[channelId]?.mode !== 'content') invalid();
      slidePrimaryChannelIds[key] = channelId;
    }
  }
  return { stackedTranslation: raw.stackedTranslation, primaryChannelId, secondaryChannelId, credits: raw.credits.trim(),
    ...(raw.audienceLanguage !== undefined ? {audienceLanguage:raw.audienceLanguage} : {}),
    ...(raw.showTitleTranslation !== undefined ? {showTitleTranslation:raw.showTitleTranslation} : {}),
    ...(Object.keys(slidePrimaryChannelIds).length ? {slidePrimaryChannelIds} : {}) };
}

function presentationPrimaryChannelId(item, leafKey) {
  if (item.songPresentation?.audienceLanguage && item.songPresentation.audienceLanguage !== 'both') return item.songPresentation.audienceLanguage;
  return item.songPresentation?.slidePrimaryChannelIds?.[leafKey] || item.songPresentation?.primaryChannelId;
}
function presentationSecondaryChannelId(item, primary) {
  return [item.songPresentation?.primaryChannelId, item.songPresentation?.secondaryChannelId].find(id => id && id !== primary)
    || Object.keys(item.variants).find(id => id !== primary && item.variants[id].mode === 'content') || null;
}

function presentationTitleBlocks(item, resolvedByChannel, channelId) {
  const presentation = item.songPresentation;
  const resolved = resolvedByChannel[channelId];
  if (!presentation || resolved.mode === 'derive' || resolved.mode === 'hidden') return null;
  const primaryId = presentationPrimaryChannelId(item, 'title');
  const solo = presentation.audienceLanguage && presentation.audienceLanguage !== 'both';
  const unified = solo || presentation.stackedTranslation || presentation.showTitleTranslation !== undefined || Boolean(presentation.slidePrimaryChannelIds?.title);
  const primary = unified ? resolvedByChannel[primaryId].resource.document : resolved.resource.document;
  const secondaryId = presentationSecondaryChannelId(item, primaryId);
  const secondary = !solo && (presentation.showTitleTranslation ?? presentation.stackedTranslation) && secondaryId
    ? resolvedByChannel[secondaryId].resource.document : null;
  const blocks = [{ type: 'text', role: 'title', text: primary.title }];
  if (secondary && secondary.title !== primary.title) blocks.push({ type: 'text', role: 'subtitle', text: secondary.title,
    spans: [{start:0,end:secondary.title.length,foreground:'#ffc000'}] });
  if (presentation.credits) blocks.push({ type: 'text', role: 'credit', text: presentation.credits });
  return blocks;
}

function presentationLyricBlocks(item, resolvedByChannel, channelId, sectionId, slideIndex, leafKey) {
  const presentation = item.songPresentation;
  const solo = presentation?.audienceLanguage && presentation.audienceLanguage !== 'both';
  if (!presentation || (!solo && !presentation.stackedTranslation && !presentation.slidePrimaryChannelIds?.[leafKey])
    || ['derive', 'hidden'].includes(resolvedByChannel[channelId].mode)) return null;
  const lyrics = sourceChannel => resolvedByChannel[sourceChannel].resource.document.sections
    .find(section => section.id === sectionId).slides[slideIndex].lines.join('\n');
  const primaryId = presentationPrimaryChannelId(item, leafKey);
  const primary = lyrics(primaryId);
  const secondaryId = presentationSecondaryChannelId(item, primaryId);
  const secondary = !solo && presentation.stackedTranslation && secondaryId ? lyrics(secondaryId) : '';
  const blocks = [{ type: 'text', role: 'lyrics', text: primary }];
  // A single-language song must not repeat the same words in another color.
  if (secondary.trim() && secondary.trim() !== primary.trim()) {
    blocks.push({ type: 'text', role: 'lyrics', text: secondary,
      spans: [{ start: 0, end: secondary.length, foreground: '#ffc000', fontScale: 0.96 }] });
  }
  return blocks;
}

module.exports = { normalizeSongPresentation, presentationTitleBlocks, presentationLyricBlocks, presentationPrimaryChannelId, presentationSecondaryChannelId };
