# Community song public-link contract

Status: active cross-application contract. The current SyncShow worktree
implements strict protocol-v2 discovery, scoped device-grant migration,
bounded client operations, a separate exact-family permission-review audit
lane, and trusted main-process list/create/copy/revoke orchestration. The
real Heritage branch `codex/syncshow-community-integration` now advertises the
resource and implements its transactional management API, immutable snapshot
store, anonymous bearer route, admin revocation, migration, tests, and
disposable PostgreSQL runtime coverage. The complete Community contract suite
passes 171/171, but the branch remains uncommitted, unmerged, and undeployed.
No production public link, packaged connected-link workflow, browser/phone, or
venue result is claimed.

This contract is separate from both:

- signed-in Community member visibility (`private`, `public`, and
  `scheduled-public` on the song record); and
- the public Heritage Content Server catalogs.

A public song link is an explicit, revocable bearer capability for one
immutable song-family snapshot. It does not make the mutable Community song
anonymous, does not change member visibility, and does not authorize later
song revisions.

## Discovery and authority

The optional protocol-v2 resource is advertised beside the song lane:

```json
{
  "integrations": {
    "syncShow": {
      "schemaVersion": 2,
      "apiBaseUrl": "/api/community/syncshow/v1",
      "deviceAuthorization": true,
      "resources": {
        "songs": {
          "schemaVersion": 1,
          "endpoint": "songs",
          "scopes": [
            "syncshow:songs:read",
            "syncshow:songs:write"
          ]
        },
        "songPublicLinks": {
          "schemaVersion": 1,
          "endpoint": "song-public-links",
          "publicBaseUrl": "/community/songs/shared/",
          "scopes": [
            "syncshow:song-public-links:read",
            "syncshow:song-public-links:write"
          ]
        }
      }
    }
  }
}
```

`songPublicLinks` is valid only when `resources.songs` is present. Scope
dependencies are:

- public-link read requires song read; and
- public-link write requires public-link read and song read.

Public-link write deliberately does not require song write. A church may allow
someone to manage links for an already reviewed song without allowing that
person to replace lyrics.

Existing grants do not inherit either public-link scope. A newly advertised
lane remains unavailable until a manager reconnects and explicitly approves
it. Effective authority remains the exact intersection of the saved grant and
the server's current advertisement. Withdrawing this lane disables
list/create/copy/revoke without disabling song or sermon synchronization.
Already issued links may still work until they are revoked through Community
admin, so the downgrade warning must say that plainly.

The management `endpoint` is pinned under the same advertised SyncShow API
namespace. `publicBaseUrl` is pinned to the same Community origin, must use
HTTPS except on an explicit loopback development origin, has no credentials,
query, or fragment, and is normalized with one trailing slash. Redirects are
not followed.

## Separate permission review

Member-sharing reviews have fixed scope `community-members`. Public-link
reviews have fixed scope `public-link`; neither normalizer accepts the other's
record.

```json
{
  "scope": "public-link",
  "basis": "direct-permission",
  "evidence": "Written permission covering anonymous web display.",
  "validUntil": "2027-07-28",
  "validThrough": "2027-07-29T06:59:59.999Z",
  "reviewedAt": "2026-07-28T19:00:00.000Z",
  "familyRevision": "64-lowercase-hex"
}
```

Supported bases are:

- `public-domain`;
- `original-work`;
- `specific-web-license`;
- `direct-permission`; and
- `other-reviewed`.

Every basis requires nonempty evidence because the audience is anyone who
possesses the link. A CCLI or SongSelect number is not a public-link basis and
is never interpreted as blanket anonymous redistribution permission.

`familyRevision` is SHA-256 over the canonical ordered
`documentId:documentRevision` lines for the exact original and every linked
translation. The review digest is SHA-256 over its fixed scope, basis,
evidence, validity date, exact UTC validity boundary, review timestamp, and
family revision. Evidence and review records remain private management data
and never enter the anonymous response.

`validUntil` is optional and inclusive through the end of that operator's
local calendar day. `validThrough` is the canonical UTC instant for that exact
local end-of-day boundary; it is generated and retained by SyncShow's main
process, is `null` exactly when `validUntil` is `null`, and participates in the
review digest. The Community server must enforce this exact instant and must
not reinterpret the calendar date in its own host or container time zone.
Legacy dated reviews without `validThrough` remain local audit evidence but
cannot authorize another link until a manager reviews the family again.

Link expiration is also optional. If the review is dated, the link must have a
finite expiration no later than `validThrough`. A non-expiring link therefore
requires a non-expiring review.

### Shared digest fixture

The two runtimes lock the permission-review digest with byte-identical copies
of `song-public-link-review-v1.json`:

- SyncShow:
  `test/fixtures/song-public-link-review-v1.json`
- isolated Heritage:
  `.tmp-heritage-patches/heritage-syncshow-integration/community-server/tests/fixtures/song-public-link-review-v1.json`

