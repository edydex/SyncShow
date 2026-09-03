'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const verifierPath = path.join(
  root,
  'scripts',
  'verify-packaged-operational-planning-electron.js'
);
const seedPath = path.join(
  root,
  'scripts',
  'fixtures',
  'packaged-operational-planning-seed.js'
);
const verifierSource = fs.readFileSync(verifierPath, 'utf8');
const seedSource = fs.readFileSync(seedPath, 'utf8');
const verifier = require(verifierPath);
const seedFixture = require(seedPath);
const {
  ISOLATED_TEST_USER_DATA_MARKER
} = require('../src/services/runtime/IsolatedTestUserData');

test('packaged planning verifier requires exact app, retained proof, hash, and output root', () => {
  const packageProofSha256 = 'a'.repeat(64);
  assert.deepEqual(
    verifier.parseArguments([
      '--app',
      '/private/tmp/frozen/SyncShow.app',
      '--package-proof',
      '/private/tmp/frozen/evidence/package-proof.json',
      '--package-proof-sha256',
      packageProofSha256,
      '--proof-root',
      '/private/tmp/lifecycle-proof'
    ]),
    {
      appPath: '/private/tmp/frozen/SyncShow.app',
      packageProofPath: '/private/tmp/frozen/evidence/package-proof.json',
      packageProofSha256,
      proofRoot: '/private/tmp/lifecycle-proof'
    }
  );
  for (const invalid of [
    [],
    ['--app', '/private/tmp/SyncShow.app'],
    [
      '--app',
      'dist/mac-arm64/SyncShow.app',
      '--package-proof',
      '/private/tmp/frozen/evidence/package-proof.json',
      '--package-proof-sha256',
      packageProofSha256,
      '--proof-root',
      '/private/tmp/proof'
    ],
    [
      '--app',
      '/private/tmp/SyncShow.app',
      '--package-proof',
      'evidence/package-proof.json',
      '--package-proof-sha256',
      packageProofSha256,
      '--proof-root',
      '/private/tmp/proof'
    ],
    [
      '--app',
      '/private/tmp/SyncShow.app',
      '--package-proof',
      '/private/tmp/frozen/evidence/package-proof.json',
      '--package-proof-sha256',
      'not-a-sha256',
      '--proof-root',
      '/private/tmp/proof'
    ],
    [
      '--app',
      '/private/tmp/SyncShow.app',
      '--package-proof',
      '/private/tmp/frozen/evidence/package-proof.json',
      '--package-proof-sha256',
      packageProofSha256,
      '--proof-root',
      'proof'
    ]
  ]) {
    assert.throws(() => verifier.parseArguments(invalid));
  }
});

test('proof root is a dedicated empty owner-only directory', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-proof-root-contract-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.chmodSync(base, 0o700);
  const resolved = await verifier.resolveProofRoot(base);
  assert.equal(resolved.proofRoot, fs.realpathSync(base));
  assert.equal(resolved.mode, 0o700);
  assert.equal(resolved.initialEntryCount, 0);
  assert.equal(resolved.initiallyEmpty, true);

  const wrongMode = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-proof-mode-contract-'));
  t.after(() => fs.rmSync(wrongMode, { recursive: true, force: true }));
  fs.chmodSync(wrongMode, 0o755);
  await assert.rejects(
    verifier.resolveProofRoot(wrongMode),
    error => error?.code === 'UNSAFE_PROOF_ROOT_MODE'
  );

  const nonempty = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-proof-nonempty-contract-'));
  t.after(() => fs.rmSync(nonempty, { recursive: true, force: true }));
  fs.chmodSync(nonempty, 0o700);
  fs.writeFileSync(path.join(nonempty, 'prior.json'), '{}', { mode: 0o600 });
  await assert.rejects(
    verifier.resolveProofRoot(nonempty),
    error => error?.code === 'PROOF_ROOT_NOT_EMPTY'
  );
});

