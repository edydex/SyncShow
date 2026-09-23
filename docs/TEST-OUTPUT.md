# Simple Load and Test Output

Load suggests the most recently edited local or Community Service Plan. Service dates do not determine the suggestion. It checks every page of both libraries. A disconnected Community falls back to saved local plans; loading still requires an explicit click and preserves the existing exact-revision/conflict checks.

**Load other** reveals Community browsing, saved local services, and **Upload .syncshow-service file**. Upload imports and builds the portable service directly into Load. **Legacy PPTX files** retains the existing PowerPoint workflow.

## Demo on one external monitor

1. Open **Admin Settings → Screen Setup**.
2. Enable **Show Test Output button** and choose the external demo screen.
3. Choose **Vertical — stacked** or **Horizontal — side by side**. Use **Rotate preview → 90° clockwise** (or counterclockwise) to turn the entire output for a physically rotated monitor. Leave macOS rotation unchanged when using this option; choose **No rotation** if macOS already rotates the monitor.
4. Add/enable each logical output and choose its slideshow. Physical assignments can remain empty for this demo. Save screen setup.
5. Load a service, close settings, and choose **Test Output**, immediately left of Admin Settings.

Every preview uses an exact 16:9 rectangle with space for its label. Black space around previews is intentional. Normal Show continues to require separate connected monitors; the demo does not rewrite those assignments. The selected demo monitor must differ from the operator's monitor.

Test Output uses the real native/PPTX/stage output windows, render acknowledgements and cue controls. Next, Previous, Clear, Stop and Restore operate on all outputs. Only the desktop operator can restore a locally stopped Show; paired remotes cannot resume it. Back to Load ends the session.

## Development verification

```sh
npm run ci
SYNCSHOW_TEST_OUTPUT_PROOF=1 node scripts/verify-live-cue-navigation-electron.js
node scripts/verify-live-cue-navigation-electron.js
```

The demo proof uses an isolated temporary profile and one synthetic external display. It tests three real output renderers in both layouts at 0°, 90° and 270°, 16:9 logical bounds and full-size rotated scenes, acknowledged Next, Clear, Stop, Restore, local versus remote Restore permissions, and complete window cleanup. The second command checks normal Show's acknowledgement/failure barriers.

Mac-only local installation build (no release/version bump or other platform packages):

```sh
npx electron-builder --mac --arm64 --dir --config.mac.identity=- \
  --config.extraMetadata.version=1.4.0-preview.35-demo.3 \
  --config.buildVersion=140038 --config.directories.output=dist-demo
node scripts/verify-packaged-app-launch.js --root dist-demo/mac-arm64
node scripts/verify-packaged-service-core.js --root dist-demo/mac-arm64
node scripts/verify-packaged-sharp.js --root dist-demo/mac-arm64
codesign --verify --deep --strict dist-demo/mac-arm64/SyncShow.app
```

The local suffix identifies this Mac testing build without triggering the repository's all-platform release workflow. User data and saved services are separate from the application bundle and must be preserved when replacing it.
