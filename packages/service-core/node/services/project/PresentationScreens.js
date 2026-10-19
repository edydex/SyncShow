'use strict';

// These are content outputs, not saved physical-display assignments.
(function expose(root) {
  const SCREEN_IDS = Object.freeze(['english', 'russian', 'media']);

  function normalizePresentationScreens(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['screenIds', 'hintScreenIds', 'localOnly'].includes(key))) {
      throw new TypeError('Presentation screens contain unsupported settings.');
    }
    const normalizeIds = (ids, label) => {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length
        || ids.some(id => !SCREEN_IDS.includes(id))) throw new TypeError(`${label} are invalid.`);
      return SCREEN_IDS.filter(id => ids.includes(id));
    };
    const screenIds = normalizeIds(value.screenIds, 'Presentation screens');
    if (!screenIds.length) throw new TypeError('Choose at least one presentation screen.');
    const hintScreenIds = normalizeIds(value.hintScreenIds ?? screenIds.filter(id => id === 'media'), 'Next-slide hints');
    if (hintScreenIds.some(id => !screenIds.includes(id))) throw new TypeError('Next-slide hints need an enabled screen.');
    if (value.localOnly !== undefined && value.localOnly !== true) throw new TypeError('Local presentation flag is invalid.');
    return {screenIds, hintScreenIds, ...(value.localOnly ? {localOnly: true} : {})};
  }

  function screenIdForChannel(id) {
    if (SCREEN_IDS.includes(id)) return id;
    if (id === 'primary') return 'russian';
    if (id === 'secondary') return 'english';
    if (/stage|singer/i.test(id || '')) return 'media';
    return null;
  }

  const api = {SCREEN_IDS, normalizePresentationScreens, screenIdForChannel};
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowPresentationScreens = api;
})(typeof globalThis === 'object' ? globalThis : this);
