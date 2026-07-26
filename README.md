# SyncShow - Synchronized Church Presentation System

A cross-platform desktop application for controlling synchronized church presentation outputs. Safe defaults still match the original Russian/English/Singers venue, while administrators can rename, add, remove, reorder, and map input and output roles for other churches.

## Features

- **Synchronized Configurable Outputs**: Advance any number of named venue outputs together; Russian, English, and Singers are only the safe starter profile
- **Fast PPTX Conversion**: Automatically converts PowerPoint files to optimized JPEG images
- **Native Prepare workspace**: Build a semantic service from titled section dividers, arranged songs, pinned Bible passages, per-output sermon/notice text, intentional blank cues, and output-specific pictures, then publish the exact saved revision for Load
- **Direct song authoring**: Create, edit, and translate songs inside SyncShow using `^1`, named sections such as `^chorus`, explicit `---` slide breaks, Unicode section names, attribution, licensing, and translation-alignment checks
- **Scalable song intake**: Search a paged Song Library with an explicit result count, or batch-import as many as 50 Markdown/TXT songs while retaining successful files if another file needs correction
- **Optional Heritage Community song sync**: Approve one church-manager connection, keep the local library usable offline, and share complete song families as private, member-visible, or scheduled-member-visible resources without putting Community credentials in the renderer
- **Exact prepared-item previews**: Choose a configured output and step through the selected item as rendered by the same preset-backed native renderer used to publish the service
- **Recoverable, portable services**: Every Prepare change is autosaved to revision history for Undo/Redo; duplicate individual cues or complete nested sections, and move a service with its pictures in a verified `.syncshow-service` file
- **Load-first workflow**: Opens on a focused service-readiness screen and explains exactly why Start is unavailable
- **Normal Person Friendly Mode**: Keeps venue defaults while hiding timing, preview, and typography controls volunteers do not need
- **One-click weekly service loading**: Finds a coherent same-date set in a private Google Drive folder, public view-only Drive link, or local/synced folder; pins an integrity-checked offline copy; and never silently mixes Sundays
- **Calm Show screen**: Grid view, large navigation/output controls, visible live/cleared/interrupted/error state, keyboard-accessible thumbnails, and Singer preview by default
- **Flexible venue profiles**: Persist custom input/output names, counts, ordering, routes, preview preferences, and conservative monitor bindings
- **Missing-Media preflight**: Upload Media, derive a next-text view, mirror an existing deck as-is, or turn the output off for one service
- **Live Bible passages**: Heritage-style shortcuts and explicit numbered-book choices, with bundled BSB/LSV text, preview, selected outputs, Send Live, and exact Return to slides
- **Show-only phone Remote**: Explicitly enable a trusted local network, pair by QR or six-digit code, then use current/next previews, Previous/Next, jump, Restore, and Clear without exposing files or Settings
- **Singer Screen Support**: Optional third display showing preview of upcoming slide text
- **Keyboard Shortcuts**: Navigate with arrow keys, space bar, Home/End keys
- **Hardware Accelerated**: Uses Chromium GPU rendering when available

## System Requirements

