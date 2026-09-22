import {GpuRuntime} from '../engine/src/runtime/runtime.js';
const report={passed:[],benchmarks:[],errors:[]};
const check=(ok,name)=>{if(!ok)throw Error(name);report.passed.push(name);};
async function main(){
 const rt=await GpuRuntime.create({onError:e=>report.errors.push(String(e))});report.adapter=rt.describe();
 const source=await(await fetch('/kernels/world.cu')).text();
 const sim=await rt.kernel(source,{entry:'simulate',workgroupSize:[1,1,1]});
 const gen=await rt.kernel(source,{entry:'generate',workgroupSize:[128,1,1]});
 const ren=await rt.kernel(source,{entry:'render',workgroupSize:[8,8,1]});
 const state=rt.createBuffer(new Float32Array(32)),heights=rt.createBuffer(66049*4);
 const damage={damageMap:rt.createBuffer(8192*4),damageKeys:rt.createBuffer(4096*16),damageMask:rt.createBuffer(4096*4096)};
 const input={dt:0,forward:0,strafe:0,rise:0,lookX:0,lookY:0,sprint:0,toggleFly:0,reset:1,seed:271828,spawnX:0,spawnZ:0};
 async function tick(change={},generate=true){Object.assign(input,change);const batch=rt.batch().dispatch(sim.bind({state,...damage},input),[1,1,1]);if(generate)batch.dispatch(gen.bind({heights,state},{seed:input.seed}),[517,1,1]);batch.submit();await rt.idle();input.reset=0;input.toggleFly=0;input.lookX=0;input.lookY=0;return rt.read(state);}
 const initial=await tick(),a=await rt.read(heights);
 check(a.every(Number.isFinite)&&a.every(v=>v>=3&&v<=47.15),'Terrain heights are finite and bounded');
 check(initial[1]>a[112*257+112],'Player spawns above terrain');
 const originA=[initial[8],initial[9]];
 await tick({reset:1});const repeat=await rt.read(heights);
 check(a.every((v,i)=>v===repeat[i]),'Same seed and coordinates reproduce every cached height exactly');
 await tick({seed:271829,reset:1});const changed=await rt.read(heights);
 check(a.some((v,i)=>Math.abs(v-changed[i])>1),'Different seeds change terrain');
 await tick({seed:271828,reset:1,spawnX:65,spawnZ:-65});const movedState=await rt.read(state),moved=await rt.read(heights);
 let compared=0;
 for(let z=0;z<257;z++)for(let x=0;x<257;x++){
   const ox=(movedState[8]+x*2-originA[0])/2,oz=(movedState[9]+z*2-originA[1])/2;
   if(ox>=0&&oz>=0&&ox<=256&&oz<=256){if(moved[z*257+x]!==a[oz*257+ox])throw Error('Cache overlap differs');compared++;}
 }
 check(compared>30000,'Streaming across positive and negative cache boundaries preserves shared heights');
 const stable=await tick();check(stable[10]===0,'Stationary player does not regenerate the terrain cache');
 await tick({reset:1,spawnX:-4096,spawnZ:-4096});const negative=await rt.read(state);
 check(negative.every(Number.isFinite)&&negative[0]===-4096&&negative[2]===-4096,'Negative distant spawn remains finite and preserves requested coordinates');
 await tick({reset:1,spawnX:0,spawnZ:0});
 let before=await rt.read(state);await tick({dt:1/60,forward:1});let after=await rt.read(state);
 check(Math.hypot(after[0]-before[0],after[2]-before[2])>0.06,'Walking updates position on the GPU');
 await tick({dt:1/60,forward:0,rise:1});after=await rt.read(state);
 check(after[5]>5,'Jump applies positive vertical velocity');
 await tick({dt:0,reset:1,rise:0});before=await rt.read(state);
 await tick({dt:1/60,toggleFly:1,rise:1});after=await rt.read(state);
 check(after[6]===1&&after[1]>before[1],'Fly toggle and vertical movement run on the GPU');
 // Locate a tree independently with integer hashing, then walk into its trunk.
 const hash=x=>{x=Math.imul(x^(x>>>16),2146121005);x=Math.imul(x^(x>>>15),2221713035);return (x^(x>>>16))>>>0;};
 let treeCell;
 for(let z=108;z<122&&!treeCell;z++)for(let x=108;x<122;x++){
   const wx=originA[0]/2+x,wz=originA[1]/2+z;
   const value=(hash(Math.imul(wx,374761393)^Math.imul(wz,668265263)^(271828+701))&65535)/65535;
   const base=(a[z*257+x]+a[z*257+x+1]+a[(z+1)*257+x]+a[(z+1)*257+x+1])/4;
   if(value>.965&&base>17&&base<33){treeCell={x:wx*2,z:wz*2,base};break;}
 }
 check(!!treeCell,'Independent seeded hash locates a test tree');
 await tick({dt:0,reset:1,rise:0,forward:0});const collisionState=await rt.read(state);
 collisionState[0]=treeCell.x+1;collisionState[2]=treeCell.z-0.5;collisionState[1]=treeCell.base+1.75;collisionState[3]=0;collisionState[6]=0;
 rt.device.queue.writeBuffer(state.gpuBuffer,0,collisionState);
 for(let i=0;i<45;i++)await tick({dt:1/60,forward:1},false);
 const stopped=await rt.read(state);check(stopped[2]<treeCell.z+0.6,'Player body is blocked by a procedurally placed tree trunk');
 await tick({dt:0,reset:1,rise:0,forward:0});
 const pixels=rt.createBuffer(320*200*4);
 async function picture(exact=1){rt.batch().dispatch(ren.bind({pixels,heights,state,...damage},{width:320,height:200,seed:271828,viewDistance:160,exact}),[40,25,1]).submit();await rt.idle();return rt.read(pixels,Uint32Array);}
 const pic=await picture();const pic2=await picture();
 check(pic.every((v,i)=>v===pic2[i]),'Exact-mode image is bit-identical across repeated GPU renders');
 check(pic.every(v=>(v>>>24)===255)&&new Set(pic).size>300,'Framebuffer is opaque and contains rendered scene detail');
 // Native fixtures are optional: generate with scripts/native-check.ps1.
 const nativeHeights=await fetch('/artifacts/native-heights.bin');
 if(nativeHeights.ok){
   const nh=new Float32Array(await nativeHeights.arrayBuffer());
   check(nh.length===a.length&&nh.every((v,i)=>Math.abs(v-a[i])<0.00005),'All cached heights agree with independently executed native CUDA within 0.00005 m');
   const np=new Uint8Array(await(await fetch('/artifacts/native-pixels.bin')).arrayBuffer());const gp=new Uint8Array(pic.buffer);
   let total=0,max=0,large=0;for(let i=0;i<np.length;i++){if(i%4===3)continue;const delta=Math.abs(np[i]-gp[i]);total+=delta;max=Math.max(max,delta);if(delta>8)large++;}
   report.nativeImage={meanChannelError:total/(320*200*3),maxChannelError:max,channelsOver8:large,totalChannels:320*200*3};
   check(report.nativeImage.meanChannelError<1&&large/(320*200*3)<0.01,'Exact-mode image agrees with native CUDA (mean channel error <1, >99% channels within 8/255)');
 }
 await tick({reset:1,spawnX:-4096,spawnZ:-4096});const farPic=await picture();
 check(new Set(farPic).size>300,'Exact centimetre rendering remains populated at distant negative coordinates');
 // Query timestamps measure simulation, cached generation and render together.
 if(rt.device.features.has('timestamp-query')) {
   const qs=rt.device.createQuerySet({type:'timestamp',count:2});
   const resolve=rt.device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
   const read=rt.device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   for(const pose of [{name:'spawn',x:0,z:0,fly:false},{name:'aerial',x:80,z:-40,fly:true},{name:'cache-rebuild',x:0,z:0,fly:false,rebuild:true}]) {
    await tick({dt:0,reset:1,spawnX:pose.x,spawnZ:pose.z});
    if(pose.fly){await tick({dt:0,toggleFly:1});for(let i=0;i<60;i++)await tick({dt:1/30,rise:1,sprint:1},false);await tick({dt:0,rise:0,lookY:200});}
    for(const [w,h,exact] of [[1024,720,0],[1920,1080,0],[1920,1080,1]]){
      const image=rt.createBuffer(w*h*4);const call=ren.bind({pixels:image,heights,state,...damage},{width:w,height:h,seed:271828,viewDistance:160,exact});
      const simCall=sim.bind({state,...damage},{...input,dt:0,reset:Number(!!pose.rebuild),rise:0,lookY:0,toggleFly:0});const genCall=gen.bind({heights,state},{seed:271828});const samples=[];
      for(let i=0;i<35;i++){
        const b=rt.batch({timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});
        b.dispatch(simCall,[1,1,1]).dispatch(genCall,[517,1,1]).dispatch(call,[Math.ceil(w/8),Math.ceil(h/8),1]);b.endPass();
        b.encoder.resolveQuerySet(qs,0,2,resolve,0);b.encoder.copyBufferToBuffer(resolve,0,read,0,16);b.submit();
        await read.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(read.getMappedRange());const ms=Number(t[1]-t[0])/1e6;read.unmap();if(i>=5)samples.push(ms);
      }
      samples.sort((a,b)=>a-b);report.benchmarks.push({scene:pose.name,width:w,height:h,exact,medianMs:samples[15],p95Ms:samples[28],samples:30});rt.destroyBuffer(image);
    }
   }
   qs.destroy();resolve.destroy();read.destroy();
 }
 report.heightSamples=[a[0],a[112*257+112],a[66048]];
 await rt.idle();check(report.errors.length===0,'No WebGPU validation or device errors');
}
main().catch(e=>report.errors.push(String(e.stack||e))).finally(()=>{window.__report=report;document.getElementById('result').textContent=JSON.stringify(report,null,2);});

