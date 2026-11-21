# TODO

Priorities: **P0** critical · **P1** high · **P2** medium · **P3** future. Mark items done as work lands, and add new findings as they come up.

Owner rules: zero cost; GitHub on autopilot (commit, push, deploy); honest labelling of estimated and synthetic data. See HANDOFF.md.

## In progress (resume first)
- [ ] **Reach-2 tiles for featured cities** (5×5 km of pre-built detail). The builder is resumable: `npx tsx scripts/build-city-tiles.ts 2`. It skips files that already exist, at about 35 s per tile on public Overpass. Done: Chicago 24/24. Partly done: Manhattan 15/24. The other 6 cities have 8/24 each. Budget: `public/` is about 100 MB; reach 2 for all cities adds about 100 MB more, far under the 1 GB Pages limit. Commit the tiles when done.

## Awaiting owner
- [ ] Real-device QA feedback: an old Windows laptop with integrated GPU, an iPad, an Android phone, Safari. Ask for city, graphics setting and the slow action.

## P0
- [ ] 3D High in dense cities on a weaker real GPU. An M2 holds 60 fps everywhere at 3000 agents; integrated Intel and older Macs are unverified.

## P1
- [ ] Shibuya: a few 55–100 ms tasks remain while tiles stream. Causes: a single dense 300 m chunk build, the React merge render, and the structured clone of the world on simulation restart.
- [ ] Calibrate the demand curve and traffic volumes against real counts (free open traffic counts from city open-data portals) per featured city.
- [ ] Transit: official route colours from OSM route relations (needs relations in packs); free GTFS feeds where available.
- [ ] Before/after traffic only reacts to road and transit edits. Building and zoning edits don't restart the simulation, so trip demand stays at the old city. Restart, or reseed sites, when buildings change.

## P2
- [ ] More roof shapes (hipped, flat with parapets) and regional facade palettes.
- [ ] Walk isochrone overlay: draw the 5/10-minute walk area from a clicked point (`src/geo/walk.ts` already does network distance).
- [ ] Scheduled GitHub Action (free on a public repo) to refresh packs and tiles monthly.
- [ ] Lane changes and intersection conflict resolution between turning vehicles.
- [ ] Packs drop OSM `capacity`. It's now in `KEEP_TAGS`, so rebuild the packs to get real venue capacities instead of estimates.

## P3
- [ ] Accounts, cloud save and real-time collaboration (needs a free-tier backend and owner approval).
- [ ] Optional LLM wording for the advisor (pluggable; the rule-based advisor stays the default).
- [ ] WebGPU renderer path.
- [ ] Education and classroom features; community scenario library.

## Known limitations
- Live Overpass loading for non-featured places can take 30–120 s per tile when public servers are busy.
- City-ring buildings come from vector tiles: heights are rendered heights, and they are view-only.
- Projects live in browser localStorage; share links are the way to move a plan.
- Mapped subway lines use distinct but illustrative colours, not official ones.
- The old URL `…github.io/Hephaestus/` returns 404, so links shared before the rename are broken.

## Done on 2026-11-20
- [x] Sidewalks stop at junctions; the agent inspector shows real speed (it was stuck at 0 km/h)
- [x] Traffic by time of day: "Jump to…" presets re-seed traffic for that hour; a Traffic button in the sim bar
- [x] Congestion by hour for the real city and the proposal side by side, compared over the hours both have run
- [x] Busier streets (agent caps 450/1300/3000) and readable nights (moonlight, windows lit by hour, no window static)
- [x] Lower latency at full agent count:
  - scheduled shadow map, no agent shadows, High pixel ratio 1.5, faster Auto quality
  - deferred whole-world layers, cached areas and metrics
  - 16-part ring builds, no quadratic id scan
  - tile parsing in a worker
- [x] Transit: headway per drawn line; metro block spacing (250 m); distinct colours for mapped lines
- [x] City-ring buildings inspectable in 3D and 2D, with "Load detail here"
- [x] Event crowds snap to real venues (OSM name and capacity, or a labelled estimate)
- [x] Walk access (transit within 400 m, park within 300 m) measured along the street network, using real station locations. Computed in the background worker.
- [x] "Save image" downloads a PNG of the view
- [x] Dense-city GPU check at City view; ring rebuild loop fixed

## Done (earlier highlights)
- [x] Foundation: search, OSM 3D city, 360° camera, tools, undo/redo, scenarios, autosave, share links
- [x] Terrain, sea from coastlines, relations, trees, roofs, glass towers, shopfronts, rooftop plant
- [x] Simulation in a worker: lanes, signals, pedestrians, emergency vehicles, taxis, parking, events, weather, projections
- [x] Transit: user bus and metro lines, transfers, real OSM rail and subway with stations
- [x] Planning: zoning, road editor, bike lanes, notes, challenges, advisor, traffic layer, x-ray underground
- [x] Map growth: streamed 1 km detail tiles; 10 km city ring from OpenFreeMap; 8 packs
- [x] 2D plan view, phone layout, interactive tour, WebGL context-loss recovery
- [x] Renamed to **Ptah**; deployed free at https://minhnguyen3001.github.io/Ptah/
