import {chromium} from '../engine/node_modules/playwright/index.mjs';
import {createStaticServer} from '../engine/scripts/serve.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const server=createStaticServer(fileURLToPath(new URL('../',import.meta.url)));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-webgpu']});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],passed=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const check=(ok,name)=>{if(!ok)throw Error(name);passed.push(name);};
const meta=()=>page.evaluate(async()=>Array.from(await game.runtime.read(game.damageMeta,Uint32Array)));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.game?.ready,null,{timeout:120000});
 await page.locator('#tool').selectOption('tnt');
 await page.locator('#play').click();await page.waitForFunction(()=>document.pointerLockElement?.id==='world');
 await page.evaluate(()=>game.runtime.device.queue.writeBuffer(game.state.gpuBuffer,12,new Float32Array([0.65,1.4])));await page.waitForTimeout(100);
 await page.mouse.down();await page.mouse.up();await page.waitForTimeout(100);
 check((await page.evaluate(async()=>(await game.runtime.read(game.state))[22]))===0,'Aiming at the sky cannot place TNT');
 await page.evaluate(()=>game.runtime.device.queue.writeBuffer(game.state.gpuBuffer,12,new Float32Array([0.65,-1.12])));await page.waitForTimeout(100);
 await page.mouse.down();await page.mouse.up();await page.waitForTimeout(150);
 const armed=await page.evaluate(async()=>Array.from(await game.runtime.read(game.state)));
 check(armed[22]>2&&armed[29]===1,'TNT tool places a charge on an aimed nearby surface');
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/tnt-armed.png'});
 await page.keyboard.press('Escape');const paused=await page.evaluate(async()=>(await game.runtime.read(game.state))[22]);await page.waitForTimeout(600);
 check(Math.abs((await page.evaluate(async()=>(await game.runtime.read(game.state))[22]))-paused)<.06,'Fuse pauses while the menu is open');
 await page.locator('#play').click();await page.waitForFunction(()=>document.pointerLockElement?.id==='world');
 await page.mouse.down();await page.mouse.up();await page.waitForTimeout(100);
 check((await meta())[3]===0,'A second click cannot detonate or replace the armed charge');
 const deadline=Date.now()+12000;while(Date.now()<deadline && (await page.evaluate(async()=>(await game.runtime.read(game.state))[28]))!==1)await page.waitForTimeout(100);
 const blasted=await meta();
 check(blasted[0]>27&&blasted[0]<=343&&blasted[1]===0&&blasted[2]>100000&&blasted[3]===1,'Fuse applies one larger atomic blast within the page budget');
 await page.screenshot({path:'artifacts/tnt-crater.png'});
 await page.waitForFunction(()=>document.getElementById('mining-status').textContent.includes('SAVED'),null,{timeout:10000});
 await page.reload();await page.waitForFunction(()=>window.game?.ready,null,{timeout:120000});
 check(JSON.stringify(await meta())===JSON.stringify(blasted),'TNT crater persists across reload');
 check((await page.evaluate(async()=>(await game.runtime.read(game.state))[22]))===0,'Reload does not re-arm or replay the exploded TNT');
 check(errors.length===0,'TNT placement and explosion have no WebGPU or browser errors');
 const report={passed,errors,meta:blasted};console.log(JSON.stringify(report,null,2));await writeFile('artifacts/tnt-ui-report.json',JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}

