'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
  const source=path.resolve(process.env.SYNCSHOW_COMMUNITY_SOURCE || path.join(__dirname,'../../heritage_study_bible'));
  const {build}=await import(path.join(source,'node_modules/vite/dist/node/index.js'));
  const root=path.join(__dirname,'planner-editor'),outDir=path.join(__dirname,'../assets/planner-editor');
  const packages=new Set();
  await build({configFile:false,root,base:'/syncshow-local/adjust/',plugins:[{name:'bundled-editor-notices',generateBundle(_,bundle){for(const chunk of Object.values(bundle))for(const id of Object.keys(chunk.modules || {})){const marker='/node_modules/',offset=id.lastIndexOf(marker);if(offset<0)continue;const tail=id.slice(offset+marker.length).split('/'),name=tail[0].startsWith('@')?tail.slice(0,2).join('/'):tail[0];packages.add(id.slice(0,offset+marker.length)+name);}}}],esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom'],alias:{'@community':path.join(source,'community-server/src'),'@':path.join(source,'community-server/src'),react:path.join(source,'node_modules/react'),'react-dom':path.join(source,'node_modules/react-dom')}},build:{outDir,emptyOutDir:true,target:'esnext',commonjsOptions:{include:[/node_modules/,/service-core/]},rollupOptions:{input:path.join(root,'index.html')}}});
  const notices=[];
  for(const directory of [...packages].sort()){
    const clean=directory.replaceAll('\0','');
    const manifest=JSON.parse(await fs.readFile(path.join(clean,'package.json'),'utf8'));
    notices.push(`${manifest.name}@${manifest.version} (${manifest.license || 'see notices'})`);
    for(const file of (await fs.readdir(clean)).filter(name=>/^(LICEN[CS]E|COPYING|NOTICE)(?:[._-].*)?$/i.test(name))){
      if((await fs.stat(path.join(clean,file))).isFile())notices.push(await fs.readFile(path.join(clean,file),'utf8'));
    }
  }
  await fs.writeFile(path.join(outDir,'THIRD_PARTY_NOTICES.txt'),notices.join('\n\n')+'\n');
  const entry='community-server/src/components/PlanServiceClient.tsx',componentSha256=crypto.createHash('sha256').update(await fs.readFile(path.join(source,entry))).digest('hex');
  await fs.writeFile(path.join(outDir,'source.json'),JSON.stringify({kind:'shared-community-editor',entry,componentSha256,activeService:true},null,2)+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1});
