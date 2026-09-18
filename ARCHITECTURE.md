# SyncShow Current Architecture

## Technical Architecture Document

### Overview
SyncShow advances either imported presentations or a native ServiceProject through a persisted venue Profile and an immutable per-service launch plan. The safe default still provides Russian, English, and optional Singer/Media roles, but input/output names, counts, mappings, and previews are configurable. The controller is a real Prepare → Load → Show workflow, with Load remaining the startup default.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ELECTRON MAIN PROCESS                          │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────┐ │
│  │  File Manager   │  │  Slide Navigator │  │   Display Coordinator   │ │
│  │  - PPTX Import  │  │  - Current Index │  │  - Screen Detection     │ │
│  │  - Image Cache  │  │  - History       │  │  - Window Management    │ │
│  └────────┬────────┘  └────────┬─────────┘  └───────────┬─────────────┘ │
│           │                    │                        │               │
│           └────────────────────┼────────────────────────┘               │
│                                │                                         │
│                    ┌───────────▼───────────┐                            │
│                    │    IPC Message Bus    │                            │
│                    │  (Electron IPC)       │                            │
│                    └───────────┬───────────┘                            │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐    ┌───────────────────┐    ┌───────────────────┐
│   Output #1   │    │     Output #2     │    │  Singer / Media   │
│ (named route) │    │   (named route)   │    │  (slide or next)  │
│               │    │                   │    │                   │
│ ┌───────────┐ │    │ ┌───────────────┐ │    │ ┌───────────────┐ │
│ │ Borderless│ │    │ │   Borderless  │ │    │ │   Text Only   │ │
│ │  Window   │ │    │ │    Window     │ │    │ │   Preview     │ │
│ │ (Chromium)│ │    │ │   (Chromium)  │ │    │ │               │ │
│ └───────────┘ │    │ └───────────────┘ │    │ └───────────────┘ │
└───────────────┘    └───────────────────┘    └───────────────────┘
```

---

## Component Details

### 1. PPTX Processor (Node.js)
**Purpose:** Convert PowerPoint files to optimized JPEG images

**Technology Stack:**
- `pptxtojson` for text extraction
- Microsoft PowerPoint automation on Windows when available
- isolated `LibreOffice` CLI conversion on Windows fallback, macOS, and Linux
- shared `pdfjs-dist` + `@napi-rs/canvas` engine for bounded PDF rendering and sermon text extraction
- `sharp` for rendered PNG → JPEG conversion
- `sharp` for image optimization and thumbnails

**Process Flow:**
1. User selects PPTX file
2. PowerPoint (preferred on Windows) or LibreOffice converts PPTX to PDF
3. The shared PDF.js engine renders annotated pages inside the selected target display bounds
4. sharp flattens transparent edge pixels and converts the rendered PNG to JPEG
5. A complete validated generation is published under `slide-cache/{language}` with files named `slide_{number:03d}.jpg`
6. PDF renderer ID/version provenance and text extracted via pptxtojson are stored in validated metadata

**Performance Considerations:**
- Pre-render all slides during import (no runtime conversion)
- Cache images at target display resolution
- Use JPEG quality 92% for slides, 85% for thumbnails
- Generate thumbnails (300px width) for control panel

### 2. Display Engine (Electron)
**Purpose:** Render legacy PowerPoint slides and native semantic cues on multiple screens with low-latency transitions

**Approach: Borderless Electron Windows with Hardware Acceleration**
- Create frameless BrowserWindows positioned on each display
- Keep imported PowerPoint on the verified full-size JPEG path and preload next/previous images
- Render native cues as constrained HTML/CSS DOM scenes in hidden double buffers; no generated HTML, arbitrary CSS, or source paths enter the scene contract
- Load the bundled Noto Sans font, decode local package images, complete layout/overflow checks, and acknowledge readiness before reveal
- Use `will-change: transform` and GPU compositing for both paths
- Synchronize via IPC with timestamp validation

**Key Features:**
- Low-latency image transitions for imported decks and resolution-independent text/picture output for native services
- Fullscreen borderless windows
- Black background for clean display
- Hardware-accelerated rendering

### 2A. Native Prepare and ShowPackage Pipeline
**Purpose:** Build common text/image services without making PowerPoint the internal document model

**Artifacts:**

1. `ServiceProject` is the editable semantic tree. A normal project owns profile-derived portable channels, ordered groups/items, stable song arrangements, explicit per-channel song variants (exact content, inherit, current-plus-next derivation, or Hidden), per-channel canonical Bible snapshots, content-addressed pictures, and—after reviewed weekly sermon intake—an exact `sourceServiceSet` ID/fingerprint/date/profile binding. Generated sermon readings use an additive provenance union: historical cues retain their exact single `translationId`, while new local cues carry one ordered BSB/LSV/Hidden treatment for every project channel and at least one visible translation. A `workflowMode: "pptx-companion"` project is a deliberately nonprojected variant: it requires that exact binding and exactly one top-level Sermon anchor, and may contain only sermon resources, never additional items, leaf cues, or assets.
2. `compileServiceProject()` produces an immutable `CueTimeline`. Deterministic Cue IDs come from project ID, item ID, and stable leaf identity rather than title or position.
3. `ShowPackagePublisher` compiles every mapped channel at equal cue length into a content-addressed immutable package with checksummed constrained scene JSON, raster thumbnails, pinned picture assets, metadata, font identity, timeline, and one canonical `handoff.json`. The handoff checksum participates in package identity; verification cross-checks its exact project revision, content hash, readiness, cue order, and semantic cue records against the manifest and compiled timeline. Native packages do not contain full-size slide JPEGs.
4. Load installs only the verified package’s presentation records into the existing launch resolver. Main exposes one handoff only when every installed native presentation agrees on the same revalidated record. Show never reads a mutable project, library file, picker path, or network source.

**Persistence and trust boundary:**

- Project and song saves use immutable revisions, compare-and-swap pointers, atomic replacement, owner-only directories, last-good recovery, and no-follow reads. Prepare mutations require the exact expected project revision.
- The native **New service** command atomically attaches explicit schema-v4 `local-created` planning metadata before revision 1 is published. Its required venue-local start time and optional team notes therefore enter the same readiness/status/handoff path as a carried plan without manufacturing template or Community provenance. Ordinary domain creation remains unplanned for backward compatibility, Community imports still attach only schemas 2/3, and PowerPoint companions cannot opt into this local planning origin.
- `Plan next service` derives a new project only from one checksum-valid exact current native revision. It carries reusable structure, songs, notices, pictures, and imported decks; independently re-copies retained assets through verified no-follow reads; and removes the prior sermon occurrence, generated sermon reading, private packet/resources, post-service links, source-service binding, and unreachable files. The new project records exact source-project/revision provenance. Its `planning` status advances explicitly through `planning`, `ready`, `completed`, or `needs-follow-up`; `ready` is editorial metadata only and never compiles, publishes, or installs a ShowPackage.
- Native service timing is an optional canonical `plannedDurationSeconds` on each semantic item: absence is untimed and zero is intentional. The derived schema-v1 run sheet uses venue-local date/time arithmetic with explicit day offsets and persists no calculated clocks. A timed group owns its outer slot; descendant durations describe its internal breakdown without contributing twice. An untimed group derives only when every child is known, and explicit group budgets report remaining time or overruns. Timing survives portable exchange, Plan Next, and in-place song replacement. Community reconciliation treats it as local presentation state and excludes it from Community-owned state hashes.
- `planning.serving` is a strict local schema-v1 assignment list with bounded role, display name, service/item scope, status, required flag, optional local call time, and note. Contact fields, directory identifiers, and Community accounts are outside the contract. Item deletion prunes invalid scopes, identity replacement rebinds reviewed scopes, and Plan Next clears people instead of silently assigning last week’s team. Serving edits use an exact project compare-and-swap and never write Community or Remote.
- A planned project's readiness is a deterministic report derived from the exact normalized project and compiled timeline. Fixed checks cover nonempty compilation, song presence, exact sermon ownership, projected sermon material, an exact linked reading before that material, and visible per-channel coverage. Generated-reading chunks qualify only when their complete effective output plan agrees, so mixed translation/hidden plans cannot combine into false readiness. Only non-compilation checks can carry bounded human-reason waivers; projected-content mutations clear them, and changing a waiver decision reopens a `ready` plan to `planning` until that exact candidate is confirmed again. Main re-derives and enforces the report for the `ready` transition and again before publishing a planned service.
- Handoff schema v2 adds the fully derived run sheet, sanitized serving assignments, and each cue’s canonical ancestor-item path to the exact checksummed package. Main derives these only from the normalized project and validates their project/revision/date/start-time, arithmetic, hierarchy, and cue bindings on publish and install; the renderer validates them again. Schema-v1 handoffs keep their exact old fields and canonical bytes. Load shows the concise runtime/finish/team brief, while Show resolves item- and group-scoped responsibility plus scheduled moment metadata without a live countdown. Operator notes, team notes, run-sheet data, and people remain local control-room state and never enter audience scenes or the allow-listed Remote protocol. Ending Show closes the output session before any post-service prompt appears. Completed/Needs-follow-up writes use the package's exact project revision as a compare-and-swap guard, and the sermon shortcut opens the current project only after validating that it is still that exact revision; neither action publishes to Community.
- A successful **Save & go to Load** atomically activates one path-free current-package pointer containing the package ID and raw manifest SHA-256, exact project revision and service date, prepared-service deck-role-contract digest, and unique activation ID. The deck-role contract covers the profile ID plus enabled deck-role IDs, order, and labels; unrelated output routing does not invalidate a prepared service. A receipt retains the previous pointer so a failed final validation or stale long-running publish can compare-and-swap back to the previous selection without clearing a newer activation; a post-rename durability error is reconciled against the visible pointer before failure is reported. On startup, main loads the venue profile first, opens the immutable package through complete checksum/artifact/scene/semantic-metadata/handoff and current-font verification, requires the pointer's manifest SHA-256, deck-role contract, and exact enabled/presentation role sets, then replaces the installed native presentation map before creating the control window. Main repeats that verification immediately before Start, and a committed profile change to the deck-role contract invalidates the installed service. Corrupt or incompatible evidence fails closed without deleting it; an intentional republish may quarantine a safe corrupt package directory and regenerate the same semantic package. Explicit PowerPoint conversion or cache restoration clears both the pointer and installed native roles before installing the PowerPoint replacement.
- Reviewed sermon-slide reconciliation accepts an empty or populated selected Sermon, Section, Point, or Subpoint group that resolves to an exact revision inherited from a semantic whole-sermon resource owner. Proposal v3 binds the selected group kind, resource owner, direct/effective outline section and section owner, ordered direct children, and fingerprinted eligible direct sermon cues; a null cue override means inherit the selected group, not necessarily whole sermon. Main maps explicit output/source IDs to immutable complete PowerPoint extraction snapshots and holds the path-free proposal behind an expiring token. Every relative-position row requires an explicit Insert/Update/Skip decision; Update requires one explicit, unreused direct-child target. Changed rows in a populated selected group require an explicit block placement; an empty group has only position zero, while bulk use-all is restricted to the empty whole-sermon owner. Selected source units remain byte-exact and cannot be reused in one output. Apply rechecks all bindings and snapshots, then performs one project compare-and-swap: inserted and selected updated cues form the reviewed row-ordered block inside that exact group, while outer order, sibling and nested subtrees, and unselected children keep identity, content, hierarchy, and relative order. Updating preserves the stable item ID, title, preset, operator notes, creation time, and unmapped output text/titles/spans while replacing mapped text, clearing unreviewed stale mapped titles, and applying the reviewed direct section override; an explicitly unpaired mapped output is cleared. Main retains a successful reply behind the same token and returns it only for an exact apply-intent retry; durable restart/eviction recovery remains separate. Trusted versioned extraction spans preserve direct source gold/bold runs; renderer input cannot manufacture styling. To reconcile a nested branch, the operator selects that group itself; one review never flattens a subtree or crosses group boundaries. Manuscript/body, source records, references, publication, and Community state are outside this mutation.
- Main owns a zero-authority inspect call for the current PowerPoint companion. It re-verifies the pinned ServiceSet, requires the active profile, and returns path-free labels plus an expiring opaque inspection token. Open accepts only that token, re-verifies the set again, and fails if its ID/fingerprint/date/profile changed. It looks up only the exact binding, rejects duplicates, and creates the complete one-anchor companion in one initial revision.
- The companion is not a second presentation model. Domain normalization rejects structural drift, non-sermon resources, projected leaves, and assets; compilation plus portable import/export fail closed; main rejects unrelated sermon linking, native reading insertion, export, and publication; and Prepare hides, disables, or locks the corresponding controls including drag/reorder. Load/Show continue using the original verified PowerPoints.
- A new companion opens packet review only while its Sermon anchor is unlinked. Reopening a linked companion validates its exact sermon resource before changing renderer state, refreshes its local/Community inspection, and resumes at post-service links. Renderer and main-process guards reject a second packet, and delayed focus rechecks the same project revision, anchor, resource, and sermon revision before moving the operator.
- Current-service song capture is a read-only derivative of the verified `ServiceSet`, not whole-deck ingestion or a project mutation. Main no-follow reads one pinned PPTX and requires the expected role, size, and SHA-256. Inspection and build execute in dedicated resource-limited workers with bounded source/options, concurrency, memory/stack, and deadline. Before JSZip constructs package-part objects, the core validates the ordinary ZIP end record and central directory, rejects multi-disk and ZIP64 input, bounds the declared directory and entry count, and then streams required XML through per-part and cumulative decompression limits.
- Inspection returns path-free complete bounded canonical text for `all`, direct `#FFFFFF`, and direct `#FFFF00` lanes behind a 15-minute proposal. An exact template-local detector may additionally propose a lyric range when one title-placeholder shape is followed by a bounded run of the expected lyric text-box shape. It exposes the exact title slide and structural evidence but does not classify title-card lines or claim general song recognition. Suggestions remain advisory; the renderer may instead submit another reviewed consecutive 1–200-slide range.
- The renderer seeds the range with one default `all`/`white`/`yellow` lane, then records one explicit lane choice for every slide. Colors are source-style selectors, never language identifiers, and may switch languages within one song. Confirmed build revalidates the exact set binding and source bytes, consumes its proposal on success or failure, and reacquires exact evidence before a retry. Each selected slide becomes one provisional `P1`/`P2` section; an empty chosen lane or any SongDocument normalization of the extracted lines fails closed.
- The result remains a proposal until the operator completes the second review. That review shows every captured occurrence and retained title evidence, requires an explicit new/repeat/exclude decision for each occurrence, preserves the exact create/update/retain consequences for the original and optional translation, and records separate per-language local-service rights evidence. Changing any decision, metadata, or rights evidence invalidates the source, rights, and local-only save confirmations.
- Confirmed save revalidates the exact ServiceSet and source bytes, preflights the prospective complete family and receipt capacity, then uses one recovery-journal-backed transaction to preserve uncaptured translations while atomically advancing every reviewed SongDocument. Immutable evidence binds the source ranges, lanes, captured text/title evidence, identity consequences, rights review, and all three confirmations; exact retry and restart recovery are idempotent. PowerPoint, the ServiceProject, and Community remain unchanged. Semantic labels, corrections, credits, or permissions are never inferred, and member visibility, anonymous links, or Community publication require a separate exact-family review.
- Publish verifies that revision before rendering and again before installing the finished package into Load. A safely completed package may remain cached after a conflict, but cannot replace a newer draft.
- The renderer receives semantic records only. Native pickers, absolute source/storage paths, song-library content, Bible verse text, and attribution remain in the trusted main process; the preload bridge exposes narrow intent-based mutation methods.
- Song output treatments name the exact target and source channels; main and
  the domain reject self-reference, cycles, and unknown channels. Channel
  labels never select behavior. Add-Bible requests contain exactly one
  BSB/LSV/Hidden row for every project channel; main resolves every visible
  translation against one canonical range before pinning any text. New
  generated-sermon-reading requests use that same dense treatment shape. Main
  resolves every visible passage, and the compiler verifies the ordered source
  provenance against the actual translated/hidden cue channels. The legacy
  single-translation reading form remains an exact readable canonical union
  member rather than being rewritten during normalization.
