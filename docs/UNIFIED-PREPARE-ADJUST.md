# Community Prepare and backstage Adjust

SyncShow uses the same Community service editor in Prepare and Show's Adjust
panel. The previous native authoring surface is retained internally for its
import and compatibility controllers, but is no longer a second Prepare tab.
Prepare → Load → Show remains the volunteer workflow.

Date warnings use the current day in the venue time zone at each Start Show
attempt. Today's and future services are allowed; an older prepared service
requires confirmation once per exact revision and current day. The PowerPoint
search date does not affect this check. Filename and folder warnings also flag
only dates before today, and are refreshed before starting, including when the
app has remained open across midnight.

The approved Community connection owns a private persistent browser session
and a private disk cache. The original editor HTML, Next assets and downloaded
libraries are available after reopening offline. English BSB/LSV and Russian
SYNO-W can resolve new readings without contacting the church server. Song
details and prepared sermon details are prefetched when their library opens;
uncached resources report that they need a connection. A first connection must
download the editor before it can open offline.

Service saves are validated and written to an atomic, fsynced local journal
before success. The editor's local compare-and-swap version stays stable when
reconnecting; the remote base is tracked separately because coalescing automatic
saves changes the server version count. Automatic versions group within five
minutes. Manual checkpoints are replayed individually, even when intervening
automatic saves coalesce. Local historical sources remain privately available.

Reconnection uses the original remote revision/version. A conflicting server
change stops replay. The operator compares both copies and explicitly chooses
one; the reviewed remote revision is rechecked, and both complete sources are
archived before resolution. A later remote change cannot be silently replaced.

Adjust saves backstage. Typing, synchronization and conflict resolution keep the
projected package pinned. Clicking a slide again or advancing flushes the editor,
compiles and verifies the latest complete ShowPackage, then rechecks the output
session, current graph, Clear/Bible operation epoch, output health and operator
authorization. Every output acknowledges the intended stable cue before the
operator sees a committed take. A clicked tile maps by cue ID, while Advance
uses the live cue's identity and then the latest draft ordering. A removed live
cue blocks Advance; a valid explicit tile can take its replacement. No old
ordinal is used as a fallback. Clear or Stop during saving/compilation preempts
the take. A locked volunteer continues the already verified graph until an
operator unlocks publishing.

The Show layout keeps service sections on the left, a thumbnail grid in the
center, and one selected LIVE output with Next/Clear controls on the right.
Adjust keeps that LIVE panel visible. Its shared editor enables scoped Show tile
clicks only for the current service, through a narrow sandboxed preload. The
native LIVE preview can also re-take the current slide. Ordinary Prepare clicks
remain previews. Double-click opens editing; subsequent edits stay backstage.
Close flushes and disables the take bridge. Device account language is retained
in cached service metadata and reused offline.

## Validation

- Full suite: 2,356 tests, 2,354 pass and two skips.
- Production-function tests verify stable targets, removed cues, Clear during
  flush/compilation, pointer activation rollback, and locked volunteer behavior.
- Focused offline tests cover restart, oldest remote base, offline creation,
  conflict preservation and both resolution choices, manual checkpoint replay,
  continued editing after coalesced reconnect, cached song details, late reads,
  and new English/Russian readings.
- `scripts/fixtures/unified-prepare-electron-app.js` exercises the actual desktop
  main/renderer with a small mock Community contract and isolated user data.
- `scripts/fixtures/unified-prepare-community-app.js` exercises the built real
  Community editor and disposable approved device against an isolated database,
  through a loopback proxy that can simulate disconnection. It verifies real
  caption editing, saved text after an offline page reload, stable projection
  while editing, changed English output after normal re-take, scoped shared
  thumbnail take, truthful LIVE tile marker, visible rejected-take error with
  unchanged output, normal Next, Russian and Stage-Facing native output, preserved cue position,
  Close while Show is active, and canonical server text after reconnect.

`scripts/fixtures/unified-prepare-offline-restart-app.js` then starts a second
process with the same marked profile and every upstream request disconnected.
The original editor and prepared service reopen; focused Ctrl+S writes a manual
checkpoint and a durable pending edit to the private journal.

The display fixtures use synthetic display inventory and real Electron output windows;
these checks do not establish physical church display/venue acceptance. The
real Community fixture requires `SYNCSHOW_REAL_COMMUNITY_FIXTURE` pointing to a
private disposable device fixture, never production credentials. The local Preview 37 app was installed for review; Preview 38 adds the Load navigation fix. Public release publication remains separate from these local checks.

## Load while a Prepare save is pending

Load opens immediately. The editor gets up to three seconds to confirm its saved service; a failed or unanswered save leaves a visible warning and the saved-service picker usable. Returning to Prepare, choosing another service, or starting Show cancels the pending handoff so a late response cannot replace the operator’s selection. Six focused tests and the real isolated Electron fixture cover failure, legacy editors, navigation cancellation, and successful loading. The full Preview 38 suite passed 2,360 tests with two skips (2,362 total).

Load checks the currently loaded Community service on startup, when entering Load,
and before Start Show. It fetches the authoritative record rather than treating a
Prepare cache as current. Unchanged content keeps the verified package without a
rebuild. A newer revision is built with inline progress; the chooser opens only
for an explicit browse action or an actual conflict. Pending Prepare journals,
concurrent local edits, and an active Show cannot be overwritten by this check.
Offline errors preserve the last package and state that freshness is unverified.

## Incremental Load and Adjust (Preview 42)

Load uses authenticated conditional GET against the saved canonical revision. An unchanged server revision returns 304 and reuses the verified package, with no document/media download or publishing. Prepare's successful editor flush is authoritative even after a previously failed PUT. A matching cached snapshot also skips publishing on Prepare-to-Load navigation.

A changed document is validated as a complete canonical snapshot. Missing media is fetched by SHA-256; an app-private, verified content cache reuses identical bytes across services. Scene thumbnails are cached by renderer inputs, font hash, output settings, and renderer version. Singer inputs include the next cue, so changes to hints invalidate the preceding thumbnail. Cue metadata and package manifests are regenerated for each exact revision and retain their verification guarantees.

Adjust opens the content editor on the live cue, using an editable audience output rather than retaining a condensed stage-facing preview. Edits save backstage and reach outputs only through a normal take or advance. Double-clicking a tile to edit cancels the delayed single-click take.
