# Importing downloaded service decks

`scripts/import-service-decks.js` is a developer utility for turning explicit
RUS, ENG, and Media `.pptx` files into:

- immutable SyncShow `SongDocument` library entries; and
- one editable Prepare-stage `ServiceProject`.

The import manifest contains only IDs, credits, output mapping, and slide
numbers. Lyrics and sermon text are extracted from the local PowerPoint files
at runtime. The utility rejects manifest fields such as `lyrics`, `lines`,
`body`, and `textByChannel`, which helps keep deck content out of Git.

## Safe workflow

Dry-run is the default and does not create an output folder:

```sh
node scripts/import-service-decks.js \
  --manifest "/absolute/path/service-import.json" \
  --rus "/absolute/path/07-19-2026 Service RUS.pptx" \
  --eng "/absolute/path/07-19-2026 Service ENG.pptx" \
  --media "/absolute/path/07-19-2026 Media.pptx" \
  --image intro-rus="/absolute/path/rendered-rus-slide-1.png" \
  --image intro-eng="/absolute/path/rendered-eng-slide-1.png"
```

The report contains IDs, counts, and hashes, but no extracted lyrics or sermon
text.

Apply first to a separate review root:

```sh
node scripts/import-service-decks.js \
  --manifest "/absolute/path/service-import.json" \
  --rus "/absolute/path/07-19-2026 Service RUS.pptx" \
  --eng "/absolute/path/07-19-2026 Service ENG.pptx" \
  --media "/absolute/path/07-19-2026 Media.pptx" \
  --image intro-rus="/absolute/path/rendered-rus-slide-1.png" \
  --image intro-eng="/absolute/path/rendered-eng-slide-1.png" \
  --apply \
  --output-root "/absolute/path/SyncShow Import Review"
```

The result has the same storage layout SyncShow uses:

```text
SyncShow Import Review/
├── song-library/
└── service-projects/
```

Pointing `--output-root` at SyncShow’s real user-data folder is blocked unless
`--live-user-data-approved` is also present. Use that flag only after the user
has approved that exact write. On macOS the live folder is normally:

```text
~/Library/Application Support/sync-show
```

Existing content is preserved:

- an identical song or project is an idempotent no-op;
- a differing song or project with the same ID stops the import; and
- the utility does not blindly replace or delete revisions.

## Manifest shape

Start from
[`docs/examples/service-deck-import-manifest.example.json`](examples/service-deck-import-manifest.example.json).

Every service item is processed in manifest order. A group must appear before
an item that names it as `parentId`.

### Song items

A song channel with a `deck` extracts a `SongDocument`. Other outputs can
inherit or derive Singer/Media text:

```json
{
  "primary": {
    "deck": "rus",
    "song": {
      "id": "example-song",
      "title": "Example Song",
      "language": "ru"
    }
  },
  "secondary": {
    "deck": "eng",
    "song": {
      "id": "example-song-en",
      "title": "Example Song",
      "language": "en"
    }
  },
  "media": {
    "mode": "derive",
    "from": "primary",
    "maxLines": 2
  }
}
```

Sections define structure without containing lyrics. Slide numbers are
one-based and follow the visible PowerPoint order, even when a PPTX internally
stores its XML parts in another order.

```json
{
  "id": "verse-1",
  "marker": "1",
  "label": "Verse 1",
  "slides": {
    "rus": { "from": 3, "to": 4 },
    "eng": { "from": 3, "to": 4 }
  }
}
```

A selection can be:

- one slide number: `3`;
- exact slides: `[3, 5, 8]`; or
- an inclusive range: `{ "from": 3, "to": 8 }`.

Translations must use the same section IDs and the same number of slides per
section. SyncShow validates that alignment before anything is written.

Direct Singer/Media content is a real pinned `SongDocument` by default, which
is appropriate when that output contains an authored translation or custom
lyrics worth reusing. For an output-only helper document, set
`"catalog": false` on that channel:

```json
{
  "media": {
    "mode": "content",
    "deck": "media",
    "catalog": false,
    "song": {
      "id": "example-song-operator-output",
      "title": "Example Song — operator output",
      "language": "ru",
      "translationOf": "example-song"
    }
  }
}
```

The output-only document remains pinned inside the editable and portable
service, so it still renders offline. It is deliberately skipped when the
portable service hydrates the reusable song library. Omitting `catalog`, or
setting it to `true`, keeps the backward-compatible catalog behavior. Prefer
`mode: "derive"` when the Media output is only a mechanical current/next-line
projection and does not need its own authored document.

