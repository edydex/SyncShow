# Heritage Community sermon implementation plan

Status: implementation and verification record. It began from a read-only audit
of `heritage_study_bible` main commit `711d834` on July 27, 2026, and the clean
isolated song-integration branch at `87c4b4b` on July 28, 2026. The five
Community resource lanes, sermon server and publication paths, public passage
index/reader, and immutable private sermon-change authority described below
have now been copied byte-for-byte onto the real Heritage branch
`codex/syncshow-community-integration`. The complete Community contract suite
passes 171/171; the branch is still uncommitted, unmerged, and undeployed, and
is not evidence of a production Community authorization, browser/phone,
recovery, or venue round trip.

The cross-repository product and wire contracts are:

- [`SERMON_PACKET_CONTRACT.md`](SERMON_PACKET_CONTRACT.md) for sermon identity,
  exact revisions, passage semantics, source preservation, service pins, and
  public-reading behavior; and
- [`COMMUNITY_SERMON_SYNC_CONTRACT.md`](COMMUNITY_SERMON_SYNC_CONTRACT.md) for
  discovery, scopes, authenticated envelopes, cursor behavior, compare-and-swap
  writes, and conflict preservation.

Paths beginning with `community-server/` or `src/` in this document are relative
to the `heritage_study_bible` repository. SyncShow paths are called out
explicitly.

The canonical synchronization target is the direct, authenticated Heritage
Community API in `heritage_study_bible`. PagesDB or another static-content
publisher may inform public projection compatibility, but it is not the
mutable sermon authority or a substitute for the Community sync server.

## Implemented boundary and historical baseline

SyncShow currently has five additive foundations:

1. The local sermon packet under `SyncShow/src/services/sermon/` preserves
   canonical v1/v2/v3 `SermonDocument` revisions, private content-addressed
   source files, exact service pins, reviewed extraction proposals, ordered
   human-confirmed v3 body entries, and staged sermon/project commits.
2. The Community client under `SyncShow/src/services/community/` normalizes
   protocol-v1 root song discovery, validates independent protocol-v2 song and
   sermon lanes, and implements manual sermon pull plus explicit one-sermon
   create/update. It preserves both exact sources when local and remote
   diverge—including body-only divergence—and makes both ordered bodies
   inspectable during guarded conflict review. Explicit v3 sync sends canonical
   body text and source descriptors, but not private file bytes.
3. Prepare reports human-reviewed canonical v3 body separately from reviewed
   external post-service HTTPS links for the canonical sermon page, recording,
   and notes/transcript. A confirmed primary passage, available recording, and
   either that reviewed body or an available page/text destination can become
   locally Ready. An attachment or extraction alone does not count. The handoff
   coherently re-pins the exact service owner and compatible generated-reading
   provenance, but does not fetch, upload, transcode, publish, automatically
   send links to Community, or select body/media for public use.
4. `SyncShow/src/services/sermon/SermonPublicProjection.js` is a strict pure
   Heritage Content Server v2 compatibility contract. Given one exact eligible
   public sermon revision and explicit reviewed body/media selections, it emits
   bounded catalog, detail, and confirmed passage-index records with canonical
   checksums and stable public IDs. The golden fixture at
   `SyncShow/test/fixtures/sermon-public-projection-v1.json` locks the portable
   bytes. This code has no authentication, database transaction, endpoint, or
   publication authority.
5. `SyncShow/src/services/community/CommunitySermonPublicationProbe.js` plus
   the main-owned Prepare action now provide a read-only deployed-publication
   gate. For an active publication receipt, SyncShow reads the exact immutable
   local `publicRevision`, anonymously fetches the fixed same-origin
   catalog/detail/passage-index routes with independent byte ceilings, and runs
   the complete checksum/index conformance contract. It re-reads and exactly
   compares the authenticated receipt after those public reads, so withdrawal,
   republish, current-revision, checksum, timestamp, or selection drift fails
   instead of producing a stale success. The renderer receives only bounded
   status and count evidence. This path has no publish or withdraw operation,
   and the isolated Heritage server now supplies the source/runtime contract.
   No deployed read-only verification result is claimed.