test('evidence result is disjoint from immutable and temporary inputs', async t => {
  const result = '/private/tmp/evidence/packaged-operational-planning-restart.json';
  assert.equal(verifier.assertEvidenceResultDisjoint(result, [
    { label: 'shared-ancestor sibling', path: '/private/tmp/frozen' }
  ]), true);
  for (const boundary of [
    result,
    '/private/tmp/evidence',
    '/private/tmp'
  ]) {
    assert.throws(
      () => verifier.assertEvidenceResultDisjoint(result, [
        { label: 'forbidden input', path: boundary }
      ]),
      error => error?.code === 'EVIDENCE_RESULT_OVERLAP'
    );
  }
  assert.equal(verifier.pathEqualsOrIsNested('/private/tmp/evidence', '/private/tmp'), true);
  assert.equal(verifier.pathEqualsOrIsNested('/private/tmp/a', '/private/tmp/b'), false);
  assert.match(verifierSource, /staticEvidenceBoundaries\(paths, packageProof\)/);
  assert.match(verifierSource, /label: 'selected app bundle'/);
  assert.match(verifierSource, /label: 'repository root'/);
  assert.match(verifierSource, /label: `source closure \$\{relativeRoot\}`/);
  assert.match(verifierSource, /label: 'retained package proof file'/);
  assert.match(verifierSource, /label: 'retained package proof root'/);
  assert.match(verifierSource, /label: 'isolated temporary profile'/);
  assert.ok(
    verifierSource.indexOf('assertEvidenceResultDisjoint(proof.resultPath, publicationBoundaries)')
      < verifierSource.indexOf('harness = await resolveHarnessProvenance()'),
    'static inputs must be disjoint before harness/source hashing'
  );
  assert.ok(
    verifierSource.indexOf('assertEvidenceResultDisjoint(proof.resultPath, [profileBoundary])')
      < verifierSource.indexOf('const sourceClosureBeforeSeed = await sourceClosureManifest()'),
    'the eventual profile must be disjoint before seed or launch work'
  );
  assert.ok(
    verifierSource.indexOf('preflightEvidenceBoundaries(options.appPath)')
      < verifierSource.indexOf('paths = await resolvePackagedApp(options.appPath)'),
    'the raw/canonical app and repository must be rejected before package hashing'
  );
  assert.ok(
    verifierSource.indexOf('paths = await resolvePackagedApp(options.appPath)')
      < verifierSource.indexOf('packageProof = await resolvePackageProof('),
    'the app preflight must precede retained package-proof hashing'
  );
  assert.match(verifierSource, /let evidencePublicationAllowed = false/);
  assert.match(verifierSource, /recheckProofRootForPublication\(proof\)/);
  assert.match(verifierSource, /assert\.deepEqual\(finalPublicationBoundaries, publicationBoundaries\)/);

  const proofRoot = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    'syncshow-overlap-no-evidence-'
  )));
  t.after(() => fs.rmSync(proofRoot, { recursive: true, force: true }));
  fs.chmodSync(proofRoot, 0o700);
  const blockedResult = path.join(proofRoot, verifier.RESULT_FILE);
  let publicationAllowed = false;
  assert.throws(
    () => verifier.assertEvidenceResultDisjoint(blockedResult, [
      { label: 'forbidden app/repository/proof root', path: proofRoot }
    ]),
    error => error?.code === 'EVIDENCE_RESULT_OVERLAP'
  );
  const blockedPublication = await verifier.publishEvidenceIfAllowed(
    blockedResult,
    { ok: false, marker: 'must-not-exist' },
    publicationAllowed
  );
  assert.equal(blockedPublication, null);
  assert.equal(fs.existsSync(blockedResult), false);
  assert.deepEqual(fs.readdirSync(proofRoot), []);

  const integratedOverlapRoot = fs.realpathSync(fs.mkdtempSync(path.join(
    root,
    '.syncshow-overlap-contract-'
  )));
  t.after(() => fs.rmSync(integratedOverlapRoot, { recursive: true, force: true }));
  fs.chmodSync(integratedOverlapRoot, 0o700);
  const integratedResult = path.join(integratedOverlapRoot, verifier.RESULT_FILE);
  await assert.rejects(
    verifier.main([
      '--app',
      root,
      '--package-proof',
      '/private/tmp/missing/package-proof.json',
      '--package-proof-sha256',
      'a'.repeat(64),
      '--proof-root',
      integratedOverlapRoot
    ], { write: () => assert.fail('overlap must not write success stdout') }),
    error => error?.code === 'EVIDENCE_RESULT_OVERLAP'
      && !error.message.includes('Evidence:')
  );
  assert.equal(fs.existsSync(integratedResult), false);
  assert.deepEqual(fs.readdirSync(integratedOverlapRoot), []);
  assert.match(
    verifierSource,
    /if \(evidencePublished\) \{[\s\S]*Evidence: \$\{proof\.resultPath\}/
  );
});