The fixture files have SHA-256
`0dbc18b0691953637eb47febd383b7612774a89050f72d53405d091b6cb3ff63`.
Their exact review normalizes to:

```json
{
  "scope": "public-link",
  "basis": "direct-permission",
  "evidence": "Written permission for anonymous web display.",
  "validUntil": "2026-08-31",
  "validThrough": "2026-09-01T06:59:59.999Z",
  "reviewedAt": "2026-07-28T19:00:00.000Z",
  "familyRevision": "31a348ab72148920ed96e74408d63edcb1d45c523f130cc603a670261b11e650"
}
```

Both implementations must produce review revision
`50621b8ffc88d2fae202a2d610508ee95f49b5634df6aa397acba39d701f37e0`.
Changing the fixture, normalization, date boundary, field order, or digest
algorithm requires an explicit schema-version decision and matching
cross-runtime tests; one runtime must never silently accept a different
digest.

## Link record

The authorized management API returns exactly this record:

```json
{
  "schemaVersion": 1,
  "linkId": "at-least-192-bits-of-base64url-entropy",
  "linkVersion": 1,
  "songSyncId": "amazing-grace",
  "songSyncVersion": 7,
  "familyRevision": "64-lowercase-hex",
  "reviewRevision": "64-lowercase-hex",
  "label": "Tuesday home group",
  "createdAt": "2026-07-28T19:00:01.000Z",
  "expiresAt": null,
  "revokedAt": null
}
```

The record is strict and bounded. `linkId` is a server-generated base64url
value of at least 192 bits and is the unguessable bearer path component.
SyncShow rejects noncanonical base64url encodings and decoded values shorter
than 24 bytes; the server remains responsible for cryptographically random
generation rather than merely returning a long string.
`linkVersion` advances monotonically on revocation. Canonical timestamps use
UTC ISO strings with milliseconds. `label` is optional private operator
metadata and is never shown anonymously.

The server never returns a free-form URL field. After validating discovery and
the record, SyncShow derives the copyable URL as
`publicBaseUrl + encodeURIComponent(linkId)`. The renderer never supplies,
constructs, or authorizes a URL. Main holds the normalized URL behind a
short-lived opaque action token and performs clipboard writes itself.

## List

```http
GET /api/community/syncshow/v1/song-public-links?songSyncId=<id>&cursor=<opaque>&limit=1..50
Authorization: SyncShow <token>
```

```json
{
  "items": [],
  "nextCursor": null,
  "hasMore": false
}
```

Every returned record must belong to the requested `songSyncId`. Pages and
cursors are bounded and must advance. A page must not repeat a `linkId`, and
the bounded desktop aggregation rejects the same identity across pages.
SyncShow fetches at most four 50-record pages; if more than 200 records remain,
it directs the operator to Community admin instead of silently truncating the
history. The renderer accepts the same 200-record bound. Active, expired, and
revoked records may remain in management history; only an active, unexpired
record produces a copyable URL.

Listing and revocation remain available during a song-content conflict.
Creating another link does not.

## Create

```http
POST /api/community/syncshow/v1/song-public-links
Authorization: SyncShow <token>
Idempotency-Key: <main-owned-random-operation-key>
If-Match: "song:<songSyncId>:<songSyncVersion>"
Content-Type: application/json
```

```json
{
  "songSyncId": "amazing-grace",
  "familyRevision": "64-lowercase-hex",
  "review": {
    "scope": "public-link",
    "basis": "direct-permission",
    "evidence": "Written permission covering anonymous web display.",
    "validUntil": null,
    "validThrough": null,
    "reviewedAt": "2026-07-28T19:00:00.000Z",
    "familyRevision": "64-lowercase-hex"
  },
  "reviewRevision": "64-lowercase-hex",
  "label": "Tuesday home group",
  "expiresAt": null
}
```

The server transaction must:

1. recheck the installation's current link-write and song-read grant;
2. load the current song under the supplied ETag;
3. parse every canonical song document;
4. recompute and compare the exact family revision;
5. validate the fixed public-link review scope, evidence, digest, and lifetime;
6. store an immutable snapshot of the exact documents and permitted public
   fields;
7. create the high-entropy link record; and
8. commit the snapshot, link, and private audit event atomically.

The response is `{ "link": <record> }` with HTTP 200 or 201. SyncShow rejects
success unless the song ID/version, family hash, review hash, label, and expiry
all echo the exact request and the link is active.

The idempotency key is required. Replaying the same key and identical operation
returns the original result. Reusing it with different content conflicts. A
stale song ETag returns 412. Creation is online-only; it is never placed into
the offline song-sync queue.

SyncShow retains the canonical intent, confirmed review and digest, remote
song version, and main-owned idempotency key when a create response is
ambiguous after the POST begins. The renderer locks those fields and offers
**Retry same link request**; refreshing the server list does not abandon that
recovery proposal. A retry sends the exact same body, review revision, ETag,
and key, including the first request's retained `validThrough` instant even if
the workstation time zone changes before the retry. Confirmed success consumes
the proposal, as does a definitive failure
before or from the request. The current desktop recovery proposal is bounded
to 15 minutes, so the server's durable idempotency record must cover at least
that complete retry window plus an in-flight request.

