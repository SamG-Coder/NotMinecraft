import {chromium} from '../engine/node_modules/playwright/index.mjs';
import {createStaticServer} from '../engine/scripts/serve.mjs';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
let server,browser;
const errors=[];
try{
 let url=process.argv[2];
 if(!url){
  const files=createStaticServer(fileURLToPath(new URL('../dist/',import.meta.url))),handler=files.listeners('request')[0];
  server=createServer((req,res)=>{if(!req.url.startsWith('/NotMinecraft/')){res.writeHead(404);res.end('Outside project prefix');return;}req.url=req.url.slice('/NotMinecraft'.length);handler(req,res);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}/NotMinecraft/`;
 }
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-webgpu']});
 const page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 // Emulate callbacks arriving much faster than a 60 Hz monitor, so the cap is
 // checked independently of the test machine's actual refresh rate.
 await page.addInitScript(()=>{window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),2);window.cancelAnimationFrame=clearTimeout;});
 await page.goto(url);await page.waitForFunction(()=>window.game?.ready||!document.getElementById('error')?.hidden,null,{timeout:120000});await page.waitForTimeout(3500);
 const result=await page.evaluate(async()=>({ready:!!window.game?.ready,error:document.getElementById('error')?.textContent,status:document.getElementById('status')?.textContent,adapter:window.game?.runtime.describe(),size:window.game?.size,opaque:window.game?Array.from(await game.runtime.read(game.pixels,Uint32Array,4096)).every(v=>(v>>>24)===255):false}));
 const timing=await page.evaluate(()=>{const t=game.frameTimes,d=t.slice(1).map((v,i)=>v-t[i]);return {frameLimit:game.frameLimit,samples:d.length,minSubmissionIntervalMs:Math.min(...d),averageFps:d.length*1000/d.reduce((a,b)=>a+b,0),hud:document.getElementById('fps').textContent};});
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/pages-live.png'});const report={url,...result,timing,errors};await writeFile('artifacts/pages-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 // performance.now() can be quantized by browser privacy settings by 0.1 ms.
 if(!result.ready||result.error||!result.opaque||errors.length||timing.samples<30||timing.minSubmissionIntervalMs<16.56||timing.averageFps>60)process.exitCode=1;
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));}
