# Heritage Community Phase 2 rollback and attribution manifest

Date: 2026-08-11

Status: completed local source-integration and rollback evidence; the frozen
patch is applied worktree-only in the authoritative Heritage checkout, but is
not staged, committed, live-runtime exercised, or deployed.

## Frozen identity

- Application root: `/Users/omayo/GitHub/heritage_study_bible`
- Patch: `docs/patches/heritage-community-managed-recording-publication-phase2.patch`
- Patch SHA-256: `9e2cb43847dd275da9d77430117ee6beade8600d07280e4dbb86320f834ebc8d`
- Patch mode/size: `0644`, 126,156 bytes
- Shape: nine existing files changed, three files created; every result is mode
  `0644`
- Apply/reverse mode: worktree only, with whitespace errors fatal; never use
  `--index`, `--3way`, checkout, reset, or a forced reverse
- Read-only observation: Heritage `HEAD` was
  `711d8345810b57780773ff958628c88f6c6f085e` on
  `codex/syncshow-community-integration`

The commit and branch identify the observation, not the rollback source. Eight
of the nine existing files are untracked, while `package.json` is tracked and
already worktree-modified. The exact bytes below are therefore authoritative.

## Exact path states

All paths are relative to the application root.

| Path | Before status | Before SHA-256 | After SHA-256 | Before/after mode |
| --- | --- | --- | --- | --- |
| `community-server/package.json` | tracked, worktree modified | `bcb989d03983f9a82c2c4fd4380f37efe990f16e620c5e6058f1d53c701ed0f3` | `6b7ca5c4c18997386f6dfc93ac5d3fa97c8d0b1f7fbdf82e4e249c72281818df` | `0644` / `0644` |
| `community-server/src/components/sermonPublicationReviewModel.ts` | untracked | `573e660f5dde8503c76c1d175ff78f64d1864387f31e6db4961c8ba4f2bae2da` | `4d90d8ef8562969b5b594109602602910d2cedacda79f790a74923ead1180bfb` | `0644` / `0644` |
| `community-server/src/components/SermonPublicationReviewClient.tsx` | untracked | `ebbd41aa9ca77895b57d93a51ad78cd6817260c237b29d96c9dd20372dedccbc` | `bc1f9dbeb46330fe87ef3d45687348d21a728133941af0ec34de63f278cd6ba8` | `0644` / `0644` |
| `community-server/src/endpoints/sermonPublications.ts` | untracked | `5528bdf0ac4ebea03a44355dc8ebc3e1192bae64bb28e5e0fa150b661e51615a` | `6bddeeff3359515edde6e1077a78d9e8deb43d8ad8c80284db2aa452536dcac6` | `0644` / `0644` |
| `community-server/src/lib/syncshow/ManagerSermonPublication.ts` | untracked | `35ffb9c886256cd498f30c461fa7e4c862161fa9e10e08cd7696dfe5438fbfa1` | `207184baef061b3af48e01c05a7a7eff7b78ede0a71eef6572ca563cc732c1d4` | `0644` / `0644` |
| `community-server/src/lib/syncshow/SermonPublicationStore.ts` | untracked | `2c5c632810f9ddbfbf804fc2da657b269e97696ecf5b8e5fb77d5a90e997bcc1` | `019fb9f1bdacdadf74280fa351e01e29e4cb4995f9a5f38c34f5f686d991e0a5` | `0644` / `0644` |
| `community-server/tests/sermon-publication-review.test.ts` | untracked | `4dd393337fd2ba523b3865b3de14890a55bf7377ddb39a96ddd9a80dddba8be7` | `3f6f9acf3e9c1dd6aaa43401dde61756a750a6220bba2b92825ce90b6295fe3c` | `0644` / `0644` |
| `community-server/tests/sermon-publication-review-static.test.mjs` | untracked | `23eb22f86a29af9dbb27c49d96c65b502963758642fa5a62cb1dff008f280ade` | `26f1db6eade884cd18676bed350c28e4555c64eee69e82b0772cb6e818114de7` | `0644` / `0644` |
| `community-server/tests/sermon-publication-endpoint.test.ts` | untracked | `443da5a29ad5eccf1271b54558fcf993c2866ceee2ae4d216c5684ce8fbb72ae` | `5218082e0b0431220a2549feef0203fe41e4b45d0ff3645ac37a383ee0e624f8` | `0644` / `0644` |
| `community-server/src/lib/syncshow/PublicSermonMediaRoute.ts` | **absent** | — | `5f5d5b2d9e6e0334957064fdfca3c7bacc7a0c366c888c5be137db651e6d8d0c` | absent / `0644` |
| `community-server/src/app/content/sermon-media/[publicId]/[sha256]/route.ts` | **absent** | — | `c482ba27f95aed293ca399f8891e7a864eeb433ee1f23e8fc0e28c048cd6941f` | absent / `0644` |
| `community-server/tests/public-sermon-media-serving.test.ts` | **absent** | — | `7ab04945ce54f09ec628df4c699a6746404a091c1d189df67a973e4291a3028f` | absent / `0644` |