- PNG, JPEG, and WebP imports are checked by magic bytes, size, decoded format, dimensions, animation count, EXIF orientation, pixel budget, and SHA-256 before publication.
- Publish-time thumbnails use the bundled OFL Noto Sans font and escaped Pango markup. Live native output loads that same bundled font and builds only allow-listed DOM nodes with text nodes and bounded scene tokens, so operator text remains literal and English/Cyrillic output does not depend on fonts installed at the venue.
- Scene JSON, copied picture assets, thumbnails, metadata, timeline, and the package manifest are size-bounded and checksum-verified before Load exposes them. The output window stages font/image/layout work while hidden, reports frame readiness, and only then participates in the shared reveal deadline.

### 3. Control Panel (Electron Renderer)
**Purpose:** Provide operator interface for slide management

**Features:**
- Grid view of thumbnails for the configured/selected outputs
- Current slide highlight with border
- Scrollable grid of all slide thumbnails
- Click-to-jump navigation
- Keyboard shortcuts (Arrow keys, Space, Home, End)
- Display assignment dropdowns
- Persisted venue Profile editing with custom role/output names and counts
- Current-output previews selected per output, with Singer/Media open by default
- Staged live-Bible lookup, ambiguity selection, preview, targets, Send Live, and Return
- Explicitly enabled LAN Remote pairing/status controls; pairing authority never enters the phone-facing renderer
- A three-column Prepare workspace for saved service projects, nested rundown sections, arranged songs, explicit exact/follow/current-plus-next/Hidden song treatments, per-output BSB/LSV/Hidden passages, and the local song library, while Load remains the default startup stage

