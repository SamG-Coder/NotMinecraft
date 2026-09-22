# NotMinecraft

[Play on GitHub Pages](https://samg-coder.github.io/NotMinecraft/) · [Public repository](https://github.com/SamG-Coder/NotMinecraft) · [Build and deployment](https://github.com/SamG-Coder/NotMinecraft/actions/workflows/pages.yml)

A playable, Minecraft-inspired mining prototype with **1 cm voxels** and a full-size player. World generation, movement, collision, mining, atomic damage accumulation, seeded fracture, ray traversal, material shading, sky, water and pixel output are all authored in the same [`kernels/world.cu`](kernels/world.cu).

Built with [SamG-Coder/cuda-webshader](https://github.com/SamG-Coder/cuda-webshader), pinned as the `engine` Git submodule at `f0f3699b498cfe6fe5419e072a4f4e2faa63b781`. Its MIT license and third-party notices remain in that directory. The upstream compiler and runtime are unmodified.

## Run

From `D:\NotMinecraft`:

```powershell
npm start
```

Open **http://localhost:5173** in Edge or Chrome with WebGPU available. Press **Explore this world** to capture the mouse. The current workspace is already installed. A fresh recursive checkout needs:

```powershell
git submodule update --init --recursive
npm ci --prefix engine
npm start
```

Node 20+ is required. CUDA Toolkit is only needed for the optional native validation; the playable game runs through WebGPU. The host defaults to localhost. Use `PORT` to select another port.

## GitHub Actions and Pages

Pushes to `main` validate the host JavaScript, compile all CUDA entries, build the static `dist/` bundle, check its assets under a repository URL prefix, and deploy that bundle to Pages. Pull requests run the same build checks without publishing. The workflow checks out the pinned engine submodule recursively and pins its actions to commit SHAs.

The static bundle includes the app, authoritative CUDA source, required compiler/runtime modules, and upstream license notices. It excludes native binaries, test fixtures, local artifacts, Git metadata, and development dependencies. Relative asset URLs support both localhost and `/NotMinecraft/` on Pages.

CI performs compilation and packaging checks. NVIDIA hardware and interactive browser checks remain the local test suites described below; the hosted runner is not reported as an RTX GPU validation run. Pages requires a browser/device with working WebGPU. Browser-local mining saves do not transfer from localhost to the public site's origin.

## Controls

| Input | Action |
| --- | --- |
| W / A / S / D | Move |
| Mouse | Look |
| Space | Jump; ascend in flight |
| Shift | Sprint / fast flight |
| F | Toggle flight |
| Ctrl or C | Descend in flight |
| Esc | Release mouse and open settings |
| Hold left mouse | Mine within 6 m of the crosshair |

Choose a 32-bit unsigned seed. Under **Go to a location**, enter X and Z in metres and press **Regenerate at location**. The URL retains the seed and starting coordinates for sharing/revisiting a world; it does not continuously save the player's current position. The supported horizontal area is -8192 to +8192 metres on each axis, with movement clamped at those limits.

Mining uses a roughly 24 cm diameter tool footprint, with individual 1 cm voxels breaking in a seeded pattern. Sweep the crosshair to excavate a larger area. Holes narrower than the player's supported footprint will not make the player fall.

Edits survive movement, terrain-cache regeneration and same-seed teleports. They autosave to this browser's IndexedDB after 1.2 seconds without mining, or when opening the menu. Wait for **MINING SAVED LOCALLY** before closing the tab. Returning to a seed or reloading restores its damage. Saves are local to the browser profile and exact origin: `localhost` and `127.0.0.1`, different ports, and other browsers do not share them. The URL contains the seed/start location, not the mining save. A session-memory fallback preserves edits across seed switches if persistent storage fails; the HUD reports that fallback.

## Representation and performance

- **100× smaller on each edge.** A block is `0.01 × 0.01 × 0.01 m`: one millionth of a cubic metre. Player eye height is 1.75 m and walking speed is 4.3 m/s.
- **Deterministic world coordinates.** Integer hashes and smooth seeded noise determine terrain and trees. Negative coordinates use floor-based indexing. Revisiting a location does not depend on generation order.
- **Implicit base terrain with sparse removal.** A smooth heightfield defines the original solid ground, quantized to the centimetre voxel grid. Trees use solid volumes. A sparse destruction layer can remove arbitrary stored voxel bits from either, exposing subsurface dirt/stone and permitting excavation under the original surface. The base generator does not create natural caves.
- **GPU terrain cache.** 257 × 257 corner heights cover a moving 512 × 512 m region. The cache costs 264,196 bytes, regardless of how many implicit tiny blocks exist under the surface. It regenerates when the player enters a new 64 m region or changes world settings. Coordinates are rebased for rendering precision.
- **Empty-space skipping.** Rays traverse 2 m macro cells, use local height/slope bounds to skip air, then traverse centimetre cells near a surface. Tree volumes use analytic box intersections. No CPU-generated voxel meshes, per-block draw calls, or giant dense voxel buffers.
- **Exact detail is the default.** The optional faster mode uses 4 cm terrain detail beyond 24 m and 16 cm beyond 64 m in pristine worlds. Once edits exist, rendering stays at 1 cm so distant detail changes cannot fill holes back in. Subpixel material and face-lighting detail is filtered to suppress grid moiré; geometry remains unchanged.
- **GPU-resident simulation and pixels.** Six kernels run in order: `simulate`, `generate`, `prepareMining`, `accumulateMining`, `resolveMining`, `render`. `replayMining` is a seventh entry for integer event replay and tests. All seven are in `world.cu`. The CUDA output buffer is copied directly into the browser canvas texture. There is no handwritten WGSL game shader or JavaScript scene renderer.
- **Minimal browser host.** `app.js` handles input events, UI, resource allocation, dispatch, timestamps, presentation, and save I/O. It reads 68 bytes of HUD telemetry twice per second. At a save boundary between frames it also snapshots allocated damage pages; this is not part of rendering. It never reads pixels or terrain geometry to render the game.
- **Accumulated atomic damage.** Only edited 32 cm pages have logical damage state: 512 saturating integer counters on a 4 cm lattice, plus one removal bit for each of 32,768 centimetre voxels. World seed and voxel position determine immutable fracture thresholds. Same accepted integer events give the same final spatial state independent of processing order. See the [destruction design](docs/destruction.md).
- **Bounded damage memory.** The GPU reserves a 4096-page pool: 24 MiB for counters/masks plus about 96 KiB for keys and lookup. Saved data includes only allocated page prefixes plus the lookup table. Capacity exhaustion rejects a new stroke in full and reports it, preserving existing edits. The current version does not evict or stream damage pages out of that pool.
- **Bounded GPU queue.** At most one gameplay frame is queued. The canvas width is aligned for a single buffer-to-texture transfer; resolution is capped at 2560 × 1440.

Walking includes gravity, jumping, mined-terrain support and damage-aware tree collision. Collision remains a body-probe approximation, not an exhaustive capsule-to-voxel solver. Natural water areas still have a solid walkable surface at 15.2 m; excavations under dry land can extend below sea level without an invisible water floor. Floating tree remnants do not collapse. Placement, inventory, item drops, crafting, mobs, natural caves, swimming and multiplayer are not implemented.

## Mining performance

The mining build was measured on the **RTX 5080** in Edge headless WebGPU at **1920 × 1080**, exact 1 cm detail and 160 m view distance. These GPU timestamps include all six frame kernels. They exclude texture presentation/copy, host work, and local save pauses. Five warm-ups and 30 measured samples per case:

| Scene | Median GPU ms | p95 GPU ms |
| --- | ---: | ---: |
| Looking at unmodified ground | 0.413 | 0.477 |
| Same ground view, a real mining stroke every frame | 0.938 | 1.459 |
| Looking toward the horizon after mining | 2.345 | 2.711 |

The active test produced 35 strokes, 29 edited pages, and 33,699 removal bits (including bits in originally empty space). These are scene-specific GPU timings, not end-to-end FPS claims or worst-case guarantees for a full damage pool. The replay benchmark deliberately mines every measured frame; normal input is limited to approximately 10 strokes per second. Raw results: [`reports/mining-gpu-validation.json`](reports/mining-gpu-validation.json).

## Original exploration baseline

Measured on the local **NVIDIA GeForce RTX 5080**, using Edge headless WebGPU, seed 271828, 160 m view distance. Each case has five warm-up frames and 30 measured frames. GPU timestamps include simulation, generation dispatch and rendering; they exclude browser presentation, the final texture copy, and JavaScript. These numbers are not end-to-end FPS claims or a guarantee for every view/device.

| Scene | Resolution | Terrain detail | Median GPU ms | p95 GPU ms |
| --- | --- | --- | ---: | ---: |
| Spawn | 1024 × 720 | Distance LOD | 0.965 | 0.967 |
| Spawn | 1920 × 1080 | Exact 1 cm | 1.671 | 1.677 |
| Aerial | 1920 × 1080 | Exact 1 cm | 2.059 | 4.678 |
| Full cache rebuilt every frame | 1920 × 1080 | Exact 1 cm | 1.673 | 4.040 |

This table records the initial exploration build before mining. Timing tails include observed scheduling variation on the desktop. The live HUD separately shows browser FPS and measured GPU milliseconds.

## Validation

```powershell
npm run check          # Compile all seven CUDA entries to WGSL
npm test               # Hardware GPU correctness and benchmark cases
npm run test:ui        # Real browser input, pointer lock, settings, screenshots
npm run test:native    # Optional: compile and execute the same .cu with NVCC
npm test               # Also compares against the native files, if generated
npm run test:mining    # Atomic state, fracture, collision and mining benchmarks
npm run test:mining-ui # Real mining input, cache travel, per-seed save and reload
```

Browser tests use the installed Edge; set `TEST_BROWSER=chrome` for the GPU test if needed. Native validation needs NVIDIA hardware, CUDA Toolkit and Visual Studio C++ build tools. The native script's execution-policy override applies only to its PowerShell process.

**18 GPU checks and 10 browser UI checks passed.** Coverage includes repeatable seeds and frames, changed seeds, overlapping cache contents across positive/negative coordinates, distant rendering, walking, jumping, flight, tree collision, pointer lock, mouse input, Escape, seed/location changes and resizing.

Mining adds **15 GPU checks** and **8 browser mining/persistence checks**. The GPU suite compares 4,096 damage cells and 262,144 voxel decisions with an independent CPU reference, then compares integer counters and masks bit-for-bit with native CUDA. It tests reordered events, simultaneous atomic contention, saturation, monotonic removal, page-capacity handling and falling onto a surviving floor after excavation.

The native test compiles `tests/native.cu`, which includes the authoritative game source. All 66,049 height samples agree within 0.00005 m. The 320 × 200 exact-mode render has a mean RGB channel difference of 0.000224 / 255 versus native CUDA; one of 192,000 channels differs by more than 8. Same-device WebGPU repeat renders are bit-identical. Cross-backend floating-point rendering is tolerance-checked, not claimed bit-identical.

Generated native binaries, WGSL, screenshots and local reports go under ignored `artifacts/`. The checked-in `reports/` files record this validation run.

