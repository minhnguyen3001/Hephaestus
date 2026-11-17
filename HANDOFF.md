# HANDOFF: read this first

Last updated: 2026-11-17 (session 1, later). The owner runs this project autonomously: **zero cost**, **GitHub on autopilot** (commit, push and merge to `main` without asking), keep working through TODO.md.

## New-session procedure
1. Read this file, then `TODO.md`, then `README.md`.
2. Run `git status` and `git log --oneline -15`. Check this file still matches the repo.
3. Run `npm install && npm test && npm run build`.
4. Continue with **Next actions**. Rationale for past choices is in `docs/DECISIONS.md`.

## Project state
Phase 1 is done, and much of Phases 2–3 too. A user can:
- Search or pick a featured city. Featured cities load from static packs.
- Explore a real 3D city on real terrain, or the 2D plan view.
- Edit buildings and roads (new roads form intersections), and draw bus and elevated metro lines.
- Watch a living simulation: lanes, signals, buses, trains and riders.
- Compare the original and proposed city in the dashboard, with a traffic flow layer.
- Rely on autosave, which keeps projects locally.

Not built yet: multiple scenarios per project, share links, accounts, collaboration, underground metro, trees, zoning brush, and any backend (deferred: zero cost).

## Technical map
| Area | Files |
| --- | --- |
| Types | `src/geo/types.ts` (WorldData, TransitLineSpec, provenance) |
| Geodata | `src/geo/osm.ts` (Overpass query core/extras, mirrors, packs, parse incl. relations and coastline), `src/geo/polygons.ts` (join/clip/coastline→sea), `src/geo/terrain.ts` (Terrarium DEM), `src/geo/geocode.ts` |
| Pack pipeline | `scripts/build-city-packs.ts` → `public/packs/*.json` + `index.json` |
| Simulation | `src/sim/simulation.ts` (Simulation: capacity, trips, car-following, signals, transit lines/stops/riders, metro, trains), `src/sim/graph.ts`, `src/sim/region.ts` |
| Worker | `src/sim/worker.ts`, `src/sim/protocol.ts` (frames), `src/sim/client.ts` (SimClient: worker or inline) |
| Scenario | `src/project/edits.ts` (Edit union incl. addLine/removeLine, applyEdits, connectRoad), `src/project/store.ts` |
| Rendering | `src/render/engine.ts` (3D Engine implements WorldRenderer), `src/render/plan2d.ts` (2D), `src/render/tools.ts` (shared ToolController), `src/render/geometry.ts`, `src/render/palette.ts`, `src/render/quality.ts` |
| UI | `src/ui/WorldView.tsx` (state owner), `src/ui/Panels.tsx`, `src/ui/Landing.tsx`, `src/ui/SearchBox.tsx`, `src/ui/metrics.ts` |
| Tests | `src/sim/sim.test.ts`, `src/geo/polygons.test.ts`, `e2e/smoke.spec.ts` |

Contract: React owns project, history and view state. It calls `renderer.setWorld(world, region)`, and renderers report through `EngineCallbacks`. Renderers rebuild the simulation only when roads, region or transit lines change.

## Git state
- Single branch `main` on origin (github.com/minhnguyen3001/Hephaestus, **private**). Everything is pushed after each feature.
- Workflow: commit on `main` (or a short-lived branch, fast-forwarded), push immediately.

## Testing state
- `npm test`: 21/21 passing.
- `npx playwright test`: 6 scenarios. 2D plan, traffic, metro and terrain pass. The Chicago and Hong Kong scenarios need live Overpass until their packs are built, and fail when public servers are busy.
- Playwright 1.60 matches the cached chromium-1223. Headless SwiftShader runs at about 1–15 fps, which says nothing about real GPU performance.

## Next actions
1. Rebuild the failed packs (Chicago Loop, District 1 Saigon, plus any others missing from `public/packs/index.json`).
2. Scenarios: multiple named proposals per project, with comparison.
3. Share links: encode place and edits in the URL (compressed).
4. Persist camera per project.
5. Trees and street furniture (instanced) for visual polish.
6. Zoning brush and polygon building/park tools.
7. Underground metro view and OSM subway stations.
8. Write the performance doc after throttled measurements.

## Owner decisions
- Approved: the master brief; **zero cost**; **automatic GitHub operations**; continuous autonomous work.
- Pending: free public hosting (needs a public repo or a free host account), product name.
- Constraints: no paid services; label estimated and synthetic data; no force-push or history rewrite.