### 4. Synchronization Strategy
**Current slide behavior:** Output windows receive the same slide command and optional future reveal timestamp. Slide navigation is best-effort coordination, not a measured frame-accurate barrier. Initial output frames and temporary Bible overlays use explicit renderer acknowledgements before all windows are revealed.

**Implementation:**
1. Control panel sends `GOTO_SLIDE` message with slide number and timestamp
2. Both display windows receive message simultaneously via IPC
3. Images already preloaded in memory
4. CSS opacity transition (instant, no animation delay)
5. `requestAnimationFrame` applies each window's reveal after its image is ready

### 5. ServiceSet Discovery and Offline Pinning
**Purpose:** Load one coherent weekly service from a local folder, a desktop-synced folder, a private Google Drive folder, or a public view-only Drive link without making Show depend on the network

**Boundary:**
- The renderer can request a scan, but cannot submit arbitrary filesystem paths, Drive IDs, API keys, OAuth tokens, or download URLs. The main process scans only the source committed in the validated venue Profile.
- Native picker grants, opaque Drive connection IDs, and profile-bound scan tokens authorize source changes and snapshot publication.
- Private Drive selection uses Google’s system-browser Picker with PKCE, state validation, a loopback-only callback, and the narrow `drive.file` scope. Refresh tokens are stored only through operating-system protected storage; short-lived access tokens remain in main-process memory.
- Public Drive links are parsed as pull-only folder identifiers and enumerated with the build’s Drive-API-restricted key. They never gain private-account or write authority.
- Resolver candidates are grouped by semantic filename/folder date before roles are selected, so files from different dates are never silently combined.
- Local PowerPoints are copied through no-follow handles and checked for source replacement. Remote files are downloaded into staging, checked against the selected Drive metadata/version, and never trusted by filename alone. Both paths are hashed and atomically published under the Electron user-data `service-sets` directory.
- Pinned files are integrity-verified before their paths are granted to the converter. Folder watcher events are only debounced rescan hints and never mutate an active Show.

