# HANDOFF: read this first

Last updated: 2026-11-17 (session 1).

## New-session procedure
1. Read this file, then `TODO.md`, then `README.md`.
2. Run `git status` and `git log --oneline -10`. Check this file still matches the repo.
3. Run `npm install && npm test && npm run build`.
4. Continue from **Next actions** below. Do not redesign the architecture. Rationale is in `docs/DECISIONS.md`.

## Project state
- **Phase:** Phase 1 (functional 3D foundation) is mostly done. The first Phase 2 simulation slice is in.
- **Working end-to-end:** landing page → search or featured city → live OSM load → 3D city → inspect, orbit and follow → edit (build, road, bulldoze, height, use) → undo/redo → original/proposed toggle → autosave → living simulation with dashboard.
- **Verified:** Chicago Loop loads 843 buildings and 181 signals. About 800 agents run: pedestrians, cyclists, motorbikes, cars, taxis, buses, plus elevated L trains. The Playwright run covers search, load, inspect, build, undo, street view and night.
- **Not built:** terrain, OSM relations (big rivers and lakes), Web Worker simulation, 2D fallback, backend, accounts, sharing, collaboration, GTFS, scenario comparison beyond original vs proposed.

## Technical map
| Area | Files |
| --- | --- |
| Types | `src/geo/types.ts` (WorldData, Building, Road, provenance fields) |
| Geodata | `src/geo/osm.ts` (Overpass query, parse, mirrors, Cache API), `src/geo/geocode.ts` (Nominatim, featured cities) |
| Geometry utils | `src/geo/util.ts` (projection, area, seeded rng, weighted sampler) |
| Routing | `src/sim/graph.ts` (RoadGraph, A*, nearestNode) |
| Simulation | `src/sim/simulation.ts` (Simulation class, capacity model, signals, buses, trains), `src/sim/region.ts` (regional profiles) |
| Scenario | `src/project/edits.ts` (Edit union, applyEdits, undo/redo), `src/project/store.ts` (localStorage) |
| Rendering | `src/render/engine.ts` (Engine class: scene, camera, tools, picking, agents, sky, perf), `src/render/geometry.ts`, `src/render/quality.ts` |
| UI | `src/App.tsx`, `src/ui/Landing.tsx`, `src/ui/WorldView.tsx` (state owner), `src/ui/Panels.tsx`, `src/ui/SearchBox.tsx`, `src/ui/metrics.ts`, `src/styles.css` |
| Tests | `src/sim/sim.test.ts` (unit, synthetic Overpass grid fixture), `e2e/smoke.spec.ts` (live data) |

Engine ↔ React contract: React owns project, history, view and tool state. It calls `engine.setWorld(world, region)` whenever the shown world changes. The engine reports back through callbacks `onSelect`, `onEdit`, `onStats` (every 0.5 s), `onPerf` (every 1 s) and `onHint`. The engine is recreated when graphics quality changes, because antialiasing is fixed at context creation.

Config: none needed. There are no env vars or API keys. External services: public Overpass (3 mirrors) and public Nominatim, both development-only.

## Git state
- Remote: `origin` → github.com/minhnguyen3001/Hephaestus.
- Branch: `feat/phase1-foundation`, created from `main`, which holds only the initial commit. Not merged yet.
- See `git log` for the latest commit. Push status is reported at the end of each session below.

## Testing state
- `npm test`: 11/11 passing (geo parsing, provenance, routing, one-way, edits/undo, demand curve, regions, agents move and complete trips, signal phases never conflict).
- `npx playwright test`: passing (about 1.3 min). It needs internet, and public Overpass occasionally returns 502, which the mirror failover handles. Playwright 1.60 matches the locally cached chromium-1223.
- Headless SwiftShader renders at ~11 fps. That number is not representative of real GPUs.
- Untested: real low-end hardware, touch devices, Safari, memory over long sessions, cities other than Chicago in automation (manually designed for NYC, HCMC, Amsterdam, Tokyo and London profiles).

## Next actions (in order)
1. Terrain from DEM (Terrarium tiles), with heights applied to all geometry and agents. (P0)
2. OSM multipolygon relations for water and parks. (P0)
3. Simulation in a Web Worker. (P0)
4. 2D fallback mode. (P0)
5. Pedestrians obey signals, plus a visible signal heads layer. (P1)
6. Road tool splits crossing roads into intersections. (P1)
7. Riders on buses, user-drawn transit lines. (P1)
8. Congestion heatmap layer. (P1)
9. An e2e fixture so CI can run Playwright without the network. (P1)

## Owner decisions
- **Approved:** the master brief (vision, phases, autonomy, commit and push workflow).
- **Pending:** ADR-004 (geodata pipeline), ADR-005 (backend and hosting cost), product name, branch strategy. All listed in TODO.md.
- **Constraints stated:** no paid infrastructure without approval; no dedicated GPU requirement; label estimated and synthetic data; no force-push or history rewrite; no claims of 1,000-user scale without load-test evidence.
