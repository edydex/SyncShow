# Community service-plan contract

Status: active Community-read-only intake contract. SyncShow implements
discovery, strict parsing, review, local import, and reviewed three-way
reconciliation of newer Ready revisions in the current worktree.
Heritage implements the manager editor, lifecycle, migration, scoped list/get
API, and disposable-PostgreSQL runtime coverage on the real
`codex/syncshow-community-integration` branch in `heritage_study_bible`. The
work is still uncommitted, unmerged, and undeployed. A current-source ordinary
Apple Silicon package now passes the structural/runtime gates. For isolated
schema-v2 Prepare QA, a disposable copy changed only its bundle identifier and
was re-signed while retaining the exact packaged app.asar. The rundown names
the sermon, translation, and cue position, while the selected read-only
exact-packet card names the sermon, confirmed primary passage, and selected cue
without raw IDs or relationship editing. This is not authenticated deployed
Community, browser/phone, or physical-venue evidence.

The service plan is an ordered planning handoff, not a synchronized
`ServiceProject` or a remotely runnable show. Community owns the shared plan.
SyncShow reads one reviewed revision and creates a local editable project from
exact resources on that computer. When an otherwise eligible Ready plan is
blocked only because referenced songs or sermons are absent locally or older
than their plan pins, the operator may first run one explicit
Community-read-only preparation action for those exact records. That action
may update the exact local song or sermon libraries but cannot write
Community. Show remains offline-capable, and Community never receives
SyncShow cues, layouts, output settings, local paths, or ShowPackages through
this lane.

## Discovery and authority

Protocol-v2 discovery advertises the optional resource independently:

```json
{
  "integrations": {
    "syncShow": {
      "schemaVersion": 2,
      "apiBaseUrl": "/api/community/syncshow/v1",
      "deviceAuthorization": true,
      "resources": {
        "servicePlans": {
          "schemaVersion": 2,
          "endpoint": "service-plans",
          "scopes": [
            "syncshow:service-plans:read"
          ]
        }
      }
    }
  }
}
```

The only service-plan scope is `syncshow:service-plans:read`. There is no
SyncShow write scope or service-plan write endpoint. Existing device grants do
not inherit a newly advertised scope; a manager must reconnect the
installation and approve the added access. Effective authority is always the
intersection of the stored grant and the server's current advertisement.
Withdrawing the resource or scope disables only service-plan browsing, review,
preparation, and import. It does not disable song or sermon synchronization
and does not damage an already imported local project.

The endpoint is resolved under the advertised same-origin SyncShow API base.
SyncShow rejects cross-origin, credential-shaped, writable, redirecting, or
otherwise unsafe descriptors. The Community access token stays in Electron
main and is never supplied to the renderer or written into a ServiceProject.

A service-plan resource advertising schema 1 may return only schema-v1 plan
documents. A resource advertising schema 2 may return schema-v1 or schema-v2
documents so existing retained plans remain readable. SyncShow fails closed
with `SERVICE_PLAN_SCHEMA_MISMATCH` when a schema-1 descriptor returns a
schema-v2 plan.

## Manager-owned planning model

Community managers create plans in Payload admin under **Planning → Service
plans**. The ordinary path is:

1. Create or edit the plan as **Draft**.
2. Select ordered section, song, Scripture, and sermon rows.
3. Save Draft to capture the current song and sermon pins.
4. Review the exact order and resources.
5. Mark the plan **Ready**.
6. In SyncShow, review the Ready plan and explicitly import it.

The server owns the stable plan ID, stable row IDs, synchronization version,
resource pins, canonical source, revision, and change timestamp. Those fields
are hidden from ordinary editor writes. A plan belongs to exactly one
Community, and selected songs and sermons must belong to that same Community.
Plans cannot be physically deleted through normal collection access.

The four lifecycle states are:

| Status | Manager meaning | SyncShow behavior |
| --- | --- | --- |
| `draft` | Still being prepared. | May be listed and reviewed, but import is blocked. |
| `ready` | Reviewed against the saved current resource pins. | Eligible for explicit local review/import. |
| `archived` | Completed and retained for history. | Import is blocked; existing local projects remain. |
| `cancelled` | The service will not take place. | Import is blocked; existing local projects remain. |

Moving to `archived` or `cancelled` preserves the exact canonical
`documentSource`, content revision, entries, and pins while advancing lifecycle
metadata. Content cannot be edited while a plan is terminal. Restore it to
Draft and save that lifecycle change before changing content; a terminal plan
cannot move directly back to Ready.

## Reviewed reconciliation of an imported revision

Community remains the owner of the shared plan, but it never overwrites an
already imported local project automatically. When the same Community plan ID
has a different Ready revision, **Check Community revision** builds the exact
local candidate and compares three exact states:

- **BASE** — the portable projection stored with the prior import;
- **Local** — the current editable project, including church-created cues and
  presentation treatments; and
- **Community** — the newly resolved Ready candidate.

Uncontested local work and uncontested Community changes merge automatically.
Every real collision is shown as an ordered Local/Community choice with no
default selection. The operator must decide every conflict and then confirm
the complete result before **Apply reviewed update & open Planning** becomes
available. Retained schema-v2 projects and schema-v3 projects carrying the
older baseline-v1 projection use a visibly separate whole-project legacy
fallback; that path requires an explicit Community choice and upgrades the
saved project to the component-aware baseline-v2 contract.

That confirmation is a short-lived main-process authority bound to all of:

- the Community connection and server identity;
- the active venue profile and output-channel contract;
- the exact remote plan ID, synchronization version, canonical revision,
  lifecycle, timestamp, and source bytes;
- the prior and candidate baseline hashes, deterministic provisional merge
  hash, exact ordered conflict set, and reviewed choices; and
- the current local project ID and immutable revision checksum.

Applying the confirmation performs another exact point read and local candidate
review. The server document must still be the identical Ready envelope, the
candidate must still be unblocked, and the local project must still be at the
reviewed revision. The save uses that local revision as a compare-and-swap
precondition. A changed connection, profile, remote plan, local project,
resource check, lifecycle, expired token, or replay fails without replacing
anything and requires a fresh check.

A successful reconciliation keeps the same stable local project ID, saves one
new immutable local history revision, makes it the current editable project,
resets its planning lifecycle to **Planning**, and opens it in Prepare. It
preserves compatible local-only items, notes, presets, song arrangements,
Scripture snapshots, and nested structure. Community additions, removals,
moves, titles, pins, and metadata apply when Local did not independently
change the same semantic component. Same-item edits, delete-versus-edit,
incompatible moves/orders, kind changes, sermon/song pin changes with local
work, and whole deleted subtrees require explicit decisions. A Community move
into a locally deleted section follows that section decision, so Keep Local
retains the item's local parent while Use Community restores the section and
its exact remote placement. When the same content-addressed resource or asset
ID carries locally reviewed metadata, a locally selected cue retains that local
provenance instead of accepting an unrelated remote overwrite. If a locally
created group independently collides with the stable ID of a new Community
group or leaf, one explicit choice selects the complete local or Community
subtree, including its source-exact parent and sibling order; descendants from
the rejected side are not silently mixed in. The same placement binding applies
to a new leaf-versus-leaf identity collision. If a shared identity sits inside
the colliding subtree on only one side but still exists elsewhere on the other,
the update fails closed instead of deleting, lifting, or hybridizing it.
Choosing **Keep Local** for a group collision stores that root as a bounded,
sorted local collision boundary. If a later Community revision changes the
competing item, placement, or subtree, SyncShow reopens the same complete
Local/Community subtree choice instead of treating the unrelated Community
shape as an uncontested BASE update. Choosing **Use Community** or observing
that the remote identity has disappeared clears the boundary. The marker is
strictly normalized with the local project, is bound by the project revision
and reconciliation receipt, and is never uploaded as Community plan content.
If otherwise valid placement choices must be collapsed to avoid a cycle, the
single combined review continues to disclose any complete collision subtree,
side-only descendants, content replacement, or deleted-subtree restoration
that the choice also controls.

