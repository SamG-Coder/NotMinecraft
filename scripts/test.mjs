import {chromium} from '../engine/node_modules/playwright/index.mjs';
import {createStaticServer} from '../engine/scripts/serve.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const server=createStaticServer(fileURLToPath(new URL('../',import.meta.url)));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
const suite=process.argv[2]==='mining'?'mining-gpu':'gpu';
try {
 browser=await chromium.launch({channel:process.env.TEST_BROWSER||'msedge',headless:true,args:['--enable-unsafe-webgpu']});
 const page=await browser.newPage();page.on('pageerror',e=>console.error(e));
 await page.goto(`http://127.0.0.1:${server.address().port}/tests/${suite}.html`);
 await page.waitForFunction(()=>window.__report,null,{timeout:180000});
 const report=await page.evaluate(()=>window.__report);await mkdir('artifacts',{recursive:true});await writeFile(`artifacts/${suite}-report.json`,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
}finally{await browser?.close();await new Promise(r=>server.close(r));}
