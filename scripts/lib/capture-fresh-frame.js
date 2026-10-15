'use strict';

const crypto = require('node:crypto');

// A renderer ACK proves DOM/layout readiness. On hidden CI windows the OS
// compositor can still return the previous surface to capturePage(). Require
// a genuinely new frame; never waive the caller's pixel/uniqueness checks.
async function captureFreshFrame(capture, seen, {
  attempts = 20,
  wait = () => new Promise(resolve => setTimeout(resolve, 50))
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const image = await capture();
    const png = image.toPNG();
    const digest = crypto.createHash('sha256').update(png).digest('hex');
    if (!seen.has(digest)) {
      seen.add(digest);
      return {image, png, digest};
    }
    if (attempt < attempts - 1) await wait();
  }
  throw new Error('The acknowledged slide never produced a fresh captured frame.');
}

module.exports = {captureFreshFrame};