Sermon revision changes are atomic across every compatible owner and linked
reading that shares the immutable resource. Duplicate service occurrences with
explicit row ownership are supported. Overlapping revision graphs that cannot
be reproduced deterministically fail closed. Replacing a row with a genuinely
different sermon is a scoped content replacement rather than a global repin;
local sermon/Scripture work shares one choice, and accepting Community clears
stale source-body receipts only for cues whose resolved owner is the replaced
managed sermon row; an independently linked nested sermon keeps its valid
receipt even when it pins the same immutable resource. Section-to-leaf changes
lift retained local children to the nearest surviving group, and independently
valid moves that would compose into a cycle become one whole-structure choice.

The saved schema-v3 project includes a bounded, checksummed
`lastReconciliationReceipt` containing the prior/candidate plan revisions,
prior/candidate projection hashes, actual merge-result hash, previous local
revision, exact conflict decisions, and application time. The receipt is
excluded from the semantic merge hash, while immutable project history keeps
the prior active revision. This action does not publish a ShowPackage, alter
the current prepared service in Load, replace a package already in Load, write
Community, or interrupt Show.

## Canonical documents

Schema v1 remains supported byte-for-byte. It has no Scripture relationship
field. Schema v2 adds exactly one field to every Scripture row:
`sermonReading`. It must be either `null` or an exact forward relationship.
New manager saves emit schema v2; terminal v1 audit records retain their
original source and revision instead of being silently upgraded.

A linked schema-v2 document has exact fields:

```json
{
  "schemaVersion": 2,
  "kind": "syncshow-community-service-plan",
  "id": "service-4ffac0c6-25c6-4cf7-86c4-98f5478f1a8e",
  "title": "Sunday Morning Service",
  "serviceDate": "2026-08-02",
  "startTime": "10:30",
  "teamNotes": "Sound check at 9:45.",
  "entries": [
    {
      "id": "entry-welcome",
      "kind": "section",
      "title": "Welcome"
    },
    {
      "id": "entry-song",
      "kind": "song",
      "title": "Communal singing",
      "syncId": "all-i-have-is-christ",
      "expectedRevision": "song:all-i-have-is-christ:7",
      "expectedSyncVersion": 7
    },
    {
      "id": "entry-reading",
      "kind": "scripture",
      "title": "Sermon reading",
      "range": {
        "schemaVersion": 1,
        "bookId": "Eph",
        "start": {
          "chapter": 3,
          "verse": 14
        },
        "end": {
          "chapter": 3,
          "verse": 21
        }
      },
      "translationId": "BSB",
      "sermonReading": {
        "sermonEntryId": "entry-sermon",
        "referenceId": "primary-eph-3"
      }
    },
    {
      "id": "entry-sermon",
      "kind": "sermon",
      "title": "Sermon",
      "syncId": "sermon-2026-08-02",
      "expectedRevision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "expectedSyncVersion": 3
    }
  ]
}
```

The plan contains 1–500 ordered entries and its complete source is limited to
256 KiB. IDs, titles, notes, dates, local venue time, translation IDs, and
Bible ranges are strictly normalized and bounded. Scripture ranges must
identify explicit starting and ending verses. Entry IDs are unique within the
plan.

The supported entry kinds are deliberately narrow:

- `section` supplies an organizational heading;
- `song` pins one exact synchronized song family;
- `scripture` requests one exact range and translation; and
- `sermon` pins one exact synchronized canonical sermon revision.

For a linked schema-v2 Scripture row:

- `sermonEntryId` must name exactly one later sermon row, never a title or
  resource guess;
- one sermon row may have at most one linked congregational reading;
- `referenceId` must exist in that sermon row's exact pinned canonical
  revision and be both `primary` and `confirmed`;
