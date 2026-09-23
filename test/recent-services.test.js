'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectLatestService, collectPages } = require('../src/renderer/recent-services');
test('suggests the last edited plan, not the furthest future service date', () => {
  const local = [{id:'future',serviceDate:'2027-01-01',updatedAt:'2026-09-01'}, {id:'recent-local',updatedAt:'2026-09-20'}];
  const community = [{syncId:'most-recent',serviceDate:'2026-09-20',changedAt:'2026-09-23'}, {syncId:'archived',status:'archived',changedAt:'2026-09-24'}];
  assert.equal(selectLatestService(local, community).id, 'most-recent');
  assert.equal(selectLatestService(local, []).id, 'recent-local');
  assert.equal(selectLatestService([], []), null);
});
test('follows local and Community pagination before choosing latest', async () => {
  const calls = [];
  const local = await collectPages(async options => {
    calls.push(options);
    return options.offset === 0 ? { items:[{id:'old',updatedAt:'2026-09-01'}],nextOffset:100 } : {items:[{id:'new',updatedAt:'2026-09-22'}],nextOffset:null};
  }, {local:true});
  assert.equal(calls[1].offset, 100);
  assert.equal(selectLatestService(local, []).id, 'new');
  const remote = await collectPages(async ({cursor}) => ({success:true,data:cursor ? {items:[{syncId:'new',changedAt:'2026-09-23'}],nextCursor:null} : {items:[],nextCursor:'page2'}}));
  assert.equal(selectLatestService(local, remote).source, 'community');
});
test('pagination failures cannot silently imply an authoritative empty library', async () => {
  await assert.rejects(collectPages(async () => ({success:false,error:{message:'Offline'}})), /Offline/);
  await assert.rejects(collectPages(async () => ({items:[],nextCursor:'same'})), /repeated/);
});
