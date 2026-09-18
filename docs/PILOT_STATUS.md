# One-service pilot status

Updated: 2026-08-15

## Current checkpoint

Complete staging publication/discovery, then stop at the supervised venue gate.

## Preserved state

Neither dirty checkout has been reset, cleaned, or rewritten. The recovery set
remains at
`/Users/omayo/Documents/Codex/SyncShow-pilot-recovery-20260813-001` with the
tracked patches, untracked archives, manifests, checksums, and Git bundles for
both repositories.

## Visible result

- Community and SyncShow edit one revisioned `HeritageServiceDocumentV1` and
  synchronize its content-addressed private picture bytes. The Community web
  planner can now add a picture or replace it for all outputs or one logical
  output; uploaded bytes remain private until the service revision references
  them.
- Community's same-document planner can now pin an exact reviewed Community
  song, resolve and checksum an exact BSB/SYNO-W reading from the configured
  Heritage reader, choose logical song-output treatments, and open the exact
  linked sermon in manager publication review. None of these actions changes
  public visibility or publication state.
- Song access review now confirms the exact saved family and intended audience;
  it no longer requests a CCLI number, license basis, rights evidence, or rights
  expiry. The hosting church is responsible for its licenses and permissions.
- The July 26 service is rebuilt natively from the supplied English, Russian,
  Media, and pastor sources: 72 semantic items compile to 112 cues per output,
  with songs, Scripture, sermon material, notices, pictures, and intentional
  blanks. No imported-deck item remains.
- Exact document revision
  `6cae0bcc136992b8f7159668856b5d35ff385821673fa74d660f80e5d3bd79d3`
  compiles to immutable ShowPackage
  `show-8cc5e7044771ebbe1c046189e42264cf814193f4b230bc7538dfd1a41aa95326`.
- The corrected macOS arm64 internal package contains the shared service core,
  round-trips a three-output service document, launches its real control
  window, and passes the packaged Planning -> Ready -> Load -> restart proof.
  A non-publishing native-runner workflow now builds and launches Windows x64,
  Linux x64, macOS arm64, and macOS x64 and runs the same packaged core smoke.

## Focused evidence

- 336/336 July 26 native output frames rendered and visually sampled against
  the supplied decks.
- 47 critical Show acknowledgement, fail-closed navigation, package integrity,
  restart, and locked-volunteer checks pass.
- macOS package archive, PDF, Sharp, shared-core, real launch, and packaged
  Planning-to-Load/restart checks pass. The internal build is ad-hoc signed and
  deliberately blocked from public-release status.
- Community picture storage/editor checks and TypeScript validation pass.
- The focused Community song/Bible/sermon-planner contracts pass: `9/9`
  editor and reader-lookup checks plus `4/4` browser-safe shared-core checks.
- The nonblocking church-managed song policy passes `115/115` focused SyncShow
  checks and `16/16` Community member/public-link contract checks; exact-family,
  audience, authorization, CAS, and idempotency safeguards remain intact.
- Live WOTBC checks found a healthy app, database, tunnel, public home page, and
  fresh backup, but the pilot service-document and song-library API paths return
  `404`, confirming that production is still on the pre-pilot route set.
- The named broad SyncShow gate passes (`190` JavaScript files syntax-checked
  and the complete Node test suite green). A clean optimized Community build
  also succeeds with the shared planner and publication routes included.

## Next feature

After the human publication inputs are supplied, use a disposable Community
staging copy to import the exact July sermon, attach the reviewed recording,
verify the public sermon page plus primary/mentioned passage discovery, and
exercise one church-selected song share. Then perform the historical rehearsal
and stop for supervised venue approval.

## Blocker

Windows and Linux native launch jobs are implemented but not yet executed from
a committed branch; native installer execution also remains unproved. The July
materials contain no reviewed sermon recording. The live WOTBC Community server
is healthy, but its deployed build does not yet expose the pilot service-document
or Community song-library endpoints, so the new workflow is not ready for user
testing there. Signed-in admin validation and physical multi-display rehearsal
remain human/environment gates. Nothing has been published automatically.
