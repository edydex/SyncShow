# Heritage Community manager recording review — Phase 1

Status: **applied to the authoritative local Heritage checkout, fully reverified, not committed, and not deployed to WOTBC**.

This phase gives an authenticated Community owner, administrator, or leader a
private browser surface for recordings already preserved by SyncShow. It does
not grant the SyncShow device token any download authority, does not publish a
recording, and does not change the public sermon-publication schema.

## Manager workflow

The ordinary Community sermon-review page gains a **Private Community
recordings** section before the publication form. A manager can:

- inspect a bounded, redacted inventory of completed and superseded recordings;
- play the private original through a same-origin `<audio preload="none">` control;
- download the exact original bytes; and
- distinguish a recording that still matches the current canonical sermon slot
  from a historical review-only copy.

These controls do not select media for publication. The existing explicit
external public-HTTPS recording field remains the Phase-1 publication fallback.

## Private HTTP contract

Payload exposes these manager-session routes under `/api`:

- `GET /community/sermon-publications/:syncId/managed-recordings`
- `GET|HEAD /community/sermon-publications/:syncId/managed-recordings/:reviewId/content`
- `GET|HEAD /community/sermon-publications/:syncId/managed-recordings/:reviewId/download`

The inventory is capped at 100 entries and returns only review metadata. It
does not return a storage key, filesystem path, database object ID, connection
ID, or secret URL. Each byte request rechecks the signed-in manager role,
configured Community, exact sermon identity, opaque review identity, object
relationship, Community namespace, hash, media type, and size.

Content supports full responses, one case-insensitive byte range, HEAD,
suffix/open-ended ranges, strong SHA-256 `ETag`, and `If-Range`. Unsupported
units, unsupported syntax, multi-range requests, and a mismatched `If-Range`
fall back to the full private object. A recognized but empty, zero-suffix,
unsafe, or unsatisfiable numeric single byte range returns 416. The response is
`private, no-store`, varies on authorization and cookie, forbids
sniffing and indexing, and is same-origin resource protected.

The storage reader validates the content-addressed key, refuses symlinked
parents and final files, opens with `O_NOFOLLOW`, compares the pre-open and
descriptor device/inode identity, and checks the regular-file size. Explicit
close, Web-stream cancellation, and endpoint-construction failures close the
claimed descriptor.

## Audit fixes incorporated

Independent review found and the patch closes the following release blockers
and audit defects:

1. Service authorization schemes are rejected case-insensitively, even if a
   preauthenticated browser user is also present.
2. A claimed recording stream remains explicitly closable, preventing a file
   descriptor leak on exceptional response construction or cancellation.
3. Publish and withdraw operations synchronously claim one sermon generation;
   navigation and refresh controls are disabled while active, duplicate submits
   are refused before React rerenders, and stale async results cannot clear or
   replace another sermon's review state.
4. HEAD now ignores `Range` and `If-Range`, returning the complete object's
   metadata with status 200 as required by HTTP semantics.
5. A same-route review-target change invalidates stale detail generations but
   retains the active mutation claim until its `finally` releases the busy UI.

Historical recordings also use their preserved filename unless every current
slot field still matches, avoiding a misleading current-title label.

## Verification

- focused endpoint, storage, and static regressions: **32/32 TypeScript and
  8/8 static/migration** in the independent audit;
- complete Community suite: **209/209 TypeScript + 63/63 static = 272/272**;
- nonincremental TypeScript check: passed;
- optimized Next.js production build: passed;
- patch dry-run against the exact source snapshot: passed; and
- two independent final audits: GO for Phase-1 integration.

Still unverified by this isolated phase: a signed-in real-browser playback and
download against Payload/Next, disconnect cancellation through the full HTTP
stack, and WOTBC deployment. Those are integration gates, not claims made here.

## Artifact and exact application boundary

The unified patch is
[`heritage-community-manager-media-review-phase1.patch`](patches/heritage-community-manager-media-review-phase1.patch),
SHA-256
`cf721e3f97923463b287cdbe7234035833d9b19b829f8c5fed86ca55092281d3`
(2,222 lines / 81,769 bytes).

It was derived from the user's existing uncommitted Heritage Community work.
Therefore it must be applied only after verifying the ten pre-existing source
files still match this base manifest:

