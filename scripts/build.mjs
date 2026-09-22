import {cp,mkdir,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,basename} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(root,'dist');
if(dirname(out)!==resolve(root)||basename(out)!=='dist')throw Error('Invalid build output directory');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
for(const file of ['index.html','app.js','style.css','kernels/world.cu','engine/LICENSE','engine/THIRD_PARTY_NOTICES.md']){
 const target=resolve(out,file);await mkdir(dirname(target),{recursive:true});await cp(resolve(root,file),target);
}
for(const dir of ['engine/src/compiler','engine/src/runtime','engine/licenses'])await cp(resolve(root,dir),resolve(out,dir),{recursive:true});
await writeFile(resolve(out,'.nojekyll'),'');
console.log('Built static site in dist/ with CUDA source, compiler, runtime, and license notices.');
