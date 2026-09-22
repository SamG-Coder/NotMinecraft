# Seeded destruction from accumulated atomic state

The implemented model is **procedural base world + sparse accumulated damage + a derived removal mask**. All rules and GPU kernels are in `kernels/world.cu`. Browser code transports input, schedules dispatches, and stores/restores snapshots.

The seed cannot encode player choices by itself. A hole on the left and a hole on the right can have identical total damage. Spatial state must distinguish them. We retain compact, location-addressed counters instead of a health value for every 1 cm voxel in the world.

## State and deterministic rule

Each edited page covers 32 × 32 × 32 centimetre voxels. Its state is:

| Data | Shape | Bytes |
| --- | --- | ---: |
| Accumulated damage | 8 × 8 × 8 unsigned 32-bit counters | 2,048 |
| Removed voxels | 32 × 32 × 32 bits | 4,096 |
| Coordinate key | X/Y/Z page coordinates and padding | 16 |

The damage lattice has 4 cm spacing. A mining event is an integer centre in world voxel coordinates, an integer radius and integer power. For each affected damage-cell centre:

```text
contribution = floor(max(0, radius² - distance²) * power / radius²)
damage[cell] = min(65535, damage[cell] + contribution)

threshold[voxel] = seeded integer hash of world coordinate
removed[voxel] |= damage[cell containing voxel] >= threshold[voxel]
solid[voxel] = proceduralBaseSolid[voxel] && !removed[voxel]
```

The threshold is 80–174 units, combining a shared 2 cm grain with 1 cm variation. All 32 seed bits feed a mixing function before reducing the result. Thresholds do not change when another stroke is applied. The 4 cm damage field intentionally approximates force distribution; it does not mean the visible blocks become 4 cm. Voxel removal remains 1 cm. A nominal 12 cm tool radius can fracture to a damage-cell edge, slightly outside that nominal sphere.

Nonnegative integer accumulation with saturation is associative and commutative. With fixed thresholds, removal is monotonic. Thus **the same multiset of accepted integer events gives identical spatial counters and masks**, even when processing order changes. Raw page IDs need not match because allocation order can differ; tests compare pages by their full coordinate keys.

This guarantee concerns fixed events, not rearranging a sequence of mouse gestures. A later ray hit can move deeper because an earlier stroke already opened a hole. Replaying an event twice adds its damage twice. A future network/event-log layer must deduplicate event IDs before acceptance; atomics do not provide exactly-once delivery.

## GPU pipeline

1. `simulate` moves the player using the previous completed destruction state.
2. `generate` refreshes the procedural terrain cache if needed.
3. `prepareMining` traces the crosshair ray against current solid voxels, enforces a 6 m reach and approximately 10 Hz tool cadence, preflights page capacity, and allocates the affected pages.
4. `accumulateMining` adds integer radial contributions to those pages using a saturating `atomicCAS` loop.
5. `resolveMining` derives removal bits. One invocation owns each output word, so it can merge its bits without conflicting writes. The removal counter uses `atomicAdd`.
6. `render` traces the resulting occupancy. The controller observes the completed edit on its next simulation step.

`replayMining` accepts a quantized event directly for replay and tests. It uses the same allocation, accumulation and resolve path as the tool.

The single-writer allocation dispatch publishes complete page keys before consumers run. We do not spin on an atomic lock waiting for another workgroup to initialize a page. A future parallel allocator would need an explicit publication protocol or separate allocation/initialization passes.

The compiler supports 32-bit integer `atomicAdd` and `atomicCAS`. It does not currently expose `atomicOr`, so this implementation assigns each mask word one owner instead. Its CUDA CAS lowering retries WebGPU weak-CAS spurious failures. Both CUDA's legacy atomics and WGSL atomics use relaxed ordering; they are not a global barrier. Producer/consumer work is scheduled as separate ordered dispatches. See the [CUDA atomic reference](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/cpp-language-extensions.html) and [WGSL atomic specification](https://www.w3.org/TR/WGSL/#atomic-builtin-functions).

## Lookup, rendering and collision

An 8,192-slot linear-probed hash table maps complete signed page coordinates to a 4,096-page pool. Hash collisions are resolved by comparing all three coordinates, never by assuming the hash is unique. Floor division handles negative coordinates. Keys use absolute world coordinates and survive the terrain cache moving.

The original terrain height remains a conservative upper bound after removal: destruction cannot add material above it. The renderer retains air skipping above the terrain, then checks removal bits when a ray reaches a candidate solid voxel. It continues through removed voxels until it reaches surviving material. Tree-box intersections likewise continue past removed cells. Edits force exact detail so coarse terrain rendering cannot close a tiny hole.

The controller samples surviving support under the player's footprint and checks damage when testing tree/terrain body probes. It does not use the original top surface as an invisible floor after mining. The test suite excavates a wide pit and verifies a 0.5 m fall onto surviving ground. Collision is still approximate; thin remnants between body probes are a limitation of this controller.

## Memory, persistence and limits

The reserved GPU damage pool is 24 MiB plus about 96 KiB of keys/lookup. Allocated pages are sparse logical state; this prototype reserves the pool up front to avoid GPU allocation stalls while mining. A full pool covers 134.2 cubic metres of page volume, which includes untouched voxels inside allocated pages. It is not a promise that the user can remove that much solid material before reaching the limit.

Snapshots preserve counters as well as masks, so partially damaged material retains its accumulated state after reload. Saving waits until mining is idle or the menu opens, pauses frame submission, then reads a consistent snapshot. It serializes the allocated page prefixes to IndexedDB under the world seed. This readback is outside the render path, but save latency can still cause a visible pause for large saves. A session-memory copy provides a fallback on storage failure. Closing before the save indicator appears can lose the last unsaved strokes.

Capacity is checked before allocation. If a complete new stroke will not fit, it is rejected and the HUD reports the condition. Existing edits are never silently evicted. Unbounded mining would need a second stage: page persistence/eviction, a GPU residency map and asynchronous restore. That is not implemented or included in current performance claims.

The world seed, generation rules and destruction-rule version must stay associated with a save. The current snapshot format is version 1. Future threshold/generator changes need an explicit migration policy rather than silently reinterpreting old counters.

## Evidence

`npm run test:mining` verifies reordered overlap, independent CPU reconstruction, native CUDA equality, concurrent atomic contention, saturation, monotonicity, negative coordinates, full-pool rejection and excavated-floor collision. `npm run test:mining-ui` uses actual mouse input and verifies cache travel, seed switching, IndexedDB saving and page reload. Detailed outputs are in `reports/mining-gpu-validation.json` and `reports/mining-ui-validation.json`.

Measured on the RTX 5080 at 1080p, the six-kernel median was 0.938 ms while the benchmark applied a real mining stroke every frame, and 2.345 ms for a horizon view after mining. These samples exercise a small edited area, not a heavily fragmented full pool; they exclude browser presentation and save I/O.