When one source slide contains both languages in differently colored
PowerPoint runs, filter the runs by RGB color without putting either language
in the manifest:

```json
{
  "primary": {
    "deck": "rus",
    "includeColors": ["#FFFFFF"],
    "song": {
      "id": "example-song",
      "title": "Example Song",
      "language": "ru"
    }
  },
  "secondary": {
    "deck": "rus",
    "includeColors": ["#FFFF00"],
    "song": {
      "id": "example-song-en",
      "title": "Example Song",
      "language": "en"
    }
  }
}
```

`includeColors` keeps only explicitly colored runs. `excludeColors` keeps
uncolored runs and every color except those listed. Both accept six-digit RGB
values with or without `#`; PowerPoint preset `white` is normalized to
`#FFFFFF`. The same filters can be placed on an individual section when a
single song changes conventions.

For a known Ukrainian-only source whose Cyrillic words were typed with Latin
lookalike characters, a content channel can opt into the deliberately narrow
`"textNormalization": "ukrainian-cyrillic-homoglyphs-v1"` mode. It replaces
only the supported Latin lookalikes inside a word that already contains
Cyrillic (plus standalone `O`, `I`, or `i`). Ordinary English words and
bilingual text remain unchanged. This must be chosen for the specific source;
the importer never applies it automatically.

For a reviewed Russian or other Cyrillic source, use the stricter
`"textNormalization": "cyrillic-homoglyphs-v1"` mode. It replaces only
supported Latin visual lookalikes inside a token that already contains at
least one Cyrillic character. It does not change ordinary English words or
standalone Latin letters. Keep this opt-in scoped to the exact song/output
whose replacement count was reviewed; it is not a general spell-checker.

For the inverse problem in a reviewed Latin-script output, use
`"textNormalization": "latin-homoglyphs-v1"`. It replaces supported
Cyrillic lookalikes only inside a token that already contains a Latin
character. Ordinary Cyrillic words and standalone Cyrillic characters remain
unchanged. Like the other modes, it requires exact source/output review and is
never selected automatically.

For a reviewed repeat-count suffix that uses Cyrillic `х` in place of the
multiplication sign, use
`"textNormalization": "repeat-marker-multiplication-v1"`. This mode changes
only a standalone Cyrillic `х` in the exact line-ending pattern `х 2` to
`× 2`. It preserves the existing space and leaves word-internal, non-suffix,
Latin, and other Cyrillic characters untouched.

### Sermon and notice items

`sermon` and `notice` items extract selected slide text into native editable
text cues. They support the same per-channel `includeColors` and
`excludeColors` filters. Use separate manifest items when each source slide
should remain a separate cue.

`sermon-notes` also preserves direct PowerPoint `#FFC000` runs as constrained
inline formatting ranges by default. The project continues to store literal
plain text; the ranges can carry only a six-digit foreground color and a
bounded numeric font weight. This retains both bold Scripture-reference runs
and normal-weight semantic emphasis without guessing from keywords. Set
`"emphasisColors": []` on the item or one channel to opt out, or provide a
different list of explicit six-digit RGB colors to override the default.

PowerPoint can visually separate a superscript verse number from the next
word even when its stored runs contain no ordinary space. When a positive-
baseline, digit-only run is followed directly by a Unicode letter, the
importer inserts `U+202F` (NARROW NO-BREAK SPACE). This preserves the visible
boundary, keeps the verse number with its word at line wraps, and avoids
guessing from Bible-book names or keywords.

### Picture items

A `picture` channel can use a pre-rendered PNG, JPEG, or WebP registered by a
CLI key:

```json
{
  "primary": { "image": "intro-rus" },
  "secondary": { "image": "intro-eng" }
}
```

This is the correct choice for composed PowerPoint slides whose visible text,
effects, or multiple images must be preserved. Absolute source paths live only
in CLI arguments; the project stores content hashes and source basenames, not
those paths.

Alternatively, a picture channel with `deck` and `slide` extracts one embedded
PNG, JPEG, or WebP relationship from a slide. `imageIndex` is zero-based and
defaults to the first image. Embedded extraction is deliberately not a
PowerPoint renderer: separate text boxes, effects, and multiple images are not
flattened into a screenshot. Use it only when the desired artwork is already a
single embedded full-slide image or background.

Always verify the review project visually before importing live data.

## Additional deck keys

RUS, ENG, and Media have dedicated flags. Other explicit decks can be added
with:

```sh
--deck ukrainian="/absolute/path/Service UKR.pptx"
```

The key must match the `deck` value used in the manifest.