Heritage main has reusable Community membership, Payload auth, opaque-token,
configured-community, and public Content Server primitives. It also already
has:

- the tracked `/.well-known/heritage-community.json` discovery route used by
  the reader's Community join flow;
- a manual Payload `Sermons` collection and admin create/edit path with a
  numeric ID, free-text Scripture, transcript, media, series, and publication
  status;
- standard Payload REST access to that collection;
- a public published-sermon Content Server catalog and detail route; and
- generic Heritage Resources listing and viewing for the resulting transcript
  and media.

Those are useful legacy/manual publication paths, not the canonical SyncShow
sermon store or passage-linked reader experience.

The `87c4b4b` historical branch supplied a real song-only SyncShow foundation:
PKCE device approval, hashed dedicated tokens, expiry/revocation, live
owner/admin/leader rechecks, scoped song read/write, transactional token
exchange, bounded requests, and song compare-and-swap. The current isolated
integration reuses that credential family and exact JSON scopes while adding
freshly approved sermon, publication, service-plan, and public-link lanes.
Existing song-only grants remain song-only.

The current isolated integration now has:

- exact canonical v1/v2/v3 and archive source storage on the current sermon and
  on every immutable private change-journal row;
- separate current and public pointers, durable cursors, create idempotency,
  compare-and-swap, and atomic change recording;
- dedicated authenticated SyncShow sermon endpoints and scopes;
- manager-owned publish/withdraw transactions, strict public
  catalog/detail/passage-index projection, and publication receipts; and
- Heritage reader UI for **On this passage**, **Appears in**, and an
  integrity-checked canonical sermon view.

Protocol v2 advertises only its five implemented resource lanes. A server that
does not actually advertise `resources.sermons` remains unsupported, and the
isolated implementation is still not a deployed authenticated round trip.

## Accepted discovery path: independent resource lanes

SyncShow now accepts protocol-v2 Community discovery with independently
advertised `resources.songs` and `resources.sermons` lanes. Either lane may be
omitted, but at least one supported lane is required. Protocol v1 remains
unchanged: its root song fields are normalized internally for existing
song-only or combined servers.

This resolves the former root-song prerequisite. Heritage may stage a real
sermon-only integration without claiming `songLibrary: true` or implementing
the song wire protocol first. It must still implement the shared device
authorization operations, advertise `deviceAuthorization: true`, and expose
only real lanes and scopes. The normalized offered scope set is the union of
the advertised lanes; adding a lane to an existing installation still requires
explicit manager approval for its new scopes.

The v2 discovery/client contract is implemented locally in SyncShow, and the
isolated Heritage worktree implements the matching authorization, resource
endpoints, storage, manager workflow, public routes, and reader integration.
The accepted manifest shape and isolated tests are not evidence of a deployed
server.

## Implementation sequence

### 1. Port and lock the canonical validators

Add the following Heritage server modules:

- `community-server/src/lib/syncshow/BibleRange.ts`
- `community-server/src/lib/syncshow/SermonDocument.ts`
- `community-server/src/lib/syncshow/SermonWire.ts`
- `community-server/src/lib/syncshow/constants.ts`

Port behavior, limits, canonical serialization, and error conditions from the
corresponding SyncShow modules. Accept canonical v1, v2, and v3 documents. Do
not reserialize an accepted v1 or v2 document as v3: every historical canonical
byte and SHA-256 revision must remain exact. `documentSource` is accepted only
when it is already the one canonical UTF-8 JSON string, including the trailing
newline.

Add shared golden fixtures in both repositories for:

- one canonical v1 document and revision;
- one canonical v2 bilingual document and revision;
- one canonical v3 document with multiple ordered reviewed body entries,
  source links, and an optional outline-section link;
- whole-chapter and verse-bounded `BibleRangeV1` values;
- invalid noncanonical JSON, mismatched IDs, and mismatched revisions;
- maximum-size document and envelope boundaries; and
- source metadata with both `available: true` and `available: false`.

