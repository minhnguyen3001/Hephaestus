import type { Building, Vec2, WorldData } from '../geo/types';
import { centroid, makeNear, signedArea } from '../geo/util';
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
  transitAccess: number; // share of residents within 400 m of a transit stop (rail/metro lines and drawn lines)
  parkAccess: number; // share of residents within 300 m of a park
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

/** Planning indicators derived from a scenario. All capacity figures are model estimates. */
export function cityMetrics(w: WorldData): CityMetrics {
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
  // Access points: drawn transit stops, plus vertices along mapped above-ground rail (a stand-in for stations).
  const stops: Vec2[] = (w.transitLines ?? []).flatMap((l) => l.stops);
  for (const r of w.rails) if (r.kind !== 'tram') for (let i = 0; i < r.points.length; i += 4) stops.push(r.points[i]);
  const parkPts: Vec2[] = w.areas.filter((a) => a.kind === 'park').flatMap((a) => a.polygon);
  const nearStop = makeNear(stops, 400);
  const nearPark = makeNear(parkPts, 300);
  let res = 0;
  let resTransit = 0;
  let resPark = 0;
  for (const b of w.buildings) {
    const { residents: r, c } = figures(b);
    if (!r) continue;
    res += r;
    if (nearStop(c)) resTransit += r;
    if (nearPark(c)) resPark += r;
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
    transitAccess: res ? resTransit / res : 0,
    parkAccess: res ? resPark / res : 0,
  };
}
