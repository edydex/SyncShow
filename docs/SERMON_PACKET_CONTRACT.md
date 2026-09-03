# Sermon packet contract

Status: active product contract. The current local sermon payload is
`SermonDocument` v3, while canonical v1 and v2 documents remain explicitly
supported with their historical bytes and hashes unchanged; canonical passage
ranges remain `BibleRangeV1`. The local SyncShow packet, reviewed-body,
exact-reading, and bounded Community client/synchronization foundations
identified below are implemented in the current worktree. Heritage SyncShow
server/store APIs, Community service planning, canonical public projection,
and passage-linked Heritage sermon discovery are implemented on the real
uncommitted integration branch. They remain unmerged and undeployed; a live
authenticated end-to-end deployment is still a future release gate, and this
document does not claim that the integration is shipped.

## Why a sermon is a packet

The reviewed July 26, 2026 service packet contains:

- three aligned 112-slide presentations for English, Russian, and Media;
- a dedicated pre-sermon reading of Ephesians 3:14–21;
- an eight-page bilingual pastor manuscript for *The Prayer That Transforms
  the Church*;
- a projected sermon outline and selected Scripture extracts that are only a
  subset of the manuscript; and
- many supporting references in addition to the primary preaching passage.

Those files describe one sermon used in one service, not four unrelated
documents. English, Russian, and Media are presentation variants. The
manuscript, projected notes, primary reading, supporting references, and later
recording have different purposes and must remain distinguishable.

The system must therefore preserve one stable sermon identity while allowing
new immutable revisions as its reviewed metadata, sources, translations, and
media become available.

## Ownership and runtime boundary

| Surface | Responsibility |
| --- | --- |
| Heritage Community | Canonical mutable store for sermon identity, revisions, source objects, service relationships, review state, access policy, media state, and audit history. |
| SyncShow Prepare | Offline-capable intake, review, service assembly, cue authoring, and compilation. It caches documents locally and pins exact sermon and service revisions. |
| SyncShow Load/Show | Runs only an immutable, integrity-checked ShowPackage. It never reads a mutable Community record during a service. |
| Static Content Server | Generated, versioned projection of records explicitly approved for public distribution. It contains no manager credentials or private source objects. |
| Heritage Study Bible | Read-only sermon discovery and consumption for a passage, including “On this passage” and “Appears in” results. It does not become the sermon editor or canonical store. |

The canonical synchronization target is the direct authenticated Heritage
Community API. PagesDB or another static publisher may supply compatible public
content, but it is not the mutable sermon authority and does not stand in for
the Community sync API.

Community unavailability must not prevent an already prepared and published
service from loading or showing. Later Community edits must not silently change
a ShowPackage already used for rehearsal or a live service.

## Current implementation boundary

The implemented local SyncShow foundation includes:

- canonical, validated `BibleRangeV1` values and intersection/ordering helpers;
- a deterministic `SermonDocument` schema, canonical serialization, and
  SHA-256 content revisions;
- explicit canonical v1/v2/v3 support: historical v1/v2 sources retain their
  exact serialization and revisions, while v3 adds ordered reviewed body
  entries linked to a source and optionally to an outline section;
- an immutable, compare-and-swap local sermon library with historical revision
  reads;
- a private content-addressed source-object store for reviewed PDF, DOCX, PPTX,
  TXT, and Markdown files, including file-type and integrity checks;
- a main-process-owned **Current PowerPoint service** bootstrap that re-verifies
  the pinned set, binds the displayed card to an expiring opaque inspection,
  and atomically creates or reopens one exact `pptx-companion` project only if
  the set is still identical. It contains exactly one top-level nonprojected
  Sermon group and sermon resources only, cannot link an unrelated library
  sermon, compile, publish, import/export, or insert a native reading, and
  therefore cannot replace the original presentations in Load. A new unlinked
  companion opens weekly packet review; reopening a linked companion selects
  that exact revision, refreshes its Community state, and resumes at the
  post-service handoff. Renderer and main-process guards reject a second packet
  for the same companion;
- one main-process-owned weekly review/commit that associates the exact verified
  PPTX `ServiceSet` and one chosen manuscript as private packet sources, with a
  path-free 15-minute proposal and durable project-to-set binding;
- exact sermon-revision and outline-section pins in `ServiceProject`, while
  preserving reviewed inline cue text and legacy unlinked projects;
- a bounded, path-free **Used in services** projection derived only from
  checksum-valid current ServiceProject revisions. It deduplicates direct and
  inherited links per sermon/project, preserves exact pinned revisions, and
  re-verifies the recorded anchor before opening a service instead of creating
  a competing ServicePlan authority;
- portable service import that hydrates a missing embedded sermon into the
  editable local library without overwriting a different current revision;
- a bounded, main-process integrity check that distinguishes verified, missing,
  corrupt, and unverified private source files on the current computer, with
  identical in-flight checks deduplicated and distinct object scans serialized;
