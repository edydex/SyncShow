# Community sermon synchronization contract

Status: active additive protocol contract. SyncShow implements the local
v1/v2/v3 sermon model, independent resource-lane discovery, capability/store
migration, bounded wire validation, explicit v3 body transfer, and body-aware
conflict preservation/review described here in the current worktree. The
real Heritage branch `codex/syncshow-community-integration` implements the
corresponding authenticated server, manager publication, public projection,
passage index, reader, and immutable private sermon-change authority. The
complete Community contract suite passes 171/171, but the branch remains
uncommitted, unmerged, and undeployed. A target that does not actually advertise
the sermon resource remains unsupported; SyncShow must not simulate a
successful upload.

This contract is separate from the public Heritage Content Server protocol.
Community owns editable, authenticated church state. The Content Server exposes
only a generated public projection after editorial approval.
The synchronization target is the direct authenticated Heritage Community API,
not PagesDB or another static-content publisher.

## Discovery and compatibility

Protocol-v1 discovery remains unchanged for older song servers and clients:

```json
{
  "integrations": {
    "syncShow": {
      "schemaVersion": 1,
      "apiBaseUrl": "/api/community/syncshow/v1",
      "deviceAuthorization": true,
      "songLibrary": true,
      "scopes": [
        "syncshow:songs:read",
        "syncshow:songs:write"
      ],
      "resources": {
        "sermons": {
          "schemaVersion": 1,
          "endpoint": "sermons",
          "scopes": [
            "syncshow:sermons:read",
            "syncshow:sermons:write"
          ],
          "sourceObjectScopes": [
            "syncshow:sermon-sources:read",
            "syncshow:sermon-sources:write"
          ]
        }
      }
    }
  }
}
```

In protocol v1, root `songLibrary`, `scopes`, and `endpoints.songs` remain the
song contract. Current SyncShow clients normalize those root fields internally
to the same `resources.songs` descriptor used by protocol v2. Old clients
ignore `resources.sermons` and continue to synchronize songs.

Protocol v2 makes song and sermon lanes independently honest:

```json
{
  "integrations": {
    "syncShow": {
      "schemaVersion": 2,
      "apiBaseUrl": "/api/community/syncshow/v1",
      "deviceAuthorization": true,
      "endpoints": {
        "deviceStart": "auth/device/start",
        "deviceStatus": "auth/device/status",
        "deviceToken": "auth/device/token",
        "deviceCancel": "auth/device/cancel",
        "revoke": "auth/revoke"
      },
      "resources": {
        "songs": {
          "schemaVersion": 1,
          "endpoint": "songs",
          "scopes": [
            "syncshow:songs:read",
            "syncshow:songs:write"
          ]
        },
        "sermons": {
          "schemaVersion": 1,
          "endpoint": "sermons",
          "scopes": [
            "syncshow:sermons:read",
            "syncshow:sermons:write"
          ],
          "sourceObjectScopes": [
            "syncshow:sermon-sources:read",
            "syncshow:sermon-sources:write"
          ]
        },
        "sermonPublications": {
          "schemaVersion": 1,
          "endpoint": "sermon-publications",
          "scopes": [
            "syncshow:sermon-publications:read"
          ]
        }
      }
    }
  }
}
```

`resources.songs` and `resources.sermons` are each optional in protocol v2,
but at least one supported lane is required. `resources.sermonPublications` is
an optional read-only status lane and is valid only beside
`resources.sermons`. It lets SyncShow distinguish a saved Ready revision from
the exact public pointer; it grants no publish or withdraw operation. A
sermon-only server omits
`resources.songs`; it does not advertise a fictional root song library. A
song-only server omits `resources.sermons`. Unknown future resources do not
create authority for a current client.

The shared device-authorization operations remain required. Protocol v2 must
advertise `deviceAuthorization: true`; the manifest may use the contract's
default auth paths or their explicitly advertised equivalents. The normalized
scope offer is the union of scopes from the lanes that are actually advertised;
a caller may request a valid subset. When a caller omits an initial scope
selection, SyncShow requests only the advertised read scopes. It never
manufactures a song scope for a sermon-only server.

