# HANDOFF: read this first

Last updated: 2026-11-20, at commit `0515d7e` on `main`, pushed and deployed.

**Ptah** is a browser-based 3D city-building and urban-planning simulator built on real-world geography.
- Live: https://minhnguyen3001.github.io/Ptah/
- Repo: https://github.com/minhnguyen3001/Ptah (public)
- The local folder is still named `~/vscode/Hephaestus`, from an earlier product name. That's harmless.

## New-session procedure
1. Read this file, then `TODO.md`, then `README.md`.
2. Run `git status` and `git log --oneline -15`. Check this file still matches the repo.
3. Run `npm install && npm test && npm run build`. Expect 45 unit tests passing.
4. Pick the top unchecked item in `TODO.md`. Don't redesign the architecture; the reasons behind it are in `docs/DECISIONS.md`.

## Owner rules (standing)
- **Zero cost.** Use only free data and services. No paid hosting, APIs or backends without explicit approval.
- **GitHub on autopilot.** Commit, push to `main` and deploy without asking. Never force-push or rewrite history.
- **Work autonomously** through TODO.md. If the usage limit hits, the next session resumes from this file.
- Label estimated data and synthetic agents honestly. Simulation results are never presented as forecasts.

## What works (all live)
- **Cities.**
  - Search anywhere (Nominatim) or pick one of 8 featured cities: Chicago Loop, Midtown Manhattan, District 1 Saigon, Amsterdam Centrum, Shibuya, Nob Hill SF, Central HK and City of London.
  - Featured cities load from static packs. Other places load live from free public Overpass, which is slow when busy.
- **Map size.**
  - The detail zone streams 1 km tiles around the camera, within a budget of 12/30/60 tiles for Low/Medium/High.
  - The city ring extends to a 10 km diameter (3/4/5 km radius by quality) using free OpenFreeMap vector tiles.
  - The "City" camera preset shows the whole area.
- **3D world.**
  - Terrain from AWS Terrarium tiles, decoded with colour management off and despiked.
  - Sea from coastlines, multipolygon water and parks, trees, and pitched roofs.
  - Glass towers, shopfronts and rooftop plant.
  - Sidewalks, street lights, crosswalks and bridge decks.
  - An underground x-ray view of subway and road tunnels.
  - Weather and day/night.
- **2D plan view.** Canvas2D with the same tools, used automatically without WebGL.
- **Planning.**
  - Buildings, roads (which form intersections), and a road editor for lanes, speed, one-way, bike lanes and pedestrian streets.
  - Zoning, bus and elevated metro lines, note pins and event crowds.
  - Scenarios with a comparison table, undo/redo, autosave (localStorage) and share links (`#plan=…`, no server).
- **Simulation** (Web Worker, wall-clock time).
  - Trips by origin and destination, with regional mode shares.
  - Lanes, signals (pedestrians obey them) and spill-back.
  - Emergency vehicles, taxi pickups, parking search, and weekday/weekend/holiday demand.
  - +5/10/20-year projections and weather effects.
  - Buses and user metros with riders and transfers, and **real OSM rail/subway lines that stop at mapped stations**.
- **Insight.** Before/after dashboard, access metrics, per-line ridership, traffic flow layer, rule-based advisor with fly-to, planning challenges and the interactive tour.