Once a ServiceSet is pinned, conversion and Show use only its verified local snapshot. Drive availability, account state, and network latency are therefore outside the live presentation path.

### 6. Heritage Community Libraries

**Purpose:** Keep local song and sermon work offline-capable while optionally exchanging bounded church-library resources with an authenticated Heritage Community, without making Load or Show depend on that server

**Boundary:**

- Discovery is pinned to one HTTPS origin and one versioned
  `/api/community/syncshow/v1` namespace. Protocol v1 keeps its root song
  contract and is normalized internally as `resources.songs`. Protocol v2
  advertises `resources.songs` and `resources.sermons` independently and may
  add `resources.songPublicLinks` only beside a real song lane. Song or sermon
  may be omitted, but at least one supported lane is required.
- Device authorization remains shared infrastructure: protocol v2 requires
  `deviceAuthorization: true` and the start/status/token/cancel/revoke
  operations. The normalized offered scope set is the union of advertised
  lanes. Song and sermon endpoints are pinned independently and cannot
  redirect, cross origins, or escape the advertised API base.
- A manager approves a named installation through device-secret + PKCE authorization. The renderer receives only the public approval page/code and sanitized connection summary; opaque access credentials stay in the Electron main process and are encrypted with `safeStorage`.
- Existing protocol-v1 song-only grants remain limited to song read/write scopes. A newly advertised sermon or public-song-link lane requires explicit approval for its additional scopes; no lane is inferred from another. Public-link read requires song read; public-link write requires link read plus song read but deliberately does not imply song write. A compatible Heritage server must recheck current owner/admin/leader membership on every request, and SyncShow enters an explicit reconnect state after revocation, role loss, or expiry.
- Local `SongDocument` revisions remain authoritative offline. Complete original/translation families move as bounded, checksum-verified source documents; server updates require exact ETag compare-and-swap versions.
- Local song save and Community member access are separate commands. Private admin staging may continue without a rights review; every member-visible create, promotion, scheduled write, changed-content upload, and keep-local resolution requires a current review of the exact original/translation family.
- The main process enumerates the whole saved family and computes its canonical revision. The renderer receives a bounded display manifest plus a short-lived opaque proposal, but never supplies the authoritative family ID/revision, review time, or remote compare-and-swap version. Apply re-enumerates the family before recording the review or writing remotely.
- Sync state is a sidecar under Electron user data. It records the remote cursor, family mapping, visibility, scheduled publication, tombstones, preserved conflict sources, and a separate store-owned `songSharingReviews[localFamilyId]` lane without changing immutable local song documents. Whole-state sync checkpoints preserve that latest audit lane and cannot mint, erase, or resurrect a review; replacing or clearing a review uses an exact digest compare-and-swap so a same-family concurrent confirmation cannot be silently overwritten.
- Any original/translation add, removal, reparent, document revision, or rights/credit metadata edit changes the canonical family revision and makes the prior review stale. A review-again date remains inclusive through the end of that calendar day on the SyncShow computer; expiry and a scheduled publication beyond that date block later member-visible writes but do not claim to unpublish an already-visible server revision. Public-domain, church-owned/authorized, specific license coverage, direct permission, and other reviewed bases remain explicit; CCLI/SongSelect identifiers are never inferred as blanket permission.
- Anonymous song links are not a song visibility value. They have independent read/write scopes and a separate store-owned `songPublicLinkReviews[localFamilyId]` audit lane fixed to `public-link`; a member review cannot migrate into it. Every anonymous basis requires explicit evidence, including public-domain and church-owned work. A dated review requires a finite link expiry within its validity window.
- Main lists, creates, copies, and revokes links only through opaque renderer actions. The management endpoint is API-pinned, the advertised public base is same-origin HTTPS, and the client derives an active link URL from the validated base plus a high-entropy server ID. Create re-enumerates the local family, fetches and parses the exact live Community family, rechecks the song ETag and review digest, and requires a main-owned idempotency key. Revoke reuses neither the renderer URL nor renderer CAS values and reports success only after an advanced server tombstone. Neither create nor revoke is queued offline.
- A create whose POST outcome is unconfirmed retains one 15-minute recovery proposal containing the canonical intent, confirmed review/digest, exact song version, and original main-owned idempotency key. The renderer locks the reviewed fields and retries that exact operation; a list refresh does not replace it with a new key. Definitive failures and confirmed success consume the proposal. Link pages reject duplicate IDs within or across the four-page/200-record desktop bound.
- Each public link pins one immutable original/translation snapshot. Existing links remain listable and revocable during a song-content conflict and show an older-version warning after local edits; creating another link is blocked until local and Community families match exactly. Withdrawing the lane clears protected in-session actions but leaves local songs and reviews intact and warns that existing server links may remain active.
- Withdrawing link-read capability immediately publishes a status update after clearing proposals/actions. A 401, 403, or 410 from link management enters reconnect-required state; the renderer then purges displayed bearer URLs and opaque actions and closes the link dialog. A normal retryable network failure may retain the last confirmed rows with a stale-state warning because it does not prove that current authority was revoked.
- Public-to-private changed-content sync is deliberately two-step: demote visibility with one CAS write, verify the server actually returned private access, checkpoint it, then upload the unreviewed documents privately. An operator may make that visibility-only demotion while preserving both sides of a content conflict. A conflict may separately accept an exact-family rights review without changing either copy, after which the guarded keep-local choice rechecks both the current family revision and remote version.
- Read-only Community approvals still pull permitted remote song changes and may deliberately keep a readable Community conflict copy locally, but the synchronization core skips every create, update, demotion, and keep-local write rather than relying on a server rejection as the write boundary. Cached protected remote conflict/status projections remain unavailable after expiry/revocation/reconnect state or without the current resource-read capability; locally saved song and sermon revisions remain usable.
- A remote tombstone never deletes local content. A two-sided edit, ambiguous or duplicate match, missing translation/family, metadata-only content loss, invalid source, cursor rollback/replay, or stale compare-and-swap becomes a guarded error or reviewable conflict instead of an overwrite. Remote mutation responses must echo the expected identity, advancing version, visibility, and exact document family. Resolution rechecks the current local family hash and current server version before keeping either copy.
- Community **member-visible** means visible to signed-in members of the configured church. Private and future scheduled songs remain manager-only. Revocable bearer links and the static Content Server are separate scopes, protocols, and trust boundaries. The server/anonymous reader half of the public-link contract exists only in the isolated Heritage integration worktree and is not merged or deployed.
- Service-plan intake remains a main-owned, Community-read-only boundary. Review may issue one import authority only for an exact Ready envelope whose local dependencies resolve. When a complete, non-truncated review has no more than 100 blockers and every blocker is an eligible exact song or sermon that is locally absent or older than the plan requires, it may instead issue a distinct opaque preparation authority bound to the connection, server, profile, full plan envelope, and deduplicated dependency vector. Explicit preparation refreshes capabilities, re-fetches/re-reviews the plan, point-GETs only those exact records with version-and-revision preconditions and identity-only local matching, preserves conflicts, may update only the exact local libraries, and leaves feed cursors, whole-lane sync times, and Community state unchanged. It checkpoints safe partial progress, then re-fetches the plan and returns a wholly fresh review. A newer/inconsistent local or live server pin becomes a non-preparable stale-plan blocker until a Community manager refreshes the Ready plan. Retry resumes only an unresolved exact subset; any new, altered, or re-pinned dependency returns a fresh review without another pull. A token-bound cancel is registered before queued discovery and aborts the current sequence without discarding prior checkpoints. Preparation never imports or opens a project, enters Load, starts Show, publishes, broadens scopes, or follows a renderer-supplied identifier.
- Every fresh Community import binds a portable baseline-v2 projection containing stable entry/item identities, output-channel contract, container topology, and separate title/content-spec/relationship/dependent-state hashes. A newer Ready revision is reconciled as BASE/local/Community, never by title or fuzzy content. Compatible local-only items and presentation state survive; remote-only work applies; same-component edits, delete-versus-edit, incompatible placement/order, kind changes, and locally worked song/sermon pin changes become bounded explicit choices. Nested subtree choices cannot be overridden by ancestor deletion, section-to-leaf changes lift retained local descendants, and independently valid moves that compose into a cycle become one whole-structure choice. New stable-ID collisions bind item bodies, existence, parents, complete subtrees, and sibling order to the same explicit source choice; a shared identity that crosses the collision boundary fails closed instead of being deleted, lifted, or hybridized. Same-sermon pins use a non-overlapping resource-global atomic repin across duplicate owners/readings and reject chains/swaps; genuinely different sermons use a scoped replacement and clear stale source-body receipts when chosen. Apply re-fetches, repeats the review, verifies exact reconciliation hashes, requires every ordered decision, and compare-and-swap saves only the Planning project. Candidate-unreachable records are pruned without touching unrelated local resources. The result stores a strict checksummed receipt with the actual decision result; that receipt is excluded from the semantic merge hash. Schema-v2 projects and schema-v3 projects with baseline v1 use a separately confirmed legacy whole-replacement fallback. Neither path changes Load, Show, a ShowPackage, or Community.
- A kept-local stable-ID group collision persists as a bounded sorted local boundary. A later Community item, placement, or subtree change reopens the same complete source choice; choosing Community or a remote disappearance clears it. When cycle prevention couples several choices, the combined conflict still discloses collision content, side-only descendants, and any subtree restoration it controls. Normal local subtree deletion prunes these markers with the removed items. The boundary is local project state and is never uploaded as Community plan content.

