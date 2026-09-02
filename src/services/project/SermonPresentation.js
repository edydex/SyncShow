'use strict';

const TEMPLATES = ['title', 'point', 'quote'];
function subtitleSpans(body, spans = []) {
  const result = [];
  let start = 0;
  for (const span of spans) {
    if (span.start > start) result.push({start, end:span.start, fontScale:0.65, weight:'400'});
    result.push({fontScale:0.65, weight:'400', ...span});
    start = span.end;
  }
  if (start < body.length) result.push({start, end:body.length, fontScale:0.65, weight:'400'});
  return result;
}
function normalizeSermonOptions(raw, channelIds, fail) {
  const result = {};
  if (raw.sermonTemplate !== undefined) {
    if (raw.kind !== 'sermon' || !TEMPLATES.includes(raw.sermonTemplate)) fail('INVALID_SERMON_TEMPLATE', 'Unknown sermon slide template.');
    result.sermonTemplate = raw.sermonTemplate;
  }
  if (raw.pendingPointChannels !== undefined) {
    if (raw.sermonTemplate !== 'point' || !Array.isArray(raw.pendingPointChannels)
      || raw.pendingPointChannels.some(id => !channelIds.includes(id))
      || new Set(raw.pendingPointChannels).size !== raw.pendingPointChannels.length) fail('INVALID_SERMON_TEMPLATE', 'Pending points must name distinct slide outputs.');
    result.pendingPointChannels = [...raw.pendingPointChannels];
  }
  if (raw.sermonPresentation !== undefined) {
    const value = raw.sermonPresentation;
    if (raw.kind !== 'sermon' || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['showText','darkenBackground'].includes(key))
      || typeof value.showText !== 'boolean' || typeof value.darkenBackground !== 'boolean') {
      fail('INVALID_SERMON_PRESENTATION', 'Sermon image options must specify text visibility and background darkening.');
    }
    result.sermonPresentation = {showText:value.showText, darkenBackground:value.darkenBackground};
  }
  return result;
}

/** Editing guides never enter a cue. Existing slides retain their old defaults. */
function sermonSlideBlocks(item, channelId) {
  const blocks = item.backgroundAssetId ? [{
    type:'image', role:'background', assetId:item.backgroundAssetId, fit:'fill',
    focalPoint:{x:0.5,y:0.5}, altText:item.title, attribution:'',
    ...(item.sermonPresentation ? {dimOpacity:item.sermonPresentation.darkenBackground ? 0.55 : 0} : {})
  }] : [];
  if (item.sermonPresentation?.showText === false) return blocks;
  const title = item.titlesByChannel?.[channelId] || '', body = item.textByChannel[channelId] || '';
  if (item.sermonTemplate === 'title') {
    const value = title + (title && body ? '\n\n' : '') + body;
    if (value) {
      const offset = title.length + (title && body ? 2 : 0);
      const spans = [...(item.titleSpansByChannel?.[channelId] || []),
        ...(body ? subtitleSpans(body, item.spansByChannel?.[channelId])
          .map(span=>({...span,start:span.start+offset,end:span.end+offset})) : [])];
      blocks.push({type:'text',role:'body',text:value,...(spans.length ? {spans} : {})});
    }
    return blocks;
  }
  if (title) blocks.push({type:'text',role:'title',text:title,...(item.titleSpansByChannel?.[channelId] ? {spans:item.titleSpansByChannel[channelId]} : {})});
  if (body) blocks.push({type:'text',role:item.kind === 'sermon' ? 'body' : 'caption',text:body,...(item.spansByChannel?.[channelId] ? {spans:item.spansByChannel[channelId]} : {})});
  return blocks;
}
module.exports = { normalizeSermonOptions, sermonSlideBlocks };
