import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {compile} from '../engine/src/compiler/compiler.js';
const source=await readFile(new URL('../kernels/world.cu',import.meta.url),'utf8');
await mkdir(new URL('../artifacts',import.meta.url),{recursive:true});
for(const [entry,workgroupSize] of [['simulate',[1,1,1]],['generate',[128,1,1]],['render',[8,8,1]],['prepareMining',[1,1,1]],['accumulateMining',[128,1,1]],['resolveMining',[128,1,1]],['replayMining',[1,1,1]]]) {
  const a=compile(source,{entry,workgroupSize});
  await writeFile(new URL(`../artifacts/${entry}.wgsl`,import.meta.url),a.wgsl);
  console.log(`${entry}: compiled ${a.wgsl.length} bytes WGSL`);
}
