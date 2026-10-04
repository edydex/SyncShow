'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CommunityMediaCache } = require('../src/services/community/CommunityMediaCache');
test('identical media is fetched once across services and corrupt bytes are repaired', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'syncshow-media-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('validated-picture-bytes'), sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  const asset={id:`sha256:${sha256}`,sha256,kind:'image',size:bytes.length};let calls=0;
  const fetch=async()=>{calls++;return bytes;};
  assert.deepEqual(await new CommunityMediaCache(root).get(asset,fetch),bytes);
  assert.deepEqual(await new CommunityMediaCache(root).get(asset,fetch),bytes);assert.equal(calls,1);
  await fs.writeFile(path.join(root,sha256),'corrupt');
  assert.deepEqual(await new CommunityMediaCache(root).get(asset,fetch),bytes);assert.equal(calls,2);
  await fs.unlink(path.join(root,sha256));
  await assert.rejects(new CommunityMediaCache(root).get(asset,async()=>Buffer.from('wrong')),/fingerprint/);
  await assert.rejects(fs.stat(path.join(root,sha256)),{code:'ENOENT'});
});
test('media fingerprints cannot escape storage or read linked files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'syncshow-media-path-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const cache=new CommunityMediaCache(root);
  await assert.rejects(cache.get({id:'sha256:../secret',sha256:'../secret',kind:'image',size:2},()=>{}));
  const bytes=Buffer.from('okay'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  const external=path.join(root,'outside');await fs.writeFile(external,bytes);await fs.symlink(external,path.join(root,sha256));
  let fetched=false;await assert.rejects(cache.get({id:`sha256:${sha256}`,sha256,kind:'image',size:4},()=>{fetched=true;return bytes;}));assert.equal(fetched,false);
});
