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
const ZOOM = 14;

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
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ll = proj.toLatLon([-extent + i * step, -extent + j * step]);
      const h = elevationAt(ll.lat, ll.lon) - h0;
      heights[j * n + i] = h;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  return { n, extent, heights, min, max };
}

async function loadTile(x: number, y: number, signal?: AbortSignal): Promise<ImageData> {
  const url = `${TERRARIUM_URL}/${ZOOM}/${x}/${y}.png`;
  const cache = typeof caches !== 'undefined' ? await caches.open('gcs-dem-v1').catch(() => null) : null;
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetch(url, { signal, mode: 'cors' });
    if (!res.ok) throw new Error(`terrain ${res.status}`);
    await cache?.put(url, res.clone()).catch(() => undefined);
  }
  const bmp = await createImageBitmap(await res.blob());
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

/** Fetch DEM tiles covering the area and build the heightfield. Resolves undefined (flat) on any failure. */
export async function fetchTerrain(center: LatLon, radius: number, signal?: AbortSignal): Promise<Terrain | undefined> {
  try {
    const extent = radius * 1.35;
    const proj = makeProjection(center);
    const sw = proj.toLatLon([-extent, -extent]);
    const ne = proj.toLatLon([extent, extent]);
    const [x0, y0] = lonLatToTile(sw.lon, sw.lat, ZOOM).map(Math.floor);
    const [x1, y1] = lonLatToTile(ne.lon, ne.lat, ZOOM).map(Math.floor);
    const tiles = new Map<string, ImageData>();
    const jobs: Promise<void>[] = [];
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        jobs.push(loadTile(x, y, signal).then((img) => void tiles.set(`${x}/${y}`, img)));
    await Promise.all(jobs);
    const px = (img: ImageData, u: number, v: number) => {
      const k = (Math.min(255, Math.max(0, v)) * img.width + Math.min(255, Math.max(0, u))) * 4;
      return decodeTerrarium(img.data[k], img.data[k + 1], img.data[k + 2]);
    };
    const elevationAt = (lat: number, lon: number) => {
      const [tx, ty] = lonLatToTile(lon, lat, ZOOM);
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
    const t = buildTerrain(center, extent, 161, elevationAt);
    // Treat sub-meter noise as flat so flat cities stay perfectly flat.
    return t.max - t.min < 1 ? undefined : t;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return undefined;
  }
}