- the reading range must be contained by that confirmed primary reference;
- the reading must stay within one chapter and contain no more than eight
  verses; and
- its translation ID must use the normalized uppercase wire form.

An unrelated Scripture row uses `"sermonReading": null`. Heritage's manager
editor stores a real relationship to the selected sermon record, then resolves
that selection to one later stable service-plan row ID. When the sermon has
exactly one confirmed primary reference the editor may fill its stable
reference ID; otherwise the manager must choose the exact ID. The desktop
honors the explicit `sermonEntryId` even when separate service occurrences pin
the same exact sermon revision; it never substitutes another occurrence by
resource hash. Titles, passage text, and range overlap are never sufficient to
manufacture a relationship.

Heritage currently records a song pin as
`song:<syncId>:<syncVersion>`. A sermon pin is the lowercase SHA-256 of its
exact canonical current source. Both also carry the expected positive
`syncVersion`. A Ready plan fails validation when a selected resource is
archived, legacy-only, noncanonical, from another Community, or changed since
the Draft pin was reviewed. The manager must save the changed selection as
Draft, review its refreshed pin, and then mark it Ready.

The source is deterministic canonical JSON: strings are normalized, line
endings are normalized where allowed, object keys are sorted recursively, and
one newline terminates the document. `revision` is SHA-256 over those exact
UTF-8 bytes. Both applications parse, reserialize, and verify that hash rather
than trusting database projection fields.

## Envelope and list summary

The resource envelope has exactly these keys (`documentSource` is abbreviated
here only to keep the example readable):

```json
{
  "syncId": "service-4ffac0c6-25c6-4cf7-86c4-98f5478f1a8e",
  "syncVersion": 4,
  "revision": "ac3ad30508beb9a4b765fe9e483d54aa6077b3eec47d74c508cde62dfd144580",
  "documentSource": "<complete canonical JSON plus trailing newline>",
  "status": "ready",
  "changedAt": "2026-07-29T01:02:03.004Z"
}
```

The source plan's
`id` must equal `syncId`, and its computed digest must equal `revision`.
`syncVersion` advances monotonically on every accepted plan or lifecycle
change. `changedAt` is a canonical UTC timestamp and advances monotonically
even when two saves reach the server within one millisecond.

List rows contain exactly:

```json
{
  "syncId": "service-4ffac0c6-25c6-4cf7-86c4-98f5478f1a8e",
  "syncVersion": 4,
  "revision": "ac3ad30508beb9a4b765fe9e483d54aa6077b3eec47d74c508cde62dfd144580",
  "status": "ready",
  "title": "Sunday Morning Service",
  "serviceDate": "2026-08-02",
  "startTime": "10:30",
  "changedAt": "2026-07-29T01:02:03.004Z"
}
```

## Read API

List plans, most recently changed first:

```http
GET /api/community/syncshow/v1/service-plans?cursor=<opaque>&limit=1..100
Authorization: SyncShow <token>
```

```json
{
  "items": [],
  "nextCursor": null,
  "hasMore": false
}
```

The default page size is 50. Cursors are bounded, signed, lane-specific,
Community-bound keyset cursors over `changedAt` and the server record ID.
Invalid limits, signatures, tenant identities, or cursor shapes fail closed.
Every response is restricted to the authorized Community.

Read one exact plan:

```http
GET /api/community/syncshow/v1/service-plans/<syncId>
Authorization: SyncShow <token>
```

```json
{
  "plan": {
    "syncId": "service-4ffac0c6-25c6-4cf7-86c4-98f5478f1a8e",
    "syncVersion": 4,
    "revision": "ac3ad30508beb9a4b765fe9e483d54aa6077b3eec47d74c508cde62dfd144580",
    "documentSource": "<complete canonical JSON plus trailing newline>",
    "status": "ready",
    "changedAt": "2026-07-29T01:02:03.004Z"
  }
}
```

No POST, PUT, PATCH, or DELETE service-plan operation is part of this
integration.

