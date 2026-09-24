'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TranslationProjection, normalizeOutput } = require('../src/services/translation/TranslationProjection');
const { TranslationFeed, communityOrigin } = require('../src/services/translation/TranslationFeed');

const state = (sessionId = 'service-1') => ({ type: 'public-state', state: {
  active: Boolean(sessionId), sessionId, serverTimeUnixMs: 1000,
  languages: sessionId ? [{ language: 'en', available: true }, { language: 'ru', available: true }] : []
} });
const caption = (sequence, changes = {}) => ({ type: 'transcript', segment: {
  sessionId: 'service-1', channelId: 'channel-ru', language: 'ru', sequence,
  text: 'Благодать вам и мир.', final: true, ...changes
} });

test('final captions replace provisional revisions once and stay source-faithful', () => {
  const projection = new TranslationProjection();
  projection.configure('russian-screen', { language: 'ru', layout: 'ticker' });
  projection.accept(state());
  projection.accept(caption(1, { final: false, revision: 3, text: 'Предварительно' }));
  assert.equal(projection.frame('russian-screen').phrases.length, 0);
  const literal = '<script>alert("text only")</script> — Мир вам';
  assert.equal(projection.accept(caption(1, { text: literal })), true);
  assert.equal(projection.frame('russian-screen').phrases[0].text, literal);
  assert.equal(projection.accept(caption(1)), false);
  assert.equal(projection.accept(caption(1, { revision: 99, final: false })), false);
  assert.equal(projection.frame('russian-screen').phrases.length, 1);
});

test('continuous translated text projects immediately but recognition drafts remain hidden', () => {
  const projection = new TranslationProjection();
  projection.configure('screen', { language: 'ru', layout: 'lower-third' });
  projection.accept(state());
  projection.accept(caption(1, { final: false, revision: 1, text: 'Recognition draft' }));
  assert.equal(projection.frame('screen').phrases.length, 0);
  projection.accept(caption(2, { final: false, revision: 1, delivery: 'streaming', text: 'Мир' }));
  assert.equal(projection.frame('screen').phrases[0].text, 'Мир');
  assert.equal(projection.frame('screen').phrases[0].streaming, true);
  projection.accept(caption(2, { final: false, revision: 2, delivery: 'streaming', text: 'Мир вам' }));
  assert.equal(projection.frame('screen').phrases.length, 1);
  assert.equal(projection.frame('screen').phrases[0].text, 'Мир вам');
  projection.accept(caption(2, { final: true, revision: 3, delivery: 'streaming', text: 'Мир вам.' }));
  assert.equal(projection.frame('screen').phrases[0].text, 'Мир вам.');
});

test('session changes remove old text and reject delayed previous-service events', () => {
  const projection = new TranslationProjection();
  projection.configure('stage', { language: 'ru', layout: 'full-screen' });
  projection.accept(state());
  projection.accept(caption(2));
  projection.override('stage', 'Manual stage cue');
  projection.accept(state('service-2'));
  assert.equal(projection.accept(caption(3)), false);
  assert.deepEqual(projection.frame('stage').phrases, []);
  assert.equal(projection.frame('stage').manual, false);
  projection.accept(state(null));
  assert.equal(projection.snapshot().status, 'idle');
});

test('each output has independent layout, language and manual override', () => {
  const projection = new TranslationProjection();
  projection.configure('english-screen', { language: 'en', layout: 'lower-third' });
  projection.configure('russian-screen', { language: 'ru', layout: 'ticker' });
  projection.configure('stage', { language: 'ru', layout: 'hidden' });
  projection.accept(state());
  projection.accept(caption(1));
  projection.accept(caption(1, { channelId: 'channel-en', language: 'en', text: 'Grace and peace.' }));
  projection.override('russian-screen', 'Пожалуйста, встаньте.');
  assert.equal(projection.frame('english-screen').phrases[0].text, 'Grace and peace.');
  assert.equal(projection.frame('russian-screen').phrases[0].text, 'Пожалуйста, встаньте.');
  assert.equal(projection.frame('stage').layout, 'hidden');
  assert.equal(projection.snapshot().captions.ru[0].text, 'Благодать вам и мир.');
  projection.override('russian-screen', null);
  assert.equal(projection.frame('russian-screen').phrases[0].text, 'Благодать вам и мир.');
});

