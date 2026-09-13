# Live translation in SyncShow

SyncShow receives the public caption feed from the connected Heritage Community and opens the same live translation controls used by Community managers. The processor and credentials stay on the church server. Projection windows never receive a provider key or the permanent device token.

## Start and listen

1. Enable the translation companion on the Heritage Community server.
2. Connect this computer in SyncShow’s Admin Settings. A connection approved before live translation was installed must be reconnected and approved with live translation control.
3. Open **Translation** from Load or Show. **Open microphone & session controls** opens the church console inside SyncShow. Starting a session does not require a loaded presentation.
4. Choose English/Russian direction in that console. Speech generation is separate; leave it off for text-only translation. Connect the selected mixer/microphone explicitly. Closing the console ends that computer’s capture connection; it does not automatically transfer capture to another console.
5. Choose a language, layout and text size for each configured screen. Screens open through the normal Show workflow. A translation-only screen launch without a loaded Show is not implemented yet.

The installed processor reports missing provider configuration in its console. This integration does not configure an OpenAI key, enroll a project in data sharing, or promise a free allowance.

## During a service

- **Hidden** shows no captions on that output. **Full-screen feed** replaces its presentation view with text. **Lower third** and **Scrolling ticker** reserve a band beneath the presentation. No video feed is added to church projection.
- Each output is independent, including Stage-Facing Screen. Language follows the explicit choice, not the output’s name.
- **Hide** affects that screen only. **Clear** blacks out all Show screens and new captions cannot remove the black screen. Neither action stops phone listeners or the translation session.
- **Replace text on one screen** temporarily shows the operator’s text. **Return to live captions** removes that override. Manual text is never sent to the provider or other listeners.
- Long captions page at the selected readable size. A new screen joins at the latest finalized phrase rather than replaying the entire sermon. The full-screen feed retains preceding text that fits. Queues are bounded so a slow ticker can catch up during a busy passage.
- A lost connection freezes scrolling and paging and reports the loss to the operator. The loaded Show remains available offline. Captions reconnect with session and revision checks.

Screen language, layout and size are saved per venue. Manual text and microphone capture are not restored after restarting the app. Open Translation to connect captions after restarting.

## Verification

`node scripts/verify-translation-electron.js` runs real display and singer renderers against a local synthetic WebSocket feed and exercises the sandboxed operator’s scoped-access exchange. `node scripts/verify-translation-controls-electron.js` runs the real app twice with an isolated profile to check its controls, IPC validation and preference persistence. Neither uses a microphone, paid provider, real church write, or the normal SyncShow profile.

`SYNCSHOW_REHEARSAL_TRANSLATION_BAND=1 npm run test:native-electron-rehearsal` checks the native weekly service with caption bands, including the direct and derived Stage-Facing Screen routes at 640×360 and 1920×1080. The rehearsal also verifies the existing Bible paragraph/verse typography and rejects an unreadable overflow probe.

These checks do not establish live translation quality, device audio capture, physical venue-screen acceptance, YouTube alignment, or phone playback. Those require an end-to-end service rehearsal.