## Trusted SyncShow import boundary

Import is a deliberate local operation:

1. Main fetches and strictly validates the exact envelope.
2. Main resolves every song, sermon, and Scripture item against stable local
   state for the selected venue profile and outputs.
3. The renderer receives bounded review data, blockers, and a short-lived
   opaque import token, not Community credentials.
4. If the only blockers are exact songs or sermons that are locally missing or
   older than the plan requires, the renderer may separately offer **Prepare
   required plan items** with a different short-lived opaque token.
5. The operator confirms the exact reviewed revision.
6. Main rechecks the connection and venue-profile identity, then creates the
   local ServiceProject transactionally.

Preparation is not import and is never automatic. The preparation token is
bound in main to the connection/server identity, selected venue profile, full
exact plan envelope, exact eligible blocker set, and exact song/sermon pins.
The renderer can submit only that opaque token plus `confirmed: true`; it
cannot supply resource IDs, revisions, server paths, credentials, or
compare-and-swap versions.

Preparation authority is issued only from a complete, non-truncated review
whose full eligible dependency vector contains at most 100 items. Larger or
incomplete blocker sets remain reviewable but receive no preparation button;
the manager must split the plan or the operator must synchronize the relevant
libraries separately before reviewing it again.

On confirmation, main refreshes current capabilities and independently
requires the service-plan read scope plus song and/or sermon read scopes for
the referenced lanes. It then re-fetches and re-reviews the plan before any
resource read. Each eligible dependency is fetched through its exact point GET
and must match both the expected synchronization version and revision before
local reconciliation. Song matching is limited to an existing persisted
mapping or exact local document/family identity; titles and alternate titles
are never used by this action. These targeted reads do not list feeds, advance
song or sermon feed cursors, update whole-lane last-sync time,
create/update/demote Community records, publish anything, or
create/open/import a ServiceProject. They may reconcile only the exact local
song or sermon records named by the main-owned authority. Existing divergent
local work is preserved through the normal conflict path instead of being
overwritten.

Successful dependencies are checkpointed one at a time. A retryable offline
failure keeps those safe checkpoints and the still-valid preparation token;
retrying the same action recomputes an exact subset and resumes only unresolved
items. A changed remote pin becomes a non-preparable stale-plan blocker bound
to that exact plan revision; it is never silently substituted or immediately
offered again. A Community manager must return that plan to Draft, refresh the
pin, review it, and mark it Ready again. The operator may stop the token-bound
sequence normally; cancellation keeps completed checkpoints and authority for
a deliberate retry. After the bounded sequence, main fetches the plan again,
rechecks the selected profile, and returns a completely fresh review. The
renderer replaces its prior review and focuses that result; it never
automatically imports, opens a project, enters Load, starts Show, or repeats
preparation. A retry may continue when the only change is that an exact subset
of the original dependencies has already resolved. If the plan, profile, or
authority changed, or the review introduces any new, altered, or re-pinned
dependency, preparation stops and returns the new review or an actionable
reconnect error before using stale authority.

Only a `ready` plan can be imported. Import blocks if:

- a song or sermon is absent locally;
- a local or remote resource version differs from the exact pin;
- a song or sermon has a synchronization conflict or is archived;
- the complete exact song-family document vector is unavailable;
- the requested song language variant is ambiguous or incompatible;
- the exact sermon revision is unavailable;
- a linked reading's target sermon row, exact reference, confirmed-primary
  status, or range containment does not match the pinned sermon source;
- the requested Scripture text cannot be resolved for every output; or
- the resulting native ServiceProject would be invalid.

Sections become local groups. Song entries use exact local family revisions and
derive channel variants from the selected venue outputs. Scripture entries
resolve exact text for every local output. A linked Scripture item retains the
local sermon resource ID, exact reference ID, normalized translation ID, and
chunk identity; the later sermon group reuses that exact resource. Sermon
entries install the exact local sermon revision as a resource and create a
sermon group. No fallback primary-reading planner or fuzzy matcher is used for
Community links. The confirmation list shows item positions alongside sermon
titles, so two identical titles remain distinguishable. The imported project
retains the Community server ID, plan ID, plan revision, import time, start
time, and team notes as provenance.

