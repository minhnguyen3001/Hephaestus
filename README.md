# Ptah

**Live demo:** https://minhnguyen3001.github.io/Ptah/

A browser-based 3D city-building and urban-planning simulator built on **real-world geography**. Search almost any place on Earth, explore its actual streets and buildings in 3D, redesign them, and watch a living simulation of synthetic people, cars, motorbikes, buses and trains respond.

> Early preview (Phase 1). See [TODO.md](TODO.md) for what is and isn't done, and [HANDOFF.md](HANDOFF.md) for the current engineering state.

## What works today

- **Global search**: cities, streets, landmarks, or `lat, lon` coordinates (OpenStreetMap Nominatim).
- **Real-world 3D city**, built from:
  - **OpenStreetMap**: building footprints and heights, roads with lanes, traffic signals, rail and elevated rail, water, parks, multipolygon relations, and **sea derived from coastlines**.
  - **Real terrain** from AWS Terrain Tiles, so hills look right in places like San Francisco and Hong Kong.
- **City packs**: featured cities ship as pre-built data packs. They load instantly and work offline.
- **Honest data labels**: each building's height is shown as *measured*, *from floor count*, *estimated* or *changed by you*. A layer highlights all estimated data.
- **360° camera**: orbit, tilt, pan and zoom by mouse, touch or keyboard. Aerial, district and street-level presets. Double-click to orbit a building. Follow any vehicle or person.
- **2D plan view**: a Canvas2D view with the same data, tools and simulation. It's used automatically on devices without WebGL.
- **Planning tools**:
  - Place buildings.
  - Draw roads. They form real intersections and T-junctions with existing streets.
  - Bulldoze buildings and roads, and change height and land use.
  - **Draw bus lines and elevated metro lines**, and set how often each one runs.
  - Undo and redo.
- **Scenarios**: real-world data stays untouched. Your proposal is a list of edits, toggled against the **Original** city. Projects autosave locally.
- **Living city simulation** (synthetic agents, run in a Web Worker):
  - **Trips**: generated from building capacity, so homes send people to jobs, schools, shops and parks. Timing follows a daily rush-hour demand curve.
  - **Regional travel modes**: the US is car-heavy, Vietnam is motorbike-heavy with lane filtering, the Netherlands is bicycle-heavy, and Japan and the UK drive on the left.
  - **Traffic**: vehicles follow each other in lanes, queue, stop at red lights and spill back. Traffic signals are visible, and pedestrians wait for the walk phase.
  - **Transit riders**: riders choose a line that serves both ends of their trip. They walk to the stop, wait, board, ride, get off and walk on. Trains run on real above-ground rail.
- **Urban impact dashboard**:
  - Housing and job capacity, floor area, road length and buildings, compared before and after your edits.
  - Live traffic metrics and per-line transit ridership.
  - A **traffic flow layer** colours roads by speed (the **Traffic** button in the sim bar).
  - **Pick a time of day** (now, morning rush, midday, evening rush, night) and the simulation re-seeds traffic for that hour.
  - A chart shows congestion by hour for the **real city and your proposal side by side**: run the same hours on Original and Proposed to compare.
- **Save image**: download a picture of the current view.
- **Day/night cycle**: windows light up at night.
- **Adaptive graphics**: Low, Medium, High and Auto.
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
| `npx playwright test` | End-to-end tests in a real browser (featured cities use bundled packs; terrain and search need internet) |
| `npx tsx scripts/build-city-packs.ts ["Name"]` | Rebuild static OSM data packs for featured cities into `public/packs/` |

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

**Stack:** TypeScript, React 18, Vite 5, three.js (WebGL2), Canvas2D, Web Workers, Vitest, Playwright. There is no backend; everything runs in the browser at zero hosting cost.

## Geographic data and attribution

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), shown in the app.
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (open data, free).
- **Featured cities** load from static packs in `public/packs/`, built by `scripts/build-city-packs.ts`. That makes them fast, reliable and free to serve.
- **Any other place** is loaded live from the free **public Overpass API**, with several mirrors and timeouts, and searched through **public Nominatim**. These services can be slow or busy, and their limits make them unsuitable for heavy production traffic. The project budget is $0, so the plan is to grow the static pack pipeline. See [docs/DECISIONS.md](docs/DECISIONS.md).
- Loaded areas and terrain are cached in the browser (Cache API).

## Known limitations

- Tunnels are hidden and excluded from the simulation. Bridges render at ground level.
- Very large water relations (over 500 members) are skipped. Lakes mapped as coastline (like the Great Lakes) work.
- Generated bus routes are not real GTFS routes. Mode shares are illustrative assumptions.
- No accounts, sharing or collaboration yet. Projects are stored in this browser only.
- Live Overpass loading of non-featured places can take 30–60 s when public servers are busy.
- **Simulation results are illustrative, not forecasts.** This is not a substitute for professional engineering or transport studies.

## Deployment

Every push to `main` builds and deploys to **GitHub Pages** for free, using `.github/workflows/pages.yml`. The production build uses the base path `/Ptah/`. To build the same thing locally, run `npm run build:pages`.

## Contributing

Run `npm run build && npm test` before committing. Keep simulation logic in `src/sim` free of three.js and DOM imports.

## License

BSD 3-Clause, see [LICENSE](LICENSE). Map data has its own license (ODbL).
