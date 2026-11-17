import type { LatLon, Vec2 } from './types';

const M_PER_DEG_LAT = 110574;

/** Local tangent-plane projection. Accurate to well under 1% within a few km of the origin. */
export function makeProjection(origin: LatLon) {
  const mPerDegLon = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return {
    toLocal: (lat: number, lon: number): Vec2 => [(lon - origin.lon) * mPerDegLon, (lat - origin.lat) * M_PER_DEG_LAT],
    toLatLon: ([x, y]: Vec2): LatLon => ({ lat: origin.lat + y / M_PER_DEG_LAT, lon: origin.lon + x / mPerDegLon }),
  };
}

/** Signed area (positive = counter-clockwise with y pointing north). */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p[0];
    y += p[1];
  }
  return [x / poly.length, y / poly.length];
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Deterministic hash of a string to [0, 1). Used for stable per-object variation. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Seeded PRNG (mulberry32) so simulations are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted sampler over cumulative weights. */
export function makeSampler<T>(items: T[], weight: (t: T) => number) {
  const cum: number[] = [];
  let total = 0;
  for (const it of items) {
    total += Math.max(0, weight(it));
    cum.push(total);
  }
  return {
    total,
    sample(r: number): T | undefined {
      if (total <= 0) return undefined;
      const x = r * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] > x) hi = mid;
        else lo = mid + 1;
      }
      return items[lo];
    },
  };
}

/** Fast "is any point within r?" queries via a uniform grid (cell = r). */
export function makeNear(points: Vec2[], r: number) {
  const grid = new Map<string, Vec2[]>();
  for (const p of points) {
    const k = `${Math.floor(p[0] / r)},${Math.floor(p[1] / r)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  return (p: Vec2): boolean => {
    const cx = Math.floor(p[0] / r);
    const cy = Math.floor(p[1] / r);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < r) return true;
    return false;
  };
}