Any mismatch is a stop condition. Regenerate or manually merge the patch; do
not weaken the gate.

## Minimal attribution capsule

Before an authoritative write, establish an exclusive integration window and
create a durable capsule **outside** the Heritage checkout containing:

1. a verified copy of the frozen patch and this manifest;
2. byte-for-byte copies of only the nine existing files above, preserving mode;
3. explicit assertions that the three created paths were absent;
4. `HEAD`, branch, and `git status --porcelain=v2 -z --untracked-files=all`
   captured as raw bytes;
5. a before-tree inventory for every tracked or non-ignored untracked path
   returned by `git ls-files --cached --others --exclude-standard -z`.

The tree inventory must be sorted by raw path bytes and record path, object
kind, permission mode, byte size, and SHA-256 (for a symlink, hash its link
target bytes). Capture the same inventory immediately after application,
before tests, formatters, builds, or servers run. The only permitted inventory
delta is the twelve exact transitions in the table. Keep the raw porcelain
snapshots too, but do not use status alone: modifying an untracked file does not
change its `?` status.

The nine-file preimage copy is a fallback safety capsule, not permission to
overwrite later edits. Hash the capsule itself after capture and store that
digest with the two inventories.

## Controlled application

From the application root, after all before-state checks pass:

```sh
git apply --check --whitespace=error-all /Users/omayo/GitHub/SyncShow/docs/patches/heritage-community-managed-recording-publication-phase2.patch
git apply --whitespace=error-all /Users/omayo/GitHub/SyncShow/docs/patches/heritage-community-managed-recording-publication-phase2.patch
```

Then verify every after hash and mode, capture the immediate after inventory,
and prove its delta is exactly these twelve paths. An unexpected delta is not a
successful application even if `git apply` returned zero.

## Completed application record

The controlled application completed on 2026-08-11. The authoritative preimage
was first preserved in the session-local `/private/tmp` snapshot at
`/private/tmp/heritage-community-phase2-preapply.20260811T1p0pVf` behind the
exact marker `heritage-community-phase2-preapply-v1\n`. It is not durable
off-device backup. The wrapper and capsule
directories are mode `0700`; sensitive inventory/status files are mode `0600`.

The complete live/snapshot comparison covered 54,199 paths: 49,339 regular
files, 4,830 directories, 30 symlinks, no special objects, and 1,171,770,479
regular-file bytes. File bytes/modes, directory modes, and symlink targets all
matched. Both sides produced canonical manifest SHA-256
`31e7514c0369cf49addeeb3239db2e840be7700262a2d49a8a5a1bab9b31ebe3`.
Two pairs of ignored `node_modules` esbuild hardlinks became independent clone
inodes, with identical bytes and modes; dependencies are deliberately outside
the source rollback contract.

