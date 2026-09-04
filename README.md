# SyncShow - Synchronized Church Presentation System

A cross-platform desktop application for planning and running synchronized church services. Safe defaults still match the original Russian/English/Singers venue, while administrators can rename, add, remove, reorder, and map input and output roles for other churches. Native ServiceProjects, editable cues, and ShowPackages are the product direction; PowerPoint remains an optional legacy and emergency fallback.

## Features

- **Synchronized Configurable Outputs**: Advance any number of named venue outputs together; Russian, English, and Singers are only the safe starter profile
- **Native Prepare workspace and weekly planning**: Build a semantic service from titled section dividers, arranged songs, pinned Bible passages, per-output sermon/notice text, intentional blank cues, and output-specific pictures; explicitly choose exact/follow/current-plus-next/Hidden song behavior and BSB/LSV/Hidden Scripture behavior for every output—including the generated reading before a linked sermon; plan the next service from one exact saved revision; then publish the exact reviewed revision for Load
- **Paste-first native sermon workflow**: Create this week’s sermon packet, confirm its primary passage, paste the pastor’s manuscript and/or slide notes, preserve the exact reviewed wording privately, and turn chosen canonical paragraphs into editable native cues without requiring an office file
- **Direct song authoring**: Create, edit, and translate songs inside SyncShow using `^1`, named sections such as `^chorus`, explicit `---` slide breaks, Unicode section names, attribution, licensing, and translation-alignment checks
- **Scalable song intake**: Search a paged Song Library with an explicit result count, or batch-import as many as 50 Markdown/TXT songs while retaining successful files if another file needs correction
- **Reviewed Heritage Community song sync**: Keep the local library usable offline, stage complete song families privately, and require an explicit exact-family rights review before any current or scheduled member-visible write
- **Revocable anonymous song-link client**: Keep signed-in member access separate from anyone-with-the-link access; require a second exact-family permission review, pin every link to one immutable family revision, and confirm every create or revoke online
- **Reviewed weekly sermon packets and guarded Community client**: Preserve immutable sermon revisions and private source files locally; review one exact current presentation set plus its manuscript, explicitly confirm a complete manuscript/transcript as ordered canonical sermon body text, keep an existing in-deck reading by default or insert a native BSB reading, and manually pull/push one exact revision through a compatible advertised Community sermon resource without uploading private source bytes
- **Explicit resumable private sermon recording preservation**: Keep MP3/M4A bytes locally reviewable, opt in to separate Community media permissions only when needed, upload only missing verified 8 MiB chunks, survive restarts and local-file loss after the durable completion claim, and keep publication entirely separate
- **Exact prepared-item previews**: Choose a configured output and step through the selected item as rendered by the same preset-backed native renderer used to publish the service
- **Resolution-checked native output**: Renderer v8 has real source-Electron direct and derived-Singer rehearsal matrices at 640×360 and 1920×1080, including exact Bible fit checks, exact current/next/blank/end Singer states, and a deliberate fail-closed overflow probe
- **Recoverable, portable services**: Every Prepare change is autosaved to revision history for Undo/Redo; duplicate individual cues or complete nested sections, and move a service with its pictures in a verified `.syncshow-service` file
- **Load-first workflow**: Opens on a focused service-readiness screen and explains exactly why Start is unavailable
- **Normal Person Friendly Mode**: Keeps venue defaults while hiding timing, preview, and typography controls volunteers do not need
- **One-click weekly service loading**: Finds a coherent same-date set in a private Google Drive folder, public view-only Drive link, or local/synced folder; pins an integrity-checked offline copy; and never silently mixes Sundays
- **Calm Show screen**: Grid view, large navigation/output controls, visible live/cleared/interrupted/error state, keyboard-accessible thumbnails, and Singer preview by default
- **Flexible venue profiles**: Persist custom input/output names, counts, ordering, routes, preview preferences, and conservative monitor bindings
- **Missing-Media preflight**: Upload Media, derive a next-text view, mirror an existing deck as-is, or turn the output off for one service
- **Live Bible passages**: Heritage-style shortcuts and explicit numbered-book choices, with bundled BSB/LSV text, preview, selected outputs, Send Live, and exact Return to slides
- **Show-only phone Remote**: Explicitly enable a trusted local network, pair by QR or six-digit code, then use current/next previews, Previous/Next, jump, Restore, and Clear without exposing files or Settings
- **Singer Screen Support**: Any configured output can explicitly derive current-plus-next lyrics from another output, with distinct next-text, intentional-blank, and end-of-presentation states
- **Keyboard Shortcuts**: Navigate with arrow keys, space bar, Home/End keys
- **Hardware Accelerated**: Uses Chromium GPU rendering when available
- **Legacy/fallback PPTX conversion**: Existing PowerPoint services can still be rendered to optimized JPEG images for migration, old services, and emergencies
- **Legacy Current PowerPoint handoff, song capture, and visual bridge**: Preserve a nonprojected sermon record, review reusable songs, or create a source-faithful picture-cue draft from one exact already-loaded ServiceSet without changing the original presentations or making PowerPoint the editable model

## System Requirements

