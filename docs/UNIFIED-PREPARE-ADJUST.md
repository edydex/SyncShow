# Community Prepare and backstage Adjust

SyncShow uses the same Community service editor in Prepare and Show's Adjust
panel. The previous native authoring surface is retained internally for its
import and compatibility controllers, but is no longer a second Prepare tab.
Prepare → Load → Show remains the volunteer workflow.

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
private disposable device fixture, never production credentials. No app was
installed, production server changed, or release published during this work.
