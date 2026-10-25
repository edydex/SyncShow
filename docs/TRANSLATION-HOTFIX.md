Translation cue and audio setup follow-up: 2.1.1-preview.2.

- Resolve the loaded Community service by its verified document content, avoiding an obsolete local packaging revision marker. The server still verifies the exact saved service revision.
- Start Translate cues reveal their chosen caption language/layout even when saved screen defaults are Hidden.
- Manual Translate reserves caption space in the current native slide and in imported image slides; it restores the original area on Stop and avoids reserving the band twice.
- Translation setup has a Default audio input selector, Find audio inputs, and a visible saved-input summary. Cues and Translate share that input.
- Show distinguishes waiting for captions from captions actually being received.

Includes the previous Show settings/session continuity fixes. This follow-up requires no additional church processor restart.

Expedited Windows venue-testing build: focused translation/rendering tests and Windows installer launch checks. Full platform regression and physical venue acceptance remain pending.

Runtime dependencies are unchanged from 2.1.0. Native dependency sources and notices remain available in the [2.1.0 release](https://github.com/edydex/SyncShow/releases/tag/v2.1.0).
