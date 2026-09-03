'use strict';

// NODE_OPTIONS reaches Electron helper processes as well as the browser
// process. Keep the privileged test instrumentation entirely out of renderers
// and utilities; the browser-process fixture performs the remaining exact-path
// and nonce checks before it installs anything.
if (
  process.type === 'browser'
  && process.env.SYNCSHOW_PACKAGED_LIVE_CUE_INSTRUMENTATION === '1'
) {
  require('./live-cue-navigation-electron-app');
}
