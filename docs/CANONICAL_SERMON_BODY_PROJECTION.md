# Native canonical sermon-body projection

## Purpose

This is the normal native-first path from a reviewed pastor manuscript or
slide-note body to editable SyncShow sermon cues. It does not require
PowerPoint.

The canonical `SermonDocument` remains the durable source of truth. Projection
adds or updates service-project cues only after an operator decides what each
audience output should see. It never rewrites the canonical sermon, translates
or summarizes text automatically, publishes to Community, or changes an
already-published ShowPackage.

The older PowerPoint slide-note reconciliation path is documented separately
in `SERMON_SLIDE_RECONCILIATION.md` and remains a legacy source option.

## Operator workflow

1. Select an eligible linked Sermon, Section, Point, or Subpoint group.
2. Choose **Build slides from sermon text**.
3. Explicitly map every project output to one canonical body entry or Hidden.
   Language metadata is a hint only; it never selects or pairs an entry.
4. Review the deterministic paragraph pools. Every candidate row starts at
   Skip.
5. For an Insert or Update row, choose one treatment for every output:

   - **Exact** — project the selected canonical paragraph byte-for-byte.
   - **Condensed service text** — bind the projected words to one selected
     canonical paragraph, then type and review the service wording.
   - **Hidden** — project nothing on that output.

6. The optional **Start from exact paragraph** button copies the selected
   paragraph only after an explicit click. SyncShow never creates condensed
   copy on its own.
7. Explicitly account for every canonical paragraph by using it once on that
   output or marking it skipped. Select a concrete direct cue for Update and a
   concrete block position when the selected group is populated.
8. Review the visible Exact, Condensed, and Hidden summary, including every
   condensed word, then confirm one compare-and-swap apply.

Whitespace-only projected text means Hidden in the focused cue editor.
Otherwise leading and trailing bytes are preserved.

## Trusted decision shape

A current row uses exactly one closed `treatmentsByChannel` map:

```json
{
  "rowId": "body-row-001",
  "action": "insert",
  "targetItemId": null,
  "treatmentsByChannel": {
    "primary": {
      "mode": "exact",
      "paragraphId": "paragraph-001"
    },
    "secondary": {
      "mode": "condensed",
      "paragraphId": "paragraph-001",
      "text": "The church displays God’s wisdom."
    },
    "media": {
      "mode": "hidden"
    }
  }
}
```

The preload and main-process boundaries reject extra fields, unsupported
modes, missing outputs, unknown or reused paragraph IDs, empty or oversized
condensed text, hidden source mappings, incomplete paragraph accounting, stale
project/sermon bindings, and unconfirmed application.

Historical `paragraphIdsByChannel` rows remain accepted. Exact-only decisions
made through either shape intentionally produce the same project bytes and
schema-v1 evidence as before this feature.

## Evidence and compilation

Every inserted or updated cue retains a `sourceBodyProjection` receipt.

- Schema v1 is preserved for exact-only rows. Each visible channel records its
  body-entry identity/hash, paragraph ID and offsets, and exact text hash.
- Schema v2 is used when a row contains at least one condensed treatment. Each
  visible channel additionally records `mode: "exact" | "condensed"`, the
  canonical `sourceTextSha256`, and the actual `projectedTextSha256`.
- Hidden outputs have no projected text and therefore no visible-channel
  receipt entry.

Project normalization reopens only receipts that still match the exact linked
sermon revision, body-entry hash, paragraph boundaries, source hash, and
projected bytes. Tampering or stale evidence fails closed.

Compilation emits ordinary `content` for exact channels, `condensed` for a
retained schema-v2 condensed channel, and `hide` for a missing output. A
condensed channel has no `sourceChannelId`: its provenance is the selected
canonical paragraph, not another audience output.

## Editing after projection

A generic cue edit does not discard all evidence automatically:

- an unchanged complete text map preserves the existing receipt byte-for-byte;
- a partial edit retains evidence only for byte-identical channels;
- retained schema-v1 exact evidence is upgraded to schema v2 when another
  channel changes; and
- the receipt is removed only when no reviewed channel evidence remains.

This lets the focused editor stay useful without claiming that changed words
still match their earlier review.

## Current validation boundary

The tracked native weekly fixture now proves one cue as:

- Front: exact canonical Russian paragraph;
- Translation: human-authored condensed English service text; and
- Singer: Hidden.

The non-GUI lifecycle carries that cue through Ready, package publication,
activation, persisted timeline, and fresh-store Load. The real Electron
rehearsal renders and inspects it through three production display windows at
both 640×360 and 1920×1080.

Packaged-app startup, physical projectors, volunteer use, and venue behavior
remain separate release gates.
