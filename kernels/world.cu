// Authoritative game code. Metres throughout; the finest voxel is 0.01 m.
// Host code only transports input, dispatches these kernels and presents pixels.
// Destruction v1: 4096 sparse 32^3-voxel pages. Each page has 512 integer
// damage cells (4 cm edges) and 1024 removal words (one bit per 1 cm voxel).
// damageMap: 8192 linear-probed slots, zero empty, otherwise page + 1.
// damageKeys: int4 page coordinates. meta: pages, capacity flag, removed bits,
// accepted mining strokes. No page is reused before an explicit world reset.
__device__ unsigned int mixDamage(unsigned int h) {
    h^=h>>16;h*=2146121005u;h^=h>>15;h*=2221713035u;return h^(h>>16);
}
__device__ unsigned int damageHash(int x,int y,int z) {
    return mixDamage(((unsigned int)x)*73856093u ^ ((unsigned int)y)*19349663u ^ ((unsigned int)z)*83492791u);
}
__device__ int floorDiv32(int x) {int q=x/32;if(x<0 && x%32!=0)q--;return q;}
__device__ int findDamage(int x,int y,int z,const unsigned int* damageMap,const int* damageKeys) {
    unsigned int slot=damageHash(x,y,z)&8191u;
    for(int probe=0;probe<8192;probe++) {
        unsigned int value=damageMap[slot];if(value==0u)return -1;
        int p=int(value)-1;
        if(damageKeys[p*4]==x && damageKeys[p*4+1]==y && damageKeys[p*4+2]==z)return p;
        slot=(slot+1u)&8191u;
    }
    return -1;
}
__device__ int removedVoxel(int x,int y,int z,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    int bx=floorDiv32(x);int by=floorDiv32(y);int bz=floorDiv32(z);
    int page=findDamage(bx,by,bz,damageMap,damageKeys);if(page<0)return 0;
    int i=(x-bx*32)+(y-by*32)*32+(z-bz*32)*1024;
    return int((damageMask[page*1024+i/32]>>(i%32))&1u);
}
__device__ unsigned int fractureStrength(int x,int y,int z,unsigned int seed) {
    // Shared 2 cm grains plus fine voxel variation, fixed in world space.
    int gx=int(floorf(float(x)*0.5f));int gy=int(floorf(float(y)*0.5f));int gz=int(floorf(float(z)*0.5f));
    return 80u+(mixDamage(damageHash(gx,gy,gz)^seed)&63u)+(mixDamage(damageHash(x,y,z)^(seed*1664525u))&31u);
}
__device__ void addDamage(unsigned int* stress,int index,unsigned int amount) {
    // Saturation is associative for nonnegative integer contributions; CAS
    // prevents overflow and lost updates even when many events share a cell.
    unsigned int old=atomicAdd(&stress[index],0u);
    while(old<65535u) {
        unsigned int next=old+amount;if(amount>65535u-old)next=65535u;
        unsigned int observed=atomicCAS(&stress[index],old,next);
        if(observed==old)return;old=observed;
    }
}
__device__ unsigned int hash(unsigned int x) {
    x ^= x >> 16; x *= 2146121005u; x ^= x >> 15; x *= 2221713035u; return x ^ (x >> 16);
}
__device__ float randomAt(int x, int z, unsigned int seed) {
    return float(hash(((unsigned int)x) * 374761393u ^ ((unsigned int)z) * 668265263u ^ seed) & 65535u) / 65535.0f;
}
__device__ float noise(float x, float z, unsigned int seed) {
    int ix = int(floorf(x)); int iz = int(floorf(z));
    float u = x - floorf(x); float v = z - floorf(z);
    u = u*u*(3.0f-2.0f*u); v = v*v*(3.0f-2.0f*v);
    float a = randomAt(ix,iz,seed); float b = randomAt(ix+1,iz,seed);
    float c = randomAt(ix,iz+1,seed); float d = randomAt(ix+1,iz+1,seed);
    return (a+(b-a)*u)*(1.0f-v)+(c+(d-c)*u)*v;
}
__device__ float elevation(float x, float z, unsigned int seed) {
    return 3.0f + 30.0f*noise(x*0.009f,z*0.009f,seed)
        + 10.0f*noise(x*0.027f,z*0.027f,seed+11u)
        + 2.8f*noise(x*0.085f,z*0.085f,seed+29u)
        + 0.65f*noise(x*0.23f,z*0.23f,seed+91u);
}
__device__ float ground(float x,float z,unsigned int seed) {
    float gx=floorf(x*0.5f)*2.0f; float gz=floorf(z*0.5f)*2.0f;
    float u=(x-gx)*0.5f; float v=(z-gz)*0.5f;
    float a=elevation(gx,gz,seed); float b=elevation(gx+2.0f,gz,seed);
    float c=elevation(gx,gz+2.0f,seed); float d=elevation(gx+2.0f,gz+2.0f,seed);
    return floorf(((a+(b-a)*u)*(1.0f-v)+(c+(d-c)*u)*v)*100.0f)*0.01f;
}
// Each crown stays within its 8 m site, including the player's collision radius.
// Shared bounds make the visible wood/leaves exactly the volumes mining picks.
__device__ float4 treeSite(int tx,int tz,unsigned int seed) {
    float height=0.0f;int species=int(randomAt(tx,tz,seed+709u)*2.999f);
    if(randomAt(tx,tz,seed+701u)>0.52f)height=3.6f+randomAt(tx,tz,seed+719u)*1.8f+(species==1?1.0f:0.0f);
    return make_float4(float(tx)*8.0f+4.0f+floorf((randomAt(tx,tz,seed+727u)-0.5f)*140.0f)*0.01f,
        float(tz)*8.0f+4.0f+floorf((randomAt(tx,tz,seed+733u)-0.5f)*140.0f)*0.01f,height,float(species));
}
__device__ void treeBounds(float4 tree,int species,int part,float3& lo,float3& hi) {
    float x=0.0f;float z=0.0f;float y=tree.w;float rx=0.22f;float rz=rx;float ry=0.22f;
    if(part==0){rx=species==1?0.16f:0.24f;rz=rx;y=tree.w*0.5f-0.2f;ry=tree.w*0.5f+0.6f;}
    if(part==1){x=0.42f;y=tree.w-0.65f;rx=0.68f;rz=0.13f;ry=0.14f;}
    if(part==2){z=-0.4f;y=tree.w-0.3f;rx=0.13f;rz=0.62f;ry=0.13f;}
    if(part>=3){
        if(species==2){float layer=float(part-3);y=tree.w-1.65f+layer*0.42f;rx=1.9f-layer*0.18f;rz=rx;ry=0.32f;}
        else {
            float scale=species==1?0.72f:1.0f;rx=1.18f*scale;rz=1.14f*scale;ry=species==1?1.02f:0.85f;
            if(part>=4 && part<=11){int l=part-4;x=((l%2)==0?-0.92f:0.92f)*scale;z=((l/2)%2==0?-0.86f:0.86f)*scale;y+=l<4?-0.4f:0.65f;rx=(0.88f+float(l%3)*0.1f)*scale;rz=(0.91f+float((l+1)%3)*0.07f)*scale;ry=0.7f+float(l%2)*0.17f;}
            if(part==12){x=0.12f;z=-0.18f;y+=1.4f;rx=0.85f*scale;rz=0.82f*scale;ry=0.5f;}
        }
    }
    lo=make_float3(floorf((tree.x+x-rx)*100.0f)*0.01f,floorf((tree.y+y-ry)*100.0f)*0.01f,floorf((tree.z+z-rz)*100.0f)*0.01f);
    hi=make_float3(floorf((tree.x+x+rx)*100.0f)*0.01f,floorf((tree.y+y+ry)*100.0f)*0.01f,floorf((tree.z+z+rz)*100.0f)*0.01f);
}
__device__ float minedFloor(float x,float z,float feet,unsigned int seed,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    float h=ground(x,z,seed);int vx=int(floorf(x*100.0f));int vz=int(floorf(z*100.0f));
    int top=int(floorf(fminf(h,feet+0.5f)*100.0f));
    for(int step=0;step<512;step++) {
        if(removedVoxel(vx,top-1,vz,damageMap,damageKeys,damageMask)==0)return float(top)*0.01f;
        top--;
    }
    return -10000.0f; // No support in this window: allow gravity, never invent a floor.
}
__device__ float supportedFloor(float x,float z,float feet,unsigned int seed,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    float h=minedFloor(x,z,feet,seed,damageMap,damageKeys,damageMask);
    h=fmaxf(h,minedFloor(x-0.22f,z,feet,seed,damageMap,damageKeys,damageMask));
    h=fmaxf(h,minedFloor(x+0.22f,z,feet,seed,damageMap,damageKeys,damageMask));
    h=fmaxf(h,minedFloor(x,z-0.22f,feet,seed,damageMap,damageKeys,damageMask));
    return fmaxf(h,minedFloor(x,z+0.22f,feet,seed,damageMap,damageKeys,damageMask));
}
__device__ int terrainBodyBlocked(float x,float eye,float z,unsigned int seed,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    int vx=int(floorf(x*100.0f));int vz=int(floorf(z*100.0f));float h=ground(x,z,seed);
    for(int i=0;i<3;i++) {float y=eye-1.1f+float(i)*0.5f;if(y<h && removedVoxel(vx,int(floorf(y*100.0f)),vz,damageMap,damageKeys,damageMask)==0)return 1;}
    return 0;
}
__device__ int remainingTreeBox(float x,float eye,float z,float3 lo,float3 hi,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    float lx=fmaxf(x-0.3f,lo.x);float hx=fminf(x+0.3f,hi.x);
    float ly=fmaxf(eye-1.75f,lo.y);float hy=fminf(eye,hi.y);
    float lz=fmaxf(z-0.3f,lo.z);float hz=fminf(z+0.3f,hi.z);
    if(lx>=hx || ly>=hy || lz>=hz)return 0;
    // Collision is a body-probe approximation, as in the original controller.
    for(int iz=0;iz<3;iz++)for(int iy=0;iy<4;iy++)for(int ix=0;ix<3;ix++) {
        int vx=int(floorf((lx+(hx-lx)*(float(ix)+0.5f)/3.0f)*100.0f));
        int vy=int(floorf((ly+(hy-ly)*(float(iy)+0.5f)/4.0f)*100.0f));
        int vz=int(floorf((lz+(hz-lz)*(float(iz)+0.5f)/3.0f)*100.0f));
        if(removedVoxel(vx,vy,vz,damageMap,damageKeys,damageMask)==0)return 1;
    }
    return 0;
}
__device__ int solidTree(float x,float y,float z,unsigned int seed,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask,int damaged) {
    float4 site=treeSite(int(floorf(x/8.0f)),int(floorf(z/8.0f)),seed);
    if(site.z==0.0f || fabsf(x-site.x)>2.6f || fabsf(z-site.y)>2.6f)return 0;
    float base=ground(site.x,site.y,seed);if(base<=17.0f || base>=34.0f)return 0;
    float4 tree=make_float4(site.x,base,site.y,site.z);
    for(int part=0;part<13;part++){
        float3 lo;float3 hi;treeBounds(tree,int(site.w),part,lo,hi);
        if(x+0.3f>lo.x && x-0.3f<hi.x && z+0.3f>lo.z && z-0.3f<hi.z && y>lo.y && y-1.75f<hi.y)
            if(damaged==0 || remainingTreeBox(x,y,z,lo,hi,damageMap,damageKeys,damageMask)!=0)return 1;
    }
    return 0;
}
// TNT pool: state[30] high-water slot count, [31] live count. 64 slots at
// state[32 + slot*8]: fuse, xyz, velocity xyz, occupied. No per-frame CPU geometry.
__device__ float tntHalf() {return 0.5f;}
__device__ int tntBodyBlocked(float x,float eye,float z,const float* state) {
    for(int i=0;i<int(state[30]);i++){int q=32+i*8;
        if(state[q+7]>0.0f && fabsf(x-state[q+1])<0.3f+tntHalf() && fabsf(z-state[q+3])<0.3f+tntHalf() && eye>state[q+2]-tntHalf() && eye-1.75f<state[q+2]+tntHalf())return 1;
    }
    return 0;
}
// State: xyz, yaw, pitch, vertical velocity, flying, initialized,
// cache origin xz, cache dirty, grounded, distance travelled.
__global__ void simulate(float* state,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask, float dt, float forward, float strafe,
    float rise, float lookX, float lookY, int sprint, int toggleFly, int reset,
    unsigned int seed, float spawnX, float spawnZ) {
    if (threadIdx.x != 0 || blockIdx.x != 0) return;
    if (state[7] == 0.0f || reset != 0) {
        state[0]=spawnX; state[2]=spawnZ; state[1]=ground(spawnX,spawnZ,seed)+1.75f;
        state[3]=0.65f; state[4]=-0.12f; state[5]=0.0f; state[6]=0.0f;
        state[7]=1.0f; state[8]=999999.0f; state[9]=999999.0f; state[12]=0.0f;
    }
    if(toggleFly != 0) { state[6]=1.0f-state[6]; state[5]=0.0f; }
    state[3]+=lookX*0.002f; state[4]=fminf(1.5f,fmaxf(-1.5f,state[4]-lookY*0.002f));
    float speed=4.3f; if(sprint != 0) speed=8.6f; if(state[6]>0.5f) speed*=3.0f;
    float norm=fmaxf(1.0f,sqrtf(forward*forward+strafe*strafe));
    float dx=(sinf(state[3])*forward+cosf(state[3])*strafe)*speed*dt/norm;
    float dz=(cosf(state[3])*forward-sinf(state[3])*strafe)*speed*dt/norm;
    int damaged=int(state[17]>0.0f);
    float oldGround=ground(state[0],state[2],seed);
    float newGround=ground(state[0]+dx,state[2]+dz,seed);
    if(damaged!=0){oldGround=supportedFloor(state[0],state[2],state[1]-1.75f,seed,damageMap,damageKeys,damageMask);newGround=supportedFloor(state[0]+dx,state[2]+dz,state[1]-1.75f,seed,damageMap,damageKeys,damageMask);}
    int bodyBlocked=0;if(damaged!=0)bodyBlocked=terrainBodyBlocked(state[0]+dx,state[1],state[2]+dz,seed,damageMap,damageKeys,damageMask);
    if((state[6]>0.5f || newGround-oldGround<0.55f) && bodyBlocked==0 && tntBodyBlocked(state[0]+dx,state[1],state[2]+dz,state)==0 && solidTree(state[0]+dx,state[1],state[2]+dz,seed,damageMap,damageKeys,damageMask,damaged)==0) {state[0]+=dx;state[2]+=dz;state[12]+=sqrtf(dx*dx+dz*dz);}
    state[0]=fminf(8192.0f,fmaxf(-8192.0f,state[0]));state[2]=fminf(8192.0f,fmaxf(-8192.0f,state[2]));
    float baseHeight=ground(state[0],state[2],seed);float support=baseHeight;if(damaged!=0)support=supportedFloor(state[0],state[2],state[1]-1.75f,seed,damageMap,damageKeys,damageMask);
    // Water support belongs only to natural water columns. Excavating dry land
    // below sea level must not introduce an invisible global water floor.
    if(baseHeight<15.2f)support=fmaxf(support,15.2f);
    float floorY=support+1.75f;
    state[11]=0.0f;
    if(state[6]>0.5f) {float nextY=fmaxf(floorY,state[1]+rise*speed*dt);if(tntBodyBlocked(state[0],nextY,state[2],state)==0 && solidTree(state[0],nextY,state[2],seed,damageMap,damageKeys,damageMask,damaged)==0 && (damaged==0 || terrainBodyBlocked(state[0],nextY,state[2],seed,damageMap,damageKeys,damageMask)==0))state[1]=nextY;}
    else {
        if(state[1]<=floorY+0.015f) {state[1]=floorY;state[5]=0.0f;state[11]=1.0f;if(rise>0.0f)state[5]=6.2f;}
        state[5]-=18.0f*dt;float nextY=fmaxf(floorY,state[1]+state[5]*dt);
        if(tntBodyBlocked(state[0],nextY,state[2],state)==0 && solidTree(state[0],nextY,state[2],seed,damageMap,damageKeys,damageMask,damaged)==0 && (damaged==0 || terrainBodyBlocked(state[0],nextY,state[2],seed,damageMap,damageKeys,damageMask)==0))state[1]=nextY;else state[5]=0.0f;
    }
    float ox=floorf(state[0]/64.0f)*64.0f-224.0f;
    float oz=floorf(state[2]/64.0f)*64.0f-224.0f;
    state[10]=0.0f;
    if(ox!=state[8] || oz!=state[9] || reset!=0) {state[8]=ox;state[9]=oz;state[10]=1.0f;}
}
// 257 squared corner heights cover 512 m. Stable world-space coordinates,
// never cache-relative noise: adjacent tiles and revisited locations agree.
__global__ void generate(float* heights,const float* state,unsigned int seed) {
    int i=int(blockIdx.x*blockDim.x+threadIdx.x);
    if(i>=66049 || state[10]<0.5f)return;
    heights[i]=elevation(state[8]+float(i%257)*2.0f,state[9]+float(i/257)*2.0f,seed);
}
__device__ float bilinear(float4 h,float u,float v) {
    return (h.x+(h.y-h.x)*u)*(1.0f-v)+(h.z+(h.w-h.z)*u)*v;
}
// Return a tree in cache-local coordinates. Site IDs stay in world space.
__device__ float4 cachedTree(float4 site,const float* heights,const float* state) {
    float x=site.x-state[8];float z=site.y-state[9];int cx=int(floorf(x*0.5f));int cz=int(floorf(z*0.5f));
    if(site.z==0.0f || cx<0 || cz<0 || cx>=256 || cz>=256)return make_float4(0.0f,0.0f,0.0f,0.0f);
    int i=cz*257+cx;float4 h=make_float4(heights[i],heights[i+1],heights[i+257],heights[i+258]);
    float base=floorf(bilinear(h,x*0.5f-float(cx),z*0.5f-float(cz))*100.0f)*0.01f;
    return make_float4(x,base,z,(base>17.0f && base<34.0f)?site.z:0.0f);
}
// Axis aligned box hit, used for the solid voxel tree volumes.
__device__ float boxHit(float3 o,float3 inv,float3 lo,float3 hi) {
    float ax=(lo.x-o.x)*inv.x;float bx=(hi.x-o.x)*inv.x;
    float ay=(lo.y-o.y)*inv.y;float by=(hi.y-o.y)*inv.y;
    float az=(lo.z-o.z)*inv.z;float bz=(hi.z-o.z)*inv.z;
    float enter=fmaxf(fminf(ax,bx),fmaxf(fminf(ay,by),fminf(az,bz)));
    float leave=fminf(fmaxf(ax,bx),fminf(fmaxf(ay,by),fmaxf(az,bz)));
    if(leave>=fmaxf(enter,0.0f))return fmaxf(enter,0.0f);
    return 10000.0f;
}
// Centimetre-built bundle: 16 separate sticks, stepped tops, band, and fuse.
// Local coordinates are integer 1 cm cells inside a 1 m casing.
__device__ int tntVoxel(int x,int y,int z) {
    if(x<0||x>=100||z<0||z>=100||y<0||y>=114)return 0;
    if(y>=98){if(x>=47&&x<=52&&z>=47&&z<=52)return y>=110?4:3;return 0;}
    if(y>=38&&y<61)return 2;
    int a=x%25;int b=z%25;int top=94+((x/25+z/25)%2)*4;
    if(a>=2&&a<=22&&b>=2&&b<=22&&y<top)return 1;
    return 0;
}
__device__ int tntLetter(int x,int y) {
    // Three 5x5 glyphs, enlarged to 2 cm pixels across the paper band.
    if(x<33||x>=67||y<44||y>=54)return 0;
    int col=(x-33)/2;int row=(53-y)/2;int glyph=col/6;int c=col%6;
    if(c>=5)return 0;if(glyph==1)return c==0||c==4||c==row;
    return row==0||c==2;
}
__device__ float4 tntShapeHit(float3 o,float3 d,float3 inv,float3 center) {
    float3 lo=make_float3(center.x-0.5f,center.y-0.5f,center.z-0.5f);
    float3 hi=make_float3(center.x+0.5f,center.y+0.64f,center.z+0.5f);
    float t=boxHit(o,inv,lo,hi);if(t>=10000.0f)return make_float4(t,0.0f,0.0f,0.0f);
    float leave=fminf(fmaxf((lo.x-o.x)*inv.x,(hi.x-o.x)*inv.x),fminf(fmaxf((lo.y-o.y)*inv.y,(hi.y-o.y)*inv.y),fmaxf((lo.z-o.z)*inv.z,(hi.z-o.z)*inv.z)));
    float shade=0.8f;t+=0.0001f;
    for(int step=0;step<350;step++){
        if(t>leave)break;
        int x=int(floorf((o.x+d.x*t-lo.x)*100.0f));int y=int(floorf((o.y+d.y*t-lo.y)*100.0f));int z=int(floorf((o.z+d.z*t-lo.z)*100.0f));
        int part=tntVoxel(x,y,z);
        if(part!=0){if(part==2 && (x<=1||x>=98||z<=1||z>=98)){int u=(x<=1||x>=98)?z:x;if(tntLetter(u,y)!=0)part=3;}return make_float4(t,float(part),shade,0.0f);}
        float nx=(lo.x+float(x+(d.x>0.0f?1:0))*0.01f-o.x)*inv.x;
        float ny=(lo.y+float(y+(d.y>0.0f?1:0))*0.01f-o.y)*inv.y;
        float nz=(lo.z+float(z+(d.z>0.0f?1:0))*0.01f-o.z)*inv.z;
        float next=fminf(nx,fminf(ny,nz));shade=next==ny?1.0f:(next==nx?0.65f:0.82f);t=fmaxf(t+0.0001f,next+0.0001f);
    }
    return make_float4(10000.0f,0.0f,0.0f,0.0f);
}
__device__ float minedBoxHit(float3 o,float3 d,float3 inv,float3 lo,float3 hi,const float* state,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    float t=boxHit(o,inv,lo,hi);if(t>=10000.0f || state[17]==0.0f)return t;
    float leave=fminf(fmaxf((lo.x-o.x)*inv.x,(hi.x-o.x)*inv.x),fminf(fmaxf((lo.y-o.y)*inv.y,(hi.y-o.y)*inv.y),fmaxf((lo.z-o.z)*inv.z,(hi.z-o.z)*inv.z)));
    t+=0.00015f;
    for(int step=0;step<1024;step++) {
        if(t>leave)return 10000.0f;
        float x=o.x+d.x*t;float y=o.y+d.y*t;float z=o.z+d.z*t;
        int vx=int(floorf(x*100.0f));int vy=int(floorf(y*100.0f));int vz=int(floorf(z*100.0f));
        if(removedVoxel(vx+int(state[8]*100.0f),vy,vz+int(state[9]*100.0f),damageMap,damageKeys,damageMask)==0)return t;
        float nx=(float(vx+(d.x>0.0f?1:0))*0.01f-o.x)*inv.x;
        float ny=(float(vy+(d.y>0.0f?1:0))*0.01f-o.y)*inv.y;
        float nz=(float(vz+(d.z>0.0f?1:0))*0.01f-o.z)*inv.z;
        t=fmaxf(t+0.00015f,fminf(nx,fminf(ny,nz))+0.00015f);
    }
    return 10000.0f;
}
__global__ void render(unsigned int* pixels,const float* heights,const float* state,
    const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask,
    int width,int height,unsigned int seed,float viewDistance,int exact) {
    int px=int(blockIdx.x*blockDim.x+threadIdx.x);int py=int(blockIdx.y*blockDim.y+threadIdx.y);
    if(px>=width || py>=height)return;
    float sx=(2.0f*(float(px)+0.5f)/float(width)-1.0f)*float(width)/float(height)*0.66f;
    float sy=(1.0f-2.0f*(float(py)+0.5f)/float(height))*0.66f;
    float yaw=state[3];float pitch=state[4];
    // Local coordinates preserve centimetre traversal precision away from spawn.
    float3 o=make_float3(state[0]-state[8],state[1],state[2]-state[9]);
    float3 d=make_float3(sinf(yaw)*cosf(pitch)+sx*cosf(yaw)-sy*sinf(yaw)*sinf(pitch),
        sinf(pitch)+sy*cosf(pitch),cosf(yaw)*cosf(pitch)-sx*sinf(yaw)-sy*cosf(yaw)*sinf(pitch));
    float invLen=rsqrtf(d.x*d.x+d.y*d.y+d.z*d.z);d.x*=invLen;d.y*=invLen;d.z*=invLen;
    if(fabsf(d.x)<0.00001f)d.x=0.00001f;if(fabsf(d.y)<0.00001f)d.y=0.00001f;if(fabsf(d.z)<0.00001f)d.z=0.00001f;
    float3 inv=make_float3(1.0f/d.x,1.0f/d.y,1.0f/d.z);
    float sky=fmaxf(0.0f,d.y);float r=0.62f-0.32f*sky;float g=0.79f-0.27f*sky;float b=0.87f-0.14f*sky;
    float sun=fmaxf(0.0f,d.x*0.44f+d.y*0.79f+d.z*0.43f);
    float glow=powf(sun,320.0f);r+=glow*0.8f;g+=glow*0.65f;b+=glow*0.36f;
    float t=0.02f;float hit=10000.0f;int material=0;float shade=1.0f;float smoothShade=1.0f;float treeShade=1.0f;int lastTreeX=-99999;int lastTreeZ=-99999;
    for(int cell=0;cell<360;cell++) {
        if(t>viewDistance || t>=hit)break;
        float x=o.x+d.x*t;float z=o.z+d.z*t;
        int cx=int(floorf(x*0.5f));int cz=int(floorf(z*0.5f));
        if(cx<0 || cz<0 || cx>=256 || cz>=256)break;
        float gx=float(cx)*2.0f;float gz=float(cz)*2.0f;
        float tx=((gx+(d.x>0.0f?2.0f:0.0f))-o.x)*inv.x;
        float tz=((gz+(d.z>0.0f?2.0f:0.0f))-o.z)*inv.z;
        float end=fminf(tx,tz)+0.00015f;
        int i=cz*257+cx;float4 h=make_float4(heights[i],heights[i+1],heights[i+257],heights[i+258]);
        float top=fmaxf(fmaxf(h.x,h.y),fmaxf(h.z,h.w));
        // Only test each larger tree tile once as the ray traverses 2 m terrain cells.
        int treeX=int(floorf((x+state[8])/8.0f));int treeZ=int(floorf((z+state[9])/8.0f));
        if(treeX!=lastTreeX || treeZ!=lastTreeZ){
            lastTreeX=treeX;lastTreeZ=treeZ;
            float4 site=treeSite(treeX,treeZ,seed);float4 tree=cachedTree(site,heights,state);
            if(tree.w>0.0f){
                for(int part=0;part<13;part++){
                    float3 lo;float3 hi;treeBounds(tree,int(site.w),part,lo,hi);
                    float th=minedBoxHit(o,d,inv,lo,hi,state,damageMap,damageKeys,damageMask);
                    if(th<hit && th>=t-0.001f){
                        hit=th;material=part<3?(site.w==1.0f?8:4):(site.w==1.0f?10:(site.w==2.0f?9:3));
                        float hx=o.x+d.x*th;float hy=o.y+d.y*th;
                        shade=0.76f;if(fabsf(hx-lo.x)<0.002f || fabsf(hx-hi.x)<0.002f)shade=0.65f;
                        if(fabsf(hy-hi.y)<0.002f)shade=1.0f;if(fabsf(hy-lo.y)<0.002f)shade=0.48f;treeShade=shade;
                    }
                }
            }
        }
        float start=t;
        if(d.y<0.0f)start=fmaxf(start,(top+0.01f-o.y)*inv.y);
        float y0=o.y+d.y*start;float y1=o.y+d.y*end;
        if(fminf(y0,y1)<=top+0.01f && start<end) {
            // Conservative local slope bound skips air before exact voxel DDA.
            float slopeX=fmaxf(fabsf(h.y-h.x),fabsf(h.w-h.z))*0.5f;
            float slopeZ=fmaxf(fabsf(h.z-h.x),fabsf(h.w-h.y))*0.5f;
            float bound=fabsf(d.y)+slopeX*fabsf(d.x)+slopeZ*fabsf(d.z)+0.00001f;
            float q=start;
            for(int step=0;step<768;step++) {
                if(q>end || q>=hit)break;
                float vx=o.x+d.x*q;float vy=o.y+d.y*q;float vz=o.z+d.z*q;
                float size=0.01f;
                if(exact==0 && state[17]==0.0f) {if(q>24.0f)size=0.04f;if(q>64.0f)size=0.16f;}
                float bx=floorf(vx/size)*size;float bz=floorf(vz/size)*size;
                float surface=floorf(bilinear(h,(bx+size*0.5f-gx)*0.5f,(bz+size*0.5f-gz)*0.5f)/size)*size;
                int removed=0;
                if(vy<surface && state[17]>0.0f)removed=removedVoxel(int(floorf(vx*100.0f))+int(state[8]*100.0f),int(floorf(vy*100.0f)),int(floorf(vz*100.0f))+int(state[9]*100.0f),damageMap,damageKeys,damageMask);
                if(vy<surface && removed==0) {
                    hit=q;material=1;if(surface<16.3f)material=2;if(surface>33.5f)material=5;
                    if(surface-vy>0.08f)material=7;if(surface-vy>2.0f)material=5;
                    float u=(vx-gx)*0.5f;float v=(vz-gz)*0.5f;
                    float hx=((h.y-h.x)*(1.0f-v)+(h.w-h.z)*v)*0.5f;
                    float hz=((h.z-h.x)*(1.0f-u)+(h.w-h.y)*u)*0.5f;
                    smoothShade=0.55f+0.45f*fmaxf(0.0f,(0.79f-hx*0.44f-hz*0.43f)*rsqrtf(1.0f+hx*hx+hz*hz));
                    break;
                }
                float gap=vy-bilinear(h,(vx-gx)*0.5f,(vz-gz)*0.5f);
                if(gap>size*(2.0f+slopeX+slopeZ)) {q+=fmaxf(0.001f,(gap-size*(1.0f+slopeX+slopeZ))/bound);}
                else {
                    float nx=((bx+(d.x>0.0f?size:0.0f))-o.x)*inv.x;
                    float nz=((bz+(d.z>0.0f?size:0.0f))-o.z)*inv.z;
                    float ny=((floorf(vy/size)*size+(d.y>0.0f?size:0.0f))-o.y)*inv.y;
                    float next=fminf(nx,fminf(nz,ny));
                    q=fmaxf(q+0.00002f,next+0.00002f);
                    shade=next==ny?1.0f:(next==nx?0.65f:0.8f);
                }
            }
        }
        t=fmaxf(t+0.00015f,end);
    }
    float water=(15.2f-o.y)*inv.y;
    if(water>0.0f && water<hit && water<viewDistance){
        float wx=o.x+d.x*water;float wz=o.z+d.z*water;int cx=int(floorf(wx*0.5f));int cz=int(floorf(wz*0.5f));
        if(cx>=0&&cx<256&&cz>=0&&cz<256){int i=cz*257+cx;float4 h=make_float4(heights[i],heights[i+1],heights[i+257],heights[i+258]);
            if(bilinear(h,wx*0.5f-float(cx),wz*0.5f-float(cz))<15.2f){hit=water;material=6;shade=1.0f;}}
    }
    float tntPart=0.0f;float tntFuse=0.0f;
    for(int ti=0;ti<int(state[30]);ti++){
        int q=32+ti*8;if(state[q+7]==0.0f)continue;
        float3 center=make_float3(state[q+1]-state[8],state[q+2],state[q+3]-state[9]);
        // Coarse box rejects almost all charges before centimetre model traversal.
        float coarse=boxHit(o,inv,make_float3(center.x-0.5f,center.y-0.5f,center.z-0.5f),make_float3(center.x+0.5f,center.y+0.64f,center.z+0.5f));
        if(coarse>=hit||coarse>viewDistance)continue;
        float4 th=tntShapeHit(o,d,inv,center);
        if(th.x<hit){hit=th.x;material=11;treeShade=th.z;tntPart=th.y;tntFuse=state[q];}
    }
    if(material!=0 && hit<viewDistance) {
        float wx=state[8]+o.x+d.x*hit;float wy=o.y+d.y*hit;float wz=state[9]+o.z+d.z*hit;
        if(material==3 || material==4 || material>=8)shade=treeShade;
        float grain=0.91f+0.13f*randomAt(int(floorf(wx*100.0f))+int(floorf(wy*100.0f))*31,int(floorf(wz*100.0f)),seed);
        // Filter subpixel material and face-lighting detail without enlarging
        // any geometry. This removes centimetre-grid moire at distance.
        float footprint=hit*1.32f/float(height);
        float filter=fminf(1.0f,fmaxf(0.0f,(footprint-0.005f)/0.025f));
        grain=grain*(1.0f-filter)+0.975f*filter;
        if(material==1 || material==2 || material==5)shade=shade*(1.0f-filter)+smoothShade*filter;
        float cr=0.31f;float cg=0.51f;float cb=0.16f;
        if(material==2){cr=0.72f;cg=0.67f;cb=0.45f;}
        if(material==3 || material==9 || material==10){cr=0.18f;cg=0.38f;cb=0.095f;if(material==9){cr=0.12f;cg=0.31f;cb=0.19f;}if(material==10){cr=0.36f;cg=0.5f;cb=0.13f;}float leafFilter=fminf(1.0f,footprint*4.0f);grain=(0.82f+0.22f*randomAt(int(floorf(wx*10.0f))+int(floorf(wy*10.0f))*13,int(floorf(wz*10.0f)),seed))*(1.0f-leafFilter)+0.93f*leafFilter;}
        if(material==4 || material==8){cr=0.34f;cg=0.23f;cb=0.13f;
            float bark=randomAt(int(floorf(wx*25.0f))+int(floorf(wy*2.0f))*17,int(floorf(wz*25.0f)),seed+811u);
            grain*=0.72f+0.36f*bark;
            if(material==8){cr=0.8f;cg=0.79f;cb=0.69f;float scar=randomAt(int(floorf(wx*4.0f))+int(floorf(wy*16.0f))*17,int(floorf(wz*4.0f)),seed+821u);grain=scar>0.78f?0.3f:0.96f;}
        }
        if(material==5){cr=0.49f;cg=0.5f;cb=0.46f;}
        if(material==11){cr=0.72f;cg=0.09f;cb=0.045f;grain=0.86f+0.14f*randomAt(int(floorf(wx*100.0f)),int(floorf(wz*100.0f))+int(floorf(wy*100.0f))*13,seed);
            if(tntPart==2.0f){cr=0.93f;cg=0.89f;cb=0.76f;}if(tntPart==3.0f){cr=0.08f;cg=0.065f;cb=0.04f;}
            if(tntPart==4.0f){cr=1.0f;cg=0.55f+0.3f*sinf(tntFuse*35.0f);cb=0.04f;shade=1.0f;}
            if(tntFuse<0.8f&&sinf(tntFuse*28.0f)>0.6f){cr=fminf(1.0f,cr+0.22f);cg+=0.18f;cb+=0.12f;}
        }
        if(material==7){cr=0.43f;cg=0.29f;cb=0.17f;}
        if(material==6){cr=0.14f;cg=0.43f;cb=0.49f;grain=1.0f;}
        float fog=1.0f-expf(-hit*hit*0.000055f);
        r=cr*grain*shade*(1.0f-fog)+r*fog;g=cg*grain*shade*(1.0f-fog)+g*fog;b=cb*grain*shade*(1.0f-fog)+b*fog;
    }
    unsigned int ri=(unsigned int)(fminf(255.0f,fmaxf(0.0f,r*255.0f)));
    unsigned int gi=(unsigned int)(fminf(255.0f,fmaxf(0.0f,g*255.0f)));
    unsigned int bi=(unsigned int)(fminf(255.0f,fmaxf(0.0f,b*255.0f)));
    pixels[py*width+px]=ri|(gi<<8)|(bi<<16)|4278190080u;
}

