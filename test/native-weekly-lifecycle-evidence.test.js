'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CurrentShowPackageStore,
  ServiceProjectStore,
  ShowPackagePublisher,
  analyzeServiceProjectReadiness,
  compileServiceProject,
  preparedServiceVenueRevisionId,
  validateCurrentShowPackageBinding
} = require('../src/services/project');
const {
  ShowRehearsalReceiptStore,
  VolunteerShowPolicyError,
  authorizeVolunteerShowCommand,
  normalizeVolunteerShowBinding,
  resolveLaunchPlan
} = require('../src/services/show');
const {
  CHANNELS,
  CONDENSED_SERMON_TEXT,
  PROFILE_ID,
  READY_PROJECT_ID,
  SERMON_READING_OUTPUTS,
  createTrackedNativeWeeklyService
} = require('./fixtures/native-weekly-service');

const FONT_PATH = path.resolve(
  __dirname,
  '../assets/fonts/NotoSans-Variable.ttf'
);
const ACTIVATION_ID = '11111111-1111-4111-8111-111111111111';
const PUBLISH_NOW = '2026-08-09T17:00:00.000Z';
const BSB_READING_BODY = [
  '¹⁰\u00a0His purpose was that now, through the church, the manifold wisdom of God should be made known to the rulers and authorities in the heavenly realms,',
  '¹¹\u00a0according to the eternal purpose that He accomplished in Christ Jesus our Lord.',
  '¹²\u00a0In Him and through faith in Him we may enter God’s presence with boldness and confidence.'
].join(' ');
const LSV_READING_BODY = [
  '¹⁰\u00a0that there might be made known now to the principalities and the authorities in the heavenly [places], through the Assembly, the manifold wisdom of God,',
  '¹¹\u00a0according to a purpose of the ages, which He made in Christ Jesus our Lord,',
  '¹²\u00a0in whom we have the freedom and the access in confidence through the faith of Him,'
].join(' ');
const BSB_READING_SHA256 =
  '89816606a4a1819988c7b51b21060d832934490f23c2fe041a1e86f2c18ab284';
const LSV_READING_SHA256 =
  'd9a7ce0ec5ea0f430fad3589763bacb19bbaa22d9bd545447112a5acfb9004d1';
const PRIMARY_SERMON_SOURCE_TEXT =
  'Церковь показывает Божью мудрость.';
const SECONDARY_SERMON_SOURCE_TEXT =
  'The church displays the wisdom of God.';
const COMPILED_SERMON_READING_OUTPUTS = Object.freeze([
  SERMON_READING_OUTPUTS[2],
  SERMON_READING_OUTPUTS[0],
  SERMON_READING_OUTPUTS[1]
]);

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-native-weekly-lifecycle-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function venueProfile() {
  return {
    schemaVersion: 2,
    id: PROFILE_ID,
    operator: {
      showControlMode: 'volunteer'
    },
    inputRoles: [
      { id: 'front', label: 'Russian', enabled: true, kind: 'deck' },
      { id: 'translation', label: 'English', enabled: true, kind: 'deck' },
      { id: 'singers', label: 'Singers', enabled: true, kind: 'deck' }
    ],
    outputs: []
  };
}

function launchOutputs() {
  return [
    {
      id: 'front-projector',
      name: 'Front projector',
      kind: 'normal',
      displayId: 2,
      expectedRole: 'front',
      operatorPreview: false
    },
    {
      id: 'translation-projector',
      name: 'Translation projector',
      kind: 'normal',
      displayId: 3,
      expectedRole: 'translation',
      operatorPreview: false
    },
    {
      id: 'singers-monitor',
      name: 'Singers monitor',
      kind: 'singer',
      displayId: 4,
      expectedRole: 'singers',
      operatorPreview: true
    }
  ];
}

function assertLocked(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof VolunteerShowPolicyError);
    assert.equal(error.code, code);
    return true;
  });
}

