Translation saved-project follow-up: 2.1.1-preview.4.

- Fix translation cues failing with “ServiceProject must be a syncshow-service-project schema v1 document.” Read the exact full saved project revision that produced the loaded Show package, rather than treating its abbreviated handoff summary as an editable service document.
- Keep the server's exact Community service revision check. A newer local draft does not replace the loaded service's translation identity.
- Remember the last named audio input on this computer across restarts, including as a fallback for a new venue or Community connection. Explicit per-venue input choices remain saved.
- Restore the saved Computer audio selection before opening translation controls.

Includes the caption-region, layout, input selector, Show settings, and session continuity fixes. No church processor restart or service-plan edit is needed.

Validation includes a real project saved to disk, published to a Show package, reopened, then used for Prepare/Start/Stop commands while a newer draft exists. Focused translation tests and Windows installer installation/launch checks are used for this expedited venue-testing build. Physical church audio and full cross-platform regression remain pending.

Runtime dependencies are unchanged from 2.1.0. Native dependency sources and notices remain available in the [2.1.0 release](https://github.com/edydex/SyncShow/releases/tag/v2.1.0).
