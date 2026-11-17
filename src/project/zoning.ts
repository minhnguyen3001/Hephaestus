import type { Area, Building, BuildingUse, Road, Vec2 } from '../geo/types';
import { centroid, hash01, pointInPolygon } from '../geo/util';

export type ZoneUse = 'residential' | 'commercial' | 'office' | 'mixed' | 'industrial' | 'park';
export type Density = 'low' | 'medium' | 'high';

export interface Zone {
  id: string;
  polygon: Vec2[];
  use: ZoneUse;
  density: Density;
  /** Replace existing buildings inside the zone (otherwise new buildings fill gaps only). */
  replace: boolean;
}

const FLOORS: Record<Density, [number, number]> = { low: [2, 4], medium: [5, 10], high: [14, 40] };
const LOT: Record<Density, number> = { low: 22, medium: 32, high: 42 };
const ROAD_CLEAR = 6; // setback from the carriageway edge

function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Dominant edge direction of the zone, so the lot grid lines up with the street pattern the user traced. */
function principalAngle(poly: Vec2[]): number {
  let best = 0;
  let bestLen = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > bestLen) {
      bestLen = l;
      best = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  return best;
}

export function buildingsInside(poly: Vec2[], buildings: Building[]): string[] {
  return buildings.filter((b) => pointInPolygon(centroid(b.footprint), poly)).map((b) => b.id);
}

/**
 * Fill a zone with proposed buildings on a rotated lot grid. Lots must lie fully inside the zone,
 * keep clear of streets, and (unless replacing) avoid existing buildings. Deterministic per zone id.
 */
export function developZone(zone: Zone, roads: Road[], existing: Building[]): { buildings: Building[]; park?: Area } {
  if (zone.use === 'park') return { buildings: [], park: { id: `zone-${zone.id}`, kind: 'park', polygon: zone.polygon } };
  const ang = principalAngle(zone.polygon);
  const [c, s] = [Math.cos(ang), Math.sin(ang)];
  const toLocal = ([x, y]: Vec2): Vec2 => [x * c + y * s, -x * s + y * c];
  const toWorld = ([u, v]: Vec2): Vec2 => [u * c - v * s, u * s + v * c];
  const local = zone.polygon.map(toLocal);
  const [u0, v0, u1, v1] = local.reduce(([a, b, cc, d], [u, v]) => [Math.min(a, u), Math.min(b, v), Math.max(cc, u), Math.max(d, v)], [Infinity, Infinity, -Infinity, -Infinity]);
  const lot = LOT[zone.density];
  const fill = 0.62; // building footprint share of the lot
  const nearRoads = roads.filter((r) => r.kind !== 'footway' && r.kind !== 'cycleway' && r.points.some((p) => pointInPolygon(p, zone.polygon) || zone.polygon.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 200)));
  const blockers = existing.map((b) => ({ c: centroid(b.footprint), r: Math.max(...b.footprint.map((p) => Math.hypot(p[0] - centroid(b.footprint)[0], p[1] - centroid(b.footprint)[1]))) }));
  const out: Building[] = [];
  let k = 0;
  for (let u = u0 + lot / 2; u <= u1 - lot / 2; u += lot) {
    for (let v = v0 + lot / 2; v <= v1 - lot / 2; v += lot) {
      const half = (lot * Math.sqrt(fill)) / 2;
      const cornersL: Vec2[] = [[u - half, v - half], [u + half, v - half], [u + half, v + half], [u - half, v + half]];
      const corners = cornersL.map(toWorld);
      const center = toWorld([u, v]);
      if (!corners.every((p) => pointInPolygon(p, zone.polygon))) continue;
      const clear = nearRoads.every((r) => {
        const hw = (r.lanes * 3.2) / 2 + ROAD_CLEAR + half;
        for (let i = 1; i < r.points.length; i++) if (segDist(center, r.points[i - 1], r.points[i]) < hw) return false;
        return true;
      });
      if (!clear) continue;
      if (!zone.replace && blockers.some((b) => Math.hypot(b.c[0] - center[0], b.c[1] - center[1]) < b.r + half)) continue;
      const id = `${zone.id}-${k++}`;
      const [fmin, fmax] = FLOORS[zone.density];
      const floors = Math.round(fmin + hash01(id) * (fmax - fmin));
      const use: BuildingUse = zone.use === 'mixed' ? (hash01(`${id}u`) < 0.6 ? 'residential' : 'commercial') : zone.use;
      out.push({
        id, footprint: corners, height: floors * 3.2 + 1, heightSource: 'user', use, useSource: 'user',
        origin: 'proposed', name: `Zoned ${zone.use} (${zone.density} density)`,
      });
    }
  }
  return { buildings: out };
}