No collection or endpoint should accept a sermon before these tests produce the
same canonical bytes and hash in both repositories.

### 2. Implemented storage model and migration ledger

The isolated implementation uses these concrete authorities:

- `community-server/src/collections/Sermons.ts` is the stable identity and
  mutable current-pointer record. It retains the newest exact canonical
  `syncCurrentDocumentSource`, SHA-256 revision, monotonic version, archive and
  editorial state, source descriptors, and create-idempotency evidence.
- `community-server/src/collections/SyncShowSermonChanges.ts` is the
  append-only private revision authority. Every create, update, archive, and
  manager publish that changes the canonical sermon appends that version's
  exact canonical `documentSource`; later current-row edits do not alter it.
- `community-server/src/collections/SyncShowSermonPublications.ts` retains the
  exact manager-approved published source and pointer separately from the
  current sermon. `SyncShowSermonPublicationCatalogs.ts` contains only
  generated public catalog/detail/passage-index authority.
- `SyncShowDeviceGrants` and `SyncShowConnections` remain the single grant,
  token, and connection family for every lane.

The journal's normal Payload access is hidden and system-administrator-only.
Only an internal sermon transaction context may create a row. Its hook verifies
that the source parses and canonically reserializes byte-for-byte, that the
document ID equals the row sync ID, that UTF-8 SHA-256 equals the revision, and
that document/archive state agrees. Updates are rejected. An unconditional
`beforeDelete` rejects deletion even through a Payload Local API call with
`overrideAccess: true`.

Direct SQL remains a deliberately privileged migration, backup, and repair
boundary outside Payload hooks. The database CHECK binds source SHA-256 to the
revision, but database operators can still modify rows directly; access to
backups must account for the private canonical sermon text they now retain.
SyncShow now applies a separate safe policy to its local imported source-object
bytes: every immutable local sermon/project revision and validated extraction
protects its object, continuously unreferenced objects wait 90 days, and an
exact confirmed set is re-audited and removed only during pre-window startup.
That local cleanup has no access to this Heritage database journal and must
never be interpreted as authority to delete canonical journal sources.

The isolated branch has eight ordered integration migrations after five earlier
migrations, for a clean 13-migration chain:

1. `20260725_160000_syncshow_song_library`
2. `20260728_234856_syncshow_sermon_roundtrip`
3. `20260729_002359_syncshow_sermon_publications`
4. `20260729_005039_service_plans`
5. `20260729_005827_sermon_passage_index`
6. `20260729_010500_syncshow_song_public_links`
7. `20260729_045710_syncshow_sermon_change_sources`
8. `20260729_130000_service_plan_sermon_readings`

The seventh, sermon-history migration stages nullable `document_source` and
backfills only an exact community/sermon/sync-ID/revision/archive match to the
current sermon. PostgreSQL 17 must reproduce the SHA-256; JSON document ID and
publication archive status must agree; and the shared TypeScript
parser/serializer must accept the exact canonical bytes. A noncanonical
candidate aborts before the schema changes. After nullable staging/backfill,
any row still lacking an exact source raises SQLSTATE `23514` and rolls back
before `NOT NULL` and the source/revision CHECK become authoritative. Down
migration also raises `23514` before dropping retained bytes if any journal
source is no longer exactly reconstructable from the current sermon. Empty or
all-current journals can roll back; distinct historical revisions cannot be
silently destroyed.

The eighth migration adds only the nullable service-plan sermon relationship
and stable reference ID, a `SET NULL` sermon foreign key, and one index. It
performs no backfill and does not rewrite retained schema-v1 canonical plan
bytes.

The migrations do not manufacture canonical documents or historical sources
from legacy `Sermons` rows. Preserve each legacy field and leave canonical
pointers empty until a manager explicitly reviews and adopts the row.

### 3. Refactor the existing device authorization and add sermon scopes

Add:

