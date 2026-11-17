# Global City Simulator

*(repository: Hephaestus — working product name: Global City Simulator)*

A browser-based 3D city-building and urban-planning simulator built on **real-world geography**. Search almost any place on Earth, explore its actual streets and buildings in 3D, redesign them, and watch a living simulation of synthetic people, cars, motorbikes, buses and trains respond.

> Early preview (Phase 1). See [TODO.md](TODO.md) for what is and isn't done, and [HANDOFF.md](HANDOFF.md) for the current engineering state.

## What works today

- **Global search** for cities, streets, landmarks, or `lat, lon` coordinates (OpenStreetMap Nominatim).
- **Real-world 3D city** loaded live from OpenStreetMap: building footprints and heights, roads with lanes, water, parks, rail and elevated rail.
- **Honest data labels**: each building shows whether its height was *measured*, *derived from floor count*, *estimated*, or *changed by you*. A layer highlights all estimated data.
- **360° camera**: orbit, tilt, pan, zoom (mouse, touch, keyboard), aerial, district and street-level presets, double-click to orbit any building, follow any vehicle or person.
- **Planning tools**: place buildings, draw roads (snapping to intersections), bulldoze buildings and roads, change height and land use, undo and redo.
- **Scenarios**: real-world data stays untouched. Your proposal is a list of edits you can toggle against the **Original** city at any time. Projects autosave locally.
- **Living city simulation** (synthetic agents):
  - Trips are generated from building capacity: homes go to jobs, schools, shops and parks.
  - Trip timing follows a daily demand curve with morning and evening rush hours.
  - Travel mode is chosen from a **regional profile**: US car-heavy, Vietnam motorbike-heavy with lane filtering, Netherlands bicycle-heavy, Japan and UK left-hand traffic, and more.
  - Vehicles follow each other in lanes, queue, and stop at red lights (real OSM signals plus estimated ones). Congestion spills back across intersections.
  - Buses run generated routes with stops, dwell times and passenger boarding. Pedestrians walk to the stops.
  - Trains shuttle along real above-ground rail lines, including Chicago's elevated L.
- **Urban impact dashboard**: housing and job capacity, floor area, road length and buildings, compared before and after your edits, plus live traffic metrics.
- **Day/night cycle**: windows light up at night.
- **Adaptive graphics**: Low, Medium, High and Auto. Auto starts from device hints and drops resolution and shadows when the frame rate falls.
- Responsive layout for desktop, tablet and phone.

## Quick start

Prerequisites: **Node.js 20+** and npm. No API keys are required.

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | TypeScript only |
| `npm test` | Unit tests (Vitest): geo parsing, routing, edits, simulation |
| `npx playwright test` | End-to-end smoke test in a real browser (needs internet: loads live OSM data) |

The first time, `npx playwright install chromium` may be needed for the e2e test.

## Architecture (summary)

```
src/
  geo/       OSM/Overpass loading + parsing, geocoding, local projection, geometry utils
  sim/       Road graph + A* routing, regional profiles, agent simulation (pure TS, no rendering)
  project/   Scenario edit model (immutable base + edits, undo/redo), local persistence
  render/    three.js engine: merged/instanced geometry, picking, camera, tools, day/night, adaptive quality
  ui/        React UI: landing, workspace, inspector, dashboard, simulation controls
e2e/         Playwright smoke test
docs/        ARCHITECTURE.md, ROADMAP.md, DECISIONS.md (ADR log)
```

The simulation is fully separate from rendering, so it can move to a Web Worker or the server without changes. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Stack:** TypeScript, React 18, Vite 5, three.js (WebGL2), Vitest, Playwright. There is no backend yet.

## Geographic data and attribution

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), shown in the app.
- During development, data comes from the **public Overpass API** (with mirror failover), and search from the **public Nominatim** API. These public services have usage limits and **must not carry production traffic**. A self-hosted pipeline is planned before launch; see [docs/DECISIONS.md](docs/DECISIONS.md).
- Loaded areas are cached in the browser (Cache API), so revisiting a place is instant.

## Known limitations

- Terrain is flat for now. Elevation (DEM) is the next graphics priority.
- Water bodies and parks mapped as OSM *relations* (multipolygons) are not loaded yet, which means some large rivers and lakes are missing.
- Tunnels are hidden and excluded from the simulation. Bridges render at ground level.
- New roads only connect at their snapped endpoints, not where they cross existing roads.
- Bus routes are generated, not real GTFS routes. Mode shares are illustrative assumptions.
- There are no accounts, sharing or collaboration yet. Projects are stored in this browser only.
- The simulation runs on the main thread.
- **Simulation results are illustrative, not forecasts.** This is not a substitute for professional engineering or transport studies.

## Contributing

Run `npm run build && npm test` before committing. Keep simulation logic in `src/sim` free of three.js and DOM imports.

## License

BSD 3-Clause, see [LICENSE](LICENSE). Map data has its own license (ODbL).