## Architecture map
| Area | Files |
| --- | --- |
| Types | `src/geo/types.ts` |
| OSM data | `src/geo/osm.ts`: Overpass queries (core/extras/stations/`all`), mirrors, pack and tile loading, `parseOverpass` (circle or bounds), `fetchTile`, `slimElements` |
| Tiles | `src/geo/tiles.ts` (`TileStream`, `mergeWorld`), `src/geo/vectortiles.ts` (city ring) |
| Terrain, polygons, trees | `src/geo/terrain.ts`, `src/geo/polygons.ts`, `src/geo/trees.ts` |
| Simulation | `src/sim/simulation.ts`, `graph.ts`, `region.ts`; worker plumbing in `worker.ts`, `protocol.ts`, `client.ts` |
| Scenario | `src/project/edits.ts` (Edit union, `applyEdits`, `connectRoad`), `zoning.ts`, `share.ts`, `store.ts` |
| 3D renderer | `src/render/engine.ts`. Key parts: chunked incremental scene (`syncChunks`, `layer`), time-sliced `work` queue (`runWork`), city ring (`setContext`), culling (`cullChunks`), picking (`pick`, `groundT`) |
| 2D renderer | `src/render/plan2d.ts` (cached static layer, viewport-culled ring) |
| Shared render code | `src/render/tools.ts` (ToolController), `geometry.ts` (models, facades via `aWall` style 1–4), `palette.ts`, `quality.ts` (presets: pixel ratio, shadows, agents, radius, tiles, ring) |
| UI | `src/ui/WorldView.tsx` (state owner), `Panels.tsx`, `Tour.tsx`, `advisor.ts`, `challenges.ts`, `metrics.ts`, `Landing.tsx`, `SearchBox.tsx` |
| Data | `public/packs/` (8 city centres, 23 MB), `public/tiles/<pack>/<i>_<j>.json` (64 surrounding tiles, 63 MB) |
| Scripts | `scripts/build-city-packs.ts`, `build-city-tiles.ts`, `profile-load.ts`, `profile-sim.ts`, `inspect-mvt.ts` |

How the pieces connect: React owns project, history and view state. It calls `renderer.setWorld(world, region)`, `setContext(ringTiles, detailZone)` and `setSimParams(...)`. Renderers report back through `EngineCallbacks`. The simulation restarts only when roads, transit lines, stations or region change, debounced by 2 s.

## Deployment
- `.github/workflows/pages.yml` runs on every push to `main`: `npm test`, then `npm run build:pages` (base `/Ptah/`), then GitHub Pages. It takes about 1–2 minutes.
- `.github/workflows/ci.yml` runs build and unit tests.
- Check the Pages build locally with `npm run build:pages && npx playwright test -c playwright.pages.config.ts`.

## Testing
- `npm test`: 45 unit tests (Vitest), all passing.
- `npx playwright test e2e/smoke.spec.ts e2e/mobile.spec.ts`: 18 smoke scenarios plus 1 phone scenario, all passing at last run. They need internet for terrain and the city ring. The Playwright `webServer` rebuilds `dist` with base `/`.
- `npx playwright test e2e/perf.spec.ts`: throttled benchmark, written to `test-results/perf.json`. Last steady-state result under 4× CPU throttle: 2D 3 ms, 3D Low 6 ms, 3D High 23 ms per frame.
- Playwright 1.60 matches the cached chromium-1223. Headless SwiftShader understates fps, so main-thread ms is the metric to watch.

## Gotchas
- Public Overpass mirrors are slow or flaky. Packs and tiles exist to avoid them, and the builders retry with backoff.
- Don't send a browser-like User-Agent from scripts. Use the honest UA strings already in the scripts.
- City-ring tiles are built in quarters keyed `tile#0..3`. Up-to-date checks must use the quarter key (a bare-key check caused an endless rebuild loop, fixed 2026-11-20).
- The frame-rate tooltip in the status bar shows draw calls and triangles, and the perf benchmark records them (`PERF_CITY=… npx playwright test e2e/perf.spec.ts`).
- Any change to the facade shader (`makeBuildingMaterial`) affects detail buildings and the High-quality city ring alike.
- `public/` stays under GitHub Pages' 1 GB limit. Check its size before adding more tiles.

## Next actions
See `TODO.md`. The top items:
1. Real-device QA (needs the owner); 3D High in dense cities on a real GPU.
2. Pre-built reach-2 detail tiles for featured cities, if repo and Pages size allow (`public/` is 86 MB today).
3. Transit: headway editing and route colours from OSM.
4. Time-slice the React side of big tile merges; make ring buildings pickable in the 2D view.