- **OS**: Windows 10/11, macOS 12+ (Intel & Apple Silicon), or Linux
- **RAM**: 8 GB minimum, 16 GB recommended
- **Storage**: SSD recommended for fast image loading
- **Displays**: 2-4 display outputs (HDMI, DisplayPort, or VGA)
- **Presentation converter**: Microsoft PowerPoint or [LibreOffice](https://www.libreoffice.org/download/) on Windows; LibreOffice on macOS and Linux

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

5. **Install LibreOffice** from https://www.libreoffice.org/download/

### Windows Installation

1. Download the `.exe` installer from [Releases](https://github.com/edydex/SyncShow/releases)
2. Run the installer and follow the prompts
3. Ensure Microsoft PowerPoint or [LibreOffice](https://www.libreoffice.org/download/) is installed. SyncShow prefers PowerPoint when both are available.

### Linux Installation

1. Download the `.AppImage` or `.deb` from [Releases](https://github.com/edydex/SyncShow/releases)
2. For AppImage:
   ```bash
   chmod +x SyncShow-*.AppImage
   ./SyncShow-*.AppImage
   ```
3. For deb: `sudo dpkg -i SyncShow-*.deb`
4. Install LibreOffice: `sudo apt install libreoffice`

**Troubleshooting Linux**: If you see a sandbox error, run with:
```bash
./SyncShow-*.AppImage --no-sandbox
```

---

## Development Setup

If you want to run from source or contribute:

### Prerequisites

1. **Node.js** (v22.12 or later; CI uses Node 24) - https://nodejs.org/
2. **Presentation converter** - Microsoft PowerPoint or LibreOffice on Windows; LibreOffice on macOS/Linux

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

## Usage Guide

### Quick Start

1. **Launch the application** - SyncShow opens on **Load**. Use **Prepare** only when you want to build a native service; volunteers loading existing PowerPoints do not need to enter the editor.
2. **Look at the configured slideshow cards**. The default profile shows Russian, English, and Singers Screen; an administrator can rename, add, remove, or reorder these roles.
3. **If an administrator connected an automatic loading source**, SyncShow checks it at startup and fills the cards from matching files for the church’s service date. Admin Settings offers private Google Drive sign-in, a public view-only Drive folder link, or an ordinary local/synced folder.
4. **Choose a slideshow on any empty card**. One-deck services are supported, and every automatically loaded file can still be replaced manually.
5. **Use Admin Settings only for setup work**. Folder paths, date matching, screen detection, input/output names, physical-screen routing, timing, previews, and Singer behavior live in the modal Admin Settings surface instead of the volunteer Load screen.
6. **Click Start Show**. A compact message appears only when loading or venue setup needs attention. If an enabled output has no matching file, Start offers to upload it, mirror another loaded slideshow, create the Singer next-text view, or turn that output off for this service. If a previous cache exists, **Use last service** can restore any valid subset of inputs.
7. **Optional: open Remote Control on Show**. Choose the private Wi-Fi or wired network used by the phone, turn Remote on, and scan the one-time QR code. Remote is off by default and is revoked on Stop, Back to Load, Show replacement, sleep, or app exit.

### Native Prepare

Prepare stores editable semantic service projects separately from live output. Create or open a service, then add and nest service sections, sermons, points, and subpoints. Add songs, Bible passages, per-output sermon/notice titles and bodies, intentional blank cues, or PNG/JPEG/WebP pictures chosen independently for each output; reorder directly by dragging or with the move controls, indent, outdent, collapse, edit, or duplicate the selected item or complete nested section. Titled groups remain visible as clear rundown dividers without becoming projected cues. In sermon and notice bodies, select exact words and choose **Gold emphasis** to reproduce the restrained inline highlighting used by the sample service; changing the body safely clears ranges that could otherwise move onto the wrong words. Built-in presets cover common song, Scripture, sermon, notice, picture, and black-screen treatments.

Songs can be imported from strict UTF-8 Markdown/TXT or created directly in the song editor. `^1`, `^chorus`, and other caret headings begin stable song sections; `---` creates an intentional slide break. Words, translators, and composers are kept as separate credits. The Song Library pages large result sets with **Showing X of Y** and **Load more**, and a batch import accepts up to 50 files at once without discarding files that already succeeded when another file fails. Linked originals and translations are shown as one song family, with each language/version still independently editable; catalog reconciliation preserves each translation’s stored original-song ID (`translationOf`) so the family and output chooser do not depend on matching titles. Create a translation from an original, check its section and slide alignment, and save an incomplete translation as a draft until it can be linked to an output. A selected service song also exposes arrangement and output-translation controls: repeated sections keep distinct identities, compatible translations can be linked per output, and the Singer output can always be restored to its normal next-line view. Bible references use the bundled BSB by default, offer LSV, and require an explicit choice for ambiguous numbered books such as Peter.

### Heritage Community song library

An administrator can connect SyncShow to a compatible Heritage Community server from **Admin Settings → Shared song library**. Enter the server’s HTTPS address and a church-manager email. The manager must explicitly approve the named computer while signed in to the exact requested account; the email link is the normal path, and SyncShow also shows a public approval code and server page when email delivery is unavailable. The approval grants only song read/write scopes, expires after 180 days, and can be revoked from either SyncShow or the Community admin. Access credentials stay in Electron’s main process and are encrypted with the operating system’s protected credential store.

Connection and synchronization never appear on the Friendly Load screen. The local immutable Song Library remains the working copy and remains usable without the server. New songs default to **Private**. **Public** means visible to signed-in members of that church Community—not anonymous internet publication—and **Scheduled** remains manager-only until the Community server’s specified time. SyncShow uploads the original and its translations as one guarded family, verifies every source checksum, pages the complete remote catalog, and uses compare-and-swap versions so a stale computer cannot overwrite a newer edit.

When the local and Community copies both changed, SyncShow preserves both and marks a conflict. **Review conflict** shows the two source families as literal text and requires the operator to choose **Keep this Mac’s copy** or **Keep Community copy** against the current local and server revisions. A missing remote translation is retained locally and remains a visible conflict instead of being silently deleted or re-uploaded. Archiving on Community never deletes a local song. Disconnecting removes the protected local credential but leaves local songs intact.

This first integration slice synchronizes songs only. Sermons, service projects, static Content Server subscriptions, and remote Prepare authoring remain separate follow-up work.

Compilation adds one stable intro cue before each song arrangement, then the arranged lyric cues. Preview 16’s source-audited public intro card uses a black background, a bold white primary title, an optional yellow linked-language title, and the exact source credit at lower right. If no exact attribution was supplied, SyncShow creates a localized fallback from the structured words, music, and translation credits. Singer/Media defaults to a simple single-title card without a credit, while an explicit channel choice or qualifying source content can retain the full card.

Select any native projected item to render its exact preset-backed preview for a configured output, including the derived Singer current/next treatment, with Previous/Next controls for multi-cue items. Service-item editors keep changes as a visible draft until **Save changes**; Cancel, Escape, or closing SyncShow asks before discarding an edited draft. Prepare autosaves each accepted mutation as a recoverable revision, so Undo/Redo restores saved history instead of editing the already-published Show package. **Export service** writes the selected revision and its pinned image assets to a checksummed `.syncshow-service` file; **Import service** verifies and installs that portable copy without overwriting a different local project. Songs pinned by the imported service are also copied into the editable local Song Library when safe. Identical songs are reused, while a different existing song with the same ID is preserved and reported without blocking the service import.

SyncShow compiles the exact saved revision into deterministic cues and publishes an integrity-checked offline ShowPackage for every mapped venue role. Preview 16 uses cue compiler 3, native scene schema 2, and renderer 6. A native ServiceProject package keeps constrained scene JSON plus pinned picture assets; Electron’s output windows build a trusted DOM from those validated scene tokens and render the audience view live with HTML/CSS, the bundled font, hidden staging, and fit checks before reveal. For native content, only the operator-navigation thumbnails are rasterized, and focused coverage exercises both those thumbnails and the live DOM interpretation of the same scene. Imported PowerPoint decks deliberately remain pre-rendered slide images so the PowerPoint/LibreOffice result is preserved exactly. Editing a project or library later cannot silently change the package already loaded for Show, and a project changed during a long publish cannot replace the newer revision in Load. Imported-deck reconciliation, a richer custom preset/style designer, custom portable preset packs, and remote Prepare authoring remain roadmap work. The existing PowerPoint path remains fully supported.

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

For the July 19 sample, the three local decks were used as source references to recreate the service as native SyncShow content rather than wrap or replay the PowerPoint files. The full artifact at `dist/2026-07-19-07-19-2026-service-native-import.syncshow-service` has 71 semantic items and resolves to 114 cues for each configured output: 12 titled groups (including one Sermon group with six nested sermon sections), 10 native reading/notice items, 31 editable sermon items with source-derived inline emphasis, 6 arranged songs, 9 intentional blanks, and 3 output-specific picture cues backed by seven PNG assets. Its songs pin eight exact reusable catalog resources plus two output-only Singer/Media resources, so importing the full service after the catalog does not create duplicate song identities. It contains no imported-deck or legacy-deck items and no PPTX files.

The reconstruction and catalog-first import were exercised only in isolated review roots. The shared timeline remained equal at 114 cues per output, all 31 sermon items remained editable, the eight reusable song resources were recognized from the catalog, and the two output-only Singer/Media treatments stayed pinned to the service rather than appearing as reusable library entries. No live SyncShow user data was changed. Preview 16 now has a structurally verified Apple Silicon app and ZIP: the arm64 bundle passes deep/strict ad-hoc signature checks, its extracted ZIP is byte-identical, its packaged source carries compiler 3 / scene schema 2 / renderer 6, and its local Drive configuration matches the ignored developer file without exposing the credential values. The managed host still refuses GUI launch, so packaged import, native-window paint, and physical venue comparison remain required before this can be called release-validated.

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

Automated tests exercise the authenticated loopback lifecycle. Treat real LAN interfaces, phone pairing, guest-Wi-Fi isolation, and platform firewall prompts as venue checks rather than already validated packaged behavior.

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
│       ├── remote/         # LAN binding, pairing, auth, state stream, and command protocol
│       ├── show/           # Immutable per-service launch-plan resolver
│       └── converter/      # Node.js PPTX converter
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

Creating an installer is not the same as release validation. Current `1.4.0-preview.17` evidence covers all 81 JavaScript syntax checks and 520/520 tests that do not open a Remote listener. The complete runner has three additional Remote loopback cases that this managed shell cannot bind because it returns `EPERM` for `127.0.0.1`; rerun those on a normal host. The Apple Silicon app and ZIP pass architecture, deep/strict ad-hoc signature, packaged-content equality, and ZIP-integrity checks. An unlocked packaged UI pass covered the focused Load screen, Admin-only Community controls, Prepare, translated song families, and a real native song intro-card preview. Heritage approval/two-way sync, real LAN Remote, Windows, Intel Mac, Linux, and physical venue multi-monitor/converter behavior remain separate release gates.

## License

SyncShow's own source code is offered under the [MIT License](LICENSE.txt).

Packaged builds also contain third-party components under their own licenses. In particular, the MuPDF vendor describes MuPDF as dual-licensed under the GNU AGPL or a commercial license. Before publishing another binary release, maintainers must confirm and document an AGPL-compliant distribution, obtain a commercial license, or replace that dependency; see [MuPDF licensing](https://mupdf.com/releases) and the release blocker in `docs/ROADMAP.md`.

Bundled Bible text also keeps its own rights and provenance: BSB is public domain (CC0), while LSV is licensed under CC BY-SA 4.0 and requires attribution. See [`src/services/bible/NOTICE.md`](src/services/bible/NOTICE.md). Those translation terms are separate from SyncShow's MIT-licensed application code.

Native service slides use a bundled Noto Sans variable font under the SIL Open Font License 1.1. The license text is included at [`assets/fonts/OFL-NotoSans.txt`](assets/fonts/OFL-NotoSans.txt).

## Support

For issues or feature requests, please open a GitHub issue.