**Sermon packet and Community client foundation:**

- Canonical `SermonDocument` v1, v2, and v3, canonical `BibleRangeV1` values, immutable local revisions, content-addressed private source files, restart-safe reviewed extraction evidence, and exact ServiceProject sermon pins are implemented under `src/services/sermon/`. V1/v2 canonical bytes and hashes remain exact; an edit explicitly upgrades to v3 rather than silently reserializing history. V3 adds ordered reviewed body entries with source, language, optional outline-section provenance, and bounded complete text.
- Weekly service-source intake is a main-process-owned proposal/commit operation. The proposal enumerates only verified PPTX inputs in the current `ServiceSet`, opens the single manuscript picker, enforces the project's exact service date and profile, and gives the renderer a path-free 15-minute review of original filenames, languages, byte sizes, and checksums.
- Commit re-reads the expected project revision, re-fingerprints the same set, and re-hashes the manuscript before copying any reviewed sources. Its first successful transaction durably binds the project to that exact `sourceServiceSet`; another set—even with the same date and profile—is a conflict, not an implicit rebind.
- The default weekly reading mode is `already-in-service`, which preserves the deck's existing congregational-reading slides without generating duplicate Bible cues. `insert-native` explicitly adds the confirmed range in BSB. Source-less packet creation remains a separate legacy fallback.
- Native packet creation and linked-sermon reading repair can instead carry one explicit BSB/LSV/Hidden choice per local project channel. Community service-plan schema v2 intentionally remains a portable single planning translation: venue/output settings, complete ServiceProjects, resolved verse text, and ShowPackages stay local and are never uploaded.
- Presentations and the manuscript are copied, never moved, into the private content-addressed store. Their original names and reviewed/inferred languages remain source metadata; no slide, wording, or layout is rewritten. Only after all imports verify does the existing recovery-journal-backed sermon/project transaction publish the packet, exact pin, optional reading, and set binding.
- Source copying does not imply extraction, post-service readiness, media processing, Community push, or public projection. A pre-transaction failure leaves sermon and project pointers unchanged, although already imported content-addressed objects can remain privately unreferenced until a safe reference-aware garbage collector is implemented.
- Source attachment and reviewed extraction advance every direct sermon owner plus generated-reading provenance as one project mutation. Generated readings move only when the same confirmed-primary reference ID and canonical range remain valid; missing linked outline sections or changed reading passages fail the mutation before the local sermon pointer advances.
- `LocalSermonExtractionStore` persists each normalized full extraction as an immutable, private, content-addressed, path-free snapshot. Its exact binding includes the stable sermon and base revision, source ID/hash/kind, and extractor ID/version, so a changed source, sermon base, or tool cannot silently reuse older evidence.
- Review receipts are persisted only after the recovery-journal-backed sermon/project commit succeeds. Each receipt retains the resulting sermon and project revisions, selected suggestion IDs, and review time; an exact reverse index by resulting sermon revision, project identity, and source identity/hash lets Prepare reopen the matching evidence after restart. Reopened suggestions still begin unchecked because a receipt is review evidence, not durable checkbox state.
- A receipt-write failure cannot roll back or misreport the already-successful canonical sermon/project commit. Prepare returns that success with a warning; a process interruption in the narrow post-commit/pre-receipt gap is treated as unreviewed on restart. Snapshots and receipts never rewrite projected cues, upload to Community, or imply publication.
- Reviewed canonical body intake is a second explicit proposal/commit boundary. It accepts only an exact saved extraction of a complete, untruncated, whole-source `manuscript` or `transcript`, builds its default from the ordered full units rather than the bounded preview, and requires the operator to inspect and confirm the entry. Applying the review creates a v3 revision; a `ready` or `published` sermon returns to `draft` with `publishedAt` cleared while visibility and canonical URL remain unchanged.
- The body commit uses the same recovery-journal-backed sermon/project coordinator to re-pin the exact sermon resource. The pinned v3 body is therefore available to packet, portable-service, and Community serialization, but existing service cue text is not regenerated or rewritten. In particular, a `pptx-companion` remains group/resource-only and the original source-faithful PowerPoints remain the only Load/Show presentation.
- Native canonical-body projection is a separate project-only review boundary. After an explicit body-entry mapping, every changed row chooses a closed per-output union: exact canonical paragraph, human-authored condensed service text bound to one exact paragraph, or Hidden. SyncShow never generates the condensed wording, translates, or aligns languages. Exact-only rows retain the historical schema-v1 receipt bytes. Any condensed row records schema-v2 evidence for the immutable body entry and paragraph plus both source-text and projected-text hashes; compilation marks only that channel `condensed` and never invents a `sourceChannelId`. Normal focused edits preserve evidence for byte-identical channels, upgrade retained legacy evidence when only part of a cue changes, and discard evidence only for changed/removed channels. The canonical sermon, Community record, source objects, and already-published ShowPackages remain unchanged.
- A staged sermon/project commit saves the exact project pin before moving the local current pointer. Portable service hydration installs a missing exact sermon but never overwrites a different local revision.
- Prepare's post-service handoff distinguishes canonical human-reviewed v3 sermon body from optional durable HTTPS destinations for the sermon page, recording, and external notes/transcript. Ready requires a confirmed primary passage, an available recording, and revisit content supplied by either reviewed canonical body, the page, or an available external text link; an attachment or extraction alone never counts as reviewed body. It records link `Waiting`/`Available` without fetching a URL, saves only a local draft or explicit Ready revision, preserves visibility, and never claims publication. Community save remains explicit, and public body/media selection plus publication remain manager-owned. A metadata-only repin updates compatible generated-reading provenance with the exact sermon owner so unchanged pre-sermon readings do not become stale.
- Exact verified local recording review is a separate Main-owned read boundary. Main re-resolves the current ServiceProject revision, inherited sermon owner/revision, and stable managed recording slot; opens the content-addressed object only after complete structure, size, and SHA-256 verification; and serves bounded byte ranges through a least-privilege custom protocol to a sandboxed audio/video window. The control renderer supplies only project/revision/item intent and receives only the exact path-free result binding—never the object path, store identity, bearer token, or playback URL. One serialized session may exist at a time, expires after at most two hours, and is revoked on replacement, close, crash, unresponsive control/player, suspend, Show start, Stop, or app quit. This grants no upload, Community, or publication authority.
- `deriveSermonServiceRelationship()` and `ServiceProjectStore.listSermonServiceRelationships()` provide a bounded read-only **Used in services** projection. They scan checksum-valid current project revisions, deduplicate direct and inherited links into one relationship per sermon/project, retain every unusual mixed exact pin, and expose only service metadata plus an exact PowerPoint set binding. The index skips recovered fallback revisions so a damaged current revision cannot resurrect an older relationship. Opening a row validates the current project revision, sermon identity, exact pin, and resolvable resource-owner anchor before replacing the operator's open workspace; unreadable project evidence is preserved without mutation.
- `CommunityClient` normalizes protocol-v1 root song discovery and validates
  protocol-v2 song/sermon resource lanes independently.
  `CommunitySermonWire`, `CommunitySermonSync`, and the migrated Community
  stores maintain a sermon cursor separately from the song cursor.
