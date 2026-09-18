# Reviewed sermon-slide reconciliation

> Legacy source option: this contract preserves reviewed wording from attached
> PowerPoint slide-note windows. The normal native-first manuscript/slide-note
> body workflow, including explicit Exact, human-authored Condensed, and Hidden
> treatments, is documented in
> [`CANONICAL_SERMON_BODY_PROJECTION.md`](CANONICAL_SERMON_BODY_PROJECTION.md).
> Further PowerPoint processing is postponed behind native service planning and
> venue validation.

## Purpose

SyncShow receives two different sermon artifacts for a weekly service:

- the pastor's manuscript or transcript, which can become the reviewed
  canonical sermon body; and
- one or more PowerPoint slide-note decks, whose per-output wording and order
  are the source for projected sermon cues.

They are related, but they are not interchangeable. Reconciliation creates
native projected cues from reviewed slide-note evidence. It never replaces the
canonical manuscript, rewrites the pastor's document, publishes a sermon, or
sends anything to Community.

The reviewed workflow supports the empty semantic whole-sermon group produced
by **Plan next service** and any eligible selected Sermon, Section, Point, or
Subpoint group in a populated native outline. The selected group must directly
own or inherit one exact sermon packet revision from a semantic whole-sermon
owner.
Only eligible direct sermon cues inside the selected group can be updated;
nested groups, sibling outline branches, and every other child remain
preserved.

## Evidence from the July 26 service

The reviewed example service has three 112-slide presentations:

- `07-26-2026 Service ENG.pptx`
- `07-26-2026 Служение RUS.pptx`
- `07-26-2026 Media.pptx`

Their sermon windows occupy the same 32 relative positions, slides 68 through
99. English and Russian carry independently authored projected wording. Media
mostly follows Russian, but is not byte-identical and has at least one
materially different title treatment. The eight-page manuscript is a separate
canonical-body source.

That evidence establishes three product rules:

1. Output/source mapping is an operator decision. Language and file names are
   hints, not authority.
2. Slides align by reviewed relative position, not by merging, translating, or
   copying missing output text.
3. Exact source wording, direct gold emphasis, and direct bold state should
   survive the native-cue conversion; the manuscript remains unchanged.

## Trust and revision boundary

Every proposal binds:

- one checksum-valid saved native `ServiceProject` revision;
- one selected semantic sermon-outline group, including group kind, effective
  resource owner, direct and effective outline-section binding, section owner,
  and its complete ordered direct-child identity list;
- one exact sermon identity and revision;
- an explicit source ID for each mapped project channel;
- one immutable extraction snapshot per source, including source checksum and
  extractor ID/version; and
- a bounded, fingerprinted summary of every eligible existing direct sermon
  cue.

The renderer never supplies a local path, source bytes, extracted spans, or a
replacement snapshot. Main owns private-source reads and extraction. Apply
re-reads every exact snapshot binding and rejects a changed project, sermon,
source, extractor, snapshot, output channel, anchor child order, or eligible
target fingerprint.

Proposals are bounded, path-free, held in memory for 15 minutes, and addressed
by an opaque token. Private extraction snapshots remain restart-safe local
evidence. The current slice does not yet persist the reconciliation
receipt as a separate durable audit record; the saved project revision and
content-addressed snapshots remain the durable result/evidence pair. After a
successful apply, main retains the exact completed reply behind the same
bounded in-memory token until expiry or cache eviction and returns it only when
a retry's project binding, decisions, placement, and confirmation hash match
exactly.

## Operator workflow

1. Select the exact eligible native Sermon, Section, Point, or Subpoint group
   whose direct cues should be reconciled. It may be the linked whole-sermon
   owner or a nested group that inherits that exact link.
2. Choose **Build sermon slides**.
3. Map an attached PowerPoint slide-notes source to each intended output.
   Every mapping starts blank. An unmapped output receives no text in a new
   cue and remains unchanged in an updated cue.
4. Review the proposed relative-position rows.
5. Explicitly choose **Insert**, **Update**, or **Skip** for every row. Rows
   start at Skip. Update never infers a target: the operator must choose one
   eligible existing direct sermon cue, and one cue cannot be selected twice.
   **Use all suggested rows** is available only for an empty selected
   whole-sermon owner group. Nested groups always require row-by-row decisions
   because the source extraction still shows the complete sermon window.
6. For an inserted or updated row, keep, change, or unpair the exact source
   unit selected for each mapped output. A source unit cannot be reused within
   an output. Unpairing a mapped output clears that output in an updated cue;
   outputs left unmapped in step 3 remain untouched.
