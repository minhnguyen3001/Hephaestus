# HANDOFF: read this first

Last updated: 2026-11-20, end of session. Everything is on `main`, pushed and deployed (see "State at hand-off").

**Ptah** is a browser-based 3D city-building and urban-planning simulator built on real-world geography.
- Live: https://minhnguyen3001.github.io/Ptah/
- Repo: https://github.com/minhnguyen3001/Ptah (public)
- The local folder is still named `~/vscode/Hephaestus`, from an earlier product name. That's harmless.

## New-session procedure
1. Read this file, then `TODO.md`, then `README.md`.
2. Run `git status` and `git log --oneline -15`. Check this file still matches the repo.
3. Run `npm install && npm test && npm run build`. Expect 51 unit tests passing.
4. Resume the **In progress** item in `TODO.md` (reach-2 tiles). Then take the top unchecked item. Don't redesign the architecture; the reasons behind it are in `docs/DECISIONS.md`.

## Owner rules (standing)
- **Zero cost.** Use only free data and services. No paid hosting, APIs or backends without explicit approval.
- **GitHub on autopilot.** Commit, push to `main` and deploy without asking. Never force-push or rewrite history.
- **Work autonomously** through TODO.md. If the usage limit hits, the next session resumes from this file.
- Label estimated data and synthetic agents honestly. Simulation results are never presented as forecasts.
- The owner has asked for low latency more than once. Measure on a real GPU before and after any rendering change (see Testing).

## State at hand-off
- The latest commits add network walk access, computed in a worker, and venue-based events. They also commit the reach-2 tiles built so far.
- The reach-2 tile build was stopped part-way. Resume with `npx tsx scripts/build-city-tiles.ts 2`. It skips existing files.

## What works (all live)
- **Cities.**
  - Search anywhere (Nominatim) or pick one of 8 featured cities: Chicago Loop, Midtown Manhattan, District 1 Saigon, Amsterdam Centrum, Shibuya, Nob Hill SF, Central HK and City of London.
  - Featured cities load from static packs and pre-built tiles. Other places load live from free public Overpass, which is slow when busy.
- **Map size.**
  - The detail zone streams 1 km tiles around the camera, within a budget of 12/30/60 tiles for Low/Medium/High.
  - The city ring extends to a 10 km diameter (3/4/5 km radius by quality) using OpenFreeMap vector tiles.
  - Ring buildings can be inspected in 3D and 2D, and "Load detail here" streams that tile first.
- **3D world.**
  - Terrain, sea from coastlines, parks, trees and roofs.
  - Glass towers, shopfronts and rooftop plant.
  - Sidewalks (which stop at junctions), street lights, crosswalks and bridges.
  - An x-ray underground view, weather, and day/night with readable nights.
- **2D plan view.** Canvas2D with the same tools, used automatically without WebGL.
- **Planning.**
  - Buildings, roads, a road editor and zoning.
  - Bus and metro lines, with headway per line: "every N min" in the dashboard, using the `setLine` edit.
  - Notes, and event crowds that snap to real venues.
  - Scenarios, undo/redo, autosave, share links (`#plan=…`) and "Save image".
- **Simulation** (Web Worker).
  - 450/1300/3000 agents by quality, with regional mode shares, lanes, signals and spill-back.
  - Emergency vehicles, taxis, parking, and weekday/weekend/holiday demand.
  - Projections and weather effects.
  - Buses and metros with riders and transfers. Real OSM rail stops at mapped stations, and metros keep 250 m block spacing.
- **Time of day.**
  - "Jump to…" offers: Now (≈ local solar time from longitude), 08:00, 12:00, 17:30, 22:00 and 03:00.
  - `Simulation.jumpTo` re-seeds traffic for the new hour when the jump is over 30 min.
  - The Traffic button colours streets by speed.
- **Insight.**
  - The before/after dashboard and per-line ridership.
  - Congestion by hour for the real city and the proposal side by side.
  - Walk access: the share of residents within a 400 m walk of transit and a 300 m walk of a park, measured along streets.
  - The advisor, challenges and the tour.

