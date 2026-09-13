# Community integration preview — 1.4.0-preview.25

This development preview brings the shared Heritage live-translation controls and tablet teaching into the desktop app.

- Open **Live translation** after connecting to an approved Heritage Community. The shared console selects English/Russian, Quality/Economy, optional sermon notes and translated speech. Connect the mixer only on the computer receiving the source audio.
- Choose full-screen translation, lower third, ticker or hidden for each configured output. Manual caption overrides and venue preferences are available.
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

The ordinary Package Smoke workflow creates temporary QA artifacts. A successful build is not an official public release. Google Drive release configuration and target-specific dependency-distribution materials remain tracked by the existing protected release workflow.

Local checks include the packaged PDF and Sharp runtimes, shared service workflow, app launch, exact artifact/source inventory, and the macOS local-network/microphone declarations. Translation and tablet teaching have separate real Electron rehearsals. Synthetic media input verifies browser permission handling without accessing a physical microphone or contacting a translation provider.

Physical mixer, stylus/tablet, venue network and paid bilingual-provider acceptance remain separate from synthetic rehearsal. The unified Heritage Community repository records the tested component revisions, server deployment and current remaining work.
