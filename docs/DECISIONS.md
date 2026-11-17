# Decision log (ADRs)

Status values: **Accepted** (in effect), **Proposed** (needs owner approval), **Superseded**.

## ADR-001: Web app, TypeScript + React + Vite — Accepted
A browser app reaches the widest range of devices (old PCs, Macs, tablets, phones) with no install. React handles UI chrome only. The 3D scene is imperative (no react-three-fiber) to avoid reconciliation overhead per frame.

## ADR-002: three.js as the 3D engine (WebGL2 baseline) — Accepted
- **Chosen over Babylon.js**: smaller bundle (~125 KB gz vs ~1 MB+), simpler to tune for low-end devices, and huge ecosystem. Babylon has more built-in game features, but we need a few of them and want control over the frame budget.
- **Chosen over MapLibre/deck.gl-first 3D**: those are map renderers with 3D extrusions. Our requirements (free 360° camera, street level, agents, object orbit, game-like art) fit a game engine with geodata loaded into it, not a map with 3D on top. MapLibre stays a candidate for the 2D fallback mode and the world-scale overview.
- WebGPU: later progressive enhancement through three's WebGPURenderer, not required.

## ADR-003: OpenStreetMap as primary geodata — Accepted (dev pipeline)
OSM has the best global coverage of streets and buildings with an open license (ODbL). Required attribution is shown in-app. The simulation uses roads, signals, lanes, speed limits and rail directly. **Development** uses the public Overpass and Nominatim APIs with caching and mirror failover. These are not allowed or reliable for production traffic (we already saw 502s during testing).

## ADR-004: Production geodata pipeline — **Proposed (needs approval)**
Options:
1. **Self-hosted tile pipeline (recommended).** Nightly or weekly OSM planet extract plus Overture buildings goes through processing (tilemaker or planetiler, heights, use classification) into PMTiles on object storage (Cloudflare R2 or S3) plus CDN. Cost is mostly storage (~100 GB) and egress. R2 has no egress fees, so expect roughly $5–30/month at early scale. Costs stay flat with users.
2. Self-hosted Overpass server: simpler port of today's code, but needs a 16–32 GB RAM VM (~$80–200/month), and live queries scale poorly with user count.
3. Commercial provider (MapTiler, Mapbox): fastest, but per-request pricing, vendor lock-in and license limits on caching and derived use.

Licensing note: the ODbL share-alike clause applies if we **publish a derived database**. Rendered views and simulations are "produced works" and only need attribution. Overture buildings are mixed-license (ODbL plus CDLA-Permissive). Keep source tags per feature.

## ADR-005: Backend stack and hosting — **Proposed (needs approval)**
Node + Fastify, Postgres + PostGIS, Redis, and WebSockets (one room per project). Start as one service plus a managed database (~$30–80/month on Fly.io, Render or Railway). Split services only when load tests show it is needed.

## ADR-006: Scenario = immutable base + edit list — Accepted
This gives cheap undo/redo, original vs proposed, small saves (edits only), and a natural operation log for collaboration (operations can be rebased or CRDT-wrapped later).

## ADR-007: Simulation fidelity tiers — Accepted
Macro capacity from buildings, meso demand and trip generation, and micro agents capped by quality budget. Agent counts scale with device class. A larger synthetic population is represented statistically, not as individuals.