| File | Base SHA-256 |
| --- | --- |
| `package.json` | `32d2d9ee368ff25efe37685984b7f5383943e9fead2dd1c9aff58607c98bfea8` |
| `src/app/(payload)/custom.scss` | `9b713f0b381017258632964b58d00623843d80893925effe786c477477d295c2` |
| `src/components/SermonPublicationReviewClient.tsx` | `5be1a6ec056914e86ac40907ad48f17be3878373a48187910622df17ee7fc8b8` |
| `src/components/sermonPublicationReviewModel.ts` | `e3f29ffb0ffbd3e22c0984c564dd1a260315b1e8fed2e50c44d919fb55be5dae` |
| `src/endpoints/sermonPublications.ts` | `da5fc8962fbc54053143fea3d071d9a15019dab1ca7c190fc19a869d622584db` |
| `src/lib/syncshow/SermonMediaStorage.ts` | `8e6758c31670140d95b9dd6b63010cc61f32e60efcdec8f78cd3136d36114923` |
| `tests/sermon-media-storage.test.ts` | `e18a90d89a501d99be5b09bf63a5b5649d577ecb410b6ca6d4a393fc8ab28896` |
| `tests/sermon-publication-review-static.test.mjs` | `70ccb428022bf5c31d515de603b1231073bf489dc0c6b883db513eed2296ca30` |
| `tests/sermon-publication-review.test.ts` | `f8b747fe22faa8c7d791430387c1c5785f9b4954c76390ee469985e9d5fefaf3` |
| `tests/syncshow-sermon-publication-migration.test.mjs` | `4ca7c4043e6d5263dc40c8b3d0e46ab0980d3456c7119466dd6654eaf074f1ee` |

The patch adds `ManagerSermonMediaReview.ts` and
`sermon-media-review-endpoint.test.ts`; those paths were absent before
application. On August 11, 2026, the exact dirty Community source was copied
into a private disposable integration workspace and also preserved as a
byte-identical rollback snapshot before any authoritative write. The patch
then applied cleanly to the authoritative local Heritage checkout. All twelve
resulting files match the isolated tested target byte-for-byte; the baseline
delta is exactly ten changed files plus the two documented additions.

| File | Applied target SHA-256 |
| --- | --- |
| `package.json` | `bcb989d03983f9a82c2c4fd4380f37efe990f16e620c5e6058f1d53c701ed0f3` |
| `src/app/(payload)/custom.scss` | `7804bc9c147bde484af0966241fd48a0f1c035c760224d6100e0dccd7efcdd60` |
| `src/components/SermonPublicationReviewClient.tsx` | `ebbd41aa9ca77895b57d93a51ad78cd6817260c237b29d96c9dd20372dedccbc` |
| `src/components/sermonPublicationReviewModel.ts` | `573e660f5dde8503c76c1d175ff78f64d1864387f31e6db4961c8ba4f2bae2da` |
| `src/endpoints/sermonPublications.ts` | `5528bdf0ac4ebea03a44355dc8ebc3e1192bae64bb28e5e0fa150b661e51615a` |
| `src/lib/syncshow/SermonMediaStorage.ts` | `8faf4ce2119a3001dbae3bb939e1893900dbe85ed11985306846cbbbae501c6b` |
| `src/lib/syncshow/ManagerSermonMediaReview.ts` | `0df9391ee2605f612bb44f0df8897e36028f8db820c088ac979a30b05003a19a` |
| `tests/sermon-media-storage.test.ts` | `53e41dcff0c23e4150aa6844bf9bf2ea309859309553a18e60def383c2384e7c` |
| `tests/sermon-publication-review-static.test.mjs` | `23eb22f86a29af9dbb27c49d96c65b502963758642fa5a62cb1dff008f280ade` |
| `tests/sermon-publication-review.test.ts` | `4dd393337fd2ba523b3865b3de14890a55bf7377ddb39a96ddd9a80dddba8be7` |
| `tests/syncshow-sermon-publication-migration.test.mjs` | `a3d568eabbe02fef11c7c74b9c15be576b05fb8ea4505e11d679c11e211133d4` |
| `tests/sermon-media-review-endpoint.test.ts` | `8c14479c52eee17ed6eb105ddea3cb966829925d76501400e10642e16cbedb24` |

The authoritative checkout itself then passed the 32/32 focused TypeScript
tests, 8/8 focused static/migration tests, the complete 209/209 TypeScript plus
63/63 static suite, and nonincremental type checking. A byte-identical isolated
copy passed the optimized Next.js production build. No commit, WOTBC deploy,
authenticated browser playback, or public publication is claimed.

## Next phases

1. Exercise signed-in playback, range seeking, download, and disconnect cleanup
   in a real browser against the locally integrated source.
2. Commit the broader interdependent Community work deliberately, then rehearse
   and deploy an exact immutable candidate through the supported WOTBC path.
3. Only then design an immutable managed-object publication binding and public
   serving route. Publication must remain an explicit manager decision.
4. Add encrypted off-device replication and a deduplicated retention policy
   before treating managed recordings as durable church archives.