### Local completion after import

Import intentionally creates the exact ordered plan, not a finished
presentation. When a verified current PowerPoint `ServiceSet` and pastor
manuscript arrive later, the operator can select the imported exact sermon
group and choose **Review current service files**. Main owns the file picker
and returns only an expiring, path-free add/reuse review. The renderer cannot
supply file paths, sermon identities, or revisions.

Confirmation rechecks the project revision, linked sermon and resource owner,
current local sermon revision, service-set ID/fingerprint, manuscript bytes,
and complete source dispositions. Compatible existing sources are reused by
exact checksum; a repeated compatible checksum is copied at most once; an
ambiguous or metadata-incompatible checksum fails closed. If only the
service-set binding is missing, SyncShow saves only that binding. If sources
are added, one sermon/project transaction advances the stable sermon identity,
preserves the confirmed primary reference ID, and repins both the exact sermon
owner and the schema-v2 generated reading to the new content-addressed sermon
revision. It does not create another sermon, infer another reading, build
slides, alter the Community plan, or make any Community request.

When the reviewed PowerPoint files remain the actual presentation instead of
becoming native projected cues, the imported whole-sermon row also offers
**Use this sermon with the current PowerPoint Show**. A separate short-lived,
one-use main-process authority binds the exact local project revision,
Community plan ID/revision, direct sermon owner, stable sermon ID and
content-addressed revision, complete verified `ServiceSet` role assets,
profile/date, and the target companion revision or absence. The confirmation
creates or compare-and-swap updates only the deterministic PowerPoint
companion, copying the already-pinned canonical sermon and linking its empty
sermon anchor. Repeating the identical decision is idempotent. A changed plan,
sermon, file set, profile, date, target revision, duplicate companion,
conflicting link, expired proposal, or replay fails closed and requires a new
review. The imported native plan, presentations, Community records,
publication state, Load, and Show remain unchanged.

Reviewed PowerPoint extraction and sermon-cue reconciliation remain separate
human-confirmed local steps. Once the native project has projected sermon
material beneath the exact owner, readiness can prove the earlier linked
reading, song presence, compilation, and visible output coverage. Marking the
exact project Ready and publishing its immutable ShowPackage remain local
actions; no ServiceProject, cue, source byte, or ShowPackage is synchronized
through the service-plan API.

Ordinary project duplication cannot clone a subtree that owns an exact sermon
packet; the operator must add or repin the next sermon explicitly. Readiness
also treats multiple material sets sharing one exact sermon resource as a
non-waivable `SERVICE_SERMON_OWNER_AMBIGUOUS` blocker. A single linked reading
therefore cannot make two copied sermon packets appear ready.

Reimporting the same revision is idempotent. A newer Community revision is
shown with a bounded local diff plus component-aware reconciliation review and
is not allowed to alter the existing local project automatically. Every
conflict and the final confirmation are explicit; retained projects without a
component baseline use the separately labeled legacy fallback. Local edits
never write back to the Community plan.

## Implementation and proof gates

Heritage migration `20260729_005039_service_plans` adds the database storage
and indexes for this lane. The additive
`20260729_130000_service_plan_sermon_readings` migration adds the nullable
stored sermon relationship, reference ID, foreign key, and index needed by
schema v2 without rewriting existing canonical plan bytes. The later
`20260729_220000_canonical_sermon_preached_date_projection` migration repairs
only the derived civil-date projection, making nine integration migrations
after five baseline migrations, for 14 total. Before the guarded production
promotion attempt, a read-only inspection of the restarted
`wotbc.heritage.faith` target confirmed five baseline migrations and schema-1
discovery. The user reports that the test Community appliance is available
again at `192.168.0.227` through the established SSH alias, but this
reconciliation slice made no server write and did not re-verify its current
application, database, tunnel, or public routes. The production-named stack's
current state is therefore not asserted here.