The sorted non-ignored source inventory before application contained 973
regular files and 200,464,295 bytes; its 167,078-byte JSONL record has SHA-256
`a6ea6eaa80d77439d6e83b1576c77fb8365d49adb7d262aad4cd14ea329525ca`.
The raw 17,198-byte porcelain-v2 status has SHA-256
`72507e6de10bc223916076c17ca46147952b25d7b288bff1f2695ef115ac0951`.
Immediately after application, the same inventory contained 976 regular files
and 200,555,178 bytes; its 167,654-byte canonical JSONL record has SHA-256
`2679849233fda98a551bd7f4c15cbea496599ca44fd24706607253d95c01458a`.
The only twelve changes were the exact nine replacements and three additions
in this manifest, all mode `0644`. The post-apply raw porcelain-v2 status is
17,398 bytes at SHA-256
`22b62e297f0d7ca63c093a4b6d553cfd6a107ffdee991e3a6de7a05d32b5604b`.
Strict reverse apply-check passed.

The session-local capsule now contains owner-only `tree-after.jsonl`,
`git-status-after.porcelain-v2.z`, and `meta-after.json` beside the preimage
records. `postapply-files.sha256` verifies all three and itself has SHA-256
`2aafc9700286cdc9ba61adcd9fc34b8a44121ad192398a653911e8dc4c0278d0`;
the post-apply metadata file has SHA-256
`9027d2cb1892c1d9c88a1777f85c09cb378b97ac29af94b4d98565554488c3e3`.

Authoritative verification then passed 44/44 focused behavioral tests, 3/3
manager-UI contracts, the complete 222+63 = 285/285 Community suite, and
nonincremental type checking. The existing dependency tree produced a
successful optimized Next build but was explicitly not called clean because
one declared package was missing and one was extraneous. A separate clean copy
at `/private/tmp/syncshow-phase2-clean-build.N2PTKS/community-server` then ran
`npm ci --legacy-peer-deps` (the observed command reported 502 packages),
passed exact `npm ls --depth=0 --omit=optional`, and returned zero from the
production and debug webpack build commands. The retained server and standalone
manifests include the managed-media route. The clean build ID is
`BuFnDezypHm8jShZESkMJ`. Post-build source checks still matched every target
hash and showed no non-generated authoritative drift.

## Deterministic rollback

The clean reverse path is allowed only while all twelve files still match the
exact after hashes and modes above:

```sh
git apply --reverse --check --whitespace=error-all /Users/omayo/GitHub/SyncShow/docs/patches/heritage-community-managed-recording-publication-phase2.patch
git apply --reverse --whitespace=error-all /Users/omayo/GitHub/SyncShow/docs/patches/heritage-community-managed-recording-publication-phase2.patch
```

A successful reverse must restore the nine exact before hashes at mode `0644`,
make the three added paths absent, and restore the twelve-path portion of the
tree inventory exactly. Capture a final status and tree inventory for the audit
trail.

If any after hash has drifted, stop. Preserve those current bytes and perform a
reviewed manual reverse/merge against the nine-file capsule. Do not force the
reverse, delete the three paths based on their names alone, or use Git history
to overwrite the eight untracked originals.

## Minimal-fixture rollback proof

On 2026-08-11, the forward and reverse operations were exercised in a fresh
temporary tree containing only:

- the nine exact current preimage files and their parent directories; and
- the frozen patch.

The fixture deliberately contained no `node_modules`, `.next`, package lock,
Git index, or other Community files. Forward `git apply --check` and apply
produced all twelve exact target hashes at mode `0644`. Reverse check and apply
then restored all nine exact base hashes and removed all three additions.
Assertions also proved `node_modules` and `.next` were absent before and after.

This is sufficient because the patch changes no dependency declaration,
lockfile, migration, database schema, or generated output. Its sole
`package.json` change adds the new test file to an existing script. Therefore:

- `node_modules` is neither rollback input nor rollback state and need not be
  copied;
- `.next` is disposable derived output and must not be treated as rollback
  evidence; if a build ran, discard/rebuild it before post-rollback runtime
  verification rather than restoring a copy; and
- the source rollback capsule is exactly the patch, this manifest, nine
  preimage files, three absence assertions, and the status/tree inventories.

This manifest governs local source attribution only. If code is later allowed
to mutate a live database or content store, take and validate the separate
service-supported data backup before that runtime exercise.
