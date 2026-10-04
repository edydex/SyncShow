(function attachPreparedServiceGuard(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowPreparedServiceGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function createPreparedServiceGuard() {
  'use strict';

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function validServiceDate(value) {
    if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function isPastServiceDate(serviceDate, currentDate) {
    return validServiceDate(serviceDate) && validServiceDate(currentDate)
      && serviceDate < currentDate;
  }

  function preparedServiceDateGuard({
    presentations,
    serviceHandoff,
    currentDate,
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
        currentDate: null
      });
    }

    const serviceDate = validServiceDate(project.serviceDate)
      ? project.serviceDate
      : null;
    const today = validServiceDate(currentDate)
      ? currentDate
      : null;
    if (!isPastServiceDate(serviceDate, today)) {
      return Object.freeze({
        requiresConfirmation: false,
        key: null,
        serviceDate,
        currentDate: today
      });
    }

    const key = [project.id, project.revisionId, today].join(':');
    const alreadyConfirmed = confirmedKeys instanceof Set
      ? confirmedKeys.has(key)
      : Array.isArray(confirmedKeys) && confirmedKeys.includes(key);
    return Object.freeze({
      requiresConfirmation: !alreadyConfirmed,
      key,
      serviceDate,
      currentDate: today
    });
  }

  return Object.freeze({ preparedServiceDateGuard, isPastServiceDate });
});
