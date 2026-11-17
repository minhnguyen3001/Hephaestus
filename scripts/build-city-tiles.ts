/**
 * Pre-build the 1 km tiles around each featured city as static files (public/tiles/<pack>/<i>_<j>.json),
 * so exploring beyond the centre is instant and doesn't depend on busy public servers.
 *
 *   npx tsx scripts/build-city-tiles.ts [reach=1] ["City name"]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { FEATURED } from '../src/geo/geocode';
import { buildOverpassQuery, OVERPASS_MIRRORS, packFile, slimElements, tileBounds } from '../src/geo/osm';
import { makeProjection } from '../src/geo/util';

const UA = 'Hephaestus-tile-builder/0.1 (open-source city planning sim)';
const reach = Number(process.argv[2] ?? 1);
const only = process.argv[3];

async function query(q: string): Promise<{ elements: unknown[] }> {
  for (let round = 1; round <= 3; round++) {
    for (const m of OVERPASS_MIRRORS) {
      try {
        const r = await fetch(`${m}?data=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) });
        if (r.ok) return (await r.json()) as { elements: unknown[] };
      } catch {
        /* try next mirror */
      }
    }
    await new Promise((res) => setTimeout(res, 30_000 * round));
  }
  throw new Error('all mirrors failed');
}

for (const place of FEATURED.filter((p) => !only || p.name === only)) {
  const center = { lat: place.lat, lon: place.lon };
  const dir = `public/tiles/${packFile(center).replace('.json', '')}`;
  mkdirSync(dir, { recursive: true });
  const proj = makeProjection(center);
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      if (!i && !j) continue; // the centre comes from the city pack
      const file = `${dir}/${i}_${j}.json`;
      if (existsSync(file)) continue;
      const b = tileBounds(i, j);
      const sw = proj.toLatLon([b.x0, b.y0]);
      const ne = proj.toLatLon([b.x1, b.y1]);
      const t0 = Date.now();
      try {
        const res = await query(buildOverpassQuery(center, 0, 'all', [sw.lat, sw.lon, ne.lat, ne.lon]));
        const json = JSON.stringify(slimElements(res.elements));
        writeFileSync(file, json);
        console.log(`${place.name} ${i},${j}: ${(json.length / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      } catch (e) {
        console.log(`${place.name} ${i},${j}: FAILED ${(e as Error).message}`);
      }
    }
  }
}
