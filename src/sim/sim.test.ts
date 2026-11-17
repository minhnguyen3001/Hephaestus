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
function gridFixture(block = 100) {
  const elements: unknown[] = [];
  const node = (i: number, j: number) => i * 10 + j + 1;
  const ll = (i: number, j: number) => ({ lat: C.lat + (j - 2) * block * M, lon: C.lon + (i - 2) * block * LON_M });
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
  return parseOverpass({ elements } as never, C, block * 3);
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

describe('proposed roads join the network', () => {
  it('creates an intersection where a new road crosses a street, and a T-junction at its end', () => {
    const base = gridFixture();
    // Runs north–south between grid columns (x = -50), crossing every east–west street, ending on the y=200 street.
    const road = { id: 'u-r-1', nodes: ['u-n-1-a', 'u-n-1-b'], points: [[-50, -230], [-50, 200]] as [number, number][], kind: 'tertiary' as const, lanes: 2, oneway: false, maxspeedKmh: 40, origin: 'proposed' as const };
    const w = applyEdits(base, [{ kind: 'addRoad', road }]);
    const added = w.roads.find((r) => r.id === 'u-r-1')!;
    expect(added.points.length).toBe(2 + 4); // 4 crossings (y = -200..100); end on y=200 street is a T
    expect(added.nodes[added.nodes.length - 1]).toMatch(/^t-/);
    const g = RoadGraph.build(w.roads);
    const from = g.index.get('u-n-1-a')!;
    const to = g.index.get('n45')!;
    expect(g.route(from, to, 'car')).not.toBeNull();
    // base data untouched
    expect(base.roads.every((r) => !r.nodes.some((n) => n.startsWith('x-')))).toBe(true);
  });
});

describe('simulation', () => {
  it('has rush-hour peaks on weekdays and a midday peak on weekends', () => {
    expect(demandAt(8.2)).toBeGreaterThan(0.9);
    expect(demandAt(3)).toBeLessThan(0.2);
    expect(demandAt(8.2, 'weekend')).toBeLessThan(demandAt(14.5, 'weekend'));
    expect(demandAt(8.2, 'weekend')).toBeLessThan(demandAt(8.2));
  });

  it('scales demand for timeline projections', () => {
    const run = (scale: number) => {
      const sim = new Simulation(gridFixture(), profileFor('us'), 150, 5);
      sim.demandScale = scale;
      sim.step(60);
      return sim.agents.filter((a) => !a.bus).length;
    };
    expect(run(1.5)).toBeGreaterThan(run(1) * 1.2);
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

  it('carries riders on user-drawn bus and metro lines', () => {
    const base = gridFixture();
    const world = applyEdits(base, [
      { kind: 'addLine', line: { id: 'u-l-bus', name: 'Bus A', mode: 'bus', stops: [[-200, -200], [0, -200], [200, -200], [200, 0], [200, 200]], color: 0xe5484d } },
      { kind: 'addLine', line: { id: 'u-l-metro', name: 'Metro B', mode: 'metro', stops: [[-200, 200], [0, 0], [200, -200]], color: 0x8e44ad } },
    ]);
    // Transit-heavy profile so plenty of trips consider the lines.
    const region = { ...profileFor('us'), modeShare: { car: 0.1, taxi: 0, motorcycle: 0, bicycle: 0, bus: 0.8, walk: 0.1 } };
    const sim = new Simulation(world, region, 200, 11);
    const lines = () => sim.stats().lines.filter((l) => !l.generated);
    expect(lines().map((l) => l.name)).toEqual(['Bus A', 'Metro B']);
    sim.step(1800);
    const [bus, metro] = lines();
    expect(bus.vehicles).toBeGreaterThan(0);
    expect(metro.vehicles).toBeGreaterThanOrEqual(2);
    expect(bus.boardings + metro.boardings).toBeGreaterThan(5);
    expect(sim.trainCars().some((c) => c.color === 0x8e44ad)).toBe(true);
  });

  it('riders transfer between two lines that meet', () => {
    const base = gridFixture(700); // a 2.8 km grid, so riding two lines beats walking
    // Line A runs along the south street west→east; line B runs up the east street. They meet in the SE corner.
    const world = applyEdits(base, [
      { kind: 'addLine', line: { id: 'a', name: 'A', mode: 'metro', stops: [[-1400, -1400], [-700, -1400], [0, -1400], [700, -1400], [1400, -1400]], color: 1 } },
      { kind: 'addLine', line: { id: 'b', name: 'B', mode: 'metro', stops: [[1400, -1400], [1400, -700], [1400, 0], [1400, 700], [1400, 1400]], color: 2 } },
    ]);
    const region = { ...profileFor('us'), modeShare: { car: 0, taxi: 0, motorcycle: 0, bicycle: 0, bus: 1, walk: 0.01 } };
    const sim = new Simulation(world, region, 250, 21);
    sim.step(3600);
    expect(sim.stats().transfers).toBeGreaterThan(0);
  });

  it('turns mapped rail with stations into a working line', () => {
    const w = gridFixture(300);
    w.rails = [{ id: 'r1', nodes: ['a', 'b', 'c'], points: [[-700, -650], [0, -650], [700, -650]], kind: 'subway', elevated: false, tunnel: true }];
    w.stations = [{ p: [-600, -640], name: 'West' }, { p: [0, -655], name: 'Central' }, { p: [600, -660], name: 'East' }];
    const sim = new Simulation(w, profileFor('us'), 100, 3);
    const line = sim.stats().lines.find((l) => l.id === 'osm-rail-0')!;
    expect(line.name).toBe('Subway: West – East');
    expect(line.vehicles).toBeGreaterThanOrEqual(2);
    expect(sim.trainCars().some((c) => c.level === 'under')).toBe(true);
    // without stations it stays a decorative shuttle
    const plain = new Simulation({ ...w, stations: [] }, profileFor('us'), 100, 3);
    expect(plain.stats().lines.some((l) => l.id === 'osm-rail-0')).toBe(false);
  });

  it('bad weather slows traffic and moves trips off foot and bike', () => {
    const run = (weather: 'clear' | 'snow') => {
      const sim = new Simulation(gridFixture(600), profileFor('nl'), 300, 13);
      sim.weather = weather;
      sim.step(300);
      const st = sim.stats();
      return { walkBike: st.active.pedestrian + st.active.bicycle, speed: st.avgVehicleSpeedKmh };
    };
    const clear = run('clear');
    const snow = run('snow');
    expect(snow.walkBike).toBeLessThan(clear.walkBike);
    expect(snow.speed).toBeLessThan(clear.speed);
  });

  it('events draw crowds before they start and send them home after', () => {
    const sim = new Simulation(gridFixture(), profileFor('us'), 200, 4);
    sim.time = 18 * 3600;
    sim.setParams({ day: 'weekday', demandScale: 1, weather: 'clear', events: [{ id: 'e', p: [0, 0], start: 19 * 3600, attendance: 20000, name: 'Concert' }] });
    sim.step(600);
    const going = sim.agents.filter((a) => a.purpose === 'event' && a.to === 'Concert').length;
    expect(going).toBeGreaterThan(10);
    sim.time = 21.2 * 3600;
    sim.step(600);
    expect(sim.agents.some((a) => a.purpose === 'event' && a.from === 'Concert')).toBe(true);
  });

  it('dispatches emergency vehicles from hospitals and civic buildings', () => {
    const w = gridFixture();
    w.buildings[0] = { ...w.buildings[0], use: 'health', name: 'General Hospital' };
    const sim = new Simulation(w, profileFor('us'), 300, 9);
    sim.step(10);
    const em = sim.agents.filter((a) => a.kind === 'emergency');
    expect(em.length).toBe(1);
    expect(em[0].from).toBe('General Hospital');
    expect(sim.stats().active.emergency).toBe(1);
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

describe('road editing and access metrics', () => {
  it('edits road properties and the network follows', () => {
    const base = gridFixture();
    const id = base.roads[0].id;
    const w = applyEdits(base, [{ kind: 'setRoad', id, patch: { kind: 'footway', oneway: false } }]);
    const g = RoadGraph.build(w.roads);
    const ped = g.edges.filter((e) => e.roadId === id);
    expect(ped.every((e) => !e.car && e.walk)).toBe(true);
  });

  it('a drawn transit line raises transit access', async () => {
    const { cityMetrics } = await import('../ui/metrics');
    const base = gridFixture();
    const before = cityMetrics(base).transitAccess;
    const w = applyEdits(base, [{ kind: 'addLine', line: { id: 'l', name: 'A', mode: 'bus', stops: [[-150, -150], [150, 150], [-150, 150]], color: 1 } }]);
    expect(cityMetrics(w).transitAccess).toBeGreaterThan(before);
  });
});

describe('bike lanes', () => {
  it('cyclists prefer bike lanes and more bike network grows cycling', () => {
    const base = gridFixture();
    const g0 = RoadGraph.build(base.roads);
    const from = g0.index.get('n11')!;
    const to = g0.index.get('n15')!;
    // give a parallel street a bike lane; the bike route should use it even if slightly longer
    const laned = applyEdits(base, base.roads.filter((r) => r.points.every((p) => Math.abs(p[0] + 100) < 1)).map((r) => ({ kind: 'setRoad' as const, id: r.id, patch: { bikeLane: true } })));
    const g1 = RoadGraph.build(laned.roads);
    const path = g1.route(g1.index.get('n11')!, g1.index.get('n15')!, 'bike')!;
    expect(path.some((e) => laned.roads.find((r) => r.id === g1.edges[e].roadId)?.bikeLane)).toBe(true);
    expect(g0.route(from, to, 'bike')).not.toBeNull();
    const s0 = new Simulation(base, profileFor('nl'), 100, 1);
    const s1 = new Simulation(applyEdits(base, base.roads.map((r) => ({ kind: 'setRoad' as const, id: r.id, patch: { bikeLane: true } }))), profileFor('nl'), 100, 1);
    expect(s1.bikeShare).toBeGreaterThan(s0.bikeShare);
  });
});

describe('zoning', () => {
  it('fills a zone with buildings clear of streets, and makes parks', () => {
    const base = gridFixture();
    // One whole block interior between streets x∈[-200,-100], y∈[-200,-100] (with the fixture building inside).
    const block: [number, number][] = [[-195, -195], [-105, -195], [-105, -105], [-195, -105]];
    const w = applyEdits(base, [{ kind: 'zone', zone: { id: 'z1', polygon: block, use: 'residential', density: 'low', replace: true } }]);
    const zoned = w.buildings.filter((b) => b.id.startsWith('z1-'));
    expect(zoned.length).toBeGreaterThan(0);
    for (const b of zoned) {
      expect(b.origin).toBe('proposed');
      expect(b.use).toBe('residential');
      for (const [x, y] of b.footprint) expect(x > -200 && x < -100 && y > -200 && y < -100).toBe(true);
    }
    // the original building in that block was replaced
    expect(w.buildings.length).toBe(base.buildings.length - 1 + zoned.length);
    const parked = applyEdits(base, [{ kind: 'zone', zone: { id: 'z2', polygon: block, use: 'park', density: 'low', replace: true } }]);
    expect(parked.areas.some((a) => a.id === 'zone-z2' && a.kind === 'park')).toBe(true);
    expect(parked.buildings.length).toBe(base.buildings.length - 1);
    // deterministic
    expect(applyEdits(base, [{ kind: 'zone', zone: { id: 'z1', polygon: block, use: 'residential', density: 'low', replace: true } }]).buildings).toEqual(w.buildings);
  });
});

describe('challenges', () => {
  it('evaluates goals against metrics', async () => {
    const { CHALLENGES, evaluate, suggested } = await import('../ui/challenges');
    const { cityMetrics } = await import('../ui/metrics');
    const base = gridFixture();
    const o = cityMetrics(base);
    const housing = CHALLENGES.find((c) => c.id === 'housing')!;
    expect(evaluate(housing, o, o, null).done).toBe(false);
    const block: [number, number][] = [[-195, -195], [-105, -195], [-105, -105], [-195, -105]];
    const grown = cityMetrics(applyEdits(base, [{ kind: 'zone', zone: { id: 'z', polygon: block, use: 'residential', density: 'high', replace: true } }]));
    expect(evaluate(housing, grown, o, null).results[0].met).toBe(true);
    expect(suggested('Chicago Loop', 'us')?.id).toBe('unjam');
  });
});

describe('advisor', () => {
  it('flags transit gaps with a location and clears them when served', async () => {
    const { advise } = await import('../ui/advisor');
    const { cityMetrics } = await import('../ui/metrics');
    const base = gridFixture();
    const m = cityMetrics(base);
    const tips = advise(base, m, m, null, new Map());
    const gap = tips.find((t) => t.id === 'transit-gap');
    expect(gap?.at).toBeDefined();
    const served = applyEdits(base, [{ kind: 'addLine', line: { id: 'l', name: 'A', mode: 'metro', stops: [[-150, -150], [150, -150], [150, 150], [-150, 150], [-150, -150]], color: 1 } }]);
    const m2 = cityMetrics(served);
    expect(advise(served, m2, m, null, new Map()).some((t) => t.id === 'transit-gap')).toBe(false);
  });
});

describe('trees', () => {
  it('keeps every mapped tree and plants illustrative trees only inside parks', async () => {
    const { treePoints } = await import('../geo/trees');
    const w = gridFixture();
    w.trees = [[1, 1], [2, 2]];
    w.areas = [{ id: 'park1', kind: 'park', polygon: [[0, 0], [100, 0], [100, 100], [0, 100]] }];
    const t = treePoints(w, 1000);
    expect(t.filter((x) => x.mapped)).toHaveLength(2);
    const planted = t.filter((x) => !x.mapped);
    expect(planted.length).toBeGreaterThan(20);
    for (const x of planted) expect(x.p[0] >= 0 && x.p[0] <= 100 && x.p[1] >= 0 && x.p[1] <= 100).toBe(true);
    expect(treePoints(w, 1000)).toEqual(t); // deterministic
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
