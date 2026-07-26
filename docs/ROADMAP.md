# SyncShow product and engineering roadmap

Status: living implementation handoff, updated July 25, 2026 for the local `1.4.0-preview.17` work.

Historical baseline: pulled `origin/main` at `159fbf3` (`v1.3.3`). The current preview work remains uncommitted local development until it is reviewed and published through the normal branch/release process.

This document is intentionally more than a feature list. It defines the workflow, data boundaries, failure behavior, migration path, and release gates needed to turn the current useful live-display tool into a dependable church presentation system without attempting a premature “super app.”

## 1. Product principles

### The workflow is Prepare → Load → Show

1. **Prepare** is where a service is assembled from songs, sermon material, Bible passages, pictures, and imported presentations. It is optional for teams that still prepare everything in PowerPoint.
2. **Load** is the default screen every time SyncShow opens. It finds or accepts the service files, maps them to the saved venue profile, reports anything questionable, and gets the operator to a safe Start button quickly.
3. **Show** is the calm live-operation surface. It advances cues, clears and restores outputs, displays spontaneous Bible passages, and exposes the Singer preview and remote status. It does not double as the settings page.

The stages must remain distinct even when the app eventually shares resources with Heritage Study Bible. A volunteer arriving five minutes before a service should never have to understand the editor, cloud authentication, converter internals, or display wiring.

### Reliability rules

- Live output is the product. A feature that can corrupt the active cache, steal keyboard focus, blank the wrong screen, or silently choose the wrong service file does not ship.
- The simplest valid service must work. One loaded deck and one mapped output is enough to start.
- Missing optional material is a recoverable choice, not a dead end. In particular, a missing Media/Singer deck gets an explicit preflight with useful fallbacks.
- Defaults live in a named venue **Profile**. Friendly Mode applies those defaults; it does not duplicate a second set of hidden behavior.
- Inputs describe content roles. Outputs describe physical destinations. Neither is permanently named “Russian” or “English.”
- Warnings say what is wrong, what SyncShow will do, and how to fix or consciously override it.
- Offline operation remains first-class. Once a service is loaded, loss of internet or Google Drive must not interrupt Show.
- Native Microsoft PowerPoint conversion on Windows is a valuable fidelity path and should remain preferred when available. LibreOffice remains the cross-platform converter and Windows fallback.
- New projects use a platform-neutral cue model and deterministic renderer. PPTX import remains supported, but PowerPoint, Keynote, Google Slides, and LibreOffice do not become SyncShow’s internal document model.
- Integrate through small shared protocols and packages before considering a combined application shell.

## 2. Target operator experience

### Prepare

Prepare creates a versioned **ServiceProject**. The operator can:

- add a song from a local or subscribed library;
- create or edit a Markdown/TXT song and its translations;
- add Bible passages, sermon headings, nested points, blank cues, and pictures;
- apply a small number of church-defined visual presets;
- preview each configured output variant;
- import one or more PPTX decks as legacy content; and
- publish or save the project for Load without needing cloud access.

Prepare is not required to run a service. Existing churches can continue selecting PPTX files while the native workflow matures.

### Load — the startup default

Load opens first and keeps the normal volunteer surface deliberately small:

- one card for each configured input role;
- automatic population from the administrator’s configured local/synced folder, private Drive connection, or public view-only Drive link;
- a manual **Choose slideshow** fallback on each card;
- clear ready, attention, error, and in-progress states;
- one compact, actionable exception when administrator setup needs attention; and
- one primary **Start Show** button.

Service dates, folder linking and refresh, screen identification, output health, role/output naming and routing, timing, previews, and Singer behavior belong behind **Admin Settings**. Friendly Mode must not expose that venue wiring on the normal Load page.

### Show

Show should contain:

- the cue/slide list and current position;
- large Previous, Next, Show/Restore, Clear, and Stop controls;
- the Singer/Media output preview by default when that screen cannot be seen from the booth;
- a compact **Bible** button on the right pane;
- remote connection status and an immediate revoke/disable action; and
- optional output previews selected in Settings.

The default Show screen should not spend space on Russian and English previews that the operator can already see in the room. It should not expose output assignment, conversion, font, timing, or cloud settings while live.

Preview 14 now exposes authoritative live, cleared, interrupted, and error state beside the Show controls and surfaces failed Restore/Clear/Stop/Back/jump actions instead of failing silently. Cue thumbnails are native keyboard controls with useful labels, `aria-current`, and visible focus; focused thumbnails retain Arrow/Home/End/Escape transport while Enter/Space activates the selected cue.

## 3. Audited `v1.3.3` baseline and blockers

SyncShow already proves the core idea: Electron can pre-render PPTX files and keep multiple fullscreen windows synchronized. The pulled `v1.3.3` branch also contains the Windows-native `PowerPointStrategy`, falling back to LibreOffice. That work should be preserved.

At the untouched `v1.3.3` baseline, the code is organized around exactly three concepts—Russian presentation, English presentation, and Singer window—in `main.js`, `src/renderer/app.js`, and `src/renderer/index.html`. Settings, loading, and live controls share one renderer, and that baseline has no test or lint command in `package.json`. This makes every new workflow request riskier than it should be.

### Phase 0 correctness blockers

These findings must be fixed or explicitly verified as fixed on the foundation branch before feature expansion:

1. **Conversion publication must be transactional.** The audited converter could remove the active role cache before a replacement conversion succeeded. `src/services/converter/Converter.js` must render into an isolated generation, validate contiguous full-size images, thumbnails, metadata, and slide count, then atomically swap it into place. A failed or cancelled conversion must leave the last good generation usable.
2. **LibreOffice isolation must not kill unrelated work.** `src/services/converter/strategies/LibreOfficeStrategy.js` used `pkill -f soffice.bin` on Linux. SyncShow should use an isolated LibreOffice user profile and terminate only a child process it owns. It must never close a volunteer’s unrelated LibreOffice session.
3. **Output-window lifecycle must be session-scoped.** Creation callbacks, delayed initial-slide sends, previews, Stop, and restart can race in `main.js`. Every output session needs an ID; late callbacks from an old session must be ignored and old timers/listeners destroyed.
4. **Output windows must not steal focus.** They should be `focusable: false`, `skipTaskbar: true`, pointer-ignoring, shown inactive, and kept above normal windows without pulling keyboard input away from the controller. Global OS-wide navigation shortcuts should remain disabled.
5. **Slide reveal must reject stale async work.** Image preload and fade callbacks in `src/renderer/display.js` need a monotonically increasing navigation token so a slow previous image cannot appear after a newer cue.
6. **IPC and cache paths need strict validation.** Renderer-provided role IDs, paths, display IDs, settings, and numeric values must be schema-checked in the main process. Role/cache IDs must be allow-listed or resolved beneath the cache root; arbitrary strings must not become path components.
7. **The DOM contract needs cleanup.** `src/renderer/index.html` currently repeats `id="btnRefreshDisplays"`, while `app.js` binds only one element. The Escape hint says “Clear to Black,” but current keyboard handling and window behavior have drifted. IDs, labels, and behavior need one tested source of truth.
8. **Packaging must use an allow-list.** The broad `"**/*"` pattern in `package.json` can accidentally include development/runtime artifacts such as `python-embed/`, `slide-cache/`, local caches, or sample files. Inspect the built archive, not only the source tree.
9. **Conversion warnings need classification.** The live sample conversion targeted `2940×1912` and emitted repeated MuPDF structure warnings. Determine whether they are harmless source-PDF diagnostics, a fidelity defect, or a sign that warnings are being swallowed. Routine harmless messages can be summarized; structural/render failures must fail the generation.
10. **Documentation must match behavior.** `README.md`, `ARCHITECTURE.md`, and `CLAUDE.md` still describe LibreOffice as universally required and contain performance claims that are not backed by an automated benchmark. Document PowerPoint-first Windows behavior and measured results.
11. **The Electron runtime needs a planned major upgrade.** The current Electron 28 line has unresolved high-severity advisories. A supported upgrade must be regression-tested across output windows, conversion, packaging, and venue hardware; Electron 38 and later require macOS 12, so this also needs an explicit decision to retire the README’s current macOS 11 claim. Track Electron’s [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes) rather than applying a blind forced audit fix.
12. **Binary distribution needs a MuPDF licensing decision.** SyncShow directly imports and packages MuPDF. Artifex describes MuPDF as available under the GNU AGPL or a commercial license. Before another binary release, document an AGPL-compliant distribution/source-notice process, obtain a commercial license, or replace MuPDF with a dependency whose terms match the intended release model. Do not treat `package.json`'s MIT field as relicensing third-party code. See the vendor's [MuPDF release/licensing notice](https://mupdf.com/releases) and [Artifex licensing guide](https://artifex.com/licensing); this is a release/compliance review, not legal advice.

Foundation branch status through July 23, 2026:

- Implemented locally: validated transactional publication/rollback, isolated LibreOffice jobs, PowerPoint busy-process safety with LibreOffice fallback, session-scoped output windows, non-focusable outputs, stale-navigation cancellation, allow-listed legacy roles plus path/display/numeric validation, atomic settings writes, the duplicate-ID/Escape cleanup, package allow-listing, cross-platform CI, documentation corrections, converter regression tests, a supported Electron 43 runtime, and an explicit macOS 12 minimum.
- Still required before calling Phase 0 complete: a close-and-retry PowerPoint-busy action; broader automated main-process/renderer state tests; MuPDF warning classification and the MuPDF distribution-license decision; structured diagnostics; stable Developer ID signing/notarization; and packaged multi-monitor/converter smoke tests on Windows, macOS Intel/Apple Silicon, and Linux.

Preview updates through July 23, 2026:

- Implemented locally in `1.4.0-preview.2`: the Load-first shell, Friendly Mode with a one-time advanced-controls warning, visible Start-readiness reasons, any-valid-subset cache restore, settings-only screen/timing/Singer typography, Singer-only preview by default, and the simplified Show control pane.
- Implemented locally in `1.4.0-preview.2`: a dedicated Media/Singers input with filename-date warnings; one-deck launch; per-service upload, mirror, derive-next-text, and disable choices; immutable launch-plan validation; generic output-window execution; and full-width one-source Show thumbnails.
- Validated locally: 37 automated tests, an actual one-deck Russian-to-Singer derived-output launch through Electron, packaged-app UI smoke testing, code-signature verification, and DMG/ZIP integrity checks on Apple Silicon macOS.
- Implemented locally in `1.4.0-preview.3`: persisted/migrated venue profiles; custom input/output names, count, ordering, routes, and preview selection; conservative monitor fingerprints; Identify Screens; serialized preference saves; control-display protection; and dynamic Load/Show surfaces.
- Implemented locally in `1.4.0-preview.3`: lazy packaged BSB/LSV text, Heritage-compatible shorthand and numbered-book ambiguity, real verse validation, a keyboard-friendly Bible palette, per-output Send Live, synchronized overlay preparation/reveal, navigation lock, Emergency Clear, and exact Return to the prior slide-or-black state.
- Validated locally for `1.4.0-preview.3`: 73 automated tests, including behavioral double-buffer/fit/stale-hide coverage; interactive Load/preflight/Settings/Show/Bible keyboard and visual checks; source and packaged Electron startup; Apple Silicon executable/native-addon architecture; ad-hoc code-signature verification; packaged BSB/LSV indexes; ZIP integrity; and mounted DMG integrity. Real unlocked native-window, converter, and multi-monitor venue testing remains a release gate.
- Implemented locally in `1.4.0-preview.4`: coherent date-grouped local/Google Drive Desktop folder discovery; profile-timezone service dates; configurable MDY/DMY parsing, role matchers, required/optional inputs, and reusable date-neutral inputs; opaque scan proposals; integrity-checked offline ServiceSet snapshots; reconciled watcher hints; changed-since-load warnings; and a permanent manual-file fallback.
- Validated locally for `1.4.0-preview.4`: 101 automated tests; an isolated packaged-runtime scan of complete July 22 and older July 19 fixtures; source-path confinement, replacement-race, restart-safe cache-cohort, pinned-asset corruption, and snapshot-retention tests; Apple Silicon executable/native-addon architecture; ad-hoc signature verification; packaged ServiceSet and Bible assets; ZIP integrity; and mounted DMG integrity. The Mac was locked during the final native-window capture, so the new folder card still needs an unlocked visual pass in addition to venue testing.
- Implemented locally in `1.4.0-preview.5`: an authoritative revisioned Show gateway; sender/session/cue-scoped output health; explicit Back-to-Load session teardown; and off-by-default Show-only LAN Remote Control with opaque private-interface selection, one-time QR/code pairing, revocable devices, current/next thumbnails, Previous/Next/jump/Restore/Clear, SSE plus polling fallback, stale/replay protection, and immediate revocation on Stop, replacement, interruption, sleep, or exit.
- Validated locally for `1.4.0-preview.5`: 140 automated tests, including a real loopback HTTP lifecycle for Host/Origin validation, cookie pairing, command sequencing/replay, authenticated thumbnails, lazy paginated jump-catalog loading, compact live-state broadcasts, SSE backpressure, per-device stream caps, revoke, rebind, rate limits, and listener shutdown; offscreen desktop Remote dialog QA at 1400×900; and phone QA at 390×844 with no horizontal overflow. Real venue LAN/phone, Windows firewall, guest-Wi-Fi isolation, multi-monitor, and cross-platform packaging tests remain release gates.
- Implemented locally for `1.4.0-preview.6`: the first working Prepare vertical slice; strict UTF-8 Markdown/TXT SongDocuments with Unicode section identities and `^1`/named-section arrangements; a searchable revisioned local song library; semantic ServiceProjects with a bounded hierarchical rundown, songs, sermon/notice text, blanks, and pictures; compare-and-swap saves and checksum-valid recovery; a deterministic Noto Sans native renderer; and immutable multi-channel ShowPackages that load through the existing hardened Show path.
- Validated locally for `1.4.0-preview.6`: 225 automated tests, including adversarial model/parser cases, storage interruption/recovery and path confinement, real deterministic Sharp/Pango rendering in English and Cyrillic, package reuse/tamper protection, trusted-main-frame IPC contracts, real loopback Remote security, stale-publish/live-Show interlocks, stable 16:9 native output, and project → cue timeline → equal-length output-package smoke testing. The Apple Silicon app starts with isolated user data and its packaged asar, Sharp add-on, and unpacked Noto font pack render an English/Cyrillic slide successfully; the arm64 binaries, macOS 11 metadata, ad-hoc signature, asar contents, ZIP, and DMG all verify. The Mac remained locked during the final native-window click-through, so Prepare → publish → Load still needs an unlocked visual pass in addition to Windows, Intel Mac, Linux, and venue multi-monitor testing.
- Implemented locally for `1.4.0-preview.7`: section creation plus deliberate indent/outdent; stable repeated-section song arrangements; structurally validated per-output song translations; reversible Singer normal/next-line behavior; and BSB-default/LSV Bible-to-service authoring with Heritage-style shorthand, explicit numbered-book ambiguity choices, pinned canonical text, attribution, and checksums. New projects use the venue Profile's stable role IDs instead of guessing Russian/English/Singer positions, and revision-checked mutations plus pre/post-render current-pointer checks prevent stale drafts from replacing Load.
- Validated locally for `1.4.0-preview.7`: 245 automated tests, including a restart-safe project → six-cue timeline → real three-channel native ShowPackage test with 18 rendered slides, 18 progress events, and 40 checksummed artifacts; exact revision conflicts; custom/reordered venue roles; linked-translation compatibility and reset; Bible ambiguity, pinning, and tamper rejection; and trusted narrow IPC contracts. Unlocked Electron/CDP passes exercised section siblings and nesting, song repeat/reorder/link/reset, `pet 1 4` ambiguity, 2 Peter BSB preview/add, publish readiness, and the polished Prepare layout without renderer errors. The ad-hoc Apple Silicon package also passed an isolated packaged-UI Bible/nesting smoke, deterministic packaged Sharp/Noto English-Cyrillic render, arm64 executable/native-library checks, macOS 11 and ATS metadata checks, deep signature verification, asar production-content checks, ZIP integrity, and verified/mounted DMG integrity. Windows, Intel Mac, Linux, and physical venue multi-monitor behavior remain release gates.
- Implemented locally for `1.4.0-preview.8`: direct create/edit/translate song authoring with canonical Markdown/TXT, `^X` sections, explicit slide breaks, attribution/license/source fields, and saveable translation-alignment drafts; direct semantic editing for nested service/sermon headings, per-output sermon and notice text, blank cues, and pictures; reorder, indent/outdent, collapse, and deep duplicate; catalog-backed preset selection; and revision-pinned exact item previews for each configured output.
- Implemented locally for `1.4.0-preview.8`: autosaved immutable project history backing Undo/Redo and explicit revision restore; verified `.syncshow-service` export/import containing the selected project revision and pinned image assets; and preservation of the Load-default **Prepare → Load → Show** workflow.
- Validated locally for `1.4.0-preview.8`: 296 automated tests, including real Remote Control loopback coverage; an unlocked packaged-app authoring pass covering direct song creation, unsaved-change protection, nested service structure, exact slide previews, deep duplicate, Undo/Redo, per-output sermon editing, `pet 1 4` ambiguity with 2 Peter BSB insertion, portable service export/idempotent import, and an eight-cue three-channel Prepare → Load publish without renderer errors. The Apple Silicon DMG/ZIP also passed arm64 executable/native-library checks, macOS 11 and local-network ATS metadata checks, deep ad-hoc signature verification, production asar-content checks, ZIP integrity, and verified/mounted DMG layout and integrity. Windows, Intel Mac, Linux, and physical venue multi-monitor/converter behavior remain release gates.
- Implemented locally for `1.4.0-preview.9`: a card-only Friendly Load surface driven by configured input roles; exact administrator-defined names; safe automatic population after startup, folder linking, date changes, and saved folder/profile changes; compact actionable readiness; and a real modal **Admin Settings** surface containing folder, screen, venue, input/output, preview, timing, and Singer controls. Automatic loads preserve manually chosen and Prepare-published slideshows, and dirty Admin drafts are protected on modal, window, and app close.
- Validated locally for `1.4.0-preview.9`: 301 automated tests; clean source and packaged Friendly Load/Admin Settings visual passes; the one-time advanced-settings warning; a real native macOS unsaved-Admin close prompt; no renderer errors in the packaged smoke; production asar-content checks; Apple Silicon executable, Sharp, and libvips architecture checks; macOS 11 metadata; deep ad-hoc signature verification; ZIP integrity; and verified/mounted DMG layout and integrity.
- Implemented locally for `1.4.0-preview.10`: mutually exclusive private Google Drive, public Drive-link, and local-folder automatic loading sources behind **Admin Settings**; system-browser private OAuth with PKCE/state/loopback validation and the narrow `drive.file` scope; OS-protected refresh-token storage; anonymous public-link access through a Drive-API-restricted key; bounded shared-drive-aware discovery; coherent role/date resolution; race-checked staged downloads and Google Slides export; integrity-checked last-good offline snapshots; disconnect/revoke; public pull-only enforcement; and an explicit private publishing opt-in that never causes background writes.
- Validated locally for `1.4.0-preview.10`: 332 automated tests, including OAuth callback hardening, secret-store behavior, public/private Drive clients, pagination/resource keys/shared-drive flags, coherent remote ServiceSet selection, download races, offline snapshot retention, Profile source exclusivity, and narrow preload exposure; unlocked source and packaged Friendly Load/Admin Settings visual passes; production asar-content checks; Apple Silicon executable, Sharp, and libvips architecture checks; macOS 11 metadata; deep ad-hoc signature verification; ZIP integrity; and verified/mounted DMG layout and integrity. Real Google OAuth/Picker, public-link access, refresh-after-restart, shared-drive, and future-child discovery still require configured Google credentials and live-account validation.
- Validated for `1.4.0-preview.11`: a dedicated production Google Cloud project with the Google Drive and Google Picker APIs enabled, a Drive-API-only public key, Desktop OAuth client, and exact `drive.file` consent scope; a live anonymous scan of the supplied public folder and its nested Russian, English, and Media PPTX files; fail-closed credential injection plus packaged-ASAR verification; missing-key Friendly Mode UX; and 345 passing automated tests. A live private Picker callback reached Google’s token endpoint, which required the Desktop client’s companion credential. Support for that optional native-client field now covers both initial exchange and later refresh while keeping it outside source, logs, renderer IPC, and user storage. Private refresh-after-restart and real shared-drive behavior remain venue validation items until exercised in the packaged app.
- Implemented locally for `1.4.0-preview.13`: Electron `43.2.0` with macOS 12 as the explicit minimum; async-first protected credential storage with a real encrypt/decrypt round-trip preflight before OAuth starts; a secure synchronous fallback for older supported storage providers; and Sharp `0.35.3` plus its current libvips packages. CI/release jobs use Node 24, and `npm audit` reports no known dependency vulnerabilities.
- Validated locally for `1.4.0-preview.13`: 365 automated tests; an unlocked source-app pass proving the protected-storage preflight can open the private OAuth flow; exact secret-safe comparison of the ignored local Google configuration with the packaged ASAR; Electron `43.2.0`, Apple Silicon architecture, macOS 12 metadata, deep ad-hoc signature verification, ZIP integrity, and DMG integrity. The verified app is installed locally with Preview 12 preserved as a backup. The complete packaged Google Picker selection and refresh-after-restart test still remain before private Drive is considered venue-validated.
- Implemented locally for `1.4.0-preview.14`: clearer Prepare section dividers and direct rundown reordering; separate words/translator/composer credits; exact Singer authoring preview; independently editable projected sermon/notice titles and output-specific pictures; safe exact-range **Gold emphasis** for sermon/notice bodies; a source-faithful native sermon-notes preset; and one localized title cue before every compiled song arrangement. A developer-only service-deck importer now extracts explicitly selected PPTX text/runs and rendered images into a proposed song library and ServiceProject while defaulting to a content-safe dry run.
- Validated locally for `1.4.0-preview.14`: the full automated suite passes 421/421 tests. The three July 19 decks were used as references to recreate—not wrap—the service as a 114-cue native project with 71 semantic items, 12 titled groups including a six-part nested Sermon, 10 generated SongDocuments, 156 bounded inline-emphasis spans, seven portable PNG assets, and no PPTX/imported-deck/legacy-deck content. An isolated install compiled and published three equal 114-frame renderer-v4 output packages; all 93 localized sermon title/body frames passed a text-fidelity comparison, selected welcome/reading/sermon/localized-image frames passed visual inspection, and a portable round trip installed all ten reachable songs into a separate editable Song Library. No live SyncShow user data was changed. The current Preview 14 checkout has not yet received a fresh packaged UI smoke or install, and Remote still needs unrestricted real-LAN/phone/firewall validation beyond its automated loopback coverage.
- Implemented locally for `1.4.0-preview.15`: the Song Library and output chooser group linked originals and translations as one family, while reconciliation repairs each translation’s stored original-song ID (`translationOf`) to the preserved catalog identity. The full July 19 portable service keeps all 71 semantic items, 31 sermon items, and 114 cues per output while reusing eight exact catalog song resources and pinning two Singer/Media-only resources. ServiceProject ShowPackages now carry constrained scene JSON, picture assets, and raster operator thumbnails; Electron output windows construct the native DOM and render it live with HTML/CSS. PPTX output remains on the separate pre-rendered image path.
- Validated locally for `1.4.0-preview.15`: all 76 JavaScript sources pass syntax checks; 468 of 471 automated tests pass, with the remaining three unchanged Remote loopback cases denied `listen` permission for `127.0.0.1` by the managed sandbox. The focused native scene/package/startup-barrier and coordinated-tamper regressions pass. The isolated Apple Silicon app/ZIP has the expected Preview 15 identity, arm64 executable/Sharp/libvips, deep ad-hoc signature, macOS 12 and ATS metadata, complete source-matched native renderer/Bible/font resources, exact secret-safe Google configuration, and valid ZIP structure. This managed host rejects LaunchServices startup for both the old and new test apps and aborts direct Electron window startup, so packaged UI/native paint, real Remote networking, cross-platform, and venue results are not claimed.
- Implemented locally for `1.4.0-preview.16`: source-audited native song intro cards. Full public cards use black, a bold white primary title, an optional yellow linked title, and a lower-right exact attribution; when exact attribution is absent, localized words/music/translation labels are generated from structured credits. Singer/Media defaults to a simple single-title card with no credit, while explicit channel settings and narrowly defined source-content exceptions can retain a full card. The title cue keeps its deterministic project/item/`title` identity. The compatibility tuple is native scene schema 2, cue compiler 3, and renderer 6.
- Validated at source level for `1.4.0-preview.16`: all 76 JavaScript sources pass syntax checks; 471 of 474 automated tests pass, with the same three Remote loopback cases denied `listen` permission for `127.0.0.1` by the managed sandbox. Focused tests cover the full and simple title-card rules, exact and structured-fallback credits, stable title cue IDs, constrained scene validation, raster operator thumbnails, and live DOM rendering. The Apple Silicon app/ZIP also passes architecture, deep/strict ad-hoc signature, packaged-content, credential-file equality, ZIP integrity, and extracted-file equality checks. This managed GUI host denies both LaunchServices and direct Electron launch, so a normal-host native-window smoke remains pending and is not claimed here.
- Implemented locally for `1.4.0-preview.17`: optional authenticated Heritage Community song synchronization behind Admin Settings; manager-approved device-secret + PKCE authorization; OS-encrypted scoped credentials; private/member-visible/scheduled-member visibility; complete cursor pagination; offline-first original/translation family exchange; checksum and ETag compare-and-swap protection; archive-only tombstones; abortable lifecycle cleanup; and guarded keep-local/keep-Community conflict review. The Friendly Load and Show paths remain server-independent.
- Validated locally for `1.4.0-preview.17`: all 81 JavaScript sources pass syntax checks and all 520 tests that do not bind a Remote listener pass. The three additional Remote loopback cases remain a normal-host network gate because the managed shell denies `listen` on `127.0.0.1`. The ad-hoc Apple Silicon app and ZIP pass source/package equality, arm64 architecture, deep/strict signature, and ZIP-integrity checks. An unlocked packaged pass covered Friendly Load, Admin Settings, the Shared song library panel, Prepare, translated song families, and the native song intro card. Real Heritage approval/two-way sync and production migration/backfill remain explicit staging gates.
- Still intentionally pending: user-facing reconciliation of imported decks with the native cue timeline; a richer custom preset/style designer and portable custom preset packs; an explicit Prepare publishing command for private Drive connections; remote Prepare/Bible authoring; and any cloud/internet Remote relay. Windows, Intel Mac, Linux, physical venue multi-monitor/converter validation, and the live Google checks above remain release gates.

### Current product blockers

- The persisted venue Profile, role/output editor, monitor matching, local ServiceSet snapshots, and ServiceProject/ShowPackage persistence are present, but Identify Screens and native/project outputs still require real Windows, Intel Mac, Linux, and venue multi-monitor validation.
- Automatic loading now supports a private OAuth folder, a public view-only Drive folder link, or a normal local/Google Drive Desktop-synced folder. The supplied public folder passed a live anonymous listing check in Preview 11. Source and focused tests do not prove that a current local or GitHub build has been provisioned with release credentials; complete current packaged private Picker/refresh-after-restart and shared-drive checks remain release gates.
- The live Bible overlay and pinned Bible-to-service authoring are present. Multi-page passage flow, parallel per-output translations, Psalm superscription normalization, and broader venue typography/fitting tests remain.
- Show-only trusted-LAN Remote Control and the common text/image Prepare workflow are present. Remote Prepare/Bible authoring, cloud relay, broader administration, in-app imported-deck reconciliation, and the richer preset designer are intentionally excluded from this preview.

## 4. What the three July 19, 2026 decks tell us

The three files from the example shared Drive service were inspected as:

- `07-19-2026 Служение RUS.pptx`
- `07-19-2026 Service ENG.pptx`
- `07-19-2026 Media.pptx`

They are a strong basis for a small preset editor, but not evidence that SyncShow needs to reproduce all of PowerPoint.

| Finding | Russian | English | Media/Singer | Product implication |
| --- | ---: | ---: | ---: | --- |
| Slides | 114 | 114 | 114 | Maintain one shared cue timeline with role-specific content. |
| Page size | 10 × 5.625 in | 10 × 5.625 in | 10 × 5.625 in | Use a fixed 16:9 logical canvas and scale to outputs. |
| Layout families | 68 Title and Content; 46 Two Content | same | same | A small preset set can cover the current service. |
| Packaged picture assets / slide uses | 4 / 3 | 4 / 3 | 3 / 2 | Images are uncommon and reused; text-first presets cover most slides, but picture cues still need first-class support and dedicated fixtures. |
| Blank/textless slides | 11 | 11 | 10 | Blank cues are intentional timeline items, not empty data to delete. |
| Typical text | median 4 lines | median 4 lines | median 3 lines | Media is often a condensed output variant. |

Additional structural findings:

- Russian and English are byte-for-byte text-equal on 72 of 114 slide positions. The editor must support “inherit the same content” as well as translated overrides; it should not force every output to have unique language text.
- Media is text-equal to Russian on 96 of 114 positions. Only a minority needs a custom Singer treatment. Around slides 34, 38–40, and 42 it intentionally carries shortened text; slide 69 adds a sermon-title treatment where the other decks are blank.
- The dominant shape patterns are one full-width title region and one full-width content region, or one centered text region occupying most of the canvas. Most paragraphs are centered.
- Common explicit sizes cluster around 32, 36, 40, and 44 pt. Calibri/inherited theme text dominates, with Times New Roman used secondarily. White, yellow, and orange are the main explicit text colors.
- The files use two stock layout names, but their many small position and formatting variations mean the editor should normalize into semantic presets rather than preserve every PowerPoint shape as a new template.

### Preview 14 reconstruction and Preview 15 portable rebuild

The guarded utility documented in [`SERVICE_DECK_IMPORT.md`](SERVICE_DECK_IMPORT.md) was first exercised in its default dry-run mode against local copies of all three decks. The review used explicit slide selectors, PowerPoint run-color filters for bilingual text, and nine separately rendered image inputs; its report exposed IDs, counts, and hashes rather than extracted lyrics or sermon bodies. That proposal was then curated as a normal editable ServiceProject and used to drive missing authoring features—inline emphasis, per-output pictures, and a source-faithful sermon-notes preset—rather than retained as an imported slideshow wrapper.

The finished reconstruction compiles to the same 114 logical positions as the source decks: 71 semantic items comprising 12 titled groups, 6 songs, 10 reading/notice cues, 31 sermon cues, 3 pictures, and 9 blanks. A new Sermon parent contains six movable sermon sections; one localized title cue before each of the six song arrangements closes the prior 108-versus-114 cue gap.

Preview 15 rebuilds that complete project against the reconciled song catalog. The portable artifact `dist/2026-07-19-07-19-2026-service-native-import.syncshow-service` pins eight exact reusable catalog resources plus two output-only Singer/Media treatments. A catalog-first isolated import therefore reuses the eight library identities instead of manufacturing duplicate songs, while the two special render resources remain service-local. The artifact still contains all 71 semantic items, including all 31 editable sermon items, and resolves to 114 cues for every output.

No live SyncShow user data was written. The project contains no PPTX, imported-deck, or legacy-deck item: songs, readings, sermon text/emphasis, pictures, blanks, and groups are all native and remain editable. Preview 14’s isolated renderer-v4 reconstruction published three equal 114-frame channels, passed the localized sermon text comparison and selected-frame visual checks, and round-tripped all ten reachable songs. That is historical evidence for the prior raster native path. A fresh packaged Preview 15 import, live-scene output run, and venue comparison remain; treat the Preview 15 artifact as a locally reviewed test artifact, not release-validated live data.

Recommended initial preset set:

1. Song title
2. Song lyrics
3. Scripture title/reference
4. Scripture text
5. Sermon title
6. Sermon point
7. Full-screen picture
8. Blank/black

Each cue should inherit the preset’s style tokens and allow a limited per-cue override. Each output channel can inherit the cue, translate it, condense it, hide it, or provide its own variant. This directly models the sample decks without turning SyncShow into a PowerPoint clone.

## 5. Target domain model

All persisted records need `schemaVersion`, stable IDs, timestamps, and deterministic JSON serialization. Labels are editable; IDs are not derived from labels. Settings and projects should be written atomically and retain one last-known-good backup.

### Profile

A **Profile** describes a venue and its safe defaults, not a single Sunday.

```json
{
  "schemaVersion": 1,
  "id": "main-sanctuary",
  "name": "Main Sanctuary",
  "timeZone": "America/Los_Angeles",
  "friendlyModeDefault": true,
  "inputRoleIds": ["primary", "secondary", "media"],
  "outputIds": ["main-left", "main-right", "singers"],
  "stalenessPolicy": "warn-and-confirm",
  "previewOutputIds": ["singers"],
  "localServiceFolder": null,
  "driveConnectionId": null
}
```

Profiles own defaults such as screen fingerprints, output routes, filename matchers, transition preset, Singer fallback preference, and preview visibility. OAuth tokens do not belong in exportable Profile JSON.

### InputRole

An **InputRole** says what kind of source the service may provide.

```json
{
  "id": "media",
  "label": "Singers Screen (Media)",
  "kind": "deck",
  "acceptedTypes": ["pptx", "ppt", "service-project"],
  "required": "if-used-by-enabled-output",
  "filenameMatchers": ["media", "singer", "stage"],
  "datePolicy": "service-date"
}
```

The shipped migration can create `primary`, `secondary`, and `media` roles with familiar Russian, English, and Singer labels, but users can rename, add, remove, and reorder them.

### Output

An **Output** is a named presentation destination and source rule.

```json
{
  "id": "singers",
  "name": "Singers Screen",
  "enabled": true,
  "displayFingerprint": "win:display-device-id-or-bounds-fallback",
  "source": {
    "mode": "role",
    "roleId": "media"
  },
  "rendererPresetId": "singer-current-next",
  "operatorPreview": true
}
```

Supported source modes should be:

- `role`: display the selected input/project channel;
- `mirror`: show an existing role/output unchanged;
- `derive-next-text`: show the current slide plus the next useful text extracted from a source role;
- `native-cue`: render the output’s cue variant from a ServiceProject; and
- `disabled`: keep the configured output without opening a window for this service.

Outputs can be added or removed without code changes. The only universal Start requirement is at least one enabled, mapped output with a resolvable source.

### ServiceSet

A **ServiceSet** is the resolved, loadable collection for one service, including legacy files.

```json
{
  "schemaVersion": 1,
  "id": "2026-07-19-main-service",
  "name": "Sunday Service",
  "serviceDate": "2026-07-19",
  "timeZone": "America/Los_Angeles",
  "source": { "type": "local-folder", "locator": "…" },
  "inputs": {
    "primary": { "assetId": "…", "fileDate": "2026-07-19" },
    "secondary": { "assetId": "…", "fileDate": "2026-07-19" },
    "media": { "assetId": "…", "fileDate": "2026-07-19" }
  },
  "warnings": []
}
```

It records exactly which assets were selected, rather than re-running “latest file” resolution during Show.

### Compiled CueTimeline

A compiled **Cue** is one synchronized position in an immutable service timeline. Prepare does not persist generated song cues as a second editable truth; it compiles them from semantic items and pinned resources.

```json
{
  "id": "cue-a14f06e7633f7c51bb8ad1ee",
  "itemId": "song-amazing-grace",
  "kind": "song",
  "title": "Verse 2",
  "groupPath": ["Worship", "Song 3", "Verse 2"],
  "channels": {
    "primary": { "mode": "content", "blocks": [] },
    "secondary": { "mode": "content", "blocks": [] },
    "media": { "mode": "condensed", "blocks": [] }
  },
  "operatorNotes": "",
  "presetId": "song-lyrics"
}
```

Cue kinds include slide, song, Bible, sermon, picture, notice, and blank. Channel inheritance/derivation is fully resolved during compilation. Native navigation retains deterministic Cue IDs while numeric index remains the legacy/PPTX compatibility position.

### ServiceProject

A **ServiceProject** is the editable Prepare document.

```json
{
  "schemaVersion": 1,
  "kind": "syncshow-service-project",
  "id": "service-2026-07-19",
  "title": "Sunday Service",
  "serviceDate": "2026-07-19",
  "preferredProfileId": "main-sanctuary",
  "channelIds": ["primary", "secondary", "media"],
  "channels": {},
  "rootItemIds": ["worship", "sermon"],
  "items": {},
  "resources": {},
  "assets": {},
  "presetPack": { "id": "main-sanctuary", "version": 1 }
}
```

The ordered item tree is the only authoring-order authority. Song items pin content-addressed SongDocuments plus stable arrangement-entry IDs; pictures pin validated content-addressed assets. `compileServiceProject()` derives an immutable CueTimeline with order-independent Cue IDs, and `ShowPackagePublisher` publishes one integrity-checked equal-length generation per mapped venue role. For a native ServiceProject, that generation contains constrained scene JSON, pinned picture assets, and raster thumbnails for operator navigation; Show reads the scene package, never the mutable draft or live library.

## 6. Friendly Mode and advanced settings

The product label can be exactly **Normal Person Friendly Mode**, with Friendly Mode used as the shorter label elsewhere. It should be on for new profiles.

Friendly Mode hides:

- adding/removing input roles and outputs;
- physical screen routing after the profile is healthy;
- converter selection/diagnostics;
- cache and render-resolution controls;
- transition tuning and experimental synchronization;
- Singer typography and extraction limits;
- filename matcher and stale-policy editing;
- cloud/OAuth management; and
- per-output preview configuration.

Friendly Mode always keeps visible:

- selected service/date and source files;
- human-readable output health;
- Browse, Refresh, Identify Screens, Start, Show, Clear, Stop, and emergency Remote Off;
- warnings and a focused way to resolve them; and
- the ability to return to Load.

### “Do you know what you’re doing?” warning

When an operator turns Friendly Mode off or opens Advanced Settings for the first time in a profile, show:

> **Do you know what you’re doing?**
>
> These settings control what appears on each live screen. A wrong change can send the wrong content to the room. Continue if you are setting up the venue; otherwise stay in Friendly Mode and use the saved defaults.

Actions:

- **Stay in Friendly Mode** — primary/safe action;
- **Open Advanced Settings**; and
- optional **Don’t show this warning again for this profile**.

The warning should be warm, not demeaning, keyboard-accessible, and screen-reader readable. It should not appear every time a knowledgeable operator opens Settings. Advanced changes show a summary and **Save profile**; output-impacting changes made while live are staged for the next Start unless explicitly applied.

Include **Reset profile to safe defaults** with a preview of what will change and an automatic backup.

## 7. Flexible inputs, outputs, and Start preflight

### Output setup

Advanced Settings provides an ordered output list. Each row has:

- custom name;
- enabled toggle;
- physical display selector and Identify action;
- source mode and source role/output;
- presentation preset;
- operator-preview toggle; and
- duplicate/remove controls.

Adding an output should duplicate a known-good output by default. Removing an output should disable/archive it until Save, so an accidental click is reversible. One physical display can host only one fullscreen SyncShow output window; mirroring means resolving the same source onto a different physical display. A same-display composite is a separate future compositor feature, not a routing exception.

Output routing must resolve as an acyclic graph. Reject self-reference, mirror cycles, references to disabled/missing outputs, and any chain that does not terminate at a loaded role or native cue channel. Show the resolved source on every output row before Start.

Display persistence should prefer an OS-provided stable device identifier. Resolution/bounds/index are only a fallback because indices change when cables are moved. If a saved display is absent, Load reports “Singers Screen is not connected” rather than silently substituting another monitor.

### Start preflight

Start resolves and freezes a launch plan before opening windows:

1. Collect enabled outputs.
2. Resolve every output source from loaded roles/project channels.
3. Verify physical displays and detect collisions.
4. Validate converted generations and slide/cue availability.
5. Compare service dates and cross-role consistency.
6. Present only unresolved decisions.
7. Save a session snapshot and start all output windows under one session ID.

Warnings do not mutate the profile unless the operator chooses **Use this every time for this profile**. The default is **Use for this service only**.

### Missing required-deck behavior

Any enabled output whose expected role is missing gets a focused resolution step instead of leaving Start mysteriously disabled. For an ordinary language/auditorium output, offer:

1. **Upload the expected slideshow** — browse, convert, date-check, then return to preflight.
2. **Show an existing slideshow as-is** — mirror any loaded role on this physical output.
3. **Turn off this output for this service** — preserve the Profile but omit the output from this launch.

If several outputs are unresolved, preflight presents them in output order, retains completed choices, and ends with one reviewable launch plan. It never silently applies one missing role's choice to another output.

### Missing Media/Singer behavior

If an enabled Singer output expects the Media role but no Media slideshow is loaded, clicking Start must open this preflight instead of leaving Start disabled:

> **What should the Singers Screen show?**
>
> No Media slideshow is loaded for this service.

1. **Upload Media slideshow** — browse, convert, date-check, then return to preflight.
2. **Create next-text view from an existing slideshow** — choose any loaded role. Display its current slide with the defined next-slide text according to the configured Singer preset.
3. **Show an existing slideshow as-is** — mirror a selected loaded role on the Singer screen.
4. **Turn off Singers Screen for this service** — continue without opening that output.

Recommended default: preselect **Create next-text view from the primary loaded slideshow**, but require the operator to confirm the first time the choice is needed. A profile may remember the preferred fallback.

The one-deck edge case is therefore straightforward:

- one deck can drive one output;
- other outputs can mirror it;
- Singer can derive next text from it;
- Singer can mirror it unchanged; or
- Singer can be disabled.

No code path should require two language decks merely because two input-role slots exist. During Phase 1, two independently routed legacy decks with unequal slide counts block Start and offer upload/replace, mirror one good deck, or disable an affected output. Numeric-index synchronization must not guess an alignment; stable Cue-ID alignment arrives with ServiceProject in Phase 2.

### Deriving “next text”

The Phase 1 default is exact: show the selected source's current slide image plus the first meaningful extracted paragraph/line from the **next numeric slide**. It does not mean the next line within the current slide, and it does not search across later slides. An intentionally blank next slide therefore previews blank. A Profile may enable **Skip blank slides for Singer preview**, but that behavior must be visibly labeled and off by default. At the end of the deck, show the configured end-of-presentation state.

Derivation should use extracted paragraph/run order, not a fixed character slice alone. It needs tested rules for blank slides, title slides, repeated choruses, soft line breaks, missing extraction, and the end of the deck. The operator preview must show exactly what singers will see. If text extraction is unavailable, preflight offers mirror/disable instead of producing an unexplained blank.

## 8. Service dates, stale warnings, and automatic folder loading

The current filename parser is useful, but “today” is the wrong sole reference. Teams prepare future services, rehearse before midnight, and may operate in a timezone different from the computer’s default.

### Date rules

- Every ServiceSet has an explicit `serviceDate` and `timeZone`, defaulting to the profile’s local today.
- Parse a date from each input title/filename when present.
- Validate **every used input role**, including a dedicated Media/Singer file.
- Report three distinct states: matches service date, recognizable different date, and no recognizable date.
- Also warn when loaded roles have different recognizable dates from each other, even if one matches today.
- A mirrored or derived Singer output inherits the source file’s date status; it does not fabricate a separate Media date.
- Default policy is warning plus explicit Start confirmation, not a hard block. Remember the override only for the current service session.
- Advanced profiles may choose stricter policy, but Clear/Stop and access to Load must never be blocked.

Example Start warning:

> **Singers Screen may be using an old file**
>
> `Media 07-12-2026.pptx` is dated July 12, but this service is July 19. Replace it, use a fallback from another loaded slideshow, turn off the output, or continue once for this service.

### Selecting the “latest” files safely

Folder automation should resolve a coherent ServiceSet, not independently pick the newest modified file for each role.

1. Scan only supported file types and ignore temporary/lock files.
2. Match role names using profile-configured patterns.
3. Group candidates by parsed service date.
4. Prefer the requested service date.
5. Within one date and role, use version markers and modified time only as tie-breakers.
6. Never silently mix dated role files from different services.
7. If today’s set is incomplete but an older complete set exists, show both choices and the missing roles.
8. Once chosen, pin paths, sizes, modified times, content hashes, and Drive IDs in the ServiceSet.

Modified time is not a substitute for a service date: copying an old deck today must not make it look current.

## 9. Google Drive: local, private OAuth, and public-link sources

### Interim: Google Drive Desktop/local folder

The quickest reliable integration is a normal folder selected from Load or Profile Settings. It can be a local folder synchronized by Google Drive Desktop, Dropbox, Nextcloud, or another provider.

Implement:

- folder picker and read permission;
- role filename patterns;
- debounced rescans plus a manual Refresh button;
- placeholder/offline-file detection before conversion;
- deterministic ServiceSet resolution as described above;
- visible “syncing,” “available offline,” “changed since load,” and error states; and
- a pinned local copy/cache for Show.

Do not rely on a single `fs.watch` event; cloud clients commonly replace files or emit partial event sequences. Use watch-as-a-hint plus a reconciled directory scan. Never replace the active service automatically after Start.

This path requires no Google credentials and works with the example shared folder once it is synchronized locally.

### Direct Google Drive integration

Implemented in Preview 10: private folders use a Google Cloud Desktop OAuth client and the Drive API; public “anyone with the link can view” folders use the Drive API with a build-supplied restricted API key. Google documents a native client secret as optional and non-confidential; SyncShow accepts it when required by the configured Desktop client and sends it only to Google’s token endpoint for code exchange and refresh. It remains absent from source, logs, renderer IPC, Profiles, and user credential records, but is necessarily extractable from a public installer and therefore is not an application-authenticity control. A folder URL is an identifier, not a file-list response, so both paths still use the API.

Current verification boundary: Preview 11 successfully listed the supplied public folder anonymously, and focused tests cover the OAuth/Picker lifecycle, protected-token storage, refresh, Drive enumeration, downloads, and offline pinning. A new credential value is not established merely by this source tree, and the complete current packaged private Picker selection plus refresh-after-restart has not yet been verified. Keep the local/Drive Desktop folder path available until that release gate passes.

- enable both the Google Drive API and Google Picker API in the OAuth project, while restricting the public API key to the Drive API only;
- system-browser Authorization Code flow with PKCE;
- use Google Picker so the user explicitly grants the files/folder SyncShow may access;
- prefer the non-sensitive `drive.file` scope for Picker-selected files;
- accept only exact HTTPS `drive.google.com/drive/folders/...` public links, preserve resource keys, and keep public connections permanently pull-only;
- keep private connections load-only by default and require an explicit administrator opt-in before any future Prepare publishing action;
- never write, overwrite, or delete Drive content during discovery, refresh, automatic loading, or Show;
- do not assume selecting a folder with `drive.file` grants future child files needed for unattended weekly discovery—prototype that exact contract before committing to it;
- if persistent enumeration of arbitrary existing and future children requires broader `drive.readonly`, treat that restricted scope, Google verification burden, and consent wording as an explicit product decision rather than silently widening access;
- store refresh credentials with Electron/OS protected storage, never in Profile exports or logs;
- key files by Drive file ID, not title;
- use `modifiedTime`, checksum, and revision metadata for caching, while using title dates for service semantics;
- download to staging, validate, and atomically publish to the local service cache;
- continue offline from the last pinned ServiceSet;
- manual disconnect that revokes local credentials and removes only SyncShow’s account state; and
- clear explanation that a Google Cloud project/consent configuration is required even if expected usage stays within free quota.

Authoritative implementation references: [OAuth 2.0 for iOS and Desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app), [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [desktop/mobile Google Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker), [search for files and folders](https://developers.google.com/workspace/drive/api/guides/search-files), and [download and export files](https://developers.google.com/workspace/drive/api/guides/manage-downloads).

For a public, static church library, a generated manifest on a static Content Server is simpler and more reproducible than Drive enumeration. For private weekly work-in-progress decks, OAuth Drive is appropriate. Decap CMS can author Git-backed static library content, but it is not a replacement for Google Drive authentication or file sync.

## 10. Preview policy

Preview visibility belongs to Profile Settings and is configured per named Output.

Recommended defaults:

- Singer/Media preview: on when that output is enabled;
- auditorium language/output previews: off;
- previews for disconnected outputs: off; and
- thumbnails/cue list: still visible because they are navigation, not live-output capture.

The Show right pane should render only selected previews in a compact, reorderable section. Closed previews should not continue expensive `capturePage()` work. Preview capture must be throttled/coalesced and must never delay the output reveal path. Clearing outputs immediately clears their previews so the operator never sees stale “live” imagery.

## 11. Prepare, song libraries, sermon nesting, and pictures

### Song source format

Markdown is the canonical editable format; UTF-8 `.txt` is accepted as an import. A minimal file can be understandable without SyncShow:

```md
---
id: amazing-grace-en
title: Amazing Grace
language: en
translationOf: amazing-grace
license: Public Domain
---

^1
Amazing grace! How sweet the sound
That saved a wretch like me

^2
’Twas grace that taught my heart to fear
And grace my fears relieved
```

Rules:

- A line containing `^` plus a number, such as `^1` or `^2`, starts that numbered verse and is not projected as lyric text.
- Optional named sections may use explicit tokens such as `^chorus`, `^bridge`, and `^tag`; the UI stores a normalized stable section ID.
- `---` within the body is an explicit slide break. Automatic fitting may suggest additional breaks but never silently discard text.
- `^^` at the start of a line escapes a literal caret.
- Plain TXT without markers imports as one section and can be structured in Prepare.
- Translations store the original song ID in `translationOf` and align through matching section IDs. Reconciliation keeps that ID pointed at the preserved catalog root, and the UI groups the root and its language versions as one family. A structurally incomplete translation can be saved as a library draft, but Prepare explains the mismatch and will not link it to a service output until its sections and slide breaks align.

Preview 8 provides direct **New song**, **Edit**, and **Translate** actions around this format. The focused form covers title, language, original-song relationship, lyrics/sections, tags, attribution, license, and source; Preview 14 presents words, translators, and composers as distinct credits instead of merging them into one vague author field. Preview 15 presents one grouped family card with the original and its linked language/version rows, and offers translation creation once at the family level. Validation runs before save, song identity is immutable while editing, stale editors cannot silently replace a newer revision, and services already using a song keep their pinned revision. Search, language, tags, source/license/attribution, exact-content deduplication, and explicit local forks are present. The library now pages results with an explicit displayed/total count and stale-query protection, while batch import accepts up to 50 Markdown/TXT files, processes them independently, keeps partial successes, and refreshes once. Read-only subscribed-library items remain future Content Server work.

### Song-to-cue behavior

Preview 7 provides an arrangement list—e.g. `1, chorus, 2, chorus`—whose entries retain stable identities while they are repeated, reordered, or removed. A compatible library translation can be linked to an output only when it belongs to the same song family and has the same section/slide structure. “Use normal” restores inheritance for ordinary outputs or the next-line derivation for Singer.

Preview 8 adds direct section/slide-break editing and catalog-backed song presentation choices. Preview 14 compiles one stable localized song-title cue before the arrangement, then the lyric cues; inherited outputs receive the resolved language title, derived Singer outputs preserve their source-channel relationship, and hidden outputs remain hidden. Selecting the service item renders the exact revision-pinned native cue for a chosen output; Previous/Next moves through the title and every arranged song cue, while the Singer choice shows its current/next treatment. This is an authoring preview from the same renderer used for publication, not a lower-fidelity mockup.

Preview 16 makes that intro card match the audited service sources. A full public card is black with a centered bold white primary title, an optional yellow linked title, and a lower-right source credit. Exact attribution wording is preserved and laid out as lines; if it is absent, structured authors, composers, and translators produce a localized fallback. Singer/Media normally receives only its resolved title, with no linked subtitle or credit. An explicit per-channel `titleCardMode` always wins; otherwise a multilingual source-content channel, or inherited source content with one public title and exact attribution, can retain the full card. The cue ID remains `deterministicCueId(project.id, item.id, 'title')`, so ordinary content or styling edits do not move the operator to a new cue. Arbitrary custom condense/hide variants and the richer preset/style designer remain planned.

### Sermon nesting

Sermon preparation should be an outline, not a flat slide pile:

- sermon → section → point → subpoint → cue;
- add and directly edit service sections, sermons, points, and subpoints;
- use titled groups as visible rundown dividers, then reorder directly by drag/drop or move controls, deliberately indent/outdent, collapse/expand, and deep-duplicate a group with its descendants;
- add and edit distinct projected titles and bodies per output under any valid group; an omitted output remains hidden;
- import Markdown headings into the same hierarchy (planned);
- Bible and picture cues can be nested under a point;
- Show navigation advances only leaf cues but displays the group path to the operator; and
- collapsing a group in Prepare never changes cue order.

Preview 8 keeps the outline deliberately simple and enforces a validated maximum internal depth of 32. Every accepted mutation autosaves an immutable revision; toolbar and keyboard Undo/Redo restore that stored history with compare-and-swap conflict protection instead of mutating a published service in place.

Preview 14 also makes the boundary between an editor draft and an accepted mutation explicit. Text, output, preset, and inline-emphasis edits remain dirty until **Save changes**; Cancel, Escape, or closing SyncShow asks before an unsaved draft is discarded.

### Picture support

Preview 8 includes the first complete picture-cue path:

- import a validated single-frame PNG, JPEG, or WebP;
- preserve the original as a content-addressed project asset and honor EXIF orientation while rendering;
- choose a different pinned image for each configured output while keeping omitted outputs hidden;
- choose Fit, Fill, or Stretch, with a safe centered focal point;
- store required operator alt text plus optional attribution;
- render the picture through the same exact item preview and offline ShowPackage path; and
- include pinned image assets in verified `.syncshow-service` export/import.

User-adjustable focal points/crop, pictures attached to text presets, pre-decoding policy, animation, and video remain later media/designer work. The July 19 sample decks use only a few reused picture assets, so picture cues still require broader fixtures and venue tests rather than assuming those files cover cropping, orientation, large images, or missing assets.

## 12. Spontaneous Bible display

The Show screen gets a small **Bible** button on the right. It opens a staging palette modeled after the fast workflow in FreeShow/ProPresenter, without copying either application’s UI.

### First release behavior

1. Type a reference or shortcut.
2. Resolve and validate it using the parser behavior already proven in Heritage Study Bible’s `src/utils/parseBibleReference.js`.
3. Resolve ambiguous numbered-book families visibly. For example, an abbreviated Peter reference without `1` or `2` should offer both rather than guessing.
4. Select a verse/range and translation.
5. Preview the generated cue for each enabled output.
6. Press **Send Live**.
7. Press **Return to service** to restore the exact deck/project cue that was active before the Bible interruption.

Bible display uses an overlay cue stack and does not insert surprise permanent slides into the prepared order. In Prepare, **Add to service** now creates a pinned Bible item containing its canonical range, bundled text, attribution, and checksum.

### Translations

- Ship/configure **BSB** as the default.
- Include **LSV** as the second built-in example and allow it to be enabled/selected in Settings.
- Preserve translation name, language, versification, license, attribution, source version, and checksum in a manifest.
- Display/export any attribution required by the translation’s license.
- Validate imported translation structure and never encourage users to import copyrighted text without permission.
- Allow a Profile to map translations to output channels, including parallel output when desired.

Reuse Heritage’s tested reference parsing and generated translation artifacts through a small versioned shared module/artifact. Do not make SyncShow depend on the entire Heritage React application at runtime.

## 13. Remote Control for Show

The current Remote Control is intentionally limited to live Show operations:

- current cue and next cue preview;
- Previous, Next, jump to a visible cue;
- Show/Restore and Clear;
- current output health.

It cannot upload files, edit projects, create or translate songs, change Profiles, remap screens, manage Google credentials, browse the filesystem, or quit the application. Remote Bible selection and all remote Prepare authoring remain separately reviewed future work.

### LAN security model

- Remote is off by default and enabled per session/profile.
- Bind to loopback until the operator explicitly chooses a LAN interface.
- Pair through a QR code plus short code backed by a high-entropy, rotating session token.
- Expire pair codes quickly; provide one-click revoke-all.
- Validate Origin/Host, rate-limit pairing and commands, and use an allow-listed command schema.
- Include output-session ID and monotonic sequence number in every command so a delayed packet cannot control a replacement show.
- Return authoritative state after every accepted command; make commands idempotent where possible.
- Show a persistent local indicator with connected-device count and **Remote Off**.
- Do not enable UPnP, router changes, cloud relay, or internet exposure in the first release.
- Treat plain LAN HTTP as trusted-network-only and say so. Add authenticated TLS/cloud relay only as a separately reviewed design.

Remote failure must be invisible to slide timing. The local controller remains authoritative and fully functional if Wi-Fi disappears.

## 14. Native presets and the future richer designer

Preview 8 ships a curated catalog of stable semantic presets for songs, Scripture, sermons, notices, full-screen pictures, and black cues. A compatible preset can be selected while editing an item, and Prepare renders that item for any configured output with the exact deterministic native renderer used by publication. Existing projects retain preset IDs so expanding the catalog does not restyle old work.

It does not yet expose an arbitrary theme or layout editor. That richer designer should remain a semantic scene composer, not a general office suite.

### Future editable preset properties

- 16:9 logical canvas and safe margins;
- background color or picture;
- title/body text regions;
- font family, size range, weight, color, alignment, and line spacing;
- maximum lines and overflow warning;
- verse/reference styling;
- optional current/next regions for Singer;
- per-output/channel variants; and
- transition choice from a small supported set.

Preview 15 implements this boundary as constrained, versioned scene JSON rather than saved arbitrary HTML or CSS. Preview 16 advances that contract to native scene schema 2, cue compiler 3, and renderer 6 for the source-audited song intro card. The Electron display window validates the scene, constructs text/picture/Singer DOM nodes, waits for the bundled font and media, performs fit checks in a hidden layer, and then reveals the prepared HTML/CSS scene. Native full-size audience frames are no longer published as JPEGs; only operator-navigation thumbnails remain raster. Focused coverage exercises the same intro through both the raster thumbnail renderer and live browser DOM renderer. Imported PPTX decks stay on their separate PowerPoint/LibreOffice pre-rendered image path. Cross-platform, mismatched-resolution, and physical-venue parity still require the release-gate tests below.

### Import/export boundary

- PPTX remains an import source rendered through PowerPoint/LibreOffice.
- Preview 14 includes a developer-only, dry-run-first importer for explicit deck paths, slide selections, run-color filters, and rendered-image inputs. It can propose native songs and common text/image cues, but it is not yet an in-app assisted importer or a general legacy-deck reconciliation path.
- A later in-app importer may detect repeated text boxes/colors and propose a SyncShow preset, but it must show the user what was lost and require visual review before publication.
- Native projects do not store opaque PPTX as their editable truth.
- PPTX export is optional later and should not block the editor. PDF/image export is simpler for archival.

The sample deck analysis supports the current small preset catalog and a future handful of style tokens. It does not justify tables, animations, arbitrary shape editing, macros, charts, or full PowerPoint compatibility.

### All-downloaded-services song-catalog evidence

The June 21 through July 19 review covers five services and 15 source decks. It found 28 song occurrences across 27 content families, with one exact reuse, and produced 42 editable language-specific catalog `SongDocument`s plus five pinned Singer/Media-only render resources that are deliberately not reusable library entries. The reconciler preserves stable song IDs and points every linked translation’s `translationOf` value at its catalog root; Preview 15 presents those related language versions as one family without merging their independently editable documents. The combined portable service has five date groups and 273 native cues. Explicit per-song normalizers made 323 reviewed character substitutions: 314 look-alikes in one Ukrainian source, five Latin letters embedded in Russian text, one Cyrillic letter embedded in English text, and three Cyrillic repeat markers converted to the unambiguous multiplication sign. Ordinary English and Cyrillic remain untouched.

`scripts/build-service-song-catalog.js` produces the ignored one-step artifact `dist/downloaded-song-library-2026-06-21-through-2026-07-19.syncshow-service`, five optional date-specific `.syncshow-service` bundles, and `dist/downloaded-service-song-catalog-report.json`. The report records source and artifact hashes, the deterministic reconciliation counts, normalization evidence, and the retained manual-review list. Ambiguous musical sections remain provisional `P1`/`P2` labels and uncertain structure or credits remain review items rather than guesses.

The combined bundle was tested in a separate empty data root: its first import added all 42 reusable songs, its second import recognized all 42 as unchanged, and the five output-only Singer resources remained pinned but absent from the library. The portable content has no PPTX, imported-deck/legacy-deck item, or asset, and the build wrote no live SyncShow user data. These are local build and round-trip results only; no packaged UI, native window, cross-platform, or venue claim follows from them.

## 15. Heritage Study Bible and church-content integration

SyncShow and Heritage can share content without becoming one deployable application.

### Static Content Servers

Heritage already defines a versioned public `heritage-content.json` manifest and catalogs for `songs`, `sermons`, `readingPlans`, `books`, and `commentaries` in its `protocol/heritage-content-v2.schema.json`.

Recommended integration:

- SyncShow subscribes read-only to public Content Servers.
- Phase 4 initially consumes `songs` and `sermons`; Bible translation artifacts remain separately versioned.
- Validate manifest kind/version, IDs, catalog type, URLs, media type, size, and checksum.
- Cache a pinned copy for offline Prepare/Show.
- Local edits create local forks unless the source explicitly supports publishing.
- A Decap CMS site can be one authoring front end that publishes these static catalogs and files.

This layer is static, public, cacheable, and does not require a user account.

### Authenticated Communities

Heritage Communities are a separate dynamic system for membership, shared notes/plans, events, private resources, permissions, and publishing workflows. They have authentication and server-side state.

SyncShow should not require joining a Community to:

- run local presentations;
- use BSB/LSV;
- subscribe to a public Content Server; or
- prepare from a local library.

Preview 17 implements the first optional authenticated provider for **songs only**. A compatible Community advertises the versioned SyncShow endpoint in discovery. A church manager approves one named installation; SyncShow stores the scoped grant through operating-system protected storage, while the server rechecks current manager membership on every request. Local SongDocuments remain usable offline and synchronize as complete language families with explicit private/member-visible/scheduled-member visibility and guarded conflict resolution.

This does not publish ServiceProjects or sermons yet, does not reuse a Community browser session, and does not mix Community credentials into static Content Server records or Google Drive credentials. Static Content Servers remain the public distribution path; Community is the authenticated church-state path.

### “Super app” boundary

The long-term ecosystem can share:

- Bible reference parser and translation package format;
- church-content manifest/catalog schemas;
- song and sermon document schemas;
- stable IDs and deep links; and
- optional authenticated publishing APIs.

It should not yet share one process, database, deployment, or release train. OBS control, streaming, and AI audio translation are future integrations with very different reliability, permission, latency, and licensing requirements. They belong behind explicit adapters after SyncShow’s core workflow is stable.

## 16. Phased roadmap

### Phase 0 — Foundation and release safety

Goal: make the existing `v1.3.3` feature set safe to extend.

Deliverables:

- transactional, validated cache generations with rollback;
- isolated converter jobs; PowerPoint-first Windows strategy retained with LibreOffice fallback;
- output-session lifecycle and async navigation tokens;
- validated IPC schemas and path confinement;
- fix duplicate IDs, Escape behavior, stale UI state, and listener/timer cleanup;
- package allow-list and artifact-content test;
- documented MuPDF/third-party distribution model and notices, or a replacement PDF renderer;
- supported Electron runtime upgrade plus an explicit macOS minimum-version decision;
- unit-test/lint scripts plus converter, cache, display-state, and date-parser tests;
- structured logs and a copyable diagnostics report with secrets/paths minimized;
- measured conversion result for all three July 19 decks; and
- branch cleanup by porting behavior, not merging conflict-heavy history.

Exit gate: forced conversion failure preserves the previous show; rapid Start/Stop/Start cannot resurrect old windows/slides; one packaged smoke test passes on each supported OS; built artifacts contain no development runtime or local service data.

### Phase 1 — Load-first workflow, Friendly Mode, and flexible outputs

Goal: make the common and edge-case loading workflows obvious and safe.

#### Phase 1A — Safe models and launch resolution

- Profile, InputRole, Output, and ServiceSet schema v1;
- migration from Russian/English/Singer settings;
- generic missing-role/output preflight;
- one-deck start, mirror, per-service disable, and the missing Media/Singer four-choice flow;
- explicit mismatch blocking for independently routed legacy decks;
- Singer file stale warning plus service-date consistency rules; and
- restore any valid subset of previous inputs.

Exit gate: zero/one/two/three-deck fixtures produce a complete, understandable launch plan; a one-deck service can Start; missing Media is recoverable; and mismatched independent decks never guess an alignment.

#### Phase 1B — Load/Show and venue configuration

- Prepare/Load/Show shell with Load as startup default;
- Normal Person Friendly Mode and guarded Advanced Settings;
- custom output names and arbitrary output count;
- stable monitor matching and Identify Screens;
- acyclic output routing with one window per physical display; and
- per-output optional previews, Singer-only default.

Exit gate: a first-time volunteer can open Load, identify screens, understand every enabled output, handle a missing deck, and start without seeing advanced controls. Test one through at least five configured outputs.

#### Phase 1C — Local synced-folder discovery

- local service folder/Google Drive Desktop selection;
- coherent service-date grouping, filename-role matching, placeholder/offline detection, and reconciled rescans;
- pinned service snapshot and changed-since-load warnings; and
- permanent manual Browse/Refresh fallback.

Exit gate: Load can accept today's coherent local/synced ServiceSet and run it offline. Preview 10 subsequently added the Phase 4 private OAuth and public-link sources without removing this no-credential fallback.

### Phase 2 — Prepare, libraries, and the focused editor

Goal: prepare a complete service without PowerPoint for the common text/image cases.

Preview 6 established the vertical foundation through local song import, semantic project revisions, text/blank/picture items, deterministic cue compilation, native rendering, immutable package publication, and Load/Show reuse. Preview 7 added nested sections, stable arrangement editing, structurally aligned per-output translations, reversible Singer behavior, and pinned Bible items. Preview 8 completed the common direct-authoring loop: songs and translations, semantic outline/text/blank/picture editing, deep duplicate, exact preset-backed item previews, revision-backed Undo/Redo, and portable service exchange. Preview 14 refined the operator-facing editor with clear section dividers, direct rundown reordering, separate song credits, localized song-title cues, Singer preview, per-output projected titles and picture assets, exact selectable inline emphasis, paged/batch song intake, and an explicit service-item save/discard guard; it also added the guarded developer deck-review utility described above. Preview 15 groups linked song translations as families, rebuilds the complete July 19 service against reusable catalog identities, and moves native ServiceProject audience output from published full-size raster frames to schema-validated live Electron DOM scenes while preserving the PPTX image path. Preview 16 source-audits the song intro presentation, preserves stable title cue identity, and aligns its raster-thumbnail and live-DOM renderers under scene schema 2/compiler 3/renderer 6.

Implemented deliverables:

- ServiceProject and Cue schema v1;
- Markdown/TXT song parser and direct editor with `^X` sections and explicit slide breaks;
- paged local song library, up-to-50-file batch import, create/edit/translate workflow, attribution fields, translation linking, and arrangement builder;
- nested semantic grouping plus direct sermon/notice title/body editing by output, drag/move reordering, indent/outdent, collapse, and deep duplicate;
- explicit service-item draft save/discard protection;
- blank and per-output picture cues with portable asset storage;
- exact-range inline body emphasis with stale-range invalidation after text edits;
- a curated native preset catalog plus revision-pinned exact item preview by output;
- normal per-output inheritance, aligned song translations, and reversible Singer derivation;
- autosaved revision history, Undo/Redo, explicit history restore, and verified `.syncshow-service` export/import;
- constrained native scene packages with live Electron DOM/HTML/CSS output and raster operator thumbnails; and
- a dry-run-first developer importer for bounded extraction of explicit legacy service decks into a review project.

Remaining before Phase 2 is complete:

- turn the developer review importer into a visual, user-facing legacy-deck reconciliation flow;
- add arbitrary per-output condense/hide authoring beyond the current translation and Singer behavior;
- design custom style/preset packs, their editor, and a portable compatibility contract; and
- prove renderer, converter, and multi-monitor parity on Windows, Intel Mac, Linux, and venue hardware.

Exit gate: move the isolated July 19 reconstruction and the five-service song-catalog artifact through the packaged in-app import flow, then run them on Windows and macOS with snapshot/venue parity. The local reviews already recreate the July 19 service’s 114 synchronized channel positions and reconcile all 28 downloaded-service song occurrences as native content without changing live user data. Keep the PPTX route available throughout.

### Phase 3 — Bible and LAN Remote Control

Goal: add the two most valuable live capabilities without destabilizing local operation.

Deliverables:

- staged Bible palette on Show;
- Heritage-derived/tested shorthand parser and ambiguity chooser;
- BSB default and LSV built-in optional translation;
- range fitting, per-output translation mapping, Send Live, Return to service, and Add to service;
- LAN remote server, QR pairing, session tokens, command allow-list, and revoke UI; and
- remote current/next state with local controller authority.

Exit gate: spontaneous Bible display returns to the exact previous cue; remote replay/stale commands cannot affect a new output session; network loss has no effect on local Show timing.

### Phase 4 — Direct Drive and static Content Servers

Goal: make weekly service discovery and shared libraries convenient while keeping Show offline-capable.

Deliverables:

- Google OAuth/PKCE folder connection and secure credential storage;
- deterministic role/date resolver using Drive IDs and revisions;
- staged downloads, offline cache, disconnect/revoke, and conflict UI;
- Heritage Content Server v2 subscription for songs and sermons;
- static catalog validation, checksums, pinning, refresh, and local fork behavior; and
- optional Decap-authored static library publishing documentation.

Exit gate: prepare/load from Drive, disconnect the network, restart SyncShow, and run the pinned service. A malformed or unavailable content server cannot block startup or damage local library data.

### Phase 5 — Ecosystem hardening and optional adapters

Goal: prove shared ecosystem seams before deciding whether any applications should be combined.

Deliverables:

- versioned shared parser/content packages with compatibility tests;
- optional authenticated Community publishing adapter, kept separate from public catalogs—Preview 17 implements the song-library slice; sermons and ServiceProjects remain;
- cross-application deep links and stable content IDs;
- import/export compatibility policy and long-term migrations;
- accessibility, localization, plugin/adapter boundary, and administrator deployment docs; and
- research prototypes for OBS status/control and audio-translation handoff outside the live display core.

Exit gate: each application remains independently installable and useful; public content works without sign-in; authenticated Community and Drive failures are contained; any OBS/AI prototype can be disabled without changing presentation behavior.

## 17. Migration and compatibility

### Existing settings

On first schema-v1 launch:

1. Back up the old `settings.json`.
2. Create a “Migrated setup” Profile.
3. Map Russian → `primary`, English → `secondary`, and Singer → `media/singers` while preserving visible labels.
4. Convert saved display IDs to fingerprints when possible; mark uncertain matches for confirmation.
5. Preserve fade, preview, and Singer typography values under the new Profile.
6. Keep old settings readable for one rollback version.

Migration never deletes source files or cached presentations. Profile export excludes local absolute paths by default and always excludes OAuth/Community/remote secrets.

### Existing caches

- Detect legacy role cache directories read-only.
- Validate them before offering restore.
- Import/link them into a generation-based cache only after successful validation.
- Keep cache keys based on source content hash, converter strategy/version, and render parameters—not editable role names.
- Garbage-collect only unreferenced generations outside a retention window and never while Show is using them.

### Existing PPTX workflow

Browse and convert remains supported in every phase. Native Prepare is additive. A church should be able to adopt Friendly Mode and flexible outputs before adopting libraries or the editor.

## 18. Testing and release gates

### Automated tests

Current Preview 17 sandbox evidence: all 81 JavaScript sources pass syntax checks, and all 520 tests that do not bind a Remote listener pass. The three additional Remote loopback cases cannot bind a local listener because the managed shell returns `EPERM`; they still require a normal-host rerun and do not count as packaged LAN validation. Focused coverage includes Community authentication/synchronization/conflicts, constrained browser/server scene parity, source-audited song intro cards in raster thumbnails and the live DOM, stable title cue IDs, semantic Singer next-line behavior, paint-before-first-frame acknowledgement, rapid-navigation cancellation contracts, package reuse/tamper rejection, the 342-scene July 19 parity fixture, corrected translation families, and catalog-first portable import without duplicate song identities. The Apple Silicon app/ZIP is structurally verified through architecture, signature, packaged-content equality, and ZIP integrity, and an unlocked packaged UI pass covered Load, Admin Settings, Community setup, Prepare, translations, and intro-card rendering. Real LAN/phone, Heritage approval/two-way sync, cross-platform packages, and venue behavior remain separate release gates.

Unit:

- date parsing, timezone/service-date comparison, and folder grouping;
- song/TXT parser, caret escaping, translation-section alignment, stable arrangement identities, and reversible output variants;
- direct song create/edit/translate validation, immutable editor identity, and stale-revision conflicts;
- Bible reference parsing, ambiguity, ranges, translation manifests, and prepared-item snapshot integrity;
- Profile/ServiceSet/ServiceProject schema validation and migrations;
- semantic item edit/deep-duplicate behavior, durable project-history restore, portable-bundle validation, and image-asset integrity;
- preset compatibility plus revision-pinned exact item rendering for every supported cue kind;
- output routing/preflight decisions, including one-deck and missing Media paths;
- display fingerprint matching and collision detection;
- IPC validation and cache path confinement; and
- remote authentication, expiry, rate limits, session IDs, and command idempotence.

Integration:

- PowerPoint strategy success/failure/timeout and LibreOffice fallback on Windows, including the installed-but-running state, visible fallback status, and close-and-retry path;
- isolated concurrent LibreOffice conversions;
- interruption before and during cache publication;
- malformed PPTX/text extraction failure;
- stale-file and mixed-date Start flows;
- Drive/local-folder partial updates and offline placeholders;
- output Start/Stop/Start, Clear/Restore, reconnect, and display removal; and
- publication revision changes before render or before Load installation; and
- Bible overlay/return with remote commands in flight.

End-to-end/visual:

- Electron controller through Load-default Prepare/Load/Show, including direct song authoring, section nesting, semantic item editing/duplicate, arrangement/link/reset, Undo/Redo, portable exchange, exact item preview, and Bible Add-to-service;
- deterministic preset screenshots at 16:9 resolutions;
- the three 114-slide July 19 decks, including blank and shortened Media cues—Preview 14 established the historical renderer-v4 structure/text/selected-frame baseline, Preview 15’s full portable rebuild preserves 71 semantic items, 31 sermon items, 114 cues per output, eight reusable catalog resources, and two output-only resources, and Preview 16 covers the audited full/simple intro-card rules through both thumbnail and DOM renderers; the live-scene packaged-app UI and venue comparison remain;
- one through five simulated outputs with mismatched resolutions/scaling; and
- no stale preview after Clear or source replacement.

### Platform/venue matrix

Windows:

- Windows 10 and 11;
- PowerPoint installed, PowerPoint absent with LibreOffice, and converter absent;
- display scaling at 100%, 125%, and 150%;
- taskbar hover, DWM/Aero Peek, Win+D, Alt+Tab, lock/unlock, sleep/wake;
- projector hot-plug and changed screen order; and
- signed installer upgrade/rollback.

macOS:

- current supported Intel and Apple Silicon versions;
- Spaces/fullscreen behavior, Dock/mission-control interactions, sleep/wake;
- LibreOffice conversion and permissions; and
- signed/notarized build when release infrastructure is ready.

Linux:

- supported X11 and Wayland environments where practical;
- AppImage and deb;
- LibreOffice installed through native package and Flatpak; and
- proof that SyncShow never kills an unrelated LibreOffice process.

### Release gate

A release candidate is promotable only when:

- clean checkout and locked dependency install pass;
- unit, integration, schema migration, and packaging checks pass;
- installers are produced through the documented CI matrix;
- artifact inspection finds no caches, source service files, user OAuth tokens, private service data, `python-embed/`, or unrelated build output; the documented public-client Drive configuration is expected inside official installers;
- old Profile/settings migration and rollback are tested;
- real multi-monitor smoke passes on the target venue hardware;
- Windows PowerPoint and LibreOffice fallback are both exercised for relevant releases;
- stale Media and missing Media preflights are manually verified;
- release notes name schema changes, converter changes, and rollback steps; and
- tags/signatures are created only from the exact tested commit.

## 19. Windows taskbar hover / DWM / Aero Peek

The reported “hovering over the app in the taskbar makes the show look out of focus or hidden” is likely Windows shell/DWM behavior rather than a slide-rendering feature. Do not promise that Electron can override every OS desktop gesture.

Recommended implementation posture:

- output windows are frameless, non-focusable, mouse-ignoring, `skipTaskbar`, shown inactive, and always-on-top;
- the control window remains the only normal taskbar window;
- never call `focus()` on an output after Start;
- do not reintroduce global system-wide arrow/space shortcuts to compensate;
- monitor output visibility/minimize/fullscreen events and report the state, but avoid a focus-stealing polling loop;
- test taskbar thumbnail hover and Aero Peek on actual Windows 10/11 with multiple physical screens; and
- if DWM still temporarily supersedes the output, document the exact OS gesture and evaluate a narrowly scoped Windows-native window-style adjustment.

If Electron-only behavior is insufficient, Windows exposes `DWMWA_DISALLOW_PEEK` for the taskbar window and `DWMWA_EXCLUDED_FROM_PEEK` for output windows through `DwmSetWindowAttribute`; any native shim must be narrow and hardware-tested. See Microsoft’s [DWMWINDOWATTRIBUTE reference](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).

`setContentProtection(true)` is not a general fix: it can interfere with screenshots, operator previews, OBS capture, and support diagnostics. Use it only if a separate privacy/capture-protection requirement is approved. Apply analogous real-device tests to macOS Spaces/Mission Control and Linux desktop shells, but treat each platform separately.

## 20. Branch disposition

Do not merge every remote branch into `main`.

| Ref | Disposition | Reason |
| --- | --- | --- |
| `origin/main` at `159fbf3` / `v1.3.3` | Baseline | Pulled current production line. |
| `origin/preview-fix` at `9f135d0` | Delete after verification | Its patches are equivalent to changes already represented on `main`; it is stale history, not missing work. |
| `origin/remove-python` at `31667e3` | Delete after verification | Its relevant behavior is already merged/obsolete; do not reintroduce its old architecture. |
| `origin/third-output` at `ca859c3` | Do not merge wholesale | It has useful unique behavior in `41801de` and `ca859c3`, but merging produces roughly 15 conflicts and preserves the fixed Russian/English/Singer model. Port the tested behaviors into the new Output model. |
| `origin/copilot/fix-singer-presentation-display-logic` at `e93359b` | Do not merge wholesale | Its dedicated-Singer implementation conflicts with the other branch’s Singer modes and the target role/output model. Use it as behavioral reference only. |
| tags `v1.3.4-beta`, `v1.3.5-beta` | Keep | They preserve historical beta points even after stale branches are removed. |

Recommended cleanup sequence:

1. Finish and test Phase 0 on `codex/syncshow-foundation`.
2. Write acceptance tests for third-output/Singer modes.
3. Port only those behaviors into Profile/InputRole/Output code; do not cherry-pick the old fixed-model UI.
4. Compare the resulting behavior against the beta tags.
5. Merge through review.
6. Delete stale remote branches only after explicit repository-owner confirmation; retain tags.
7. Verify that retired `python-embed/` artifacts are never packaged; handle any maintainer-local pre-pull stash separately from repository history.

## 21. Recommended answers and open decisions

These recommendations let implementation proceed without inventing hidden policy.

| Question | Recommended answer | Still needs owner confirmation? |
| --- | --- | --- |
| What opens on launch? | Load. | No, this is the stated priority. |
| Is Friendly Mode default? | Yes, for new and migrated Profiles after setup is confirmed. | Confirm exact public wording. |
| Is stale content blocked? | Warn and require a one-service confirmation; do not hard-block by default. | Yes, confirm whether any role should be strict. |
| What is the service date? | Explicit ServiceSet date, defaulting to Profile-local today. | No. |
| What happens with one deck? | Start any mapped output; allow mirror/derive across the others. | No, this addresses the stated edge case. |
| Missing Media default? | Show the four-choice preflight; preselect derive-next-text from the primary loaded role. | Confirm what each Profile calls “primary.” |
| Old Media file? | Warn exactly like other used inputs and include it in cross-role date checks. | No. |
| How many outputs? | Zero or more configured; at least one resolvable enabled output to Start. | Confirm a practical UI soft limit, recommended 8 initially. |
| Which previews show? | Singer/Media only by default; per-output toggles in Settings. | No. |
| Google Drive path? | Private folder via OAuth, public view-only link via a restricted API key, or a local synced folder. | Live-test the configured Google project before release. |
| Can a public share link be the whole integration? | Yes for pull-only weekly loading when the folder is truly public; private folders require OAuth. | No. |
| Bible translations? | BSB default; LSV included as the second selectable translation with license metadata. | Confirm preferred visual attribution placement. |
| Bible live behavior? | Stage/preview, Send Live, then Return to exact previous cue. | No. |
| Remote exposure? | LAN-only, off by default, paired and revocable; no cloud relay initially. | Confirm typical venue network and desired remote devices. |
| Song source? | Markdown canonical, TXT import, `^1`/`^2` verse markers, explicit slide breaks. | Confirm whether existing files use any additional caret tokens. |
| Editor scope? | Keep the shipped semantic preset catalog and exact item preview; add only a focused style/preset designer, never a general PowerPoint clone. | Confirm any essential treatment missing from the sample service. |
| Native editor or PPTX export first? | Native deterministic renderer first; PPTX export later if proven necessary. | Yes. |
| Electron upgrade vs. macOS 11? | Done in Preview 13: Electron `43.2.0`, with macOS 12 as the explicit minimum. | No; continue regression-testing supported venue hardware. |
| MuPDF distribution model? | Confirm AGPL-compliant distribution and notices, obtain a commercial license, or replace MuPDF before another binary release. | Yes; this blocks binary release. |
| Heritage integration? | Share protocol/artifacts; keep static Content Servers and authenticated Communities separate. | No. |
| Unified super app now? | No. Build interoperable independent apps and revisit only after the contracts are stable. | No. |

Additional decisions to capture in the first Profile setup interview:

1. The church’s real input-role names and filename patterns.
2. Which role is preferred for Singer next-text derivation.
3. Whether a Profile should opt into skipping blank slides; the safe default deliberately previews blank.
4. Which physical screen is visible from the operator booth.
5. Whether service dates in filenames use month-day-year, day-month-year, or ISO conventions when ambiguous.
6. The expected maximum output count and whether a future same-display compositor is actually needed.
7. The exact song caret tokens already in use.
8. Whether volunteers’ remote devices share a trusted private LAN or a guest network with client isolation.
9. Who owns the Google OAuth project and release credentials.
10. Which library content is public/static versus private/Community-only.

## 22. Completed Phase 1 implementation slices

These slices were delivered incrementally across the early previews and remain useful architectural boundaries. Future work should preserve them rather than folding Prepare, Load, Show, discovery, and venue configuration back into one stateful screen.

### Slice 1A — Make Start resolve real services

1. Add versioned Profile/InputRole/Output/ServiceSet models and migrate current settings.
2. Replace fixed readiness with the generic output-resolution preflight.
3. Implement one-deck Start, mirror/disable choices, and the four missing-Media choices.
4. Block mismatched independently routed legacy decks without guessing alignment.
5. Apply service-date warnings to every used role, including Media.

### Slice 1B — Make the workflow volunteer-friendly

1. Split the UI into Load and Show, with Load opening by default.
2. Add Friendly Mode and the guarded Advanced Settings page.
3. Add named/flexible acyclic outputs, stable monitor matching, and Identify Screens.
4. Move preview choices into Settings and default to Singer only.

### Slice 1C — Discover the weekly files

1. Add local/Google Drive Desktop folder selection and coherent ServiceSet scanning.
2. Show offline-placeholder, syncing, incomplete-date-set, and changed-since-load states.
3. Pin the chosen service locally and preserve manual Browse/Refresh.

These slices solved the highest-risk volunteer workflows first. Later previews added the editor, Bible, LAN Remote, and direct Drive sources on that same role/Profile/ServiceSet model, so each feature extends a stable structure instead of adding more Russian/English/Singer special cases.
