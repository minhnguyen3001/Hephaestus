# TODO

Priorities: **P0** critical · **P1** high · **P2** medium · **P3** future. Mark items done as work lands, and add new findings as they come up.

Owner rules: zero cost; GitHub on autopilot (commit, push, deploy); honest labelling of estimated and synthetic data. See HANDOFF.md.

## Awaiting owner
- [ ] Real-device QA feedback: an old Windows laptop with integrated GPU, an iPad, an Android phone, Safari. Ask for city, graphics setting and the slow action.

## P0
- [x] Dense-city check (Shibuya): Low and Medium within GPU budget at City view (~0.55M triangles); fixed zoom-out culling and a ring-quarter rebuild loop that kept the ring from ever finishing (2026-11-20)
- [ ] 3D High in dense cities needs a real-GPU check (software GL is too noisy to judge)

## P1
- [x] Sidewalks stop at junctions instead of crossing them; inspector speed no longer stuck at 0 km/h (2026-11-20)
- [x] Traffic by time of day: "Jump to…" (now, rush hours, night) re-seeds traffic for that hour; Traffic button in the sim bar; congestion-by-hour chart in the dashboard (2026-11-20)
- [x] City-ring buildings: click to inspect (height, footprint, source); “Load detail here” streams that tile first; editing tools explain they're view-only (2026-11-20)
- [ ] 2D plan view: ring buildings are not pickable yet (3D only)
- [ ] Pre-build reach-2 detail tiles (5×5 km) for featured cities if `public/` stays well under 1 GB (currently 86 MB)
- [ ] Transit: line headway editing; route colours from OSM relations; free GTFS feeds where available
- [ ] Time-slice the React side of large tile merges (`applyEdits`, `cityMetrics`) for very dense areas

## P2
- [ ] More roof shapes (hipped, flat with parapets) and regional facade palettes
- [ ] Stadium and arena presets for event crowds, detected from OSM `leisure=stadium`
- [ ] Network-based walk isochrones (access metrics currently use straight-line distance)
- [ ] Scheduled GitHub Action (free on a public repo) to refresh packs and tiles monthly
- [ ] Lane changes and intersection conflict resolution between turning vehicles
- [ ] Metro trains keep headway (they can overlap at stations on short lines)

## P3
- [ ] Accounts, cloud save and real-time collaboration (needs a free-tier backend and owner approval)
- [ ] Optional LLM wording for the advisor (pluggable; the rule-based advisor stays the default)
- [ ] WebGPU renderer path
- [ ] Education and classroom features; community scenario library

## Known limitations
- Live Overpass loading for non-featured places can take 30–120 s per tile when public servers are busy.
- City-ring buildings come from vector tiles: heights are rendered heights, and they are view-only.
- Projects live in browser localStorage; share links are the way to move a plan.
- The old URL `…github.io/Hephaestus/` returns 404, so links shared before the rename are broken.

## Done (highlights)
- [x] Foundation: search, OSM 3D city, 360° camera, tools, undo/redo, scenarios, autosave, share links
- [x] Terrain (spike-free), sea from coastlines, relations, trees, roofs, glass towers, shopfronts, rooftop plant
- [x] Simulation in a worker: lanes, signals, pedestrians, emergency vehicles, taxis, parking, events, weather, projections
- [x] Transit: user bus and metro lines, transfers, real OSM rail and subway with stations
- [x] Planning: zoning, road editor, bike lanes, notes, challenges, advisor, traffic layer, x-ray underground
- [x] Map growth: 1 km detail tiles stream around the camera; 10 km city ring from OpenFreeMap; 8 packs and 64 pre-built tiles
- [x] Performance: chunked incremental scene, culled picking, heightfield ground pick, time-sliced building, quality-scaled ring
- [x] 2D plan view, phone layout, interactive tour, WebGL context-loss recovery
- [x] Renamed to **Ptah**; repo renamed; deployed free at https://minhnguyen3001.github.io/Ptah/
- [x] 47 unit tests; 18 smoke e2e + phone + Pages check + perf benchmark
