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

Adjust saves backstage. Apply compiles and verifies a complete new ShowPackage,
rechecks the output session, current package, output health and volunteer
authorization, then replaces the graph. Current cue identity and output routing
are preserved where possible. Even the same cue index is explicitly refreshed
through the all-output frame acknowledgement barrier. Clear remains black.
Close flushes the editor without applying. Saves, synchronization and conflict
resolution do not change the projected package.

## Validation

- Full suite: 2,341 tests, 2,339 pass and two skips at the functional checkpoint.
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
  before Apply, changed English output after Apply, preserved cue position,
  Close while Show is active, and canonical server text after reconnect.

Both fixtures use synthetic display inventory and real Electron output windows;
these checks do not establish physical church display/venue acceptance. The
real Community fixture requires `SYNCSHOW_REAL_COMMUNITY_FIXTURE` pointing to a
private disposable device fixture, never production credentials. No app was
installed, production server changed, or release published during this work.
