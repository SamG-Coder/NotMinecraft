import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative} from 'node:path';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const base=new URL('https://example.test/NotMinecraft/'),seen=new Set();
async function resource(url){
 assert.equal(url.origin,base.origin);assert.ok(url.pathname.startsWith(base.pathname),`Escaped Pages prefix: ${url}`);
 const name=decodeURIComponent(url.pathname.slice(base.pathname.length));if(!name||seen.has(name))return;seen.add(name);
 const file=resolve(root,name);assert.ok(!relative(root,file).startsWith('..'));assert.ok((await stat(file)).isFile(),`Missing ${name}`);
 const text=await readFile(file,'utf8');
 if(name.endsWith('.html'))for(const match of text.matchAll(/(?:src|href)="([^"]+)"/g)){if(match[1].startsWith('data:'))continue;await resource(new URL(match[1],url));}
 if(name.endsWith('.js'))for(const match of text.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g))await resource(new URL(match[1],url));
}
await resource(new URL('index.html',base));await resource(new URL('kernels/world.cu',base));
const app=await readFile(resolve(root,'app.js'),'utf8');assert.ok(app.includes("new URL('./kernels/world.cu',import.meta.url)"),'CUDA fetch must resolve relative to the app module');
console.log(`PASS: ${seen.size} deployable assets and modules resolve under /NotMinecraft/.`);
