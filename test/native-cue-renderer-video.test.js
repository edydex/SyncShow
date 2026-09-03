'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { compileNativeCueScene } = require('../src/services/show/NativeCueScene');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.classList = {
      add: () => {},
      toggle: () => {}
    };
    this.readyState = tagName === 'video' ? 2 : 0;
    this.ended = false;
    this.paused = true;
    this.currentTime = 0;
    this.loadCalls = 0;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) || []) listener();
  }

  getBoundingClientRect() {
    return { width: 1920, height: 1080 };
  }

  async play() {
    this.paused = false;
    this.ended = false;
    this.dispatch('playing');
  }

  pause() {
    this.paused = true;
    this.dispatch('pause');
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }

  load() {
    this.loadCalls += 1;
  }
}

function videoScene() {
  const assetId = `sha256:${'b'.repeat(64)}`;
  return compileNativeCueScene({
    id: 'cue-video-runtime',
    kind: 'video',
    title: 'Test video',
    presetId: 'video-fullscreen',
    channels: {
      primary: {
        mode: 'content',
        blocks: [{ type: 'video', assetId, fit: 'fit', muted: false }]
      }
    }
  }, 'primary', { width: 1920, height: 1080 });
}

test('native video renderer arms, plays, pauses, replays, stops, and destroys safely', async () => {
  const document = {
    createElement: tagName => new FakeElement(tagName),
    createTextNode: text => ({ text })
  };
  const context = vm.createContext({
    window: {},
    document,
    requestAnimationFrame: callback => callback()
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/renderer/native-cue-renderer.js'), 'utf8'),
    context
  );
  const states = [];
  const renderer = context.window.SyncShowNativeCueRenderer.buildScene(videoScene(), {
    resolveAssetUrl: () => 'file:///tmp/safe-video.mp4',
    onVideoState: state => states.push(JSON.parse(JSON.stringify(state)))
  });
  const video = renderer.element.children[0].children[0];

  assert.equal(renderer.videoState(), 'armed');
  await renderer.prepare();
  assert.equal(states.at(-1).state, 'armed');

  assert.equal(await renderer.playVideo(), true);
  assert.equal(renderer.videoState(), 'playing');
  assert.equal(video.paused, false);

  assert.equal(renderer.pauseVideo(), true);
  assert.equal(renderer.videoState(), 'paused');
  assert.equal(video.paused, true);

  video.currentTime = 1;
  video.ended = true;
  video.dispatch('ended');
  assert.equal(renderer.videoState(), 'ended');
  assert.equal(await renderer.playVideo(), true);
  assert.equal(video.currentTime, 0);
  assert.equal(renderer.videoState(), 'playing');

  assert.equal(renderer.stopVideo(), true);
  assert.equal(renderer.videoState(), 'armed');
  assert.equal(video.currentTime, 0);

  renderer.destroy();
  assert.equal(video.src, '');
  assert.equal(video.loadCalls, 1);
});