- a dedicated BSB primary-reference review path that accepts up to 100 verses
  without raising the separate eight-verse limit used by projected Bible cues;
- deterministic, bounded PDF, DOCX, PPTX, TXT, and Markdown extraction whose
  normalized full result is retained as private, content-addressed, path-free
  evidence while the renderer receives only an expiring review proposal;
- a separate reviewed-body proposal/commit for a linked Current PowerPoint
  service sermon. It accepts only a complete, untruncated, whole-source
  manuscript or transcript extraction, seeds review from all ordered unit text
  rather than the bounded preview, and requires human confirmation before an
  exact v3 revision is committed and re-pinned without rewriting projected
  cues;
- conservative PowerPoint sermon-window detection, ordered source evidence,
  bilingual outline suggestions, and English/Russian canonical book hints for
  all 66 books;
- an opt-in Prepare review in which every suggestion begins unchecked, outline
  parents remain structurally closed, and only checked suggestion IDs can cross
  the renderer/main boundary;
- trusted main-process canonicalization of proposed Scripture references,
  including removal of duplicates and ranges already contained by the confirmed
  primary passage;
- additive, conflict-checked outline localization so aligned Russian and
  English sources enrich one stable structural outline rather than creating
  duplicate sections;
- a staged sermon/project commit with a private recovery journal: the exact
  service pin is saved before the local sermon pointer advances, recovery
  verifies the full intended semantic project hash rather than only the sermon
  pin, and restart recovery never overwrites a newer independent sermon edit;
- an exact primary-reading workflow that keeps an already-present service-deck
  reading by default, can explicitly add BSB during packet creation, offers BSB
  or LSV for an already linked packet, chunks at no more than eight verses per
  cue, pins cue provenance to one embedded exact sermon revision through the
  compiled ShowPackage, and repairs placement idempotently without overwriting
  older or different generated cues;
- a reviewed post-service revisit workflow that reports canonical
  human-reviewed body independently from one canonical sermon page, one
  recording slot, and one external notes/transcript slot. New links must be
  durable HTTPS URLs; `Waiting` and `Available` are explicit operator states,
  no URL is fetched or probed, and saving creates a new immutable local sermon
  revision without uploading, publishing, or sending it to Community. The
  recording slot can also preserve one main-process-validated MP3, M4A, or MP4
  in private content-addressed storage, verify its device-local health, restore
  byte-identical missing/corrupt media without a canonical edit, or replace an
  editable recording while clearing stale URL/readiness review;
- a coherent sermon-revision repin that moves every direct service owner and
  compatible generated-reading provenance together after reviewed source or
  extraction changes. It requires the same sermon, retained linked outline
  sections, and the same confirmed-primary reference IDs and canonical ranges
  used by generated readings. The post-service workflow adds a stricter
  metadata-only check that also rejects changes to sermon content, audience,
  sources, references, outline, or unrelated media;
- compiled sermon cue provenance that contains the pinned revision and optional
  section rather than a live mutable record;
- local Prepare operations to create a private draft from a human-confirmed
  primary passage, search sermons, read an outline, link an exact revision and
  section, and attach a reviewed source through a main-process-owned file
  picker. Both sermon and project writes use compare-and-swap revisions; and
- a bounded Community sermon client/synchronization foundation with protocol-v2
  independent `resources.songs` and `resources.sermons` discovery lanes,
  protocol-v1 root-song normalization, an independent sermon cursor, canonical
  envelopes, manual exact-revision pull, explicit one-sermon compare-and-swap
  push, and guarded divergence that never transfers private source bytes.

Protocol v2 still requires shared device authorization and at least one
supported resource lane. Its normalized offered scopes are the union of the
advertised lanes, while song and sermon endpoints remain independently pinned
to the same-origin API base.

The packet and authoring path remains local-first and offline-capable. The
matching Heritage discovery lanes, scoped device authorization, transactional
sermon/service-plan/publication stores, durable change feed, canonical public
projection, passage index, and Study Bible sidebar/viewer now exist on the
uncommitted integration branch. The current system still does **not** include:

- a broad multi-entry outline/body editor or one-review subtree reconciliation
  across multiple nested groups beyond the implemented exact selected-group
  mapping slice;
- a merged production migration and authenticated packaged-to-deployed
  Community round trip; or
- recording processing, playback, automatic media retention/cleanup,
  media upload/transcoding, or Community/website media publication. Prepare can
  preserve and integrity-check one local recording plus reviewed external
  links, but it does not host or probe the linked resources.

Community is the canonical mutable owner; SyncShow remains the offline
author/compiler and pins exact revisions for rehearsal and live use. The local
library is not a competing long-term server of record.

## Canonical passage contract

Free-text references are retained for source fidelity, but joins and passage
queries use a canonical range:

```json
{
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
}
```

`BibleRangeV1` rules:

