import { describe, expect, it } from 'vitest';
import { parseOverpass, classifyUse, parseHeight } from '../geo/osm';
import { makeProjection, signedArea } from '../geo/util';
import { parseCoordinates } from '../geo/geocode';
import { applyEdits, pushEdit, redo, undo, type History } from '../project/edits';
import { RoadGraph } from './graph';
import { profileFor } from './region';
import { demandAt, Simulation } from './simulation';
import type { LatLon } from '../geo/types';

const C: LatLon = { lat: 41.88, lon: -87.63 };
const M = 1 / 110574; // ~1 m in degrees latitude
const LON_M = 1 / (111320 * Math.cos((C.lat * Math.PI) / 180));

/** A 5x5 street grid (100 m blocks) with one building per block, built as raw Overpass JSON. */
function gridFixture() {
  const elements: unknown[] = [];
  const node = (i: number, j: number) => i * 10 + j + 1;
  const ll = (i: number, j: number) => ({ lat: C.lat + (j * 100 - 200) * M, lon: C.lon + (i * 100 - 200) * LON_M });
  let wid = 1000;
  for (let i = 0; i < 5; i++) {
    const ids = [0, 1, 2, 3, 4].map((j) => node(i, j));
    elements.push({ type: 'way', id: wid++, nodes: ids, geometry: [0, 1, 2, 3, 4].map((j) => ll(i, j)), tags: { highway: i === 2 ? 'primary' : 'residential' } });
    const ids2 = [0, 1, 2, 3, 4].map((j) => node(j, i));
    elements.push({ type: 'way', id: wid++, nodes: ids2, geometry: [0, 1, 2, 3, 4].map((j) => ll(j, i)), tags: { highway: i === 2 ? 'secondary' : 'residential' } });
  }
  let nid = 5000;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const corners = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]].map(([a, b]) => ll(i + a, j + b));
      const ids = [nid, nid + 1, nid + 2, nid + 3];
      nid += 4;
      const use = (i + j) % 2 ? 'apartments' : 'office';
      elements.push({ type: 'way', id: wid++, nodes: [...ids, ids[0]], geometry: [...corners, corners[0]], tags: { building: use, 'building:levels': '6' } });
    }
  elements.push({ type: 'node', id: node(2, 2), tags: { highway: 'traffic_signals' } });
  return parseOverpass({ elements } as never, C, 300);
}

describe('geo', () => {
  it('projects round-trip within centimeters', () => {
    const p = makeProjection(C);
    const local = p.toLocal(C.lat + 0.005, C.lon - 0.004);
    const back = p.toLatLon(local);
    expect(back.lat).toBeCloseTo(C.lat + 0.005, 7);
    expect(back.lon).toBeCloseTo(C.lon - 0.004, 7);
  });

  it('parses coordinates in search', () => {
    expect(parseCoordinates('41.88, -87.63')?.lat).toBe(41.88);
    expect(parseCoordinates('Chicago')).toBeNull();
    expect(parseCoordinates('95, 10')).toBeNull();
  });

  it('labels heights by source and never invents an observed height', () => {
    expect(parseHeight({ building: 'yes', height: '42' }, 'unknown', 'a').source).toBe('osm-height');
    expect(parseHeight({ building: 'yes', 'building:levels': '10' }, 'unknown', 'a')).toEqual({ height: 33, source: 'osm-levels' });
    expect(parseHeight({ building: 'yes' }, 'unknown', 'a').source).toBe('estimated');
    expect(classifyUse({ building: 'yes', shop: 'bakery' }).use).toBe('commercial');
    expect(classifyUse({ building: 'yes' })).toEqual({ use: 'unknown', source: 'estimated' });
  });

  it('parses an Overpass response into buildings, roads and signals', () => {
    const w = gridFixture();
    expect(w.roads).toHaveLength(10);
    expect(w.buildings).toHaveLength(16);
    expect(w.signalNodes).toEqual(['n23']);
    expect(Math.abs(signedArea(w.buildings[0].footprint))).toBeGreaterThan(3000);
  });
});

describe('road graph', () => {
  it('routes across the grid and respects one-way streets', () => {
    const w = gridFixture();
    const g = RoadGraph.build(w.roads);
    const a = g.index.get('n1')!;
    const b = g.index.get('n45')!;
    const path = g.route(a, b, 'car')!;
    expect(path.length).toBeGreaterThanOrEqual(8);
    expect(g.edges[path[0]].from).toBe(a);
    expect(g.edges[path[path.length - 1]].to).toBe(b);

    const oneway = RoadGraph.build([{ ...w.roads[0], oneway: true }]);
    const s = oneway.index.get(w.roads[0].nodes[0])!;
    const t = oneway.index.get(w.roads[0].nodes[4])!;
    expect(oneway.route(s, t, 'car')).not.toBeNull();
    expect(oneway.route(t, s, 'car')).toBeNull();
    expect(oneway.route(t, s, 'walk')).not.toBeNull();
  });

  it('finds the nearest node', () => {
    const g = RoadGraph.build(gridFixture().roads);
    const n = g.nearestNode([3, -4], 'car');
    expect(g.nodes[n].id).toBe('n23');
  });
});

