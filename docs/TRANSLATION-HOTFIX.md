Translation cue region follow-up: 2.1.1-preview.3.

- Ordinary Show slides before and after a translation cue region use the full screen. Saved lower-third defaults no longer paint an empty band over those slides.
- Leaving or jumping outside the cue region hides captions immediately, even before a pending processor stop completes. Late captions and reopening settings cannot reveal that band again.
- The slide immediately before Start still prepares audio without displaying a band.
- Manual Translate and translation-only screens retain their chosen layouts. Saved screen defaults and the shared default audio input are preserved.

Includes the previous translation, Show settings, and session continuity fixes. No church processor restart or default settings reset is needed.

Expedited Windows venue-testing build: focused translation/rendering tests and Windows installer launch checks. Full platform regression and physical venue acceptance remain pending.

Runtime dependencies are unchanged from 2.1.0. Native dependency sources and notices remain available in the [2.1.0 release](https://github.com/edydex/SyncShow/releases/tag/v2.1.0).