test('loss of heartbeats freezes projection while preserving readable text', () => {
  let now = 0;
  const projection = new TranslationProjection({ now: () => now });
  projection.configure('screen', { language: 'ru', layout: 'ticker' });
  projection.accept(state());
  projection.accept(caption(1));
  now = 31000;
  assert.equal(projection.frame('screen').status, 'disconnected');
  assert.equal(projection.frame('screen').moving, false);
  assert.equal(projection.frame('screen').phrases.length, 1);
  projection.accept(state());
  assert.equal(projection.frame('screen').moving, true);
});

test('caption history and renderer payloads stay bounded and ordered', () => {
  const projection = new TranslationProjection();
  projection.accept(state());
  for (let sequence = 0; sequence < 200; sequence++) projection.accept(caption(sequence));
  assert.equal(projection.phrases.get('ru').size, 80);
  assert.equal(projection.snapshot().captions.ru.length, 8);
  assert.equal(projection.accept(caption(0)), false);
  assert.equal(projection.accept(caption(201, { text: 'x'.repeat(12001) })), false);
  assert.equal(projection.accept(caption(-1)), false);
  assert.equal(projection.accept(caption(201, { language: 'en', channelId: '../private' })), false);
});

test('settings reject invalid layouts, URLs and executable extras', () => {
  assert.throws(() => normalizeOutput({ layout: 'video' }));
  assert.throws(() => normalizeOutput({ fontScale: 100 }));
  assert.throws(() => normalizeOutput({ html: '<img>' }));
  assert.equal(communityOrigin('https://wotbc.heritage.faith'), 'https://wotbc.heritage.faith');
  assert.equal(communityOrigin('http://127.0.0.1:4310'), 'http://127.0.0.1:4310');
  for (const value of ['http://church.example', 'https://token@church.example', 'https://church.example/private', 'file:///tmp']) {
    assert.throws(() => communityOrigin(value));
  }
});

class Socket extends EventTarget {
  static opened = [];
  constructor(url) { super(); this.url = url; Socket.opened.push(this); }
  sendMessage(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
}
function fixture() {
  Socket.opened = [];
  const timers = new Map();
  let id = 0;
  const projection = new TranslationProjection();
  const feed = new TranslationFeed({ projection, changed() {}, WebSocketClass: Socket,
    setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    clearTimer: timer => timers.delete(timer)
  });
  return { feed, projection, timers };
}

test('one public connection supplies all outputs without credentials or provider calls', () => {
  const { feed, projection } = fixture();
  for (const output of ['en-screen', 'ru-screen', 'stage']) projection.configure(output, { layout: 'ticker', language: 'ru' });
  feed.connect('https://church.example');
  feed.connect('https://church.example/');
  assert.equal(Socket.opened.length, 1);
  assert.equal(Socket.opened[0].url, 'wss://church.example/translation/api/public/events');
  Socket.opened[0].sendMessage(state());
  Socket.opened[0].sendMessage(caption(1));
  assert.equal(projection.frame('stage').phrases.length, 1);
  feed.stop();
});

test('old sockets and queued reconnects cannot attach after a church switch or stop', () => {
  const { feed, projection, timers } = fixture();
  feed.connect('https://first.example');
  const old = Socket.opened[0];
  old.sendMessage(state());
  old.close();
  const retry = [...timers.values()].find(item => item.delay === 1000).callback;
  feed.connect('https://second.example');
  old.sendMessage(caption(1));
  retry();
  assert.equal(Socket.opened.length, 2);
  assert.deepEqual(projection.snapshot().captions, {});
  feed.stop();
  retry();
  assert.equal(Socket.opened.length, 2);
  assert.equal(timers.size, 0);
});

test('a silent socket times out and reconnects without replaying an old service', () => {
  const { feed, projection, timers } = fixture();
  feed.connect('https://church.example');
  Socket.opened[0].sendMessage(state());
  Socket.opened[0].sendMessage(caption(1));
  [...timers.values()].find(item => item.delay === 30000).callback();
  assert.equal(projection.snapshot().status, 'disconnected');
  [...timers.values()].find(item => item.delay === 1000).callback();
  Socket.opened[1].sendMessage(state('service-2'));
  Socket.opened[1].sendMessage(caption(1));
  assert.deepEqual(projection.snapshot().captions, {});
  feed.stop();
});
