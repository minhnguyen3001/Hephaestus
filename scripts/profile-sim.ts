/** Dev tool: time simulation setup and ticks on a city pack. Usage: npx tsx scripts/profile-sim.ts [pack.json] [maxAgents] */
import { readFileSync } from 'node:fs';
import { parseOverpass } from '../src/geo/osm';
import { profileFor } from '../src/sim/region';
import { Simulation } from '../src/sim/simulation';
const pack = JSON.parse(readFileSync(process.argv[2] ?? 'public/packs/40.7549_-73.9840.json', 'utf8'));
const w = parseOverpass({ elements: pack.core }, pack.center, 850);
w.areas = parseOverpass({ elements: pack.extras }, pack.center, 850).areas;
w.stations = parseOverpass({ elements: pack.stations ?? [] }, pack.center, 850).stations;
console.log('buildings', w.buildings.length, 'stations', w.stations?.length);
let t = performance.now();
const sim = new Simulation(w, profileFor('us'), +(process.argv[3] ?? 900));
console.log('init', (performance.now() - t).toFixed(0), 'ms; lines', sim.stats().lines.length);
for (let i = 0; i < 10; i++) {
  t = performance.now();
  sim.step(0.1);
  console.log('tick', i, (performance.now() - t).toFixed(0), 'ms, agents', sim.agents.length);
}