test('tracked all-native weekly service crosses plan, publish, activation, fresh-store Load binding, and volunteer policy', async t => {
  const workspace = await tempDirectory(t);
  const fixture = await createTrackedNativeWeeklyService(workspace);
  const project = fixture.ready.project;

  assert.equal(project.id, READY_PROJECT_ID);
  assert.equal(project.planning.status, 'ready');
  assert.equal(project.planning.templateSource.projectId, fixture.prior.project.id);
  assert.equal(
    project.planning.templateSource.sourceRevisionId,
    fixture.prior.revisionId
  );
  assert.equal(project.items['prior-week-song-item'], undefined);
  assert.ok(project.items['native-weekly-song-item']);
  assert.equal(project.items['prior-sermon-cue'], undefined);
  assert.equal(project.items['prior-sermon-reading'], undefined);
  const priorReading = fixture.prior.project.items['prior-sermon-reading'];
  assert.equal(priorReading.sermonReading.translationId, 'FIXTURE');
  assert.equal(priorReading.sermonReading.outputs, undefined);
  assert.deepEqual(
    Object.keys(priorReading.passagesByChannel),
    ['media', 'primary', 'secondary']
  );
  const priorTimeline = compileServiceProject(fixture.prior.project);
  assert.equal(
    priorTimeline.cueIds.some(cueId =>
      priorTimeline.cues[cueId].sourceReference?.translationId === 'FIXTURE'),
    true
  );
  assert.deepEqual(
    project.items.sermon.childIds,
    ['native-sermon-slide-1', 'native-sermon-slide-2']
  );
  const condensedSermonItem = project.items['native-sermon-slide-1'];
  assert.deepEqual(condensedSermonItem.textByChannel, {
    primary: PRIMARY_SERMON_SOURCE_TEXT,
    secondary: CONDENSED_SERMON_TEXT
  });
  assert.equal(condensedSermonItem.sourceBodyProjection.schemaVersion, 2);
  assert.equal(
    condensedSermonItem.sourceBodyProjection.channels.primary.mode,
    'exact'
  );
  assert.equal(
    condensedSermonItem.sourceBodyProjection.channels.secondary.mode,
    'condensed'
  );
  assert.equal(
    condensedSermonItem.sourceBodyProjection.channels.primary.sourceTextSha256,
    crypto.createHash('sha256')
      .update(PRIMARY_SERMON_SOURCE_TEXT, 'utf8')
      .digest('hex')
  );
  assert.equal(
    condensedSermonItem.sourceBodyProjection.channels.primary.projectedTextSha256,
    condensedSermonItem.sourceBodyProjection.channels.primary.sourceTextSha256
  );
  assert.equal(
    condensedSermonItem.sourceBodyProjection.channels.secondary.sourceTextSha256,
    crypto.createHash('sha256')
      .update(SECONDARY_SERMON_SOURCE_TEXT, 'utf8')
      .digest('hex')
  );
  assert.equal(
    condensedSermonItem.sourceBodyProjection.channels.secondary.projectedTextSha256,
    crypto.createHash('sha256')
      .update(CONDENSED_SERMON_TEXT, 'utf8')
      .digest('hex')
  );
  assert.equal(
    project.items['native-sermon-slide-2'].sourceBodyProjection.schemaVersion,
    1
  );
  assert.deepEqual(
    project.items.service.childIds,
    ['opening', 'native-sermon-reading-1', 'sermon', 'closing-blank']
  );
  assert.ok(project.items['welcome-picture']);
  assert.deepEqual(project.channelIds, CHANNELS.map(channel => channel.id));
  const generatedReading = project.items['native-sermon-reading-1'];
  assert.deepEqual(generatedReading.sermonReading.outputs, SERMON_READING_OUTPUTS);
  assert.equal(generatedReading.sermonReading.translationId, undefined);
  assert.deepEqual(Object.keys(generatedReading.passagesByChannel), [
    'primary',
    'secondary'
  ]);
  assert.equal(
    generatedReading.passagesByChannel.primary.translationId,
    'BSB'
  );
  assert.equal(
    generatedReading.passagesByChannel.secondary.translationId,
    'LSV'
  );
  assert.notEqual(
    generatedReading.passagesByChannel.primary.contentSha256,
    generatedReading.passagesByChannel.secondary.contentSha256
  );

  const serializedProject = JSON.stringify(project);
  assert.doesNotMatch(
    serializedProject,
    /\.pptx?\b|imported-deck|legacy-deck/i
  );
  assert.equal(
    Object.values(project.items).some(item => item.kind === 'imported-deck'),
    false
  );

  const readiness = analyzeServiceProjectReadiness(project);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.waivedChecks, []);
  assert.deepEqual(
    readiness.checks.map(check => [check.id, check.status]),
    [
      ['compilable-nonempty', 'pass'],
      ['song-present', 'pass'],
      ['exact-sermon-link', 'pass'],
      ['linked-sermon-material', 'pass'],
      ['sermon-reading-before-material', 'pass'],
      ['channel-visible-content', 'pass']
    ]
  );
  const timeline = compileServiceProject(project);
  assert.equal(timeline.cueIds.length, 9);
  assert.deepEqual(
    timeline.cueIds.map(cueId => timeline.cues[cueId].kind),
    [
      'song',
      'song',
      'song',
      'notice',
      'picture',
      'bible',
      'sermon',
      'sermon',
      'blank'
    ]
  );
  assert.equal(
    timeline.cueIds.some(cueId =>
      Object.values(timeline.cues[cueId].channels)
        .flatMap(channel => channel.blocks || [])
        .some(block => block.type === 'legacy-deck')),
    false
  );
  const bibleCueId = timeline.cueIds[5];
  const compiledReading = timeline.cues[bibleCueId];
  assert.equal(compiledReading.kind, 'bible');
  assert.deepEqual(
    compiledReading.sourceReference.outputs,
    COMPILED_SERMON_READING_OUTPUTS
  );
  assert.equal(compiledReading.sourceReference.translationId, undefined);
  assert.equal(
    compiledReading.channels.primary.blocks[0].translationId,
    'BSB'
  );
  assert.equal(
    compiledReading.channels.secondary.blocks[0].translationId,
    'LSV'
  );
  assert.deepEqual(compiledReading.channels.media, {
    mode: 'hide',
    blocks: []
  });
  const firstSermonCue = timeline.cues[timeline.cueIds[6]];
  assert.equal(firstSermonCue.kind, 'sermon');
  assert.equal(firstSermonCue.channels.primary.mode, 'content');
  assert.equal(
    firstSermonCue.channels.primary.blocks[0].text,
    PRIMARY_SERMON_SOURCE_TEXT
  );
  assert.equal(firstSermonCue.channels.secondary.mode, 'condensed');
  assert.equal(
    firstSermonCue.channels.secondary.blocks[0].text,
    CONDENSED_SERMON_TEXT
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      firstSermonCue.channels.secondary,
      'sourceChannelId'
    ),
    false
  );
  assert.deepEqual(firstSermonCue.channels.media, {
    mode: 'hide',
    blocks: []
  });

  const pictureAssetId = project.items['welcome-picture'].assetId;
  const priorPicture = await fixture.projectStore.resolveAssetPath(
    fixture.prior.project.id,
    fixture.prior.revisionId,
    pictureAssetId
  );
  const plannedPicture = await fixture.projectStore.resolveAssetPath(
    project.id,
    fixture.ready.revisionId,
    pictureAssetId
  );
  assert.notEqual(priorPicture.assetPath, plannedPicture.assetPath);
  await fs.unlink(priorPicture.assetPath);
  assert.equal(
    (await fixture.projectStore.resolveAssetPath(
      project.id,
      fixture.ready.revisionId,
      pictureAssetId
    )).asset.sha256,
    pictureAssetId.slice('sha256:'.length)
  );

  const packagesPath = path.join(workspace, 'show-packages');
  const publisher = new ShowPackagePublisher({
    projectStore: fixture.projectStore,
    rootPath: packagesPath,
    fontPath: FONT_PATH,
    clock: () => new Date(PUBLISH_NOW)
  });
  const published = await publisher.publish({
    projectId: project.id,
    revisionId: fixture.ready.revisionId,
    roleMapping: {
      front: 'primary',
      translation: 'secondary',
      singers: 'media'
    },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 82
  });

  assert.equal(published.manifest.projectId, project.id);
  assert.equal(
    published.manifest.projectRevisionId,
    fixture.ready.revisionId
  );
  assert.equal(published.manifest.cueCount, timeline.cueIds.length);
  assert.deepEqual(published.manifest.cueIds, timeline.cueIds);
  assert.equal(published.serviceHandoff.readiness.ready, true);
  assert.equal(published.serviceHandoff.planning.status, 'ready');
  assert.deepEqual(Object.keys(published.presentations), [
    'front',
    'translation',
    'singers'
  ]);
  for (const presentation of Object.values(published.presentations)) {
    assert.equal(presentation.sourceType, 'service-project');
    assert.equal(presentation.renderer, 'native-cue');
    assert.equal(presentation.slideCount, timeline.cueIds.length);
    assert.equal(presentation.scenes.length, timeline.cueIds.length);
    assert.equal(
      presentation.scenes.some(scene => scene.layout === 'legacy-deck'),
      false
    );
  }
  const bibleCueIndex = published.presentations.front.scenes.findIndex(
    scene => scene.sourceKind === 'bible'
  );
  assert.equal(bibleCueIndex, 5);
  for (const roleId of ['front', 'translation']) {
    const scene = published.presentations[roleId].scenes[bibleCueIndex];
    assert.equal(scene.layout, 'text');
    assert.equal(scene.sourceKind, 'bible');
    assert.deepEqual(scene.canvas, { width: 640, height: 360 });
  }
  const frontBibleScene = published.presentations.front.scenes[bibleCueIndex];
  const translationBibleScene =
    published.presentations.translation.scenes[bibleCueIndex];
  const singersBibleScene =
    published.presentations.singers.scenes[bibleCueIndex];
  assert.equal(frontBibleScene.title, 'Ephesians 3:10–12');
  assert.equal(frontBibleScene.body, BSB_READING_BODY);
  assert.equal(translationBibleScene.title, 'Ephesians 3:10–12');
  assert.equal(translationBibleScene.body, LSV_READING_BODY);
  assert.notEqual(frontBibleScene.body, translationBibleScene.body);
  assert.equal(
    crypto.createHash('sha256')
      .update(frontBibleScene.body, 'utf8')
      .digest('hex'),
    BSB_READING_SHA256
  );
  assert.equal(
    crypto.createHash('sha256')
      .update(translationBibleScene.body, 'utf8')
      .digest('hex'),
    LSV_READING_SHA256
  );
  assert.equal(frontBibleScene.style.bodySize, 52);
  assert.equal(frontBibleScene.style.bodyMinimumSize, 28);
  assert.equal(frontBibleScene.style.bodyWidthPercent, 82);
  assert.equal(frontBibleScene.style.bodyRegionHeightPercent, 66);
  assert.equal(singersBibleScene.layout, 'blank');
  assert.equal(singersBibleScene.sourceKind, 'bible');
  assert.deepEqual(singersBibleScene.canvas, { width: 640, height: 360 });
  assert.equal('body' in singersBibleScene, false);
  const firstSermonCueIndex = 6;
  assert.equal(
    published.presentations.front.scenes[firstSermonCueIndex].body,
    PRIMARY_SERMON_SOURCE_TEXT
  );
  assert.equal(
    published.presentations.translation.scenes[firstSermonCueIndex].body,
    CONDENSED_SERMON_TEXT
  );
  assert.equal(
    published.presentations.singers.scenes[firstSermonCueIndex].layout,
    'blank'
  );

  const persistedTimeline = JSON.parse(await fs.readFile(
    path.join(published.packagePath, 'timeline.json'),
    'utf8'
  ));
  assert.deepEqual(
    persistedTimeline.cues[bibleCueId].sourceReference.outputs,
    COMPILED_SERMON_READING_OUTPUTS
  );
  assert.equal(
    persistedTimeline.cues[bibleCueId].channels.primary.blocks[0].translationId,
    'BSB'
  );
  assert.equal(
    persistedTimeline.cues[bibleCueId].channels.secondary.blocks[0].translationId,
    'LSV'
  );
  assert.equal(
    persistedTimeline.cues[bibleCueId].channels.media.mode,
    'hide'
  );
  assert.equal(
    persistedTimeline.cues[timeline.cueIds[firstSermonCueIndex]]
      .channels.secondary.mode,
    'condensed'
  );

  const profile = venueProfile();
  const profileRevisionId = preparedServiceVenueRevisionId(profile);
  const pointerRoot = path.join(workspace, 'prepared-service');
  const currentStore = new CurrentShowPackageStore({
    rootPath: pointerRoot,
    clock: () => new Date(PUBLISH_NOW),
    randomUUID: () => ACTIVATION_ID
  });
  const activationReceipt = await currentStore.activateWithReceipt({
    packageId: published.manifest.id,
    packageManifestSha256: published.manifestSha256,
    projectId: published.manifest.projectId,
    projectRevisionId: published.manifest.projectRevisionId,
    projectRevision: published.manifest.projectRevision,
    serviceDate: published.serviceHandoff.project.serviceDate,
    venueProfileId: profile.id,
    venueProfileRevisionId: profileRevisionId
  });
  assert.equal(activationReceipt.previousPointer, null);
  const activated = activationReceipt.pointer;

  const restartedProjectStore = new ServiceProjectStore({
    rootPath: path.join(workspace, 'service-projects')
  });
  const restartedPublisher = new ShowPackagePublisher({
    projectStore: restartedProjectStore,
    rootPath: packagesPath,
    fontPath: FONT_PATH
  });
  const restartedCurrentStore = new CurrentShowPackageStore({
    rootPath: pointerRoot
  });
  const reopenedPointer = await restartedCurrentStore.read();
  const reopened = await restartedPublisher.open(reopenedPointer.packageId);
  const binding = validateCurrentShowPackageBinding({
    pointer: reopenedPointer,
    manifest: reopened.manifest,
    manifestSha256: reopened.manifestSha256,
    serviceHandoff: reopened.serviceHandoff,
    venueProfileId: profile.id,
    venueProfileRevisionId: profileRevisionId,
    enabledRoleIds: ['front', 'translation', 'singers'],
    presentationRoleIds: Object.keys(reopened.presentations)
  });

  assert.deepEqual(reopenedPointer, activated);
  assert.equal(binding.packageId, published.manifest.id);
  assert.equal(binding.projectRevisionId, fixture.ready.revisionId);
  assert.deepEqual(binding.roleIds, ['front', 'singers', 'translation']);
  assert.equal(reopened.serviceHandoff.readiness.ready, true);
  assert.equal(reopened.serviceHandoff.planning.status, 'ready');
  assert.equal(
    reopened.presentations.front.scenes[bibleCueIndex].body,
    BSB_READING_BODY
  );
  assert.equal(
    reopened.presentations.translation.scenes[bibleCueIndex].body,
    LSV_READING_BODY
  );
  assert.equal(
    reopened.presentations.singers.scenes[bibleCueIndex].layout,
    'blank'
  );
  assert.equal(
    reopened.presentations.front.scenes[firstSermonCueIndex].body,
    PRIMARY_SERMON_SOURCE_TEXT
  );
  assert.equal(
    reopened.presentations.translation.scenes[firstSermonCueIndex].body,
    CONDENSED_SERMON_TEXT
  );
  assert.equal(
    reopened.presentations.singers.scenes[firstSermonCueIndex].layout,
    'blank'
  );

  const launchPlan = resolveLaunchPlan({
    presentations: reopened.presentations,
    outputs: launchOutputs(),
    decisions: {},
    preferredTimelineRoleId: 'front'
  });
  assert.equal(launchPlan.totalSlides, timeline.cueIds.length);
  assert.equal(launchPlan.timelineRoleId, 'front');
  assert.deepEqual(
    launchPlan.outputs.map(output => [
      output.id,
      output.renderer,
      output.sourceRoleId,
      output.operatorPreview
    ]),
    [
      ['front-projector', 'native-cue', 'front', false],
      ['translation-projector', 'native-cue', 'translation', false],
      ['singers-monitor', 'native-cue', 'singers', true]
    ]
  );

  const volunteerBinding = normalizeVolunteerShowBinding({
    showId: published.manifest.id,
    showFingerprint: published.manifestSha256,
    venueProfileId: profile.id,
    venueFingerprint: profileRevisionId,
    outputSessionId: 'session-native-weekly-0001'
  });
  assert.equal(volunteerBinding.showId, published.manifest.id);
  assert.equal(
    authorizeVolunteerShowCommand({
      mode: profile.operator.showControlMode,
      authority: 'locked',
      source: 'local',
      type: 'cue.next'
    }).allowed,
    true
  );
  assertLocked('VOLUNTEER_COMMAND_LOCKED', () =>
    authorizeVolunteerShowCommand({
      mode: profile.operator.showControlMode,
      authority: 'locked',
      source: 'local',
      type: 'cue.previous'
    }));
  assertLocked('VOLUNTEER_COMMAND_LOCKED', () =>
    authorizeVolunteerShowCommand({
      mode: profile.operator.showControlMode,
      authority: 'locked',
      source: 'local',
      type: 'cue.jump'
    }));

  // This non-GUI journey deliberately does not manufacture the output-window
  // acknowledgements required by a rehearsal receipt. A real Electron run
  // must render and acknowledge every cue on every output before this store
  // can truthfully become non-empty.
  const rehearsalStore = new ShowRehearsalReceiptStore({
    rootPath: path.join(workspace, 'show-readiness')
  });
  assert.equal(await rehearsalStore.read(), null);
});
