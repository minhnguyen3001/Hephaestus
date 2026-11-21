# Ptah: Real-World City Simulator

![Status](https://img.shields.io/badge/status-under%20development-yellow)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![three.js](https://img.shields.io/badge/three.js-WebGL2-000000?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-build-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![cost](https://img.shields.io/badge/hosting-%240%20(GitHub%20Pages)-2ea44f)](https://minhnguyen3001.github.io/Ptah/)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

A browser-based **3D city-building and urban-planning simulator** built on **real-world geography**. Search almost any place on Earth, walk its real streets and buildings in 3D, redesign them, and watch a living simulation of people, cars, bikes, buses and trains react to your plan.

This is **Minh Nguyen's** project, built and hosted entirely with **free, open data and free services**.

**▶ Play it now: https://minhnguyen3001.github.io/Ptah/** (no install, no account; best in a recent Chrome or Edge on a desktop or laptop)

---

## Contents
1. [What you can do](#what-you-can-do)
2. [How to play (2-minute guide)](#how-to-play-2-minute-guide)
3. [Run it on your own computer](#run-it-on-your-own-computer)
4. [How it works](#how-it-works)
5. [Where the data comes from](#where-the-data-comes-from)
6. [Limits and honesty notes](#limits-and-honesty-notes)
7. [For developers](#for-developers)

---

## What you can do

| | |
| --- | --- |
| 🌍 **Explore any city** | Search a city, street, landmark or `lat, lon`. Eight featured cities load instantly: Chicago, Manhattan, Saigon, Amsterdam, Shibuya, San Francisco, Hong Kong and London. |
| 🏙️ **See it in 3D** | Real buildings, roads, rail, water, parks and hills, about 10 km across. You can also switch to a flat 2D plan. |
| 🛠️ **Redesign it** | Place or demolish buildings, draw roads, zone whole blocks, and draw bus and metro lines. Undo and redo work for everything. |
| 🚦 **Watch it live** | Thousands of simulated people drive, cycle, walk and ride transit. Traffic lights, jams and crowds happen as they would in the real city. |
| ⏰ **Pick a time** | Jump to the morning rush, midday, the evening rush or night, and see how traffic changes. |
| 📊 **Measure the impact** | Compare **Original** and **Proposed**: housing, jobs, walk access to transit and parks, and congestion by hour. |
| 🔗 **Share it** | Copy a link that contains your whole plan, or save a picture of the view. |

---

## How to play (2-minute guide)

1. **Open** https://minhnguyen3001.github.io/Ptah/ and click a featured city (for example **Chicago Loop**), or type any place in the search box.
2. **Look around.**
   - **Mouse:** left-drag to orbit, right-drag to pan, scroll to zoom.
   - **Touch:** one finger to orbit, two to pan or zoom.
   - **Keyboard:** `W A S D` to move, `Q`/`E` to turn, `R`/`F` to tilt, `+`/`-` to zoom.
   - The **City · Aerial · District · Street** buttons jump to preset views.
3. **Click anything** to inspect it: a building, a road, or a moving car or person (then press **Follow**).
4. **Change the city** with the toolbar on the left, or the number keys:

   | Key | Tool | What it does |
   | --- | --- | --- |
   | `1` | Select | Inspect things, and edit a building's height or use |
   | `2` | Place | Add a new building |
   | `3` | Draw | Draw a road; it joins existing streets automatically |
   | `4` | Bulldoze | Remove a building or road |
   | `5` | Transit | Click stops to draw a bus or metro line, then **Finish line** |
   | `6` | Zone | Draw an area to fill it with new homes, shops or offices |
   | `7` | Note | Pin a comment on the map |
   | `8` | Event | Start a concert or game crowd (it uses the real venue if there is one nearby) |

5. **Run the simulation** with the bar at the bottom.
   - Press ▶ or `Space` to play or pause, and choose a speed (1×–60×).
   - **Jump to…** sets the time of day, and **Traffic** colours streets green to red by speed.
6. **See the impact.** Open the **dashboard** on the right, and use **Original / Proposed** at the top to compare.
7. **Share** your plan with the **Share** button, which copies a link. Use **Save image** for a picture.

> 💡 If it feels slow, choose **Graphics: Low** or **Auto** in the top-right corner.

---

## Run it on your own computer

You only need this if you want to change the code. To play, use the link above.

**You need:** [Node.js 20 or newer](https://nodejs.org/) (it includes `npm`) and [Git](https://git-scm.com/). No API keys or accounts are needed.

```bash
# 1. Download the project
git clone https://github.com/minhnguyen3001/Ptah.git
cd Ptah

# 2. Install the libraries it uses (once)
npm install

# 3. Start it
npm run dev
```

Then open **http://localhost:5173** in your browser. Changes to the code show up straight away.

**Other useful commands:**

| Command | What it does |
| --- | --- |
| `npm test` | Run the unit tests |
| `npm run build` | Check types and build the production site into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npx playwright install chromium` | One-time setup for the browser tests |
| `npx playwright test e2e/smoke.spec.ts` | Run the browser tests (needs internet) |

---

## How it works

```
 Real-world data (OpenStreetMap, terrain, vector tiles)
          │  loaded in the browser, cached, parsed in a background thread
          ▼
 World model ──► your edits (a list on top of the untouched real city)
          │
          ├──► 3D renderer (three.js / WebGL2) or 2D plan (Canvas)
          └──► Simulation (Web Worker): trips, traffic, transit, signals
                     │
                     ▼
              Dashboard, advisor and charts
```

- **No server.** Everything runs in your browser, and the site is static files on GitHub Pages. That's why hosting costs $0.
- **The real city is never changed.** Your plan is a list of edits laid on top of it, so **Original vs Proposed** is a single click, and a share link is just that list, compressed.
- **The simulation runs in a background thread** (a Web Worker), so the 3D view stays smooth.

Code layout:

| Folder | Contents |
| --- | --- |
| `src/geo/` | Loading and parsing map data, terrain, tiles, the walking network |
| `src/sim/` | Road graph, routing and the agent simulation (plain TypeScript, no graphics) |
| `src/project/` | The edit model, undo/redo, saving and share links |
| `src/render/` | The 3D engine, the 2D plan view and the editing tools |
| `src/ui/` | Screens, panels, the dashboard, the advisor and the tour |
| `public/` | Pre-built data for the featured cities |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md), [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

---

## Where the data comes from

| Data | Source | License |
| --- | --- | --- |
| Buildings, roads, rail, water, parks, venues | [OpenStreetMap](https://www.openstreetmap.org/copyright) via the public Overpass API | ODbL |
| Wider city around you (the outer ring) | [OpenFreeMap](https://openfreemap.org/) vector tiles | ODbL / OpenMapTiles |
| Hills and terrain | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Open data |
| Place search | OpenStreetMap Nominatim | ODbL |

Featured cities ship as pre-built files, so they load fast without busy public servers. Other places load live, which can take 30–120 seconds per area when those servers are busy.

---

## Limits and honesty notes

- **Simulation results are illustrative, not forecasts.** The people are synthetic, and travel habits per country are assumptions. Don't use it as a substitute for professional traffic or planning studies.
- Estimated data is labelled. A building height can be *measured*, *from floor count*, *estimated* or *changed by you*, and a layer highlights the estimates.
- Buildings in the outer ring are for viewing only. Click **Load detail here** to make that area editable.
- Generated bus routes aren't real timetables. Mapped subway lines use distinct but not official colours.
- Plans are saved in your browser only. Use a share link to move a plan to another device.

---

## For developers

- Engineering state and next steps: [HANDOFF.md](HANDOFF.md) and [TODO.md](TODO.md).
- Before committing, run `npm run build && npm test`. Keep `src/sim` free of three.js and DOM code.
- Every push to `main` is tested and deployed automatically to GitHub Pages (`.github/workflows/pages.yml`, base path `/Ptah/`). To build the same thing locally, run `npm run build:pages`.

## License

Code: BSD 3-Clause (see [LICENSE](LICENSE)). Map data keeps its own licenses (see above).
