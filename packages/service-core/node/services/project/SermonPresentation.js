'use strict';

const { normalizeCanvasObjects } = require('./CanvasLayout');
const TEMPLATES = ['title', 'point', 'quote', 'other'];
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
function normalizeSermonOptions(raw, channelIds, fail, normalizeSpans) {
  const result = {};
  if (raw.backgroundAssetIdsByChannel !== undefined) {
    const values = raw.backgroundAssetIdsByChannel;
    if (raw.kind !== 'sermon' || !values || typeof values !== 'object' || Array.isArray(values)) fail('INVALID_ASSET_REFERENCE', 'Choose a title image for a known output.');
    result.backgroundAssetIdsByChannel = {};
    for (const [channel, assetId] of Object.entries(values)) {
      if (!channelIds.includes(channel) || typeof assetId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(assetId)) fail('INVALID_ASSET_REFERENCE', 'Invalid output title image.');
      result.backgroundAssetIdsByChannel[channel] = assetId;
    }
  }
  if (raw.sermonTemplate !== undefined) {
    if (raw.kind !== 'sermon' || !TEMPLATES.includes(raw.sermonTemplate)) fail('INVALID_SERMON_TEMPLATE', 'Unknown sermon slide template.');
    result.sermonTemplate = raw.sermonTemplate;
  }
  if (raw.quoteSourcesByChannel !== undefined) {
    if (raw.sermonTemplate !== 'quote' || !raw.quoteSourcesByChannel || typeof raw.quoteSourcesByChannel !== 'object' || Array.isArray(raw.quoteSourcesByChannel)) fail('INVALID_SERMON_TEMPLATE', 'Quotation sources must name known outputs.');
    result.quoteSourcesByChannel = {};
    for (const [channel, text] of Object.entries(raw.quoteSourcesByChannel)) {
      if (!channelIds.includes(channel) || typeof text !== 'string' || text.length > 500) fail('INVALID_SERMON_TEMPLATE', 'Quotation sources must be text up to 500 characters.');
      result.quoteSourcesByChannel[channel] = text;
    }
  }
  if (raw.sermonInheritance !== undefined) {
    if (!['point','quote'].includes(raw.sermonTemplate) || !raw.sermonInheritance || typeof raw.sermonInheritance !== 'object' || Array.isArray(raw.sermonInheritance)) fail('INVALID_SERMON_TEMPLATE', 'Invalid sermon inheritance.');
    result.sermonInheritance = {};
    for (const [channel, value] of Object.entries(raw.sermonInheritance)) {
      if (!channelIds.includes(channel) || !value || typeof value.heading !== 'boolean' || !Array.isArray(value.pointKeys)
        || value.pointKeys.length > 500 || value.pointKeys.some(key => typeof key !== 'string' || !/^[A-Za-zА-Яа-я0-9/-]{1,80}$/.test(key))) fail('INVALID_SERMON_TEMPLATE', 'Invalid sermon inheritance output.');
      result.sermonInheritance[channel] = {heading:value.heading, pointKeys:[...new Set(value.pointKeys)]};
    }
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
  if (raw.objectsByChannel !== undefined || raw.sermonTemplate === 'other') {
    if (raw.sermonTemplate !== 'other' || !raw.objectsByChannel || typeof raw.objectsByChannel !== 'object' || Array.isArray(raw.objectsByChannel)) fail('INVALID_CANVAS', 'Choose an Other slide for movable objects.');
    result.objectsByChannel = {};
    for (const [channel, objects] of Object.entries(raw.objectsByChannel)) {
      if (!channelIds.includes(channel)) fail('INVALID_CANVAS', 'Unknown canvas output.');
      result.objectsByChannel[channel] = normalizeCanvasObjects(objects, fail, normalizeSpans);
    }
  }
  return result;
}

/** Editing guides never enter a cue. Existing slides retain their old defaults. */
function sermonSlideBlocks(item, channelId) {
  if (item.sermonTemplate === 'other') return [{ type: 'canvas', objects: item.objectsByChannel[channelId] || [] }];
  const backgroundAssetId = item.backgroundAssetIdsByChannel?.[channelId] || item.backgroundAssetId;
  const blocks = backgroundAssetId ? [{
    type:'image', role:'background', assetId:backgroundAssetId, fit:'fill',
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
  if (item.sermonTemplate === 'quote' && item.quoteSourcesByChannel?.[channelId]) blocks.push({type:'text',role:'credit',text:item.quoteSourcesByChannel[channelId]});
  return blocks;
}
module.exports = { normalizeSermonOptions, sermonSlideBlocks };