Scope dependencies are strict:

- song write requires song read;
- sermon write requires sermon read;
- sermon-publication read requires sermon read;
- sermon-source read requires sermon read; and
- sermon-source write requires sermon-source read and sermon write.

Every auth and resource endpoint is resolved under the advertised same-origin
`/api/community/syncshow/v1` boundary. Song and sermon endpoints are validated
and pinned independently; one lane cannot supply or redirect the other lane's
endpoint. Redirects are not followed. SyncShow uses its dedicated
`Authorization: SyncShow <token>` credential family; it never reuses a
Community member browser session.

Existing song-only grants remain valid. Enabling sermon synchronization requires
an explicit reconnect/approval for the new scopes. Each song or sermon operation
also checks the current nested resource advertisement before its request; a
stored write grant cannot override a server that has since removed or
downgraded the resource. Effective authority is always the intersection of the
exact approved grant and the current validated advertisement. Removing one lane
disables only that lane; already approved and still-advertised lanes, plus all
local library content, remain usable. Cached protected remote conflict/status
projections require the current lane's read scope. Protocol-v2 sermon-only
discovery is therefore a valid staging contract, but a manifest shape alone
does not prove that its authorization and sermon endpoints are deployed or
working.

## Canonical sermon record

Community stores one stable SyncShow sermon ID with immutable canonical
`SermonDocument` revisions. The exact canonical JSON string, including its
trailing newline, is hashed with SHA-256. The server:

- parses and validates the document;
- verifies `document.id === syncId`;
- verifies canonical serialization byte-for-byte;
- recomputes the revision hash;
- accepts canonical v1, v2, and v3 documents;
- preserves historical v1 and v2 bytes and hashes without silent v3
  normalization;
- treats ordered v3 body entries as canonical sermon content, not as source
  objects or mutable envelope metadata;
- stores the newest canonical source on the mutable current sermon row;
- in the same transaction as every create, content update, archive, or manager
  publish that changes the canonical source, appends a private immutable change
  row containing that event's exact canonical `documentSource`, revision,
  archive flag, and monotonic version;
- retains the exact v1, v2, v3, and canonical archive sources for their
  historical versions rather than retargeting old rows to the newest source;
  and
- advances a monotonic `syncVersion` only when canonical content changes.

Payload timestamps, row IDs, or ETags are not sermon content revisions.

### Private immutable revision authority

`syncshow-sermon-changes` is the implemented private revision authority. Its
`documentSource` includes the canonical trailing newline, hashes exactly to the
row's `revision`, parses to the same `syncId`, and has a publication archive
state equal to the row's `archived` flag. The normal change-feed response
projects only the bounded summary shown below; it never returns the retained
historical source from a journal row.

The Payload collection is hidden, normally readable only by a system
administrator, and append-only:

- only the existing internal sermon transaction context may create a row;
- the collection hook rechecks exact canonical serialization, ID, SHA-256, and
  archive state before create;
- every update is rejected; and
- the unconditional `beforeDelete` hook rejects deletion even when a
  privileged Payload Local API caller uses `overrideAccess: true`.

That hook is the Payload application boundary, not a substitute for database
administration controls. Direct SQL, a migration, or a database restore remains
a privileged repair/backup boundary. The database CHECK binds each retained
source's UTF-8 SHA-256 to its revision, but a database administrator can still
act outside Payload hooks. Database backups therefore contain private canonical
sermon text and require the church's normal restricted access, retention, and
restore policy.

## Change feed