- **OS**: Windows 10/11, macOS 12+ (Intel & Apple Silicon), or Linux
- **RAM**: 8 GB minimum, 16 GB recommended
- **Storage**: SSD recommended for fast image loading
- **Displays**: 2-4 display outputs (HDMI, DisplayPort, or VGA)
- **Optional legacy presentation converter**: Microsoft PowerPoint or [LibreOffice](https://www.libreoffice.org/download/) on Windows; LibreOffice on macOS and Linux

## Installation

### Download Pre-built Releases

Download the latest installer for your platform from the [Releases page](https://github.com/edydex/SyncShow/releases):

- **Windows**: `SyncShow Setup X.X.X.exe`
- **macOS**: separate Intel and Apple Silicon `.dmg`/`.zip` downloads
- **Linux**: `SyncShow-X.X.X.AppImage` or `.deb`

### macOS Installation

1. **Download** the `.dmg` file from [Releases](https://github.com/edydex/SyncShow/releases)
2. **Open** the DMG file
3. **Drag** SyncShow to the Applications folder
4. **First launch** - You may see "SyncShow can't be opened because Apple cannot check it for malicious software"

   **To bypass Gatekeeper** (required for unsigned apps):
   - **Option 1**: Right-click (or Control-click) on SyncShow in Applications → click **Open** → click **Open** in the dialog
   - **Option 2**: Go to **System Settings → Privacy & Security** → scroll down and click **Open Anyway**
   - **Option 3**: Run in Terminal:
     ```bash
     xattr -cr /Applications/SyncShow.app
     ```

5. **Optional legacy/emergency fallback**: Install LibreOffice from https://www.libreoffice.org/download/ only if this computer must open older PowerPoint services.

### Windows Installation

1. Download the `.exe` installer from [Releases](https://github.com/edydex/SyncShow/releases)
2. Run the installer and follow the prompts
3. **Optional legacy/emergency fallback**: Ensure Microsoft PowerPoint or [LibreOffice](https://www.libreoffice.org/download/) is installed only if this computer must open older PowerPoint services. Within this optional fallback converter only, SyncShow uses installed PowerPoint before LibreOffice.

### Linux Installation

1. Download the `.AppImage` or `.deb` from [Releases](https://github.com/edydex/SyncShow/releases)
2. For AppImage:
   ```bash
   chmod +x SyncShow-*.AppImage
   ./SyncShow-*.AppImage
   ```
3. For deb: `sudo dpkg -i SyncShow-*.deb`
4. **Optional legacy/emergency fallback**: Install LibreOffice with `sudo apt install libreoffice` only if this computer must open older PowerPoint services.

**Troubleshooting Linux**: If you see a sandbox error, run with:
```bash
./SyncShow-*.AppImage --no-sandbox
```

---

## Development Setup

If you want to run from source or contribute:

### Prerequisites

1. **Node.js** (v22.13 or later; Node 24 is recommended and used in CI) - https://nodejs.org/
2. **Optional legacy/emergency presentation converter** - Microsoft PowerPoint or LibreOffice on Windows; LibreOffice on macOS/Linux

### Setup the Application

```bash
# Clone the repository
git clone https://github.com/edydex/SyncShow.git
cd SyncShow

# Install Node.js dependencies
npm install
```

### Run the Application

```bash
npm start
```

For development with DevTools:
```bash
npm run dev
```

Run the local safety checks before packaging:

```bash
npm run ci
```

### Build and launch the current Mac test bundle

Spotlight opens the copy already installed in `/Applications`, which may be an older preview. On an Apple Silicon Mac, build the current checkout with an ad-hoc local signature and open that exact bundle path:

```bash
npm run ci
npm run build:mac:adhoc -- --arm64
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$PWD/dist/mac-arm64/SyncShow.app/Contents/Info.plist"
open -n "$PWD/dist/mac-arm64/SyncShow.app"
```

Confirm that the printed version matches `package.json` before testing. This launches the local bundle without replacing the installed copy; it does not by itself prove packaged UI, converter, Drive, or multi-monitor behavior.

Ordinary local packages deliberately omit
`assets/google-drive-config.json`, even when a maintainer has an ignored local
copy. The protected release workflow is the only path that may include a
generated configuration, and it verifies the packaged bytes before removing
the temporary file. Do not weaken the file exclusion to make a local OAuth
setup portable.

The non-publishing **Package Smoke** workflow builds ordinary credential-free
QA packages on Windows x64, Linux x64, Apple Silicon, and Intel macOS. Each job
runs the source suite, packaged PDF.js and Sharp runtime probes, blocked legal
evidence verification in evidence-only mode, and an exact target artifact,
native-architecture, and SHA-256 inventory. Its seven-day artifacts are for
review only: the workflow has read-only repository permission, receives no
release secrets, creates no tag or release, and does not weaken the protected
public-release legal gate.

### Latest isolated weekly-service validation

The current renderer-v8 source has completed direct and derived-Singer
real-Electron matrices in Electron 43.2.0 / Chromium 150.0.7871.129. The same
tracked all-native weekly package ran all nine cues through three hidden
production output windows at both `640×360` and `1920×1080`: **108 sender-bound
acknowledgements**, **36 rendered surface captures**, exact Bible title/body fit
checks, one sermon cue rendered as Exact on Front, human-authored Condensed on
Translation, and Hidden on Singer, exact Singer current/next text plus intentional-blank and
end-of-presentation states, one deliberate oversized `640×360` cue rejected by
the production overflow guard, and four route-bound rehearsal receipts
persisted and reopened. This proves the source-runtime display page, preload,
native renderer, direct-role payload route, derived `singer-current-next`
payload route, and acknowledgement barrier at those two resolutions. It does
not prove a packaged `display:start`, fullscreen reveal, physical monitor
routing, or volunteer/venue operation.

Separately, an Apple Silicon package has exercised the supplied July 26 English,
Russian, and Media decks through the legacy/emergency fallback using a linked
local folder and LibreOffice `25.8.4.2`. All
three converted and validated at 112 slides, were pinned as one coherent
offline service, and restored from cache after a complete restart. Prepare
also reviewed the exact three presentations plus the supplied pastor PDF,
resolved Ephesians 3:14–21, and stopped before copying or linking anything; no
sermon packet or Community action was created. The original four input hashes
remained unchanged and the isolated package/profile/copies were removed.

This proves the local-folder, converter, immutable service-set, guarded
sermon-review, and restart path on this Mac. It does not prove physical
multi-monitor Show, PowerPoint conversion on Windows, signed/notarized release
artifacts, LAN Remote, Community authorization/publication, another platform,
or a venue rehearsal. See
[`docs/HANDOFF-2026-07-27.md`](docs/HANDOFF-2026-07-27.md) for exact evidence
and remaining gates.

## Usage Guide

### Quick Start

1. **Launch the application** - SyncShow opens on **Load**. A published native service is the normal weekly handoff; use **Prepare** when planning or editing it.
2. **For a legacy or emergency PowerPoint service, look at the configured slideshow cards**. The default profile shows Russian, English, and Singers Screen; an administrator can rename, add, remove, or reorder these roles. Volunteers can use this fallback without entering the editor.
3. **If an administrator connected an automatic loading source**, SyncShow checks it at startup and fills the cards from matching files for the church’s service date. Admin Settings offers private Google Drive sign-in, a public view-only Drive folder link, or an ordinary local/synced folder.
4. **Choose a slideshow on any empty card**. One-deck services are supported, and every automatically loaded file can still be replaced manually.
5. **Use Admin Settings only for setup work**. Folder paths, date matching, screen detection, input/output names, physical-screen routing, timing, previews, and Singer behavior live in the modal Admin Settings surface instead of the volunteer Load screen.
6. **Click Start Show**. A compact message appears only when loading or venue setup needs attention. If an enabled output has no matching file, Start offers to upload it, mirror another loaded slideshow, create the Singer next-text view, or turn that output off for this service. If a previous cache exists, **Use last service** can restore any valid subset of inputs.
7. **Optional: open Remote Control on Show**. Choose the private Wi-Fi or wired network used by the phone, turn Remote on, and scan the one-time QR code. Remote is off by default and is revoked on Stop, Back to Load, Show replacement, sleep, or app exit.

### Native Prepare

Prepare stores editable semantic service projects separately from live output. Create or open a service, then add and nest service sections, sermons, points, and subpoints. Add songs, Bible passages, per-output sermon/notice titles and bodies, intentional blank cues, or PNG/JPEG/WebP pictures chosen independently for each output; reorder directly by dragging or with the move controls, indent, outdent, collapse, edit, or duplicate the selected item or complete nested section. Titled groups remain visible as clear rundown dividers without becoming projected cues. New Bible passages explicitly choose BSB, LSV, or Hidden for every configured output; Main resolves each visible translation against one canonical range and never accepts renderer-owned verse text. In sermon and notice bodies, select exact words and choose **Gold emphasis** to reproduce the restrained inline highlighting used by the sample service; changing the body safely clears ranges that could otherwise move onto the wrong words. Built-in presets cover common song, Scripture, sermon, notice, picture, and black-screen treatments.

For the ordinary weekly sermon, choose **Sermon** in the Add grid, then **Create packet**. Confirm the sermon details and primary passage; optionally insert the native BSB reading immediately before the sermon. SyncShow then opens **Add the pastor’s reviewed material**. Paste the complete manuscript, the slide notes, or both, confirm the exact wording and language, and save. The text is canonicalized into private content-addressed source evidence, the exact sermon and service pin advance together, and **Build slides from sermon text** becomes available. Re-pasting changed text replaces only the earlier SyncShow-pasted entry for that role and language; an identical re-paste is a no-op, and separately attached original files remain untouched.

**New service** now begins the planning workflow instead of creating an untracked content container. It asks for the service name, date, local start time, and optional team notes, then saves revision 1 with an explicit local-created planning identity and immediately shows the weekly readiness checks. It does not invent a template, Community source, or PowerPoint relationship. Existing unplanned projects remain readable, Community imports retain their separate exact remote provenance, and PowerPoint companions remain outside native planning. The first service can later be used by **Plan next service…**, at which point the child records the exact saved parent revision as normal.

For a saved native service, **Plan next service…** creates a new planning project from that exact current revision. It carries the reusable order, sections, songs, notices, pictures, and imported decks, and it copies every retained asset into the new project's own content-addressed storage. It deliberately removes the prior sermon occurrence, generated sermon reading, private sermon packet/resources, post-service links, source-service binding, and files no longer reachable from the retained service. Planning metadata records the exact source project and revision. The project list groups services as Upcoming, Needs follow-up, or Past, while the planning panel moves deliberately through **Planning**, **Ready**, **Completed**, and **Needs follow-up**. Readiness is re-derived from the exact project: a compilable nonempty service, a song, an exact sermon link, projected sermon material, its linked reading before that material, and visible content on every configured output. A planned service can record a reasoned exception for a failed editorial check, but never for compilation; any content edit clears those revision-specific exceptions, and changing an exception reopens a Ready plan to Planning until the exact candidate is confirmed again. Main enforces the same report when marking Ready and again before publishing. **Ready** remains editorial state—it does not compile a ShowPackage, publish the project, or install anything in Load/Show.

Each native rundown item can now carry an explicit planned duration. Missing means untimed, while a checked `0:00` is an intentional instantaneous moment. A timed section owns one outer service slot and may use its children as an internal breakdown without double-counting them; an untimed section derives a slot only when every child is timed. Prepare calculates venue-local wall-clock starts and an expected finish without inventing a timezone, calls out partial schedules and section overruns, and persists only the entered durations—not derived clocks. **Manage serving team…** records bounded local responsibilities, people, service/item scope, status, required/optional state, call time, and notes. It never stores email, phone, Community account, or directory data. Item removal prunes stale responsibilities, in-place song replacement rebinds them, and **Plan next service…** deliberately clears last week’s people while retaining reusable durations.

After **Save & go to Load** publishes that exact reviewed revision, Load shows a local **Reviewed service** brief with the service date, start time, volunteer notes, cue count, and any reasoned readiness exceptions. Show keeps the same immutable handoff beside the transport controls: the operator sees the current cue’s semantic title and group, its private operator note, and the next cue while audience outputs and Remote continue receiving only their existing presentation state. **Back to Load** ends every output first, then offers to mark that exact project revision **Completed** or **Needs follow-up**, or to open its exact linked sermon packet. These post-service choices are revision compare-and-swap operations; if the plan changed while the service was running, SyncShow stops instead of updating or opening a different revision. This handoff is local and never publishes anything to Community.

That reviewed native service is also the explicit current service across restarts. After publication, SyncShow atomically activates a path-free pointer containing the package ID and raw manifest SHA-256, exact project identity/revision and service date, a digest of the prepared-service deck-role contract (profile ID plus enabled deck-role IDs, order, and labels), and a unique activation ID. Receipt-backed rollback restores the previous pointer only while that exact activation remains current, so it cannot clear a newer selection. At startup—and again immediately before Start—SyncShow reopens the package, verifies the current bundled font, complete artifact inventory/checksums, timeline, scenes, semantic operator metadata, and handoff, and requires exact deck-role and presentation sets. Contract drift or verification failure withholds or removes native presentations while preserving package evidence; unrelated output routing does not invalidate this render contract. Intentionally re-preparing can quarantine a safe corrupt same-identity package before regeneration. Loading or restoring PowerPoint clears both the current native pointer and installed native presentations, not immutable package evidence. Load confirms a restored prepared-service date mismatch before output windows open.

When Load has a verified PowerPoint `ServiceSet`, Prepare shows a **Current PowerPoint service** card. Main returns an expiring opaque inspection token with that path-free card; **Start sermon handoff** fails closed if the loaded set changes before the click. A successful click atomically creates one `pptx-companion` record bound to that exact set, with exactly one top-level nonprojected Sermon anchor. A new unlinked record immediately opens the weekly file review. Reopening an already-linked record instead selects its exact pinned sermon, refreshes Community status, and focuses the post-service handoff; both the page and main process refuse to start a second packet for that companion. The card finds only the exact binding and never adopts a project merely because the date matches. A companion stores that anchor and sermon resources only: native text, song, Bible, picture, and deck cues are unavailable, generated Bible readings and unrelated library-sermon linking are blocked, and the record cannot be compiled, published to Load, exported, or imported as a portable native service. The original PowerPoints remain the only Show source.

The same card can explicitly **Create native draft…** or reopen the one reserved native-draft identity for that exact ServiceSet. Before offering confirmation, main requires one loaded presentation for every enabled deck channel, identical synchronized position counts, the exact current venue role order and labels, matching ServiceSet restore provenance, a complete validated conversion generation, and safe JPEG type, size, dimensions, and content hashes. Confirmation rechecks those inputs, copies each distinct rendered image into content-addressed project storage, and creates one ordinary output-specific picture cue per position. The original presentations and current Load/Show selection are not changed; the operator must review the separate project and later choose **Save & go to Load**. This is a visually source-faithful starting point, not semantic PowerPoint conversion: text, notes, transitions, animations, and song/sermon structure remain flat pixels until a person deliberately replaces reviewed ranges with native content.

The same card can **Review songs from this service…** as one local family: an original and, when present, one translation captured from the same or a different presentation in the exact pinned `ServiceSet`. Main uses no-follow reads and rechecks the set binding, role, size, and SHA-256 for inspection, review preparation, and commit. Parsing runs outside Electron main in a resource-limited worker with a deadline. Before the ZIP library can construct an object for every package part, SyncShow preflights the ordinary ZIP central directory, rejects unsupported multi-disk/ZIP64 packages, and enforces entry and directory bounds; slide XML is then streamed through per-part and cumulative decompression limits. Inspection returns the complete bounded canonical `all`, direct-white, and direct-yellow text for every slide—there is no hidden preview tail—plus optional exact ranges derived from this template's title-placeholder and lyric-textbox runs. Those ranges are local structural suggestions, not general song recognition: the operator must review each member's lyric boundaries and separately displayed, unclassified title-card text, and can enter a different consecutive 1–200-slide range.

For each captured member, the operator chooses a default text lane and can override it independently on every selected slide before confirming the stable Song Library ID, title, and language. Changing the default preserves explicit per-slide exceptions. `all`, `white`, and `yellow` describe source text/color evidence, not languages; a bilingual song can switch which language is white or yellow during the same run. The second step shows every complete deterministic captured line, retained title-card evidence, and the exact prospective local identity effect: create, replace the current revision, or retain an uncaptured existing translation unchanged. Every occurrence must be classified as new, a repeat of an earlier occurrence, or excluded. SyncShow still does not infer Verse/Chorus/Bridge meaning, correct wording, or invent credits.

Before saving, the operator records descriptive Song Library license wording and credits plus a separate bounded local-service rights basis and exact evidence for each captured language. A CCLI or SongSelect number alone is not treated as permission. Three explicit confirmations bind the compared source, reviewed rights, and local-only save; changing a decision or metadata invalidates them. The complete merged family is then committed through one recovery-journal-backed local transaction, with immutable schema-v3 review evidence and receipt, retained translations preserved, and receipt capacity reserved before any library pointer can change. Exact retries and restart recovery cannot create a second receipt for the same reviewed snapshot; legacy v1/v2 evidence remains readable without being silently rewritten. PowerPoint and the ServiceProject remain unchanged. This grants no Community-member or public-link authority and performs no network action; those remain separate reviews of the exact saved family.

The local sermon packet is separate from projected cue text. The normal native path is the paste-first workflow above. **Review current service files…** is an optional source-preservation and legacy-service path: Electron's main process—not the page—enumerates the exact verified PPTX `ServiceSet`, opens the one-manuscript picker, and returns a path-free 15-minute review showing each original filename, language, size, checksum, and whether its exact bytes will be added or reused. The set must match the project's service date and venue profile. Confirmation rechecks the project revision, exact linked sermon revision, set ID/fingerprint, manuscript bytes, and every add/reuse decision. An already-linked native sermon—including one imported from a schema-v2 Community plan—is revised in place: SyncShow does not create a second sermon or reading, compatible same-checksum sources are reused, new sources are copied once, and the exact sermon owner plus compatible generated-reading provenance move together to the new immutable revision. The first successful review durably binds that project to the exact `sourceServiceSet`, so another same-date set cannot silently replace it. SyncShow copies added presentations and the manuscript into its private content-addressed source store and saves the immutable sermon, exact service pin, and set binding through one recovery-journal-backed sermon/project commit. It never moves the originals, edits presentation slides, wording, or layout, builds projected cues, or contacts Community.

The weekly review assumes the full deck already contains the congregational reading, so it creates no duplicate Bible cues by default. A PowerPoint companion always preserves that choice. In a native project, select **Insert a native Bible reading** only when SyncShow should add the confirmed passage in BSB immediately before the sermon. The legacy source-less **Create & link** path remains available only for native projects when there is no reviewed current set. SyncShow can also create and search canonical `SermonDocument` records, preserve immutable PDF/DOCX/PPTX/TXT/Markdown sources, review bounded extraction suggestions, and link one exact sermon revision and outline section into a service. Sermon schemas v1, v2, and v3 remain readable and hashable as their own canonical bytes; an edit upgrades an older document explicitly instead of silently changing its historical revision. V3 adds ordered reviewed body entries with language, source, optional outline-section provenance, and complete text.

The normalized full extraction is saved as private, content-addressed, path-free evidence bound to the exact base sermon revision, source identity and hash, source kind, and extractor identity and version. Suggestions begin unchecked—including after an exact saved review is reopened following a restart—and only an operator's selected IDs are applied; source bytes remain private to that computer. A private review receipt is written only after the sermon and project commit succeeds and records the exact resulting sermon and project revisions. If that later receipt write fails, the canonical edit remains successful and SyncShow shows a warning; a restart during that gap honestly treats the extraction as unreviewed. Attaching a source or applying reviewed extraction advances every direct owner and generated reading together only when the same confirmed-primary reference ID and canonical range remain valid; incompatible passage or linked-section changes reject the whole project mutation. Portable services can hydrate a missing exact sermon without overwriting a different local revision.

For an empty or populated native sermon outline, select the exact Sermon, Section, Point, or Subpoint group and choose **Build slides from sermon text** to turn reviewed canonical body entries—including pasted manuscript or slide-note text—into native cues among that group's direct children. Preserved PowerPoint slide-note windows remain one legacy source option, not a requirement. The selected group must directly own or inherit one exact revision from a semantic whole-sermon owner; nested and sibling groups stay opaque and are never flattened. Every output/source mapping starts blank and must be chosen explicitly; filenames and language tags are hints only. Each changed row then chooses **Exact**, human-authored **Condensed service text**, or **Hidden** independently for every mapped output. Condensed text is never generated: the operator selects its exact canonical source paragraph, may copy that paragraph only through the visible **Start from exact paragraph** action, edits the projected words, and confirms them while the canonical sermon remains unchanged. Exact-only rows keep the historical byte-identical receipt format; a row with condensed text records both the canonical source hash and projected-text hash, and compilation marks that output as condensed without pretending it came from another output channel. Proposed relative-position rows start at Skip, expose unmatched outputs, and require an Insert, explicit eligible direct-cue Update, or Skip decision plus final confirmation for every row. **Use all suggested rows** is limited to an empty selected whole-sermon owner group, so a complete source window cannot be dumped into one nested point. Changed rows form one reviewed direct-child block; a populated selected group requires explicit placement, while an empty group has only position zero. Main rechecks proposal-v3 anchor ownership and direct/effective section bindings, project order and target fingerprints, sermon, source, extractor, immutable snapshot, every treatment, and exact source/projected hashes before one compare-and-swap save. A blank cue section removes only its direct override and inherits the selected group's effective section. An update preserves the stable cue ID, title, preset, operator notes, creation time, and unmapped output text/titles/spans while replacing reviewed mapped output text, clearing unreviewed stale mapped titles, and applying the reviewed direct section override; an explicitly Hidden mapped output is cleared. Later focused text edits retain provenance only for channels whose bytes are still unchanged. No language inference, automatic translation or summary, manuscript rewrite, Community action, or missing-output copy occurs. This is semantic, source-bound text placement into SyncShow's own editor and renderer. The native contract and current limits are in [`docs/CANONICAL_SERMON_BODY_PROJECTION.md`](docs/CANONICAL_SERMON_BODY_PROJECTION.md); the separate legacy PowerPoint slide-note source path remains documented in [`docs/SERMON_SLIDE_RECONCILIATION.md`](docs/SERMON_SLIDE_RECONCILIATION.md).

**Review sermon text** is a separate human-confirmed operation on an exact linked sermon in either a native service project or the Current PowerPoint service companion. It can seed a draft only from the full ordered units of an untruncated, whole-source manuscript or transcript extraction; it never promotes a shortened preview, a scoped deck window, or truncated text into the canonical sermon. The operator can review and edit the complete entry before saving. Saving creates an exact v3 sermon revision and re-pins the selected project through the sermon/project transaction without changing, generating, or rewording any projected cue. If the sermon was `ready` or `published`, content review deliberately returns it to `draft` and clears `publishedAt` while preserving its audience and canonical URL. The source-faithful PowerPoints remain the only Show content for a companion.

Source review and copying do not extract or rewrite sermon text, mark post-service links Ready, publish a recording, or send anything to Community. Saved extraction evidence likewise does not rewrite projected cues, publish a sermon, or upload anything to Community. A confirmed v3 body is canonical local sermon content, but it reaches Community only when the operator separately chooses **Save sermon to Community**; that exact save includes the body text in the canonical document and still leaves the private manuscript/transcript bytes on this computer. If a copy fails before the transaction, no sermon or project pointer advances; an earlier successfully copied content-addressed object may remain privately unreferenced and enter the continuous orphan ledger. It cannot become eligible until it has remained unreferenced for the full retention window, and only the re-audited restart path can remove it.

For an already linked packet, Prepare offers each confirmed primary passage plus one explicit BSB, LSV, or Hidden choice for every configured output. SyncShow accepts only exact same-chapter verse ranges for this automatic path, requires at least one visible output, resolves every visible translation in trusted Main code, splits the range into consecutive cues of no more than eight verses, and places the cues immediately before the outer sermon group (or the linked resource owner when no sermon group exists). Every generated and compiled cue records the exact sermon resource, reference, complete output plan, chunk index, and chunk count; compiler validation also cross-checks that provenance against the actual translated and hidden cue channels. Prepare reports `unlinked`, `unavailable`, `selection-required`, `unsupported`, `missing`, `ready`, `out-of-position`, or `wrong-passage`; readiness groups chunks by their complete logical output plan, rerunning a ready reading makes no edit, and repair reuses and repositions valid cues or creates only missing chunks. The older single-translation `translationId` form remains readable, serializes and compiles with its original canonical bytes, and retains its earlier sparse-output semantics. Cues from an older sermon revision, another confirmed primary, another translation, or a different output plan are preserved but block automatic replacement until the operator reviews or removes them, so a volunteer cannot unknowingly project two generated readings.

After the service, the same linked packet now has a distinct **Sermon revisit handoff**. It reports the canonical reviewed sermon body separately from optional external links, and an operator can preserve the church sermon page, one audio/video recording, and one external notes/transcript link. The recording picker is owned by Electron main; it accepts structurally valid MP3, M4A, or MP4 files up to 1 GiB, streams them into owner-only content-addressed storage, verifies their SHA-256 identity, and never exposes a local path to the page. The card checks whether that exact object exists on this computer before saying it is preserved. A missing or corrupt copy can be restored from byte-identical media, including a renamed backup, without changing the sermon; an editable Draft/Ready record may instead use a different recording, which clears the old reviewed recording URL and returns Ready to Draft. Published and archived records permit exact device-local restoration only. When the exact object is verified, **Review local recording** re-resolves the current project, inherited sermon revision, and managed recording slot in Main, then opens a separate sandboxed audio/video player. A single expiring capability streams bounded byte ranges from the already-open verified object; no local path, object ID, token, or capability URL crosses the control-page bridge. Replacement, player/control crash, an unresponsive window, suspend, Show start, Stop, expiry, and app quit revoke the reader. Choosing and reviewing a recording never uploads, fetches, transcodes, or publishes it.

On a compatible Community server, the separate **Private Community recording** card can explicitly request the added media scopes, start or resume an exact verified upload in fixed 8 MiB chunks, and explicitly cancel a still-uploading session. Attempt identity, acknowledged upload identity, and authoritative received-chunk state persist across app restarts. A durable completion claim returns `202 finalizing`; SyncShow then polls and safely replays that same claim without reopening or hashing the local file. Cancel is unavailable while the server owns finalization, and a lost response, restart, or local-file loss after that claim does not fabricate failure or start a second upload. Completion means only that Community privately preserved the exact bytes. It never creates a public URL or publishes the sermon.

The current Main, preload, and Prepare renderer have also been exercised in a real source-Electron window with an isolated profile. A tiny disposable MP3 passed through the real picker and owner-only local store; with no Community connection, the card correctly remained **Check pending**, kept upload actions disabled, and left **Review local recording** separate. That walkthrough exposed a null-state song-library renderer defect, which is now fixed with a focused 10/10 regression pass and the complete effective 2,036/2,036 suite. The capture is [`docs/goal-progress-assets/syncshow-managed-recording-real-electron-2026-07-30.jpeg`](docs/goal-progress-assets/syncshow-managed-recording-real-electron-2026-07-30.jpeg), SHA-256 `c5a11d50eb45bda3c73b4c88805ef860da0f57e81e948a73c1008e28ed622252`. It is source-Electron client evidence, not a connected upload, packaged app, audible-playback, server-transfer, or venue claim.

The current managed-recording slice deliberately has no manager byte-review or download surface, no public serving route, no transcoding, and no publication binding. Its server feature flag is off by default, and this server code has not been deployed to the WOTBC test appliance; an isolated appliance rehearsal remains the next gate. The format-2 backup/restore implementation verifies exact completed-object and database inventories, but backups stored on the appliance's same disk are not disaster recovery. A real deployment needs encrypted off-device replication and a deduplicated retention policy. Verified filename, type, hash, and size are canonical sermon metadata and may cross the later explicit Community save; automatic local recording-object cleanup is not implemented yet, so private media remains on this computer. The exact private-transfer and recovery boundary is documented in [`docs/COMMUNITY_SERMON_MEDIA_CONTRACT.md`](docs/COMMUNITY_SERMON_MEDIA_CONTRACT.md).

The current source gates are green: syntax validation covers **173 JavaScript files**; the complete SyncShow suite is effectively **2,036/2,036** (**2,033** in the managed sandbox plus the three real-loopback Remote cases passing separately); the focused managed-recording client slice is **61/61**; the Electron null-state/UI regression is **10/10**; Community is **264/264**; its focused server media checks are **29/29** plus **9/9** static/migration checks; and Community type checking, production build, and deploy/operator checks pass. These are local implementation and contract results, not a packaged-app, public-tunnel, live WOTBC managed-recording, or venue claim.

**Save reviewed links** creates a local Draft revision. A media link counts toward **Mark ready for Community** only when it is stable public HTTPS with no sign-in credentials, query string, fragment, IP/private/reserved host, or nonstandard port; a recording URL must also identify a file rather than a directory. Temporary or signed links may remain in Draft for later review, but they do not count as Ready and cannot enter the public sermon projection. SyncShow does not test reachability. Ready still requires either reviewed canonical sermon text, the page, or available external notes, preserves the existing audience, and does not send anything. Merely preserving a local recording or attaching/extracting a manuscript does not satisfy that review gate. **Save sermon to Community** remains the separate explicit compare-and-swap network action, and a Community manager must still select public body/media and publish separately. Community manager Publish and Withdraw actions do not send a live event back to SyncShow, so the selected sermon exposes **Refresh publication status** as an explicit read-only recheck. A forced refresh invalidates any prior live **Verify publication** result even when the visible publication key is unchanged; it never publishes, withdraws, or changes the local sermon. It also does not import a server-authored canonical revision: after a schema-2 direct-recording publication changes the Community document, the ordinary sermon pull/conflict path must bring that exact revision into the local library before local artifact verification can succeed against it. The coherent metadata repin also updates compatible generated-reading provenance, so the unchanged pre-sermon reading stays Ready and already-published ShowPackages stay immutable.

When that exact local Ready or Published revision is conflict-free and saved byte-for-byte to Community, Prepare shows **Continue in Community**. The renderer sends only the stable sermon ID and expected local revision. Main re-resolves the active non-expired connection and read permission, the saved conflict-free local/remote revision pair, the current local library revision, and its Ready/Published status before deriving `/admin/sermon-publications?sermon=<id>` from the trusted saved Community origin. The handoff opens the manager review page; it performs no Publish, Withdraw, or Community data mutation. Heritage treats a review page with no `sermon` query as the ordinary generic queue. A present empty, duplicate, malformed, stale, Draft, archived, withdrawn, or otherwise unreviewable target produces a visible refusal instead of selecting another record. Exact auto-selection happens only after the authorized reviewable list returns the same stable ID; title and date are never matching fallbacks. This exact-query support and its focused SyncShow **46/46**, Heritage behavioral **14/14**, Heritage static **3/3**, and Heritage type-check gates are local source evidence, not a deployed WOTBC or packaged-app claim.

The authorized WOTBC deployment described below supersedes only the
server-deployment clause in that earlier exact-query checkpoint. A packaged
SyncShow manager-to-public-reader round trip is still not claimed.

The sermon inspector also shows **Used in services** for the selected stable sermon identity. This is a read-only local history derived from checksum-valid current ServiceProject revisions, not a second ServicePlan database: each row retains the exact pinned sermon revision, distinguishes native and PowerPoint service records, and opens the saved service only if its recorded sermon anchor still resolves to that same identity and revision. If the service changed after the list loaded, SyncShow stops before navigating and asks for a refresh instead of guessing. Corrupt project evidence remains untouched, recovered fallback revisions are never presented as current history, private sermon sources and workstation paths never enter the listing, and no Community request is required.

**Admin Settings → Original sermon documents** provides a read-only, path-free storage check for imported manuscripts and slide notes. A source stays protected while any immutable sermon version, any immutable service-project revision, or reviewed extraction evidence still refers to it. Unreferenced objects must remain continuously unreferenced for 90 days before SyncShow offers removal. Confirmation only persists the exact reviewed candidate hash; nothing is deleted from the running app. On the next launch, SyncShow recovers pending sermon/project work, repeats every bounded reference and object-integrity check before opening a window or starting Community sync, and removes only an unchanged confirmed set. Missing references, corrupt evidence, unknown entries, symbolic links, scan limits, or unsafe retention records stop cleanup without deleting anything.

Songs can be imported from strict UTF-8 Markdown/TXT or created directly in the song editor. `^1`, `^chorus`, and other caret headings begin stable song sections; `---` creates an intentional slide break. Words, translators, and composers are kept as separate credits. The Song Library pages large result sets with **Showing X of Y** and **Load more**, and a batch import accepts up to 50 files at once without discarding files that already succeeded when another file fails. Linked originals and translations are shown as one song family, with each language/version still independently editable; catalog reconciliation preserves each translation’s stored original-song ID (`translationOf`) so the family and output chooser do not depend on matching titles. Create a translation from an original, check its section and slide alignment, and save an incomplete translation as a draft until it can be linked to an output. A selected service song exposes its arrangement and an explicit treatment for every output: pin an exact aligned saved version, follow another valid output, derive current-plus-next lyrics from a chosen source, or stay Hidden. Output labels never choose that behavior. Bible references use the bundled BSB by default, offer LSV, and require an explicit choice for ambiguous numbered books such as Peter.

### Heritage Community libraries

An administrator can connect SyncShow to a compatible Heritage Community server from **Admin Settings → Shared Community library**. Enter the server’s HTTPS address and a church-manager email. The manager explicitly approves the named computer while signed in to the exact requested account; the email link is the normal path, and SyncShow also shows a public approval code and server page when email delivery is unavailable. Protocol v2 can advertise any compatible subset of six independent resources: songs, anonymous song links, sermon synchronization, private managed sermon recording, sermon-publication receipts, and service-plan intake; the songs descriptor may additionally advertise the nested schema-1 exact-family `memberSharing` transaction, while protocol-v1 song-only discovery remains supported. Managed recording is omitted unless its separate safe-default-off server feature is deliberately enabled. The approval requests the server’s currently advertised scopes, and the effective permission is always the exact approved grant intersected with the server’s current advertisement. Grants expire after 180 days and can be revoked from either SyncShow or Community admin. Access credentials stay in Electron’s main process and are encrypted with the operating system's protected credential store.

Connection and synchronization never appear on the Friendly Load screen. Admin and Prepare expose only the controls supported by each effective lane: read permits pull/status and conflict review; write permits sharing, save, or keep-this-Mac actions. If a server withdraws a lane or scope, SyncShow disables only that lane without interrupting the other lanes or forcing a disconnect. A newly advertised lane remains unavailable until a manager explicitly approves its new scopes. The local immutable Song Library and local sermon packets remain the working copies and remain usable without the server; a downgrade masks cached protected Community status or conflict data rather than deleting local lyrics, packets, revisions, or service pins. Saving lyrics is always a local-library action; it is not blocked by an offline, read-only, archived, or conflicted Community copy. Background song synchronization may stage a saved family as **Private** for Community admins, but making it visible to signed-in members is a separate action. **Member-visible** is not anonymous internet publication; public song links have their own advertised resource, approval scopes, review records, and server lifecycle.

**Review and share…** enumerates the exact saved original and every linked translation, including language, revision, credits, license, source, and attribution. The operator records the reviewed permission basis and evidence and confirms that it covers every listed version for signed-in Community members. SyncShow keeps that review locally only as a draft and recovery record against a main-process-computed family hash; adding, removing, reparenting, or editing any version makes it stale. Ordinary create/update calls can stage only **Private** content. Member access is granted only by the separately advertised online Community transaction, which binds the exact song version, family hash, review hash, visibility, and schedule to one idempotent request and an immutable server receipt. Community—not the workstation—turns an optional civil review-again date into an end-of-day boundary in the Community’s configured time zone and reports the current effective access. A CCLI or SongSelect number is legacy audit evidence, never blanket redistribution permission or a usable sharing basis. Member sharing is never queued offline: an explicitly rejected or unsupported transaction leaves the staged copy private, while an interrupted response is reported as unknown and reconciled by replaying the same idempotent review after reconnecting. Older servers continue to support private synchronization. The operator can explicitly **Restrict to admins**, including while preserving both sides of a content conflict, with an honest queued warning while offline. Read-only Community approvals can still pull permitted changes but never enter the outbound create/update phase.

#### Current authorized WOTBC test-appliance proof

The member-sharing server contract is deployed on the explicitly authorized WOTBC test appliance, not as a public release. The installed source bundle has SHA-256 `dbd1f02567647b7a2652cbd6b38f165d0945c11f9f67be774118a56875f6a8fc`, contains 186 expected files and no AppleDouble entries, and is recorded on server branch `codex/wotbc-syncshow-dbd1f0256764` at commit `ceba0431a07301d969c12f833eabbe6c5afcb351`. The running candidate uses `heritage-community:syncshow-dbd1f0256764` and `heritage-community:migrations-syncshow-dbd1f0256764`; all 15 migrations are applied, ending at `20260730_120000_song_member_sharing`.

The migration intentionally made all 31 legacy songs Draft/private at sync version 3, preserved 14 licensed and 17 mixed rights classifications, and left zero schedules, active member-sharing pointers, or receipts. The appliance still has 2 users, 1 community, 2 memberships, and no sermons, media rows, or service plans. Public and admin routes are healthy; the anonymous song catalog is empty and `/content/songs/8` returns 404 until a family completes a fresh exact-family review. The existing Cloudflare tunnel remained unchanged at PID 600460 with zero restarts.

The production-data-copy rehearsal proved the real sequence `201 create → 200 replay → 412 stale write → 200 member read → 200 private demotion → 404 hidden`, then removed its disposable credentials. It also caught and fixed the migration's enum/text comparison, bounded invalid-family handling, and hidden receipt-field projection before deployment. The final verifier followed the catalog's advertised content URL because the bounded summary intentionally omits `syncId`. At that member-sharing deployment checkpoint, Heritage passed 220/220 integration/contract tests and SyncShow passed 1,971/1,974 restricted tests with the three denied loopback listeners passing separately 3/3. The newer current totals are the 264/264 Community and effective 2,036/2,036 SyncShow results reported in the managed-recording section above.

Rollback evidence is preserved at `/opt/heritage-community/backups/backup-20260730T194152Z-pre-syncshow-member-sharing` and `/opt/heritage-community/backups/backup-20260730T204759Z-pre-update`, with checksum validation green. This proves the scoped test-appliance migration and server/member contract. It does not prove a merged branch, public installer, packaged SyncShow authorization, physical displays, phone/LAN Remote, volunteer operation, or a venue service.

The saved-song editor now presents **Anyone with the link** as a separate lane. It lists only bounded, duplicate-free server-confirmed records, derives copyable URLs from a same-origin server advertisement, and performs Copy through a short-lived main-process action rather than accepting a renderer URL. Creating another link re-fetches the exact Community family and version, requires a distinct `public-link` review with nonempty evidence for every permission basis, and pins an immutable snapshot; later song edits show that link as an older version rather than silently retargeting it. If the create response is lost after the request begins, SyncShow locks and retries the exact review, body, song version, and idempotency key instead of risking a second link; a list refresh may reconcile server state without abandoning that recovery. Expiry is optional, but a dated permission review requires a link expiry no later than that review boundary. Revoke uses the link's exact server version and is never queued offline: if the server does not confirm the tombstone, SyncShow says the link may still work. Authorization loss clears displayed bearer URLs and short-lived actions. A CCLI/SongSelect number and the existing signed-in-member review are not anonymous-link authority. The client contract and Heritage staging gates are in [`docs/COMMUNITY_SONG_PUBLIC_LINK_CONTRACT.md`](docs/COMMUNITY_SONG_PUBLIC_LINK_CONTRACT.md).

When the local and Community copies both changed, SyncShow preserves both and marks a conflict. **Review conflict** shows the two source families as literal text and requires the operator to choose **Keep this Mac’s copy** or **Keep Community copy** against the current local and server revisions. If keeping a member-visible local family needs a fresh rights review, the operator can record that exact-family review without overwriting either conflict copy, then return to the guarded choice. A private demotion is sent and checkpointed before changed lyrics are uploaded; only after that private checkpoint may the explicit online member-sharing transaction restore reviewed access. If Community rejects that transaction, the new exact content remains private. A missing remote translation is retained locally and remains a visible conflict instead of being silently deleted or re-uploaded. Archiving on Community never deletes a local song. Disconnecting removes the protected local credential but leaves local songs intact.

SyncShow now also contains the bounded Community **sermon client/synchronization foundation**. It validates a separately advertised sermon capability, keeps song and sermon cursors independent, manually pulls exact canonical sermon revisions, and explicitly creates or updates one selected sermon with compare-and-swap protection. V1, v2, and v3 canonical documents cross that explicit save unchanged; a v3 save includes its ordered reviewed body text, but never the private source bytes. If the local and remote sermon both changed—including a body-only change—SyncShow preserves both exact canonical revisions in a guarded conflict state and makes their ordered body entries inspectable before either copy is chosen. Canonical-page and media-link conflicts are shown as non-clickable origin/path summaries with session-local fingerprints: differences remain reviewable without exposing raw query parameters or private attachment metadata.

Ready Community service plans remain Community-read-only intake. A plan can be imported only after every song, sermon, and Scripture pin resolves exactly for the selected venue profile. Schema-v2 plans may explicitly link a Scripture row to one later sermon row and one stable confirmed-primary reference ID. SyncShow revalidates the exact pinned sermon source, role/status, range containment, uppercase translation, one-chapter/eight-verse limit, and unique target; it never infers the link from titles or range overlap. The imported Bible item and later sermon group reuse one exact local sermon resource, and the confirmation list includes item positions so duplicate sermon titles remain distinguishable. In Prepare, the reading row names the linked sermon, translation, and cue position; its selected read-only exact-packet card names the sermon, confirmed primary passage, and selected cue without exposing raw IDs or relationship editing. Ordinary duplication refuses an exact sermon-owner subtree. Readiness requires every distinct exact sermon resource with projected material to have its own earlier linked reading; a multi-cue reading qualifies only as one complete, unique, ordered `0..chunkCount-1` set with the same range, translation, and chunk count. Partial, duplicate, mixed, reversed, or late chunks fail, and multiple material sets sharing one exact sermon resource remain a non-waivable ambiguity. Frozen schema-v1 plans remain readable.

When the only blockers are exact songs or sermons that are locally missing or older than the plan requires, the review offers a separate **Prepare required plan items** button. One confirmation performs only bounded point reads for those pinned records and may update the local libraries; it never title-matches another song, lists feeds, advances feed cursors or whole-lane sync time, writes Community, imports a project, enters Load, or starts Show. SyncShow re-fetches and re-reviews the plan before the reads and again afterward; a newer or inconsistent local/server observation produces an actionable stale-plan blocker that requires a Community manager to refresh the Ready plan, existing local edits become reviewable conflicts, and an offline partial run keeps safe checkpoints for the same explicit retry. The operator can stop a long preparation without discarding those checkpoints. Import stays a distinct unchecked confirmation on the fresh review.

An imported Community plan is never updated automatically. Its Community-origin card exposes **Check Community revision…** for the exact open project, so the operator no longer has to browse the full catalog or match a title. The renderer sends only the project ID and exact local revision; Main derives the stored server and plan identities, requires the matching active connection, fetches only that plan, and rejects any local/project/connection drift before returning the existing review. Same, newer, Draft, Archived, Cancelled, blocked, offline, reconnect, and stale states all leave the offline local service unchanged. A newer Ready candidate compares the stored BASE projection, current Local project, and exact Community revision. Uncontested changes merge; local-only cues, notes, presets, arrangements, Scripture snapshots, and compatible nested structure are retained. Real same-component edits, deletions, moves/orders, kind changes, and song/sermon pin changes with local work appear as ordered **Keep Local** / **Use Community** choices with no default. Stable-ID collisions select one complete Local or Community item/subtree, including exact content, parent, and order; keeping a local group collision records a durable local boundary so a later Community change reopens that whole choice instead of silently mixing the two histories. Cycle-coupled reviews retain explicit collision/restoration disclosure even when several structure choices become one. Apply is unavailable until every choice and the final confirmation are explicit. Main re-fetches and re-reviews the plan, verifies the prior/candidate/merge hashes, then compare-and-swap saves a new immutable revision under the same local project ID. Same-sermon revision changes move compatible owners/readings atomically; different-sermon replacements are scoped and clear stale source receipts when Community is chosen. Older projects without the component-aware baseline use a separately labeled whole-project fallback. Every successful update stores a bounded checksummed decision receipt. Any stale, blocked, non-Ready, incompatible, expired, or replayed action fails without mutation. The prior local revision remains in history, the result reopens as **Planning**, and the current Load/Show package is not changed.

For a Community-imported service that will still use the reviewed PowerPoint files in the room, select its direct whole-sermon row and choose **Use this sermon with the current PowerPoint Show**. The confirmation shows the exact sermon, Community plan revision, venue/profile/date, and every verified presentation role/file. A short-lived main-owned authority then creates or compare-and-swap updates only the deterministic PowerPoint companion, linking the same stable sermon ID and content-addressed revision instead of creating a duplicate. The action is idempotent and fails closed if the plan, sermon, current files, profile, date, target companion, or proposal changes; ambiguity, expiry, replay, and conflicting sermon links also require a fresh review. It does not change the presentations, imported plan, Load/Show state, Community data, or publication state, and it makes no Community request. No additional PowerPoint processing was added in this checkpoint: this remains a preserved legacy migration and emergency fallback behind the native editor, ServiceProject, renderer, and ShowPackage workflow.

The following paragraph preserves the earlier schema-v2 foundation snapshot.
Its 13-migration, 171-test, and undeployed totals are historical; the current
authorized WOTBC member-sharing deployment and 220-test result are recorded
above.

This is not an end-to-end deployed Heritage result. SyncShow has a strict pure projection that converts one exact eligible public sermon revision into Heritage Content Server v2 catalog, detail, and passage-index records, with canonical checksums and primary-over-mentioned passage handling. A separate conformance verifier and self-contained cross-runtime vector bind the authenticated read-only publication pointer, exact canonical published source, selected body/media IDs, detail bytes, complete catalog snapshot, and complete derived passage-index snapshot; a newer private `currentRevision` may correctly coexist with the older public revision. Separate pure schema-1 transaction gates now cover active republish and genuine first publication without adding a SyncShow Publish operation. The first-publication gate requires true null/null pre-state, exact Ready-to-Published bytes, publication version 1, and the Heritage server's locked pre/post catalog-authority generations; it rejects a pre-existing target, unrelated-row loss, checksum/index drift, or anything other than one exact generation advance. Its safe fixed vector matches the current Heritage schema-1 manager transition and public projection byte-for-byte. This does not yet cover Heritage's schema-2 direct-recording mutation, authenticate the authority record outside the server transaction, or replace deployed/PostgreSQL atomicity proof. The real Heritage branch `codex/syncshow-community-integration` now contains the matching scoped SyncShow device flow, song/public-link/sermon/publication/service-plan resources, immutable private sermon-change sources, anonymous link reader, public sermon routes, and Study Bible **On this passage**/**Appears in** sidebar and strict sermon viewer. It passes 171/171 Community contract tests, TypeScript checking, 144/144 reader assertions, and 80/80 reader protocol checks; a disposable PostgreSQL 17 run applied all 13 migrations and passed the real schema-v2 linked-plan lifecycle. The branch remains uncommitted, unmerged, and undeployed. Local contracts and disposable runtime evidence do not prove packaged desktop authorization, a production-data restore, deployed browser/phone access, or venue operation. ServiceProject publishing, static Content Server subscription in SyncShow, and remote Prepare authoring remain separate follow-up work. See [`docs/HERITAGE_COMMUNITY_SERMON_IMPLEMENTATION_PLAN.md`](docs/HERITAGE_COMMUNITY_SERMON_IMPLEMENTATION_PLAN.md) for the implementation record and remaining proof gates.

Heritage Community approval no longer uses the macOS login Keychain. SyncShow
encrypts its Community token with AES-256-GCM and a random app-local device key;
the vault directory and key are created with owner-only permissions, and the
connection survives an app restart without a computer-password prompt. This is
an intentional convenience tradeoff: another process already running as the
same computer user and able to read SyncShow's application data could obtain
both the encrypted token and its key. Existing Keychain-backed Community
connections require one Community-admin reapproval after this update. Google
Drive remains separate and continues to use the operating system's protected
credential storage.

Separately, the current source completed the successful data path against a
real disposable Heritage Community server backed by Payload and PostgreSQL.
A test-only local manager approval moved the device flow from pending to an
exact three-scope read grant; SyncShow listed and fetched one Ready five-entry
plan, performed exactly one song and one sermon point read, accepted the
checkpointed raw-Community and canonical-local song revisions as distinct
checksum domains, and reached a fresh ready-to-import review. Import created
the exact two section roots with song, Ephesians 3:14–21, and sermon children,
two pinned local resources, and the exact Community planning source. Fresh
store/coordinator instances reopened the same project and revision; review and
repeat import both returned already-imported with one history revision and
zero additional protocol requests. No feed was read, no feed cursor advanced,
no Community content was written, remote row fingerprints stayed unchanged,
and the disposable grant and connection were revoked and removed. This proves
the current source/server protocol and coordinator path, not packaged Keychain
persistence, browser/email approval, a deployed Community, or venue behavior.

Compilation adds one stable intro cue before each song arrangement, then the arranged lyric cues. Preview 16’s source-audited public intro card uses a black background, a bold white primary title, an optional yellow linked-language title, and the exact source credit at lower right. If no exact attribution was supplied, SyncShow creates a localized fallback from the structured words, music, and translation credits. Singer/Media defaults to a simple single-title card without a credit, while an explicit channel choice or qualifying source content can retain the full card.

Select any native projected item to render its exact preset-backed preview for a configured output, including the derived Singer current/next treatment, with Previous/Next controls for multi-cue items. The Singer renderer distinguishes one exact next line, an intentional blank next cue, and the true end of the presentation. Service-item editors keep changes as a visible draft until **Save changes**; Cancel, Escape, or closing SyncShow asks before discarding an edited draft. Prepare autosaves each accepted mutation as a recoverable revision, so Undo/Redo restores saved history instead of editing the already-published Show package. **Export service** writes the selected revision and its pinned image assets to a checksummed `.syncshow-service` file; **Import service** verifies and installs that portable copy without overwriting a different local project. Songs pinned by the imported service are also copied into the editable local Song Library when safe. Identical songs are reused, while a different existing song with the same ID is preserved and reported without blocking the service import.

SyncShow compiles the exact saved revision into deterministic cues and publishes an integrity-checked offline ShowPackage for every mapped venue role. Historically, Preview 16 used cue compiler 3, native scene schema 2, and renderer 6; the current native scene schema is 3 and the renderer is version 8, with resolution-scaled safe text fitting and explicit Singer text/blank/end next-cue state. ShowPackage schema 3 also carries one canonical `handoff.json`, whose checksum is bound into the package identity and whose project, readiness, cue order, semantic titles, groups, and operator notes are cross-checked against the exact manifest and timeline before Load can expose it. A native ServiceProject package keeps constrained scene JSON plus pinned picture assets; Electron’s output windows build a trusted DOM from those validated scene tokens and render the audience view live with HTML/CSS, the bundled font, hidden staging, and fit checks before reveal. For native content, only the operator-navigation thumbnails are rasterized, and focused coverage exercises both those thumbnails and the live DOM interpretation of the same scene. Imported PowerPoint decks deliberately remain pre-rendered slide images so the PowerPoint/LibreOffice result is preserved exactly; the reviewed bridge can now copy those verified images into ordinary native picture cues without treating PPTX as the editable model. Editing a project or library later cannot silently change the package already loaded for Show, and a project changed during a long publish cannot replace the newer revision in Load. Semantic reviewed-range reconciliation, a richer custom preset/style designer, custom portable preset packs, and remote Prepare authoring remain roadmap work. The PowerPoint path remains a supported legacy and emergency fallback.

The default profile keeps the familiar Russian, English, and Singers labels, but those are no longer hard-coded product limits. **Admin Settings** contains the venue’s input/output names, count, order, physical-screen mapping, direct slideshow route, and operator-preview choices. Friendly Mode controls the default volunteer surface; it does not prevent an administrator from reaching the complete settings modal. Start-time mirror/derive/disable choices apply only to that service and never silently rewrite the saved venue profile.

When a build has the required Google configuration, private Drive folders use Google’s system-browser OAuth/Picker flow and store the refresh token with the operating system’s protected credential storage. They load only by default; an administrator may separately allow future explicit Publish actions when Google reports write capability. Public links require no sign-in and are always pull-only, but the build still needs its restricted Drive API key. Background loading never changes or deletes Drive files. Once a ServiceSet is pinned, losing internet or Drive does not affect Show.

The supplied public example folder was successfully listed anonymously during the Preview 11 live check. Private OAuth, secure-storage preflight, and token exchange have focused coverage, but a complete current packaged Picker selection plus refresh-after-restart has not yet passed the release gate. Local or Google Drive Desktop-synced folders remain the no-credential fallback.

### Google Drive build configuration

Direct Drive access needs credentials created for this open-source desktop app:

- `SYNCSHOW_GOOGLE_CLIENT_ID`: a Google **Desktop app** OAuth client ID for private-folder Picker access.
- `SYNCSHOW_GOOGLE_CLIENT_SECRET`: the companion credential from that same Desktop app client, used only when exchanging and refreshing OAuth tokens.
- `SYNCSHOW_GOOGLE_API_KEY`: an API key restricted to the Google Drive API for anonymous public-link access.

Enable both the **Google Drive API** and the **Google Picker API** in the same Google Cloud project. The Picker API is required for the private folder-selection screen; the public API key should still be restricted to the Drive API only.

For a local packaged build, copy `assets/google-drive-config.example.json` to the ignored `assets/google-drive-config.json` and set `clientId`, optional `clientSecret`, and/or `apiKey`. [Google documents the secret as optional for native clients](https://developers.google.com/identity/protocols/oauth2/native-app), so secretless Desktop clients remain supported. The build workflow can inject all three values for a Desktop client that requires the companion credential at the token endpoint, but the workflow’s support does not prove that a particular local or GitHub build was provisioned. The release cleanup command refuses to remove a developer-maintained file.

The GitHub workflow is designed to read those values from secrets in the `release-build` GitHub Environment. Configure that environment to permit deployments only from the protected `main` branch, and keep these values out of repository-level secrets so a workflow on another branch cannot request them. A required reviewer can be added for an additional release gate. Immediately before each platform is packaged, the workflow creates the ignored config with restrictive permissions where the runner supports Unix file modes. The credential environment variables exist only during that preparation step; the generated file then exists only for packaging and a non-secret-printing verification that every packaged app contains it. The workflow removes that generated copy even if packaging or verification fails. Values are never printed or committed, so GitHub's generated source archives remain credential-free. Any installer built with direct Drive enabled necessarily contains its Desktop client ID, any companion credential required by that client, and the restricted API key needed by end users.

The release workflow never runs for pull requests and its build jobs receive a read-only GitHub token. Keep `main` branch protection and required review enabled: packaging code necessarily has access to the generated file while producing an installer. [Google explicitly does not treat an installed-app client secret as confidential](https://developers.google.com/identity/protocols/oauth2#installed); anyone can extract it from a public SyncShow installer, so it must never be treated as proof that a request came from an authentic SyncShow binary. PKCE, state validation, the loopback-only callback, narrow scope, protected refresh-token storage, release controls, monitoring, and rotation are the meaningful safeguards. Restrict the API key to the Google Drive API, apply conservative quotas and monitoring, and rotate credentials if abuse is detected. If a future Google integration requires a genuinely confidential client, it needs a separately reviewed backend token broker rather than an embedded desktop credential.

### Reviewing an existing PowerPoint service

Maintainers can use [`scripts/import-service-decks.js`](scripts/import-service-decks.js) to review explicit RUS, ENG, and Media decks as a proposed native song library and ServiceProject. It is a developer utility, not an in-app import button. Dry-run is the default, manifest files may contain only structure and slide selectors rather than lyrics or sermon bodies, and writes require both `--apply` and a separate output root. Pointing it at SyncShow’s real user-data folder requires an additional explicit approval flag. See [`docs/SERVICE_DECK_IMPORT.md`](docs/SERVICE_DECK_IMPORT.md) for the bounded review workflow.

For the July 19 sample, the three local decks were used as source references to recreate the service as native SyncShow content rather than wrap or replay the PowerPoint files. The full artifact at `dist/2026-07-19-07-19-2026-service-native-import.syncshow-service` has 71 semantic items and resolves to 114 cues for each configured output: 12 titled groups (including one Sermon group with six direct Point groups), 10 native reading/notice items, 31 editable sermon items with source-derived inline emphasis, 6 arranged songs, 9 intentional blanks, and 3 output-specific picture cues backed by seven PNG assets. Its songs pin eight exact reusable catalog resources plus two output-only Singer/Media resources, so importing the full service after the catalog does not create duplicate song identities. It contains no imported-deck or legacy-deck items and no PPTX files.

The reconstruction and catalog-first import were exercised only in isolated review roots. The shared timeline remained equal at 114 cues per output, all 31 sermon items remained editable, the eight reusable song resources were recognized from the catalog, and the two output-only Singer/Media treatments stayed pinned to the service rather than appearing as reusable library entries. No live SyncShow user data was changed. Historically, Preview 16 had only a structurally verified Apple Silicon app and ZIP: its arm64 bundle passed deep/strict ad-hoc signature checks, its extracted ZIP was byte-identical, and its packaged source carried compiler 3 / scene schema 2 / renderer 6. The current schema-v2 package now has a separate isolated native-window linkage inspection, but the full July 19 reconstructed-service packaged import, complete native-window comparison, and physical venue comparison remain required before that reconstruction can be called release-validated.

### All downloaded service songs

The five downloaded services from June 21 through July 19 were also reconciled as one native song catalog: 15 source decks contained 28 song occurrences across 27 content families, including one exact reuse. The resulting portable project contains 273 native cues and 42 editable, language-specific `SongDocument` library entries. Their original-song links are normalized to the preserved catalog IDs, so the Song Library can group related language versions as families instead of presenting every translation as an unrelated song. Five special Singer/Media treatments remain pinned to the services so they render faithfully, but are intentionally excluded from the reusable library. Explicit per-song text repair made 323 reviewed character substitutions: 314 look-alikes in one Ukrainian source, five Latin letters embedded in Russian text, one Cyrillic letter embedded in English text, and three Cyrillic repeat markers converted to the unambiguous multiplication sign. The normalizers do not rewrite ordinary English or Cyrillic. When the source did not establish verse/chorus semantics, sections remain visibly provisional as `P1`, `P2`, and so on, and the report preserves manual review items instead of inventing structure or credits.

For one-step testing, import the ignored build artifact `dist/downloaded-song-library-2026-06-21-through-2026-07-19.syncshow-service`. Optional single-service bundles are `dist/2026-06-21-downloaded-songs.syncshow-service`, `dist/2026-06-28-downloaded-songs.syncshow-service`, `dist/2026-07-05-downloaded-songs.syncshow-service`, `dist/2026-07-12-downloaded-songs.syncshow-service`, and `dist/2026-07-19-downloaded-songs.syncshow-service`. `dist/downloaded-service-song-catalog-report.json` records the source and artifact SHA-256 hashes, counts, review items, and validation evidence.

The combined artifact was imported by itself into a new isolated data root: the first import added all 42 reusable songs, and the second import added none and recognized all 42 as unchanged. Archive inspection found no PPTX, imported-deck/legacy-deck items, or assets. The source decks were read only and no live SyncShow user data was written. This is deterministic local artifact and round-trip evidence, not packaged-app, native-window, cross-platform, or venue validation.

### During Presentation

| Action | Keyboard Shortcut |
|--------|-------------------|
| Next slide | → (Right Arrow) or Space |
| Previous slide | ← (Left Arrow) |
| First slide | Home |
| Last slide | End |
| Clear outputs to black | Escape |
| Jump to slide | Click a thumbnail, or focus it and press Enter/Space |
| Show a spontaneous Bible passage | Click **Bible**, enter a reference, preview it, and press **Send Live** |
| Return from a Bible passage | Reopen **Bible** and press **Return to slides** |
| Control from a phone | Click **Remote Control**, choose the trusted local network, then scan or enter the one-time pair code |

Remote Control is intended for a trusted church LAN only. It does not use a cloud relay, open router ports, or provide file, output-setup, Bible-library, Settings, or quit authority. The local SyncShow window remains authoritative, and losing Wi-Fi does not affect output timing.

Automated tests exercise the authenticated loopback lifecycle, and the current ordinary Apple Silicon QA package passes the same-Mac real-interface gate. Actual phone/browser pairing, guest-Wi-Fi isolation, firewall prompts, and venue behavior remain unverified.

After building a macOS app on a Mac with a real RFC1918 interface, maintainers can run `npm run build:verify-remote-lan -- "/absolute/path/SyncShow.app"`. The fail-closed gate verifies the packaged privacy metadata, executes through that app's Electron runtime, binds the packaged server to the real private interface, serves the packaged phone assets, and exercises pairing, the state stream, Next, Clear, Restore, revoke, and Stop. It is a same-Mac self-smoke, not browser, phone, firewall, guest-Wi-Fi, or venue proof.

Show reports whether outputs are live, cleared, interrupted, or in error instead of leaving an operator to infer the result of an output action. Cue thumbnails are native keyboard-focusable controls with a visible focus indicator and current-cue announcement; Arrow, Home, End, and Escape navigation remains available while a thumbnail is focused.

### Tips for Best Results

1. **For independently routed PowerPoints, keep slide counts aligned**; native ServiceProjects compile every output from one shared cue timeline
2. **Test on venue hardware** before the service
3. **Use 16:9 aspect ratio** for best display quality
4. **Close other applications** to maximize performance

## Project Structure

```
SyncShow/
├── main.js                 # Electron main process
├── preload.js              # Secure IPC bridge
├── package.json            # Node.js configuration
├── src/
│   ├── renderer/
│   │   ├── index.html      # Control panel UI
│   │   ├── styles.css      # Control panel styles
│   │   ├── app.js          # Control panel logic
│   │   ├── prepare-controller.js # Native service Prepare workflow
│   │   ├── display.html    # Presentation display
│   │   ├── display.js      # Display logic
│   │   └── singer.html     # Singer screen
│   ├── remote/             # Responsive phone-only Show controller
│   └── services/
│       ├── bible/          # Heritage-derived parser plus lazy local BSB/LSV data
│       ├── profile/        # Persisted venue profile schema and migration
│       ├── service-set/    # Same-date discovery and integrity-checked offline snapshots
│       ├── project/        # Song/project models, safe stores, native rendering, ShowPackages
│       ├── community/      # Private-first sync, exact-family member review, receipts, and plans
│       ├── remote/         # LAN binding, pairing, auth, state stream, and command protocol
│       ├── show/           # Immutable per-service launch-plan resolver
│       └── converter/      # Legacy/emergency PPTX migration fallback
│           ├── Converter.js
│           ├── PdfToImageConverter.js
│           ├── TextExtractor.js
│           └── strategies/
└── slide-cache/            # Converted images (auto-created)
```

## Troubleshooting

### "No PPTX converter found" error
- On Windows, install Microsoft PowerPoint or LibreOffice
- On macOS and Linux, install LibreOffice
- Restart SyncShow after installing the converter

### PowerPoint is already open on Windows
- SyncShow never closes or changes an open PowerPoint session
- If LibreOffice is installed, SyncShow automatically uses it for that conversion
- If the fallback is unavailable or also fails, close PowerPoint yourself and use **I closed PowerPoint — retry** on that slideshow card; the exact approved file is retried

### Slides look different from PowerPoint
- This is due to font substitution. Install the same fonts used in your PPTX files on the presentation computer.

### Lag between displays
- Ensure both displays are connected directly (not through adapters if possible)
- Close resource-intensive applications
- Check that GPU drivers are up to date

### Black screen on display
- Use **Show** in the control panel if the outputs were cleared
- Verify the correct physical display is assigned before starting
- Use **Back to Setup** and start again if a display was disconnected or rearranged

## Building for Distribution

To create a standalone installer:

```powershell
npm run build
```

This creates an installer in the `dist/` folder.

Creating an installer is not the same as release validation.

Every release packaging job runs `npm run build:verify-pdf-engine` against the
fresh `app.asar`. That gate rejects MuPDF, verifies the exact PDF.js and native
canvas/sharp target set, verifies the package's target-specific legal-evidence
bundle, and executes text extraction plus page rendering through the packaged
Electron runtime. Each QA package carries the notices and pre-platform-signing
native provenance currently available under `Resources/legal` on macOS or
`resources/legal` on Windows/Linux.

`npm run build:verify-release-legal` is a separate fail-closed public-release
gate. It currently exits with `RELEASE_LEGAL_BLOCKED` for the three native
source/relink gaps described below, before any installer can be uploaded.
This complements rather than replaces signed cross-platform and venue testing.

The schema-1 first-publication transaction gate passes 13/13 focused
fail-closed tests; the combined first-publication, republish, receipt, and wire
matrix passes 42/42, and the broader publication probe/Main/renderer slice
passes 91/91. A separate 30-assert read-only run matched the fixed vector
against Heritage's current schema-1 builders byte-for-byte.

The current unreleased worktree passes syntax checks for all 173 JavaScript files. Its complete effective result is 2,036/2,036 Node tests: 2,033 pass in the managed sandbox, where the only denied cases are the three real Remote listeners, and those same three pass 3/3 with normal loopback permission. The project-bound Community revision slice passes 17/17 focused Main/preload/Prepare checks, and the broader service-plan, reconciliation, planning, and renderer set passes 294/294. The native timing, serving, handoff, Load/Show, and Remote-privacy slice passes 110/110 focused tests. The recording intake, health, and playback slice passes 52/52 focused tests; the managed-recording transfer slice passes 61/61; the real-Electron null-state/UI regression passes 10/10; the final dense generated-sermon-reading, packet, compatibility, and lifecycle slice passes 74/74; and the current Exact/Condensed/Hidden canonical-body, trusted-IPC, Prepare UI, lifecycle, and Electron-contract slice passes 25/25. Renderer-v8 coverage now also includes the direct and derived-Singer real-Electron `640×360` plus `1920×1080` matrices: 108 sender-bound acknowledgements, 36 captures, exact bundled BSB on Front, exact bundled LSV on Translation, a genuinely hidden Singer reading, exact canonical sermon text on Front, human-authored condensed sermon text on Translation, a hidden Singer sermon output, exact Singer current/next/blank/end states, a deliberate minimum-resolution overflow rejection, and four persisted/reopened route-bound receipts. The separate private-recording walkthrough used the real picker and local store in an isolated source-Electron profile, kept disconnected upload actions disabled, and captured the repaired card without making a Community write. Current coverage includes exact service/project/package durability; paste-first reviewed sermon material with canonical UTF-8 bounds, private content-addressed storage, exact no-op/replacement behavior, confirmation invalidation, source-file preservation, and journaled sermon/project repinning; strict source/projected sermon-body evidence with deterministic paragraph identity and boundary validation; the preserved review-first legacy PowerPoint-to-native picture-cue fallback with deterministic identity, exact ServiceSet/venue binding, no-follow conversion-cache validation, atomic asset installation, competing-review refusal, and idempotent retry; source-faithful PowerPoint fallback and native workflows; structured PowerPoint-busy close-and-retry recovery; reviewed song-family capture; local rights evidence; atomic commit/receipt/recovery; canonical v1/v2/v3 sermon bodies; reference-aware restart-only private source retention; Community pull/push/conflict and rights boundaries; identity-only point-read service-plan preparation with stale-plan/conflict/subset-retry/cancellation guards; distinct exact remote-source and canonical-local song revision domains; schema-v2 exact Scripture-to-sermon linkage with descriptor negotiation; confirmed-primary containment; duplicate-title review identity; per-sermon and complete ordered multi-cue reading readiness; duplicate-owner refusal; linked-sermon current-service add/reuse review and atomic reading repin; local Ready ShowPackage composition; bounded fail-closed macOS credential-storage handling; output-first post-show handoff for native and legacy PowerPoint services; strict public sermon detail/catalog/passage projection; exact publication-state/source/artifact conformance; deployed read-only verification with an exact post-artifact receipt recheck; proposal-v3 nested sermon-slide reconciliation with direct-child isolation, section inheritance and override handling, stale mapped-title clearing; executable UI scope rules; the UTF-8 preload boundary; and target-specific package legal-evidence generation, tamper verification, and release blocking.

The previously rebuilt Apple Silicon Preview 21 (`1.4.0-preview.21`, build `140021`) app, DMG, and ZIP pass arm64 architecture, macOS 12/ATS metadata, deep/strict ad-hoc signature verification, ZIP and DMG integrity, identical built-app/ZIP/DMG `app.asar` hashes, and byte equality for all 262 packaged `main.js`, `preload.js`, and `src/` files; the source-only thumbnail test page is intentionally excluded. It is not notarized. That distributable set remains structural evidence for an earlier source state.

A final July 29 ordinary credential-free Apple Silicon QA rebuild from the
schema-v2 linked-reading worktree passes exact 298-file first-party
source/package identity, deep/strict ad-hoc signatures, arm64 native inventory,
packaged PDF.js and Sharp execution, legal evidence-only verification, ZIP/DMG
integrity, and the same-Mac RFC1918 Remote gate. The built app, extracted ZIP,
and read-only mounted DMG carry identical `app.asar` bytes at
`e92dc3fcdc9a39705aacd508ac243b89ddcf96f5da2db79f972b9d8004a0b64a`.
For rendered QA, a disposable copy changed only its bundle identifier and was
re-signed ad hoc; its app.asar remained the exact hash above. That copy rendered
the schema-v2 Prepare project: the rundown names the linked sermon, BSB
translation, and cue position, while the selected-item card shows the human
sermon title, confirmed primary passage, selected cue, and exact-packet status
without raw IDs or relationship-edit controls. Its two blockers are intentional
because the proof fixture has no projected sermon material. The proof is
preserved under
`/private/tmp/syncshow-arm64-package-proof-v2-ui-final.D5Yusm`. It remains
unnotarized, legally blocked for public release, and does not prove successful
Community authorization, another platform, or phone/browser/firewall/venue
operation.

The later authorized July 30 deployment supersedes that temporary
unreachable-target snapshot. `wotbc.heritage.faith` and its admin, discovery,
manifest, sermon catalog/index, and manager preparation routes now answer
successfully from the deployed 15-migration test-appliance build. The anonymous
song catalog is deliberately empty and legacy song detail remains hidden until
an exact family completes a fresh member-sharing review; this is current
test-server evidence, not public-release or venue proof.

A separate private unpacked Apple Silicon app was built from the then-current worktree before the bounded-async Community credential-store change, with a smoke-only bundle ID and an explicit isolated profile under macOS's real `os.tmpdir()` root. It excluded the ignored maintainer-local Google Drive credential file and matched that source state's main, preload, retention, and Admin renderer bytes exactly. In the packaged UI, the read-only private-source audit completed with path-free aggregates; Prepare created an isolated service, resolved `2thes 2:1-3` to `2 Thessalonians 2:1–3`, added the BSB passage, built a verified one-cue native package, handed it to Load, and restored the exact revision after restart. Start Show stayed blocked because no physical output was mapped. The temporary app/profile were removed afterward. This remains valid offline macOS operator evidence for that earlier source state, not a clean release artifact or evidence for authenticated Heritage manager-to-reader flow, LAN/phone Remote, Windows/Intel Mac/Linux packages, or physical-venue multi-monitor/converter behavior. It does not release or advertise Preview 21.

## License

SyncShow's own source code is offered under the [MIT License](LICENSE.txt).

Packaged builds also contain third-party components under their own licenses.
The current worktree replaces MuPDF with the Apache-2.0 PDF.js engine and the
MIT-licensed `@napi-rs/canvas` wrapper, and fresh-package verification rejects
any residual MuPDF files. That removes the earlier MuPDF/AGPL blocker, but it
does not by itself make a public binary legally ready. Exact notices and
corresponding-source/relink materials remain unresolved for the native canvas
binary, sharp/libvips, and Electron's bundled LGPL FFmpeg. Public binary
release remains blocked until those target-specific materials are complete.
Current QA packages include the exact available notices, a partial audited
component inventory, pre-signing native hashes, SHA-256 coverage, and an
explicit blocked-status manifest; they do not claim to be a complete
corresponding-source or relinking set. The release workflow mechanically
enforces that distinction; see `docs/ROADMAP.md`. This is an engineering
compliance boundary, not legal advice.

Bundled Bible text also keeps its own rights and provenance: BSB is public domain (CC0), while LSV is licensed under CC BY-SA 4.0 and requires attribution. See [`src/services/bible/NOTICE.md`](src/services/bible/NOTICE.md). Those translation terms are separate from SyncShow's MIT-licensed application code.

Native service slides use a bundled Noto Sans variable font under the SIL Open Font License 1.1. The license text is included at [`assets/fonts/OFL-NotoSans.txt`](assets/fonts/OFL-NotoSans.txt).

## Support

For issues or feature requests, please open a GitHub issue.
