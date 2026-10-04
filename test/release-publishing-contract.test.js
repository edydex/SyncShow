'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');

test('public installer jobs disable electron-builder publishing and reserve publication for the verified release job', async () => {
  const workflow = yaml.load(await fs.readFile(path.resolve(__dirname, '../.github/workflows/build.yml'), 'utf8'));
  const names = ['build-windows', 'build-mac', 'build-linux'];
  for (const name of names) {
    const job = workflow.jobs[name];
    const builders = job.steps.filter(step => /npm run build:(?:win|mac:adhoc|linux)\b/.test(step.run || ''));
    assert.equal(builders.length, 1, `${name} must have one explicit installer build`);
    assert.match(builders[0].run, /--publish\s+never(?:\s|$)/, `${name} must not auto-publish before smoke and legal checks`);
    for (const environment of [workflow.env, job.env, ...job.steps.map(step => step.env)]) {
      assert.equal(environment?.GH_TOKEN, undefined, `${name} must not receive a publishing token`);
      assert.equal(environment?.GITHUB_TOKEN, undefined, `${name} must not receive a publishing token`);
    }
    assert.ok(!job.steps.some(step => /action-gh-release|gh release (?:create|upload)|--publish\s+always/.test(`${step.uses || ''}\n${step.run || ''}`)), `${name} must not publish before final verification`);
  }
  const release = workflow.jobs['create-release'];
  for (const name of names) assert.ok(release.needs.includes(name), `Publication must wait for ${name}`);
  const finalCheck = release.steps.findIndex(step => /verify-release-artifacts\.js/.test(step.run || ''));
  const publish = release.steps.findIndex(step => /softprops\/action-gh-release@/.test(step.uses || ''));
  assert.ok(finalCheck >= 0 && publish > finalCheck, 'Publication must follow exact artifact and receipt verification');
});
