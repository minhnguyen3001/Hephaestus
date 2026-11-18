import type { LatLon } from './types';
import { makeProjection } from './util';

/**
 * Terrain heightfield in local meters, relative to the ground height at the project origin.
 * Source: AWS Terrain Tiles (Terrarium encoding, open data — SRTM/GMTED/NED/ETOPO and others),
 * free to use with attribution. Missing terrain falls back to flat ground, never to a failure.
 */
export interface Terrain {
  n: number; // grid is n x n
  extent: number; // grid spans [-extent, extent] meters on both axes
  heights: Float32Array; // row-major, row j at y = -extent + j * step
  min: number;
  max: number;
}

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ZOOM = 14; // default; wide areas use z13 (fewer tiles, still ~20 m pixels)

export function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const s = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * s, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s];
}

export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export function sampleTerrain(t: Terrain | undefined, x: number, y: number): number {
  if (!t) return 0;
  const n = t.n;
  const f = (n - 1) / (2 * t.extent);
  const gx = Math.min(n - 1.0001, Math.max(0, (x + t.extent) * f));
  const gy = Math.min(n - 1.0001, Math.max(0, (y + t.extent) * f));
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const fx = gx - i;
  const fy = gy - j;
  const H = t.heights;
  const a = H[j * n + i] + (H[j * n + i + 1] - H[j * n + i]) * fx;
  const b = H[(j + 1) * n + i] + (H[(j + 1) * n + i + 1] - H[(j + 1) * n + i]) * fx;
  return a + (b - a) * fy;
}

/** Build a local grid from any (lat, lon) → meters sampler. Heights are re-based so the origin sits at 0. */
export function buildTerrain(center: LatLon, extent: number, n: number, elevationAt: (lat: number, lon: number) => number): Terrain {
  const proj = makeProjection(center);
  const heights = new Float32Array(n * n);
  const step = (2 * extent) / (n - 1);
  const h0 = elevationAt(center.lat, center.lon);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ll = proj.toLatLon([-extent + i * step, -extent + j * step]);
      heights[j * n + i] = elevationAt(ll.lat, ll.lon) - h0;
    }
  }
  despike(heights, n);
  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  return { n, extent, heights, min, max };
}

async function loadTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ImageData> {
  const url = `${TERRARIUM_URL}/${z}/${x}/${y}.png`;
  const cache = typeof caches !== 'undefined' ? await caches.open('gcs-dem-v1').catch(() => null) : null;
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetch(url, { signal, mode: 'cors' });
    if (!res.ok) throw new Error(`terrain ${res.status}`);
    await cache?.put(url, res.clone()).catch(() => undefined);
  }
  // Elevation is encoded in exact RGB bytes: the browser must not colour-manage or premultiply them,
  // or a 1-step change in red becomes a 256 m spike.
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

/** Fetch DEM tiles covering the area and build the heightfield. Resolves undefined (flat) on any failure. */
export async function fetchTerrain(center: LatLon, radius: number, signal?: AbortSignal): Promise<Terrain | undefined> {
  try {
    const extent = radius * 1.35;
    const Z = extent > 3000 ? 13 : ZOOM;
    const proj = makeProjection(center);
    const sw = proj.toLatLon([-extent, -extent]);
    const ne = proj.toLatLon([extent, extent]);
    const [x0, y0] = lonLatToTile(sw.lon, sw.lat, Z).map(Math.floor);
    const [x1, y1] = lonLatToTile(ne.lon, ne.lat, Z).map(Math.floor);
    const tiles = new Map<string, ImageData>();
    const jobs: Promise<void>[] = [];
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        jobs.push(loadTile(Z, x, y, signal).then((img) => void tiles.set(`${x}/${y}`, img)));
    await Promise.all(jobs);
    const px = (img: ImageData, u: number, v: number) => {
      const k = (Math.min(255, Math.max(0, v)) * img.width + Math.min(255, Math.max(0, u))) * 4;
      return decodeTerrarium(img.data[k], img.data[k + 1], img.data[k + 2]);
    };
    const elevationAt = (lat: number, lon: number) => {
      const [tx, ty] = lonLatToTile(lon, lat, Z);
      const img = tiles.get(`${Math.floor(tx)}/${Math.floor(ty)}`);
      if (!img) return 0;
      const u = (tx - Math.floor(tx)) * 256 - 0.5;
      const v = (ty - Math.floor(ty)) * 256 - 0.5;
      const i = Math.floor(u);
      const j = Math.floor(v);
      const fx = u - i;
      const fy = v - j;
      const a = px(img, i, j) * (1 - fx) + px(img, i + 1, j) * fx;
      const b = px(img, i, j + 1) * (1 - fx) + px(img, i + 1, j + 1) * fx;
      return a * (1 - fy) + b * fy;
    };
    // ~15 m grid spacing, more samples as the loaded city grows (capped for memory)
    const t = buildTerrain(center, extent, Math.min(361, Math.max(161, Math.ceil((2 * extent) / 15) + 1)), elevationAt);
    // Treat sub-meter noise as flat so flat cities stay perfectly flat.
    return t.max - t.min < 1 ? undefined : t;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return undefined;
  }
}

/**
 * Remove isolated spikes and pits (bad DEM pixels): any sample more than 15 m away from the median
 * of its neighbours is replaced by that median. Real slopes change gradually, so they are untouched.
 */
export function despike(h: Float32Array, n: number, threshold = 15) {
  const src = h.slice();
  const nb: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      nb.length = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const x = i + di;
          const y = j + dj;
          if (x >= 0 && y >= 0 && x < n && y < n) nb.push(src[y * n + x]);
        }
      nb.sort((a, b) => a - b);
      const med = nb[nb.length >> 1];
      if (Math.abs(src[j * n + i] - med) > threshold) h[j * n + i] = med;
    }
  }
}