- `community-server/src/lib/syncshowScopes.ts`
- `community-server/src/lib/syncshowDeviceAuth.ts`
- `community-server/src/lib/syncshowHttp.ts`
- `community-server/src/lib/communityManifest.ts`

Refactor the isolated branch's existing `src/endpoints/syncShow.ts` so its
working PKCE start/status/token/cancel/revoke flow, signed-in approval page,
bounded HTTP helpers, and live manager-role authorization can be reused by
independent song and sermon endpoint modules. Preserve its explicit
owner/admin/leader check and dedicated `Authorization: SyncShow <token>`
credential family.

Extend the existing
`community-server/src/app/.well-known/heritage-community.json/route.ts`
additively. Preserve its current Community join and magic-link fields.

Register the custom endpoints and collections in
`community-server/src/payload.config.ts`.

Reuse the existing membership relationships, opaque-token hashing, grants, and
connections. Never accept a Community browser token on SyncShow endpoints.
Preserve hash-only device secrets, approval codes, and access credentials,
PKCE, one-time approval, expiry, revocation, narrow attempt/rate limits, and
exact configured-community/origin binding.

Every request must recheck that the approving user still has an allowed
owner/admin/leader membership and that the grant still carries the requested
scope. Scope dependencies are:

- song write requires song read;
- sermon write requires sermon read;
- sermon-publication read requires sermon read;
- sermon-source read requires sermon read; and
- sermon-source write requires source read and sermon write.

The discovery route must be same-origin HTTPS in production, advertise
protocol `schemaVersion: 2`, set `deviceAuthorization: true`, retain the shared
device start/status/token/cancel/revoke operations, and advertise one versioned
`/api/community/syncshow/v1` base. Put the implemented lanes under
`resources.songs` and `resources.sermons`; each is optional, at least one is
required, and their scopes form the normalized offered scope set. Song and
sermon endpoint paths are pinned independently. They may be relative or
same-origin absolute URLs, but cannot redirect across origins or escape the
advertised API base. Do not advertise a song lane until its real endpoint and
scopes exist.

The implemented protocol v2 also advertises the dependent read-only
`resources.sermonPublications` lane with
`syncshow:sermon-publications:read`. It exposes exact current/public pointer
status to SyncShow but no publish or withdraw method; those remain manager
actions in Community administration.

### 4. Keep all sermon mutations transactional

The implemented sermon and manager-publication endpoint modules use shared
transaction helpers. New endpoint or Payload-admin paths must reuse that
boundary rather than assembling multi-row writes independently.

For create, one database transaction must:

1. authenticate and authorize the grant;
2. validate the exact canonical source, stable ID, and revision;
3. reserve/check the idempotency key;
4. reject an existing ID with different content, or return the identical
   existing revision as an idempotent no-op;
5. create the stable sermon record and source descriptors at `syncVersion: 1`;
6. append a durable private change row containing that version's exact
   canonical source; and
7. commit the idempotent response.

For update, one database transaction must:

1. lock/read the stable sermon record;
2. require the exact expected `If-Match` sync version;
3. validate the new exact canonical source;
4. advance `syncVersion` only when canonical content changes;
5. move `currentRevision`;
6. append the corresponding immutable source-bearing change; and
7. commit the idempotent response.

No partial current source, pointer, or journal write may survive a failed
request. A stale update returns the contract's precondition failure and never
uses last-write-wins.

#### Current revision and public revision are separate

`currentRevision` is the latest authenticated editorial state. It may be
private, incomplete, or under review. `publicRevision` is the exact revision a
manager has explicitly approved for the public Content Server and Heritage
reader.

Publishing or withdrawing is a separate authorized transaction:

- the ordinary sermon-write scope cannot publish or withdraw;
- publication starts from one exact retained **Ready** `currentRevision` and
  requires compare-and-swap guards for its `syncVersion`, `currentRevision`,
  prior `publicationVersion`, and prior `publicRevision`;