7. Optionally set a direct canonical outline-section override. Choosing an
   Update target starts from that cue's current direct override. A blank
   override removes the cue's direct pin and inherits the selected group's
   effective section; inside a section-scoped group, blank does not mean the
   whole sermon.
8. In a populated group, if any row changes, choose one explicit position for
   the reviewed block among the group's current direct children. An empty group
   has only position zero, so SyncShow supplies it without another choice.
9. Confirm the complete review and apply once.

If at least one row is inserted or updated, Apply performs one compare-and-swap
project save. An all-Skip review returns unchanged and performs no save. Changed
rows become one row-ordered block at the reviewed position. Insert creates
native `sermon` items with the `sermon-notes` preset. Update preserves the
target item identity, title, preset, operator notes, creation time, and all
unmapped output text, per-output titles, and spans while replacing only
reviewed mapped outputs, direct outline override, and update time. Because
mapped per-output titles are not part of this review, Apply clears them rather
than projecting stale titles above newly reviewed body text.
Unselected direct children—including nested groups, unrelated cues, and
eligible sermon cues not chosen as targets—retain their identity, content,
hierarchy, and relative order. Normal `sermon-library` source references still
compile from the exact owning resource. Apply does not touch the sermon body,
references, source records, post-service links, publication state, or Community
state.

## Extraction and source fidelity

Historical extraction proposal v1 remains readable and hash-stable. New
PowerPoint extraction uses a separate extractor binding and a versioned
proposal that may include bounded inline spans over the authoritative unit
text.

Only direct PowerPoint run formatting is carried:

- direct `#FFC000` foreground;
- direct bold-on as weight `700`; and
- direct bold-off as weight `400` when it accompanies preserved emphasis.

Theme formatting, inherited formatting, visual keyword guessing, arbitrary
markup, backgrounds, images, and layout coordinates are not inferred. Span
offsets are sorted, non-overlapping, within the exact UTF-16 text, and cannot
split a surrogate pair. Apply derives spans from the trusted saved snapshot;
the renderer selects only an exact unit ID and exact text.

This preserves the meaningful gold emphasis used by the reviewed source decks
without pretending that a semantic native cue is a pixel-identical PowerPoint
slide. The original presentations and private sources remain preserved.

## Weekly readiness

Readiness is derived from the exact saved project revision. It is not a
renderer-supplied flag. The fixed checks are:

1. the native project compiles to at least one cue;
2. the service contains at least one song;
3. the service owns at least one exact sermon packet revision;
4. projected sermon material exists under an exact sermon link;
5. an exact linked sermon reading appears before projected sermon material; and
6. every configured channel has visible projected content.

Compilation/nonempty can never be waived. A planned service may record a
bounded waiver for another failed check only with a human reason. Waivers are
canonicalized by fixed check ID and are invalidated by every projected-content
mutation, even if the plan was already back in Planning. Changing a waiver
decision on a Ready plan reopens it to Planning; the operator must confirm the
new exact review before it can become Ready again.

Main re-derives readiness before accepting **Ready**. Publishing a planned
service also requires both the Ready lifecycle state and a newly derived
blocker-free report. Ready remains editorial state; **Save & go to Load** is
the separate command that builds and installs the exact Show Package.

Unplanned legacy projects retain their existing publication path for
compatibility. Their readiness report is still visible when opened, but no
planning metadata or waiver is invented.

## Deliberate limits of this slice

- This slice updates only eligible direct sermon-cue children of the selected
  group. To reconcile cues inside a nested point, select that point itself.
  One review never flattens a whole subtree or moves a cue across group
  boundaries.
- Relative-position suggestions are proposals, not a claim that independently
  authored decks are semantically identical.
- No automatic language matching, translation, missing-output copy, or
  manuscript-to-slide generation occurs.
- PowerPoint layout, backgrounds, images, theme formatting, and animations do
  not become native preset data.
- The reconciliation receipt is returned by the domain operation but does not
  yet have its own durable local store. Same-process retries can recover the
  exact cached result while the original token remains alive; restart-safe or
  evicted-token recovery/replay remains pending.
- Installed-app, packaged-window, Windows PowerPoint, multi-monitor, and
  physical-venue validation remain separate from source and renderer checks.
- Community sermon persistence, atomic public projection, confirmed passage
  indexing, recordings, and Heritage Study Bible reader consumption remain
  separate server/reader milestones.
