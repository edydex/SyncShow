# Imported Bible passages and projection credits

Heritage Community's **Bible translations** library accepts an authorized plain-text JSON edition, previews it and records the church's permission. The service/sermon planner can then select editions for each language output. Selected passages are pinned into normal service documents so they remain available to SyncShow offline. The complete imported Bible and private permission receipt stay in Community's database.

SyncShow renders a passage's supplied attribution in a separate footer on native audience scenes, stage-facing current slides and raster previews. It is not appended to verse text or the stage next-line cue. Footer space is reserved before fitting the verses. Credits are bounded to 500 characters and rendered as plain text.

Renderer identity 12 forces fresh preparation to create new packages rather than reuse pre-credit artifacts. Existing renderer-11 packages remain readable offline without modification. New credited packages require the updated SyncShow app; older strict readers will reject them. Before a service, prepare again with the updated app and check all outputs. This change does not retroactively add a footer to an immutable old package.

Standalone installation of complete Bible modules on a SyncShow computer is still separate work. This increment supports Community-prepared excerpts; it does not add a retail LSB download or decrypt another application's Bible modules.

## LSB source

The [Legacy Standard Bible publisher FAQ](https://lsbible.org/faqs/) directs software-use agreements to `info@316publishing.com`. Ask for Heritage Community/SyncShow use and an authorized structured source, including the intended projection, local/offline storage and streaming permissions. No portable retail LSB file has been verified or purchased. Community includes a public-domain BSB Romans 1:1–3 import sample for testing the complete upload workflow.

## Verification

Tests cover exact attribution through canonical scene validation, serialization, stage conversion and raster pixels. The package test opens a renderer-11 fixture and verifies that fresh preparation produces a distinct renderer-12 identity. The weekly lifecycle test prepares and reloads a service at 640×360, including long LSV attribution.

Actual Chrome and Firefox rendering passed 24 combinations: three Scripture presets, two logical canvas sizes (1920×1080 and 640×360), and audience/stage views. Long credit text remained complete and below the fitted verses, without body or footer overflow. These are local tests, not projector or installed-release acceptance.
