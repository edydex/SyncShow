# July 19 native service rebuild

The complete native July 19 service and the downloaded-song catalog are
different portable projects:

- `dist/downloaded-song-library-2026-06-21-through-2026-07-19.syncshow-service`
  is the one-step reusable Song Library import. It contains song occurrences
  grouped by service date, but it does not contain sermon or reading items.
- `dist/2026-07-19-07-19-2026-service-native-import.syncshow-service` is the
  complete July 19 rundown. It contains the opening, readings, worship,
  six-part nested sermon, closing, intentional blanks, and pictures.

The complete-service artifact is rebuilt from a locally reviewed native
template and the final combined catalog:

```sh
node scripts/rebuild-july19-native-service.js \
  --template "/absolute/path/2026-07-19-native-service-template.pre-catalog.syncshow-service" \
  --catalog "/absolute/path/downloaded-song-library-2026-06-21-through-2026-07-19.syncshow-service" \
  --work-root "/absolute/path/new-empty-isolated-root" \
  --output "/absolute/path/2026-07-19-07-19-2026-service-native-import.syncshow-service" \
  --report "/absolute/path/2026-07-19-native-service-rebuild-report.json"
```

The reviewed template and catalog are local content artifacts and remain
ignored by Git. The command validates both portable bundles before use and
never writes to SyncShow's live user-data directory.

The rebuild deliberately preserves:

- all 71 semantic items and their root order;
- all 12 groups, including the six nested sermon sections;
- all 31 editable sermon items;
- all seven picture assets by SHA-256;
- every non-song item's data and visible native cue output; and
- the 114-position compiled timeline.

Only the six service-song pins and arrangements are rebased. They use the exact
SongDocument IDs, revisions, translation families, and output-only Singer
resources from the final catalog. The clean validation sequence imports the
combined catalog first, then the rebuilt complete service, and requires the
second import to add zero reusable songs and report zero conflicts.

As of this rebuild, June 21, June 28, July 5, and July 12 have song-only
portable projects. July 19 is the only downloaded service recreated as a
complete native service. `Psalm 32.pptx` has not yet been reconstructed as a
native sermon/service project.
