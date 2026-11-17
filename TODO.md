# TODO

Priorities: **P0** critical · **P1** high · **P2** medium · **P3** future. Update this file whenever work lands.

## Owner constraints (decided 2026-11-17)
- **Zero cost.** Free data and services only. ADR-004 and ADR-005 are resolved toward free options (see docs/DECISIONS.md).
- **GitHub on autopilot.** Commit, push and merge to `main` automatically.

## Awaiting owner decision
- [ ] Free public hosting. The repo is private, and GitHub Pages is paid for private repos. Options: make the repo public (free Pages via Actions), or connect a free Vercel, Netlify or Cloudflare Pages account.
- [ ] Product name: keep "Global City Simulator", or adopt "Hephaestus" or another brand.

## P0
- [ ] Re-run the pack builder for Chicago, Saigon and any other city that failed (public Overpass timeouts): `npx tsx scripts/build-city-packs.ts "Chicago Loop"`
- [ ] Measure performance on throttled profiles (4× CPU, integrated GPU) and record targets in docs/PERFORMANCE.md

## P1
- [ ] Multiple named scenarios per project, with side-by-side metric comparison
- [ ] Shareable link: place, camera and edits encoded in the URL (no backend needed)
- [ ] Persist camera per project
- [ ] Road properties editor (lanes, one-way, speed, pedestrian-only, bike lane)
- [ ] Underground metro: x-ray view of tunnels; trains on subway lines; stations from OSM
- [ ] Onboarding: interactive steps instead of a static card
- [ ] Touch QA on a real iPad and Android phone; Safari QA
- [ ] Transit: transfers between lines; real GTFS where free feeds exist; line headway editing

## P2
- [ ] Building LOD: roof shapes, facade variety by region
- [ ] Trees along streets and in parks (instanced)
- [ ] Bridges at proper elevation with ramps; road tunnels
- [ ] Zoning brush and polygon tools (draw building and park footprints)
- [ ] Larger areas: tiled loading around the camera, multiple origins
- [ ] Parking, taxis picking up and dropping off
- [ ] Weekend and holiday demand profiles; events (road closure, concert)
- [ ] Accessibility metrics (walk-time isochrones to jobs, parks and transit)
- [ ] Grow the pack pipeline: GitHub Action (free minutes) to rebuild packs on a schedule

## P3
- [ ] Accounts, cloud save, sharing, permissions (needs free-tier backend, e.g. Supabase free, if approved)
- [ ] Real-time collaboration
- [ ] Load testing (only meaningful once there is a backend)
- [ ] Planning timeline (5/10/20 years) and challenges
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
- [x] 21 unit tests; 6 e2e scenarios
