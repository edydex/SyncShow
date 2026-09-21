# Imported Bible passages and projection credits

Heritage Community's **Bible translations** library accepts an authorized plain-text JSON edition, previews it and records the church's permission. The service/sermon planner can then select editions for each language output. Selected passages are pinned into normal service documents so they remain available to SyncShow offline. The complete imported Bible and private permission receipt stay in Community's database.

SyncShow renders a passage's supplied attribution in a separate footer on native audience scenes, stage-facing current slides and raster previews. It is not appended to verse text or the stage next-line cue. Footer space is reserved before fitting the verses. Credits are bounded to 500 characters and rendered as plain text.

Renderer identity 12 forces fresh preparation to create new packages rather than reuse pre-credit artifacts. Existing renderer-11 packages remain readable offline without modification. New credited packages require the updated SyncShow app; older strict readers will reject them. Before a service, prepare again with the updated app and check all outputs. This change does not retroactively add a footer to an immutable old package.

## Install directly in SyncShow

In **Prepare → This computer → Scripture**, open **Bible translations…**. Choose an authorized Heritage Bible JSON file, review the sample words and metadata, record the permission reference, then select **Install edition**. Installed editions appear in the passage selector and each output's translation choices, including linked sermon readings. They also appear in the live Bible palette. Missing passages produce an error; SyncShow never substitutes a different edition.

**Save test sample…** writes the public-domain BSB Romans 1:1–3 fixture to a location you choose. Import that file, select BSB-DEMO, enter `Rom 1 1-3` and add the passage. Asking for verse 4 confirms that incomplete files are not silently filled. Version 1 uses the same strict JSON format as Community: UTF-8, up to 24 MiB, conventional 66-book chapter numbering, required edition/source/attribution/permission metadata, and a new ID for changed text. Invalid UTF-8 is rejected before parsing.

Complete editions and permission references stay under `bible-translations` in this computer's private app profile. Installs use confined, checked file reads, a write lock, atomic private files and an immutable digest. The file chooser runs in the main process. The renderer receives a short-lived preview token and sample, never an arbitrary-path read API or the complete source. Cancelled, expired or replaced previews cannot install a file. Reinstalling identical text is safe; changed or damaged existing editions cannot be overwritten. Keep the original authorized file as your backup.

This feature does not add a retail LSB download or decrypt another application's Bible modules. Imported texts are not automatically copied between computers; authorized service excerpts continue to travel through the normal offline package workflow.

## LSB source

The [Legacy Standard Bible publisher FAQ](https://lsbible.org/faqs/) directs software-use agreements to `info@316publishing.com`. Ask for Heritage Community/SyncShow use and an authorized structured source, including the intended projection, local/offline storage and streaming permissions. No portable retail LSB file has been verified or purchased. Community includes a public-domain BSB Romans 1:1–3 import sample for testing the complete upload workflow.

## Verification

Tests cover exact attribution through canonical scene validation, serialization, stage conversion and raster pixels. The package test opens a renderer-11 fixture and verifies that fresh preparation produces a distinct renderer-12 identity. The weekly lifecycle test prepares and reloads a service at 640×360, including long LSV attribution.

Actual Chrome and Firefox rendering passed 24 combinations: three Scripture presets, two logical canvas sizes (1920×1080 and 640×360), and audience/stage views. Long credit text remained complete and below the fitted verses, without body or footer overflow. These are local tests, not projector or installed-release acceptance.

Desktop import acceptance used the actual Electron app with an isolated profile. Only the native file-picker selection was supplied by the harness; storage, preview, permission confirmation, catalog refresh, passage lookup and adding the three-output slide used real application code. A separate package check opened the saved service, prepared renderer-12 output, removed the test source module and reopened the package: exact verses and credits remained available on English, Russian and stage/media channels. It did not bypass the interactive service-readiness workflow or claim a venue Show rehearsal.

The complete local suite passed with 2,254 tests and two existing skips. Tests also cover stale/expired/cancelled preview tokens, sender authorization, invalid UTF-8, conflicting IDs, file tampering, symlinks, private permission metadata, restart lookup and built-in Bible compatibility. Packaged smoke now requires the importer, store and sample inside the application archive and exercises the actual parser in the packaged runtime. Windows/macOS/Linux hosted packaging remains a separate check on each published commit.