- `bookId` is one enumerated OSIS-style identifier, not a translated label.
- A range is always within one book; v1 rejects cross-book ranges.
- Chapters are positive integers within the selected canonical book.
- Verses are positive integers or `null`. A `null` start verse means the
  beginning of that chapter and a `null` end verse means the end of that
  chapter, so whole chapters and chapter spans are representable.
- Numbered verses fail closed at the selected chapter's exact final verse in
  the bundled BSB Protestant 66-book versification.
- Localized book names and punctuation are accepted only by intake parsers.
  They do not become identifiers.
- The original entered string is preserved separately and is never regenerated
  as if it were the pastor's exact wording.

SyncShow and Heritage independently test the same canonical, newline-terminated
`bible-versification-bsb-v1.json` coordinate vector. Its SHA-256 is
`878253daa85e874da525fd58cbc5fb22522c30fe494522bf356da3ecbf874069`;
changing the 66-book/1,189-chapter coordinates therefore requires an explicit
cross-repository contract update rather than silently widening either parser.

A sermon reference records meaning and provenance:

```json
{
  "id": "ref_eph_3_14_21_primary",
  "range": {
    "schemaVersion": 1,
    "bookId": "Eph",
    "start": { "chapter": 3, "verse": 14 },
    "end": { "chapter": 3, "verse": 21 }
  },
  "role": "primary",
  "source": "pastor",
  "reviewStatus": "confirmed",
  "enteredText": "Ephesians 3:14-21",
  "sectionId": "reading",
  "startOffset": 0,
  "endOffset": 20
}
```

`SermonReferenceV1` rules:

- `role` is `primary` or `mentioned`.
- The `SermonReference.source` reference source-kind is `pastor`,
  `slide-notes`, `manuscript`, `transcript-extraction`, or `operator`.
- `reviewStatus` is `suggested` or `confirmed`.
- `sectionId` and text offsets are optional provenance pointers into a
  preserved source or reviewed section.
- A parser, transcript tool, or future AI assistant may create only
  `suggested` references. A person must confirm their range and role.
- Suggested references never affect public passage indexes.

For discovery, a verse or range intersects a sermon when it intersects a
confirmed canonical range. Confirmed primary references populate **On this
passage**. Confirmed mentioned references populate **Appears in**. A primary
match must not also inflate the mentioned count.

## Sermon document

A canonical `SermonDocument` has a stable ID and immutable content revisions.
The implemented local v3 payload contains:

- schema version and stable sermon ID; canonical serialization produces the
  deterministic revision hash stored by the library and project;
- localized titles and a default language;
- speaker identity and displayed name;
- preaching date and optional series;
- primary and mentioned references with suggestion/confirmation state;
- ordered outline sections with stable section IDs and localized titles;
- preserved manuscript, slide-note, and transcript source records;
- ordered reviewed body entries. Each entry has a stable ID, kind, language,
  optional source ID, optional outline section ID, and complete canonical text;
- recording and other media records with independent processing state;
- and editorial status, visibility, and publication metadata.

Drafts may be incomplete. A confirmed primary reference is required when a
sermon becomes `ready` or `published`, not merely to preserve an early draft.
The current local outline stores section identity, hierarchy, kind, and
localized titles. Body entries can point at those section IDs, but
manuscript/deck/section-to-cue mapping and the broader outline/body editor are
not yet implemented. Reviewed projected cue text remains independently owned by
the `ServiceProject`; adding or editing the canonical body does not replace it.

Localized summaries, Community `ServicePlan` relationships, server timestamps,
access policy records, and Community audit events belong to later contracts
rather than being implied as implemented `SermonDocument` fields. The private
extraction snapshots and review receipts described below remain separate
noncanonical local evidence even when their full unit text is later used as the
starting point for an explicitly confirmed canonical v3 body entry.

Labels may change; IDs do not derive from labels. Serialization used for
revision hashing must be deterministic. Mutable server metadata such as an
ETag, access timestamp, or sync cursor is not part of the sermon content hash.

`SermonDocument` v1 and v2 remain readable so existing embedded revisions and
their historical SHA-256 values stay exact. V1 used one singular `language` on
each source record. V2 introduced `languages`; v3 adds the ordered `body`
array. A new sermon is created as v3, while editing an older document performs
an explicit v1-to-v3 or v2-to-v3 upgrade and starts with an empty body unless
the human-reviewed operation supplies entries. Code must verify or pin the
older exact revision before upgrading it; silently normalizing a v1 or v2
payload as v3 would change its canonical bytes and break its historical hash.

## Source preservation and review

Every imported source is retained as an immutable object. Its record includes:

- stable source ID and source kind;
- original file name, media type, byte length, and SHA-256;
- one or more specific BCP-47 language tags when known (for example `en` and
  `ru` for the bilingual July 26 manuscript);
- operator-reviewed provider attribution and main-process receipt time; and
- source-system provenance and content-addressed object identity, never a
  workstation absolute path.

