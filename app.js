import {GpuRuntime} from './engine/src/runtime/runtime.js';
const $=id=>document.getElementById(id);
const canvas=$('world'), keys=new Set();
let runtime, state, heights, pixels, sim, gen, render, simCall, genCall, renderCall;
let ready=false, menu=true, reset=1, toggleFly=0, mx=0, my=0, width=0, height=0;
let seed=271828, spawnX=0, spawnZ=0, last=0, lastHud=0, frames=0;
const frameTimes=[];
let hudElapsed=0;
let querySet, queryResolve, queryRead, queryPending=false, gpuMs=0;
let damage, damageStress, damageMeta, mining, prepare, accumulate, resolve, prepareCall, accumulateCall, resolveCall;
let placeTnt=false, observedBlasts=0;
let mineHeld=false, saveNeeded=false, lastMine=0, bufferSeed=seed, db;
const sessionSaves=new Map();
const fail=error=>{$('error').hidden=false;$('error').textContent=String(error?.stack||error);$('status').textContent='GPU ERROR';console.error(error);};
function openMenu(show){menu=show;$('menu').hidden=!show;document.body.classList.toggle('playing',!show);$('crosshair').hidden=show;$('hint').hidden=show||document.pointerLockElement===canvas;if(show){keys.clear();mx=my=0;mineHeld=false;placeTnt=false;if(document.pointerLockElement)document.exitPointerLock();}}
function readWorld(){
  const nextSeed=Number($('seed').value),x=Number($('spawn-x').value),z=Number($('spawn-z').value);
  if(!Number.isInteger(nextSeed)||nextSeed<0||nextSeed>4294967295||![x,z].every(v=>Number.isFinite(v)&&Math.abs(v)<=8192)){fail(new Error('Use a whole-number seed from 0 to 4294967295, and coordinates between -8192 and 8192 metres.'));return false;}
  seed=nextSeed;spawnX=x;spawnZ=z;reset=1;
  const url=new URL(location.href);url.searchParams.set('seed',seed);url.searchParams.set('x',x);url.searchParams.set('z',z);history.replaceState({},'',url);return true;
}
const params=new URLSearchParams(location.search);
for(const [key,id] of [['seed','seed'],['x','spawn-x'],['z','spawn-z']])if(params.has(key))$(id).value=params.get(key);
readWorld();
$('play').onclick=async()=>{if(!ready)return;openMenu(false);try{await canvas.requestPointerLock({unadjustedMovement:true});}catch{try{await canvas.requestPointerLock();}catch{$('hint').hidden=false;}}};
canvas.onclick=()=>{if(!menu&&document.pointerLockElement!==canvas)$('play').click();};
$('menu-button').onclick=()=>openMenu(!menu);
$('seed').onchange=readWorld;
$('new-seed').onclick=()=>{$('seed').value=(Number($('seed').value)+1)>>>0;readWorld();};
$('teleport').onclick=readWorld;
$('tool').onchange=()=>{mineHeld=false;placeTnt=false;$('mining-status').textContent=$('tool').value==='tnt'?'TNT SELECTED - CLICK A SURFACE TO PLACE':'HOLD LEFT MOUSE TO MINE - 6 M REACH';};
document.addEventListener('pointerlockchange',()=>{if(document.pointerLockElement!==canvas)openMenu(true);else $('hint').hidden=true;});
document.addEventListener('mousemove',e=>{if(document.pointerLockElement===canvas){mx+=e.movementX;my+=e.movementY;}});
document.addEventListener('keydown',e=>{if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement)return;if(['Space','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();if(e.code==='Escape'){openMenu(true);return;}if(!menu){keys.add(e.code);if(e.code==='KeyF'&&!e.repeat)toggleFly=1;if(!e.repeat&&(e.code==='Digit1'||e.code==='Digit2')){$('tool').value=e.code==='Digit2'?'tnt':'mine';$('tool').onchange();}}});
document.addEventListener('keyup',e=>keys.delete(e.code));
document.addEventListener('mousedown',e=>{if(!menu&&document.pointerLockElement===canvas){if(e.button===2||(e.button===0&&$('tool').value==='tnt')){placeTnt=true;$('tnt-status').textContent='PLACING TNT...';}else if(e.button===0)mineHeld=true;}});
document.addEventListener('mouseup',e=>{if(e.button===0)mineHeld=false;});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
window.addEventListener('blur',()=>{keys.clear();mx=my=0;openMenu(true);});
document.addEventListener('visibilitychange',()=>{keys.clear();last=0;});
function openDatabase(){return new Promise((res,rej)=>{const request=indexedDB.open('notminecraft-destruction',1);request.onupgradeneeded=()=>request.result.createObjectStore('worlds');request.onsuccess=()=>res(request.result);request.onerror=()=>rej(request.error);});}
function storedWorld(key){return new Promise((res,rej)=>{const r=db.transaction('worlds').objectStore('worlds').get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
async function saveWorld(force=false){
  // Called between frames, so all buffers belong to one consistent snapshot.
  if(!saveNeeded&&!force)return;
  const meta=await runtime.read(damageMeta,Uint32Array);const count=meta[0];
  const [map,keys,mask,stress]=await Promise.all([runtime.read(damage.damageMap,Uint32Array),runtime.read(damage.damageKeys,Int32Array,Math.max(4,count*16)),runtime.read(damage.damageMask,Uint32Array,Math.max(4,count*4096)),runtime.read(damageStress,Uint32Array,Math.max(4,count*2048))]);
  const snapshot={version:1,meta,map,keys,mask,stress};sessionSaves.set(bufferSeed,snapshot);saveNeeded=false;
  if(!db){$('mining-status').textContent='SAVED FOR THIS SESSION · LOCAL STORAGE UNAVAILABLE';return;}
  try{await new Promise((res,rej)=>{const tx=db.transaction('worlds','readwrite');tx.objectStore('worlds').put(snapshot,bufferSeed);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});$('mining-status').textContent='MINING SAVED LOCALLY';}
  catch(error){$('mining-status').textContent='SAVED FOR THIS SESSION · DISK SAVE FAILED';console.warn(error);}
}
async function loadWorld(nextSeed){
  let saved=sessionSaves.get(nextSeed);if(!saved&&db){try{saved=await storedWorld(nextSeed);}catch(error){console.warn(error);}}
  const batch=runtime.batch();for(const b of [...Object.values(damage),damageStress,damageMeta,mining])batch.clear(b);batch.submit();
  runtime.device.queue.writeBuffer(state.gpuBuffer,64,new Float32Array([0,0]));
  if(saved){
    const n=saved.meta?.[0];
    if(saved.version!==1||!Number.isInteger(n)||n>4096||saved.map.length!==8192||saved.map.some(v=>v>n)||saved.keys.byteLength!==Math.max(4,n*16)||saved.mask.byteLength!==Math.max(4,n*4096)||saved.stress.byteLength!==Math.max(4,n*2048))throw Error('Saved mining state has an unsupported layout.');
    for(const [b,data] of [[damageMeta,saved.meta],[damage.damageMap,saved.map],[damage.damageKeys,saved.keys],[damage.damageMask,saved.mask],[damageStress,saved.stress]])runtime.device.queue.writeBuffer(b.gpuBuffer,0,data);
    runtime.device.queue.writeBuffer(state.gpuBuffer,68,new Float32Array([n]));
  }
  runtime.device.queue.writeBuffer(state.gpuBuffer,88,new Float32Array(10+64*8));runtime.device.queue.writeBuffer(state.gpuBuffer,116,new Float32Array([-1]));observedBlasts=0;placeTnt=false;
  bufferSeed=nextSeed;saveNeeded=false;reset=1;
}
function resize(){
  const scale=Number($('resolution').value),w=Math.max(64,Math.floor(innerWidth*devicePixelRatio*scale/64)*64),h=Math.max(1,Math.floor(innerHeight*devicePixelRatio*scale));
  // A bounded allocation protects against extreme browser zoom / monitor sizes.
  const factor=Math.min(1,2560/w,1440/h),nw=Math.max(64,Math.floor(w*factor/64)*64),nh=Math.max(1,Math.floor(h*factor));
  if(nw===width&&nh===height)return;
  width=nw;height=nh;canvas.width=width;canvas.height=height;
  if(pixels)runtime.destroyBuffer(pixels);
  pixels=runtime.createBuffer(width*height*4,{label:'CUDA RGBA framebuffer'});
  renderCall=render.bind({pixels,heights,state,...damage},{width,height,seed,viewDistance:Number($('distance').value),exact:Number($('exact').checked)});
}
async function frame(now){
  if(!ready)return;
  try {
    now=performance.now();
    while(bufferSeed!==seed){await saveWorld(true);await loadWorld(seed);}
    if(saveNeeded&&!mineHeld&&(menu||now-lastMine>1200)){try{await saveWorld();}catch(error){$('mining-status').textContent='LOCAL SAVE FAILED — KEEP THIS TAB OPEN';console.warn(error);lastMine=now;}}
    if(document.hidden){last=0;requestAnimationFrame(frame);return;}
    resize();
    const elapsed=last?now-last:0;const dt=Math.min(elapsed/1000,0.05);last=now;
    const active=!menu&&document.pointerLockElement===canvas;
    const pressed=active&&mineHeld;const placing=active&&placeTnt;placeTnt=false;if(placing){saveNeeded=true;lastMine=now;}if(pressed){saveNeeded=true;lastMine=now;$('mining-status').textContent='MINING · 1 CM FRACTURE';}
    simCall.setScalars({dt:active?dt:0,forward:active?Number(keys.has('KeyW'))-Number(keys.has('KeyS')):0,strafe:active?Number(keys.has('KeyD'))-Number(keys.has('KeyA')):0,rise:active?Number(keys.has('Space'))-Number(keys.has('ControlLeft')||keys.has('KeyC')):0,lookX:mx,lookY:my,sprint:Number(keys.has('ShiftLeft')||keys.has('ShiftRight')),toggleFly,reset,seed,spawnX,spawnZ});
    mx=my=0;toggleFly=0;reset=0;genCall.setScalars({seed});renderCall.setScalars({width,height,seed,viewDistance:Number($('distance').value),exact:Number($('exact').checked)});
    prepareCall.setScalars({dt:active?dt:0,pressed:placing?2:Number(pressed),seed});resolveCall.setScalars({seed});
    const measure=querySet&&!queryPending&&now-lastHud>500;
    const batch=runtime.batch(measure?{timestampWrites:{querySet,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});
    batch.dispatch(simCall,[1,1,1]);batch.dispatch(genCall,[517,1,1]);
    batch.dispatch(prepareCall,[1,1,1]);batch.dispatch(accumulateCall,[108,1,1]);batch.dispatch(resolveCall,[216,1,1]);
    batch.dispatch(renderCall,[Math.ceil(width/8),Math.ceil(height/8),1]);
    batch.endPass();
    batch.encoder.copyBufferToTexture({buffer:pixels.gpuBuffer,bytesPerRow:width*4,rowsPerImage:height},{texture:canvas.getContext('webgpu').getCurrentTexture()},[width,height,1]);
    if(measure){batch.encoder.resolveQuerySet(querySet,0,2,queryResolve,0);batch.encoder.copyBufferToBuffer(queryResolve,0,queryRead,0,16);}
    batch.submit();if(elapsed>0){frames++;hudElapsed+=elapsed;}const submittedAt=performance.now();frameTimes.push(submittedAt);if(frameTimes.length>180)frameTimes.shift();
    if(measure){queryPending=true;queryRead.mapAsync(GPUMapMode.READ).then(()=>{const t=new BigUint64Array(queryRead.getMappedRange());gpuMs=Number(t[1]-t[0])/1e6;queryRead.unmap();queryPending=false;}).catch(fail);}
    if(now-lastHud>500){
      lastHud=now;const fps=hudElapsed?frames*1000/hudElapsed:0;frames=0;hudElapsed=0;
      $('fps').innerHTML=`${Math.round(fps)} <small>FPS</small>`;$('gpu-time').innerHTML=`${querySet?gpuMs.toFixed(2):'N/A'} <small>MS</small>`;
      // Small state and damage telemetry twice per second; no pixel readback.
      runtime.read(state,Float32Array,128).then(s=>{$('coords').textContent=`X ${s[0].toFixed(2)}   Y ${s[1].toFixed(2)}   Z ${s[2].toFixed(2)}`;if(s[31]>0)$('mining-status').textContent='TNT ARMED - FUSE PAUSES IN MENU';if(s[28]!==observedBlasts){observedBlasts=s[28];saveNeeded=true;lastMine=performance.now();$('mining-status').textContent='TNT DETONATED - WAITING TO SAVE CRATER';}
        $('tnt-status').textContent=s[31]>0?`${s[31]} / 64 TNT - NEXT FUSE ${s[22].toFixed(1)}s`:(s[29]===2?'64 TNT LIMIT - WAIT FOR A FREE SLOT':s[29]===0?'NO TARGET WITHIN 6 M - AIM AT CLOSER GROUND':s[29]===3?'TNT TOO CLOSE TO YOU - AIM FURTHER AHEAD':s[29]===4?'NO ROOM FOR TNT - AIM AT A CLEARER SURFACE':'RIGHT-CLICK TO PLACE TNT - 6 M REACH');$('mode').textContent=s[6]>.5?'FLYING - SPACE UP / CTRL DOWN':'ON FOOT';}).catch(fail);
      runtime.read(damageMeta,Uint32Array).then(m=>{if(m[1])$('mining-status').textContent='EDIT CAPACITY REACHED · EXISTING HOLES PRESERVED';$('edit-pages').textContent=`${m[0]} / 4096 EDIT PAGES`;}).catch(fail);
    }
    // Bound GPU queue depth to one frame; no latency spiral under heavy load.
    await runtime.idle();requestAnimationFrame(frame);
  }catch(error){ready=false;fail(error);}
}
async function start(){
  runtime=await GpuRuntime.create({onError:fail});
  const source=await(await fetch(new URL('./kernels/world.cu',import.meta.url))).text();
  sim=await runtime.kernel(source,{entry:'simulate',workgroupSize:[1,1,1]});
  gen=await runtime.kernel(source,{entry:'generate',workgroupSize:[128,1,1]});
  render=await runtime.kernel(source,{entry:'render',workgroupSize:[8,8,1]});
  prepare=await runtime.kernel(source,{entry:'prepareMining',workgroupSize:[1,1,1]});
  accumulate=await runtime.kernel(source,{entry:'accumulateMining',workgroupSize:[128,1,1]});
  resolve=await runtime.kernel(source,{entry:'resolveMining',workgroupSize:[128,1,1]});
  state=runtime.createBuffer(new Float32Array(32+64*8));heights=runtime.createBuffer(66049*4);
  damage={damageMap:runtime.createBuffer(8192*4),damageKeys:runtime.createBuffer(4096*16),damageMask:runtime.createBuffer(4096*4096)};
  damageStress=runtime.createBuffer(4096*2048);damageMeta=runtime.createBuffer(16);mining=runtime.createBuffer(512*4);
  try{db=await openDatabase();}catch{$('mining-status').textContent='LOCAL STORAGE UNAVAILABLE · SESSION ONLY';}
  await loadWorld(seed);
  simCall=sim.bind({state,...damage},{dt:0,forward:0,strafe:0,rise:0,lookX:0,lookY:0,sprint:0,toggleFly:0,reset:1,seed,spawnX,spawnZ});
  genCall=gen.bind({heights,state},{seed});
  prepareCall=prepare.bind({state,heights,...damage,damageMeta,mining},{dt:0,pressed:0,seed});
  accumulateCall=accumulate.bind({mining,damageKeys:damage.damageKeys,damageStress},{});
  resolveCall=resolve.bind({mining,damageKeys:damage.damageKeys,damageStress,damageMask:damage.damageMask,damageMeta},{seed});
  canvas.getContext('webgpu').configure({device:runtime.device,format:'rgba8unorm',alphaMode:'opaque',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  if(runtime.device.features.has('timestamp-query')){querySet=runtime.device.createQuerySet({type:'timestamp',count:2});queryResolve=runtime.device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});queryRead=runtime.device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});}
  ready=true;$('play').disabled=false;$('play').innerHTML='Explore this world <span>↗</span>';$('status').textContent='WORLD ONLINE';
  // Explicit diagnostics hook for reproducible GPU correctness and performance checks.
  window.game={runtime,state,heights,damage,damageMeta,damageStress,mining,frameLimit:null,get frameTimes(){return frameTimes.slice();},get pixels(){return pixels;},get size(){return [width,height];},get gpuMs(){return gpuMs;},get ready(){return ready;},get seed(){return seed;},setWorld(s,x=0,z=0){$('seed').value=s;$('spawn-x').value=x;$('spawn-z').value=z;return readWorld();}};
  requestAnimationFrame(frame);
}
start().catch(fail);