- Sermon synchronization is deliberate: manual pull may hydrate or fast-forward a clean baseline, while push creates or updates one explicitly selected exact revision with compare-and-swap. There is no background upload of every local draft. A v3 body enters the wire only as part of that separate explicit sermon save.
- Canonical synchronization transfers the exact v1/v2/v3 document, including ordered reviewed v3 body text and source descriptors, but not PDF, DOCX, PPTX, TXT, or Markdown source bytes; those remain in the private local source store.
- If local and remote both moved from the observed baseline, including body-only divergence, SyncShow preserves both exact canonical sources and records a guarded conflict for review instead of choosing a winner.
- Sermon conflict review exposes the complete ordered body text, kind, and language for both revisions while keeping source paths, bytes, and raw body identifiers private. A session-keyed metadata marker makes entry/source/outline-binding-only differences reviewable without disclosing those identifiers. It also shows bounded, non-clickable origin/path summaries and session-keyed fingerprints for canonical/media links. Query values, private source details, file names, hashes, and provenance remain outside the review IPC while query-only link differences remain distinguishable.
- `SermonPublicProjection` is a pure, strict compatibility boundary for public Content Server output. Given one exact eligible public `SermonDocument` revision and explicit selected body/media IDs, it emits bounded Heritage v2 catalog, detail, and confirmed passage-index records with canonical checksums and stable public IDs. The parser/fixture path verifies exact revisions and cross-record checksums, suppresses mentioned duplicates already covered by primary ranges, and rejects private, noncanonical, mixed, or drifted input. It has no database, authentication, publication, or network authority.
- `CommunitySermonPublicationConformance` binds that projection to one normalized read-only Community publication state. It reprojects the exact immutable public source, requires document-order selections, verifies identity/revision/time and detail bytes, verifies the target catalog row, and requires the complete passage index to be the deterministic derivative of the complete catalog snapshot. It deliberately permits `currentRevision !== publicRevision` and exposes no network, IPC, persistence, publish, or withdraw operation. The self-contained fixture in `test/fixtures/community-sermon-publication-conformance-v1.json` is the portable Heritage server/reader parity vector.
- `CommunitySermonPublicationTransactionConformance` is a stricter pure parity gate for an **active republish**, not first publication. It binds the exact prior Published document and authenticated global catalog/index generation, the different current Ready revision, every compare-and-swap field, a genuinely new Published revision at a later server time, one-step version advances, exact selected content, and target-only replacement while preserving unrelated global rows. First publication requires a separate authenticated-global-generation gate; neither verifier performs authorization, storage, or publication.