describe('scenario edits', () => {
  it('applies edits without mutating the base and supports undo/redo', () => {
    const base = gridFixture();
    const id = base.buildings[0].id;
    let h: History = { edits: [], redo: [] };
    h = pushEdit(h, { kind: 'setHeight', id, height: 120 });
    h = pushEdit(h, { kind: 'demolish', id: base.buildings[1].id });
    const proposed = applyEdits(base, h.edits);
    expect(proposed.buildings.find((b) => b.id === id)!.height).toBe(120);
    expect(proposed.buildings.find((b) => b.id === id)!.heightSource).toBe('user');
    expect(proposed.buildings).toHaveLength(15);
    expect(base.buildings).toHaveLength(16);
    h = undo(h);
    expect(applyEdits(base, h.edits).buildings).toHaveLength(16);
    h = redo(h);
    expect(h.edits).toHaveLength(2);
  });
});

describe('simulation', () => {
  it('has rush-hour peaks', () => {
    expect(demandAt(8.2)).toBeGreaterThan(0.9);
    expect(demandAt(3)).toBeLessThan(0.2);
  });

  it('picks regional profiles and driving side', () => {
    expect(profileFor('vn').motorcycleFiltering).toBe(true);
    expect(profileFor('jp').driveSide).toBe('left');
    expect(profileFor('ph').driveSide).toBe('right');
    expect(profileFor('').id).toBe('default');
  });

  it('spawns origin-destination trips and moves agents along the network', () => {
    const w = gridFixture();
    const sim = new Simulation(w, profileFor('us'), 120, 7);
    expect(sim.totals.residents).toBeGreaterThan(100);
    expect(sim.totals.jobs).toBeGreaterThan(100);
    sim.step(0.1);
    expect(sim.agents.length).toBeGreaterThan(50);
    const before = new Map(sim.agents.map((a) => [a.id, [a.x, a.y]]));
    sim.step(5);
    const moved = sim.agents.filter((a) => {
      const p = before.get(a.id);
      return p && Math.hypot(a.x - p[0], a.y - p[1]) > 1;
    });
    expect(moved.length).toBeGreaterThan(10);
    for (const a of sim.agents) {
      expect(Math.abs(a.x)).toBeLessThan(400);
      expect(Math.abs(a.y)).toBeLessThan(400);
    }
    sim.step(600);
    expect(sim.stats().tripsCompleted).toBeGreaterThan(20);
  });

  it('warms up in bounded batches so no single tick stalls', () => {
    const sim = new Simulation(gridFixture(), profileFor('us'), 900, 2);
    const buses = sim.agents.length;
    sim.step(0.25);
    expect(sim.agents.length - buses).toBeLessThanOrEqual(60);
    sim.step(5);
    expect(sim.agents.length - buses).toBeGreaterThan(100);
  });

  it('exposes signal heads and per-road speed ratios', () => {
    const sim = new Simulation(gridFixture(), profileFor('us'), 150, 4);
    expect(sim.signalApproaches().length).toBeGreaterThanOrEqual(3);
    sim.step(30);
    const { ids, ratio } = sim.roadSpeeds();
    expect(ids.length).toBeGreaterThan(0);
    for (const r of ratio) expect(r).toBeGreaterThanOrEqual(0), expect(r).toBeLessThanOrEqual(1);
  });

  it('stops cars at red lights', () => {
    const w = gridFixture();
    const sim = new Simulation(w, profileFor('us'), 10, 3);
    const g = sim.graph;
    const sig = g.index.get('n23')!;
    const inc = g.edges.filter((e) => e.to === sig && e.car);
    const t = [...Array(64).keys()].find((t) => sim.signalState(inc[0], t) === 'red')!;
    const t2 = [...Array(64).keys()].find((t) => sim.signalState(inc[0], t) === 'green')!;
    expect(t).toBeDefined();
    expect(t2).toBeDefined();
    // perpendicular approaches never both green
    const perp = inc.find((e) => Math.abs(e.dir[0] * inc[0].dir[0] + e.dir[1] * inc[0].dir[1]) < 0.3)!;
    for (let s = 0; s < 64; s++) expect(sim.signalState(inc[0], s) === 'green' && sim.signalState(perp, s) === 'green').toBe(false);
  });
});

describe('terrain', () => {
  it('decodes Terrarium pixels and maps tiles', async () => {
    const { decodeTerrarium, lonLatToTile } = await import('../geo/terrain');
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 100, 128)).toBe(100.5);
    const [x, y] = lonLatToTile(0, 0, 1);
    expect([x, y]).toEqual([1, 1]);
  });

  it('builds a heightfield re-based at the origin and samples it bilinearly', async () => {
    const { buildTerrain, sampleTerrain } = await import('../geo/terrain');
    const proj = makeProjection(C);
    // A plane rising 10 m per 100 m to the east, 50 m above sea level at the origin.
    const t = buildTerrain(C, 500, 21, (lat, lon) => 50 + proj.toLocal(lat, lon)[0] * 0.1);
    expect(sampleTerrain(t, 0, 0)).toBeCloseTo(0, 3);
    expect(sampleTerrain(t, 200, -130)).toBeCloseTo(20, 1);
    expect(sampleTerrain(t, 9999, 0)).toBeCloseTo(50, 1); // clamped at grid edge
    expect(sampleTerrain(undefined, 5, 5)).toBe(0);
  });
});
