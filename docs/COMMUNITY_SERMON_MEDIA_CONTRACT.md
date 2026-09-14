# Community managed sermon-recording contract

Status: the private preservation lane is implemented, rehearsal-green, and its
exact server build is deployed and enabled on the authorized WOTBC test
appliance. The final public cancel-only transfer proof still awaits one fresh
explicit execution approval; no WOTBC recording has been finalized or
published. The exact Phase-1 private manager review/download patch and Phase-2
managed-publication/public-byte route are now applied and clean-build verified
in the authoritative local Heritage worktree, but neither is committed,
live-browser exercised, or deployed. WOTBC remains private preservation only;
this status is not a deployed public-media or publication claim.

This lane operates on the native managed recording attached to an exact
`SermonDocument`. It does not add PowerPoint processing or make PowerPoint part
of the ordinary sermon workflow. Legacy deck import and presentation fallback
remain separate.

## Product boundary

The ordinary post-service workflow is:

1. An operator chooses an MP3 or M4A recording in Prepare.
2. SyncShow validates and copies it into owner-only local storage.
3. The exact sermon revision is saved to Community through the existing sermon
   synchronization lane.
4. If that server advertises managed recording upload, the operator explicitly
   enables its additional permissions.
5. The operator explicitly starts the private recording upload.
6. Community stores the verified recording privately.
7. A manager separately reviews any preserved recording before a later,
   distinct sermon-publication decision.

Steps 4 and 5 never occur automatically. The deployed WOTBC slice stops after
step 6. The authoritative local Phase-1 source adds the manager-only private
byte review/download surface for step 7. Phase 2 adds an explicit manager
schema-3 decision and canonical managed-object byte route, but only in that
uncommitted local worktree. Upload completion itself still does not publish,
schedule, withdraw, or create a public URL. SyncShow has no sermon-media
publication endpoint, WOTBC still has no public managed-object serving route,
and no transcoding route exists.

Local playback and reviewed external recording links remain available whether
or not the connected server supports this lane.

## Exact eligibility binding

Every upload is bound to all of:

- the current immutable ServiceProject revision;
- the selected service item;
- the exact linked local sermon ID and canonical revision;
- the exact Community sermon `syncVersion` and current revision;
- the stable managed slot
  `post-service:recording:<default-language>`;
- audio kind and MP3/M4A media type;
- canonical filename, byte length, and whole-file SHA-256;
- the pinned server origin; and
- the stable discovery Community identity.

The local project, current local sermon-library revision, Community sermon
state, recording metadata, and private object are re-resolved before init,
state reads, every chunk, and completion. Any mismatch fails closed. HTTP 412
also marks the upload superseded; SyncShow never retargets an upload to new
bytes or a new sermon revision.

The renderer sends only the stable project ID, expected project revision, and
service-item ID. Filesystem paths, private-store object identities, access
tokens, upload IDs, and endpoint URLs remain in Electron main.

## Discovery and compatibility

The lane is optional in protocol-v2 discovery and is valid only beside the
sermon resource:

```json
{
  "schemaVersion": 1,
  "endpoint": "sermon-media",
  "scopes": [
    "syncshow:sermon-media:read",
    "syncshow:sermon-media:write"
  ],
  "chunkSizeBytes": 8388608,
  "maximumBytes": 1073741824,
  "acceptedMediaTypes": [
    "audio/mpeg",
    "audio/mp4"
  ],
  "sessionTtlSeconds": 604800
}
```

SyncShow accepts this descriptor exactly. Unknown fields, a different endpoint,
missing scopes, changed transfer limits, different media types, or a
sermon-media resource without a sermon resource fail closed.

An older server simply has no managed-upload lane. Prepare says managed upload
is unavailable while retaining local review and external-link workflows. It
does not simulate success or fall back to an unscoped upload.

