(function attachPreparedServiceGuard(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowPreparedServiceGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function createPreparedServiceGuard() {
  'use strict';

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function preparedServiceDateGuard({
    presentations,
    serviceHandoff,
    selectedDate,
    confirmedKeys
  } = {}) {
    const loaded = Object.values(
      presentations && typeof presentations === 'object'
        ? presentations
        : {}
    ).filter(presentation => presentation?.loaded);
    const project = serviceHandoff?.project;
    if (
      loaded.length < 1
      || loaded.some(presentation => presentation.source !== 'prepared')
      || !project
      || typeof project.id !== 'string'
      || typeof project.revisionId !== 'string'
    ) {
      return Object.freeze({
        requiresConfirmation: false,
        key: null,
        serviceDate: null,
        selectedDate: null
      });
    }

    const serviceDate = ISO_DATE.test(project.serviceDate || '')
      ? project.serviceDate
      : null;
    const requestedDate = ISO_DATE.test(selectedDate || '')
      ? selectedDate
      : null;
    if (!serviceDate || !requestedDate || serviceDate === requestedDate) {
      return Object.freeze({
        requiresConfirmation: false,
        key: null,
        serviceDate,
        selectedDate: requestedDate
      });
    }

    const key = [project.id, project.revisionId, requestedDate].join(':');
    const alreadyConfirmed = confirmedKeys instanceof Set
      ? confirmedKeys.has(key)
      : Array.isArray(confirmedKeys) && confirmedKeys.includes(key);
    return Object.freeze({
      requiresConfirmation: !alreadyConfirmed,
      key,
      serviceDate,
      selectedDate: requestedDate
    });
  }

  return Object.freeze({ preparedServiceDateGuard });
});
