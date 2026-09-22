#include <cstdio>
#include <cstdlib>
#include "../kernels/world.cu"
static void checked(cudaError_t e){if(e!=cudaSuccess){fprintf(stderr,"%s\n",cudaGetErrorString(e));exit(1);}}
int main(){
    float *state,*heights;unsigned int *pixels,*damageMap,*damageMask;int* damageKeys;
    checked(cudaMalloc(&state,544*sizeof(float)));checked(cudaMemset(state,0,544*sizeof(float)));
    checked(cudaMalloc(&damageMap,8192*4));checked(cudaMemset(damageMap,0,8192*4));
    checked(cudaMalloc(&damageKeys,4096*16));checked(cudaMalloc(&damageMask,4096*4096));
    checked(cudaMalloc(&heights,66049*sizeof(float)));checked(cudaMalloc(&pixels,320*200*sizeof(unsigned int)));
    simulate<<<1,1>>>(state,damageMap,damageKeys,damageMask,0,0,0,0,0,0,0,0,1,271828u,0,0);
    generate<<<517,128>>>(heights,state,271828u);
    render<<<dim3(40,25),dim3(8,8)>>>(pixels,heights,state,damageMap,damageKeys,damageMask,320,200,271828u,160,1);
    checked(cudaGetLastError());checked(cudaDeviceSynchronize());
    float* h=new float[66049];unsigned int* p=new unsigned int[320*200];
    checked(cudaMemcpy(h,heights,66049*sizeof(float),cudaMemcpyDeviceToHost));
    checked(cudaMemcpy(p,pixels,320*200*sizeof(unsigned int),cudaMemcpyDeviceToHost));
    FILE* f=fopen("artifacts/native-heights.bin","wb");if(!f)return 2;fwrite(h,sizeof(float),66049,f);fclose(f);
    f=fopen("artifacts/native-pixels.bin","wb");if(!f)return 2;fwrite(p,sizeof(unsigned int),320*200,f);fclose(f);
    printf("Native CUDA height samples: %.9f %.9f %.9f\n",h[0],h[112*257+112],h[66048]);
    unsigned int *stress,*meta;int* mining;
    checked(cudaMalloc(&stress,4096*2048));checked(cudaMemset(stress,0,4096*2048));
    checked(cudaMemset(damageMask,0,4096*4096));checked(cudaMalloc(&meta,16));checked(cudaMemset(meta,0,16));checked(cudaMalloc(&mining,2048));
    int events[4][5]={{-2,2700,1,12,96},{9,2692,-5,12,160},{-2,2700,1,12,96},{-12,2703,-7,16,200}};
    for(int i=0;i<4;i++){
        replayMining<<<1,1>>>(damageMap,damageKeys,meta,mining,events[i][0],events[i][1],events[i][2],events[i][3],events[i][4]);
        accumulateMining<<<108,128>>>(mining,damageKeys,stress);
        resolveMining<<<216,128>>>(mining,damageKeys,stress,damageMask,meta,271828u);
    }
    checked(cudaGetLastError());checked(cudaDeviceSynchronize());unsigned int m[4];checked(cudaMemcpy(m,meta,16,cudaMemcpyDeviceToHost));
    int* k=new int[m[0]*4];unsigned int* s=new unsigned int[m[0]*512];unsigned int* mask=new unsigned int[m[0]*1024];
    checked(cudaMemcpy(k,damageKeys,m[0]*16,cudaMemcpyDeviceToHost));checked(cudaMemcpy(s,stress,m[0]*2048,cudaMemcpyDeviceToHost));checked(cudaMemcpy(mask,damageMask,m[0]*4096,cudaMemcpyDeviceToHost));
    f=fopen("artifacts/native-mining-keys.bin","wb");if(!f)return 2;fwrite(k,16,m[0],f);fclose(f);
    f=fopen("artifacts/native-mining-stress.bin","wb");if(!f)return 2;fwrite(s,2048,m[0],f);fclose(f);
    f=fopen("artifacts/native-mining-mask.bin","wb");if(!f)return 2;fwrite(mask,4096,m[0],f);fclose(f);
    printf("Native CUDA mining: %u pages, %u removal bits, %u strokes\n",m[0],m[2],m[3]);
    checked(cudaMemset(state,0,544*sizeof(float)));checked(cudaMemset(damageMap,0,8192*4));checked(cudaMemset(damageMask,0,4096*4096));checked(cudaMemset(stress,0,4096*2048));checked(cudaMemset(meta,0,16));
    simulate<<<1,1>>>(state,damageMap,damageKeys,damageMask,0,0,0,0,0,0,0,0,1,271828u,0,0);generate<<<517,128>>>(heights,state,271828u);
    float ts[544];checked(cudaMemcpy(ts,state,sizeof(ts),cudaMemcpyDeviceToHost));ts[30]=4;ts[31]=4;
    float charges[4][8]={{.001f,0,60,0,0,0,0,1},{2,1.2f,60,0,0,0,0,1},{2,3.5f,60,0,0,0,0,1},{2,5,60,0,0,0,0,1}};
    for(int i=0;i<4;i++)for(int j=0;j<8;j++)ts[32+i*8+j]=charges[i][j];checked(cudaMemcpy(state,ts,sizeof(ts),cudaMemcpyHostToDevice));
    prepareMining<<<1,1>>>(state,heights,damageMap,damageKeys,damageMask,meta,mining,1.0f/120.0f,0,271828u);
    accumulateMining<<<108,128>>>(mining,damageKeys,stress);resolveMining<<<216,128>>>(mining,damageKeys,stress,damageMask,meta,271828u);
    checked(cudaGetLastError());checked(cudaDeviceSynchronize());checked(cudaMemcpy(ts,state,sizeof(ts),cudaMemcpyDeviceToHost));
    f=fopen("artifacts/native-tnt-state.bin","wb");if(!f)return 2;fwrite(ts,sizeof(float),544,f);fclose(f);
    printf("Native CUDA TNT: %.0f remaining, near impulse %.6f, far impulse %.6f\n",ts[31],ts[44],ts[52]);
    delete[] k;delete[] s;delete[] mask;cudaFree(stress);cudaFree(meta);cudaFree(mining);
    delete[] h;delete[] p;cudaFree(state);cudaFree(heights);cudaFree(pixels);cudaFree(damageMap);cudaFree(damageKeys);cudaFree(damageMask);return 0;
}
