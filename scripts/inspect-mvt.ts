/** Dev tool: list layers and sample features of a vector tile. Usage: npx tsx scripts/inspect-mvt.ts tile.pbf */
import { readFileSync } from 'node:fs';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
const t = new VectorTile(new Pbf(readFileSync(process.argv[2])));
for (const [name, layer] of Object.entries(t.layers)) {
  const f = layer.length ? layer.feature(0) : null;
  console.log(name, layer.length, 'extent', layer.extent, f ? JSON.stringify(f.properties).slice(0, 160) : '');
}
