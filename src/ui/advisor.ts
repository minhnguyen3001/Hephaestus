import type { Vec2, WorldData } from '../geo/types';
import { centroid, makeNear } from '../geo/util';
import { buildingCapacity, type SimStats } from '../sim/simulation';
import type { CityMetrics } from './metrics';

export interface Insight {
  id: string;
  severity: 'high' | 'medium' | 'info';
  title: string;
  detail: string;
  /** Where to look (local meters), if the insight is about a place. */
  at?: Vec2;
}

/** Group points onto a coarse grid and return the heaviest cell centre. */
function hotspot(points: { p: Vec2; w: number }[], cell = 250): { p: Vec2; w: number } | null {
  const cells = new Map<string, { x: number; y: number; w: number }>();
  for (const { p, w } of points) {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    const c = cells.get(k) ?? { x: 0, y: 0, w: 0 };
    c.x += p[0] * w;
    c.y += p[1] * w;
    c.w += w;
    cells.set(k, c);
  }
  let best: { p: Vec2; w: number } | null = null;
  for (const c of cells.values()) if (!best || c.w > best.w) best = { p: [c.x / c.w, c.y / c.w], w: c.w };
  return best;
}

/**
 * A rule-based planning advisor: free, offline and explainable. It reads the scenario and live
 * simulation and points at concrete problems. (An optional LLM could rephrase these later.)
 */
export function advise(w: WorldData, m: CityMetrics, o: CityMetrics, stats: SimStats | null, roadSpeed: Map<string, number>): Insight[] {
  const out: Insight[] = [];
  const stops: Vec2[] = (w.transitLines ?? []).flatMap((l) => l.stops);
  for (const r of w.rails) if (r.kind !== 'tram') for (let i = 0; i < r.points.length; i += 4) stops.push(r.points[i]);
  const parks: Vec2[] = w.areas.filter((a) => a.kind === 'park').flatMap((a) => a.polygon);
  const nearStop = makeNear(stops, 400);
  const nearPark = makeNear(parks, 300);

  const homes = w.buildings
    .map((b) => ({ p: centroid(b.footprint), w: buildingCapacity(b).residents }))
    .filter((h) => h.w > 0);

  if (m.transitAccess < 0.6) {
    const far = hotspot(homes.filter((h) => !nearStop(h.p)));
    if (far) {
      out.push({
        id: 'transit-gap', severity: m.transitAccess < 0.35 ? 'high' : 'medium',
        title: `${Math.round((1 - m.transitAccess) * 100)}% of residents are far from transit`,
        detail: `About ${Math.round(far.w).toLocaleString()} people live around this spot with no stop within 400 m. A bus line (Transit tool) through here would reach them.`,
        at: far.p,
      });
    }
  }
  if (m.parkAccess < 0.5) {
    const far = hotspot(homes.filter((h) => !nearPark(h.p)));
    if (far) {
      out.push({
        id: 'park-gap', severity: 'medium',
        title: 'A park desert',
        detail: `Residents here are more than 300 m from green space. Zoning a small park nearby (Zone tool → Park) would help ~${Math.round(far.w).toLocaleString()} people.`,
        at: far.p,
      });
    }
  }
  // Congestion: the slowest well-used road.
  let worst: { id: string; r: number } | null = null;
  for (const [id, r] of roadSpeed) if (r < 0.35 && (!worst || r < worst.r)) worst = { id, r };
  if (stats && stats.congestion > 0.3 && worst) {
    const road = w.roads.find((x) => x.id === worst!.id);
    if (road) {
      out.push({
        id: 'jam', severity: stats.congestion > 0.45 ? 'high' : 'medium',
        title: `Traffic is crawling on ${road.name ?? 'this street'}`,
        detail: `Vehicles here move at ${Math.round(worst.r * 100)}% of the limit. Options: add lanes (select the road), add a parallel link, or give people a transit alternative. Turn on the Traffic flow layer to see the pattern.`,
        at: road.points[Math.floor(road.points.length / 2)],
      });
    }
  }
  const ratio = m.residents / Math.max(1, m.jobs);
  if (ratio < 0.3) {
    out.push({
      id: 'imbalance', severity: 'info',
      title: 'Many jobs, few homes',
      detail: `There are ${(1 / Math.max(ratio, 0.01)).toFixed(1)} jobs per resident here, so most workers commute in. Zoning mixed-use or residential blocks shortens trips.`,
    });
  }
  if (m.residents < o.residents) {
    out.push({ id: 'housing-loss', severity: 'medium', title: 'This plan removes housing', detail: `Housing capacity is ${Math.round(o.residents - m.residents).toLocaleString()} lower than today.` });
  }
  if (m.estimatedHeights > 0.5) {
    out.push({
      id: 'data', severity: 'info', title: 'Many building heights are estimated',
      detail: `${Math.round(m.estimatedHeights * 100)}% of heights here are not mapped, so capacity figures are rougher. Turn on “Highlight estimated data” to see where.`,
    });
  }
  if (!out.length) out.push({ id: 'ok', severity: 'info', title: 'No major issues spotted', detail: 'Transit and park access look good and traffic is flowing. Try a challenge, or compare a bolder scenario.' });
  return out;
}