// Authoritative occupancy for GPU picking. Terrain uses exactly the renderer's
// cached corner heights and voxel-centre sampling; tree volumes share its bounds.
__device__ int pickSolid(int vx,int vy,int vz,const float* heights,const float* state,unsigned int seed,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    if(state[17]>0.0f && removedVoxel(vx,vy,vz,damageMap,damageKeys,damageMask)!=0)return 0;
    float x=(float(vx)+0.5f)*0.01f;float y=(float(vy)+0.5f)*0.01f;float z=(float(vz)+0.5f)*0.01f;
    int cx=int(floorf((x-state[8])*0.5f));int cz=int(floorf((z-state[9])*0.5f));if(cx<0||cx>=256||cz<0||cz>=256)return 0;
    float gx=state[8]+float(cx)*2.0f;float gz=state[9]+float(cz)*2.0f;int i=cz*257+cx;
    float4 h=make_float4(heights[i],heights[i+1],heights[i+257],heights[i+258]);
    float surface=floorf(bilinear(h,(x-gx)*0.5f,(z-gz)*0.5f)*100.0f)*0.01f;if(y<surface)return 1;
    float4 site=treeSite(int(floorf(x/8.0f)),int(floorf(z/8.0f)),seed);float4 tree=cachedTree(site,heights,state);
    if(tree.w==0.0f)return 0;x-=state[8];z-=state[9];
    for(int part=0;part<13;part++){
        float3 lo;float3 hi;treeBounds(tree,int(site.w),part,lo,hi);
        if(x>=lo.x&&x<hi.x&&z>=lo.z&&z<hi.z&&y>=lo.y&&y<hi.y)return 1;
    }
    return 0;
}
__device__ void reserveMining(int vx,int vy,int vz,int radius,int power,unsigned int* damageMap,int* damageKeys,unsigned int* damageMeta,int* mining) {
    int ax=floorDiv32(vx-radius);int ay=floorDiv32(vy-radius);int az=floorDiv32(vz-radius);
    int bx=floorDiv32(vx+radius);int by=floorDiv32(vy+radius);int bz=floorDiv32(vz+radius);
    int missing=0;
    for(int z=az;z<=bz;z++)for(int y=ay;y<=by;y++)for(int x=ax;x<=bx;x++)if(findDamage(x,y,z,damageMap,damageKeys)<0)missing++;
    if(damageMeta[0]+((unsigned int)missing)>4096u){damageMeta[1]=1u;return;}
    // Allocation is one writer in a separate dispatch. Consumers cannot observe
    // partially initialized keys. Atomics are used for the later damage merge.
    int count=0;
    for(int z=az;z<=bz;z++)for(int y=ay;y<=by;y++)for(int x=ax;x<=bx;x++) {
        int page=findDamage(x,y,z,damageMap,damageKeys);
        if(page<0){page=int(damageMeta[0]);damageMeta[0]=damageMeta[0]+1u;damageKeys[page*4]=x;damageKeys[page*4+1]=y;damageKeys[page*4+2]=z;
            unsigned int slot=damageHash(x,y,z)&8191u;while(damageMap[slot]!=0u)slot=(slot+1u)&8191u;damageMap[slot]=((unsigned int)page)+1u;}
        mining[8+count]=page;count++;
    }
    mining[0]=1;mining[1]=vx;mining[2]=vy;mining[3]=vz;mining[4]=radius;mining[5]=power;mining[6]=count;
    damageMeta[3]=damageMeta[3]+1u;
}
__device__ void tntStats(float* state) {
    int count=0;float nearest=10000.0f;int high=0;
    for(int i=0;i<int(state[30]);i++){int q=32+i*8;if(state[q+7]>0.0f){count++;high=i+1;nearest=fminf(nearest,state[q]);}}
    state[30]=float(high);state[31]=float(count);state[22]=count==0?0.0f:nearest;
}
__device__ int tntBoxBlocked(float x,float y,float z,int self,const float* heights,const float* state,unsigned int seed,const unsigned int* damageMap,const int* damageKeys,const unsigned int* damageMask) {
    for(int i=0;i<int(state[30]);i++){int q=32+i*8;if(i!=self&&state[q+7]>0.0f&&fabsf(x-state[q+1])<0.999f&&fabsf(y-state[q+2])<0.999f&&fabsf(z-state[q+3])<0.999f)return 1;}
    for(int iz=-1;iz<=1;iz++)for(int iy=-1;iy<=1;iy++)for(int ix=-1;ix<=1;ix++){
        float px=x+float(ix)*0.499f;float py=y+float(iy)*0.499f;float pz=z+float(iz)*0.499f;
        if(px<state[8]||px>=state[8]+512.0f||pz<state[9]||pz>=state[9]+512.0f){if(py<ground(px,pz,seed))return 1;}
        else if(pickSolid(int(floorf(px*100.0f)),int(floorf(py*100.0f)),int(floorf(pz*100.0f)),heights,state,seed,damageMap,damageKeys,damageMask)!=0)return 1;
    }
    return 0;
}
__device__ int advanceTnt(float* state,const float* heights,unsigned int* damageMap,int* damageKeys,const unsigned int* damageMask,unsigned int* damageMeta,int* mining,float dt,unsigned int seed) {
    if(dt<=0.0f||state[31]==0.0f)return 0;
    // Fixed 120 Hz motion. Slot order, fuse expiry and radial impulses are stable.
    state[26]+=fminf(dt,0.05f);float stepTime=1.0f/120.0f;
    for(int sub=0;sub<6;sub++){
        if(state[26]+0.000001f<stepTime)break;state[26]=fmaxf(0.0f,state[26]-stepTime);
        for(int i=0;i<int(state[30]);i++){
            int q=32+i*8;if(state[q+7]==0.0f)continue;state[q]=fmaxf(0.0f,state[q]-stepTime);
            state[q+5]-=18.0f*stepTime;
            for(int axis=0;axis<3;axis++){
                int c=axis==0?1:(axis==1?3:2);int v=c+3;state[q+v]=fminf(20.0f,fmaxf(-20.0f,state[q+v]));
                float delta=state[q+v]*stepTime;if(fabsf(delta)<0.000001f)continue;
                float old=state[q+c];state[q+c]=old+delta;
                if(tntBoxBlocked(state[q+1],state[q+2],state[q+3],i,heights,state,seed,damageMap,damageKeys,damageMask)!=0){
                    float low=0.0f;float high=1.0f;
                    for(int solve=0;solve<6;solve++){float mid=(low+high)*0.5f;state[q+c]=old+delta*mid;if(tntBoxBlocked(state[q+1],state[q+2],state[q+3],i,heights,state,seed,damageMap,damageKeys,damageMask)!=0)high=mid;else low=mid;}
                    state[q+c]=old+delta*low;
                    state[q+v]=fabsf(state[q+v])<1.0f?0.0f:-state[q+v]*0.18f;
                    if(c==2&&delta<0.0f){state[q+4]*=0.86f;state[q+6]*=0.86f;}
                }
            }
        }
    }
    // One terrain blast per frame bounds the expensive voxel work. Simultaneously
    // expired charges remain queued in their slots, rather than losing events.
    for(int i=0;i<int(state[30]);i++){
        int q=32+i*8;if(state[q+7]==0.0f||state[q]>0.0f)continue;
        float x=state[q+1];float y=state[q+2];float z=state[q+3];state[q+7]=0.0f;
        reserveMining(int(roundf(x*100.0f)),int(roundf(y*100.0f)),int(roundf(z*100.0f)),80,768,damageMap,damageKeys,damageMeta,mining);
        for(int j=0;j<int(state[30]);j++){
            int r=32+j*8;if(state[r+7]==0.0f)continue;
            float dx=state[r+1]-x;float dy=state[r+2]-y;float dz=state[r+3]-z;float dist=sqrtf(dx*dx+dy*dy+dz*dz);
            if(dist>=4.0f)continue;
            if(dist<0.001f){dx=(j%2==0?1.0f:-1.0f);dy=0.5f;dz=0.0f;dist=sqrtf(1.25f);}
            float falloff=1.0f-dist/4.0f;float kick=14.0f*falloff*falloff;
            state[r+4]+=dx/dist*kick;state[r+5]+=dy/dist*kick+3.0f*falloff;state[r+6]+=dz/dist*kick;
        }
        state[28]+=1.0f;state[17]=float(damageMeta[0]);tntStats(state);return 1;
    }
    tntStats(state);return 0;
}
__global__ void prepareMining(float* state,const float* heights,unsigned int* damageMap,int* damageKeys,const unsigned int* damageMask,unsigned int* damageMeta,int* mining,float dt,int pressed,unsigned int seed) {
    if(threadIdx.x!=0||blockIdx.x!=0)return;mining[0]=0;state[17]=float(damageMeta[0]);
    int emitted=advanceTnt(state,heights,damageMap,damageKeys,damageMask,damageMeta,mining,dt,seed);
    if(emitted!=0&&pressed!=2)return;
    int slot=-1;
    if(pressed==2){state[29]=0.0f;for(int i=0;i<64;i++){if(i>=int(state[30])||state[32+i*8+7]==0.0f){slot=i;break;}}if(slot<0){state[29]=2.0f;return;}}
    state[16]-=dt;if(pressed==0){state[16]=fmaxf(0.0f,state[16]);return;}if(state[16]>0.0f && pressed!=2)return;
    state[16]+=0.1f;state[18]=0.0f;
    int ox=int(floorf(state[0]*100.0f));int oy=int(floorf(state[1]*100.0f));int oz=int(floorf(state[2]*100.0f));
    float3 o=make_float3(state[0]*100.0f-float(ox),state[1]*100.0f-float(oy),state[2]*100.0f-float(oz));
    float3 d=make_float3(sinf(state[3])*cosf(state[4]),sinf(state[4]),cosf(state[3])*cosf(state[4]));
    if(fabsf(d.x)<0.00001f)d.x=0.00001f;if(fabsf(d.y)<0.00001f)d.y=0.00001f;if(fabsf(d.z)<0.00001f)d.z=0.00001f;
    float t=0.0f;
    for(int step=0;step<1800;step++) {
        if(t>600.0f)break;
        int x=int(floorf(o.x+d.x*t));int y=int(floorf(o.y+d.y*t));int z=int(floorf(o.z+d.z*t));
        if(pickSolid(ox+x,oy+y,oz+z,heights,state,seed,damageMap,damageKeys,damageMask)!=0){
            if(pressed==2){
                // A metre-wide voxel bundle needs clear space and cannot overlap
                // the player or another charge. Try above the hit, then towards it.
                float hitX=(float(ox)+o.x+d.x*t)*0.01f;float hitY=(float(oy)+o.y+d.y*t)*0.01f;float hitZ=(float(oz)+o.z+d.z*t)*0.01f;
                for(int attempt=0;attempt<28;attempt++){
                    float cx=hitX;float cy=hitY+0.51f+float(attempt)*0.025f;float cz=hitZ;
                    if(attempt>=12){float back=90.0f+float(attempt-12)*5.0f;if(t<back)continue;cx=(float(ox)+o.x+d.x*(t-back))*0.01f;cy=(float(oy)+o.y+d.y*(t-back))*0.01f;cz=(float(oz)+o.z+d.z*(t-back))*0.01f;}
                    cx=floorf(cx*100.0f)*0.01f;cy=floorf(cy*100.0f)*0.01f;cz=floorf(cz*100.0f)*0.01f;
                    int body=fabsf(cx-state[0])<0.8f&&fabsf(cz-state[2])<0.8f&&cy+0.5f>state[1]-1.75f&&cy-0.5f<state[1];
                    state[29]=body!=0?3.0f:4.0f;
                    if(body==0&&tntBoxBlocked(cx,cy,cz,-1,heights,state,seed,damageMap,damageKeys,damageMask)==0){
                        int q=32+slot*8;state[q]=3.0f;state[q+1]=cx;state[q+2]=cy;state[q+3]=cz;state[q+4]=0.0f;state[q+5]=0.0f;state[q+6]=0.0f;state[q+7]=1.0f;
                        state[23]=cx;state[24]=cy;state[25]=cz;state[30]=fmaxf(state[30],float(slot+1));state[29]=1.0f;tntStats(state);return;
                    }
                }
                return;
            }
            reserveMining(ox+x,oy+y,oz+z,12,96,damageMap,damageKeys,damageMeta,mining);
            state[17]=float(damageMeta[0]);state[18]=1.0f;state[19]=float(ox+x)*0.01f;state[20]=float(oy+y)*0.01f;state[21]=float(oz+z)*0.01f;return;}
        float nx=(float(x+(d.x>0.0f?1:0))-o.x)/d.x;
        float ny=(float(y+(d.y>0.0f?1:0))-o.y)/d.y;
        float nz=(float(z+(d.z>0.0f?1:0))-o.z)/d.z;
        t=fmaxf(t+0.0001f,fminf(nx,fminf(ny,nz))+0.0001f);
    }
}
__global__ void accumulateMining(const int* mining,const int* damageKeys,unsigned int* damageStress) {
    if(mining[0]==0)return;
    for(int lane=int(blockIdx.x*blockDim.x+threadIdx.x);lane<mining[6]*512;lane+=int(gridDim.x*blockDim.x)){
    int page=mining[8+lane/512];int cell=lane%512;
    int x=damageKeys[page*4]*32+(cell%8)*4+2-mining[1];
    int y=damageKeys[page*4+1]*32+((cell/8)%8)*4+2-mining[2];
    int z=damageKeys[page*4+2]*32+(cell/64)*4+2-mining[3];
    int r2=mining[4]*mining[4];int d2=x*x+y*y+z*z;if(d2>=r2)continue;
    unsigned int amount=(unsigned int)((r2-d2)*mining[5]/r2);if(amount!=0u)addDamage(damageStress,page*512+cell,amount);
    }
}
__global__ void resolveMining(const int* mining,const int* damageKeys,const unsigned int* damageStress,unsigned int* damageMask,unsigned int* damageMeta,unsigned int seed) {
    if(mining[0]==0)return;
    for(int lane=int(blockIdx.x*blockDim.x+threadIdx.x);lane<mining[6]*1024;lane+=int(gridDim.x*blockDim.x)){
    int page=mining[8+lane/1024];int word=lane%1024;int y=word%32;int z=word/32;
    unsigned int bits=damageMask[page*1024+word];unsigned int next=bits;
    for(int x=0;x<32;x++) {
        int cell=x/4+(y/4)*8+(z/4)*64;unsigned int stress=damageStress[page*512+cell];
        if(stress>=fractureStrength(damageKeys[page*4]*32+x,damageKeys[page*4+1]*32+y,damageKeys[page*4+2]*32+z,seed))next|=1u<<x;
    }
    damageMask[page*1024+word]=next;
    if(next!=bits)atomicAdd(&damageMeta[2],(unsigned int)__popc(next^bits));
    }
}
// Deterministic event injection for replay and correctness tests. Events are
// integer voxel positions and must be applied exactly once by the caller.
__global__ void replayMining(unsigned int* damageMap,int* damageKeys,unsigned int* damageMeta,int* mining,int x,int y,int z,int radius,int power) {
    if(threadIdx.x!=0||blockIdx.x!=0)return;mining[0]=0;
    if(radius<1||radius>24||power<1||power>65535)return;
    reserveMining(x,y,z,radius,power,damageMap,damageKeys,damageMeta,mining);
}
