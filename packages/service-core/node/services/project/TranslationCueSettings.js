 'use strict';
const DEFAULTS = Object.freeze({ sourceLanguage:'en', targetLanguage:'ru', voice:'cedar', speechEnabled:true, captionStyle:'hidden', captionChannel:'russian' });
function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!Object.hasOwn(DEFAULTS,key))) throw new Error('Invalid translation cue settings.');
  const result = { ...DEFAULTS, ...value };
  if (!['en','ru'].includes(result.sourceLanguage) || !['en','ru'].includes(result.targetLanguage) || result.sourceLanguage===result.targetLanguage
    || !['cedar','marin'].includes(result.voice) || typeof result.speechEnabled!=='boolean'
    || !['hidden','ticker','lower-third'].includes(result.captionStyle) || !['english','russian','both'].includes(result.captionChannel)) throw new Error('Choose the spoken and translated languages, voice and caption style.');
  return result;
}
function reservation(settings, channelId) {
  if (!settings || channelId==='media' || (settings.captionChannel!=='both' && settings.captionChannel!==channelId)) return 0;
  return settings.captionStyle==='ticker' ? .12 : settings.captionStyle==='lower-third' ? .29 : 0;
}
module.exports = { DEFAULTS, normalizeSettings, reservation };
