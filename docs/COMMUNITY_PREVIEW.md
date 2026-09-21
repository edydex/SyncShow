# Community integration preview — 1.4.0-preview.32

Preview 32 adds separate reading and sermon Scripture layouts, a centered reading
title, and the current sermon point above passage text. Sermon title pictures can
differ between English and Russian. Community's song library supports flexible
verse-part headings and a per-song default language used by new planner entries.
Update the Community server alongside SyncShow to prepare these layouts. Existing
saved services retain their song snapshots; re-add a song to use its updated
library formatting.

Preview 31 adds a local patterned monochrome tablet view with named swatches and
a used-color legend. Normal congregation output retains its intended colors.
See [monochrome teaching](MONOCHROME-TEACHING.md) for display limitations.
It also adds **Prepare → This computer → Scripture → Bible translations**:
preview and install an authorized edition, choose it independently for each
output, and preserve exact text and credits in offline service packages. See
[Bible import](BIBLE-IMPORTS.md) for the portable format and permission boundary.
Canvas slides and text highlighting from Preview 30 remain supported.

## Download and install

**Preview 32 is ready for owner testing**, including Windows. Sign into GitHub
with access to the private `edydex/heritage-preview-builds` repository, then open
the [Preview 32 release](https://github.com/edydex/heritage-preview-builds/releases/tag/syncshow-v1.4.0-preview.32).
A signed-out browser can show a 404 for a private download.

| Computer | Installer |
| --- | --- |
| Windows 10/11, x64 | [Windows installer](https://github.com/edydex/heritage-preview-builds/releases/download/syncshow-v1.4.0-preview.32/SyncShow.Setup.1.4.0-preview.32.exe) |
| Mac, Apple silicon | [arm64 DMG](https://github.com/edydex/heritage-preview-builds/releases/download/syncshow-v1.4.0-preview.32/SyncShow-1.4.0-preview.32-arm64.dmg) |
| Mac, Intel | [x64 DMG](https://github.com/edydex/heritage-preview-builds/releases/download/syncshow-v1.4.0-preview.32/SyncShow-1.4.0-preview.32-x64.dmg) |
| Linux, x64 | [AppImage](https://github.com/edydex/heritage-preview-builds/releases/download/syncshow-v1.4.0-preview.32/SyncShow-1.4.0-preview.32.AppImage) or [Debian package](https://github.com/edydex/heritage-preview-builds/releases/download/syncshow-v1.4.0-preview.32/sync-show_1.4.0-preview.32_amd64.deb) |

Quit SyncShow before installing, keep your previous installer until rehearsal
passes, and confirm version **1.4.0-preview.32** after opening the new copy.
It uses your existing settings and service library. Windows is unsigned; the
Mac preview is ad-hoc signed, without notarization. Checksums and exact-source
verification files are attached to the release. There is no automatic updater
for these private previews.

The installers passed packaged-app launch and runtime checks on all four native
CI platforms. They support **Heritage Community** and **This computer** services.
Direct Google Drive is not configured in these previews. The older public
releases and their separate release workflow do not indicate whether this
private testing installer is available.

## Preview features

Preview 28 adds the progressively fading pointer, a nearby-slide gallery and a full-width host notification after any paired remote changes slides. This version distinguishes the pastor-controls milestone from earlier Preview 27 installers. Pen/highlighter ink remains per-slide, while pointer fragments fade after about one second. See [tablet teaching](TABLET_TEACHING.md) for the controls and limitations.

Prepared services can now supply saved language, Quality/Economy, translated-speech and sermon-note choices in the shared translation console. Select a service in Live translation; Community also links there from its service editor. Saving does not start translation. Economy note sharing remains an explicit choice for each session. Update the unified Community/Multilinguum server set to enable this workflow.

This development preview includes shared Heritage live-translation controls, tablet teaching, and translation-only screens that work without loading a presentation.

- Open **Live translation** after connecting to an approved Heritage Community. The shared console selects English/Russian, Quality/Economy, optional sermon notes and translated speech. Connect the mixer only on the computer receiving the source audio.
- Choose full-screen translation, lower third, ticker or hidden for each configured output. **Open screen** shows captions on its saved venue screen without loading slides. **Hide** leaves that screen black; **Close screen** returns to the desktop. These controls never start or stop microphone capture, translated voice, or provider work.
- During a slide Show, translation uses the Show's existing outputs. Starting Show takes over translation-only screens after its preflight succeeds. Translation-only windows close on changed output assignments or a disconnected display; the operator screen and ambiguous saved display matches are excluded.
- Manual caption overrides and venue preferences are available. Manual text is not retained after app restart. Full-screen, lower-third and ticker outputs contain captions only, with no pulpit video.
- Pair a tablet through **Remote Control**, expand **Teach**, and annotate the selected congregation screen with pen or highlighter. See [tablet teaching](TABLET_TEACHING.md).
- The macOS package now includes the microphone purpose declaration required for optional mixer input. Camera and system-audio capture remain unavailable in the translation console. Turning translated speech off does not remove the need for source audio when producing live text.

## Local build

Use Node.js 24 in an isolated checkout of the selected revision:

```sh
npm ci
npm run ci
npm run build:mac:adhoc -- --arm64
```

Use `--x64` on an Intel Mac, `npm run build:win` on Windows, or `npm run build:linux` on Linux. The ordinary package omits maintainer-local Google Drive credentials. Its Heritage Community and local presentation workflows do not require those Google credentials.

The macOS installer is produced in `dist/`. Check its version and architecture before installing. Quit the existing SyncShow app before opening the new copy; existing settings and services use the same normal app profile. Automated acceptance must use a separate temporary profile through the existing test switches.

## Packaging checks

The ordinary Package Smoke workflow creates temporary QA artifacts. Build and Release also calls it for preview version pushes and manual preview runs, so a successful preview run includes checked installers instead of skipped packaging. Each platform's job summary links its installer ZIP and verification files; sign into GitHub to download them within seven days. Permanent owner releases are published separately after their receipts and checksums are verified, at the private download location above.

A successful preview build is not an official public release. Non-preview releases still require Google Drive release configuration and target-specific dependency-distribution materials in the protected release workflow.

Local checks include the packaged PDF and Sharp runtimes, shared service workflow, app launch, exact artifact/source inventory, and the macOS local-network/microphone declarations. Translation and tablet teaching have separate real Electron rehearsals. Synthetic media input verifies browser permission handling without accessing a physical microphone or contacting a translation provider.

Physical mixer, stylus/tablet, venue network and paid bilingual-provider acceptance remain separate from synthetic rehearsal. The unified Heritage Community repository records the tested component revisions, server deployment and current remaining work.