```http
GET /api/community/syncshow/v1/sermons?cursor=<opaque>&limit=1..100
Authorization: SyncShow <token>
```

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "syncId": "sermon-2026-07-26",
      "syncVersion": 7,
      "revision": "64-lowercase-hex",
      "archived": false,
      "updatedAt": "2026-07-27T18:22:03.000Z"
    }
  ],
  "nextCursor": "durable-opaque-cursor",
  "hasMore": false
}
```

Feed pages contain summaries rather than full documents. A cursor is durable
only after its page has been validated and applied. A continuing page requires
both items and a next cursor. Every page, including an empty or final page,
returns a non-null durable `nextCursor`; the client persists it only after the
entire snapshot has been validated and applied. An empty final poll may retain
the cursor it was asked for. A page containing changes must return a different
cursor so the same changes cannot be replayed forever.

A paginated snapshot is stable for its full page sequence and contains each
`syncId` at most once. The server coalesces multiple changes to the same sermon
to the latest summary in that snapshot. If the record changes after the
snapshot, its summary-to-document mismatch makes this pull fail closed and the
next durable cursor retry includes the newer change.

Song and sermon cursors are independent. Failure in one lane must not advance
the other.

## Read and write

```http
GET /api/community/syncshow/v1/sermons/{encodedSyncId}
```

```json
{
  "sermon": {
    "syncId": "sermon-2026-07-26",
    "syncVersion": 7,
    "revision": "64-lowercase-hex",
    "documentSource": "{\"schemaVersion\":3,...,\"body\":[...]}\n",
    "archived": false,
    "updatedAt": "2026-07-27T18:22:03.000Z",
    "sourceObjects": [
      {
        "sourceId": "pastor-manuscript",
        "sha256": "64-lowercase-hex",
        "sizeBytes": 338835,
        "available": true
      }
    ]
  }
}
```

`sourceObjects` has exactly one entry for every source descriptor in the
canonical document. Missing private bytes are represented as
`available: false`, not by omitting the source. Availability is mutable storage
state and does not change the sermon revision or `syncVersion`.

Create:

```http
POST /api/community/syncshow/v1/sermons
Idempotency-Key: <safe client operation id>
```

Update:

```http
PUT /api/community/syncshow/v1/sermons/{encodedSyncId}
If-Match: "sermon:<syncId>:<expectedSyncVersion>"
```

Both write bodies are self-describing:

```json
{
  "syncId": "sermon-2026-07-26",
  "revision": "64-lowercase-hex",
  "documentSource": "{\"schemaVersion\":2,...}\n"
}
```

Creating the same ID and revision is an idempotent no-op. Creating the same ID
with different content is a conflict. Updates use compare-and-swap; neither the
client nor server uses last-write-wins. A successful server transaction commits
the immutable revision, current pointer, change record, monotonic sync version,
and audit event together.

Archiving is a canonical `publication.status: archived` revision. There is no
destructive sermon-delete operation in protocol v1.

### Read-only publication state

When protocol v2 advertises `resources.sermonPublications`, SyncShow may read:

```http
GET /api/community/syncshow/v1/sermon-publications/{encodedSyncId}
Authorization: SyncShow <token>
```

The exact response wrapper is `{ "publication": <state> }`. The state contains
the stable sermon ID, current revision/version, nullable publication
version/public revision, deterministic public ID, exact detail/catalog/index
checksums, server publication time, and the selected body/media IDs. All public
projection fields are null and both selection lists are empty when there is no
active public pointer. A non-null `publicationVersion` with a null
`publicRevision` means the sermon was explicitly withdrawn; both null means it
has never been published.

`currentRevision` may differ from `publicRevision`. That is the normal,
important case where editors have created a newer Draft or Ready revision while
the older approved revision remains public. Reading this state grants no
publication authority, and SyncShow exposes only a bounded status projection
to its renderer. The authenticated response uses
`Cache-Control: private, no-store`.

Prepare may cache that bounded state for the exact selected sermon. Community
manager Publish and Withdraw actions do not emit a live event to the desktop
client, so Prepare exposes an explicit **Refresh publication status** action
whenever the selected connection advertises publication-state reads. Refresh
performs only the exact point read above. It is independent of sermon write
authority and does not publish, withdraw, list records, or mutate the local
sermon.

Every forced refresh clears the previous deployed-artifact verification result,
even when the returned publication key appears unchanged. A prior successful
**Verify publication** check is evidence for its earlier observation, not a
subscription to Community state. Refresh also is not a sermon pull: it can
report a newer `currentRevision` or `publicRevision`, but it does not import the
corresponding server-authored canonical document. In particular, a schema-2
direct-recording manager transaction may create a new canonical revision during
publication. The normal exact sermon pull/conflict workflow must bring that
revision into the local immutable library before SyncShow can locally verify its
anonymous artifacts.

`CommunitySermonPublicationConformance` is the pure receipt boundary between
that state and the anonymous artifacts. Given the exact immutable public
`documentSource`, state, detail source, complete catalog source, and complete
passage-index source, it reprojects the selected revision and rejects identity,
revision, timestamp, selection-order, detail, catalog-row, checksum, or
catalog/index drift. It validates canonical bounded sources before hashing and
requires the whole index to be the deterministic derivative of the whole
catalog. It does not prove that a response is current, authenticate a manager,
or grant publication authority. The self-contained cross-runtime vector is
`test/fixtures/community-sermon-publication-conformance-v1.json`.

Two separate pure transaction gates cover the schema-1 publication transition
without giving SyncShow publication authority:

- `CommunitySermonPublicationTransactionConformance` covers an active
  **republish**. Its prior active receipt authenticates the exact Published
  revision, detail, complete catalog, and complete passage-index bytes. It
  requires a newer public revision, a later server publication time, exact
  compare-and-swap fields, one version advance, target-only catalog
  replacement, and preservation of every unrelated catalog row.
- `CommunitySermonFirstPublicationTransactionConformance` covers a genuine
  **first publication**. Both pre-transaction publication pointers must be
  null, and the post state must advance from no publication version to version
  1. Because a never-published sermon correctly has no catalog checksum, this
  gate separately requires the exact server-owned pre/post catalog-authority
  records: schema, generation, monotonic change time, checksums, canonical
  catalog bytes, and canonical derivative passage-index bytes. The target must
  be absent before the transaction, the generation must advance exactly once,
  and the post catalog must be an exact insertion that preserves every prior
  row.

The first-publication authority records are trustworthy only when the Heritage
server reads and validates its singleton catalog row while holding the catalog
lock, regenerates the row inside the same manager-authorized database
transaction, runs the gate before commit, and supplies those internal records
directly. Accepting an authority record from an HTTP request body would not
authenticate the global before-state. The self-contained fixed vector is
`test/fixtures/community-sermon-first-publication-transaction-conformance-v1.json`.

Both gates are pure compatibility contracts and are exported only from the
Community service barrel. Main, preload, Prepare, and the deployed read-only
probe do not invoke them and expose no Publish or Withdraw operation. The
first-publication vector covers schema-1 publish intents. Heritage's schema-2
direct-recording path intentionally changes the canonical document during the
manager transaction and still needs a separate portable transition/vector
before it can claim the same cross-runtime transaction proof.

### Exact manager-review handoff

Prepare exposes **Continue in Community** only when all of these selected-state
conditions hold:

- the service is still pinned to the selected exact sermon revision;
- the active connection can read sermons;
- the Community sync state is conflict-free and `synced`;
- its saved local and remote revisions both equal the selected revision; and
- the current canonical sermon is Ready or Published.

The renderer sends only `sermonId` and `expectedLocalRevision` through the
bounded preload bridge. Main validates those two exact keys, re-resolves the
active non-expired saved connection and sermon-read scope, reads the saved sync
state, rejects any conflict or local/remote revision mismatch, then re-reads the
current local sermon and requires the same revision and Ready/Published status.
Only after those checks does Main derive
`/admin/sermon-publications?sermon=<encodedSyncId>` from the trusted saved
Community origin and ask the operating system to open it. Renderer input cannot
supply an origin, path, action, credential, document, or publication choice.
This operation makes no Community API write and exposes no Publish or Withdraw
operation; the manager still makes that separate decision in Community.

Heritage parses the optional `sermon` query in the server-rendered admin view.
An absent parameter preserves the ordinary generic review queue. A present
empty value, more than one value, or a value outside the exact SyncShow sermon
ID grammar becomes a visible refusal. For a valid target, the client first
loads the same-origin, authenticated, no-store reviewable list and selects only
when that returned list contains the identical `syncId` in Ready state or with
an active public pointer. Stale, Draft, archived, withdrawn, missing, and other
unreviewable targets remain unselected with an explicit message. Neither title
nor service date participates in resolution.

The focused local evidence is **46/46** SyncShow Main/preload/renderer contract
checks, **14/14** Heritage behavioral checks, **3/3** Heritage static wiring
checks, and a passing Heritage type check. The matching Heritage changes are
local to the server view, client, review model, and their two focused test
files. They are not deployed.

## Local synchronization rules

Sync uses exact stable IDs only. It never fuzzy-matches a sermon by title,
speaker, passage, or date.

Pull behavior:

- a missing local sermon may be hydrated after the complete remote envelope is
  verified;
- an unchanged local baseline may fast-forward by local compare-and-swap;
- if local and remote both changed after the baseline, both exact revisions are
  preserved and the sync state records a reviewable conflict; and
- a remote omission or archive never physically deletes local immutable data.

The exact remote conflict revision is staged in the immutable local sermon
library before the compact sync-state checkpoint is written. Sync state stores
only the revision, server version, timestamps, and conflict metadata—not a
second multi-megabyte copy of canonical JSON.

The server `syncVersion` must never decrease, and the same version must never
name different canonical content. A higher version may legitimately return to
an older observed revision (for example A → B → A when a client missed B), so a
revision hash alone cannot identify an empty version advance.

Push behavior:

- creating the first Community record is an explicit operator action;
- background sync does not upload every local draft;
- reviewed v3 body text crosses the network only inside that separately
  confirmed create/update of the exact canonical sermon revision;
- an update requires both the last observed `syncVersion` and the exact local
  revision the operator reviewed;
- even a locally unchanged explicit push verifies the current remote envelope
  before reporting “synced”;
- a conflict fetches and preserves the remote exact source for review; and
- canonical metadata sync does not imply private source-byte upload.

Conflict detection compares the complete canonical revision, so a body-only
local/Community divergence is a real conflict. Both exact v3 revisions remain
in the immutable local sermon library. Conflict review exposes each copy's
complete ordered body text, kind, and language, together with bounded sermon
metadata. It omits raw body/source/outline identifiers but includes a
session-keyed metadata marker so a binding-only difference remains visible. It
does not send source paths, source filenames, provenance, private bytes, or raw
attachment content to the renderer. “Keep this Mac” performs a live remote GET
followed by an exact-version PUT. “Keep Community” promotes the already
verified immutable remote revision by local compare-and-swap and performs no
network write. Both choices require the reviewed local revision and server
version; a race preserves the newer conflict instead of overwriting either
copy.

## Private source objects

Canonical v3 body text belongs in the JSON sermon envelope only after human
review. The manuscript, transcript, and presentation files from which it may
have been derived do not belong in that envelope or the existing public/member
`Media` collection. A later server slice uses revision-bound raw-byte
endpoints:

```text
HEAD /sermons/{id}/revisions/{revision}/sources/{sourceId}/object
PUT  /sermons/{id}/revisions/{revision}/sources/{sourceId}/object
GET  /sermons/{id}/revisions/{revision}/sources/{sourceId}/object
```

The exact immutable revision must contain a matching source descriptor. PUT
streams and verifies digest, byte count, and media type before publication. GET
and HEAD require the dedicated source scopes and use
`Cache-Control: private, no-store`. No local path, bearer credential, source
byte, or public object URL becomes canonical sermon data.

Source transfer is separately opt-in. A sermon may synchronize successfully
while one or more private objects remain unavailable.

## Public Heritage projection

The future server-side `publicProjection` is generated from a `published` and
`public` canonical revision. Synchronizing a v3 body does not select it for
public use. `syncshow:sermons:write` does not grant publication authority.

A publish transaction starts from one exact immutable `ready` current
revision. It compare-and-swap checks the expected sermon `syncVersion`,
`currentRevision`, prior `publicationVersion`, and prior `publicRevision`.
After a manager confirms the public audience, canonical destination, and exact
body/media selections, the server creates the eligible revision itself by
changing only:

- `publication.status` from `ready` to `published`;
- `publication.visibility` to `public`; and
- `publication.publishedAt` to the server-authored transaction timestamp.

The new canonical source, its immutable revision, the current pointer and
change/audit records, the selected public detail and checksum, the catalog
entry, confirmed passage rows, and `publicRevision` pointer commit in one
database transaction. The server re-reads the Ready base and runs the shared
projection code itself; it never accepts client-generated public bytes or
checksums as authority. Failure leaves the prior current/public pointers and
served artifacts unchanged.

The publication review includes:

- stable sermon ID and exact Ready base revision;
- localized titles and default language;
- speaker display data, exact date-only service date, and series;
- approved outline titles;
- confirmed primary and mentioned canonical references;
- explicitly approved ordered v3 body/transcript entries; and
- public, ready media URLs.

Every Ready or public media URL must be stable public HTTPS: it has no
credentials, query string, fragment, IP literal, private/reserved hostname, or
nonstandard port. A recording URL must also have a non-root file path and must
not end at a directory. SyncShow does not infer stability from a provider name
and does not test network reachability. Temporary, signed, or query-bearing
links may be retained in a Draft canonical document so they can be reviewed or
replaced, but they do not satisfy Ready eligibility and the strict public
projection rejects them. These checks intentionally match the Heritage public
sermon boundary before a manager chooses media.

The manager transaction intent is an exact versioned record. Publish binds
`syncId`, `expectedSyncVersion`, `expectedCurrentRevision`, nullable prior
`expectedPublicationVersion`/`expectedPublicRevision`, the selected body/media
IDs, and explicit `publicAudienceConfirmed` plus `canonicalLinkConfirmed`
booleans. Withdraw is a different exact shape containing the same identity and
CAS fields but no selections or publish confirmations; it requires an active
prior publication version and public revision. Unknown fields fail closed.
These records authorize an internal Community transaction only when paired
with the authenticated manager action; their existence in shared validation
code is not an HTTP publish capability for SyncShow.

It excludes private source descriptors and bytes, filenames, provider
provenance, suggested references, internal offsets, draft/member/unlisted
documents, device/account data, and pending media.

That allow-list projection and its body-entry approval rules are implemented in
the isolated Heritage worktree, but are not merged or deployed. SyncShow's
explicit sermon save is an authenticated canonical synchronization action, not
proof of public publication.

Withdrawing is a separate manager transaction guarded by the expected
publication version and public revision. It clears the public pointer,
projection, and passage rows without deleting either the immutable published
revision or audit history. Editing the current sermon never implicitly
withdraws or republishes the older public revision.

Catalog items carry confirmed canonical reference ranges so Heritage can build
“On this passage” and “Appears in” indexes without downloading every sermon.
Primary matches suppress duplicate mentioned matches.

The public Content v2 item ID must satisfy its lowercase ID grammar. A
deterministic ID such as `sermon-<sha256(syncId)>` may be used while the exact
SyncShow `sermonId` remains a separate field.

The manager-approved public projection, passage-index reader, and strict public
sermon viewer are implemented locally. Authenticated member-only or private
sermon reading remains a separate, undeployed slice; an anonymous resource
fetch must never be presented as that authority.

## Legacy Heritage sermon migration

The existing Heritage sermon collection remains a legacy/public editor until a
manager explicitly adopts a row:

- add nullable stable sync ID, sync version, current revision pointer, and
  distinct public revision pointer;
- after explicit adoption, store every canonical change's exact source in the
  append-only private sermon-change journal rather than inventing history for
  the legacy row;
- keep unadopted numeric URLs working;
- never fuzzy-merge by title/date;
- require human confirmation when converting timestamp `preachedAt` to a
  date-only service date;
- retain legacy free-text Scripture as suggestions only; and
- keep a legacy published page live until its canonical adoption is reviewed.

The manager must confirm a primary canonical passage before an adopted sermon
can become a canonical `ready` or `published` record.

## Migration ledger and fail-closed history backfill

The isolated Heritage integration adds eight ordered migrations to the five
pre-integration migrations, for a clean 13-migration chain:

1. `20260725_160000_syncshow_song_library`
2. `20260728_234856_syncshow_sermon_roundtrip`
3. `20260729_002359_syncshow_sermon_publications`
4. `20260729_005039_service_plans`
5. `20260729_005827_sermon_passage_index`
6. `20260729_010500_syncshow_song_public_links`
7. `20260729_045710_syncshow_sermon_change_sources`
8. `20260729_130000_service_plan_sermon_readings`

The seventh, sermon-history migration follows the public-link migration. It
first stages a nullable journal `document_source`, then backfills only a row
whose community, sermon, stable sync ID, revision, and archive state all exactly
match the current sermon. PostgreSQL 17 must reproduce the revision SHA-256; the
stored JSON ID and publication archive status must agree; and the shared
TypeScript parser/serializer must accept the exact canonical source before any
schema change is made.

If the shared parser rejects a candidate as noncanonical, upgrade aborts before
the schema changes. After the nullable staging/backfill, any row still lacking
an exact source raises SQLSTATE `23514` and the transactional migration leaves
no partial authority. Only after every row passes does the migration set the
source `NOT NULL` and add the source/revision SHA-256 CHECK. Downgrade likewise
raises `23514` before dropping the only historical-source column if any journal
source is no longer exactly reconstructable from the current sermon. Therefore
an empty journal or an all-current journal can roll back; a journal containing a
distinct retained revision cannot be destructively downgraded.

The eighth migration adds only the nullable service-plan sermon relationship
and stable reference ID, a `SET NULL` sermon foreign key, and one index. It
performs no backfill and does not rewrite retained schema-v1 canonical plan
bytes.

## Server acceptance boundary

The integration is not complete until a real authenticated round trip passes:

1. create a local reviewed sermon;
2. explicitly upload its exact canonical v3 revision, including reviewed body
   text but excluding private source bytes, to Community;
3. exercise a real compare-and-swap body-only conflict and inspect both ordered
   bodies before resolution;
4. restart and pull from a durable cursor while offline fallback remains usable;
5. generate the filtered public projection; and
6. verify Heritage “On this passage” and “Appears in” results.

Package tests, mocked HTTP fixtures, and local source extraction do not replace
that server/reader contract check.

Current isolated source/runtime evidence is narrower than that acceptance
boundary: the focused sermon endpoint suite passes 11/11, the history-migration
suite passes 5/5, and the complete Community contract suite passes 171/171
tests, including ordinary manager-review and live-CI safety coverage. A
dedicated PostgreSQL 17 cluster applied all 13 migrations and passed the real
schema-v2 relationship, Draft → Ready → Archived, scoped list/get, drift,
exact-byte retention, terminal refusal, and cleanup lifecycle. Earlier
disposable runs also passed the song-link and sermon-history cases. The payload
cases now self-seed through the real transactional sermon endpoint on one
migrated database, while the table-dropping history case is guarded and
assigned a different fresh database. Static wiring checks pass, but these
hardened GitHub Actions jobs have not run yet. Type checking, generated Payload
types, and migration diff checks also pass, and the sermon-history migration
has both TypeScript and JSON artifacts. This is not a merged or production
migration, authenticated packaged-client test, deployed browser/phone smoke,
backup/restore rehearsal on church data, or venue validation.
