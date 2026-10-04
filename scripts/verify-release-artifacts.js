'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { expectedArtifactNames } = require('./verify-package-smoke');
const { packageTarget } = require('./lib/package-targets');
const application = require('../package.json');

const TARGETS = [
  {directory:'windows-installer',platform:'win32',arch:'x64'},
  {directory:'macos-installer-arm64',platform:'darwin',arch:'arm64'},
  {directory:'macos-installer-x64',platform:'darwin',arch:'x64'},
  {directory:'linux-installer',platform:'linux',arch:'x64'}
];

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFile(file) {
  const stat=await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size>0, `Unsafe or empty release file: ${path.basename(file)}`);
  return stat;
}

async function verifyReleaseArtifacts(root, sourceRevision, {version=application.version,projectDir=path.resolve(__dirname,'..')}={}) {
  assert(/^[a-f0-9]{40}$/.test(sourceRevision),'Release source revision must be an exact commit');
  const output=[];
  const add=async file=>{
    await regularFile(file);
    output.push({path:path.relative(root,file).split(path.sep).join('/'),publishedName:path.basename(file).replace(/\s/g,'.'),sha256:await sha256File(file)});
  };
  for(const {directory,platform,arch} of TARGETS) {
    const folder=path.join(root,directory),names=await fs.readdir(folder);
    const receipts=names.filter(name=>name.startsWith('package-smoke-') && name.endsWith('.json'));
    assert.equal(receipts.length,1,`One exact package receipt required for ${platform}-${arch}`);
    const receiptFile=path.join(folder,receipts[0]);await regularFile(receiptFile);
    const receipt=JSON.parse(await fs.readFile(receiptFile,'utf8'));
    assert.equal(receipt.schemaVersion,1);
    assert.equal(receipt.sourceRevision,sourceRevision,`Wrong source commit for ${platform}-${arch}`);
    assert.equal(receipt.application.version,version,`Wrong installer version for ${platform}-${arch}`);
    assert.equal(receipt.application.name,'sync-show');
    assert.equal(receipt.application.productName,'SyncShow');
    assert.equal(receipt.target.platform,platform);assert.equal(receipt.target.arch,arch);
    assert.equal(receipt.privateGoogleDriveConfig,'absent');
    const expected=expectedArtifactNames(packageTarget(platform,arch),{name:'sync-show',productName:'SyncShow',version});
    assert.deepEqual(receipt.artifacts.map(record=>record.path).sort(),[...expected].sort());
    assert.deepEqual(names.filter(name=>/\.(exe|dmg|zip|AppImage|deb)$/.test(name)).sort(),[...expected].sort(),`Unexpected installer inventory in ${directory}`);
    for(const record of receipt.artifacts) {
      assert.equal(record.path,path.basename(record.path),'Installer record must be a basename');
      assert(!/[\\\0\r\n]/.test(record.path));
      const file=path.join(folder,record.path),stat=await regularFile(file);
      assert.equal(stat.size,record.size,`Installer size changed: ${record.path}`);
      assert.equal(await sha256File(file),record.sha256,`Installer digest changed: ${record.path}`);
      await add(file);
    }
    const launchFile=path.join(folder,`packaged-launch-${platform}-${arch}.json`);await regularFile(launchFile);
    const launch=JSON.parse(await fs.readFile(launchFile,'utf8'));
    assert.equal(launch.launch,'passed');assert.equal(launch.isolatedProfile,'confirmed-and-removed');
    assert.equal(launch.target,`${platform}-${arch}`);
    assert.equal(launch.archiveSha256,receipt.appArchive.sha256,`Launch evidence belongs to another app for ${platform}-${arch}`);
    assert.equal(launch.executableSha256,receipt.runtime.sha256,`Launch evidence belongs to another executable for ${platform}-${arch}`);
    await add(receiptFile);await add(launchFile);
  }
  const sourceDirectory=path.join(root,'corresponding-sources');
  const sourceNames=await fs.readdir(sourceDirectory);
  assert.deepEqual(sourceNames.sort(),[`SyncShow-${version}-corresponding-sources.zip`,'release-source-receipt.json'].sort());
  const { readReleaseSourceMaterials } = require('./lib/release-source-materials');
  await readReleaseSourceMaterials({projectDir,version,root:sourceDirectory,required:true});
  for(const name of sourceNames)await add(path.join(sourceDirectory,name));
  output.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  assert.equal(new Set(output.map(record=>record.publishedName)).size,output.length,'Release assets must have unique published names');
  // GitHub normalizes whitespace in asset names (the NSIS installer has spaces).
  const checksums=output.map(record=>`${record.sha256}  ${record.publishedName}`).join('\n')+'\n';
  await fs.writeFile(path.join(root,'SHA256SUMS'),checksums);
  return {version,sourceRevision,installerTargets:TARGETS.length,assets:output};
}

async function main(argv=process.argv.slice(2)) {
  assert.equal(argv.length,4);assert.equal(argv[0],'--root');assert.equal(argv[2],'--source-revision');
  const result=await verifyReleaseArtifacts(path.resolve(argv[1]),argv[3]);
  console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={TARGETS,sha256File,verifyReleaseArtifacts};
