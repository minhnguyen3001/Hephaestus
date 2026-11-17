# HANDOFF: read this first

Last updated: 2026-11-17 (session 1, later). The owner runs this project autonomously: **zero cost**, **GitHub on autopilot** (commit, push and merge to `main` without asking), keep working through TODO.md.

## New-session procedure
1. Read this file, then `TODO.md`, then `README.md`.
2. Run `git status` and `git log --oneline -15`. Check this file still matches the repo.
3. Run `npm install && npm test && npm run build`.
4. Continue with **Next actions**. Rationale for past choices is in `docs/DECISIONS.md`.

## Project state
A broad, working product. A user can:
- Search or pick a featured city. All 8 featured cities have packs, including stations, trees and bike-lane tags. Other places load live from free Overpass.
- Explore real 3D: terrain, sea from coastlines, relations, trees, pitched roofs, bridge decks, an underground x-ray, and weather. Or use the 2D plan view.
- Edit the plan: buildings, roads (which form intersections), the road editor (lanes, speed, one-way, bike lanes, pedestrian streets), zoning, bus and elevated metro lines, note pins, and event crowds (simulation condition). Multiple scenarios with comparison. Undo/redo, autosave, share links (`#plan=`).
- Watch the simulation, which runs in a worker:
  - OD trips and regional modes.
  - Lanes, signals (with pedestrians obeying them) and spill-back.
  - Emergency vehicles.
  - Buses and user metros with riders and transfers, plus **real OSM rail/subway lines that stop at mapped stations and carry riders**.
  - Weekday/weekend, +5/10/20-year projections, and weather.
- Read the dashboard: before/after metrics, access indicators, live traffic, per-line ridership, the traffic flow layer, the **rule-based planning advisor** with fly-to, and **planning challenges** with live goals.
- Take the interactive tour, use the phone layout, and switch graphics quality (Auto/Low/Medium/High).

Not built: any backend (accounts, cloud save, real-time collaboration). It's deferred because of the zero-cost constraint; share links and notes cover sharing for now.

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
| UI | `src/ui/WorldView.tsx` (state owner), `src/ui/Panels.tsx`, `src/ui/Tour.tsx`, `src/ui/Landing.tsx`, `src/ui/SearchBox.tsx`, `src/ui/metrics.ts` |
| Planning | `src/project/zoning.ts` (zone → buildings/park), `src/project/share.ts` (URL codec), `src/geo/trees.ts` |
| Insight | `src/ui/advisor.ts` (rule-based advisor), `src/ui/challenges.ts` (goals), `src/ui/metrics.ts` (capacity, access; grid proximity via `makeNear`) |
| Tests | `src/sim/sim.test.ts`, `src/geo/polygons.test.ts`, `e2e/smoke.spec.ts` |

Contract: React owns project, history and view state. It calls `renderer.setWorld(world, region)`, and renderers report through `EngineCallbacks`. Renderers rebuild the simulation only when roads, region or transit lines change.

## Git state
- Single branch `main` on origin (github.com/minhnguyen3001/Hephaestus, **private**). Everything is pushed after each feature.
- Workflow: commit on `main` (or a short-lived branch, fast-forwarded), push immediately.

## Testing state
- `npm test`: 37/37 passing.
- `npx playwright test`: about 19 scenarios in `e2e/smoke.spec.ts` plus `e2e/mobile.spec.ts`; all passing at last run. Some use live station and terrain queries (fast). Live-only cities can time out when public servers are busy.
- `npx playwright test e2e/perf.spec.ts`: throttled benchmark → `test-results/perf.json` (see docs/PERFORMANCE.md).
- Playwright 1.60 matches the cached chromium-1223. Headless SwiftShader runs at about 1–15 fps, which says nothing about real GPU performance.

## Next actions
1. Parking search and taxi pickup behaviour (P2).
2. (done) Road tunnels.
3. More roof shapes; regional facade palettes.
4. Public holiday profile; stadium event presets from OSM.
5. Real-device QA (needs the owner); zero-cost hosting once the owner decides.

Dev tools: `scripts/profile-load.ts` (load stages), `scripts/profile-sim.ts` (simulation ticks), `e2e/perf.spec.ts` (throttled benchmark).

## Owner decisions
- Approved: the master brief; **zero cost**; **automatic GitHub operations**; continuous autonomous work.
- Pending: free public hosting (needs a public repo or a free host account), product name.
- Constraints: no paid services; label estimated and synthetic data; no force-push or history rewrite.
