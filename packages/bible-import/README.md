# Shared Bible interchange parser

`index.js` is copied without modifications from Heritage Community's `community-server/packages/bible-import/index.js` at commit `951a2c684c0394a3428d0826c5a43297baac45ac` in `edydex/heritage_study_bible`. It is application code under the parent repository's MIT license, not licensed Bible data.

Keep both copies identical when changing the version-1 interchange contract. The canonical book table is injected by each application. The desktop store and Community collection have different persistence/access boundaries, but parse the same authorized source file and canonical digest. No network call, model translation, missing-verse repair or proprietary module decoding happens here.
