'use strict';
// Optional real-browser rehearsal; point SYNCSHOW_PLAYWRIGHT_MODULE at an installed
// @playwright/test module when it is not on Node's module path.
const {chromium,firefox,expect}=require(process.env.SYNCSHOW_PLAYWRIGHT_MODULE || '@playwright/test');
const {RemoteControlServer}=require('../src/services/remote');
const {TeachingSurface}=require('../src/services/show/TeachingSurface');
const sharp=require('sharp');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),evidence=path.resolve(process.env.SYNCSHOW_TEACHING_EVIDENCE || path.join(root,'test-results/teaching-monochrome'));
async function run() {
  await fs.mkdir(evidence,{recursive:true});const results=[];
  for(const [name,engine] of Object.entries({chromium,firefox})) {
    const session='4c480506-4436-4e72-90d2-6e3fca88e775';
    const state={protocolVersion:1,revision:1,outputSessionId:session,phase:'live',profileName:'Browser rehearsal',currentCue:{id:'cue-1',index:0,number:1,text:'Pattern rehearsal'},nextCue:null,totalCues:1,cues:[],outputs:[{id:'main',name:'English',renderer:'slides',status:'healthy',visible:true}],bible:{phase:'idle',reference:'',translationId:'',targetOutputIds:[]},controls:{canPrevious:false,canNext:false,canJump:false,canRestore:true,canClear:true},permissions:{canOpenBiblePicker:false}};
    const surface=new TeachingSurface({readContext:()=>({sessionId:session,cueKey:'one',cueLabel:'Pattern rehearsal',ready:true,outputs:[{id:'main',name:'English',size:[1200,675]}]})});
    const routes=Object.fromEntries([['/','src/remote/index.html'],['/styles.css','src/remote/remote.css'],['/app.js','src/remote/remote.js'],['/teaching.js','src/remote/teaching.js'],['/teaching-patterns.js','src/remote/teaching-patterns.js'],['/teaching-trail.js','src/renderer/teaching-trail.js'],['/teaching.css','src/remote/teaching.css']].map(([url,file])=>[url,{filePath:path.join(root,file)}]));
    const server=new RemoteControlServer({showGateway:{getState:()=>state,getCueCatalog:()=>[state.currentCue],subscribe:()=>()=>{},execute:async()=>({applied:true,state})},staticRoutes:routes,teachingGateway:{state:id=>surface.state(id),apply:body=>surface.apply(body),preview:async()=>{
      const strokes=surface.frame('main').strokes.map(stroke=>`<polyline points="${stroke.points.map(([x,y])=>`${x*1200},${y*675}`).join(' ')}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width*675}" stroke-linecap="round" opacity="${stroke.tool==='highlight'?.3:1}"/>`).join('');
      return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="1200" height="675" fill="white"/><text x="70" y="150" font-family="sans-serif" font-size="64" fill="black">Love is patient. Love is kind.</text><rect x="80" y="270" width="200" height="130" fill="#ef4444"/><rect x="370" y="270" width="200" height="130" fill="#2563eb"/><rect x="660" y="270" width="200" height="130" fill="#16a34a"/>${strokes}</svg>`)).jpeg().toBuffer();
    }}});
    let browser;
    try {
      await server.startLoopback();const grant=server.openPairing();browser=await engine.launch({headless:true});const page=await browser.newPage({viewport:{width:1200,height:1100}}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(grant.pairingUrl);await expect(page.locator('#showView')).toBeVisible();
      await page.locator('#teachingPanel > summary').click();await expect(page.locator('#teachingCanvasWrap')).toHaveAttribute('data-ready','true');
      await page.locator('#teachingMonochrome').check();await expect(page.getByRole('group',{name:'Drawing color patterns'})).toBeVisible();
      await page.getByRole('button',{name:'Blue · Horizontal waves',exact:true}).click();
      const canvas=page.locator('#teachingCanvas'),box=await canvas.boundingBox();
      await page.mouse.move(box.x+box.width*.15,box.y+box.height*.72);await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.8,{steps:12});await page.mouse.up();
      await expect.poll(()=>surface.frame('main').strokes[0]?.finished).toBe(true);
      assert.equal(surface.frame('main').strokes[0].color,'#2563eb');
      await expect(page.locator('#teachingCanvasWrap')).toHaveAttribute('data-ready','true');await expect(page.locator('#teachingPatternLegend')).toContainText('Blue · Horizontal waves');
      const original=JSON.stringify(surface.frame('main').strokes);
      const gray=await page.locator('#teachingPatternPreview').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;for(let i=0;i<data.length;i+=4)if(data[i]!==data[i+1]||data[i+1]!==data[i+2])return false;return true;});assert(gray);
      await page.screenshot({path:path.join(evidence,`${name}-patterns.png`),fullPage:true});
      await page.locator('#teachingMonochrome').uncheck();assert.equal(JSON.stringify(surface.frame('main').strokes),original);
      await page.locator('#teachingMonochrome').check();await page.reload();await page.locator('#teachingPanel > summary').click();await expect(page.locator('#teachingMonochrome')).toBeChecked();await expect(page.locator('#teachingPatternLegend')).toContainText('Blue');
      await page.locator('#teaching-undo').click();await expect.poll(()=>surface.frame('main').strokes.length).toBe(0);await expect(page.locator('#teachingPatternLegend')).not.toContainText('Blue');
      await page.setViewportSize({width:600,height:900});await page.screenshot({path:path.join(evidence,`${name}-tablet.png`),fullPage:true});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
      results.push({browser:name,pairedRealHTTP:true,canonicalColorPreserved:true,previewAllGray:true,persistentLocalChoice:true,undoLegend:true,narrowLayout:true,errors});
    } finally {if(browser)await browser.close();await server.destroy();}
  }
  await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;});
