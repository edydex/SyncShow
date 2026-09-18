'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  CurrentShowPackageStore,
  ServiceProjectStore,
  ShowPackagePublisher,
  addProjectItem,
  validateCurrentShowPackageBinding
} = require('../src/services/project');

const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');
const NOW = '2026-07-28T18:30:00.000Z';
const ACTIVATION_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_REVISION_ID = 'a'.repeat(64);

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-current-package-restart-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('published package, pointer, picture, and handoff reopen together after fresh instances', async t => {
  const workspace = await tempDirectory(t);
  const projectsPath = path.join(workspace, 'projects');
  const packagesPath = path.join(workspace, 'packages');
  const pointerPath = path.join(workspace, 'prepared-service');
  const sourceImagePath = path.join(workspace, 'welcome.png');
  const clock = () => new Date(NOW);
  await sharp({
    create: {
      width: 64,
      height: 36,
      channels: 3,
      background: '#173a63'
    }
  }).png().toFile(sourceImagePath);

  const projectStore = new ServiceProjectStore({ rootPath: projectsPath, clock });
  const created = await projectStore.create({
    id: 'restart-service',
    title: 'Restart-safe Sunday',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary'
  });
  const saved = await projectStore.importImageAndUpdateProject(
    created.project.id,
    {
      sourcePath: sourceImagePath,
      expectedRevisionId: created.revisionId,
      altText: 'Welcome artwork',
      attribution: 'Church archive',
      reason: 'restart-fixture-picture'
    },
    (project, asset) => addProjectItem(project, {
      id: 'welcome-picture',
      kind: 'picture',
      title: 'Welcome',
      assetId: asset.id,
      channelIds: ['primary', 'media'],
      fit: 'fit',
      focalPoint: { x: 0.5, y: 0.5 },
      altText: asset.altText,
      attribution: asset.attribution,
      presetId: 'picture-fullscreen',
      operatorNotes: 'Advance when the room is ready.'
    }, { now: NOW })
  );
  const publisher = new ShowPackagePublisher({
    projectStore,
    rootPath: packagesPath,
    fontPath: FONT_PATH,
    clock
  });
  const published = await publisher.publish({
    projectId: saved.project.id,
    revisionId: saved.revisionId,
    roleMapping: {
      main: 'primary',
      singers: 'media'
    },
    width: 640,
    height: 360,
    thumbnailWidth: 100
  });
  assert.match(published.manifestSha256, /^[a-f0-9]{64}$/);

  const currentStore = new CurrentShowPackageStore({
    rootPath: pointerPath,
    clock,
    randomUUID: () => ACTIVATION_ID
  });
  const activated = await currentStore.activate({
    packageId: published.manifest.id,
    packageManifestSha256: published.manifestSha256,
    projectId: published.manifest.projectId,
    projectRevisionId: published.manifest.projectRevisionId,
    projectRevision: published.manifest.projectRevision,
    serviceDate: published.serviceHandoff.project.serviceDate,
    venueProfileId: 'main-sanctuary',
    venueProfileRevisionId: PROFILE_REVISION_ID
  });

  const restartedStore = new CurrentShowPackageStore({
    rootPath: pointerPath
  });
  const restartedPublisher = new ShowPackagePublisher({
    projectStore: new ServiceProjectStore({ rootPath: projectsPath }),
    rootPath: packagesPath,
    fontPath: FONT_PATH
  });
  const reopenedPointer = await restartedStore.read();
  const reopened = await restartedPublisher.open(reopenedPointer.packageId);
  const binding = validateCurrentShowPackageBinding({
    pointer: reopenedPointer,
    manifest: reopened.manifest,
    manifestSha256: reopened.manifestSha256,
    serviceHandoff: reopened.serviceHandoff,
    venueProfileId: 'main-sanctuary',
    venueProfileRevisionId: PROFILE_REVISION_ID,
    enabledRoleIds: ['main', 'singers'],
    presentationRoleIds: Object.keys(reopened.presentations)
  });

  assert.deepEqual(reopenedPointer, activated);
  assert.deepEqual(binding.roleIds, ['main', 'singers']);
  for (const presentation of Object.values(reopened.presentations)) {
    const assetPaths = Object.values(presentation.assetPaths);
    assert.equal(assetPaths.length, 1);
    assert.equal((await fs.lstat(assetPaths[0])).isFile(), true);
    assert.equal(presentation.serviceHandoff.project.id, saved.project.id);
  }
});
