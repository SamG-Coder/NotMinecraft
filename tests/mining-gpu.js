import {GpuRuntime} from '../engine/src/runtime/runtime.js';
const report={passed:[],benchmarks:[],errors:[]};
const check=(ok,name)=>{if(!ok)throw Error(name);report.passed.push(name);};
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
async function main(){
 const rt=await GpuRuntime.create({onError:e=>report.errors.push(String(e))});report.adapter=rt.describe();
 const source=await(await fetch('/kernels/world.cu')).text(),kernels={};
 for(const entry of ['simulate','generate','render','prepareMining','accumulateMining','resolveMining','replayMining'])kernels[entry]=await rt.kernel(source,{entry,workgroupSize:entry==='render'?[8,8,1]:['generate','accumulateMining','resolveMining'].includes(entry)?[128,1,1]:[1,1,1]});
 function create(){return {damageMap:rt.createBuffer(8192*4),damageKeys:rt.createBuffer(4096*16),damageMask:rt.createBuffer(4096*4096),damageStress:rt.createBuffer(4096*2048),damageMeta:rt.createBuffer(16),mining:rt.createBuffer(64*4)};}
 const view=b=>({damageMap:b.damageMap,damageKeys:b.damageKeys,damageMask:b.damageMask});
 async function events(b,list,seed=271828){
   const batch=rt.batch();
   for(const e of list){batch.dispatch(kernels.replayMining.bind({damageMap:b.damageMap,damageKeys:b.damageKeys,damageMeta:b.damageMeta,mining:b.mining},e),[1]);batch.dispatch(kernels.accumulateMining.bind({mining:b.mining,damageKeys:b.damageKeys,damageStress:b.damageStress},{}),[108]);batch.dispatch(kernels.resolveMining.bind({mining:b.mining,damageKeys:b.damageKeys,damageStress:b.damageStress,damageMask:b.damageMask,damageMeta:b.damageMeta},{seed}),[216]);}
   batch.submit();await rt.idle();
 }
 async function snapshot(b){const meta=await rt.read(b.damageMeta,Uint32Array),n=meta[0];const keys=await rt.read(b.damageKeys,Int32Array,Math.max(4,n*16)),mask=await rt.read(b.damageMask,Uint32Array,Math.max(4,n*4096)),stress=await rt.read(b.damageStress,Uint32Array,Math.max(4,n*2048));return {meta,keys,mask,stress};}
 function normalize(s){const out=new Map();for(let p=0;p<s.meta[0];p++)out.set(Array.from(s.keys.slice(p*4,p*4+3)).join(','),{mask:s.mask.slice(p*1024,(p+1)*1024),stress:s.stress.slice(p*512,(p+1)*512)});return out;}
 const a=create(),b=create();
 const list=[{x:-2,y:2700,z:1,radius:12,power:96},{x:9,y:2692,z:-5,radius:12,power:160},{x:-2,y:2700,z:1,radius:12,power:96},{x:-12,y:2703,z:-7,radius:16,power:200}];
 await events(a,list);await events(b,[...list].reverse());const sa=await snapshot(a),sb=await snapshot(b),na=normalize(sa),nb=normalize(sb);
 check(sa.meta[2]>0,'Accumulated integer damage fractures centimetre voxels');
 check(na.size===nb.size&&[...na].every(([k,v])=>nb.has(k)&&equal(v.mask,nb.get(k).mask)&&equal(v.stress,nb.get(k).stress)),'Reversing overlapping event order gives identical spatial stress and removal bits');
 // Independent integer CPU calculation from event geometry and published rules.
 const hash=(x,y,z)=>{let h=Math.imul(x,73856093)^Math.imul(y,19349663)^Math.imul(z,83492791);h=Math.imul(h^(h>>>16),2146121005);h=Math.imul(h^(h>>>15),2221713035);return (h^(h>>>16))>>>0;};
 const mix=h=>{h=Math.imul(h^(h>>>16),2146121005);h=Math.imul(h^(h>>>15),2221713035);return (h^(h>>>16))>>>0;};
 const strength=(x,y,z,seed)=>80+(mix(hash(Math.floor(x/2),Math.floor(y/2),Math.floor(z/2))^seed)&63)+(mix(hash(x,y,z)^Math.imul(seed,1664525))&31);
 let cells=0,voxels=0;
 for(const [key,value] of na){const [bx,by,bz]=key.split(',').map(Number);for(let i=0;i<512;i++){
   const x=bx*32+(i%8)*4+2,y=by*32+(Math.floor(i/8)%8)*4+2,z=bz*32+Math.floor(i/64)*4+2;
   let energy=0;for(const e of list){const r2=e.radius**2,d2=(x-e.x)**2+(y-e.y)**2+(z-e.z)**2;if(d2<r2)energy=Math.min(65535,energy+Math.floor((r2-d2)*e.power/r2));}
   if(value.stress[i]!==energy)throw Error('Independent stress mismatch');cells++;
  }
  for(let i=0;i<32768;i++){const x=i%32,y=Math.floor(i/32)%32,z=Math.floor(i/1024);const energy=value.stress[Math.floor(x/4)+Math.floor(y/4)*8+Math.floor(z/4)*64];const expected=energy>=strength(bx*32+x,by*32+y,bz*32+z,271828)?1:0;if(((value.mask[i>>>5]>>>(i&31))&1)!==expected)throw Error('Independent fracture mismatch');voxels++;}
 }
 check(true,`Independent CPU reference agrees on ${cells} damage cells and ${voxels} voxels, including negative coordinates`);
 const native=await fetch('/artifacts/native-mining-keys.bin');
 if(native.ok){
   const nk=new Int32Array(await native.arrayBuffer()),ns=new Uint32Array(await(await fetch('/artifacts/native-mining-stress.bin')).arrayBuffer()),nm=new Uint32Array(await(await fetch('/artifacts/native-mining-mask.bin')).arrayBuffer());
   check(equal(nk.filter((v,i)=>i%4!==3),sa.keys.filter((v,i)=>i%4!==3)),'Sparse mining page coordinates agree exactly with native CUDA');
   check(equal(ns,sa.stress),'All integer damage cells agree bit-for-bit with native CUDA');
   check(equal(nm,sa.mask),'All seeded fracture bits agree bit-for-bit with native CUDA');
 }
 await events(a,[list[0]]);const more=normalize(await snapshot(a));check([...na].every(([k,v])=>v.mask.every((word,i)=>(word&more.get(k).mask[i])>>>0===word)),'Additional hits never restore removed voxels');
 const c=create();await events(c,list,999);const nc=normalize(await snapshot(c));check([...na].some(([k,v])=>!equal(v.mask,nc.get(k).mask)),'Changing seed changes the fracture pattern for the same damage field');
 // Duplicate slots deliberately create simultaneous atomic contention. Real
 // allocation supplies unique pages; this test stresses the accumulator itself.
 const contention=create();await events(contention,[{x:8,y:8,z:8,radius:12,power:1}]);
 const commands=new Int32Array(64);commands.set([1,8,8,8,24,20000,27]);commands.fill(0,8,35);rt.device.queue.writeBuffer(contention.mining.gpuBuffer,0,commands);
 const keys0=await rt.read(contention.damageKeys,Int32Array,16);const oldStress=await rt.read(contention.damageStress,Uint32Array,512*4);
 rt.batch().dispatch(kernels.accumulateMining.bind({mining:contention.mining,damageKeys:contention.damageKeys,damageStress:contention.damageStress},{}),[108]).submit();await rt.idle();const contended=await rt.read(contention.damageStress,Uint32Array,512*4);
 check(contended.every((v,i)=>{const x=keys0[0]*32+(i%8)*4+2-8,y=keys0[1]*32+(Math.floor(i/8)%8)*4+2-8,z=keys0[2]*32+Math.floor(i/64)*4+2-8;const d2=x*x+y*y+z*z;const add=d2<576?Math.floor((576-d2)*20000/576):0;return v===Math.min(65535,oldStress[i]+27*add);}), '27 concurrent writers per damage cell saturate exactly without overflow or lost updates');
 const savedMeta=await rt.read(c.damageMeta,Uint32Array);rt.device.queue.writeBuffer(c.damageMeta.gpuBuffer,0,new Uint32Array([4096,0,savedMeta[2],savedMeta[3]]));
 await events(c,[{x:500000,y:0,z:500000,radius:12,power:96}]);const full=await rt.read(c.damageMeta,Uint32Array);
 check(full[0]===4096&&full[1]===1&&full[2]===savedMeta[2]&&full[3]===savedMeta[3],'Page exhaustion rejects an entire new stroke without erasing or partially applying edits');
 // Verify controller support really changes when a wide patch is removed.
 const pit=create(),state=rt.createBuffer(new Float32Array(32)),heights=rt.createBuffer(66049*4);
 const input={dt:0,forward:0,strafe:0,rise:0,lookX:0,lookY:0,sprint:0,toggleFly:0,reset:1,seed:271828,spawnX:0,spawnZ:0};
 const sim=kernels.simulate.bind({state,...view(pit)},input),gen=kernels.generate.bind({heights,state},{seed:271828});rt.batch().dispatch(sim,[1]).dispatch(gen,[517]).submit();await rt.idle();const initial=await rt.read(state);
 const groundY=Math.floor((initial[1]-1.75)*100),patch=[];
 for(const y of [groundY-4,groundY-24])for(const x of [-24,0,24])for(const z of [-24,0,24])patch.push({x,y,z,radius:24,power:65535});
 await events(pit,patch);const pitMeta=await rt.read(pit.damageMeta,Uint32Array);rt.device.queue.writeBuffer(state.gpuBuffer,68,new Float32Array([pitMeta[0]]));
 sim.setScalars({reset:0,dt:1/60});for(let i=0;i<45;i++){rt.batch().dispatch(sim,[1]).submit();await rt.idle();}
 const fallen=await rt.read(state);check(fallen[1]<initial[1]-0.15,'Player falls into a sufficiently wide mined hole instead of standing on the original heightfield');
 check(fallen[1]>initial[1]-1.5,'Mined-hole collision finds surviving floor beneath the player');
 report.pitDropMetres=initial[1]-fallen[1];
 // A dry-land cavity can extend below sea level without an invisible water floor.
 const deep=[];for(const y of [1460,1500,1540,1580,1620,1660,1700])for(const x of [-24,0,24])for(const z of [-24,0,24])deep.push({x,y,z,radius:24,power:65535});
 await events(pit,deep);const deepMeta=await rt.read(pit.damageMeta,Uint32Array),deepState=await rt.read(state);deepState[1]=17.0;deepState[5]=0;deepState[17]=deepMeta[0];rt.device.queue.writeBuffer(state.gpuBuffer,0,deepState);
 for(let i=0;i<60;i++){rt.batch().dispatch(sim,[1]).submit();await rt.idle();}
 const belowSea=await rt.read(state);report.belowSeaFeet=belowSea[1]-1.75;check(belowSea[1]-1.75<15.0,'Dry-land excavations below sea level have no invisible water floor');
 // Independently locate each species and mine both trunk and crown surfaces.
 const forest=create(),fs=rt.createBuffer(new Float32Array(32)),fh=rt.createBuffer(66049*4);
 const fi=kernels.simulate.bind({state:fs,...view(forest)},input),fg=kernels.generate.bind({heights:fh,state:fs},{seed:271828});
 rt.batch().dispatch(fi,[1]).dispatch(fg,[517]).submit();await rt.idle();
 const forestState=await rt.read(fs),corners=await rt.read(fh),sites=new Map();
 const random=(x,z,s)=>(mix(Math.imul(x,374761393)^Math.imul(z,668265263)^s)&65535)/65535;
 for(let tz=-8;tz<=8;tz++)for(let tx=-8;tx<=8;tx++){
   const species=Math.floor(random(tx,tz,271828+709)*2.999);if(sites.has(species)||random(tx,tz,271828+701)<=.52)continue;
   const x=tx*8+4+Math.floor((random(tx,tz,271828+727)-.5)*140)*.01,z=tz*8+4+Math.floor((random(tx,tz,271828+733)-.5)*140)*.01;
   const u=(x-forestState[8])/2,v=(z-forestState[9])/2,ix=Math.floor(u),iz=Math.floor(v),fx=u-ix,fz=v-iz,i=iz*257+ix;
   const base=Math.floor(((corners[i]+(corners[i+1]-corners[i])*fx)*(1-fz)+(corners[i+257]+(corners[i+258]-corners[i+257])*fx)*fz)*100)*.01;
   if(base>17&&base<34)sites.set(species,{x,z,base,height:3.6+random(tx,tz,271828+719)*1.8+(species===1?1:0)});
 }
 check(sites.size===3,'Independent seed lookup finds oak, birch and pine test sites');
 const fp=kernels.prepareMining.bind({state:fs,heights:fh,...view(forest),damageMeta:forest.damageMeta,mining:forest.mining},{dt:.1,pressed:1,seed:271828});
 for(const [species,site] of sites)for(const part of ['trunk','crown']){
   const pose=forestState.slice();pose[0]=site.x;pose[1]=site.base+(part==='trunk'?2:site.height);pose[2]=site.z-3;pose[3]=0;pose[4]=0;pose[16]=0;
   rt.device.queue.writeBuffer(fs.gpuBuffer,0,pose);rt.batch().dispatch(fp,[1]).submit();await rt.idle();const first=await rt.read(fs);
   check(first[18]===1&&Math.abs(first[21]-site.z)<2.2&&Math.abs(first[20]-pose[1])<.02,`${['Oak','Birch','Pine'][species]} ${part} is picked at its visible volume`);
   await events(forest,[{x:Math.round(first[19]*100),y:Math.round(first[20]*100),z:Math.round(first[21]*100),radius:24,power:65535}]);
   rt.batch().dispatch(fp,[1]).submit();await rt.idle();const second=await rt.read(fs);
   check(second[18]===0||second[21]>first[21]+.1,`${['Oak','Birch','Pine'][species]} ${part} mining exposes a deeper surface`);
 }
 // Full frame GPU timestamps, including all six gameplay kernels.
 if(rt.device.features.has('timestamp-query')){
   const bench=create(),bs=rt.createBuffer(new Float32Array(32)),bh=rt.createBuffer(66049*4),pixels=rt.createBuffer(1920*1080*4);
   const si=kernels.simulate.bind({state:bs,...view(bench)},input),ge=kernels.generate.bind({heights:bh,state:bs},{seed:271828});rt.batch().dispatch(si,[1]).dispatch(ge,[517]).submit();await rt.idle();rt.device.queue.writeBuffer(bs.gpuBuffer,16,new Float32Array([-1.12]));si.setScalars({reset:0,dt:0});
   const prep=kernels.prepareMining.bind({state:bs,heights:bh,...view(bench),damageMeta:bench.damageMeta,mining:bench.mining},{dt:0.1,pressed:0,seed:271828});
   const ac=kernels.accumulateMining.bind({mining:bench.mining,damageKeys:bench.damageKeys,damageStress:bench.damageStress},{});
   const re=kernels.resolveMining.bind({mining:bench.mining,damageKeys:bench.damageKeys,damageStress:bench.damageStress,damageMask:bench.damageMask,damageMeta:bench.damageMeta},{seed:271828});
   const draw=kernels.render.bind({pixels,heights:bh,state:bs,...view(bench)},{width:1920,height:1080,seed:271828,viewDistance:160,exact:1});
   const qs=rt.device.createQuerySet({type:'timestamp',count:2}),qr=rt.device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),read=rt.device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   for(const scenario of [{name:'ground view, pristine',pressed:0},{name:'ground view, active mining every frame',pressed:1},{name:'horizon view after mining',pressed:0,horizon:true}]){
    if(scenario.horizon)rt.device.queue.writeBuffer(bs.gpuBuffer,16,new Float32Array([-0.12]));prep.setScalars({pressed:scenario.pressed});const samples=[];
    for(let i=0;i<35;i++){const batch=rt.batch({timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});batch.dispatch(si,[1]).dispatch(ge,[517]).dispatch(prep,[1]).dispatch(ac,[108]).dispatch(re,[216]).dispatch(draw,[240,135]);batch.endPass();batch.encoder.resolveQuerySet(qs,0,2,qr,0);batch.encoder.copyBufferToBuffer(qr,0,read,0,16);batch.submit();await read.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(read.getMappedRange());if(i>=5)samples.push(Number(t[1]-t[0])/1e6);read.unmap();}
    samples.sort((a,b)=>a-b);report.benchmarks.push({scene:scenario.name,width:1920,height:1080,exact:true,samples:30,medianMs:samples[15],p95Ms:samples[28]});
   }
   const end=await rt.read(bench.damageMeta,Uint32Array);check(end[3]>=30&&end[2]>1000,'Active-mining benchmark performed real strokes and removed voxels');report.benchmarkDamage=Array.from(end);
 }
 check(report.errors.length===0,'No WebGPU validation errors');
}
main().catch(e=>report.errors.push(String(e.stack||e))).finally(()=>{window.__report=report;document.getElementById('result').textContent=JSON.stringify(report,null,2);});