Private source-object availability is local and time-varying, so it is not part
of the canonical sermon or service hash. Prepare checks the content-addressed
object before saying a file is verified on this computer. A portable service
currently carries the exact sermon document and its source metadata, but not the
private manuscript/deck bytes; after import those records are honestly shown as
missing until the objects are separately restored. Missing private bytes do not
invalidate the exact embedded sermon revision or its reviewed projected text.

Implemented `SermonSource.kind` values are `manuscript`, `slide-notes`,
`transcript`, and `other`. This enum is separate from
`SermonReference.source`, whose `operator` value records a human-entered
reference.

### Reviewed weekly service-source intake

The common weekly handoff is one reviewed proposal/commit operation, not four
independent attachments:

1. Prepare starts from an eligible sermon item in the current
   `ServiceProject`. The trusted main process loads the current verified
   `ServiceSet`, requires its service date and profile to equal the project's,
   and accepts only its pinned PPTX inputs.
2. The main process opens one native picker for the pastor's PDF, DOCX, TXT, or
   Markdown manuscript and inspects it without first changing the private
   source store.
3. The renderer receives a bounded, path-free review containing the set name
   and date plus each source's role, original filename, language tags, byte
   length, and SHA-256. Presentation languages are inferred conservatively from
   their configured roles; manuscript languages are operator-reviewed, and a
   blank field is stored as `und` rather than guessed from the sermon title.
4. The opaque proposal token expires after 15 minutes. Changing sermon
   metadata, passage, manuscript languages, or reading mode invalidates the
   visible review. The renderer cannot supply source paths, substitute another
   set, or manufacture authoritative source IDs or provenance.
5. Commit requires explicit confirmation and the same expected project
   revision and eligible target. It re-reads and fingerprints the current set,
   requires the same set ID and fingerprint, and re-inspects the manuscript's
   filename, media type, size, and hash.
6. Each reviewed source is copied—not moved—to the private content-addressed
   store, preserving its original filename, languages, checksum, role, and
   immutable receipt provenance. The speaker is recorded as provider of the
   chosen manuscript only; service-team presentations retain their
   `service-set` origin without falsely attributing them to the preacher. No
   presentation slide, projected wording, or layout is edited.
7. Only after every import matches its reviewed plan does one existing
   recovery-journal-backed sermon/project transaction create the immutable
   sermon, pin it to the item, optionally add a native reading, and persist the
   exact `sourceServiceSet` binding.

That binding contains the verified set ID, fingerprint, service date, and
profile ID. A project's first successful reviewed intake establishes it;
subsequent intake must resolve to that exact set. A different morning/evening
or otherwise same-date set is a binding conflict rather than a silent
substitution.

The default reading mode is `already-in-service`, because a full weekly deck
normally already contains the congregational reading. It creates no duplicate
Bible cues. The operator may instead select `insert-native`, which resolves the
confirmed passage in BSB and includes those cues in the same journaled commit.
The source-less **Create & link** operation remains available when no current
service set is reviewed.

Packet intake does not run extraction, infer public-discovery references, map
deck sections to native cues, mark post-service links Ready, ingest a recording,
or push to Community. Those are separate reviewed operations. If an import
fails before the sermon/project transaction, no visible sermon or project
pointer advances. Sources copied earlier in that attempt can remain as
unreferenced private content-addressed objects and enter the continuous orphan
ledger. They cannot become eligible until the full retention window passes,
and only the pre-window startup path can re-audit every historical reference
and remove the exact confirmed candidate.

Extraction creates a bounded derivative with explicit tool/version and exact
source-hash provenance; it never overwrites the original and it does not become
canonical merely because the parser found it. `LocalSermonExtractionStore`
normalizes and saves the full derivative as a private, content-addressed,
path-free snapshot. Its exact binding contains the sermon ID and base revision,
source ID/hash/kind, and extractor ID/version, so reuse cannot cross a changed
sermon base, source, or extraction tool. The renderer still receives only
bounded text evidence and semantic suggestion IDs behind an opaque, expiring
main-process proposal token, never source bytes or a workstation path.
Re-importing the same bytes is idempotent and attachments are deduplicated by
SHA-256. Re-importing changed bytes creates a new immutable object and sermon
revision while leaving the prior object and historical sermon revision
recoverable.

Only after the reviewed sermon and project transaction succeeds does SyncShow
write a private review receipt containing the selected suggestion IDs, review
time, and exact resulting sermon and project revisions. A reverse index over
the resulting sermon revision, project identity, and source identity/hash lets
Prepare reopen that exact saved evidence after restart. Every reopened
suggestion is unchecked: a prior receipt proves what was applied, but it does
not authorize applying it again. If the receipt write fails after the canonical
commit, the sermon and project remain successfully saved and the operator sees
a warning. A crash in that narrow post-commit/pre-receipt gap likewise reopens
the evidence as unreviewed. Neither snapshots nor receipts rewrite projected
cues, upload to Community, or claim publication.

### Reviewed canonical body