The Community feature is safe-default-off. Unless
`HERITAGE_SYNCSHOW_SERMON_MEDIA_ENABLED=true` is deliberately configured,
discovery omits the descriptor, the routes are not registered, and the handler
still refuses direct invocation. Existing device grants do not inherit the two
media scopes; a manager must explicitly approve them after enablement.

## Permission approval

The two media scopes are deliberately omitted from ordinary initial Community
approval:

- `syncshow:sermon-media:read`
- `syncshow:sermon-media:write`

Media read requires sermon read. Media write requires both media read and
sermon read. Effective authority is the intersection of the stored grant and
the current validated discovery advertisement.

The first **Enable private upload…** action starts a new device approval for
the existing Community/account identity and explicitly adds the media scopes.
The existing trusted Community approval page and polling flow are reused. No
upload starts while approval is pending. Removing the advertised lane disables
managed upload without disabling still-valid song, sermon, planning, local
recording, or Show functionality.

## HTTP contract

All requests stay under the same-origin endpoint:

```text
/api/community/syncshow/v1/sermon-media
```

The v1 operations are:

```http
POST   /uploads
GET    /uploads/{uploadId}
PUT    /uploads/{uploadId}/chunks/{index}
POST   /uploads/{uploadId}/complete
DELETE /uploads/{uploadId}
```