- the server, not SyncShow or the browser, creates the next canonical revision
  by changing only `publication.status` to `published`,
  `publication.visibility` to `public`, and `publication.publishedAt` to the
  server-authored transaction time;
- the transaction generates the bounded public projection and confirmed range
  rows from that newly created exact revision and atomically advances
  `currentRevision`, `syncVersion`, `publicationVersion`, and
  `publicRevision`;
- editing `currentRevision` later does not silently change the public sermon;
- withdrawing is a separately authorized, compare-and-swap transaction that
  clears the public pointer/projection/ranges without deleting immutable
  history; and
- the reader and public routes never fall back from `publicRevision` to
  `currentRevision`.

The publish review binds explicit body-entry and media IDs to the Ready base
revision. The server re-reads that exact canonical source and re-runs the shared
projection code inside the transaction; it never trusts client-projected
detail, catalog, checksum, or passage-index bytes. Any validation or database
failure leaves the previous current and public pointers, public detail,
catalog, and passage rows intact.

`canonicalLinkConfirmed` means the manager reviewed the canonical-destination
decision for this exact revision. It may confirm that there is deliberately no
separate church-website page; it must not manufacture a URL or treat an
unchecked/missing decision as approval.

The projection excludes private source descriptors/bytes, manager-only notes,
unconfirmed references, device/audit state, and mutable internal IDs. A source
object becoming available does not republish or alter the canonical sermon.

### 5. Add the authenticated sermon API and durable cursor

Add:

- `community-server/src/endpoints/syncshowSermons.ts`
- `community-server/src/lib/syncshow/SermonCursor.ts`

Register:

- `GET /api/community/syncshow/v1/sermons`
- `POST /api/community/syncshow/v1/sermons`
- `GET /api/community/syncshow/v1/sermons/{encodedSyncId}`
- `PUT /api/community/syncshow/v1/sermons/{encodedSyncId}`

The list returns bounded summaries; GET returns one exact envelope; POST and PUT
follow the transactional rules above. Decode and validate the path ID exactly
once, and reject ambiguous encodings, redirects, oversized bodies, unknown
fields, and unsupported content types.

The cursor must be opaque, tamper-evident, versioned, and bound to the
configured Community and resource lane. Prefer a signed/HMAC payload containing
only the minimum snapshot position and expiry data; never expose a raw
incrementing database ID as an authorization substitute.

Every page, including a final or empty page, returns a non-null durable
`nextCursor`. A page with changes must advance it. A continuing page must
contain both items and a cursor. The server must be able to restart between
pages without making the last acknowledged cursor replay changes forever.
Songs and sermons retain independent cursors.

### 6. Add explicit legacy adoption

Add:

- `community-server/src/lib/sermonAdoption.ts`
- a Payload admin endpoint/component for reviewing legacy sermon adoption

The adopter may propose a canonical v3 document from the legacy title,
speaker/date, free-text Scripture, transcript, media, and series fields, but a
manager must confirm the stable `syncId`, primary passage, visibility,
publication state, retained source meaning, and any transcript text selected as
ordered canonical body entries. The confirmed adoption goes through the same
transactional repository as any other create. It must not silently treat the
entire legacy transcript as reviewed body content.

Keep the legacy fields read-only until adoption is complete. Record the legacy
row ID and adopted revision in the audit event so the operation is
deterministic and reversible without deleting historical data.

### 7. Generate the public Content Server projection

Add:

- `community-server/src/lib/publicSermonProjection.ts`

Port the behavior and golden fixture from
`SyncShow/src/services/sermon/SermonPublicProjection.js`; do not invent a
second public format. The SyncShow implementation already proves the pure v2
catalog/detail/passage-index bytes, exact checksums, selected-body/media
allow-list, canonical confirmed ranges, and primary-over-mentioned suppression.
Port or independently reproduce
`SyncShow/src/services/community/CommunitySermonPublicationTransactionConformance.js`
as the server transaction parity gate. Its self-contained republish vector at
`SyncShow/test/fixtures/community-sermon-publication-transaction-conformance-v1.json`
is deliberately an **active-republish-only** gate. It binds the exact canonical
Ready source and base revision, the exact prior canonical Published source and
non-null prior publication CAS, normalized manager intent, a strictly later
server-authored time, a genuinely new exact Published source, one-step
sync/publication version advances, document-order selections, target public
ID/checksum, and exact before/after global catalog and passage-index bytes. The
vector includes an unrelated active sermon and requires that global
regeneration replace the target once without changing that unrelated row.
First publication needs a separate parity gate whose empty target state is
still bound to an independently authenticated global generation; it must not
reuse a caller-supplied catalog snapshot.