Canonical sermon body review is deliberately separate from attaching a source
or accepting outline/reference suggestions:

1. The trusted process starts from the exact sermon revision pinned by either
   a native sermon target or the linked PowerPoint companion and one attached
   `manuscript` or `transcript`.
   Slide notes and scoped deck windows cannot automatically stand in for the
   complete sermon.
2. It reuses or creates the exact-bound private extraction snapshot and accepts
   it only when the extraction scope is `whole-source`, the unit list and full
   text are untruncated, and every individual unit is complete. A bounded
   preview or bounded suggestion list may be truncated because neither is used
   as canonical body text.
3. The default body entry is formed from every complete extraction unit in
   ordinal order. It retains the exact source ID/kind, a reviewed language
   (`mul` for a multi-language source), and an existing stable body-entry ID and
   outline-section link when replacing that source's one prior entry.
4. The renderer receives the complete proposed text behind an expiring,
   revision-bound proposal and requires the operator to inspect and confirm it.
   The renderer may submit only the bounded canonical entry fields; it cannot
   supply a source path, source revision, snapshot hash, sermon revision, or
   project authority.
5. Apply re-reads the exact sermon/project/source binding, canonicalizes the
   reviewed entries as `SermonDocument` v3, and commits the sermon plus exact
   project pin through the recovery-journal-backed coordinator. A stale sermon,
   source, project, or proposal fails closed; an exact already-applied retry is
   a no-op.

Changing canonical content reopens editorial review. If the previous sermon was
`ready` or `published`, body apply changes its status to `draft` and clears
`publishedAt`, while preserving its configured visibility and canonical URL.
Archived sermons cannot accept a body review.

The repinned v3 sermon body is packet/library content, not projection
instructions. Existing native cue wording and exact cue identities are
unchanged. A `pptx-companion` remains nonprojected, group/resource-only, and
bound to the exact verified `ServiceSet`; Load/Show continue to use the
source-faithful PowerPoint slides without a native cue rewrite.

Body review is also not a Community write. The canonical body text crosses the
Community wire only if the operator later invokes the separate explicit
compare-and-swap sermon save. That save transfers the exact canonical v3
document, including ordered body entries and source descriptors, while the
private manuscript/transcript bytes remain local. A body-only local/remote
divergence preserves both immutable revisions and exposes both ordered bodies
for guarded conflict review before either exact copy is chosen.

By default, selecting the same bytes restores the private object on the current
computer without replacing the existing reviewed source record or creating new
sermon and service revisions. Correcting that record's kind, languages, or
provider is a separate, explicit operator choice in Prepare. When an attachment
is started from a cue that inherits its sermon, every direct owner of the
previous exact revision advances together. Independently owned outline-section
links remain in place, and generated congregational readings advance only when
their exact confirmed-primary reference ID and canonical range are unchanged.
If a corrected kind belongs to a source linked from the canonical reviewed
body, every linked body entry changes to that kind in the same transaction. A
`ready` or `published` sermon returns to `draft` and clears `publishedAt`;
an archived sermon rejects that correction until it is explicitly restored.

The implemented local Prepare flow:

1. starts from an eligible sermon cue or sermon/outline group in a service;
2. creates a private draft from operator-reviewed title, speaker, language, and
   a confirmed primary Bible range. The operator can review the exact current
   PPTX service set plus one manuscript through the weekly intake above, use the
   legacy source-less path, or link an existing exact sermon revision;
3. keeps an existing in-deck congregational reading by default, or explicitly
   adds the confirmed range in BSB immediately before the sermon;
4. for an existing link, lets the operator select a confirmed primary passage
   and BSB or LSV, then add or repair that reading immediately before the
   sermon;
5. lets the operator select an exact existing outline section;
6. attaches one additional reviewed PDF, DOCX, PPTX, TXT, or Markdown source at
   a time, with reviewed kind, one or more languages, and provider metadata;
7. extracts or reopens a selected attachment as a saved private snapshot behind
   an expiring proposal, displays the preserved-source evidence beside
   default-unchecked outline and Scripture suggestions, and applies only the
   IDs the operator checks; and
8. stages the reviewed immutable sermon revision, saves and re-pins the exact
   service resource, then advances the local sermon pointer. A private journal
   completes an interrupted pointer promotion after restart, while a concurrent
   newer sermon edit is preserved. Direct sermon owners and compatible
   generated-reading provenance advance in the same project mutation; a changed
   linked outline section or congregational-reading passage rejects the whole
   mutation. Reviewed inline cue text and publication state are not changed.

### Exact primary sermon-reading workflow

Packet creation treats the congregational reading as part of the same reviewed
operation as sermon creation. The checkbox is off by default because the full
weekly service deck normally already contains that reading. In
`already-in-service` mode, SyncShow embeds the new immutable sermon resource and
exact revision in the `ServiceProject` without creating duplicate Bible cues.
Selecting the checkbox uses `insert-native`: SyncShow resolves the
operator-confirmed primary passage in BSB, creates the reading, and saves it
with the exact service pin through the same recovery-journal-backed transaction
before promoting the local sermon pointer. The legacy source-less packet path
uses the same explicit option and remains available without a reviewed
`ServiceSet`.

