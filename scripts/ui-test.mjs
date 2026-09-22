import {chromium} from '../engine/node_modules/playwright/index.mjs';
import {createStaticServer} from '../engine/scripts/serve.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const server=createStaticServer(fileURLToPath(new URL('../',import.meta.url)));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-webgpu']});
const errors=[],passed=[];
const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(String(e)));
const check=(ok,name)=>{if(!ok)throw Error(name);passed.push(name);};
const state=()=>page.evaluate(async()=>Array.from(await game.runtime.read(game.state)));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.game?.ready,null,{timeout:120000});
 await page.waitForTimeout(700);await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/game-menu.png'});
 check(await page.locator('#exact').isChecked(),'Exact centimetre rendering is enabled by default');
 await page.locator('#play').click();await page.waitForFunction(()=>document.pointerLockElement?.id==='world');
 check(await page.locator('#menu').isHidden(),'Explore button captures mouse and opens the game');
 let before=await state();await page.keyboard.down('KeyW');await page.waitForTimeout(400);await page.keyboard.up('KeyW');let after=await state();
 check(Math.hypot(after[0]-before[0],after[2]-before[2])>0.5,'W key moves the actual player through browser input');
 await page.keyboard.press('KeyF');await page.keyboard.down('Space');await page.waitForTimeout(500);await page.keyboard.up('Space');
 const flying=await state();check(flying[6]===1&&flying[1]>after[1]+1,'F and Space activate flight and climb');
 await page.mouse.move(850,610);await page.waitForTimeout(100);const looked=await state();check(looked[3]!==flying[3]||looked[4]!==flying[4],'Mouse movement changes GPU camera angles');
 // Use a reproducible view for visual QA after testing real mouse input.
 await page.evaluate(()=>game.runtime.device.queue.writeBuffer(game.state.gpuBuffer,12,new Float32Array([0.65,-0.25])));await page.waitForTimeout(100);
 await page.screenshot({path:'artifacts/game-playing.png'});
 await page.keyboard.press('Escape');await page.waitForTimeout(100);check(await page.locator('#menu').isVisible(),'Escape returns to the menu');
 await page.locator('#seed').fill('12345');await page.locator('#seed').press('Tab');await page.waitForTimeout(100);check(await page.evaluate(()=>game.seed===12345),'Seed input regenerates the world');
 await page.locator('summary').click();await page.locator('#spawn-x').fill('-4096');await page.locator('#spawn-z').fill('4096');await page.locator('#teleport').click();await page.waitForTimeout(150);
 const teleported=await state();check(teleported[0]===-4096&&teleported[2]===4096,'Location controls regenerate at the requested coordinates');
 await page.setViewportSize({width:1280,height:720});await page.locator('#resolution').selectOption('1');await page.waitForTimeout(150);
 check(await page.evaluate(()=>game.size[0]===1280&&game.size[1]===720),'Resize and resolution controls reallocate the framebuffer correctly');
 check(await page.locator('#error').isHidden()&&errors.length===0,'UI play session has no application or WebGPU errors');
 console.log(JSON.stringify({passed,errors},null,2));await writeFile('artifacts/ui-report.json',JSON.stringify({passed,errors},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
