import {GpuRuntime} from '../engine/src/runtime/runtime.js';
const report={passed:[],errors:[],benchmarks:[]};
const check=(ok,name)=>{if(!ok)throw Error(name);report.passed.push(name);};
async function main(){
 const rt=await GpuRuntime.create({onError:e=>report.errors.push(String(e))});
 const source=await(await fetch('/kernels/world.cu')).text(),k={};
 for(const entry of ['simulate','generate','prepareMining','accumulateMining','resolveMining','render'])k[entry]=await rt.kernel(source,{entry,workgroupSize:entry==='render'?[8,8,1]:['generate','accumulateMining','resolveMining'].includes(entry)?[128,1,1]:[1,1,1]});
 const state=rt.createBuffer(new Float32Array(544)),heights=rt.createBuffer(66049*4),damageMap=rt.createBuffer(8192*4),damageKeys=rt.createBuffer(4096*16),damageMask=rt.createBuffer(4096*4096),damageStress=rt.createBuffer(4096*2048),damageMeta=rt.createBuffer(16),mining=rt.createBuffer(512*4);
 const damage={damageMap,damageKeys,damageMask};
 const sim=k.simulate.bind({state,...damage},{dt:0,forward:0,strafe:0,rise:0,lookX:0,lookY:0,sprint:0,toggleFly:0,reset:1,seed:271828,spawnX:0,spawnZ:0});
 rt.batch().dispatch(sim,[1]).dispatch(k.generate.bind({heights,state},{seed:271828}),[517]).submit();await rt.idle();const base=await rt.read(state);
 const prep=k.prepareMining.bind({state,heights,...damage,damageMeta,mining},{dt:1/120,pressed:0,seed:271828});
 const acc=k.accumulateMining.bind({mining,damageKeys,damageStress},{}),resolve=k.resolveMining.bind({mining,damageKeys,damageStress,damageMask,damageMeta},{seed:271828});
 async function reset(charges){const s=base.slice();s[30]=charges.length;s[31]=charges.length;charges.forEach((c,i)=>s.set(c,32+i*8));rt.device.queue.writeBuffer(state.gpuBuffer,0,s);const batch=rt.batch();for(const b of [damageMap,damageMask,damageStress,damageMeta,mining])batch.clear(b);batch.submit();await rt.idle();}
 async function tick(dt=1/120){prep.setScalars({dt,pressed:0});rt.batch().dispatch(prep,[1]).dispatch(acc,[108]).dispatch(resolve,[216]).submit();await rt.idle();return rt.read(state);}
 const charges=[[.001,0,60,0,0,0,0,1],[2,1.2,60,0,0,0,0,1],[2,3.5,60,0,0,0,0,1],[2,5,60,0,0,0,0,1]];
 await reset(charges);const first=await tick();
 const native=await fetch('/artifacts/native-tnt-state.bin');if(native.ok){const ns=new Float32Array(await native.arrayBuffer());check(ns.length===first.length&&ns.every((v,i)=>Math.abs(v-first[i])<.0001),'All 544 TNT state values agree with native CUDA within 0.0001');}
 check(first[28]===1&&first[31]===3,'One detonation preserves three unexploded charges');
 check(Math.abs(first[44]-6.86)<.002&&first[44]>first[52]&&first[52]>0&&first[60]===0,'Radial impulse agrees with independent distance falloff, and excludes TNT outside 4 m');
 check(first[45]>0&&first[40]>1.9,'Explosion lifts nearby TNT without prematurely consuming its fuse');
 await reset(charges);const repeated=await tick();check(first.every((v,i)=>v===repeated[i]),'Identical starting charges and timestep reproduce the same state bit-for-bit');
 let moved;for(let i=0;i<12;i++)moved=await tick();check(moved[41]>first[41]+.3&&moved[42]>first[42],'Impulse becomes observable horizontal and upward motion');
 const paused=await tick(0);check(paused.every((v,i)=>v===moved[i]),'Paused simulation preserves every charge, fuse and velocity');
 await reset([[.001,0,60,0,0,0,0,1],[.001,1.2,60,0,0,0,0,1],[.001,2.4,60,0,0,0,0,1]]);
 const one=await tick();const two=await tick();const three=await tick();
 check(one[28]===1&&two[28]===2&&three[28]===3&&three[31]===0,'Simultaneous expiries queue deterministically and all three blasts execute exactly once');
 check((await rt.read(damageMeta,Uint32Array))[3]===3,'Each queued blast reaches the atomic terrain-damage pipeline');
 await reset([[2,1.2,60,0,0,0,0,1]]);await tick(1/60);const coarse=await rt.read(state);await reset([[2,1.2,60,0,0,0,0,1]]);await tick();const fine=await tick();
 check(coarse.every((v,i)=>Math.abs(v-fine[i])<.00001),'120 Hz fixed physics agrees across different frame timestep partitions');
 // A falling charge must settle on the same terrain used by mining and rendering.
 await reset([[2,0,base[1]+1,0,0,-8,0,1]]);let landed;for(let i=0;i<100;i++)landed=await tick();
 check(landed[34]>.5+base[1]-1.75-.02&&landed[34]<base[1]+1,'Gravity and collision stop TNT above surviving ground');
 await reset(Array.from({length:64},(_,i)=>[3,(i%8)*1.2,60,Math.floor(i/8)*1.2,0,0,0,1]));
 const full=await tick(0);check(full[30]===64&&full[31]===64,'The full 64-charge pool remains resident without overwriting a slot');
 prep.setScalars({dt:0,pressed:2});rt.batch().dispatch(prep,[1]).submit();await rt.idle();const rejected=await rt.read(state);check(rejected[29]===2&&rejected[31]===64&&rejected.slice(32).every((v,i)=>v===full[32+i]),'Pool exhaustion rejects placement without overwriting existing TNT');
 const pixels=rt.createBuffer(1280*720*4),pose=full.slice();pose[0]=4;pose[1]=64;pose[2]=-5;pose[3]=0;pose[4]=-.35;rt.device.queue.writeBuffer(state.gpuBuffer,0,pose);
 const draw=k.render.bind({pixels,heights,state,...damage},{width:1280,height:720,seed:271828,viewDistance:160,exact:1});
 prep.setScalars({dt:1/60,pressed:0});const start=performance.now();for(let i=0;i<8;i++){rt.batch().dispatch(prep,[1]).dispatch(acc,[108]).dispatch(resolve,[216]).dispatch(draw,[160,90]).submit();await rt.idle();}report.benchmarks.push({scene:'64 moving detailed TNT models: physics, damage dispatches and rendering',resolution:'1280x720',averageSubmissionAndGpuMs:(performance.now()-start)/8});
 const pic=await rt.read(pixels,Uint32Array);check(pic.every(v=>(v>>>24)===255)&&new Set(pic).size>100,'Full-pool detailed models render an opaque, populated framebuffer');
 check(report.errors.length===0,'No WebGPU validation errors');
}
main().catch(e=>report.errors.push(String(e.stack||e))).finally(()=>{window.__report=report;document.getElementById('result').textContent=JSON.stringify(report,null,2);});
