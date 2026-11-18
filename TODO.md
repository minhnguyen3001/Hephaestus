# TODO

Priorities: **P0** critical · **P1** high · **P2** medium · **P3** future. Update this file whenever work lands.

## Owner constraints (decided 2026-11-17)
- **Zero cost.** Free data and services only. ADR-004 and ADR-005 are resolved toward free options (see docs/DECISIONS.md).
- **GitHub on autopilot.** Commit, push and merge to `main` automatically.

## Awaiting owner decision
- [x] Name: **Ptah** (owner, 2026-11-17)
- [x] Hosting: repo goes public, deployed free to GitHub Pages via Actions

## P0
- [ ] Real-device QA (old Windows laptop with integrated GPU, iPad, Android phone, Safari). Note: 3D High in headless SwiftShader costs ~150 ms/frame; verify on real GPUs

## P1
- [ ] Transit: real GTFS where free feeds exist; line headway editing; route colours from OSM relations

## P2
- [ ] More roof shapes (hipped, flat with parapets); regional facade palettes
- [x] Road tunnels: in the network, rendered in x-ray, agents shown underground
- [x] Larger areas: 1 km tiles stream around the camera (budget by quality); static tiles for featured cities
- [ ] Pre-build reach-2 tiles (5×5 km) for featured cities if repo size allows; consider a free CDN for bigger tile sets
- [ ] ~~Geometry build in a worker~~ not needed: profiling (`scripts/profile-load.ts`) shows the full data pipeline is ~160 ms; terrain no longer blocks first render
- [x] Parking search (garages preferred) and taxi pickups
- [x] Public holiday demand profile
- [ ] Auto-detect stadiums from OSM for event presets
- [ ] Network-based walk isochrones (current access metrics use straight-line distance)
- [ ] Grow the pack pipeline: GitHub Action (free minutes) to rebuild packs on a schedule

## P3
- [ ] Accounts, cloud save, sharing, permissions (needs free-tier backend, e.g. Supabase free, if approved)
- [ ] Real-time collaboration
- [ ] Load testing (only meaningful once there is a backend)
- [ ] Optional LLM phrasing for the advisor (pluggable; the rule-based advisor works offline and for free)
- [ ] WebGPU renderer path

## Known bugs / tech debt
- [ ] No conflict resolution inside intersections between turning vehicles in the same signal group
- [ ] No lane changes; lane switches snap visually at edge transitions
- [ ] `setWorld` rebuilds all static meshes on every edit (fine at ~4k buildings)
- [ ] Metro trains don't follow each other (they may overlap at stations on short lines)
- [ ] Riders choose transit only on a single line (no transfers yet)

## Done
- [x] Phase 1 foundation: search, OSM 3D city, camera, tools, undo/redo, scenarios, simulation, dashboard (2026-11-17)
- [x] Real terrain from AWS Terrain Tiles; draped roads and areas; buildings seated on terrain
- [x] Multipolygon relations; sea from coastlines with islands; area clipping
- [x] Static city packs + pack builder; live Overpass split into core and streamed extras with mirror timeouts
- [x] Simulation in a Web Worker (inline fallback); wall-clock time; bounded warm-up; main-component snapping
- [x] 2D plan view (Canvas2D) with full tools, auto-used without WebGL
- [x] Traffic flow layer; visible signal heads; pedestrians obey signals
- [x] Drawn roads form intersections and T-junctions
- [x] User-drawn bus and elevated metro lines with full rider lifecycle and per-line ridership
- [x] Scenarios (named, compare table), share links (#plan=, no server), saved camera
- [x] Trees (OSM + illustrative park planting), pitched roofs, underground x-ray with subway trains
- [x] Zoning tool (use, density, replace), road properties editor, accessibility indicators
- [x] Weekday/weekend demand; +5/10/20-year projections with stated growth assumptions
- [x] Interactive onboarding tour; phone layout test; bridge decks; duplicate building; load-the-city-here
- [x] Performance doc with throttled measurements (main thread 0.8 ms/frame in 2D, 1.4 ms in 3D Low)
- [x] Emergency vehicles; transit transfers; real OSM rail/subway lines with stations and riders
- [x] Planning challenges; rule-based advisor with fly-to; note pins (travel in share links); weather
- [x] All 8 featured cities packed (with stations, trees, bike-lane tags)
- [x] Bike lanes (OSM + editor + routing + mode effect); event crowds; glass curtain-wall towers
- [x] WebGL context-loss recovery; precomputed transit reachability; profiling scripts (scripts/profile-load.ts, scripts/profile-sim.ts)
- [x] 37 unit tests; ~21 e2e scenarios + phone layout + perf benchmark
