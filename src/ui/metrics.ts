import type { WorldData } from '../geo/types';
import { signedArea } from '../geo/util';
import { buildingCapacity } from '../sim/simulation';

export interface CityMetrics {
  buildings: number;
  residents: number;
  jobs: number;
  floorAreaKm2: number;
  greenHa: number;
  roadKm: number;
  estimatedHeights: number; // share 0..1
}

/** Planning indicators derived from a scenario. All capacity figures are model estimates. */
export function cityMetrics(w: WorldData): CityMetrics {
  let residents = 0;
  let jobs = 0;
  let fa = 0;
  let est = 0;
  for (const b of w.buildings) {
    const c = buildingCapacity(b);
    residents += c.residents;
    jobs += c.jobs;
    fa += Math.abs(signedArea(b.footprint)) * Math.max(1, Math.round(b.height / 3.2));
    if (b.heightSource === 'estimated') est++;
  }
  let green = 0;
  for (const a of w.areas) if (a.kind === 'park') green += Math.abs(signedArea(a.polygon));
  let road = 0;
  for (const r of w.roads) {
    if (r.kind === 'footway' || r.kind === 'cycleway') continue;
    for (let i = 1; i < r.points.length; i++) road += Math.hypot(r.points[i][0] - r.points[i - 1][0], r.points[i][1] - r.points[i - 1][1]);
  }
  return {
    buildings: w.buildings.length,
    residents: Math.round(residents),
    jobs: Math.round(jobs),
    floorAreaKm2: fa / 1e6,
    greenHa: green / 1e4,
    roadKm: road / 1000,
    estimatedHeights: w.buildings.length ? est / w.buildings.length : 0,
  };
}
