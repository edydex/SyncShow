'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const PREFIX='/syncshow-local/adjust/';
async function bundledPlannerResponse(request,{rootPath,fontsRoot,language='en'}) {
  const url=new URL(request.url);
  if(request.method==='GET' && fontsRoot && ['NotoSans-Variable.ttf','LiberationSans-Regular.ttf','LiberationSans-Bold.ttf','LiberationSans-Italic.ttf','LiberationSans-BoldItalic.ttf'].some(name=>url.pathname==='/fonts/'+name))return new Response(await fs.readFile(path.join(fontsRoot,path.basename(url.pathname))),{headers:{'Content-Type':'font/ttf'}});
  if(request.method!=='GET'||!url.pathname.startsWith(PREFIX))return null;
  const relative=decodeURIComponent(url.pathname.slice(PREFIX.length)),target=path.resolve(rootPath,relative);
  const confined=path.relative(path.resolve(rootPath),target);
  if(!confined||confined.startsWith('..')||path.isAbsolute(confined)||! /\.(?:html|js|css)$/.test(target))return new Response('Not found',{status:404});
  let bytes=await fs.readFile(target);
  if(target.endsWith('.html'))bytes=Buffer.from(bytes.toString().replace('<html lang="en">',`<html lang="${language==='ru'?'ru':'en'}">`));
  return new Response(bytes,{headers:{'Content-Type':target.endsWith('.html')?'text/html; charset=utf-8':target.endsWith('.css')?'text/css':'application/javascript','Cache-Control':'no-store'}});
}
module.exports={bundledPlannerResponse,PREFIX};
