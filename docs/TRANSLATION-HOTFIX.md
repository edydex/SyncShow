Translation service testing installer for Windows.

- Admin Settings opens visibly during Show and can be closed normally.
- Closing translation controls returns to Show while keeping the same audio stream and settings.
- More controls includes Translate / Stop translation, using this computer's saved defaults.
- Translation setup saves the default recognition/translation path, speaker language, and optional speech. OpenAI realtime is the initial default.
- Screen language, bottom-third layout and text size are saved per output and are reused when starting translation.
- Manual translation continues across slide navigation; Stop translation and ending Show stop the owned session.

The church's translation console must include the matching session-controller update. WOTBC receives that client update separately, without restarting its processor.

This is an expedited venue-testing build. Focused translation tests and Windows installation/launch checks run before publication. Full platform regression and physical venue acceptance are pending.

Runtime dependency versions match 2.1.0. Corresponding native sources and notices remain available with the [2.1.0 release](https://github.com/edydex/SyncShow/releases/tag/v2.1.0); application changes are in the source commit linked to this release.
