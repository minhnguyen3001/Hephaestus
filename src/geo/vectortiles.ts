import { classifyRings, VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { lonLatToTile } from './terrain';
import type { LatLon, RoadKind, Vec2 } from './types';
import { makeProjection, signedArea } from './util';

/**
 * City ring: lightweight context out to ~5 km from OpenFreeMap vector tiles (OpenMapTiles schema,
 * © OpenMapTiles © OpenStreetMap contributors). Free, no key, served from a CDN. Used for viewing;
 * the detailed, editable, simulated zone comes from full OSM data near the camera.
 */
export const CONTEXT_RADIUS = 5000;
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14;

export interface ContextTile {
  key: string; // "x/y" at z14
  center: Vec2; // local metres
  buildings: { ring: Vec2[]; height: number; min: number }[];
  roads: { points: Vec2[]; kind: RoadKind }[];
  water: Vec2[][];
  green: Vec2[][];
}

const ROAD: Record<string, RoadKind> = {
  motorway: 'highway', trunk: 'highway', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
  minor: 'residential', service: 'service',
};

let tileUrl: Promise<string> | null = null;
function urlTemplate(): Promise<string> {
  tileUrl ??= fetch(TILEJSON).then((r) => r.json()).then((j: { tiles: string[] }) => j.tiles[0]);
  return tileUrl;
}

/** z14 tiles that intersect the circle of `radius` metres around the centre, nearest first. */
export function contextTileKeys(center: LatLon, radius = CONTEXT_RADIUS): { x: number; y: number; d: number }[] {
  const proj = makeProjection(center);
  const sw = proj.toLatLon([-radius, -radius]);
  const ne = proj.toLatLon([radius, radius]);
  const [x0, y1] = lonLatToTile(sw.lon, sw.lat, Z).map(Math.floor);
  const [x1, y0] = lonLatToTile(ne.lon, ne.lat, Z).map(Math.floor);
  const n = 2 ** Z;
  const out: { x: number; y: number; d: number }[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const lon = ((x + 0.5) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
      const [cx, cy] = proj.toLocal(lat, lon);
      const d = Math.hypot(cx, cy);
      if (d - 1500 < radius) out.push({ x, y, d });
    }
  return out.sort((a, b) => a.d - b.d);
}

export async function fetchContextTile(center: LatLon, x: number, y: number, signal?: AbortSignal): Promise<ContextTile> {
  const url = (await urlTemplate()).replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y));
  const cache = typeof caches !== 'undefined' ? await caches.open('gcs-ctx-v1').catch(() => null) : null;
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`context tile ${res.status}`);
    await cache?.put(url, res.clone()).catch(() => undefined);
  }
  return decodeContextTile(new Uint8Array(await res.arrayBuffer()), center, x, y);
}

/** Decode a vector tile into local-metre geometry (pure; testable). */
export function decodeContextTile(buf: Uint8Array, center: LatLon, x: number, y: number): ContextTile {
  const proj = makeProjection(center);
  const vt = new VectorTile(new Pbf(buf));
  const n = 2 ** Z;
  const toLocal = (px: number, py: number, extent: number): Vec2 => {
    const lon = ((x + px / extent) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) * 180) / Math.PI;
    return proj.toLocal(lat, lon);
  };
  const tile: ContextTile = { key: `${x}/${y}`, center: toLocal(2048, 2048, 4096), buildings: [], roads: [], water: [], green: [] };
  const polys = (layerName: string, each: (rings: Vec2[][], props: Record<string, unknown>) => void) => {
    const layer = vt.layers[layerName];
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3) continue;
      for (const poly of classifyRings(f.loadGeometry())) {
        each(poly.map((ring) => ring.map((p) => toLocal(p.x, p.y, layer.extent))), f.properties);
      }
    }
  };
  polys('building', (rings, p) => {
    const ring = rings[0].slice(0, -1);
    if (ring.length < 3 || Math.abs(signedArea(ring)) < 12) return;
    const height = Number(p.render_height) || 8;
    tile.buildings.push({ ring, height: Math.max(3, height), min: Number(p.render_min_height) || 0 });
  });
  polys('water', (rings) => tile.water.push(rings[0].slice(0, -1)));
  polys('park', (rings) => tile.green.push(rings[0].slice(0, -1)));
  polys('landcover', (rings, p) => {
    if (['grass', 'wood', 'forest'].includes(String(p.class))) tile.green.push(rings[0].slice(0, -1));
  });
  const tr = vt.layers.transportation;
  if (tr) {
    for (let i = 0; i < tr.length; i++) {
      const f = tr.feature(i);
      const kind = ROAD[String(f.properties.class)];
      if (f.type !== 2 || !kind || f.properties.brunnel === 'tunnel') continue;
      for (const line of f.loadGeometry()) if (line.length > 1) tile.roads.push({ points: line.map((p) => toLocal(p.x, p.y, tr.extent)), kind });
    }
  }
  return tile;
}