Implemented local evidence covers:

- byte-identical canonical plan behavior across the SyncShow JavaScript and
  Heritage TypeScript implementations for frozen v1 and v2 fixtures;
- exact forward sermon-reading validation, manager-selected relationship
  resolution, confirmed-primary containment, descriptor negotiation,
  duplicate-title review labels, and duplicate-owner readiness refusal;
- strict discovery, scope migration, list/get parsing, pagination, and
  renderer/main authority boundaries;
- manager lifecycle, tenant/resource checks, pin refresh, terminal retention,
  and no-delete behavior;
- exact point-read preparation for eligible missing/behind song and sermon
  pins, including identity-only song matching, zero remote writes, unchanged
  feed cursors and lane-sync timestamps, stale-plan refusal, conflict
  preservation, same-action partial offline retry, explicit cancellation,
  capability/profile rechecks, and a fresh post-preparation review;
- import blockers, exact local resource resolution, idempotent import, and
  reviewed BASE/local/Community reconciliation with stable item identities,
  component-aware title/spec/relationship/dependent hashes, local-only
  preservation, delete/move/order/kind conflict choices, atomic song and sermon
  pin handling, duplicate-owner readings, nested subtree preservation,
  cross-move cycle review, legacy-baseline fallback, compare-and-swap apply,
  durable kept-local collision boundaries, candidate-scoped resource pruning,
  and a strict durable decision receipt;
- exact linked-sermon current-service review with path-free add/reuse
  dispositions, token expiry/replay/concurrency bounds, checksum-safe reuse,
  project-only service-set binding, atomic sermon/reading repin, and no
  Community call; an isolated Electron pass with the supplied three July 26
  decks and pastor manuscript committed four additions, then reopened the same
  set as four exact reuses without duplicating the sermon or reading;
- one cross-contract local composition from a schema-v2 import through reviewed
  source-plan disposition, exact sermon/reading repin, human-confirmed native
  cue reconciliation, all six readiness checks, Ready status, and a real
  immutable ShowPackage publish/reopen. This composition uses synthetic exact
  extraction snapshots; focused tests separately cover private-byte import,
  extraction, and the main-owned transaction, so it is not a packaged UI or
  real-PowerPoint end-to-end claim;
- a disposable PostgreSQL/Payload runtime round trip for migration and the
  schema-v2 manager relationship, Draft → Ready → Archived lifecycle, scoped
  list/get, changed resource behavior, retained terminal bytes, and cleanup;
  and
- a current-source 298-file Apple Silicon package plus isolated rendered UI
  proof that the linked reading and exact sermon packet are presented with
  human labels and fail-closed readiness. The package is ad-hoc signed and the
  fixture is preseeded; it does not prove manager authorization or a deployed
  server round trip.

Before calling this lane deployed or venue-ready, still prove:

1. the isolated Heritage work is reviewed, merged, and deployed through the
   backup-enabled updater;
2. production migrations and rollback/restore are rehearsed against a copy of
   the real database;
3. a packaged SyncShow installation completes real manager authorization and
   reapproval for `syncshow:service-plans:read`;
4. a real manager creates and revises a plan in a deployed browser;
5. desktop- and phone-width manager workflows are accessible;
6. one Ready plan imports into the packaged app, survives restart, is edited
   locally, publishes a ShowPackage, and runs with the network disconnected;
7. stale pins, withdrawn scope, role loss, pagination, terminal transitions,
   and newer revisions fail or warn exactly as contracted; and
8. the full service is exercised on venue displays without treating this
   planning lane as proof of converter, Remote, multi-monitor, or show timing
   behavior.

Source tests, a disposable database, and the completed local package/renderer
proof do not substitute for authenticated manager authorization, production
migration/restore, deployed browser and phone checks, or physical-venue
operation.