Multiple independently labelled and revocable links may pin the same family
revision. Editing the song does not retarget them. SyncShow shows an older
version warning when a link's family hash no longer matches the current local
family.

## Revoke

```http
DELETE /api/community/syncshow/v1/song-public-links/<linkId>
Authorization: SyncShow <token>
Idempotency-Key: <main-owned-random-operation-key>
If-Match: "song-public-link:<linkId>:<linkVersion>"
```

The response is `{ "link": <record> }` with an advanced `linkVersion` and a
canonical non-null `revokedAt`. A stale link ETag returns 412. The server makes
revocation idempotent under the operation key.

SyncShow reports success only after this response validates. A network failure
must say that the link may still work; it is never represented as a queued or
completed revocation. Revocation does not delete the song, change signed-in
member visibility, or resolve a song-content conflict.

## Anonymous route

```http
GET /community/songs/shared/<linkId>
```

This route requires no Community session because possession of the
high-entropy path is the capability. It serves only the pinned immutable
family snapshot and its reviewed public fields. It must exclude:

- review basis, evidence, reviewer, and private audit events;
- Community account, member, role, and installation data;
- mutable current-song pointers;
- private notes, local paths, source attachments, and unrelated translations;
  and
- any other song, sermon, service, or admin record.

Responses should use `Cache-Control: private, no-store` and
`X-Robots-Tag: noindex, nofollow, noarchive`. Logs and telemetry must redact
the bearer path. Unknown links return 404; expired or revoked links return an
unavailable response without leaking the pinned lyrics. The public page may
offer ordinary accessible reading and printing, but must not expose a
directory or enumeration endpoint.

## Trusted desktop boundary

The renderer receives only:

- a main-minted review proposal plus safe exact-family manifest;
- normalized management rows after an explicit list/create action; and
- short-lived opaque action tokens for Copy and Revoke.

It never supplies the authoritative family ID/hash, remote song version,
review timestamp/digest, link ID/version, idempotency key, or URL. Main
re-resolves the local family, fetches the exact live remote family, rechecks
connection identity and effective scopes, compare-and-swaps the separate local
review record, and sends the management request.

Changing the local draft invalidates only an open create proposal. Existing
links keep their immutable snapshot and remain explicitly copyable/revocable.
An ambiguous in-flight create is kept as a locked recovery proposal rather
than silently replaced with a new key.

If discovery withdraws public-link read access, main clears every in-session
proposal and action token and immediately publishes the changed status. A
management response of 401, 403, or 410 enters reconnect-required state and
clears the same authority. The renderer treats those authorization failures,
reapproval-required read loss, and an unavailable link lane as secret-purge
events: it removes displayed bearer URLs, opaque actions, and review state and
closes the dialog instead of preserving stale protected rows. Ordinary network
errors may preserve a previously confirmed list with an explicit stale-state
warning because current read authority has not been disproved.

## Heritage implementation and proof gates

Heritage migration `20260729_010500_syncshow_song_public_links` adds the link,
snapshot, audit, and idempotency storage in the isolated worktree. It has not
run against the church's production database.

The isolated Heritage worktree now covers the server structure that this
contract requires:

1. protocol-v2 discovery and explicit device-scope approval for both link
   scopes;
2. transactional link, immutable snapshot, audit, and idempotency records with
   song/link ETag checks;
3. bounded authorized list/create/revoke routes;
4. the anonymous same-origin reader route with a strict public projection;
5. admin revocation independent of SyncShow; and
6. retained history that never silently retargets an issued link.

Local and disposable-database evidence covers first creation and identical
idempotent replay, changed-body idempotency conflict, stale song/link ETags,
the shared digest fixture, immutable output after song edits, multiple
independent links, expiration and revocation denial, anonymous-field
redaction, tenant/scope checks, and durable record loading through the Payload
runtime.

Before this can be called deployed or production-live, still prove:

- review, merge, migration, backup, and deployment through the normal Heritage
  release path;
- real packaged SyncShow authorization and explicit reapproval for both link
  scopes against the deployed server;
- create, ambiguous-response retry, list, copy, restart, revoke, and admin
  revoke against the deployed database;
- role loss and withdrawn scopes disabling management while already issued
  links behave exactly as warned;
- deployed HTTPS and proxy behavior without redirects or bearer-path leakage
  in application, proxy, analytics, or error logs;
- anonymous response headers and absence of review evidence in the actual
  served bytes;
- expiry and revocation denial after process/container restart; and
- accessible browser reading and printing at real desktop and phone widths.

Local client tests, disposable PostgreSQL coverage, and rendered UI checks do
not substitute for those packaged, authenticated, deployed, browser, phone,
monitoring, backup, and recovery proofs.
