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
- `mupdf` (WASM) + `sharp` for PDF → JPEG conversion
- `sharp` for image optimization and thumbnails

**Process Flow:**
1. User selects PPTX file
2. PowerPoint (preferred on Windows) or LibreOffice converts PPTX to PDF
3. MuPDF (WASM) renders PDF pages to pixel buffers
4. sharp resizes and converts to JPEG at the selected target display resolution
5. A complete validated generation is published under `slide-cache/{language}` with files named `slide_{number:03d}.jpg`
6. Text extracted via pptxtojson and stored in JSON metadata file

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

1. `ServiceProject` is the editable semantic tree. It owns profile-derived portable channels, ordered groups/items, stable song arrangements, pinned per-channel SongDocuments, pinned Bible text/attribution, and content-addressed pictures.
2. `compileServiceProject()` produces an immutable `CueTimeline`. Deterministic Cue IDs come from project ID, item ID, and stable leaf identity rather than title or position.
3. `ShowPackagePublisher` compiles every mapped channel at equal cue length into a content-addressed immutable package with checksummed constrained scene JSON, raster thumbnails, pinned picture assets, metadata, font identity, and timeline. Native packages do not contain full-size slide JPEGs.
4. Load installs only the verified package’s presentation records into the existing launch resolver. Show never reads a mutable project, library file, picker path, or network source.

**Persistence and trust boundary:**

- Project and song saves use immutable revisions, compare-and-swap pointers, atomic replacement, owner-only directories, last-good recovery, and no-follow reads. Prepare mutations require the exact expected project revision.
- Publish verifies that revision before rendering and again before installing the finished package into Load. A safely completed package may remain cached after a conflict, but cannot replace a newer draft.
- The renderer receives semantic records only. Native pickers, absolute source/storage paths, song-library content, Bible verse text, and attribution remain in the trusted main process; the preload bridge exposes narrow intent-based mutation methods.
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
- A three-column Prepare workspace for saved service projects, nested rundown sections, arranged songs, compatible output translations, pinned BSB/LSV passages, and the local song library, while Load remains the default startup stage

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

### 6. Heritage Community Song Synchronization
**Purpose:** Optionally share one offline-capable Song Library with a church’s authenticated Heritage Community without making Load or Show depend on that server

**Boundary:**
- Discovery is pinned to one HTTPS origin and one versioned `/api/community/syncshow/v1` namespace. Advertised endpoints cannot redirect or escape that origin.
- A manager approves a named installation through device-secret + PKCE authorization. The renderer receives only the public approval page/code and sanitized connection summary; opaque access credentials stay in the Electron main process and are encrypted with `safeStorage`.
- The grant is limited to song read/write scopes. Heritage rechecks current owner/admin/leader membership on every request, and SyncShow enters an explicit reconnect state after revocation, role loss, or expiry.
- Local `SongDocument` revisions remain authoritative offline. Complete original/translation families move as bounded, checksum-verified source documents; server updates require exact ETag compare-and-swap versions.
- Sync state is a sidecar under Electron user data. It records the remote cursor, family mapping, visibility, scheduled publication, tombstones, and preserved conflict sources without changing immutable local song documents.
- A remote tombstone never deletes local content. A two-sided edit, ambiguous first match, missing translation, invalid source, or stale compare-and-swap becomes a reviewable conflict. Resolution rechecks the current local family hash and current server version before keeping either copy.
- Community **public** means visible to signed-in members of the configured church. Private and future scheduled songs remain manager-only. The public static Content Server is a separate protocol and trust boundary.

Full sync, targeted visibility updates, and conflict resolution are serialized and abortable. Network failure leaves local songs and live presentation state untouched; it is not a Show-path failure.

### 7. Singer Screen Module
**Purpose:** Show the current slide plus extracted upcoming text for singers/readers

**Implementation:**
- Separate window on third display (if available)
- Extract first line of text from next slide
- Configurable large text and character limit
- Dark theme (white text on black background)

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
│       └── converter/           # Node.js PPTX converter
│           ├── Converter.js     # Main orchestrator
│           ├── PdfToImageConverter.js  # PDF → JPEG (via MuPDF WASM)
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