SyncShow sends its dedicated `Authorization: SyncShow <token>` credential,
uses manual redirect handling, and rejects cross-origin or redirect responses.
JSON requests and responses are bounded. Error responses use:

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "STALE_SERMON_BINDING",
    "message": "The sermon or recording no longer matches this upload.",
    "retryable": false
  }
}
```

Init sends only exact sermon and recording metadata:

```json
{
  "schemaVersion": 1,
  "sermon": {
    "syncId": "sermon:2026-08-02:romans-8",
    "expectedSyncVersion": 7,
    "expectedCurrentRevision": "64-lowercase-hex"
  },
  "recording": {
    "id": "post-service:recording:en",
    "kind": "audio",
    "language": "en",
    "mediaType": "audio/mpeg",
    "fileName": "sermon-2026-08-02.mp3",
    "sha256": "64-lowercase-hex",
    "sizeBytes": 8388614,
    "durationSeconds": null
  }
}
```

Each raw chunk request has exact `Content-Length`, `Content-Range`,
`X-Content-SHA256`, and `Idempotency-Key` headers. SyncShow opens the preserved
object, reads exactly the expected bytes in bounded pieces, hashes that chunk,
and refuses an empty, short, oversized, or changed read. It uploads only the
indices absent from Community's authoritative sorted `receivedChunks` array.
It does not infer server receipt from local progress.

Completion sends exactly:

```json
{
  "schemaVersion": 1
}
```

The first durable completion claim returns `202` with the same bounded upload
envelope in `finalizing`. SyncShow then uses identity-only `GET` polling; it
does not reopen or hash the local recording after that claim. A completed
replay returns `200` and `complete`. While finalization remains active,
SyncShow hides Cancel, repeats the exact idempotent completion claim at a
bounded interval, and stops its local polling after a bounded total wait so the
operator can resume later.

If both completion attempts fail before a durable claim and authoritative
`GET` still reports `uploading`, SyncShow keeps cancellation available instead
of labelling the slot `finalizing`. When Community already reports every chunk
and byte, **Resume** may reissue the exact completion claim from the persisted
binding even if the local file has since disappeared. A partial remote slot
still needs the local recording to resume; without it, the only safe action is
**Cancel upload**.

Transport deadlines are operation-specific: ordinary JSON control requests
remain at 30 seconds, the 8 MiB raw chunk PUT allows 15 minutes for slow
uplinks, and the durable completion claim allows 60 seconds. Each explicit
deadline is validated against a hard 30-minute per-request ceiling; response
and request byte limits do not change. Caller cancellation still composes
through the same `AbortSignal`. A non-JSON proxy `5xx`/`524` response is read
only to the existing bound and becomes a status-based retryable error without
surfacing its body.

Every mutation has a deterministic idempotency key. The complete shared
cross-runtime vector is
`test/fixtures/community-sermon-media-wire-v1.json`.

## Resume and attempt identity

SyncShow persists one random attempt identity for the exact server, Community,
sermon revision, Community sync version, recording slot, hash, and byte length.
Two local service projects that reference the same exact sermon recording reuse
that identity. Different server origins or different Communities on one server
never share it.

Retries and app restarts reuse the same init key. This matters in both
directions:

- a partially received upload reopens the existing session and sends only
  missing chunks; and
- a completed upload replays the successful init and returns the already
  complete private slot rather than trying to create a conflicting duplicate.

Successful attempts remain reusable for that exact replay. A cancelled,
expired, superseded, or otherwise terminal attempt is marked rotate-eligible.
The next explicit **Start** creates a new attempt key. A retryable network or
server pause keeps the existing key and offers **Resume** instead.

Concurrent Start/Resume commands for one exact service binding are reserved
synchronously in main before discovery or hashing begins. The start IPC returns
after Community has confirmed the upload session/progress, while transfer
continues in main. This makes **Cancel upload** reachable during a long
transfer.

## Cancellation and lifecycle

Remote `DELETE` is used only by the explicit, confirmed **Cancel upload**
action. Network errors, HTTP 412, app quit, renderer loss, or system suspend do
not auto-delete the server session.

Once Community acknowledges an upload ID, explicit cancellation uses that
main-process-only ID through the already pinned Community client. A missing or
changed local recording, or a subsequently edited local service revision,
cannot prevent the operator from cancelling the acknowledged private staging
session. The bounded response must identify that exact upload and report the
authoritative `cancelled` state before the local attempt becomes terminal.
Local staleness after acknowledgement is not treated as proof that the remote
slot is terminal: SyncShow preserves the ID, disables Resume for that changed
local binding, and requires explicit cancellation before a new upload. Only an
authoritative Community stale response rotates the attempt.

If `DELETE` races a completion claim and Community reports
`FINALIZATION_IN_PROGRESS`, SyncShow performs an identity-only `GET`. An exact
`finalizing` result switches the operation to resumable finalization with
cancellation disabled; an exact `complete` result is accepted as completed.
Neither case is recorded as a successful cancellation.

Suspend and quit abort the current network request and leave the attempt
resumable. After restart, SyncShow re-initializes with the persisted key and
uses Community's received-chunk state. Explicit cancellation aborts the current
request, asks Community to cancel that upload ID, requires the authoritative
`cancelled` response, and then makes the attempt rotate-eligible.

The recognized server states are:

| State | Client meaning |
| --- | --- |
| `uploading` | Missing chunks may be sent. |
| `finalizing` | Server owns final verification; client must not send chunks. |
| `internal` | Finalization failed closed and requires administrator attention; it is not a successful private upload. |
| `complete` | Exact private recording is stored; publication is still separate. |
| `cancelled` | Explicitly cancelled; a new Start may rotate the attempt. |
| `superseded` | Sermon/recording binding is stale; reload is required. |
| `expired` | Session is terminal; a new explicit Start is required. |

## Privacy and recovery boundary

The local content-addressed recording remains available for playback and
explicit resume regardless of Community availability. Upload progress exposed
to the renderer contains only bounded counts, percentage, phase, and safe
action flags. It contains no upload ID, local path, token, or URL.

Community's completed private object is distinct from its public sermon
projection. Publication remains manager-owned and must use the separate
review/publish workflow. SyncShow never treats `complete` as `published`.

The server backup boundary is intentionally narrower than live resume:

- completed content-addressed private objects and their database
  bindings/audit records are archived;
- active `staging/` chunks and sessions are not backed up or restored;
- the supported backup command fails closed while any staging entry exists, so
  an operator must finish or explicitly cancel active uploads first; and
- complete, cancel, expiry, supersession, and internal finalization clean the
  exact staging tree.

Resume therefore covers ordinary client interruption while the same server
session still exists. It does not promise recovery of an active upload across
server loss or restore. After such a loss, the operator may need to start the
upload again from SyncShow's verified local copy. SyncShow owns that preserved
local recovery copy and its integrity checks; it does not claim that a server
backup or restore succeeded.

Format-2 backup/restore verifies an exact inventory across completed private
objects and their database rows. That protects consistency; it does not turn
the appliance's default same-disk backup directory into disaster recovery.
Before real sermon-library use, a church still needs regularly verified,
encrypted off-device replication and a deduplicated retention policy sized for
its recordings.

## Focused validation

Current validation is:

- SyncShow syntax: **182/182 JavaScript files**;
- complete SyncShow suite: effectively **2,129/2,129**—**2,126** pass in the
  managed sandbox and its three denied loopback-listener cases pass **3/3**
  when rerun with normal loopback permission;
- focused SyncShow managed-recording client/Main/preload/renderer contract:
  **61/61**;
- real source-Electron picker/local-store/disconnected-card regression:
  **10/10**, with the captured card at
  `docs/goal-progress-assets/syncshow-managed-recording-real-electron-2026-07-30.jpeg`;
- deployed-source Community integration/contract suite: **264/264**;
- focused Community managed-media behavior: **29/29**, plus **9/9**
  static/migration checks; and
- Community TypeScript checking, production build, and deploy/operator
  regression: green.

The locally integrated private manager-review patch separately passes **209/209
TypeScript + 63/63 static = 272/272**, nonincremental TypeScript checking, the
optimized production build, patch dry-run, and two independent final GO audits.
Its exact artifact and application boundary are documented in
`docs/HERITAGE-MANAGER-RECORDING-REVIEW-PHASE1.md`.

The locally integrated Phase-2 source passes **44/44** focused behavioral plus
**3/3** static UI checks, the complete **222+63 = 285/285** Community suite,
nonincremental type checking, and a clean copied-source `npm ci` production and
debug build with the dynamic managed-media route in server and standalone
output. Its exact artifact, rollback capsule, and live-system boundaries are
documented in `docs/HERITAGE-MANAGED-RECORDING-PUBLICATION-PHASE2.md`.

These results prove the local implementation and cross-runtime contract. The
deployed source and locally integrated manager/publication patches are separate proof rungs: they do not
prove the pending public cancel transfer, authenticated WOTBC manager playback,
a packaged SyncShow flow, a real slow uplink through the public tunnel, or a
venue workflow.

The source-Electron capture proves the real picker, owner-only local store, and
honest disconnected UI state: `Check pending`, disabled upload actions, and a
separate local-review control. It made no Community connection or write and is
not server-transfer, audible-playback, packaged-app, or publication evidence.

The focused suite covers:

- exact discovery and older-server fallback;
- same-origin binary requests, raw streams, manual redirects, bounded JSON,
  authorization, abort, and error mapping;
- shared wire-fixture parsing and fail-closed schema drift;
- missing-chunk resume and exact chunk hashes/ranges;
- durable `202 finalizing`, identity-only polling, bounded completion-claim
  replay, and completed replay after app restart;
- finalization recovery when the local recording disappears after the durable
  claim;
- lost-response recovery without a duplicate upload or false cancellation;
- HTTP 412 and local-revision staleness without remote deletion;
- retryable pause without remote deletion;
- prompt failure on short/empty local reads;
- explicit cancellation only, including the cancellation-disabled finalizing
  state and completion/cancellation races;
- persisted attempt rotation and cross-project/server/Community separation;
- synchronous operation reservation and suspend/quit pause semantics;
- bounded slow-uplink chunk progress and stalled-stream refusal;
- quiesced maintenance plus exact format-2 object/database inventory checks;
- path/token/URL-free preload and progress contracts; and
- visible approval, Start, Resume, Cancel, progress, private-state, and
  publication-separation UI copy.
