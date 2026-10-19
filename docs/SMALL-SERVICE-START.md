# Small gatherings and local presentations

Start Blank is available beside Admin Settings. Choose English, Russian, Stage-Facing, or a combination. Selected cards are green. Audience next-slide hints are optional; selecting Stage-Facing enables its hints by default.

These are presentation choices. They do not rewrite the venue profile, display assignments, or the Sunday service. In Automatic mode SyncShow keeps usable saved assignments and fills unused external screens. An explicitly selected output can be used even when its saved venue output switch is off. A disabled presentation input still needs to be enabled in Screen Setup. The operator display is never assigned automatically.

Start Blank opens Show immediately. With enough connected screens, it projects black until you select a slide. Without enough screens, Show runs in clearly labeled Preview only mode using hidden offscreen renderers; it never takes over the operator screen. End Show, connect your screens, and use Load → Start Show to begin projection. Choose Screens in the editor to change the presentation's outputs and hints before Show.

Local presentations save privately on this computer. They do not require a Community connection, readiness review, or service selector. New songs entered in the bundled editor are saved to a separate private desktop catalog; connected or downloaded church songs remain available in the same picker. Installed Bible texts work offline; online-only editions still require a connection. Images and other content remain pinned with the saved presentation.

The Show toolbar has + Song, + Passage and + Media beside Adjust. These buttons also stay visible at the top of Adjust, so subsequent additions do not require closing the editor. Each opens the matching library in the pinned local editor for the active presentation. Adding content stays backstage while the current cue continues playing. The separate Bible button sends a temporary passage and Return restores the cue underneath; its normal and stage renderers share orange references, white Arial text and a black background.

During Show, editing stays backstage. Close Adjust and click a saved slide or advance to show the change. Neither typing nor adding a song changes the current audience frame. Reopening Prepare follows the last committed local Show revision while preserving any separate unfinished Prepare draft.

Admin Settings is on the left of the top bar. Its Translation tab opens Translation setup. Screen Setup contains the Show Start Blank preference, enabled by default.

Start Show checks connected screens again before readiness. Saved OS display IDs are no longer rejected merely because resolution, scaling, or rotation changed. New assignments use a mode-independent, hashed platform display label when available; unique matching labels can reconnect after an ID change. Duplicate or uncertain matches still require an explicit choice, and the operator screen remains protected. Older mode-based assignments continue to work without rewriting the venue profile.

Screen history is recorded locally and privately across restarts (up to 200 bounded events, at most 2 MiB). It includes startup, screen additions/removals/mode changes, sleep/resume, saved assignments and match decisions, Start, output failures, and recovery targets. Use Admin Settings → Screen Setup → Save diagnostics… after a problem, including after manually reassigning a screen. Export also includes the existing app/OS/GPU/font/startup checks, but not credentials, full file paths, or slide contents. Nothing is uploaded automatically.

## Verification

- Actual macOS Electron control window inspected for card contrast, the local song form, and the direct Show additions toolbar.
- Disposable profiles tested with zero, one, two, three, and Stage-Facing-only simulated external displays: offline song creation, saved venue profile preservation, Prepare-to-Load handoff, and live cue acknowledgement on every selected output.
- Quick Show rehearsals cover zero, one and three simulated external screens, song and passage insertion while the current cue stays live, temporary Bible display/return with computed colors, Clear/Restore, and recovery of intentionally crashed hidden preview renderers.
- Full process restart checks preserve the local presentation, private song catalog, and hidden Start Blank preference.
- Focused contracts cover canonical serialization, legacy projects, package reopen, hint thumbnail invalidation, intentional blanks, private local saves, and committed-versus-unfinished local journals.
- The screen-recognition rehearsal exercises repeated additions in the actual editor, hidden preview recovery, three simulated outputs, a changed monitor ID and mode, Start-time rescan, and diagnostic export. CI runs it on Windows, both Mac architectures, and Linux.
- Physical venue projection is not covered by these simulated local/CI checks. Check the release and packaged-platform receipts separately before describing an installer as published or verified.