## Architecture map
| Area | Files |
| --- | --- |
| Types | `src/geo/types.ts` (`Building.venue`, `TransitLineSpec.headwayMin`) |
| OSM data | `src/geo/osm.ts`: Overpass queries, pack and tile loading, `parseOverpass`, `venueOf`, `fetchTile`, `slimElements` / `KEEP_TAGS` |
| Off-main-thread work | `src/geo/parse.worker.ts` + `src/geo/offthread.ts`: tile JSON, ring vector tiles and walk-access jobs, with an inline fallback |
| Walking network | `src/geo/walk.ts`: `walkReach` (multi-source Dijkstra, segment snapping, graph cached per roads array) |
| Tiles | `src/geo/tiles.ts` (`TileStream`, `mergeWorld`), `src/geo/vectortiles.ts` (city ring) |
| Simulation | `src/sim/simulation.ts` (`jumpTo`, `vehiclesFor`, `moveMetro` block spacing, `demandAt`), `graph.ts`, `region.ts`; worker in `worker.ts`, `protocol.ts`, `client.ts` |
| Scenario | `src/project/edits.ts` (Edit union incl. `setLine`, `applyEdits`), `zoning.ts`, `share.ts`, `store.ts` |
| 3D renderer | `src/render/engine.ts`. Key parts: <ul><li>`syncChunks`, `layer` and `defer` (whole-world layers through the work queue)</li><li>`runWork`, `setContext` / `buildContextTile` (4×4 parts per ring tile; `ringIds`)</li><li>`cullChunks`, `pick`</li><li>the scheduled shadow map in `loop`</li><li>`updateSky` (moonlight, `lit` uniform)</li><li>`snapshot`</li></ul> |
| 2D renderer | `src/render/plan2d.ts` (`ringPick` for ring inspection, `snapshot`) |
| Shared render code | `src/render/tools.ts`, `geometry.ts` (`trimLine`, `offsetLine`, facades), `palette.ts`, `quality.ts` (presets) |
| UI | `src/ui/WorldView.tsx` (state owner; `useAccess` hook at the bottom; hourly series; venue snapping in `onPlaceEvent`), `Panels.tsx` (`SimBar`, `Dashboard`, `HourlyCongestion`), `metrics.ts` (`cityMetrics(w, access)`, `accessJob`, `computeAccess`, `cityMetricsSync`) |
| Data | `public/packs/` (8 city centres), `public/tiles/<pack>/<i>_<j>.json`; `public/` is about 100 MB |
| Scripts | `scripts/build-city-packs.ts`, `build-city-tiles.ts [reach]`, `profile-load.ts`, `profile-sim.ts`, `inspect-mvt.ts` |

How the pieces connect:
- React owns the project, history and view state. It calls `renderer.setWorld(world, region)`, `setContext(ringTiles, detailZone)` and `setSimParams(...)`.
- Renderers report back through `EngineCallbacks`.
- The simulation restarts only when roads, transit lines, stations or region change, debounced by 2 s. Building edits don't restart it (see TODO P1).
- Metrics: the cheap part runs in render. Walk access arrives asynchronously from the worker, and shows "…" until known (NaN in `CityMetrics`).

## Deployment
- `.github/workflows/pages.yml` runs on every push to `main`: `npm test`, then `npm run build:pages` (base `/Ptah/`), then GitHub Pages. It takes about 1–2 minutes.
- `.github/workflows/ci.yml` runs build and unit tests.
- Check the Pages build locally with `npm run build:pages && npx playwright test -c playwright.pages.config.ts`.
- `gh` isn't installed on the dev machine. To check runs, use `curl -s "https://api.github.com/repos/minhnguyen3001/Ptah/actions/runs?per_page=2"`.

## Testing
- `npm test`: 51 unit tests (Vitest), all passing.
- `npx playwright test e2e/smoke.spec.ts e2e/mobile.spec.ts`: 21 smoke scenarios plus 1 phone scenario. They need internet. Two tests probe click positions and are occasionally flaky; re-run before investigating: "city-ring buildings can be inspected…" and "load a real city…" when run beside the perf tests.
- `npx playwright test e2e/perf.spec.ts`: SwiftShader with a 4× throttle. Compare relative numbers only, and run it on its own.
- **Real-GPU profiling** (use this for latency work): a temporary Playwright config with these settings:
  - `headless: false`, `deviceScaleFactor: 2`
  - `launchOptions.args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']`
  - `webServer.reuseExistingServer`, with `npm run build && npx vite preview --port 4173` started yourself

  Record frame gaps with rAF and long tasks with `PerformanceObserver({ type: 'longtask' })`. Take CPU profiles through CDP `Profiler.start`. Last results on an M2:
  - 60 fps panning, zooming and orbiting, with about 3 ms main-thread work per frame.
  - Long tasks after the first load: Chicago 0–1, Shibuya 3–4 (55–100 ms).

## Gotchas
- **Latency rules:**
  - The shadow map refreshes on a schedule (`shadowMap.autoUpdate = false`). Agents don't cast shadows.
  - High's pixel ratio is 1.5, and Auto steps down below 45 fps.
  - Never rebuild whole-world layers synchronously in `setWorld`; use `defer()`.
  - Keep per-object caches keyed by immutable objects (`areaGeo`, metrics `perBuilding`).
  - Heavy pure computation goes through `offThread`.
- City-ring tile parts are keyed `tile#0..15`. Up-to-date checks must use the part key (a bare-key check once caused an endless rebuild loop).
- `walkReach` snaps to the nearest street segment, not vertex. OSM vertices are 80–250 m apart. Searches cover 3×3 cells of 40 m first, widening to 120 m.
- `SimClient.watch(id)` must ignore repeat calls for the same id, or the inspector loses its info every refresh.
- Sidewalks are split at junction nodes and trimmed by the widest meeting street + 3.5 m (`trimLine`).
- Public Overpass mirrors are slow or flaky. Packs and tiles avoid them, and the builders retry with backoff. Use the honest UA strings already in the scripts.
- Any change to the facade shader (`makeBuildingMaterial`) affects detail buildings and the High-quality ring alike.
- Keep `public/` well under GitHub Pages' 1 GB limit.

## Next actions
1. Finish reach-2 tiles (TODO "In progress"), then commit.
2. Real-device QA (needs the owner).
3. Building and zoning edits should affect simulated demand (TODO P1).
4. Remaining Shibuya stutters; demand calibration against open traffic counts.
