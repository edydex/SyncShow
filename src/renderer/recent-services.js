(function exposeRecentServices(root) {
  'use strict';
  function timestamp(item) {
    const time = Date.parse(item.changedAt || item.updatedAt || '');
    return Number.isFinite(time) ? time : 0;
  }
  function selectLatestService(local, community) {
    const candidates = [
      ...local.map(item => ({ ...item, source: 'local' })),
      ...community.map(item => ({ ...item, id: item.syncId, source: 'community' }))
    ].filter(item => item.id && item.status !== 'archived' && item.planning?.status !== 'archived');
    candidates.sort((a, b) => timestamp(b) - timestamp(a)
      || (a.source === b.source ? String(a.id).localeCompare(String(b.id)) : a.source === 'community' ? -1 : 1));
    return candidates[0] || null;
  }
  async function collectPages(fetchPage, { local = false } = {}) {
    let cursor = null;
    const seen = new Set(), items = [];
    for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
      const result = await fetchPage(local ? { offset: cursor || 0, pageSize: 100 } : { cursor, limit: 50 });
      if (result?.success === false) throw new Error(result.error?.message || 'Community could not be reached.');
      const page = result?.data || result;
      if (!Array.isArray(page?.items)) throw new Error('The service list could not be read.');
      items.push(...page.items);
      cursor = local ? page.nextOffset : page.nextCursor;
      if (cursor == null) return items;
      if (seen.has(String(cursor))) throw new Error('The service list repeated a page. Try refreshing.');
      seen.add(String(cursor));
    }
    throw new Error('The service library is too large to suggest a service. Use Load other.');
  }
  const api = { selectLatestService, collectPages };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncShowRecentServices = Object.freeze(api);
})(typeof window === 'undefined' ? globalThis : window);
