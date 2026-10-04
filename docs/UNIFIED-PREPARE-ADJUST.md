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

## Current-slide focus and fast backstage edits (Preview 44)

Adjust follows the stable current cue, expands its containing sections, selects
only that slide, scrolls it into view, and opens Edit. The same open service keeps
its draft. Selection inside Adjust remains editing-only.

Embedded editor saves acknowledge the durable local journal before network
upload. Background sync retains manual checkpoints and persists the exact
in-flight request for retry after a lost response or restart. Hidden editor
flushes have a bounded animation-frame fallback, including after Adjust closes.

Publishing uses bounded artifact work and checksum-verified links for identical
scene and thumbnail bytes. Changed visuals still render; repeated visual keys
share one atomic cache write. Packages remain immutable and fully verified.

Validation used the actual shared React editor with a synthetic 96-slide service
and three real Electron output windows in an isolated profile. Adjust selected
and revealed slide 71; saving during a stalled server upload took 1.31 seconds,
closing Adjust took 65 ms, and retaking the text edit reached the English output
in 1.13 seconds. All three outputs acknowledged the cue; projection stayed
unchanged while editing, and background upload eventually synchronized. These
measurements establish local rehearsal behavior, not physical venue acceptance.
The full suite passed 2,414 tests with two skips. Packaged service-core, Sharp,
and PDF runtime checks passed. Preview 44 (140044) was installed and relaunched;
the existing prepared-service pointer remained byte-for-byte identical.

`scripts/verify-adjust-editing-electron.js` expects
`SYNCSHOW_ADJUST_EDITING_FIXTURE` to point to the built Community
`community-server/tests/browser/native-adjust.html` fixture. The fixture mounts
the real editor and uses this script's local mock service; it needs no production
credentials or database. `scripts/bench-backstage-edit.js` separately measures
96-slide package reuse in a disposable local directory.

## Adjust the active local Show (Preview 45)

Adjust now opens the bundled shared editor on the exact immutable project
revision used by the active Show. Its service picker and workspace navigation
are absent. The editor shell, JavaScript, styles, font, service document and
existing media come from this computer. Libraries load when Add slide opens;
cached resources are reused and installed Bible text is resolved locally first.

Show drafts use a separate durable journal from Prepare. Saving and retaking
edits do not require a Community connection or a server document read. Pending
uploads retry independently, including recovered Show journals after restart;
concurrent server edits still require conflict review and never block local
presentation. Selecting inside Adjust remains editing-only. Closing Adjust and
retaking or advancing shows the changed draft.

The real shared editor rehearsal opened cold with Heritage offline on slide 71
of a 96-slide Show, with no service selector and zero server reads. A held upload
did not block the local save (125 ms), closing Adjust (65 ms), or the edited take (1.03 s).
All three native outputs acknowledged the cue, and the edit eventually synced.
Focused tests also cover local history, restart recovery, explicit resource
requests, sandbox isolation, and confined bundled paths. Physical venue display
acceptance remains separate from this isolated rehearsal.

Build the shared native editor with
`SYNCSHOW_COMMUNITY_SOURCE=/path/to/heritage_study_bible npm run build:planner-editor`
before packaging changes to its source. The generated bundle includes its
source component fingerprint and third-party notices.

## Faster saved-edit takes and previews (Preview 46)

Native service outputs render HTML/CSS scenes, including text and local media.
The thumbnail grid and operator LIVE preview use images; the LIVE preview is a
capture of the acknowledged native output rather than a separate approximation.

Saving an active Show draft starts preparing its exact revision in the
background, independently of server upload. A normal take reuses that work or
awaits the same in-flight job. Obsolete queued drafts can be skipped, while an
explicitly requested take retains its exact revision. Preparation cannot change
the active pointer or audience screen; the existing authorization, preemption
and output acknowledgement checks still guard activation.

Publishing avoids duplicate thumbnail reads and redundant immediate artifact
rehashing, verifies scenes with bounded concurrent reads, and reuses verified
media bytes. Final validation still rereads every artifact and checks scenes
against the complete canonical timeline. Retaking the current edited cue skips
the normal fade; advancing keeps it. The operator preview captures immediately
after an edited retake and uses Electron's JPEG encoder for unrotated outputs.
Session, revision and cue guards prevent delayed captures replacing newer ones.

The isolated 96-cue rehearsal measured a local save at 131 ms, close at 66 ms,
an immediate just-saved take at 760 ms, and a background-prepared take at 116 ms.
The operator preview had already updated when checked after output confirmation.
All three native outputs acknowledged the changed cue; background preparation
left the audience unchanged, and Adjust made zero server document reads. These
are local measurements, not a physical church display latency guarantee.

The full suite passed 2,420 tests with two skips, and the additional current-cue
instant-refresh assertion passed in the focused 11-test run. Packaged service
core, Sharp and PDF runtime checks passed. Preview 46 (140046) was installed and
verified in About; the existing 96-cue prepared-service pointer remained
byte-for-byte unchanged. Preview 45 is retained as a rollback bundle.

## Show previews follow saved edits (Preview 47)

The Show slide grid now refreshes as soon as the exact saved backstage package
is ready, without a live take. This includes autosaved edits. A compact status
distinguishes updating previews from saved edits ready to show. Grid refreshes
preserve scroll position and focused cue. The LIVE OUTPUT capture continues to
mirror the audience; preparing or previewing a draft cannot activate its package.

Draft tile clicks take stable cue IDs in the active output session and service.
Adding or removing slides therefore cannot redirect a click through an old live
ordinal. The current-slide highlight follows the live cue's identity in the
draft, and a removed cue cannot highlight a replacement at its former position.
Selecting with Adjust open remains editing-only. Late responses are rejected
after a newer draft, service revision or closed Show. Preview file reads are
bounded and asynchronous, and verify the exact published thumbnail checksums.

Runtime state now includes the validated active output plan, fixing the old
backstage refresh that dropped its renderer copy after a take and prevented
subsequent preview updates. The native rehearsal covers successive saved text
edits, changed thumbnail pixels before a take, unchanged audience and LIVE
OUTPUT, an inserted slide, and taking the shifted tile by stable identity.

The native rehearsal passed with three acknowledged outputs; prepared takes
measured 55 ms and 117 ms. The full suite passed 2,425 tests with two skips.
Packaged service-core, Sharp and PDF runtime checks passed. Preview 47 (140047)
was installed and verified in About. Both existing durable Show draft sources
remained unchanged after restart; normal Load freshness picked up Community
revision 127 from the previously loaded revision 126. Preview 46 is retained
as a rollback bundle. Physical venue acceptance remains separate.
