# Roadmap

Phases follow the product brief, re-ordered where dependencies require it. Current: **end of Phase 1 / start of Phase 2**.

## Phase 1: Functional 3D foundation (mostly done)
Done: landing and search, live OSM data, 3D city, 360° camera and presets, selection, inspection and orbit, building, road and bulldoze tools, undo/redo, original vs proposed, local projects and autosave, adaptive quality, responsive layout, first living-city slice (7 agent kinds, signals, buses, trains).
Remaining: terrain (DEM), OSM relations (rivers and lakes), simulation in a Web Worker, functional 2D fallback mode, more tutorial polish.

## Phase 2: Living city and transportation
Pedestrian crossings and pedestrians obeying signals, lane changes and turn lanes, parking, real GTFS transit where available (otherwise generated routes), passengers riding (not only counted), metro on tunnel geometry with stations, user-drawn bus and metro lines, emergency vehicles, events (closures, concerts), weekend and holiday profiles, more regional profiles.

## Phase 3: Advanced planning
Zoning brushes, polygon building and park drawing, road properties editor (lanes, one-way, speed), intersections splitting where roads cross, bridges and tunnels, utilities.

## Phase 4: Analytics and scenarios
Multiple named scenarios per project, side-by-side comparison, accessibility isochrones (walk, transit), congestion heatmaps, 5/10/20-year timeline projections (clearly labeled), challenges, and an optional AI assistant (pluggable, non-blocking).

## Phase 5: Multiplayer and scale (needs ADR-004/005 approval)
Accounts, cloud projects, sharing and permissions, real-time collaboration (op log over WebSocket), version history, load test to 1,000+ concurrent users with k6, monitoring.

## Phase 6: Global expansion and graphics
Production tile pipeline with global coverage, LOD tiles for wide areas, better procedural assets (roof shapes, facade styles by region), trees and street furniture, weather, education features, and a community library.

**Recommended re-ordering:** pull the ADR-004 geodata pipeline forward to the start of Phase 2. Every later phase (scale, wide areas, reliability) depends on not using public Overpass.