The narrower
`SyncShow/src/services/community/CommunitySermonPublicationConformance.js`
remains the post-transaction receipt check. Its self-contained vector at
`SyncShow/test/fixtures/community-sermon-publication-conformance-v1.json`
binds one exact public source and read-only publication state to detail,
catalog, passage-index, and representative primary/mentioned/excluded query
behavior, including a newer private current revision beside an older public
revision. Neither pure verifier proves Heritage authorization, database
atomicity, persisted range rows, served routes, or reader behavior.
Heritage must call the bulk builders only from bounded trusted repository
records: enforce an aggregate transaction/input byte limit or stream fixed-size
batches rather than exposing the pre-parsed publication arrays directly to an
untrusted HTTP body. The publication review must also confirm that every
selected `ready` HTTPS media URL is a durable anonymous public destination,
not an internal or presigned/expiring URL; URL syntax alone cannot prove that.

Modify:

- `community-server/src/app/heritage-content.json/route.ts`
- `community-server/src/app/catalogs/[type]/route.ts`
- `community-server/src/app/content/[type]/[id]/route.ts`

Add:

- `community-server/src/app/indexes/sermon-passages/route.ts`

The shared dynamic-Community route profile is
`/catalogs/sermons`, `/content/sermons/{publicId}`, and
`/indexes/sermon-passages`. These extensionless paths are locked with the exact
detail, catalog, and passage-index bytes and SHA-256 values in
`SyncShow/test/fixtures/sermon-publication-bundle-v1.json`.
The newer self-contained conformance vector above is the preferred parity gate
because it also binds those anonymous artifacts to the authenticated
publication-state receipt and exact selected canonical revision.

The current content route must stop spreading a raw Payload document into the
response. It should return a strict, versioned allow-list `publicProjection`
generated from `publicRevision`. Catalog records should contain stable public
IDs, revision/checksum, bounded display metadata, canonical confirmed ranges,
and a same-origin content URL. Detail records may include only the ordered v3
body entries explicitly approved for this public revision plus public recording
links; synchronized body text is not automatically public. No private source
descriptor/object, provider provenance, or internal Payload relationship may
enter the projection.

Catalog and detail ETags/checksums must change only when their public bytes
change. A public catalog should remain cacheable without a Community account.
Its passage rows are derived in the same publication transaction, so a reader
cannot observe a new sermon with an old range index.

The catalog and passage-index checksums describe one global committed public
generation, not immutable properties of an individual sermon publication.
Publishing or withdrawing any sermon changes those two global bytes for every
active sermon receipt without advancing every other sermon's publication
version. Store or derive them from one atomically swapped generation record;
do not duplicate them as independently authoritative per-sermon values.

### 8. Add Heritage reader discovery and viewing

Add:

- `src/utils/canonicalBibleRanges.js`
- `src/services/sermonCatalog.js`
- `src/hooks/useSermonPassageMatches.js`
- `src/components/SermonsForPassage.jsx`
- `src/components/SermonViewer.jsx`

Modify:

- `src/utils/contentProtocol.js`
- `src/services/contentServers.js`
- `src/components/CommentarySidebar.jsx`
- `src/components/RemoteResourceViewer.jsx`
- `src/App.jsx`

