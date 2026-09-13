# Tablet teaching

Use a paired tablet browser to underline, circle, connect and highlight text on the current SyncShow output. No camera or pulpit video is involved. The existing slide or native service cue is the teaching surface.

1. Prepare and Load the service, then start Show.
2. Open Remote Control, select the trusted local network, and pair the tablet with its QR code or six-digit code.
3. On the tablet, expand **Teach · Draw on the current slide** and select the congregation screen to annotate.
4. Choose Pen or Highlighter, a color and pen size, then draw on the captured output preview. Use **Undo ink** or **Clear ink** as needed. Existing Previous/Next, Clear-to-black and Restore controls remain below the teaching view.

**Stylus only** is optional and off by default. The browser reports whether pointer input comes from a pen, touch or mouse. When enabled, drawing accepts only input reported as a pen; fingers can still operate toolbar controls. Turn it off if your browser does not recognize the stylus. This filter is not a guarantee of hardware palm rejection. Physical tablet/stylus acceptance is still required.

Ink belongs to one screen and one slide in the current Show. English and Russian outputs can be annotated independently because their words occupy different positions. Stage-facing outputs are excluded. Returning to a slide restores its ink; Clear-to-black and output restoration preserve the annotations without exposing them while the screen is black. Ending or replacing the Show discards them. Up to 64 annotated slide/output pairs are retained; older pairs are evicted if that limit is reached. Each pair allows 160 strokes and 8,192 points in total.

Drawing pauses during an unconfirmed slide change or failed connection. Delayed strokes cannot migrate to the next slide or undo a Clear action. The tablet refreshes its preview after completed strokes and polls while open. Updates are coalesced to approximately nine per second; the authenticated remote API has a higher request allowance for drawing and preview capture. This is a local network allowance and does not use OpenAI.

The tablet uses the same paired Show authority and revocation as Remote Control. No edits are made to the source slides or immutable ShowPackage. Teaching remains available without an internet connection on the same local network.

## Verification

Run `node scripts/verify-teaching-electron.js` for an opt-in source-app rehearsal. It creates a temporary profile, synthetic displays and service, and a loopback-only paired browser. It checks actual pointer input, output rendering, per-screen routing, highlighter/Undo, navigation, blackout/restore, browser reconnect, Clear ink and Show end. It saves screenshots and an explicit evidence report.

This is not physical tablet, venue Wi-Fi, or packaged-release acceptance. Saving annotations as a reusable lesson, export/replay, and aligned multilingual word annotations remain future work.
