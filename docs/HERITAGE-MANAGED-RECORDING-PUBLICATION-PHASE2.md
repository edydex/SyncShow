# Heritage managed-recording publication — Phase 2 local integration

Date: August 11, 2026

Status: **applied to the authoritative local Heritage worktree and clean-build verified; not committed, live-database/browser exercised, or deployed**

## Outcome

This locally integrated slice closes the code-level gap between private manager review of a
preserved SyncShow sermon recording and public Heritage sermon playback. The
ordinary manager review page now offers an explicit publishable-recording
choice. Nothing is selected automatically. The manager must select one current
publishable recording, retain a written sermon alternative, and separately
confirm recording rights and privacy.

That choice produces publish-intent schema 3. The endpoint binds the opaque
review ID to the exact Community, sermon, canonical revision, media slot,
completed upload, and content-addressed object while holding database row
locks. It opens the confined private object before any sermon or publication
mutation. The same transaction publishes the exact hash, size, media type,
title, language, filename, duration, slot ID, and canonical public URL into the
immutable publication source and selected-media pointer.

The public route is:

`GET|HEAD|OPTIONS /content/sermon-media/{publicId}/{sha256}`

Every byte request reloads the active publication and accepts only one selected
ready audio tuple whose canonical URL, hash, size, and media type match the
same-tenant content-addressed object and deterministic storage key. The route
then opens that object with the existing no-follow confined descriptor reader.
It supports full GET, HEAD, one HTTP byte range, `If-Range`, a strong SHA-256
ETag, CORS playback headers, and `Cache-Control: no-store`. Query, trailing,
percent-encoded, malformed, stale, withdrawn, cross-tenant, missing-object, and
path-probing requests return the same anonymous 404 response.

Withdrawal or replacement removes future byte authority immediately because
the route never serves from the URL alone. Bytes already delivered to a client
cannot be retracted.

## Compatibility and refusal rules

- Schema 1 remains byte-compatible. It may preserve a managed recording only
  when the current active publication already selected the exact same slot and
  full descriptor, and the locked private object is still readable.
- Schema 2 remains byte-compatible for ordinary stable external HTTPS audio.
  It cannot use any valid, malformed, encoded, or bare URL in the configured
  Community managed-media namespace.
- Schema 3 is the only path that can establish or change a managed recording.
  It rejects a mixed direct-audio form and requires the exact current
  publishable review ID plus explicit rights/privacy confirmation.
- Review-only historical recordings remain available only through the private
  manager playback/download controls. They cannot enter schema 3.
- Public responses never expose upload/review IDs, object-row IDs, storage
  keys, filesystem paths, or private manager URLs.

No collection, database schema, migration, or package-lock change is required.
The immutable publication source and selected-media IDs bind the existing
unique `(community_id, sha256)` object authority.

## Frozen artifact

Patch:
`docs/patches/heritage-community-managed-recording-publication-phase2.patch`

- SHA-256: `9e2cb43847dd275da9d77430117ee6beade8600d07280e4dbb86320f834ebc8d`
- Size: 126,156 bytes
- Lines: 3,269
- Delta: 12 paths, 2,679 insertions, 61 deletions
- Shape: 9 existing paths changed, 3 paths added
- Application root: `/Users/omayo/GitHub/heritage_study_bible`
- Application mode: worktree only; never use `--index` or `--3way`

The artifact passed `git apply --check --whitespace=error-all` against the
authoritative dirty preimage. It was also applied to a separate minimal copy of
the exact nine base files; all twelve resulting files compared byte-for-byte
equal to the isolated reviewed target. After a complete rollback snapshot and
preimage audit, that same artifact was applied worktree-only to the
authoritative local Community checkout. The immediate post-apply inventory
contained exactly the nine changed records and three additions below, and a
strict reverse apply-check passed. Nothing was staged or committed.

## Exact preimage and target manifest

| Path under `community-server/` | Base SHA-256 | Target SHA-256 |
| --- | --- | --- |
| `package.json` | `bcb989d03983f9a82c2c4fd4380f37efe990f16e620c5e6058f1d53c701ed0f3` | `6b7ca5c4c18997386f6dfc93ac5d3fa97c8d0b1f7fbdf82e4e249c72281818df` |
| `src/components/sermonPublicationReviewModel.ts` | `573e660f5dde8503c76c1d175ff78f64d1864387f31e6db4961c8ba4f2bae2da` | `4d90d8ef8562969b5b594109602602910d2cedacda79f790a74923ead1180bfb` |
| `src/components/SermonPublicationReviewClient.tsx` | `ebbd41aa9ca77895b57d93a51ad78cd6817260c237b29d96c9dd20372dedccbc` | `bc1f9dbeb46330fe87ef3d45687348d21a728133941af0ec34de63f278cd6ba8` |
| `src/endpoints/sermonPublications.ts` | `5528bdf0ac4ebea03a44355dc8ebc3e1192bae64bb28e5e0fa150b661e51615a` | `6bddeeff3359515edde6e1077a78d9e8deb43d8ad8c80284db2aa452536dcac6` |
| `src/lib/syncshow/ManagerSermonPublication.ts` | `35ffb9c886256cd498f30c461fa7e4c862161fa9e10e08cd7696dfe5438fbfa1` | `207184baef061b3af48e01c05a7a7eff7b78ede0a71eef6572ca563cc732c1d4` |
| `src/lib/syncshow/SermonPublicationStore.ts` | `2c5c632810f9ddbfbf804fc2da657b269e97696ecf5b8e5fb77d5a90e997bcc1` | `019fb9f1bdacdadf74280fa351e01e29e4cb4995f9a5f38c34f5f686d991e0a5` |
| `tests/sermon-publication-review.test.ts` | `4dd393337fd2ba523b3865b3de14890a55bf7377ddb39a96ddd9a80dddba8be7` | `3f6f9acf3e9c1dd6aaa43401dde61756a750a6220bba2b92825ce90b6295fe3c` |
| `tests/sermon-publication-review-static.test.mjs` | `23eb22f86a29af9dbb27c49d96c65b502963758642fa5a62cb1dff008f280ade` | `26f1db6eade884cd18676bed350c28e4555c64eee69e82b0772cb6e818114de7` |
| `tests/sermon-publication-endpoint.test.ts` | `443da5a29ad5eccf1271b54558fcf993c2866ceee2ae4d216c5684ce8fbb72ae` | `5218082e0b0431220a2549feef0203fe41e4b45d0ff3645ac37a383ee0e624f8` |
| `src/lib/syncshow/PublicSermonMediaRoute.ts` | absent | `5f5d5b2d9e6e0334957064fdfca3c7bacc7a0c366c888c5be137db651e6d8d0c` |
| `src/app/content/sermon-media/[publicId]/[sha256]/route.ts` | absent | `c482ba27f95aed293ca399f8891e7a864eeb433ee1f23e8fc0e28c048cd6941f` |
| `tests/public-sermon-media-serving.test.ts` | absent | `7ab04945ce54f09ec628df4c699a6746404a091c1d189df67a973e4291a3028f` |

