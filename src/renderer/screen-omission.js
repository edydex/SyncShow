'use strict';
// Leaving a screen out for one run: when fewer TVs are connected than the
// service's Screens (Prepare → Screens), the operator can still start Show
// without one of them. The saved service is never changed.
(function expose(root) {
  // Suggested order when nothing else decides: the stage screen first, then English, then Russian.
  const LEAVE_OUT_ORDER = Object.freeze(['media', 'english', 'russian']);

  /** The service's screens for this run: the saved choice minus the screens left out. */
  function withoutScreens(selection, leftOutIds) {
    if (!selection || !Array.isArray(leftOutIds) || !leftOutIds.length) return selection;
    const screenIds = selection.screenIds.filter(id => !leftOutIds.includes(id));
    if (!screenIds.length) return selection;
    return {...selection, screenIds, hintScreenIds: (selection.hintScreenIds || []).filter(id => screenIds.includes(id))};
  }

  /** How many screens this run still needs beyond the connected TVs (0 when they are enough). */
  function missingScreenCount(selection, connectedCount) {
    if (!selection || !(connectedCount > 0)) return 0;
    return Math.max(0, selection.screenIds.length - connectedCount);
  }

  /**
   * Which screens to suggest leaving out: first those whose output has no
   * connected TV, then the stage screen, English and Russian.
   */
  function suggestLeftOut(selection, count, withoutTvIds = []) {
    if (!selection || !(count > 0)) return [];
    const order = [...withoutTvIds, ...LEAVE_OUT_ORDER].filter((id, index, all) => all.indexOf(id) === index && selection.screenIds.includes(id));
    // Never suggest leaving out every screen.
    return order.slice(0, Math.min(count, selection.screenIds.length - 1));
  }

  /** Keeps only real, distinct screens of this service, and never all of them. */
  function cleanLeftOut(selection, leftOutIds) {
    if (!selection || !Array.isArray(leftOutIds)) return [];
    const valid = [...new Set(leftOutIds)].filter(id => selection.screenIds.includes(id));
    return valid.length >= selection.screenIds.length ? [] : valid;
  }

  const api = {LEAVE_OUT_ORDER, withoutScreens, missingScreenCount, suggestLeftOut, cleanLeftOut};
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowScreenOmission = api;
})(typeof globalThis === 'object' ? globalThis : this);