For an already linked packet, the operator chooses one confirmed primary
reference and either BSB or LSV. Automatic construction is deliberately limited
to exact verse ranges within one chapter; a cross-chapter or whole-chapter
reference is `unsupported` rather than guessed. The planner splits a longer
range into consecutive chunks of at most eight verses. For example,
Psalm 119:1–18 becomes 1–8, 9–16, and 17–18. The ordered cues are placed
immediately before the outermost sermon group, or before the resource-owning
item when there is no sermon group.

Each generated Bible cue carries:

```json
{
  "sermonReading": {
    "sermonResourceId": "embedded-exact-sermon-resource",
    "referenceId": "confirmed-primary-reference",
    "translationId": "BSB",
    "chunkIndex": 0,
    "chunkCount": 3
  }
}
```

Validation requires that the resource contain the exact content-addressed
sermon revision, the reference be that revision's confirmed primary passage,
the cue range remain inside it, and every channel use the recorded translation.
Ordinary cue duplication removes this provenance so a copy cannot impersonate a
generated sermon reading.

The Prepare status model is explicit: `unlinked`, `unavailable`,
`selection-required`, `unsupported`, `missing`, `ready`, `out-of-position`, or
`wrong-passage`. A `ready` request is a no-op and does not save a new project
revision. Repair reuses correctly provenanced chunks, moves the same cue IDs
when only placement is wrong, and creates only missing chunks. Reading cues
provenanced to an older sermon revision, another confirmed primary, or another
translation are preserved and require review or removal before a different
generated reading can be added. Duplicate or malformed matching provenance
likewise requires manual review instead of destructive automatic repair. The
compiled Bible cue retains the exact sermon ID and revision plus the reference,
translation, chunk index, and chunk count for ShowPackage auditability.

The reviewed July 26 packet work now covers:

1. one path-free review that associates the verified English, Russian, and
   Media PPTX inputs plus the chosen manuscript as a single private packet,
   while durably binding the project to the exact presentation-set fingerprint;
2. deterministic extraction from the eight-page bilingual pastor manuscript
   and both 112-slide language presentations as a separate later operation;
3. conservative presentation scoping to slides 68–99 rather than treating the
   full service deck as sermon metadata;
4. one source-independent outline that can be enriched safely by aligned
   Russian and English headings;
5. reviewed mentioned-reference proposals with primary-passage subranges and
   duplicates removed; and
6. an operator comparison and confirmation path that changes nothing until
   suggestions are checked and applied; and
7. a separate complete-source body review that derives one ordered bilingual
   manuscript entry from all eight untruncated pages, requires explicit human
   confirmation, creates a canonical v3 revision, and re-pins the exact
   companion without touching the three presentation decks or their cues.

The source association and private restart-safe derivative persistence steps
are complete, and the first reviewed canonical-body slice is complete.
Remaining authoring work includes mapping manuscript, deck, and section
evidence to existing projected cues without changing their wording, expanding
the narrow complete-source review into the broader outline/body editor, and
extending exact selected-group mapping into deliberate multi-group workflows.
Confirmation of the primary range and every reference used for public discovery
remains mandatory.

The operator may correct a suggestion without changing the source. The audit
trail will record both the suggestion and the reviewed result once Community
audit APIs exist.

## Service linkage and exact revisions

A Community `ServicePlan` should link to a sermon by stable ID and explicit
revision. It also owns service-specific facts such as date/time, order,
pre-sermon reading placement, assigned outputs, readiness, and team notes.

A SyncShow `ServiceProject` pins:

- the exact reviewed `sourceServiceSet` ID, fingerprint, service date, and
  profile after weekly packet intake;
- the exact sermon document revision used to prepare the service;
- the exact canonical v3 body as part of that pinned sermon resource, without
  treating it as replacement cue text;
- the exact source or outline section behind each sermon cue;
- the exact localized cue text and presentation treatment; and
- each primary-reading cue's exact embedded sermon resource, confirmed reference,
  BSB/LSV translation, chunk position/count, canonical range, bundled text,
  attribution, and checksum.

Compiled cues carry a constrained source reference such as sermon ID, revision
hash, and section ID. They do not embed a live Community URL as their authority.
Updating the sermon or service creates a new revision and an explicit review
choice; it does not mutate a published ShowPackage.

The post-service recording may be added later without rewriting the historical
show package. Its relationship is to the stable sermon ID.

## Editorial, media, and publication lifecycle

Content and media readiness are separate.

Editorial states:

- `draft` — incomplete or awaiting review;
- `ready` — primary metadata and sources reviewed and suitable for a service;
- `published` — approved for its configured audience and passage indexes; and
- `archived` — retained but removed from normal current listings.