All twelve target paths are mode `0644`.

## Verification

The authoritative locally integrated source passes:

- 44/44 focused endpoint, manager-review model, and public-media behavioral
  tests;
- 3/3 focused static manager-UI contract tests;
- 285/285 complete `test:syncshow` checks: 222 TypeScript behavioral checks and
  63 static/migration checks;
- `npm run typecheck -- --incremental false`;
- independent security and test-coverage audits with no remaining code blocker;
- an optimized authoritative Next 16.2.10 build whose app-path manifest binds
  `/content/sermon-media/[publicId]/[sha256]/route` to its compiled server file;
  and
- a separate clean source copy at
  `/private/tmp/syncshow-phase2-clean-build.N2PTKS/community-server`, where
  the observed `npm ci --legacy-peer-deps` command reported 502 packages
  installed, exact `npm ls --depth=0 --omit=optional` passed, and the production
  and debug webpack build commands both returned zero. The retained standalone
  output contains the managed-media route. The clean build ID is
  `BuFnDezypHm8jShZESkMJ`.

The clean build proves lockfile installation and a local optimized standalone
compile, not a Docker image or configured runtime. Aside from inherited
telemetry disablement, the Dockerfile builder supplies `NODE_ENV=production`
and none of the database, Payload-secret, public-origin, or media-storage
runtime values.

## Completed integration and rollback evidence

Before the authoritative write, the complete dirty Community tree was copied
to `/private/tmp/heritage-community-phase2-preapply.20260811T1p0pVf`. The
snapshot and live preimage matched across 54,199 paths: 49,339 regular files,
4,830 directories, 30 symlinks, no special objects, and 1,171,770,479 regular
file bytes. The canonical full-tree manifest SHA-256 is
`31e7514c0369cf49addeeb3239db2e840be7700262a2d49a8a5a1bab9b31ebe3`.

The capsule's non-ignored preimage inventory contains 973 files and
200,464,295 bytes at SHA-256
`a6ea6eaa80d77439d6e83b1576c77fb8365d49adb7d262aad4cd14ea329525ca`;
the raw Git-status snapshot is 17,198 bytes at SHA-256
`72507e6de10bc223916076c17ca46147952b25d7b288bff1f2695ef115ac0951`.
Immediately after application, the corresponding inventory contained 976
files and 200,555,178 bytes at SHA-256
`2679849233fda98a551bd7f4c15cbea496599ca44fd24706607253d95c01458a`.
Its only deltas were the twelve exact `0644` records in the manifest above.
All twelve still match after tests and builds; the source is byte-identical to
the reviewed isolated candidate outside generated/ignored trees, and the
frozen patch still passes strict reverse checking.

That `/private/tmp` copy is retained session-local evidence, not durable
off-device backup. The deterministic rollback procedure and exact before/after hashes are in
`docs/evidence/HERITAGE-COMMUNITY-PHASE2-ROLLBACK-MANIFEST.md`. Do not reverse
blindly: the reverse remains authorized only while all twelve target bytes and
modes still match. The next legitimate verification step is a disposable live
PostgreSQL/object-storage run followed by a signed-in owner/admin/leader
browser: explicit selection, no auto-selection, rights/privacy refusal and
approval, public full/range playback, HEAD, withdrawal, replacement,
stale/cross-sermon refusal, and private playback/download continuity.

## Remaining boundary

This is authoritative **local source integration**, not a commit or deployment.
It has not used live PostgreSQL/object storage, a configured running Next
server, a signed-in manager browser, anonymous public playback through the
reverse proxy, WOTBC, or a physical/venue workflow. `COMMUNITY_PUBLIC_URL` must
be one stable HTTPS origin.

Withdrawal closes future route authority, but fresh approval of that same
withdrawn managed recording is not a one-click operation: the canonical sermon
must first become a new Ready revision whose managed slot URL has been cleared.
Future object reclamation must treat active immutable publication sources as
references. Transcoding, an explicit retention/reclamation policy, encrypted
off-device replication, clean committed provenance, immutable deployment, and
church adoption remain open.
