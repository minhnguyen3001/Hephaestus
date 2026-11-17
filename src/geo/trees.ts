import type { Vec2, WorldData } from './types';
import { hash01, pointInPolygon, rng, signedArea } from './util';

export interface TreePoint {
  p: Vec2;
  mapped: boolean; // true = OSM natural=tree; false = illustrative park planting
  scale: number;
}

/**
 * Trees to draw: every mapped OSM tree, plus illustrative planting inside parks and woods
 * (deterministic, ~1 per 220 m²). Illustrative trees are flagged so the UI can say so.
 */
export function treePoints(w: WorldData, budget: number): TreePoint[] {
  const out: TreePoint[] = (w.trees ?? []).slice(0, budget).map((p, i) => ({ p, mapped: true, scale: 0.8 + hash01(`t${i}`) * 0.5 }));
  const parks = w.areas.filter((a) => a.kind === 'park');
  const total = parks.reduce((s, a) => s + Math.abs(signedArea(a.polygon)), 0);
  const left = budget - out.length;
  if (left <= 0 || total <= 0) return out;
  const density = Math.min(1 / 220, left / total);
  for (const a of parks) {
    const area = Math.abs(signedArea(a.polygon));
    const n = Math.floor(area * density);
    if (!n) continue;
    const r = rng(Math.floor(hash01(a.id) * 1e9));
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of a.polygon) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    for (let k = 0, tries = 0; k < n && tries < n * 4; tries++) {
      const p: Vec2 = [x0 + r() * (x1 - x0), y0 + r() * (y1 - y0)];
      if (!pointInPolygon(p, a.polygon) || a.holes?.some((h) => pointInPolygon(p, h))) continue;
      out.push({ p, mapped: false, scale: 0.7 + r() * 0.7 });
      k++;
    }
  }
  return out;
}
