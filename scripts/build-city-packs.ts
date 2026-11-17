/**
 * Data pipeline: pre-build compact OSM "city packs" for featured places, served as static files.
 * Featured cities then load instantly and reliably without touching public Overpass at runtime.
 *
 *   npx tsx scripts/build-city-packs.ts            # all featured cities
 *   npx tsx scripts/build-city-packs.ts "Shibuya"  # one city by name
 *
 * Data © OpenStreetMap contributors (ODbL). Packs keep only the tags the app uses.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { FEATURED } from '../src/geo/geocode';
import { buildOverpassQuery, OVERPASS_MIRRORS, PACK_RADIUS, packFile, slimElements, type PackIndexEntry } from '../src/geo/osm';

const UA = 'GlobalCitySimulator-pack-builder/0.1 (open-source city planning sim)';

async function query(q: string): Promise<{ elements: unknown[] }> {
  // Public servers are often busy: try every mirror, then back off and retry the whole round.
  for (let round = 1; round <= 3; round++) {
    for (const m of OVERPASS_MIRRORS) {
      try {
        const r = await fetch(`${m}?data=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) });
        if (r.ok) return (await r.json()) as { elements: unknown[] };
        console.warn(`  ${m} → ${r.status}`);
      } catch (e) {
        console.warn(`  ${m} → ${(e as Error).message}`);
      }
    }
    if (round < 3) await new Promise((res) => setTimeout(res, 30_000 * round));
  }
  throw new Error('all mirrors failed after 3 rounds');
}

const only = process.argv[2];
const indexPath = 'public/packs/index.json';
const index: PackIndexEntry[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];

for (const place of FEATURED.filter((p) => !only || p.name === only)) {
  const center = { lat: place.lat, lon: place.lon };
  const file = packFile(center);
  console.log(`${place.name} → ${file}`);
  const t0 = Date.now();
  const core = await query(buildOverpassQuery(center, PACK_RADIUS, 'core'));
  const extras = await query(buildOverpassQuery(center, PACK_RADIUS, 'extras'));
  const pack = { center, radius: PACK_RADIUS, builtAt: new Date().toISOString(), core: slimElements(core.elements), extras: slimElements(extras.elements) };
  const json = JSON.stringify(pack);
  writeFileSync(`public/packs/${file}`, json);
  const i = index.findIndex((e) => e.file === file);
  const entry = { name: place.name, lat: place.lat, lon: place.lon, radius: PACK_RADIUS, file, builtAt: pack.builtAt };
  if (i >= 0) index[i] = entry;
  else index.push(entry);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`  ${(json.length / 1e6).toFixed(1)} MB, ${pack.core.length + pack.extras.length} elements, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