**Deployment boundary:**

- The canonical mutable integration target is the direct authenticated Heritage
  Community API, not PagesDB or another static publisher. Static services are
  public projections only.
- The audited Heritage server already has its Community discovery route, a
  manual Payload sermon collection/admin path, a public published-sermon
  catalog/detail path, and generic Heritage Resources viewing. It does not yet
  advertise or implement SyncShow device grants/scopes, dedicated song or
  sermon endpoints, canonical sermon revisions, cursor/change journal,
  compare-and-swap, or idempotency. The sermon client therefore reports
  unsupported against that implementation; local/client tests are not an
  authenticated round-trip.
- SyncShow's pure v2 projection, publication-state conformance verifier, and
  self-contained fixture define the strict public bytes and their exact
  authenticated pointer receipt, but
  Heritage still needs separate `currentRevision`/`publicRevision` pointers, an
  authenticated atomic publication transaction, persisted confirmed passage
  rows, catalog/detail/index endpoints, and the Study Bible **On this
  passage**/**Appears in** commentary-sidebar UI. Generic legacy resource
  viewing is not the canonical passage-linked viewer. The Heritage transaction
  must explicitly select eligible reviewed v3 body/media entries and port the
  compatibility contract rather than treating every synchronized body as
  public. No private source-byte endpoint is part of the first round-trip.
- The exact server and reader sequence is maintained in `docs/HERITAGE_COMMUNITY_SERMON_IMPLEMENTATION_PLAN.md`.

Song full sync, targeted visibility updates, and conflict resolution remain serialized and abortable. Sermon pull and explicit push use the same abortable connection boundary but remain a separate cursor lane. Network failure leaves local songs, local sermon packets, and live presentation state untouched; it is not a Show-path failure.

### 7. Singer Screen Module
**Purpose:** Show one configured output’s current native cue plus the exact next-cue state for singers/readers

**Implementation:**
- Any enabled output may explicitly use `derive-next-text` from a selected
  source role; it is not tied to a third display or a Singer-like name.
- The shared main/rehearsal payload resolver derives a schema-3 Singer scene
  only from a checksum-verified native presentation.
- `next` is exactly `text`, `blank`, or `end`. Text contains one trimmed
  meaningful line; blank and end contain no text.
- Browser and raster renderers share the same semantics. An intentional blank
  renders no false end label; only absence of a following cue renders “End of
  presentation.”
- Unknown variants, malformed scenes, unavailable assets, or inheritance
  cycles fail closed before a partial cue reaches the output window.

### 8. Show Gateway and LAN Remote
**Purpose:** Let a paired phone control only the active Show without coupling network latency to output timing

**Boundary:**
- The main process owns a revisioned public Show state and the only command adapter. It omits cache paths, display IDs, Profile data, files, and administrative actions.
- Remote is off by default. The controller chooses an opaque ID for an enumerated RFC1918 IPv4 interface; the server never binds a wildcard or accepts an address supplied by the renderer.
- A one-time QR ticket and equivalent six-digit code create a revocable per-device HttpOnly cookie. Host/Origin checks, strict schemas, rate limits, per-device sequences, command IDs, expected revision/cue guards, and output-session rotation reject stale or replayed commands.
- The allow-list is Previous, Next, jump, Restore, and Clear. Local Stop, Back to Load, Show replacement/interruption, computer suspend, and app exit synchronously revoke authority and close the listener.
- Server-Sent Events publish sanitized state; polling is a fallback. Authenticated thumbnail routes derive cue files internally and never expose filesystem paths.
- The local controller and output renderers never await the network. Output health comes from sender/session/cue-scoped frame acknowledgements, not BrowserWindow visibility.

The first implementation uses plain HTTP on a trusted private LAN and provides no cloud relay, UPnP, or internet exposure. It protects against accidental/stale control and untrusted web origins, but a hostile device able to sniff that LAN is outside this preview’s threat model.

---

## File Structure

```
SyncShow/
├── package.json                 # Electron app config
├── main.js                      # Electron main process
├── preload.js                   # Secure IPC bridge
├── scripts/
│   ├── beforePack.js            # Fail-closed private release-config boundary
│   ├── afterPack.js             # macOS metadata plus legal-evidence hook
│   ├── package-legal-bundle.js  # Target-specific notices/provenance outside ASAR
│   ├── verify-packaged-pdf-engine.js # Packaged runtime and native-target smoke
│   └── verify-release-legal.js  # Deliberately blocks incomplete public releases
├── src/
│   ├── renderer/
│   │   ├── index.html           # Control panel HTML
│   │   ├── styles.css           # UI styles
│   │   ├── app.js               # Control panel logic
│   │   ├── prepare-controller.js # Prepare projects, rundown, and library
│   │   ├── display.html         # Presentation display window
│   │   └── display.js           # Display window logic
│   ├── remote/                   # Phone Show controller HTML/CSS/JS
│   └── services/
│       ├── bible/               # Parser, translations, and lazy per-book data
│       ├── profile/             # Venue Profile schema and migration
│       ├── service-set/         # Coherent folder discovery and offline snapshots
│       ├── google-drive/        # OAuth/Picker, public links, Drive client, protected connections
│       ├── project/             # SongDocuments, ServiceProjects, stores, renderer, ShowPackages
│       ├── remote/              # LAN server, authority, protocol, rate limits, and SSE
│       ├── show/                # Per-service launch-plan resolver
│       ├── pdf/
│       │   └── PdfEngine.js      # Shared bounded PDF.js render/text adapter
│       └── converter/           # Node.js PPTX converter
│           ├── Converter.js     # Main orchestrator
│           ├── PdfToImageConverter.js  # PDF.js PNG → JPEG via sharp
│           ├── TextExtractor.js # Text extraction via pptxtojson
│           ├── ThumbnailGenerator.js   # Thumbnails via sharp
│           ├── PlatformDetector.js     # Tool detection
│           └── strategies/
│               ├── BaseStrategy.js
│               ├── LibreOfficeStrategy.js
│               └── PowerPointStrategy.js
├── slide-cache/                 # Converted images (gitignored)
└── README.md                    # Setup instructions
```

Packaged legal evidence is deliberately distinct from release clearance. The
`afterPack` hook copies and hashes the notices and provenance currently
available for the exact target, records native hashes at the explicitly named
pre-platform-signing stage, and writes a blocked-status manifest outside ASAR.
The packaged-runtime verifier requires that evidence to remain internally
consistent. The release verifier rejects installer upload until the separately
identified native corresponding-source and relinking gaps are resolved.

---

## Unverified Performance Targets

These are historical goals, not guarantees. Record hardware, converter, slide deck, resolution, and measured distribution before turning any target into a release claim.

| Operation | Target Time |
|-----------|-------------|
| PPTX Import (130 slides) | < 60 seconds |
| Slide transition | < 16ms (one frame) |
| Inter-display sync | < 5ms variance |
| Control panel response | < 50ms |
| Image load time | < 100ms |

---

## Hardware Requirements

- Windows, macOS, or Linux supported by the packaged release
- 8GB RAM minimum (16GB recommended)
- Dedicated GPU with multiple outputs OR USB display adapters
- SSD for image cache (faster loading)
- 2-4 display outputs

---

## Security Considerations

- Node integration disabled in renderer
- Context isolation enabled
- IPC communication uses validated channels
- Presentation conversion paths require a native-picker or verified-snapshot grant
- Service-source scans use committed Profile sources, opaque Drive connection IDs, and expiring proposal tokens
- Google authorization URLs, client configuration, access/refresh tokens, Drive IDs, and download URLs remain outside renderer IPC and Profile exports
- Local files only (no network dependencies during presentation)

---

## Fallback Strategies

1. **PowerPoint unavailable on Windows:** Fall back to LibreOffice when installed
2. **No supported converter:** Show an actionable installation error
3. **GPU acceleration disabled:** Use software rendering
4. **Display detection fails:** Require the operator to refresh/reassign outputs
5. **Image load failure:** Show a visible error instead of a stale slide

---

## Planned Architecture

See `docs/ROADMAP.md` for the audited Prepare → Load → Show workflow, flexible input/output model, Google Drive stages, native editor, Bible palette, Remote Control, and Heritage integration boundaries.
