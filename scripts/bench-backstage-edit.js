'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ServiceProjectStore}=require('../src/services/project/ServiceProjectStore');
const {ShowPackagePublisher}=require('../src/services/project/ShowPackagePublisher');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'backstage-speed-'));
 const store=new ServiceProjectStore({rootPath:path.join(root,'projects')});
 const created=await store.create({id:'speed-fixture',title:'Text editing speed',serviceDate:'2026-10-04',profileId:'main-sanctuary'});
 const project=structuredClone(created.project);
 for(let i=0;i<96;i++){const id=`point-${i}`;project.rootItemIds.push(id);project.items[id]={id,kind:'notice',title:`Slide ${i+1}`,textByChannel:{primary:`Existing English text ${i+1}`,media:`Существующий текст ${i+1}`},operatorNotes:'',presetId:'notice-text'};}
 project.revision++;
 let saved=await store.save(project,{expectedRevisionId:created.revisionId,reason:'fixture'});
 const publisher=new ShowPackagePublisher({projectStore:store,rootPath:path.join(root,'packages')});
 const options={projectId:saved.project.id,revisionId:saved.revisionId,roleMapping:{main:'primary',russian:'primary',singers:'media'},width:1920,height:1080,thumbnailWidth:300};
 let start=performance.now();let published=await publisher.publish(options);console.log(JSON.stringify({phase:'initial',ms:performance.now()-start,root}));
 project.items['point-70'].textByChannel.primary+=' test';project.revision++;
 saved=await store.save(project,{expectedRevisionId:saved.revisionId,reason:'text-edit'});
 let rendered=0,reused=0;start=performance.now();
 published=await publisher.publish({...options,revisionId:saved.revisionId,reusePackageId:published.manifest.id,reusePackageManifestSha256:published.manifestSha256,onProgress:p=>p.reused?reused++:rendered++});
 console.log(JSON.stringify({phase:'one-text-edit',ms:performance.now()-start,rendered,reused,root}));
})().catch(e=>{console.error(e);process.exitCode=1});