test('retained audited package proof is byte- and identity-bound before launch', () => {
  assert.match(verifierSource, /async function resolvePackageProof\(/);
  assert.match(verifierSource, /retainedProof\.verified, true/);
  assert.match(verifierSource, /retainedAppRoot, paths\.appPath/);
  assert.match(verifierSource, /async function bundleManifest\(appRoot\)/);
  assert.match(verifierSource, /function recordsDigest\(records\)/);
  assert.match(verifierSource, /assert\.deepEqual\(paths\.bundleManifest, retainedBundle\)/);
  assert.match(
    verifierSource,
    /assert\.deepEqual\(finalBundleManifest, paths\.bundleManifest\)/
  );
  assert.match(
    verifierSource,
    /retainedPackage\.asarSha256, paths\.hashes\.appAsarSha256/
  );
  assert.match(
    verifierSource,
    /record\?\.path === 'Contents\/MacOS\/SyncShow'/
  );
  assert.match(verifierSource, /executableRecords\.length, 1/);
  assert.match(
    verifierSource,
    /executableRecord\.sha256, paths\.hashes\.executableSha256/
  );
  assert.match(verifierSource, /recordsSha256: retainedBundle\.recordsSha256/);
  for (const identityField of [
    'bundleId',
    'version',
    'buildVersion',
    'architecture'
  ]) {
    assert.ok(
      verifierSource.includes(
        `retainedPackage.${identityField}, paths.identity.${identityField}`
      ),
      `package proof does not bind ${identityField}`
    );
  }
  assert.match(verifierSource, /finalPackageProofSha256/);
  assert.match(verifierSource, /packageProofBytesUnchanged = true/);
});

test('external verifier, seed, fixture, and Node provenance are hash-stable', () => {
  assert.match(verifierSource, /processVersion: process\.version/);
  assert.match(verifierSource, /path: __filename/);
  assert.match(verifierSource, /SEED_SCRIPT_PATH/);
  assert.match(verifierSource, /TRACKED_FIXTURE_PATH/);
  assert.match(verifierSource, /external-test-seed-not-packaged-behavior/);
  assert.match(verifierSource, /tracked-source-fixture-input/);
  assert.match(verifierSource, /async function rehashHarnessProvenance/);
  assert.match(verifierSource, /assert\.equal\(finalSha256, record\.sha256\)/);
  assert.match(verifierSource, /harnessBytesUnchanged = true/);
  assert.match(verifierSource, /async function sourceClosureManifest\(\)/);
  assert.match(verifierSource, /'package-lock\.json'/);
  assert.match(verifierSource, /'assets\/fonts\/NotoSans-Variable\.ttf'/);
  assert.match(verifierSource, /preSeedToPostRestartEqual = true/);
  assert.match(verifierSource, /prelaunchProfileSnapshot/);
});

test('the packaged executable is the only Electron entrypoint', () => {
  assert.match(
    verifierSource,
    /const child = spawn\(paths\.executablePath, args, \{/
  );
  assert.match(verifierSource, /'--syncshow-test-user-data'/);
  assert.match(verifierSource, /`--user-data-dir=\$\{profilePath\}`/);
  assert.match(verifierSource, /'--remote-debugging-port=0'/);
  assert.match(verifierSource, /'--remote-debugging-address=127\.0\.0\.1'/);
  assert.match(
    verifierSource,
    /environment\.SYNCSHOW_TEST_USER_DATA_DIR = profilePath/
  );
  assert.match(verifierSource, /delete environment\.ELECTRON_RUN_AS_NODE/);
  assert.match(verifierSource, /delete environment\.NODE_OPTIONS/);
  for (const secretName of [
    'SYNCSHOW_GOOGLE_CLIENT_ID',
    'SYNCSHOW_GOOGLE_CLIENT_SECRET',
    'SYNCSHOW_GOOGLE_API_KEY',
    'SYNCSHOW_PACKAGE_GOOGLE_DRIVE_CONFIG'
  ]) {
    assert.ok(
      verifierSource.includes(`delete environment.${secretName}`),
      `spawn environment does not scrub ${secretName}`
    );
  }
  assert.doesNotMatch(verifierSource, /require\(['"]electron['"]\)/);
  assert.doesNotMatch(verifierSource, /require\(['"]\.\.\/main['"]\)/);
  assert.doesNotMatch(verifierSource, /BrowserWindow|ipcMain|screen\.getAllDisplays/);
  assert.doesNotMatch(verifierSource, /window\.api\.startPresentation|display:start/);
  assert.doesNotMatch(
    verifierSource,
    /CurrentShowPackageStore|ShowPackagePublisher/
  );
});

test('the source-side fixture is labeled setup and cannot replace packaged Main', () => {
  assert.match(seedSource, /provenance: 'external-test-seed'/);
  assert.match(seedSource, /packagedBehavior: false/);
  assert.match(seedSource, /createTrackedNativeWeeklyService\(profilePath\)/);
  assert.match(seedSource, /setServicePlanStatus\([\s\S]*'planning'/);
  assert.match(seedSource, /project\.revision, 3/);
  assert.match(seedSource, /preparedServiceAbsent: true/);
  assert.match(seedSource, /showPackagesAbsent: true/);
  assert.match(seedSource, /baselineEntries\.length,[\s\S]*1/);
  assert.match(seedSource, /PROFILE_MARKER_SOURCE/);
  assert.match(seedSource, /profileStats\.mode & 0o777, 0o700/);
  assert.match(seedSource, /markerStats\.mode & 0o777, 0o600/);
  assert.match(seedSource, /otherEntries: 0/);
  assert.doesNotMatch(seedSource, /return Object\.freeze\(\{[\s\S]*fixture,/);
  assert.doesNotMatch(seedSource, /require\(['"]electron['"]\)/);
  assert.doesNotMatch(seedSource, /require\(['"]\.\.\/\.\.\/main['"]\)/);

  const seedIndex = verifierSource.indexOf(
    'await seedTrackedPlanningProfile(temp.profilePath)'
  );
  const launchIndex = verifierSource.indexOf(
    'const firstLaunch = launchPackagedApp(',
    seedIndex
  );
  assert.ok(seedIndex >= 0 && launchIndex > seedIndex);
});

test('seed raw pointer and revision identity are independently no-follow bound', async t => {
  for (const seedContract of [
    'readStableNoFollow',
    'nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW',
    'statIdentity(await fs.lstat(filePath))',
    'planningPointerValue.reason',
    "'packaged-operational-planning-external-seed'",
    'planningPointerValue.updatedAt, planningStored.project.updatedAt',
    'planningRevision.sha256, planningStored.revisionId',
    'planningRevisionValue, planningStored.project',
    'rawPlanningStorageBound: true'
  ]) {
    assert.ok(seedSource.includes(seedContract), `missing raw seed binding: ${seedContract}`);
  }
  assert.match(verifierSource, /inspectSeededPlanningStorage\(/);
  assert.match(verifierSource, /inspectSeededPlanningRevision\(/);
  assert.equal(
    (verifierSource.match(/inspectSeededPlanningRevision\(/g) || []).length >= 3,
    true,
    'the immutable rev3 file must be checked after Ready and after restart'
  );

  const profilePath = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    'syncshow-seed-identity-contract-'
  )));
  t.after(() => fs.rmSync(profilePath, { recursive: true, force: true }));
  fs.chmodSync(profilePath, 0o700);
  fs.writeFileSync(
    path.join(profilePath, ISOLATED_TEST_USER_DATA_MARKER),
    verifier.PROFILE_MARKER_SOURCE,
    { flag: 'wx', mode: 0o600 }
  );
  const seed = await seedFixture.seedTrackedPlanningProfile(profilePath);
  const inspected = await verifier.inspectSeededPlanningStorage(
    profilePath,
    seed.expectedPlanningStorage
  );
  assert.equal(inspected.exactSeededStorageIdentity, true);
  assert.equal(inspected.pointer.mode, 0o600);
  assert.equal(inspected.revision.mode, 0o600);

  fs.chmodSync(seed.expectedPlanningStorage.revision.path, 0o644);
  await assert.rejects(
    verifier.inspectSeededPlanningRevision(
      profilePath,
      seed.expectedPlanningStorage.revision
    ),
    assert.AssertionError
  );
});

test('Ready continuity permits only revision, updatedAt, and planning status', () => {
  const planningStored = {
    revisionId: 'a'.repeat(64),
    project: {
      id: 'service-native-weekly-ready',
      revision: 3,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      planning: { status: 'planning', teamNotes: 'Keep this exact note' },
      items: { item: { title: 'Exact item', nested: ['unchanged'] } },
      resources: { resource: { sha256: 'b'.repeat(64) } }
    }
  };
  const readyProject = structuredClone(planningStored.project);
  readyProject.revision = 4;
  readyProject.updatedAt = '2026-08-01T10:01:00.000Z';
  readyProject.planning.status = 'ready';
  const readyStored = {
    revisionId: 'c'.repeat(64),
    project: readyProject,
    pointer: { value: { updatedAt: readyProject.updatedAt } }
  };
  assert.equal(
    verifier.assertReadyContinuity(planningStored, readyStored).onlyIntendedReadyTransition,
    true
  );
  const changedNested = structuredClone(readyStored);
  changedNested.project.items.item.title = 'Unexpected mutation';
  assert.throws(
    () => verifier.assertReadyContinuity(planningStored, changedNested),
    assert.AssertionError
  );
  const changedPlanningDetail = structuredClone(readyStored);
  changedPlanningDetail.project.planning.teamNotes = 'Unexpected note';
  assert.throws(
    () => verifier.assertReadyContinuity(planningStored, changedPlanningDetail),
    assert.AssertionError
  );
});

test('CDP drives Planning, the operator confirmation control, Ready, and Load', () => {
  for (const contractText of [
    "#btnStagePrepare",
    "#prepareProjectSearch",
    "#prepareProjectList button[data-project-id]",
    "Planning \u00b7",
    "Review & mark Ready",
    "#serviceReadinessDialog",
    "#serviceReadinessConfirmed",
    "#btnMarkServiceReady",
    "Ready \u00b7",
    "Save & go to Load",
    "load-stage",
    "#loadServiceHandoffTitle",
    "#loadServiceHandoffBadge",
    "9 cues",
    "exact revision 4",
    "ready in Load"
  ]) {
    assert.ok(
      verifierSource.includes(contractText),
      `missing packaged UI assertion: ${contractText}`
    );
  }
  assert.match(verifierSource, /allowUnsafeEvalBlockedByCSP: true/);
  assert.match(verifierSource, /const IN_PAGE_VISIBLE_PREDICATE = `element =>/);
  assert.match(
    verifierSource,
    /const IN_PAGE_SCROLL_INTO_OWNER_PREDICATE = `\(owner, target\) =>/
  );
  for (const visibilityTerm of [
    'element.getClientRects().length === 0',
    'element.getBoundingClientRect()',
    'current = current.parentElement',
    "style.display === 'none'",
    "style.visibility !== 'visible'",
    'Number.parseFloat(style.opacity) > 0',
    'viewportWidth > 0',
    'viewportHeight > 0',
    'rect.right > 0',
    'rect.bottom > 0',
    'rect.left < viewportWidth',
    'rect.top < viewportHeight'
  ]) {
    assert.ok(
      verifierSource.includes(visibilityTerm),
      `missing in-page visibility predicate term: ${visibilityTerm}`
    );
  }
  assert.equal(
    (verifierSource.match(/const isVisible = \$\{IN_PAGE_VISIBLE_PREDICATE\};/g) || []).length,
    12,
    'all twelve critical control evaluations must install the shared visibility predicate'
  );
  assert.equal(
    (verifierSource.match(
      /const exposeWithin = \$\{IN_PAGE_SCROLL_INTO_OWNER_PREDICATE\};/g
    ) || []).length,
    4,
    'Planning, readiness review, confirmation, and Ready must prove sequential access'
  );
  for (const scrollAccessibilityTerm of [
    "target.scrollIntoView({ block: 'nearest', inline: 'nearest' })",
    'targetRect.top >= ownerRect.top - 1',
    'targetRect.bottom <= ownerRect.bottom + 1',
    "document.querySelector('.prepare-rundown-pane')",
    "document.querySelector('#prepareRundownList')",
    "['auto', 'scroll'].includes(scrollOwnerStyle?.overflowY)",
    "['auto', 'scroll'].includes(rundownListStyle?.overflowY)",
    'scrollOwner.scrollHeight <= scrollOwner.clientHeight',
    "['auto', 'scroll'].includes(dialogStyle?.overflowY)",
    "['auto', 'scroll'].includes(cardListStyle?.overflowY)",
    'dialog.scrollHeight <= dialog.clientHeight',
    "sequentialTargets.push('planning-heading')",
    "sequentialTargets.push('review-ready-primary')",
    "sequentialTargets.push('review-title')",
    "sequentialTargets.push('operator-confirmation')",
    "sequentialTargets.push('mark-ready-action')"
  ]) {
    assert.ok(
      verifierSource.includes(scrollAccessibilityTerm),
      `missing scroll-accessibility proof: ${scrollAccessibilityTerm}`
    );
  }
  for (const visibilityAssertion of [
    'isVisible(stagePrepare)',
    'isVisible(controlSurface)',
    'isVisible(search)',
    'isVisible(primary)',
    'isVisible(check)',
    'isVisible(dialog)',
    'isVisible(title)',
    'isVisible(confirmed)',
    'isVisible(markReady)',
    'isVisible(button)',
    'isVisible(handoff)',
    'isVisible(titleElement)',
    'isVisible(headingElement)',
    'isVisible(card)',
    'isVisible(badgeElement)',
    'isVisible(scheduleElement)',
    'isVisible(statusElement)'
  ]) {
    assert.ok(
      verifierSource.includes(visibilityAssertion),
      `missing critical visibility assertion: ${visibilityAssertion}`
    );
  }
  assert.ok(
    (verifierSource.match(/isVisible\(handoff\)/g) || []).length >= 2,
    'both final Load and restarted Load must require a visible handoff surface'
  );
  assert.ok(
    (verifierSource.match(/isVisible\(titleElement\)/g) || []).length >= 2,
    'both final Load and restarted Load must require a visible handoff title'
  );
  assert.ok(
    (verifierSource.match(/isVisible\(primary\)/g) || []).length >= 2,
    'Planning and Ready primary controls must both be visible'
  );
  assert.ok(
    (verifierSource.match(/isVisible\(markReady\)/g) || []).length >= 2,
    'Mark Ready must be sequentially exposed in review and before the automation click'
  );
  for (const repeatedVisibility of [
    'isVisible(headingElement)',
    'isVisible(badgeElement)',
    'isVisible(scheduleElement)',
    'isVisible(statusElement)'
  ]) {
    assert.ok(
      (verifierSource.split(repeatedVisibility).length - 1) >= 2,
      `${repeatedVisibility} must cover both relevant lifecycle surfaces`
    );
  }
  assert.match(verifierSource, /location\.href !==/);
  assert.match(verifierSource, /expectedControlUrl/);
  assert.match(verifierSource, /app\.asar/);
  assert.match(verifierSource, /fs\.constants\.O_NOFOLLOW/);
  assert.match(verifierSource, /READY_PROJECT_STORAGE_DIRECTORY/);
  assert.match(verifierSource, /manifest\.artifacts\.length, 60/);
  assert.match(verifierSource, /`channel-\$\{sha256Bytes\(/);
  assert.match(verifierSource, /channel\.directory, expectedDirectory/);
  assert.match(verifierSource, /channel\.metadataPath, `\$\{expectedDirectory\}\/metadata\.json`/);
  assert.match(verifierSource, /metadata\.slides\.map\(slide => slide\?\.cueId\), manifest\.cueIds/);
  assert.match(verifierSource, /`\$\{expectedDirectory\}\/scene_\$\{number\}\.json`/);
  assert.match(verifierSource, /`\$\{expectedDirectory\}\/slide_\$\{number\}_thumb\.jpg`/);
  assert.match(verifierSource, /scene\.cueId, cueId/);
  assert.match(verifierSource, /sceneEntries\.map\(\(\[artifactPath\]\) => artifactPath\)\.sort\(\)/);
  assert.match(verifierSource, /thumbnailRecords\.map\(record => record\.path\)\.sort\(\)/);
  assert.match(verifierSource, /packagedFont\.sha256, manifest\.font\.sha256/);
  assert.match(verifierSource, /async function assertDirectDirectory/);
  assert.match(verifierSource, /record\.type === 'directory'/);
  assert.match(verifierSource, /record\.mode === 0o700/);
  assert.match(verifierSource, /thumbnailRecords\.every\(record => record\.mode === 0o644\)/);
  assert.match(verifierSource, /record\.mode & 0o133/);
  assert.match(verifierSource, /privateFileRecords\.every\(record => record\.mode === 0o600\)/);
  assert.match(verifierSource, /packagedFont\.mode, 0o644/);
  assert.match(verifierSource, /projectRevisionUnchanged: true/);
  assert.match(verifierSource, /watchedExternalBytesUnchanged: true/);
  assert.match(verifierSource, /confirmationControl/);
  assert.match(verifierSource, /confirmationAction/);
  assert.match(verifierSource, /actor: 'automation'/);
  assert.match(verifierSource, /humanPresent: false/);
  assert.doesNotMatch(verifierSource, /humanConfirmation|human confirmation/i);
});

test('wait polling retries only explicit not-ready or bounded discovery transport', async () => {
  const launch = { cancellation: null, spawnError: null, exit: null };
  let notReadyCalls = 0;
  const ready = await verifier.waitFor(() => {
    notReadyCalls += 1;
    return notReadyCalls === 2 ? { ready: true } : null;
  }, 'explicit not-ready contract', launch, 1000);
  assert.deepEqual(ready, { ready: true });
  assert.equal(notReadyCalls, 2);

  let transportCalls = 0;
  const discovered = await verifier.waitFor(() => {
    transportCalls += 1;
    if (transportCalls === 1) {
      throw new verifier.RetryableDiscoveryTransportError('bounded startup transport');
    }
    return { discovered: true };
  }, 'retryable discovery contract', launch, 1000);
  assert.deepEqual(discovered, { discovered: true });
  assert.equal(transportCalls, 2);

  for (const fatal of [
    new verifier.PackagedPlanningVerificationError(
      'UNEXPECTED_OUTPUT_WINDOW',
      'one-shot output invariant'
    ),
    new assert.AssertionError({ message: 'one-shot assertion invariant' }),
    new Error('one-shot generic invariant')
  ]) {
    let fatalCalls = 0;
    await assert.rejects(
      verifier.waitFor(() => {
        fatalCalls += 1;
        throw fatal;
      }, 'fatal invariant contract', launch, 1000),
      error => error === fatal
    );
    assert.equal(fatalCalls, 1);
  }
  let falseCalls = 0;
  await assert.rejects(
    verifier.waitFor(() => {
      falseCalls += 1;
      return false;
    }, 'invalid falsy wait result', launch, 1000),
    error => error?.code === 'INVALID_WAIT_RESULT'
  );
  assert.equal(falseCalls, 1);
});

test('CDP call and renderer exceptions are fatal on the first evaluation', async () => {
  const launch = { cancellation: null, spawnError: null, exit: null };
  const rendererException = new verifier.CdpSession('ws://contract.invalid');
  let exceptionCalls = 0;
  rendererException.call = async () => {
    exceptionCalls += 1;
    return { exceptionDetails: { text: 'readiness dialog invariant failed' } };
  };
  await assert.rejects(
    verifier.waitForEvaluation(
      rendererException,
      '(() => null)()',
      'readiness dialog contract',
      launch,
      1000
    ),
    error => error?.code === 'CDP_EVALUATION_EXCEPTION'
      && error?.fatalWait === true
  );
  assert.equal(exceptionCalls, 1);

  const callFailure = new verifier.CdpSession('ws://contract.invalid');
  let callFailures = 0;
  callFailure.call = async () => {
    callFailures += 1;
    throw new Error('CDP transport closed');
  };
  await assert.rejects(
    verifier.waitForEvaluation(
      callFailure,
      '(() => null)()',
      'CDP call failure contract',
      launch,
      1000
    ),
    error => error?.code === 'CDP_EVALUATION_CALL_FAILED'
      && error?.fatalWait === true
  );
  assert.equal(callFailures, 1);
  assert.match(verifierSource, /if \(error\?\.retryableWait !== true\) throw error/);
  assert.match(verifierSource, /fail\('UNEXPECTED_OUTPUT_WINDOW'/);
  assert.match(verifierSource, /throw new Error\(error\.textContent\.trim\(\)\)/);
  const outputInvariant = verifierSource.indexOf("fail('UNEXPECTED_OUTPUT_WINDOW'");
  const controlNotReady = verifierSource.indexOf(
    "if (!control || typeof control.webSocketDebuggerUrl !== 'string') return null;"
  );
  assert.ok(
    outputInvariant >= 0 && outputInvariant < controlNotReady,
    'an output renderer must fail before a missing control target can be retried'
  );
});

test('restart reuses the exact profile and rejects Show resurrection or byte drift', () => {
  const firstLaunch = verifierSource.indexOf(
    'const firstLaunch = launchPackagedApp('
  );
  const restartLaunch = verifierSource.indexOf(
    'const restartLaunch = launchPackagedApp('
  );
  assert.ok(firstLaunch >= 0 && restartLaunch > firstLaunch);
  const firstRunComplete = verifierSource.indexOf(
    'evidence.planningToLoad = await runPlanningToLoad('
  );
  const stalePortCleanup = verifierSource.indexOf(
    "prepareDevToolsActivePort(\n      temp.profilePath,\n      'restart'",
    firstRunComplete
  );
  assert.ok(
    firstRunComplete >= 0
      && stalePortCleanup > firstRunComplete
      && restartLaunch > stalePortCleanup,
    'the stale first-run DevTools port must be cleared after close and before restart spawn'
  );
  assert.match(verifierSource, /priorLaunch\?\.processGroupAbsence\?\.absent/);
  assert.match(verifierSource, /readDirectFile\(portFile, 4096, 'active DevToolsActivePort'\)/);
  assert.match(
    verifierSource,
    /preparedServiceRestore\?\.status !== 'restored'/
  );
  assert.match(verifierSource, /showState\?\.phase, 'idle'/);
  assert.match(verifierSource, /showState\?\.outputSessionId, null/);
  assert.match(verifierSource, /appState\.totalSlides !== 0/);
  assert.match(
    verifierSource,
    /appState\.serviceHandoff\.cueIds\.length !== \$\{EXPECTED_PREPARED_CUE_COUNT\}/
  );
  assert.match(verifierSource, /preparedPresentationsReady/);
  assert.doesNotMatch(verifierSource, /finalAppState\.totalSlides, 9/);
  assert.doesNotMatch(verifierSource, /appState\.totalSlides !== 9/);
  assert.match(verifierSource, /exactDurableBytesUnchanged: true/);
  assert.match(verifierSource, /noShowAutoResurrection: true/);
  assert.match(verifierSource, /assert\.deepEqual\(finalHashes, paths\.hashes\)/);
  assert.match(verifierSource, /appState\.displays\.length,[\s\S]*1/);
  assert.equal(
    (verifierSource.match(/appState\.displays\.length !== 1/g) || []).length >= 2,
    true,
    'both startup waits must require the exact one-display state'
  );
});

test('prepared Load state separates installed cue count from the live Show counter', () => {
  const preparedLoadState = {
    currentSlide: 0,
    totalSlides: 0,
    displays: [{ id: 1 }],
    showState: { phase: 'idle', outputSessionId: null },
    serviceHandoff: {
      cueIds: Array.from({ length: 9 }, (_, index) => `cue-${index + 1}`)
    },
    presentations: Object.fromEntries(
      ['english', 'media', 'russian'].map(roleId => [
        roleId,
        { loaded: true, slideCount: 9 }
      ])
    )
  };

  assert.doesNotThrow(() => verifier.assertPreparedLoadState(preparedLoadState));
  assert.throws(
    () => verifier.assertPreparedLoadState({ ...preparedLoadState, totalSlides: 9 }),
    /live Show slide counter at zero/
  );
  assert.throws(
    () => verifier.assertPreparedLoadState({
      ...preparedLoadState,
      serviceHandoff: { cueIds: preparedLoadState.serviceHandoff.cueIds.slice(0, 8) }
    })
  );
  assert.throws(
    () => verifier.assertPreparedLoadState({
      ...preparedLoadState,
      presentations: {
        ...preparedLoadState.presentations,
        media: { loaded: false, slideCount: 9 }
      }
    })
  );
  assert.throws(
    () => verifier.assertPreparedLoadState({
      ...preparedLoadState,
      presentations: {
        english: preparedLoadState.presentations.english,
        russian: preparedLoadState.presentations.russian
      }
    })
  );
});

test('restart stale DevToolsActivePort is removed only after group absence', async t => {
  const profilePath = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    'syncshow-stale-devtools-contract-'
  )));
  t.after(() => fs.rmSync(profilePath, { recursive: true, force: true }));
  fs.chmodSync(profilePath, 0o700);
  const portPath = path.join(profilePath, 'DevToolsActivePort');
  fs.writeFileSync(
    portPath,
    '1234\n/devtools/browser/stale-contract\n',
    { mode: 0o600 }
  );
  const removed = await verifier.prepareDevToolsActivePort(
    profilePath,
    'restart',
    { processGroupAbsence: { absent: true } }
  );
  assert.equal(removed.status, 'stale-file-removed-before-restart');
  assert.equal(removed.staleFileRemoved, true);
  assert.match(removed.staleSha256, /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(portPath), false);

  await assert.rejects(
    verifier.prepareDevToolsActivePort(
      profilePath,
      'restart',
      { processGroupAbsence: { absent: false } }
    ),
    assert.AssertionError
  );

  const target = path.join(profilePath, 'port-target');
  fs.writeFileSync(target, '1234\n/devtools/browser/target\n', { mode: 0o600 });
  fs.symlinkSync(target, portPath);
  await assert.rejects(
    verifier.prepareDevToolsActivePort(
      profilePath,
      'restart',
      { processGroupAbsence: { absent: true } }
    ),
    error => error?.code === 'UNSAFE_DIRECT_READ'
  );
});

test('cleanup is confined, status-bearing, and written into non-overwriting evidence', () => {
  assert.equal(
    verifier.confinedTempChild(
      '/private/tmp',
      '/private/tmp/syncshow-packaged-operational-planning-123'
    ),
    true
  );
  assert.equal(verifier.confinedTempChild('/private/tmp', '/private/tmp'), false);
  assert.equal(verifier.confinedTempChild('/private/tmp', '/private/var'), false);
  assert.match(
    verifierSource,
    /status: 'retained-process-group-absence-unproven'/
  );
  assert.match(verifierSource, /status: 'retained-unsafe-path'/);
  assert.match(verifierSource, /status: remains \? 'cleanup-failed' : 'removed'/);
  assert.match(verifierSource, /const detached = true/);
  assert.match(verifierSource, /detached,/);
  assert.match(verifierSource, /processGroupBound:/);
  assert.match(verifierSource, /process\.kill\(-processGroupId, 0\)/);
  assert.match(verifierSource, /process\.kill\(-launch\.processGroupId, signal\)/);
  assert.match(verifierSource, /process\.on\(signal, handler\)/);
  assert.match(verifierSource, /cancellation\.dispose\(\)/);
  assert.match(verifierSource, /await fsp\.open\(tempPath, 'wx', 0o600\)/);
  assert.match(verifierSource, /await handle\.sync\(\)/);
  assert.match(verifierSource, /await fsp\.link\(tempPath, resultPath\)/);
  assert.match(verifierSource, /await fsyncDirectory\(directoryPath\)/);
  assert.match(verifierSource, /proofBoundary:/);
  assert.match(
    verifierSource,
    /No Show, Finish, phone, venue, install, notarization, DMG, ZIP, or adoption claim/
  );

  const cleanupIndex = verifierSource.indexOf(
    'evidence.cleanup = await cleanupTempProfile(temp, launches)'
  );
  const finalCancellationIndex = verifierSource.indexOf(
    'applyCancellation();',
    cleanupIndex
  );
  const disposeIndex = verifierSource.indexOf(
    'cancellation.dispose();',
    finalCancellationIndex
  );
  const cancellationEvidenceIndex = verifierSource.indexOf(
    'evidence.cancellation = cancellation.evidence();',
    disposeIndex
  );
  const publishIndex = verifierSource.indexOf(
    'const publication = await publishEvidenceIfAllowed(',
    cancellationEvidenceIndex
  );
  assert.ok(
    cleanupIndex >= 0
      && finalCancellationIndex > cleanupIndex
      && disposeIndex > finalCancellationIndex
      && cancellationEvidenceIndex > disposeIndex
      && publishIndex > cancellationEvidenceIndex,
    'cancellation must be finalized and handlers removed before one atomic publication'
  );
  assert.doesNotMatch(
    verifierSource,
    /writeEvidence\(proof\.resultPath, evidence,/
  );
  assert.match(
    verifierSource,
    /publishEvidenceIfAllowed\([\s\S]*evidencePublicationAllowed/
  );
});

test('evidence publication is complete, owner-only, atomic, and no-overwrite', async t => {
  const proofRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'syncshow-packaged-evidence-contract-'
  ));
  t.after(() => fs.rmSync(proofRoot, { recursive: true, force: true }));
  const resultPath = path.join(
    proofRoot,
    'packaged-operational-planning-restart.json'
  );
  const evidence = { ok: true, marker: 'first-complete-evidence' };
  const publication = await verifier.writeEvidence(resultPath, evidence);
  const firstBytes = fs.readFileSync(resultPath, 'utf8');
  assert.deepEqual(JSON.parse(firstBytes), evidence);
  assert.equal(fs.statSync(resultPath).mode & 0o777, 0o600);
  assert.equal(publication.publication, 'fsynced-owner-only-temp-hard-link-no-overwrite');

  await assert.rejects(
    verifier.writeEvidence(resultPath, { ok: false, marker: 'replacement' }),
    error => error?.code === 'EEXIST'
  );
  assert.equal(fs.readFileSync(resultPath, 'utf8'), firstBytes);
  assert.deepEqual(fs.readdirSync(proofRoot), [path.basename(resultPath)]);
});

test('prelaunch cancellation rejects work and removes installed handlers', async () => {
  const cancellation = verifier.createCancellationController([]);
  try {
    cancellation.request('SIGTERM');
    assert.equal(cancellation.requested, true);
    assert.equal(cancellation.signal, 'SIGTERM');
    await assert.rejects(
      verifier.raceCancellation(
        Promise.resolve('must-not-complete'),
        cancellation,
        'unit prelaunch work'
      ),
      error => error?.code === 'VERIFIER_CANCELLED'
    );
  } finally {
    cancellation.dispose();
  }
  assert.equal(cancellation.handlersRemoved, true);
});

test('dedicated test process group is killed and proven absent', async t => {
  if (process.platform !== 'darwin') {
    t.skip('The verifier intentionally binds process groups only on macOS.');
    return;
  }
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    });
    setInterval(() => {}, 1000);
  `], {
    detached: true,
    stdio: 'ignore'
  });
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  });
  const launch = {
    phase: 'contract-process-group',
    pid: child.pid,
    processGroupId: child.pid,
    processGroupBound: true,
    processGroupAbsence: null,
    exit: null
  };
  launch.closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      launch.exit = { code, signal: signal || null };
      resolve(launch.exit);
    });
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(verifier.processGroupState(launch).absent, false);
  const termination = await verifier.terminateLaunch(launch);
  assert.equal(termination.processGroup.absent, true);
  assert.equal(verifier.processGroupState(launch).absent, true);
});
