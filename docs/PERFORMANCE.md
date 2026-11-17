# Performance

## Targets (low-end baseline: 4-core laptop, integrated GPU, 4 GB RAM)

| Metric | Target | How we measure |
| --- | --- | --- |
| Main-thread work per frame (3D Low) | < 8 ms | `frameMs` in the status bar, `e2e/perf.spec.ts` |
| Main-thread work per frame (2D) | < 4 ms | same |
| Frame rate (3D Low, integrated GPU) | ≥ 30 fps | manual on real hardware (pending) |
| Featured city ready (pack, 4× CPU throttle) | < 10 s | `e2e/perf.spec.ts` |
| Simulation tick (900 agents, 850 m area) | < 40 ms, off main thread | Node benchmark (worker) |
| Initial JS before the 3D engine | < 60 KB gz | `npm run build` output |

## Latest results (2026-11-17)

Headless Chromium, **software rendering (SwiftShader, no GPU)**, **4× CPU throttling**, Midtown Manhattan pack (1,772 buildings), Low quality:

| View | Ready | Main-thread ms/frame | fps (headless) | Agents |
| --- | --- | --- | --- | --- |
| 2D plan | 6.5 s | **0.7 ms** | 18 | 146 |
| 3D Low | 9.7 s | **1.8 ms** | 11 | 146 |
| 3D High | 14.1 s | **4.1 ms** | 12 | ~800 |

Accessibility metrics and the advisor use grid-based proximity lookups. Earlier O(homes × stops) scans caused 100+ ms spikes in dense cities.

Note: under software rendering, `frameMs` can also include GPU back-pressure. When the emulated GPU falls behind, `render()` blocks, so dense cities at High quality can show large values in headless runs. Low quality and the 2D view stay in the low single digits.

How to read this: our JavaScript per frame is tiny, even on a throttled CPU. The fps cap in headless runs comes from software rasterisation and compositing, not from the app. On a real integrated GPU, rendering cost is dominated by the GPU, and the scene uses only a few dozen draw calls thanks to merged and instanced geometry.

Simulation (Node, unthrottled): worst tick 37 ms for 900 agents in Shibuya at 850 m. It runs in a Web Worker, so it never blocks rendering. The simulation advances on wall-clock time, so a slow GPU doesn't slow the city.

Bundle: landing ~49 KB gz. The 3D engine (three.js ~125 KB gz) and workspace (~38 KB gz) are lazy-loaded. The worker is ~18 KB.

## Techniques in place
- Buildings, roads, areas and rails merged into a few meshes; agents, trees, signals and pillars instanced.
- Simulation in a Web Worker, sending compact Float32Array frames.
- Adaptive resolution in Auto mode: pixel ratio steps down below 28 fps, and shadows turn off before resolution drops further.
- 2D view caches its static map layer, so only moving agents redraw each frame.
- Window shader fades the facade grid with `fwidth`, so distant buildings don't shimmer.
- Featured cities ship as static packs; terrain and OSM responses are cached.

## Gaps
- Real-device measurements (old Windows laptop, iPad, Android phone) are not done yet.
- Time to ready is dominated by geometry build. Building geometry in a worker is a P2 optimisation.

Re-run with: `npx playwright test e2e/perf.spec.ts` (writes `test-results/perf.json`).
