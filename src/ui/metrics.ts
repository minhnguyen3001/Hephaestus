import type { Building, Road, Vec2, WorldData } from '../geo/types';
import { centroid, signedArea } from '../geo/util';
import { walkReach } from '../geo/walk';
import { buildingCapacity } from '../sim/simulation';

export interface CityMetrics {
  buildings: number;
  residents: number;
  jobs: number;
  floorAreaKm2: number;
  greenHa: number;
  roadKm: number;
  bikeKm: number;
  estimatedHeights: number; // share 0..1
  transitAccess: number; // share of residents within a 400 m walk of a station or drawn transit stop
  parkAccess: number; // share of residents within a 300 m walk of a park
}


// Buildings are immutable and shared between merges and scenarios, so their per-building figures are cached.
const perBuilding = new WeakMap<Building, { residents: number; jobs: number; fa: number; c: Vec2 }>();
function figures(b: Building) {
  let f = perBuilding.get(b);
  if (!f) {
    const cap = buildingCapacity(b);
    f = { residents: cap.residents, jobs: cap.jobs, fa: Math.abs(signedArea(b.footprint)) * Math.max(1, Math.round(b.height / 3.2)), c: centroid(b.footprint) };
    perBuilding.set(b, f);
  }
  return f;
}

export interface Access {
  transit: number;
  park: number;
}

/** Everything the walk-access calculation needs, in a compact form that's cheap to send to a worker. */
export interface AccessJob {
  homes: Float64Array; // x, y, residents per residential building
  roads: Pick<Road, 'id' | 'nodes' | 'points' | 'kind' | 'tunnel'>[];
  stops: Vec2[];
  parks: Vec2[];
}

export function accessJob(w: WorldData): AccessJob {
  const homes: number[] = [];
  for (const b of w.buildings) {
    const f = figures(b);
    if (f.residents) homes.push(f.c[0], f.c[1], f.residents);
  }
  // Access points: drawn transit stops plus mapped stations (or, without station data, points along mapped rail).
  const stops: Vec2[] = (w.transitLines ?? []).flatMap((l) => l.stops);
  if (w.stations?.length) stops.push(...w.stations.map((s) => s.p));
  else for (const r of w.rails) if (r.kind !== 'tram') for (let i = 0; i < r.points.length; i += 4) stops.push(r.points[i]);
  // park edges, thinned to a point every ~40 m (detailed outlines have thousands of vertices)
  const parks: Vec2[] = [];
  for (const a of w.areas) {
    if (a.kind !== 'park') continue;
    let last: Vec2 | null = null;
    for (const p of a.polygon) if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 40) parks.push((last = p));
  }
  return { homes: new Float64Array(homes), roads: w.roads.map((r) => ({ id: r.id, nodes: r.nodes, points: r.points, kind: r.kind, tunnel: r.tunnel })), stops, parks };
}

/** Share of residents within a 400 m walk of transit and a 300 m walk of a park, along the street network. */
export function computeAccess(job: AccessJob): Access {
  const roads = job.roads as Road[];
  const nearStop = walkReach(roads, job.stops, 400);
  const nearPark = walkReach(roads, job.parks, 300);
  let res = 0;
  let t = 0;
  let p = 0;
  const h = job.homes;
  for (let i = 0; i < h.length; i += 3) {
    const c: Vec2 = [h[i], h[i + 1]];
    res += h[i + 2];
    if (nearStop(c)) t += h[i + 2];
    if (nearPark(c)) p += h[i + 2];
  }
  return { transit: res ? t / res : 0, park: res ? p / res : 0 };
}

/**
 * Planning indicators derived from a scenario. All capacity figures are model estimates.
 * Walk access is slower to compute, so it's passed in (worked out off the main thread); NaN until known.
 */
export function cityMetrics(w: WorldData, access?: Access | null): CityMetrics {
  let residents = 0;
  let jobs = 0;
  let fa = 0;
  let est = 0;
  for (const b of w.buildings) {
    const f = figures(b);
    residents += f.residents;
    jobs += f.jobs;
    fa += f.fa;
    if (b.heightSource === 'estimated') est++;
  }
  let green = 0;
  for (const a of w.areas) if (a.kind === 'park') green += Math.abs(signedArea(a.polygon));
  let road = 0;
  let bike = 0;
  for (const r of w.roads) {
    let l = 0;
    for (let i = 1; i < r.points.length; i++) l += Math.hypot(r.points[i][0] - r.points[i - 1][0], r.points[i][1] - r.points[i - 1][1]);
    if (r.kind === 'cycleway' || r.bikeLane) bike += l;
    if (r.kind !== 'footway' && r.kind !== 'cycleway') road += l;
  }
  return {
    buildings: w.buildings.length,
    residents: Math.round(residents),
    jobs: Math.round(jobs),
    floorAreaKm2: fa / 1e6,
    greenHa: green / 1e4,
    roadKm: road / 1000,
    bikeKm: bike / 1000,
    estimatedHeights: w.buildings.length ? est / w.buildings.length : 0,
    transitAccess: access ? access.transit : NaN,
    parkAccess: access ? access.park : NaN,
  };
}

/** Metrics with walk access worked out right here (tests, scripts). */
export const cityMetricsSync = (w: WorldData): CityMetrics => cityMetrics(w, computeAccess(accessJob(w)));
