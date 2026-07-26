'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPathUtils() {
  const exposed = {};
  const ipcRenderer = {
    invoke() {},
    send() {},
    on() {},
    removeAllListeners() {}
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed[name] = value;
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

  vm.runInNewContext(source, {
    require(moduleName) {
      if (moduleName === 'electron') return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${moduleName}`);
    },
    encodeURIComponent
  });
  return exposed.pathUtils;
}

test('sandbox-safe file URLs preserve roots and encode special characters', () => {
  const { toFileUrl } = loadPathUtils();

  assert.equal(
    toFileUrl('/Users/example/Service Slides/July #1.jpg'),
    'file:///Users/example/Service%20Slides/July%20%231.jpg'
  );
  assert.equal(
    toFileUrl('C:\\Church Media\\Sunday 1.jpg'),
    'file:///C:/Church%20Media/Sunday%201.jpg'
  );
  assert.equal(
    toFileUrl('\\\\media-server\\slides\\Sunday.jpg'),
    'file://media-server/slides/Sunday.jpg'
  );
  assert.equal(toFileUrl(''), '');
});