`contentProtocol.js` should validate the raw sermon catalog shape before the
existing generic normalizer spreads unknown item fields or resolves
`content.url`; retain the resolved URL only as reader metadata. Validate only
the new public sermon projection, never the private Community envelope.
`contentServers.js` should use the existing pinned/cached Content Server
boundary and make a malformed sermon catalog fail independently of books,
commentaries, and Bible reading. Its current generic metadata limit is 5 MiB,
while the shared contract permits a 16 MiB sermon catalog and 32 MiB explicit
passage index, so the first reader slice should derive verse matches from the
already-bounded catalog rather than route the full index through that generic
fetcher. The server must still publish the explicit index atomically.

`sermonCatalog.js` normalizes confirmed ranges and builds a deterministic local
index. `useSermonPassageMatches.js` intersects the currently visible verse or
range with that index:

- a confirmed primary match appears once under **On this passage**;
- a confirmed mentioned match appears once under **Appears in**;
- a primary match is not repeated in the mentioned count; and
- suggested, malformed, withdrawn, or unpublished references never match.

`CommentarySidebar.jsx` adds compact result groups without hiding the existing
commentary controls. `SermonsForPassage.jsx` owns loading, empty, offline,
malformed-server, and result states. `SermonViewer.jsx` opens the exact cached
public revision with title, speaker, preached date, primary passage, reviewed
content, and public recording links. It may reuse presentation and media
patterns from `RemoteResourceViewer`, but never its permissive parser or a
generic fallback: exact detail-byte SHA-256, revision, identity, and
catalog/detail display metadata must all agree before render. `App.jsx` owns
stable navigation/deep-link state.

The first reader slice is read-only. Editing, adoption, source upload, and
publication remain in Community administration and SyncShow Prepare.

### 9. Add tests at each boundary

Heritage server tests should cover:

- shared golden canonical bytes and revisions;
- v1/v2 preservation and explicit upgrade-to-v3 editing behavior;
- v3 ordered-body canonicalization, exact transfer, publication demotion before
  resubmission, and public body allow-listing;
- authorization start, approval, polling, expiry, revocation, PKCE, and
  membership loss;
- scope dependency and same-origin discovery failures;
- create idempotency, conflicting create, successful update, and stale
  compare-and-swap;
- transaction rollback after each write stage;
- independent source availability without a revision/version change;
- bounded stable pagination, final cursors, restart/resume, tamper/expiry, and
  independent song/sermon lanes;
- legacy adoption without silent conversion;
- current edits that do not change `publicRevision`;
- body-only conflicting edits that preserve both exact revisions;
- publish, republish, and withdraw transactions;
- strict public projection with no private/internal fields; and
- primary/mentioned passage indexing and deduplication.

Use real PostgreSQL transaction tests for repository and cursor behavior.
Payload mocks alone cannot prove row locks, uniqueness, rollback, or restart
durability.

Heritage reader tests should cover:

- catalog/detail validation and checksum/cache behavior;
- whole-chapter and verse-range intersection;
- primary-versus-mentioned deduplication;
- malformed or unavailable sermon catalogs without breaking Bible reading;
- offline use of a previously pinned public revision; and
- sidebar-to-viewer navigation for the exact sermon revision.

Keep SyncShow's existing `test/community-sermon-*.test.js` and local sermon
tests green. Add one contract fixture test that reads the exact same golden
files used by Heritage.

## Smallest authenticated round-trip

Complete this before building broad admin or reader UI:

1. Extend the isolated branch's existing discovery route on disposable staging
   to `schemaVersion: 2`, preserve its real song resource lane, and add the
   sermon resource lane only after its endpoints pass. Reuse the existing
   device-authorization operations and require a fresh approval for the new
   sermon scopes.
2. Apply the reviewed Payload migration to a disposable PostgreSQL Community
   with one manager membership.
3. From a real SyncShow client, start device authorization, approve that named
   installation while signed in as the requested manager, poll for the
   `SyncShow` credential, and confirm the credential never enters renderer
   state or logs.
4. Explicitly push one existing local v3 sermon with a human-reviewed ordered
   body. Send its exact canonical `documentSource`; let the server initialize
   source availability from its canonical descriptors, and do not upload the
   manuscript/transcript bytes.
