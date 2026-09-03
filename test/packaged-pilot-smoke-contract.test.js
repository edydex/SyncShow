'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const packageJson = require('../package.json');
const serviceCoreVerifier = require('../scripts/verify-packaged-service-core');
const launchVerifier = require('../scripts/verify-packaged-app-launch');

test('packaged shared-core smoke is exact and exercises document-to-cue compilation', () => {
  assert.deepEqual(serviceCoreVerifier.parseArguments(['--root', 'dist']), {
    root: path.join(root, 'dist')
  });
  assert.throws(() => serviceCoreVerifier.parseArguments([]));
  const source = serviceCoreVerifier.serviceCoreSmokeSource('/tmp/app.asar/packages/service-core/node.js');
  assert.match(source, /createHeritageServiceDocument/);
  assert.match(source, /parseHeritageServiceDocumentSource/);
  assert.match(source, /compileServiceProject/);
  assert.match(source, /projectRevision, 1/);
  assert.deepEqual(serviceCoreVerifier.REQUIRED_CORE_ENTRIES, [
    '/packages/service-core/package.json',
    '/packages/service-core/index.js',
    '/packages/service-core/node.js',
    '/packages/service-core/node/services/project/ServiceProject.js'
  ]);
});

test('native package workflow launches every target and runs the core smoke once per package', () => {
  assert.deepEqual(launchVerifier.parseArguments(['--root', 'dist']), {
    root: path.join(root, 'dist')
  });
  assert.throws(() => launchVerifier.parseArguments(['--root']));
  assert.equal(packageJson.scripts['build:verify-service-core'], 'node scripts/verify-packaged-service-core.js');
  assert.equal(packageJson.scripts['build:verify-app-launch'], 'node scripts/verify-packaged-app-launch.js');
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'package-smoke.yml'), 'utf8');
  assert.match(workflow, /needs: validate/);
  assert.equal((workflow.match(/npm run ci/g) || []).length, 1);
  assert.match(workflow, /build:verify-service-core -- --root dist/);
  assert.match(workflow, /build:verify-app-launch -- --root dist/);
  assert.match(workflow, /xvfb-run -a npm run build:verify-app-launch/);
  for (const target of ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64']) {
    assert.match(workflow, new RegExp(`target: ${target}`));
  }
});