Visibility is explicit:

- `private` — managers/editors only;
- `members` — authorized members of that Community; and
- `unlisted` — available to people with the deliberate share link but omitted
  from public browse and passage indexes;
- `public` — eligible for the static public projection and anonymous links.

An optional availability time controls scheduling without inventing another
visibility meaning. Changing visibility or availability creates an audited
revision.

Applying reviewed canonical body text is also an editorial change. A
`ready` or `published` revision returns to `draft`, its prior `publishedAt` is
cleared, and its existing visibility and canonical URL are retained for the
next review. This prevents newly reviewed text from inheriting a publication
claim while avoiding an unrelated audience or link rewrite.

Media states are independent, for example `pending`, `processing`, `ready`, and
`failed`. A reviewed sermon can be published before its recording is ready.
The recording can appear later without changing the confirmed passage
semantics.

SyncShow's bounded local post-service handoff is deliberately stricter than the
general media schema. It reports human-reviewed canonical v3 body independently
from optional external destinations; an attached manuscript or saved extraction
does not count until the complete body has crossed the explicit body-review
commit. Its local picker copies one structurally validated MP3, M4A, or MP4 of
at most 1 GiB into owner-only content-addressed storage without exposing the
path to the renderer. Device health is ephemeral and exact-revision-bound:
missing or corrupt bytes can be restored from a byte-identical renamed backup,
while a different file can replace only an editable Draft/Ready record and
therefore clears the prior recording URL and reopens Ready as Draft. Published
or archived canonical media remains locked while permitting exact local-byte
repair. Automatic media retention/cleanup, upload, playback, probing, and
transcoding remain outside this slice. **Save reviewed links** stores the
reviewed HTTPS page and link slots as a local `draft`. **Mark ready for
Community** requires a confirmed primary passage, an `Available` audio/video
link, and revisit content supplied by either the reviewed canonical body, the
canonical sermon page, or `Available` external notes/transcript. It sets only
`ready`, keeps the existing visibility, clears no remote state, and never sets
`published` or `publishedAt`. The separate Community button is still the only
network write, and synchronization does not select any
body or media for public use. Published and archived revisions are read-only in
this local workflow so the desktop cannot manufacture, downgrade, or silently
revise a publication claim.

Actual publication is a manager-authorized Community transaction over one
exact synced Ready revision. The server authors the publication timestamp,
creates the canonical Published/Public revision, regenerates the selected
public projection and confirmed passage rows, and moves the separate public
pointer atomically. Ordinary sermon synchronization cannot perform that
transition. A later current edit may return to Draft while the previously
approved public revision remains live until a manager republishes or
withdraws it.

Only `published` sermons visible to the current reader enter passage discovery.
The static Content Server includes only `published` plus `public` records and
the deliberately selected public derivatives. It must not copy private
manuscripts merely because public notes or audio exist.

## Security, conflicts, and audit

- SyncShow uses a named, manager-approved device grant with narrow sermon and
  service scopes. It does not reuse a member's browser session.
- Credentials remain in Electron's main process and operating-system protected
  storage; renderers receive only bounded operations and data.
- Community rechecks the installation's current authorization on each request.
- Writes use compare-and-swap revisions or ETags. A conflict preserves both
  versions and requires a human choice; last-write-wins is not acceptable.
- Conflict review represents external destinations as non-clickable
  origin/path text plus a session-keyed fingerprint. Query parameters remain
  hidden while query-only differences remain visible; raw query values, source
  paths, file names, hashes, and private provenance do not cross that review
  projection.
- Archiving is the normal removal path. Offline caches and historical packages
  are not remotely erased.
- Audit events record actor, installation, action, time, prior revision, new
  revision, source hashes, and review/publication changes.
- Logs and exports exclude secrets, local absolute paths, and private source
  bytes unless the export explicitly includes those sources.

## Migration and next slices

This contract can be adopted without breaking the current PowerPoint-first or
song-library workflows:

1. **Complete — local domain.** Shared, tested `BibleRangeV1`,
   `SermonReferenceV1`, and `SermonDocument` normalization, deterministic
   serialization, and passage-query semantics.
2. **Complete — local persistence and exact linkage.** Immutable sermon
   revisions, a private content-addressed source store, exact
   `ServiceProject` sermon/section pins, and legacy-project compatibility.
3. **Complete — local Prepare foundation.** Create/search/read/link/attach
   operations with main-owned source selection, reviewed metadata,
   content-hash deduplication, sermon/project compare-and-swap writes, v1 hash
   preservation with explicit v3 upgrade (and exact v2 compatibility),
   portable sermon-library hydration, and host-local source integrity status.
4. **Complete — reviewed source extraction.** Deterministically extract bounded
   text/evidence from preserved manuscript and presentation sources, propose
   source-independent bilingual outline nodes and canonicalized mentioned
   references, and apply only default-unchecked operator selections through an
   exact revision-bound, recoverable commit. Nothing is silently confirmed,
   projected, or published.
