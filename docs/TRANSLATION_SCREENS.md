# Translation screens without a presentation

From either Prepare or Load, open **Translation**. You can operate captions without creating a service, importing slides or starting Show.

1. In Admin Settings, assign the venue's outputs to their connected screens. Keep the operator screen separate.
2. Open Translation and choose English or Russian, a visible layout and text size for each output.
3. Choose **Open screen** on the output you want. It remains black until captions or manual text arrive. Full-screen feed, lower third and scrolling ticker use the same live caption connection as a slide Show.
4. Open **microphone & session controls** to manage translation through your approved Community connection. Opening a projector window itself does not connect the mixer or start paid work.
5. **Hide** removes captions and leaves the translation-only screen black. **Close screen** removes that output window. Phone listeners and the shared translation session continue independently.

Starting a slide Show replaces translation-only windows after its normal preflight succeeds. The same saved caption layouts then apply to the Show outputs. A failed preflight preserves the currently visible translation screens. Translation-only Open controls are unavailable while a Show owns the outputs, including a stopped Show awaiting restoration.

When a screen is unplugged, reassigned, moved onto the operator display, or its display geometry changes, its standalone window closes rather than following the operating system onto an unintended screen. Review the assignments and open it again. A renderer that fails to load, hangs or exits also closes and can be retried.

## Verification boundary

The lifecycle tests cover independent English/Russian windows, public caption-frame delivery, hidden output behavior, duplicate opens, delayed-load cancellation, renderer failure/timeout, Show takeover, disconnected displays and conservative saved-display matching. The real macOS source app was operated through its normal UI with an empty temporary profile and simulated display assignments: Open screen created a window, manual text was accepted, Hide retained the window, and Close removed it from the app's window list. No provider or church connection was used. This proves the desktop control path, not physical projector placement, generated speech or a live service.
