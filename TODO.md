# TODO

Priorities: **P0** critical · **P1** high · **P2** medium · **P3** future. Update this file whenever work lands.

## Awaiting owner decision
- [ ] **ADR-004**: production geodata pipeline (recommended: self-hosted PMTiles from OSM + Overture on R2/CDN). Blocks launch and scale. See docs/DECISIONS.md.
- [ ] **ADR-005**: backend stack and hosting budget (recommended: Node/Fastify + Postgres/PostGIS + Redis, ~$30–80/mo to start).
- [ ] Product name: keep "Global City Simulator", or adopt the repo name (Hephaestus) or another brand.
- [ ] Branching: work is on `feat/phase1-foundation`. Merge to `main` and keep feature branches, or commit straight to `main`?

## P0
- [ ] Terrain: load DEM (AWS Terrain Tiles / Terrarium, open data), build heightfield, put roads, buildings and agents on it
- [ ] Load OSM multipolygon relations (water, parks, large buildings). Rivers like the Chicago River are currently missing
- [ ] Move simulation to a Web Worker (transfer positions as Float32Array) to protect frame rate on low-end CPUs
- [ ] Functional 2D planning mode (Canvas2D top-down, same data and tools) for devices without WebGL
- [ ] Measure performance on throttled profiles (4× CPU slowdown, integrated GPU) and record targets in docs

## P1
- [ ] Pedestrians obey signals and use crosswalks. Signals visualized (pole lights)
- [ ] Road tool: split existing roads where a new road crosses them, so intersections form
- [ ] Road properties editor (lanes, one-way, speed, pedestrian-only, bike lane)
- [ ] Bus riders actually ride (agent boards, rides, alights, walks to destination)
- [ ] User-drawn bus routes and metro lines with stations
- [ ] Underground metro: render tunnel rail in an x-ray/underground view; trains on subway lines
- [ ] Multiple scenarios per project and side-by-side comparison
- [ ] Congestion heatmap layer on roads (edge speed / free-flow)
- [ ] Persist the camera position per project. Shareable link with place and camera in the URL
- [ ] Onboarding: interactive steps (detect orbit, select, edit) instead of a static card
- [ ] Touch QA on real iPad and Android phone
- [ ] CI: add e2e against a recorded Overpass fixture (avoid live-network flakiness)

## P2
- [ ] Building LOD: roof shapes (gabled/hipped for small residential), facade variety by region
- [ ] Trees along streets and in parks (instanced)
- [ ] Bridges at proper elevation with ramps. Tunnels for roads
- [ ] Zoning brush and polygon tools (draw building/park footprints)
- [ ] Larger areas: tiled loading around camera, unload far tiles, multiple origins
- [ ] Parking simulation, taxis picking up and dropping off
- [ ] Weekend/holiday demand profiles, events (road closure, concert)
- [ ] Accessibility metrics (walk-time isochrones to jobs/parks/transit)
- [ ] Bundle: lazy-load OrbitControls/BufferGeometryUtils with engine (already split), check landing bundle stays < 60 KB gz

## P3
- [ ] Accounts, cloud save, sharing, permissions (after ADR-005)
- [ ] Real-time collaboration (op log over WebSocket rooms)
- [ ] Load testing to 1,000+ concurrent users (k6)
- [ ] GTFS import for real transit routes
- [ ] Planning timeline (5/10/20 years) and challenges
- [ ] Optional AI planning assistant (pluggable, not required)
- [ ] WebGPU renderer path

## Known bugs / tech debt
- [ ] Vehicles at junctions can overlap with crossing turns from the same signal group (no conflict resolution inside intersections)
- [ ] Lane assignment is static per agent (no lane changes), so lane switches snap visually at edge transitions
- [ ] Proposed roads don't receive lane markings until connected properly; endpoints only snap within 25 m
- [ ] `setWorld` rebuilds all static meshes on every edit (fine at ~3k buildings, will need per-chunk rebuild for bigger areas)
- [ ] Public Overpass/Nominatim usage (dev only, see ADR-004)

## Done
- [x] Repo scaffold: Vite + React + TS + three.js, Vitest, Playwright (2026-11-17)
- [x] OSM loading via Overpass with Cache API and mirror failover; parsing of buildings, roads, water, parks, rail, signals
- [x] Height/use provenance labels; "highlight estimated data" layer
- [x] 3D engine: merged pickable buildings with window/night shader, mitered road ribbons with markings, elevated rail with pillars
- [x] Camera: 360° orbit, presets, fly-to, keyboard, follow agent, double-click orbit-focus, ground clamp
- [x] Tools: select/inspect, place building, draw road (snapping), bulldoze, height/use edits, undo/redo
- [x] Original vs Proposed toggle, local autosave, project list
- [x] Simulation: OD trips from building capacity, regional mode share, lane following, signals, spill-back, buses with stops and boarding, trains
- [x] Dashboard: capacity before/after, live traffic metrics, assumptions shown
- [x] Adaptive quality (Low/Medium/High/Auto) with FPS-driven resolution scaling
- [x] Unit tests (11) and e2e smoke test against live Chicago data (passing)
