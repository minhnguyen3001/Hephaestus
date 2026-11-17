# TODO

Priorities: **P0** critical · **P1** high · **P2** medium · **P3** future. Update this file whenever work lands.

## Owner constraints (decided 2026-11-17)
- **Zero cost.** Free data and services only. ADR-004 and ADR-005 are resolved toward free options (see docs/DECISIONS.md).
- **GitHub on autopilot.** Commit, push and merge to `main` automatically.

## Awaiting owner decision
- [ ] Free public hosting. The repo is private, and GitHub Pages is paid for private repos. Options: make the repo public (free Pages via Actions), or connect a free Vercel, Netlify or Cloudflare Pages account.
- [ ] Product name: keep "Global City Simulator", or adopt "Hephaestus" or another brand.

## P0
- [ ] Packs still missing: Chicago Loop, District 1 Saigon, Amsterdam Centrum (public Overpass timeouts; builder now retries). Re-run: `npx tsx scripts/build-city-packs.ts "Chicago Loop"`
- [ ] Real-device QA (old Windows laptop with integrated GPU, iPad, Android phone, Safari). Note: 3D High in headless SwiftShader costs ~150 ms/frame; verify on real GPUs

## P1
- [ ] Subway stations from OSM, so subway trains stop at them; bike lanes in the road editor
- [ ] Emergency vehicles (ambulance, police, fire) with priority
- [ ] Transit: transfers between lines; real GTFS where free feeds exist; line headway editing

## P2
- [ ] Facade variety by region; more roof shapes (hipped, flat with parapets)
- [ ] Road tunnels (currently hidden)
- [ ] Larger areas: tiled loading around the camera (now: "load the city here" opens a new area)
- [ ] Geometry build in a worker (ready time is 8–12 s under 4× CPU throttle)
- [ ] Parking, taxis picking up and dropping off
- [ ] Weekend and holiday demand profiles; events (road closure, concert)
- [ ] Network-based walk isochrones (current access metrics use straight-line distance)
- [ ] Grow the pack pipeline: GitHub Action (free minutes) to rebuild packs on a schedule

## P3
- [ ] Accounts, cloud save, sharing, permissions (needs free-tier backend, e.g. Supabase free, if approved)
- [ ] Real-time collaboration
- [ ] Load testing (only meaningful once there is a backend)
- [ ] Planning challenges (goal-based scenarios)
- [ ] Optional AI planning assistant (pluggable, not required)
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
- [x] 29 unit tests; 12 e2e scenarios + perf benchmark
