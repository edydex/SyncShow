'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

async function fixture(t, initialManifest = { version: '1.9.0' }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-version-trigger-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'release@example.test',
      GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'release@example.test' } }).trim();
  git('init', '--quiet');
  const commit = async (name, file, content) => {
    await fs.writeFile(path.join(directory, file), content);
    git('add', file); git('commit', '--quiet', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const before = initialManifest === null
    ? await commit('Initial source without manifest', 'README.md', 'source\n')
    : await commit('Initial manifest', 'package.json', typeof initialManifest === 'string'
      ? initialManifest : JSON.stringify(initialManifest));
  return { directory, before, commit, git };
}

async function runStep(f, { event = 'push', before = f.before } = {}) {
  const workflow = yaml.load(await fs.readFile(path.resolve(__dirname, '../.github/workflows/build.yml'), 'utf8'));
  const job = workflow.jobs['check-version'];
  assert.equal(job.steps.find(step => step.uses === 'actions/checkout@v4').with['fetch-depth'], 0,
    'The before-push commit must remain available even when the push has several commits');
  const step = job.steps.find(step => step.id === 'check');
  assert.equal(step.env.RELEASE_BEFORE_SHA, '${{ github.event.before }}');
  const output = path.join(f.directory, 'step-output.txt');
  await fs.writeFile(output, '');
  execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
    step.run.replaceAll('${{ github.event_name }}', event)], { cwd: f.directory, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, RELEASE_BEFORE_SHA: before, GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: path.join(f.directory, 'step-summary.md') } });
  return Object.fromEntries((await fs.readFile(output, 'utf8')).trim().split('\n').map(line => line.split('=')));
}

test('automatic release detects a version bump before the last commit of one push', async t => {
  const f = await fixture(t);
  await f.commit('Bump release version', 'package.json', JSON.stringify({ version: '2.0.1' }));
  await f.commit('Follow-up release notes', 'README.md', 'release notes\n');
  assert.equal(JSON.parse(f.git('show', 'HEAD~1:package.json')).version, '2.0.1',
    'The old parent-only comparison would skip this release');
  assert.deepEqual(await runStep(f), { preview: 'false', changed: 'true', version: '2.0.1' });
});

test('automatic release skips a multi-commit push with unchanged version', async t => {
  const f = await fixture(t, { version: '2.0.1' });
  await f.commit('Update description without bump', 'package.json', JSON.stringify({ version: '2.0.1', description: 'Updated' }));
  await f.commit('Add source notes', 'README.md', 'notes\n');
  assert.deepEqual(await runStep(f), { preview: 'false', changed: 'false', version: '2.0.1' });
});

test('initial push releases from a zero previous version without depending on a parent', async t => {
  const f = await fixture(t, { version: '2.0.1' });
  assert.deepEqual(await runStep(f, { before: '0'.repeat(40) }), { preview: 'false', changed: 'true', version: '2.0.1' });
});

test('manual stable dispatch builds even when the current version is unchanged', async t => {
  const f = await fixture(t, { version: '2.0.1' });
  assert.deepEqual(await runStep(f, { event: 'workflow_dispatch', before: '' }),
    { preview: 'false', changed: 'true', version: '2.0.1' });
});

test('an absent or invalid before-push manifest safely starts from zero', async t => {
  for (const manifest of [null, '{broken', { description: 'No version yet' }]) await t.test(String(manifest), async child => {
    const f = await fixture(child, manifest);
    await f.commit('Add valid release manifest', 'package.json', JSON.stringify({ version: '2.0.1' }));
    assert.deepEqual(await runStep(f), { preview: 'false', changed: 'true', version: '2.0.1' });
  });
});

test('preview packaging and prerelease promotion keep their existing routing', async t => {
  const preview = await fixture(t, { version: '2.0.1-preview.1' });
  assert.deepEqual(await runStep(preview), { preview: 'true', changed: 'false', version: '2.0.1-preview.1' });
  assert.deepEqual(await runStep(preview, { event: 'workflow_dispatch', before: '' }),
    { preview: 'true', changed: 'false', version: '2.0.1-preview.1' });
  const promoted = await fixture(t, { version: '2.0.1-beta.1' });
  assert.deepEqual(await runStep(promoted), { preview: 'false', changed: 'false', version: '2.0.1-beta.1' });
});
