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

## ADR-004: Production geodata pipeline — **Accepted: zero-cost static packs (owner: no spending)**
Decision (2026-11-17): the owner requires zero cost. Featured and curated places ship as **static OSM packs** built by `scripts/build-city-packs.ts` and served with the app (free on any static host). Other places use free public Overpass with mirrors, timeouts and browser caching. Option 1 below stays the long-term path if a free host for larger tile sets is chosen (Cloudflare R2's free tier covers ~10 GB).

Original analysis:
Options:
1. **Self-hosted tile pipeline (recommended).** Nightly or weekly OSM planet extract plus Overture buildings goes through processing (tilemaker or planetiler, heights, use classification) into PMTiles on object storage (Cloudflare R2 or S3) plus CDN. Cost is mostly storage (~100 GB) and egress. R2 has no egress fees, so expect roughly $5–30/month at early scale. Costs stay flat with users.
2. Self-hosted Overpass server: simpler port of today's code, but needs a 16–32 GB RAM VM (~$80–200/month), and live queries scale poorly with user count.
3. Commercial provider (MapTiler, Mapbox): fastest, but per-request pricing, vendor lock-in and license limits on caching and derived use.

Licensing note: the ODbL share-alike clause applies if we **publish a derived database**. Rendered views and simulations are "produced works" and only need attribution. Overture buildings are mixed-license (ODbL plus CDLA-Permissive). Keep source tags per feature.

## ADR-005: Backend stack and hosting — **Deferred (zero-cost constraint)**
No backend for now. Everything runs client-side: projects in localStorage, simulation in a Web Worker. Sharing will use URL-encoded scenarios first. A free-tier backend (e.g. Supabase free) needs owner approval before use.

Original analysis:
Node + Fastify, Postgres + PostGIS, Redis, and WebSockets (one room per project). Start as one service plus a managed database (~$30–80/month on Fly.io, Render or Railway). Split services only when load tests show it is needed.

## ADR-006: Scenario = immutable base + edit list — Accepted
This gives cheap undo/redo, original vs proposed, small saves (edits only), and a natural operation log for collaboration (operations can be rebased or CRDT-wrapped later).

## ADR-007: Simulation fidelity tiers — Accepted
Macro capacity from buildings, meso demand and trip generation, and micro agents capped by quality budget. Agent counts scale with device class. A larger synthetic population is represented statistically, not as individuals.

## ADR-008: Simulation in a Web Worker on wall-clock time — Accepted
The simulation runs in a dedicated worker and sends compact frames (Float32Array) back. Time advances on wall-clock time, not frame count, so slow GPUs don't slow the city. Worker failures fall back to inline simulation instead of freezing.

## ADR-009: 2D plan view as a first-class renderer — Accepted
Canvas2D implements the same `WorldRenderer` interface as the 3D engine (shared `ToolController`), so every planning feature works without WebGL.

## ADR-010: Transit riders as a lifecycle, not counters — Accepted
Riders pick a line serving both trip ends (≤ 700 m walk each), then walk, wait, board, ride, alight and walk on. Ridership numbers come from actual simulated boardings.
