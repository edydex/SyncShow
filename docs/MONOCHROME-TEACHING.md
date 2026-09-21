# Monochrome teaching preview

In the paired remote's Teach panel, turn on **Monochrome / colorblind view**. Choose a named color and its pattern; a reference beside the slide shows the colors in its current ink. The setting stays on this browser/device. Audience outputs continue receiving the original ink colors and timing.

The output preview is a captured image, so conversion happens locally by hue family. Red uses dots, blue horizontal waves, green vertical waves, and yellow diagonal lines; neutral pixels retain their gray level. Orange, purple and teal regions in source pictures use additional horizontal-line, cross and vertical-line patterns. Similar shades share a pattern, and photographic regions also become monochrome. Thin colored marks have a dark edge so a pattern gap cannot erase them. Fine pen strokes may be too narrow to distinguish every pattern; Medium or Bold is more useful on a small tablet.

The preview conversion runs when a new image arrives, the view changes, or its size changes. It does not add network requests or alter the host capture/projector. The local trailing pointer updates at most eight times per second in this mode; the host retains the normal progressive one-second lifetime. Turning the view off immediately restores the color screenshot.

## Verification

- Teaching and remote-server tests cover pairing, stale-frame protection, undo, screen separation, used-color state, pure raster conversion and unchanged source pixels/ink.
- `scripts/verify-teaching-monochrome.js` exercises the real local HTTP server, QR-ticket pairing and remote UI with a generated slide/host fixture in Chromium and Firefox. It checks drawing with a named pattern while the host stores the original blue color, grayscale preview pixels, persistence, undo and narrow layout.
- For that optional browser rehearsal, set `SYNCSHOW_PLAYWRIGHT_MODULE` to an installed `@playwright/test` module and optionally `SYNCSHOW_TEACHING_EVIDENCE` to an output folder.

This browser rehearsal is not evidence of projector capture or real e-ink hardware behavior. The standard color teaching path and host renderer are unchanged. Verify readability, stylus input, refresh and pointer latency on the actual reMarkable/BOOX device before service use.
