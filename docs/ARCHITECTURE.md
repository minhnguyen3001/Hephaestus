# Architecture

## Principles

1. **Real data stays immutable.** The world loaded from geodata is never edited. A scenario is `base + Edit[]`, and `applyEdits()` produces the proposed world. Original vs proposed, undo/redo and (later) scenario diffing and collaboration all build on this.
2. **Simulation is separate from rendering.** `src/sim` has no three.js or DOM imports. The engine reads agent positions after each step. This lets the simulation move to a Web Worker (P1) or a server process (Phase 5) later.
3. **Low-end hardware first.** Static geometry is merged into a few draw calls, agents are instanced, and quality presets plus auto-adaptation keep frame rates acceptable.
4. **Honesty in data.** Every building records where its height and use came from (`heightSource`, `useSource`). Generated items carry `origin: 'proposed'`. Agents are labeled synthetic.

## Data flow

```
Place (search) ──► fetchWorld (Overpass, Cache API) ──► parseOverpass ──► WorldData (local meters)
                                                                           │
                                     History{edits, redo} ──► applyEdits ──┤
                                                                           ▼
                                                  Engine.setWorld(world, regionProfile)
                                                     ├─ static meshes (buildings, roads, areas, rails)
                                                     └─ Simulation(world, region) ─► agents ─► instanced meshes
```

## Coordinates

Each project has an origin (lat/lon). Geometry is in local meters on a tangent plane (`makeProjection`). This is accurate to well under 1% within the few-km working area. three.js maps local `(x east, y north)` to `(x, up, -y)`. A project covering a much larger area will need tiled origins (see roadmap).

## Rendering (src/render)

- **three.js / WebGL2**, chosen over Babylon and over MapLibre-centric 3D. Rationale is in DECISIONS.md (ADR-002).
- Buildings are custom-extruded, non-indexed geometry merged into **one mesh** (`PickMesh`). A triangle→id table supports picking and selection without per-building draw calls. Facade windows and night lights come from a shader patch (`onBeforeCompile`) using per-vertex facade coordinates, with `fwidth`-based anti-aliasing fade.
- Roads are mitered ribbons merged into one pickable mesh, with lane center markings. Areas and rails are merged too. Elevated rail gets instanced pillars.
- Agents use one `InstancedMesh` per kind (7 kinds plus train cars), up to 1100 instances each.
- The camera is `OrbitControls`, extended with eased fly-to tweens, presets (aerial, district, street, inspect), WASD/QE/RF keyboard control, vehicle follow and a ground clamp.
- **Adaptive quality**: presets set pixel ratio, shadows, agent budget and data radius. In Auto mode, sustained frame rates below 28 fps lower resolution and then disable shadows; sustained frame rates above 55 fps raise resolution again.

## Simulation (src/sim)

- **RoadGraph**: directed edges from OSM ways (one-way aware), with car and walk permissions, lanes per direction, and speed. It has grid spatial indexes for nearest-node lookup and A* routing (time cost for cars, distance for walking).
- **Population (macro)**: per-building capacity for residents, jobs, visitors, students and freight, computed from floor area and use. Parks attract visitors.
- **Trips (meso)**: the demand curve sets the target number of active agents. Trip purpose depends on time of day. Origins and destinations are sampled by capacity. Mode choice comes from the regional profile, adjusted by distance and bus availability.
- **Movement (micro)**: vehicles follow the leader in their lane (Krauss-like safe speed), stop at signal stop lines, respect queue spill-back into the next edge, and recover from gridlock after 150 s. Motorbikes in filtering regions pass cars. Pedestrians and cyclists use the walk graph with sidewalk and curb offsets. Drive side comes from the country.
- **Signals**: real OSM `traffic_signals` nodes, plus estimated signals where 3 or more major approaches meet. Phases are two-group (by approach axis) on a 64 s cycle with yellow and all-red.
- **Transit**: up to 3 generated bus routes on major roads, with stops every ~320 m, boarding and alighting, and dwell time. Pedestrians whose mode is bus walk to the nearest stop and wait there. Trains shuttle along chained above-ground rail ways.
- Deterministic seeded RNG (tests rely on it).

## Persistence (src/project)

localStorage keeps project metadata and edits (small). The Cache API keeps raw Overpass responses. A backend replaces this in Phase 5. The `Project` shape is designed to serialize unchanged.

## Planned backend (not built)

Node (Fastify) API, Postgres/PostGIS for projects, scenarios and permissions, Redis for sessions, rate limits and pub/sub, and WebSocket rooms partitioned per project for collaboration. Geodata is served as static, pre-processed vector tiles (PMTiles) from object storage plus CDN, so geodata cost stays flat with user count. See DECISIONS.md (ADR-004 / ADR-005, pending approval).
