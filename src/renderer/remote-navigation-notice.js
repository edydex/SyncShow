(() => {
  'use strict';
  const banner = document.getElementById('remoteNavigationNotice');
  const copy = document.getElementById('remoteNavigationCopy');
  let timer;
  function dismiss() { clearTimeout(timer); banner.hidden = true; }
  document.getElementById('remoteNavigationDismiss').addEventListener('click', dismiss);
  window.api.onRemoteNavigation(notice => {
    copy.textContent = `${notice.deviceName} changed to slide ${notice.cueNumber} · ${notice.cueLabel}`;
    banner.hidden = false; clearTimeout(timer); timer = setTimeout(dismiss, 6000);
  });
  window.api.onShowStateChanged(({ state }) => { if (!state?.outputSessionId) dismiss(); });
})();