5. **Complete — reviewed weekly source packet.** Review the exact current
   verified PPTX `ServiceSet` plus one chosen manuscript behind a path-free
   15-minute proposal; preserve original names, languages, sizes, and hashes;
   durably bind the project to the set ID/fingerprint/date/profile; then verify
   and copy all private sources before one journaled sermon/project commit.
   Source-less packet creation remains available.
6. **Complete — exact primary sermon reading.** Keep the reading already in a
   full service deck by default, or explicitly insert BSB immediately before the
   sermon; let linked packets select a confirmed primary passage and BSB/LSV,
   chunk at no more than eight verses, validate exact-revision provenance and
   status, and repair idempotently. An inserted reading, exact service pin, and
   packet creation share the recoverable sermon/project transaction.
7. **Complete — reviewed post-service revisit handoff.** Report the canonical
   human-reviewed v3 body separately from optional external destinations;
   preserve an HTTPS canonical page, recording, and notes/transcript as
   operator-reviewed `Waiting`/`Available` records; privately ingest and verify
   one exact local MP3/M4A/MP4; restore missing/corrupt bytes without changing a
   locked canonical record; allow an editable record to replace permanently
   lost media while clearing stale URL/readiness review; accept reviewed body,
   page, or available external text as the revisit-content side of Ready while
   still requiring the confirmed primary passage and available recording; save
   through the recoverable sermon/project transaction; coherently re-pin
   compatible primary-reading provenance; and keep Ready, Community push,
   public selection, and actual publication explicit. No upload, playback,
   probe, transcoding, cleanup, or publication is implied.
8. **Complete — local sermon-to-service history.** Derive one read-only,
   path-free relationship per stable sermon and current saved service; retain
   exact pinned revisions and PowerPoint/native workflow identity; exclude
   recovered fallback revisions; skip but preserve corrupt project evidence;
   and validate the unchanged current project revision plus a resolvable exact
   resource-owner anchor before replacing the operator's open workspace.
9. **Complete — private restart-safe extraction evidence.** Persist normalized
   full extraction snapshots as content-addressed, path-free evidence bound to
   the exact base sermon/source/extractor; write reviewed receipts only after
   the sermon/project commit; reopen the exact resulting
   sermon/project/source evidence after restart with suggestions unchecked; and
   report a receipt-write gap as unreviewed without undoing the canonical
   commit. This does not rewrite cues, upload to Community, or publish.
10. **In progress — reviewed body, mapping, editing, and cleanup.** The first
   body slice is complete: v1/v2/v3 canonical support preserves historical
   hashes; a human-confirmed, full untruncated whole-source manuscript or
   transcript extraction becomes ordered v3 body entries; editorial status is
   safely reopened; the exact ServiceProject resource is re-pinned without cue
   rewriting; and explicit Community wire/conflict handling retains the
   canonical body while private source bytes remain local. The projected
   mapping slice now supports an empty or populated exact-linked whole-sermon
   native group, rejecting a section-pinned anchor: explicit output/source
   mappings, immutable complete PowerPoint extraction snapshots, default-Skip
   relative rows, exact Insert/Update/Skip
   and unit/section review, and an explicit unreused eligible direct-cue target.
   A populated group requires one explicit changed-row block placement; an
   empty group has only automatic position zero. Trusted direct gold/bold spans
   and one project compare-and-swap complete the mutation. Unselected children
   preserve identity, content, hierarchy, and relative order; updates preserve
   the stable item ID,
   title, preset, operator notes, creation time, and unmapped output text/spans
   while replacing the reviewed outline pin, update time, and mapped outputs,
   without changing canonical body or Community state. Still pending are
   subtree-aware reconciliation for nested sermon descendants, a durable
   standalone reconciliation-receipt store and restart/evicted-token recovery
   beyond the exact same-process cached apply reply,
   and the broader outline/body editor.
11. **Implemented on the uncommitted Heritage branch — Community server
   ownership.** The server capability,
   scoped-device authorization, transactional Sermon/ServicePlan/source-object
   repositories, durable change feed, conflict handling, and audit APIs behind
   the implemented SyncShow client/synchronization foundation are present with
   additive migrations and tests, but remain unmerged and undeployed.
12. **Implemented on the uncommitted Heritage branch — public projection and
   Heritage.** The versioned public sermon projection, confirmed passage index,
   Heritage Study Bible passage results, and canonical sermon viewer are
   present with cross-repository fixtures, but remain unmerged and undeployed.
13. **Later — media operations and publication.** Add automatic local recording
   retention/cleanup, processing, progress/cancel, playback, upload/transcoding,
   and website publication after the implemented private intake and reviewed
   text/reference paths are proven.

Each slice must preserve existing source files and remain useful offline.
Package/build checks do not replace an authenticated Community sync test,
Heritage passage-discovery test, live deployment proof, or physical venue Show
test.
