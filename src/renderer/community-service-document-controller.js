/**
 * Visible shared-service workflow for HeritageServiceDocumentV1.
 *
 * The renderer sees summaries and explicit conflict choices only. Credentials,
 * canonical serialization, the durable outbox, and all compare-and-swap writes
 * stay in the main process.
 */
(function exposeSharedServiceController() {
  'use strict';

  const PAGE_SIZE = 50;

  function byId(id) {
    return document.getElementById(id);
  }

  function checked(result) {
    if (result?.success === false) {
      const error = new Error(
        result.error?.message || 'The shared-service operation could not be completed.'
      );
      error.code = result.error?.code || 'COMMUNITY_ERROR';
      throw error;
    }
    return result?.data && typeof result.data === 'object'
      ? result.data
      : result;
  }

  function friendlyDate(value) {
    const date = new Date(`${String(value || '')}T12:00:00`);
    if (Number.isNaN(date.getTime())) return String(value || 'Date unavailable');
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(date);
  }

  function shortRevision(value) {
    return typeof value === 'string' && value.length >= 12
      ? value.slice(0, 12)
      : 'unknown';
  }

  function createController(options = {}) {
    const api = options.api || window.api || {};
    const prepareController = options.prepareController;
    const onStatus = typeof options.onStatus === 'function'
      ? options.onStatus
      : () => {};
    const elements = {
      card: byId('prepareSharedServices'),
      cardStatus: byId('prepareSharedServicesStatus'),
      browse: byId('btnBrowseSharedServices'),
      dialog: byId('sharedServicesDialog'),
      notice: byId('sharedServicesNotice'),
      list: byId('sharedServicesList'),
      refresh: byId('btnRefreshSharedServices'),
      loadMore: byId('btnLoadMoreSharedServices'),
      close: byId('btnCloseSharedServices'),
      retry: byId('btnRetrySharedServices'),
      detailEmpty: byId('sharedServiceDetailEmpty'),
      conflict: byId('sharedServiceConflict'),
      conflictTitle: byId('sharedServiceConflictTitle'),
      conflictDescription: byId('sharedServiceConflictDescription'),
      conflictLocal: byId('sharedServiceConflictLocal'),
      conflictRemote: byId('sharedServiceConflictRemote'),
      useCommunity: byId('btnUseCommunityService'),
      keepLocal: byId('btnKeepLocalService')
    };
    const requiredMethods = [
      'getCommunityStatus',
      'listCommunityServiceDocuments',
      'getCommunityServiceDocumentState',
      'openCommunityServiceDocument',
      'saveCommunityServiceDocument',
      'flushCommunityServiceDocuments'
    ];
    const state = {
      available: false,
      capable: false,
      busy: false,
      items: [],
      nextCursor: null,
      conflict: null,
      autosave: null,
      autosaveTimer: null,
      autosaveBusy: false,
      autosaveMessage: ''
    };

    function setCard(message, kind = '') {
      elements.cardStatus.textContent = message;
      elements.cardStatus.dataset.kind = kind;
    }

    function setNotice(message, kind = '') {
      elements.notice.textContent = message;
      elements.notice.dataset.kind = kind;
    }

    function setBusy(busy) {
      state.busy = busy;
      elements.browse.disabled = !state.capable || busy;
      elements.refresh.disabled = busy;
      elements.loadMore.disabled = busy;
      elements.close.disabled = busy;
      elements.retry.disabled = busy;
      elements.useCommunity.disabled = busy;
      elements.keepLocal.disabled = busy;
      elements.dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    function renderConflict() {
      const review = state.conflict;
      elements.conflict.hidden = !review;
      elements.detailEmpty.hidden = Boolean(review);
      if (!review) return;
      const local = review.local || {};
      const remote = review.remote || {};
      const descriptions = {
        'unbound-local-service': 'A local service already uses this identity, but it has never been linked to this Community record.',
        'different-community': 'This local service is linked to a different Community record.',
        'concurrent-change': 'Community and this computer both changed after their last common revision.'
      };
      elements.conflictTitle.textContent = review.kind === 'concurrent-change'
        ? 'Both copies changed'
        : 'Confirm which service should continue';
      elements.conflictDescription.textContent = descriptions[review.kind]
        || 'The two copies differ and SyncShow will not overwrite either one automatically.';
      elements.conflictLocal.textContent = [
        local.title || local.projectId || 'Local service',
        local.serviceDate ? friendlyDate(local.serviceDate) : '',
        `revision ${shortRevision(local.documentRevision)}`
      ].filter(Boolean).join(' · ');
      elements.conflictRemote.textContent = [
        remote.title || remote.syncId || 'Community service',
        remote.serviceDate ? friendlyDate(remote.serviceDate) : '',
        Number.isSafeInteger(remote.syncVersion)
          ? `Community version ${remote.syncVersion}`
          : '',
        remote.revision ? `revision ${shortRevision(remote.revision)}` : ''
      ].filter(Boolean).join(' · ');
    }

    function renderList() {
      elements.list.replaceChildren();
      if (state.items.length < 1) {
        const message = document.createElement('p');
        message.className = 'prepare-list-message';
        message.textContent = state.busy
          ? 'Loading shared services…'
          : 'No shared services are available.';
        elements.list.appendChild(message);
      }
      for (const item of state.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'prepare-project-button shared-service-button';
        button.disabled = state.busy;
        button.dataset.syncId = item.syncId;
        const title = document.createElement('strong');
        title.textContent = item.title;
        const detail = document.createElement('span');
        const pending = item.shared?.pending
          ? ' · saved locally, waiting to sync'
          : '';
        detail.textContent = `${friendlyDate(item.serviceDate)} · ${item.status} · v${item.syncVersion}${pending}`;
        button.append(title, detail);
        button.addEventListener('click', () => openService(item.syncId));
        elements.list.appendChild(button);
      }
      elements.loadMore.hidden = !state.nextCursor;
      elements.loadMore.disabled = state.busy;
    }

    async function refreshCapability() {
      if (!state.available) {
        setCard('This build does not include the shared-service bridge.', 'error');
        return false;
      }
      try {
        const status = checked(await api.getCommunityStatus());
        const connection = status?.connection || null;
        state.capable = Boolean(
          status?.connected
          && connection?.canReadServiceDocuments
        );
        if (state.capable) {
          setCard(
            state.autosaveMessage
              || `Open and edit the same service stored in ${connection.serverName || 'Heritage Community'}.`,
            state.autosaveMessage ? 'warning' : 'success'
          );
        } else if (status?.connected) {
          setCard(
            'Reconnect Community in Admin Settings to approve shared-service access.',
            'warning'
          );
        } else {
          setCard('Connect Heritage Community in Admin Settings.', 'warning');
        }
      } catch (error) {
        state.capable = false;
        setCard(error.message, 'error');
      }
      elements.browse.disabled = !state.capable || state.busy;
      return state.capable;
    }

    async function loadServices({ append = false } = {}) {
      if (state.busy) return false;
      setBusy(true);
      if (!append) {
        state.items = [];
        state.nextCursor = null;
        state.conflict = null;
      }
      setNotice(append ? 'Loading more services…' : 'Loading services…');
      renderConflict();
      renderList();
      try {
        const page = checked(await api.listCommunityServiceDocuments({
          cursor: append ? state.nextCursor : null,
          limit: PAGE_SIZE
        }));
        const combined = append ? [...state.items, ...page.items] : page.items;
        if (new Set(combined.map(item => item.syncId)).size !== combined.length) {
          throw new Error('Community repeated a service in the list. Refresh before opening it.');
        }
        state.items = combined;
        state.nextCursor = page.nextCursor;
        setNotice(
          `${combined.length} shared ${combined.length === 1 ? 'service' : 'services'} available.`,
          'success'
        );
        return true;
      } catch (error) {
        setNotice(error.message, 'error');
        return false;
      } finally {
        setBusy(false);
        renderList();
      }
    }

    async function showOpenedService(syncId, result) {
      const opened = await prepareController.openProjectById(syncId);
      if (!opened) throw new Error('The shared service was saved locally but could not be opened.');
      state.conflict = null;
      elements.dialog.close();
      if (result.state === 'queued') {
        state.autosaveMessage = 'Saved locally. Community is unavailable, so this service is waiting to sync.';
        setCard(state.autosaveMessage, 'warning');
        onStatus(state.autosaveMessage);
      } else if (result.state === 'local-newer') {
        state.autosaveMessage = 'This computer has a newer local edit that still needs to sync.';
        setCard(state.autosaveMessage, 'warning');
      } else {
        state.autosaveMessage = '';
        setCard('This service is linked to Heritage Community.', 'success');
      }
    }

    async function openService(syncId, resolution = null) {
      if (state.busy) return false;
      setBusy(true);
      setNotice(
        resolution ? 'Applying the reviewed choice…' : 'Opening the exact shared service…'
      );
      try {
        const result = checked(await api.openCommunityServiceDocument({
          syncId,
          resolution
        }));
        if (result.state === 'conflict') {
          state.conflict = { syncId, ...result.conflict };
          renderConflict();
          setNotice('Nothing was overwritten. Review both versions and choose one.', 'warning');
          return false;
        }
        await showOpenedService(syncId, result);
        return true;
      } catch (error) {
        setNotice(error.message, 'error');
        return false;
      } finally {
        setBusy(false);
        renderList();
      }
    }

    async function resolveConflict(resolution) {
      const syncId = state.conflict?.syncId;
      if (!syncId) return;
      await openService(syncId, resolution);
    }

    async function retryOfflineSaves() {
      if (state.busy) return;
      setBusy(true);
      setNotice('Retrying locally saved changes…');
      try {
        const payload = checked(await api.flushCommunityServiceDocuments());
        const conflicts = payload.results.filter(result => result.state === 'conflict');
        const waiting = payload.results.filter(result => result.state === 'waiting');
        const synced = payload.results.filter(result => result.state === 'synced');
        if (conflicts.length) {
          setNotice('A queued service also changed in Community. Open that service to review both versions.', 'warning');
        } else if (waiting.length) {
          setNotice('Community is still unavailable. The local saves remain queued safely.', 'warning');
        } else {
          state.autosaveMessage = '';
          setNotice(
            synced.length
              ? `${synced.length} queued ${synced.length === 1 ? 'save is' : 'saves are'} now synchronized.`
              : 'There are no offline saves waiting.',
            'success'
          );
          await refreshCapability();
        }
      } catch (error) {
        setNotice(error.message, 'error');
      } finally {
        setBusy(false);
      }
    }

    async function flushAutosave() {
      if (state.autosaveBusy || !state.autosave) return;
      state.autosaveBusy = true;
      try {
        while (state.autosave) {
          const requested = state.autosave;
          state.autosave = null;
          const current = prepareController.getCurrent();
          if (current.project?.id !== requested.project.id
            || current.revisionId !== requested.revisionId) {
            continue;
          }
          const serviceState = checked(
            await api.getCommunityServiceDocumentState({
              projectId: requested.project.id
            })
          );
          if (!serviceState.shared) continue;
          setCard('Saving this edit to Heritage Community…');
          const saved = checked(await api.saveCommunityServiceDocument({
            projectId: requested.project.id,
            expectedRevisionId: requested.revisionId,
            status: 'planning'
          }));
          if (saved.state === 'conflict') {
            state.autosaveMessage = 'Community also changed. Open shared services to review both copies; neither was overwritten.';
            setCard(state.autosaveMessage, 'warning');
            onStatus(state.autosaveMessage);
          } else if (saved.state === 'queued') {
            state.autosaveMessage = 'Saved locally. This edit will synchronize when Community is reachable.';
            setCard(state.autosaveMessage, 'warning');
          } else {
            state.autosaveMessage = '';
            setCard('Saved locally and to Heritage Community.', 'success');
          }
        }
      } catch (error) {
        state.autosaveMessage = error.message;
        setCard(`Saved locally. Community save needs attention: ${error.message}`, 'warning');
      } finally {
        state.autosaveBusy = false;
        if (state.autosave) scheduleAutosave();
      }
    }

    function scheduleAutosave() {
      if (state.autosaveTimer !== null) window.clearTimeout(state.autosaveTimer);
      state.autosaveTimer = window.setTimeout(() => {
        state.autosaveTimer = null;
        flushAutosave();
      }, 450);
    }

    function projectChanged(result) {
      if (!state.capable || !result?.project?.id || !result?.revisionId) return;
      state.autosave = result;
      scheduleAutosave();
    }

    async function browseServices() {
      if (!await refreshCapability()) return false;
      elements.dialog.showModal();
      await loadServices();
      return true;
    }

    function bindEvents() {
      elements.browse.addEventListener('click', browseServices);
      elements.close.addEventListener('click', () => elements.dialog.close());
      elements.dialog.addEventListener('cancel', event => {
        if (state.busy) event.preventDefault();
      });
      elements.refresh.addEventListener('click', () => loadServices());
      elements.loadMore.addEventListener('click', () => loadServices({ append: true }));
      elements.retry.addEventListener('click', retryOfflineSaves);
      elements.useCommunity.addEventListener('click', () => resolveConflict('use-community'));
      elements.keepLocal.addEventListener('click', () => resolveConflict('keep-local'));
    }

    const controller = Object.freeze({
      initialize() {
        state.available = requiredMethods.every(method =>
          typeof api[method] === 'function')
          && typeof prepareController?.openProjectById === 'function'
          && typeof prepareController?.getCurrent === 'function';
        bindEvents();
        refreshCapability();
        return controller;
      },
      open: browseServices,
      projectChanged,
      refresh: refreshCapability
    });
    return controller;
  }

  window.SyncShowSharedServices = Object.freeze({ createController });
})();