5. List from an empty sermon cursor, GET the returned stable ID, and verify that
   the downloaded canonical bytes and SHA-256 revision are byte-for-byte equal
   to the local source.
6. Edit only the body on both sides, update once with the observed `If-Match`,
   then repeat from the stale version and prove the server rejects the stale
   write while preserving both exact bodies for conflict review.
7. Persist the returned final cursor, restart both server and SyncShow, pull
   again, and prove there is no loss, duplicate replay, or cross-advance of the
   song cursor.
8. Disconnect the network and prove the exact sermon remains linked in the
   prepared service and Load/Show remain usable.

Only after that private authenticated round-trip passes should the team approve
one exact revision for public projection, refresh the Content Server catalog,
and prove the Heritage reader shows it under both the intended primary and
mentioned passage queries.

## Verification boundaries and release gates

These gates are deliberately separate:

Current isolated history evidence is:

- focused sermon endpoint tests: 11/11;
- history migration tests: 5/5;
- complete Community contract suite: 171/171, including manager-review and
  disposable-database/CI wiring guards;
- a dedicated PostgreSQL 17 cluster applied all 13 migrations and passed the
  schema-v2 linked-plan relationship, lifecycle, scoped reads, drift,
  exact-byte terminal retention, refusal, and cleanup;
- earlier disposable runs cover the song-link lifecycle and tenant isolation
  plus actual history up/down/up with fail-closed destructive downgrade,
  transactional failure for an unreconstructable upgrade, and rejection of
  `payload.delete({ overrideAccess: true })` while retaining the bytes;
- two isolated CI database jobs are now defined and statically covered, but the
  hardened workflow still needs its first GitHub Actions run; and
- clean type checking and generated Payload types, plus TypeScript and JSON
  artifacts for the sermon-history migration and additive schema-v2 reading
  migration.

Separate SyncShow-local retention evidence is 20/20 focused tests plus 102/102
surrounding storage/transaction tests, including historical references,
transaction recovery, stale plans, missing/corrupt evidence, symlinks, bounded
scans, unsafe permissions, and rollback. It does not exercise Heritage
PostgreSQL records or modify a live SyncShow profile.

The live test used a separate disposable cluster and did not touch a shared
database. This evidence proves the isolated storage/application contract only;
it does not prove a production migration, church-data backup/restore, packaged
SyncShow authorization, deployed browser/phone behavior, or venue operation.

| Gate | What it proves | What it does not prove |
| --- | --- | --- |
| SyncShow unit/fixture tests | Local packet, wire validation, manual pull/push policy, guarded conflict preservation, and exact pure v2 projection bytes/checksums | Heritage auth, storage, transactions, served routes, or reader behavior |
| Heritage validator tests | Cross-runtime canonical bytes, revisions, and bounds | PostgreSQL atomicity or deployed authorization |
| Real PostgreSQL integration | CAS, uniqueness, idempotency, rollback, durable cursor, current/public separation, exact source retention, and fail-closed history migration | Browser approval, packaged desktop credentials, production data, or public reader UI |
| Authenticated staging round-trip | Discovery, manager approval, real token, one exact push/pull/update/conflict/restart | Public publication or source-byte transfer |
| Heritage public-projection integration | One exact approved `publicRevision`, strict allow-list, checksum, atomic passage rows, and served catalog/detail/index | Signed-in Community editing or private attachments |
| Heritage reader smoke | Cached catalog, **On this passage**, **Appears in**, exact viewer, and offline fallback | Venue projection, audio quality, or website publication |
| Packaged/venue checks | Protected credentials on each OS and no dependency in Prepare/Load/Show | Server correctness not exercised by that check |

Do not describe sermons as integrated end-to-end until the authenticated staging
round-trip and public reader smoke both pass. Private source-byte endpoints,
recording ingestion/upload/transcoding, website publication, remote service planning,
cross-platform packaging, and physical-venue presentation are later,
independent milestones.
