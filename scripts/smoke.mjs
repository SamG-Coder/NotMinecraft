import {chromium} from '../engine/node_modules/playwright/index.mjs';
import {mkdir} from 'node:fs/promises';
await mkdir('artifacts',{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-webgpu']});
const page=await browser.newPage({viewport:{width:1440,height:960}});
page.on('pageerror',e=>console.error('PAGE',e));page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
await page.goto('http://localhost:5173');
try{await page.waitForFunction(()=>window.game?.ready||!document.getElementById('error').hidden,null,{timeout:120000});await page.waitForTimeout(5000);console.log(await page.evaluate(()=>({error:document.getElementById('error').textContent,gpu:window.game?.runtime.describe(),ms:window.game?.gpuMs,size:window.game?.size,fps:document.getElementById('fps').textContent})));await page.screenshot({path:'artifacts/first-look.png'});}finally{await browser.close();}
