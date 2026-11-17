import type { Building, TransitLineSpec, Vec2, WorldData } from '../geo/types';
import { centroid, dist, hash01, makeSampler, polylineLength, rng, signedArea } from '../geo/util';
import { LANE_WIDTH, RoadGraph, type GEdge } from './graph';
import type { RegionProfile, TravelMode } from './region';

const CYCLE = 64;

export type AgentKind = 'pedestrian' | 'bicycle' | 'motorcycle' | 'car' | 'taxi' | 'truck' | 'bus';
export const AGENT_KINDS: AgentKind[] = ['pedestrian', 'bicycle', 'motorcycle', 'car', 'taxi', 'truck', 'bus'];
export type Purpose = 'commute' | 'return home' | 'school' | 'shopping' | 'leisure' | 'delivery' | 'to transit stop' | 'from transit stop' | 'transit service';

export interface Agent {
  id: number;
  kind: AgentKind;
  purpose: Purpose;
  path: number[];
  pi: number;
  s: number;
  v: number;
  vmax: number; // fraction of the edge speed limit (vehicles) or absolute m/s (walk graph users)
  len: number;
  side: number;
  dwell: number;
  stopped: number; // seconds stationary, for gridlock recovery
  from?: string;
  to?: string;
  bus?: { line: number; dir: 0 | 1; riders: Rider[]; cap: number; lastStop: number };
  rider?: Rider; // pedestrian walking to a stop to take transit
  stopId?: number;
  done: boolean;
  // derived each step (local meters + unit heading)
  x: number;
  y: number;
  hx: number;
  hy: number;
}

interface Site {
  label: string;
  c: Vec2;
  residents: number;
  jobs: number;
  attract: number;
  school: number;
  freight: number;
  carNode: number;
  walkNode: number;
}

/** A passenger heading for a stop on a specific line and direction. */
interface Rider {
  line: number;
  dir: 0 | 1;
  to: number; // stop id to alight at
  destWalk: number;
  destLabel: string;
}

interface Stop {
  id: number;
  p: Vec2;
  walkNode: number;
  waiting: Rider[];
  lines: Set<number>;
}

interface Poly {
  pts: Vec2[];
  cum: number[];
  len: number;
}

interface Line {
  id: string;
  name: string;
  mode: 'bus' | 'metro';
  color: number;
  generated: boolean;
  stopSeq: [number[], number[]]; // stop ids in travel order per direction
  paths?: [number[], number[]]; // bus: edge paths per direction
  stopAtPath?: [Map<number, number>, Map<number, number>]; // bus: path index (stop at edge end; -1 = start) → stop id
  poly?: Poly; // metro guideway
  stationS?: number[]; // metro: distance along poly of each stop in stopSeq[0]
  boardings: number;
}

interface MetroTrain {
  line: number;
  s: number;
  dir: 1 | -1;
  next: number; // index into stationS of the station being approached
  v: number;
  dwell: number;
  riders: Rider[];
}

export interface TransitLineView {
  id: string;
  name: string;
  mode: 'bus' | 'metro';
  color: number;
  generated: boolean;
  pts: Vec2[];
  stops: Vec2[];
}

export interface LineStats {
  id: string;
  name: string;
  mode: 'bus' | 'metro';
  color: number;
  generated: boolean;
  boardings: number;
  onboard: number;
  waiting: number;
  vehicles: number;
}

interface TrainLine {
  pts: Vec2[];
  cum: number[];
  len: number;
  elevated: boolean;
  kind: string;
}

interface Train {
  line: number;
  s: number;
  dir: 1 | -1;
  v: number;
  dwell: number;
  cars: number;
  carLen: number;
}

export interface TrainCar {
  x: number;
  y: number;
  hx: number;
  hy: number;
  elevated: boolean;
  carLen: number;
  color?: number;
}

export interface SimStats {
  time: number;
  active: Record<AgentKind, number>;
  trains: number;
  tripsCompleted: number;
  avgVehicleSpeedKmh: number;
  congestion: number;
  busRiders: number; // transit boardings
  waitingAtStops: number;
  lines: LineStats[];
  residents: number;
  jobs: number;
  signals: number;
  busRoutes: number;
  rerouted: number;
}

export type SignalState = 'green' | 'yellow' | 'red';

export interface SignalHead {
  x: number;
  y: number;
  hx: number;
  hy: number;
  offset: number;
  group: 0 | 1;
}

/** Two-group fixed-time plan: 28 s green, 3 s yellow, 1 s all-red per group on a 64 s cycle. */
export function signalPhase(t: number, offset: number, group: number): SignalState {
  const ph = (((t + offset) % CYCLE) + CYCLE) % CYCLE;
  const local = group === 0 ? ph : (ph + CYCLE / 2) % CYCLE;
  return local < 28 ? 'green' : local < 31 ? 'yellow' : 'red';
}

/** Inspector-friendly description of one agent. */
export interface AgentInfo {
  id: number;
  kind: AgentKind;
  purpose: string;
  from?: string;
  to?: string;
  speedKmh: number;
  load?: number;
  cap?: number;
}

const VEHICLE: Record<'car' | 'taxi' | 'motorcycle' | 'truck' | 'bus', { len: number; vmax: number; acc: number }> = {
  car: { len: 4.6, vmax: 1, acc: 2.5 },
  taxi: { len: 4.8, vmax: 1.05, acc: 2.6 },
  motorcycle: { len: 2.1, vmax: 1.05, acc: 3.5 },
  truck: { len: 9, vmax: 0.85, acc: 1.2 },
  bus: { len: 12.5, vmax: 0.8, acc: 1.2 },
};
const isVehicle = (k: AgentKind) => k !== 'pedestrian' && k !== 'bicycle';

/** Daily travel-demand curve in [0,1]: AM/PM peaks, midday shoulder, quiet nights. */
export function demandAt(hour: number): number {
  const g = (mu: number, w: number) => Math.exp(-((hour - mu) ** 2) / (2 * w * w));
  const night = hour < 5 ? 0.06 : 0.14;
  return Math.min(1, night + 0.86 * Math.max(g(8.2, 1.1), g(17.6, 1.3)) + 0.4 * g(13, 2.4));
}

export function floorArea(b: Building): number {
  return Math.abs(signedArea(b.footprint)) * Math.max(1, Math.round(b.height / 3.2));
}

export function buildingCapacity(b: Building) {
  const fa = floorArea(b);
  const per: Record<string, [number, number, number, number, number]> = {
    // [m² per resident, m² per job, m² per visitor, m² per student, freight weight]
    residential: [45, 1000, 0, 0, 0],
    unknown: [90, 150, 400, 0, 0.2],
    commercial: [400, 35, 20, 0, 1],
    office: [0, 20, 300, 0, 0.3],
    industrial: [0, 70, 0, 0, 3],
    education: [0, 60, 0, 12, 0.1],
    health: [0, 35, 150, 0, 0.3],
    civic: [0, 50, 120, 0, 0.1],
    religious: [0, 200, 120, 0, 0],
    parking: [0, 0, 0, 0, 0],
  };
  const [r, j, a, s, f] = per[b.use];
  const q = (d: number) => (d > 0 ? fa / d : 0);
  return { residents: q(r), jobs: q(j), attract: q(a), school: q(s), freight: f * fa / 1000 };
}

export class Simulation {
  readonly graph: RoadGraph;
  time = 7.5 * 3600;
  agents: Agent[] = [];
  private trains: Train[] = [];
  private lines: TrainLine[] = [];
  private sites: Site[] = [];
  private transit: Line[] = [];
  private stops: Stop[] = [];
  private stopByNode = new Map<number, number>();
  private metros: MetroTrain[] = [];
  private signals = new Map<number, { axis: Vec2; offset: number }>();
  private rand: () => number;
  private nextId = 1;
  private tripsCompleted = 0;
  private busRiders = 0;
  private rerouted = 0;
  private filled = false;
  private samplers!: Record<'residents' | 'jobs' | 'attract' | 'school' | 'freight' | 'any', ReturnType<typeof makeSampler<Site>>>;
  totals = { residents: 0, jobs: 0 };

  constructor(world: WorldData, readonly region: RegionProfile, public maxAgents = 400, seed = 1) {
    this.rand = rng(seed);
    this.graph = RoadGraph.build(world.roads);
    this.buildSites(world);
    this.buildSignals(new Set(world.signalNodes));
    this.buildBusRoutes(world.radius);
    this.buildUserLines(world.transitLines ?? []);
    this.buildTrains(world);
  }

  // ---------- setup ----------

  private buildSites(world: WorldData) {
    for (const b of world.buildings) {
      const cap = buildingCapacity(b);
      const c = centroid(b.footprint);
      this.sites.push({ label: b.name ?? `${b.use} building`, c, ...cap, carNode: -1, walkNode: -1 });
    }
    for (const a of world.areas) {
      if (a.kind !== 'park') continue;
      const area = Math.abs(signedArea(a.polygon));
      this.sites.push({ label: 'park', c: centroid(a.polygon), residents: 0, jobs: area / 20000, attract: area / 400, school: 0, freight: 0, carNode: -1, walkNode: -1 });
    }
    for (const s of this.sites) {
      s.carNode = this.graph.nearestNode(s.c, 'car');
      s.walkNode = this.graph.nearestNode(s.c, 'walk');
      this.totals.residents += s.residents;
      this.totals.jobs += s.jobs;
    }
    const usable = this.sites.filter((s) => s.walkNode >= 0);
    this.samplers = {
      residents: makeSampler(usable, (s) => s.residents),
      jobs: makeSampler(usable, (s) => s.jobs),
      attract: makeSampler(usable, (s) => s.attract),
      school: makeSampler(usable, (s) => s.school),
      freight: makeSampler(usable.filter((s) => s.carNode >= 0), (s) => s.freight),
      any: makeSampler(usable, (s) => s.residents + s.jobs + 1),
    };
  }

  private buildSignals(osmSignals: Set<string>) {
    const g = this.graph;
    const incoming = new Map<number, GEdge[]>();
    for (const e of g.edges) if (e.car) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
    g.nodes.forEach((n, i) => {
      const inc = incoming.get(i) ?? [];
      const roads = new Set(inc.map((e) => e.roadId));
      const majorIn = inc.filter((e) => e.kind === 'highway' || e.kind === 'primary' || e.kind === 'secondary').length;
      // Real signals from OSM; otherwise estimate one where several major approaches meet.
      const estimated = roads.size >= 3 && majorIn >= 3 && inc.length >= 3;
      if ((osmSignals.has(n.id) && inc.length >= 1) || estimated) {
        this.signals.set(i, { axis: inc[0]?.dir ?? [1, 0], offset: hash01(n.id) * CYCLE });
      }
    });
  }

  signalState(e: GEdge, t = this.time): SignalState {
    const sig = this.signals.get(e.to);
    if (!sig) return 'green';
    const group = Math.abs(e.dir[0] * sig.axis[0] + e.dir[1] * sig.axis[1]) > 0.7071 ? 0 : 1;
    return signalPhase(t, sig.offset, group);
  }

  /** One signal head per car approach, placed at the curb before the stop line (for rendering). */
  signalApproaches(): SignalHead[] {
    const out: SignalHead[] = [];
    const side = this.region.driveSide === 'right' ? 1 : -1;
    for (const e of this.graph.edges) {
      const sig = this.signals.get(e.to);
      if (!sig || !e.car || e.len < 8) continue;
      const p = this.graph.nodes[e.to].p;
      const off = (e.halfWidth + 1.2) * side;
      out.push({
        x: p[0] - e.dir[0] * 4 + e.dir[1] * off,
        y: p[1] - e.dir[1] * 4 - e.dir[0] * off,
        hx: e.dir[0],
        hy: e.dir[1],
        offset: sig.offset,
        group: Math.abs(e.dir[0] * sig.axis[0] + e.dir[1] * sig.axis[1]) > 0.7071 ? 0 : 1,
      });
    }
    return out;
  }

  /** Mean speed / speed limit per road for roads with vehicles on them right now (1 = free flow). */
  roadSpeeds(): { ids: string[]; ratio: number[] } {
    const acc = new Map<string, [number, number]>();
    for (const a of this.agents) {
      if (!isVehicle(a.kind) || a.dwell > 0) continue;
      const e = this.graph.edges[a.path[a.pi]];
      if (!e) continue;
      const r = acc.get(e.roadId) ?? [0, 0];
      r[0] += Math.min(1, a.v / e.speed);
      r[1]++;
      acc.set(e.roadId, r);
    }
    const ids: string[] = [];
    const ratio: number[] = [];
    for (const [id, [sum, n]] of acc) {
      ids.push(id);
      ratio.push(sum / n);
    }
    return { ids, ratio };
  }

  get signalNodes(): number[] {
    return [...this.signals.keys()];
  }

  private stopAtNode(node: number): number {
    let id = this.stopByNode.get(node);
    if (id === undefined) {
      const p = this.graph.nodes[node].p;
      id = this.stops.length;
      this.stops.push({ id, p, walkNode: this.graph.nearestNode(p, 'walk'), waiting: [], lines: new Set() });
      this.stopByNode.set(node, id);
    }
    return id;
  }

  private addBusLine(meta: Pick<Line, 'id' | 'name' | 'color' | 'generated'>, paths: [number[], number[]], stopAtPath: [Map<number, number>, Map<number, number>], perDir: number) {
    const g = this.graph;
    const order = (dir: 0 | 1) => [...stopAtPath[dir].entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
    const li = this.transit.length;
    this.transit.push({ ...meta, mode: 'bus', paths, stopAtPath, stopSeq: [order(0), order(1)], boardings: 0 });
    for (const dir of [0, 1] as const) for (const id of stopAtPath[dir].values()) this.stops[id].lines.add(li);
    for (const dir of [0, 1] as const) {
      for (let k = 0; k < perDir; k++) {
        const path = paths[dir];
        const a = this.newAgent('bus', 'transit service', path);
        a.pi = Math.floor(((k + 0.5) / perDir) * path.length * 0.9);
        a.s = Math.min(g.edges[path[a.pi]].len, 1);
        a.bus = { line: li, dir, riders: [], cap: 70, lastStop: -1 };
        this.agents.push(a);
      }
    }
  }

  private buildBusRoutes(radius: number) {
    const g = this.graph;
    const major = g.nodes
      .map((_, i) => i)
      .filter((i) => g.nodes[i].out.some((e) => g.edges[e].car && ['primary', 'secondary', 'tertiary'].includes(g.edges[e].kind)));
    if (major.length < 2) return;
    const cands: { a: number[]; b: number[]; len: number }[] = [];
    for (let k = 0; k < 40 && cands.length < 12; k++) {
      const s = major[Math.floor(this.rand() * major.length)];
      const t = major[Math.floor(this.rand() * major.length)];
      if (dist(g.nodes[s].p, g.nodes[t].p) < radius * 0.8) continue;
      const a = g.route(s, t, 'car');
      const b = a && g.route(t, s, 'car');
      if (a && b && a.length > 3 && b.length > 3) cands.push({ a, b, len: a.reduce((l, e) => l + g.edges[e].len, 0) });
    }
    cands.sort((x, y) => y.len - x.len);
    const stopsFor = (path: number[]) => {
      const m = new Map<number, number>();
      let acc = 0;
      path.forEach((e, i) => {
        acc += g.edges[e].len;
        if (acc >= 320 && i < path.length - 1) {
          m.set(i, this.stopAtNode(g.edges[e].to));
          acc = 0;
        }
      });
      return m;
    };
    cands.slice(0, 3).forEach((c, n) => {
      this.addBusLine(
        { id: `gen-bus-${n}`, name: `Bus ${n + 1} (simulated)`, color: this.region.busColor, generated: true },
        [c.a, c.b], [stopsFor(c.a), stopsFor(c.b)], this.maxAgents >= 600 ? 2 : 1,
      );
    });
  }

  /** Proposed lines drawn by the user. Bus lines follow streets between stops; metro lines are straight guideways. */
  private buildUserLines(specs: TransitLineSpec[]) {
    const g = this.graph;
    for (const spec of specs) {
      if (spec.stops.length < 2) continue;
      if (spec.mode === 'bus') {
        const nodes = spec.stops.map((p) => g.nearestNode(p, 'car')).filter((n, i, arr) => n >= 0 && n !== arr[i - 1]);
        if (nodes.length < 2) continue;
        const build = (seq: number[]): [number[], Map<number, number>] | null => {
          const path: number[] = [];
          const at = new Map<number, number>([[-1, this.stopAtNode(seq[0])]]);
          for (let i = 1; i < seq.length; i++) {
            const leg = g.route(seq[i - 1], seq[i], 'car');
            if (!leg) return null;
            path.push(...leg);
            at.set(path.length - 1, this.stopAtNode(seq[i]));
          }
          return path.length ? [path, at] : null;
        };
        const fwd = build(nodes);
        const back = build([...nodes].reverse());
        if (!fwd || !back) continue;
        const len = fwd[0].reduce((l, e) => l + g.edges[e].len, 0);
        this.addBusLine({ id: spec.id, name: spec.name, color: spec.color, generated: false }, [fwd[0], back[0]], [fwd[1], back[1]], Math.max(1, Math.round(len / 900)));
      } else {
        const pts = spec.stops;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
        const li = this.transit.length;
        const ids = pts.map((p) => {
          const id = this.stops.length;
          this.stops.push({ id, p, walkNode: g.nearestNode(p, 'walk'), waiting: [], lines: new Set([li]) });
          return id;
        });
        const poly = { pts, cum, len: cum[cum.length - 1] };
        this.transit.push({
          id: spec.id, name: spec.name, mode: 'metro', color: spec.color, generated: false,
          stopSeq: [ids, [...ids].reverse()], poly, stationS: cum, boardings: 0,
        });
        const n = Math.max(2, Math.ceil(poly.len / 900));
        for (let k = 0; k < n; k++) {
          const dir: 1 | -1 = k % 2 ? -1 : 1;
          const idx = Math.min(cum.length - 1, Math.floor((k / n) * cum.length));
          this.metros.push({ line: li, s: cum[idx], dir, next: Math.max(0, Math.min(cum.length - 1, idx + dir)), v: 0, dwell: 5, riders: [] });
        }
      }
    }
  }

  private buildTrains(world: WorldData) {
    const segs = world.rails.filter((r) => !r.tunnel);
    const byEnd = new Map<string, number[]>();
    segs.forEach((r, i) => {
      for (const n of [r.nodes[0], r.nodes[r.nodes.length - 1]]) byEnd.set(n, [...(byEnd.get(n) ?? []), i]);
    });
    const used = new Set<number>();
    const chains: { pts: Vec2[]; elevated: boolean; kind: string }[] = [];
    segs.forEach((seg, i) => {
      if (used.has(i)) return;
      used.add(i);
      let nodes = [...seg.nodes];
      let pts = [...seg.points];
      let elevated = seg.elevated;
      for (const atEnd of [true, false]) {
        for (;;) {
          const end = atEnd ? nodes[nodes.length - 1] : nodes[0];
          const next = (byEnd.get(end) ?? []).find((j) => !used.has(j) && segs[j].kind === seg.kind);
          if (next === undefined) break;
          used.add(next);
          const s = segs[next];
          let sn = [...s.nodes];
          let sp = [...s.points];
          if ((atEnd && sn[0] !== end) || (!atEnd && sn[sn.length - 1] !== end)) {
            sn = sn.reverse();
            sp = sp.reverse();
          }
          elevated ||= s.elevated;
          if (atEnd) {
            nodes = [...nodes, ...sn.slice(1)];
            pts = [...pts, ...sp.slice(1)];
          } else {
            nodes = [...sn.slice(0, -1), ...nodes];
            pts = [...sp.slice(0, -1), ...pts];
          }
        }
      }
      chains.push({ pts, elevated, kind: seg.kind });
    });
    const lines = chains
      .map((c) => ({ ...c, len: polylineLength(c.pts) }))
      .filter((c) => c.len > 400)
      .sort((a, b) => b.len - a.len)
      .slice(0, 8);
    for (const l of lines) {
      const cum = [0];
      for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + dist(l.pts[i - 1], l.pts[i]));
      this.lines.push({ pts: l.pts, cum, len: l.len, elevated: l.elevated, kind: l.kind });
      const tram = l.kind === 'tram';
      this.trains.push({
        line: this.lines.length - 1, s: this.rand() * l.len, dir: this.rand() < 0.5 ? 1 : -1, v: 0, dwell: 0,
        cars: tram ? 2 : 4, carLen: tram ? 14 : 18,
      });
    }
  }

  // ---------- trips ----------

  private newAgent(kind: AgentKind, purpose: Purpose, path: number[]): Agent {
    const veh = isVehicle(kind) ? VEHICLE[kind as keyof typeof VEHICLE] : null;
    const vmax = kind === 'pedestrian' ? 1.15 + this.rand() * 0.4 : kind === 'bicycle' ? 4 + this.rand() * 1.5 : veh!.vmax * (0.9 + this.rand() * 0.2);
    return {
      id: this.nextId++, kind, purpose, path, pi: 0, s: 0, v: 0, vmax,
      len: veh?.len ?? (kind === 'bicycle' ? 1.8 : 0.5),
      side: this.rand() < 0.5 ? 1 : -1, dwell: 0, stopped: 0, done: false, x: 0, y: 0, hx: 1, hy: 0,
    };
  }

  private pickPurpose(): { purpose: Purpose; o?: Site; d?: Site } {
    const h = this.time / 3600;
    const r = this.rand();
    const s = this.samplers;
    const pick = (k: keyof typeof s) => s[k].sample(this.rand());
    if (h >= 9 && h < 18 && r < 0.07) return { purpose: 'delivery', o: pick('freight'), d: pick('attract') };
    if (h >= 5 && h < 10.5) {
      if (r < 0.68) return { purpose: 'commute', o: pick('residents'), d: pick('jobs') };
      if (r < 0.82 && s.school.total > 0) return { purpose: 'school', o: pick('residents'), d: pick('school') };
    } else if (h >= 15 && h < 20) {
      if (r < 0.6) return { purpose: 'return home', o: pick('jobs'), d: pick('residents') };
    }
    const leisure = this.rand() < 0.35;
    return { purpose: leisure ? 'leisure' : 'shopping', o: pick('any'), d: pick('attract') ?? pick('jobs') };
  }

  private chooseMode(d: number, hasStops: boolean): TravelMode {
    const w = { ...this.region.modeShare };
    w.walk *= d < 400 ? 8 : d < 1000 ? 2 : d > 2500 ? 0.1 : 1;
    w.bicycle *= d < 300 ? 0.3 : 1;
    if (!hasStops || d < 300) w.bus = 0;
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    let x = this.rand() * total;
    for (const [m, v] of Object.entries(w)) {
      x -= v;
      if (x <= 0) return m as TravelMode;
    }
    return 'walk';
  }

  /** Best line, direction and stops for a trip, if transit beats walking (≤ 700 m walk at each end). */
  private planTransit(o: Site, d: Site): { line: number; dir: 0 | 1; from: number; to: number } | null {
    const MAX = 700;
    let best: { line: number; dir: 0 | 1; from: number; to: number } | null = null;
    let bestCost = dist(o.c, d.c) * 0.8; // must beat walking most of the way
    for (const a of this.stops) {
      const wa = dist(o.c, a.p);
      if (wa > MAX) continue;
      for (const li of a.lines) {
        const line = this.transit[li];
        for (const dir of [0, 1] as const) {
          const seq = line.stopSeq[dir];
          const i = seq.indexOf(a.id);
          if (i < 0) continue;
          for (let j = i + 1; j < seq.length; j++) {
            const b = this.stops[seq[j]];
            const wb = dist(b.p, d.c);
            if (wb > MAX) continue;
            const cost = wa + wb;
            if (cost < bestCost) {
              bestCost = cost;
              best = { line: li, dir, from: a.id, to: b.id };
            }
          }
        }
      }
    }
    return best;
  }

  /** Create one trip from the origin-destination model. Returns false if no route exists. */
  spawnTrip(): boolean {
    const { purpose, o, d } = this.pickPurpose();
    if (!o || !d || o === d) return false;
    const g = this.graph;
    const D = dist(o.c, d.c);
    let mode: TravelMode | 'truck' = purpose === 'delivery' ? 'truck' : this.chooseMode(D, this.stops.length > 0);
    let path: number[] | null = null;
    let kind: AgentKind;
    let p: Purpose = purpose;
    let to = d.label;
    let rider: Rider | undefined;
    let stopId: number | undefined;
    if (mode === 'bus') {
      const plan = this.planTransit(o, d);
      if (plan) {
        rider = { line: plan.line, dir: plan.dir, to: plan.to, destWalk: d.walkNode, destLabel: d.label };
        stopId = plan.from;
        const stop = this.stops[plan.from];
        path = g.route(o.walkNode, stop.walkNode, 'walk');
        if (path && path.length === 0) {
          stop.waiting.push(rider); // already at the stop
          return true;
        }
        p = 'to transit stop';
        to = `${this.transit[plan.line].name} stop`;
      } else mode = D < 1500 ? 'walk' : 'car';
    }
    if (mode === 'walk' || (mode === 'bus' && !path)) {
      kind = 'pedestrian';
      path ??= g.route(o.walkNode, d.walkNode, 'walk');
    } else if (mode === 'bus') {
      kind = 'pedestrian';
    } else if (mode === 'bicycle') {
      kind = 'bicycle';
      path = g.route(o.walkNode, d.walkNode, 'walk');
    } else {
      kind = mode;
      if (o.carNode < 0 || d.carNode < 0) return false;
      path = g.route(o.carNode, d.carNode, 'car');
    }
    if (!path || path.length === 0) return false;
    const a = this.newAgent(kind, p, path);
    a.from = o.label;
    a.to = to;
    a.rider = rider;
    a.stopId = stopId;
    if (!this.filled) {
      a.pi = Math.floor(this.rand() * path.length);
      a.s = this.rand() * g.edges[path[a.pi]].len;
      a.v = isVehicle(kind) ? g.edges[path[a.pi]].speed * 0.6 : a.vmax;
    }
    this.agents.push(a);
    return true;
  }

  // ---------- stepping ----------

  /** Advance the simulation by dt seconds of simulated time (internally sub-stepped). */
  step(dt: number) {
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(0.25, left);
      this.tick(h);
      left -= h;
    }
    this.updatePositions();
  }

  private tick(dt: number) {
    this.time = (this.time + dt) % 86400;
    const g = this.graph;

    // Keep the population of moving agents near demand for this time of day.
    const target = Math.round(this.maxAgents * demandAt(this.time / 3600));
    let movers = 0;
    for (const a of this.agents) if (!a.bus) movers++;
    // While warming up, spawn in bounded batches (placed mid-trip) so no single tick stalls.
    for (let tries = 0; movers < target && tries < (this.filled ? 6 : 60); tries++) if (this.spawnTrip()) movers++;
    if (movers >= target * 0.9) this.filled = true;

    // Group vehicles by (edge, lane) for car-following.
    const lanes = new Map<number, Agent[]>();
    const tail = new Map<number, number>(); // edge -> rear position of last vehicle
    for (const a of this.agents) {
      if (!isVehicle(a.kind) || a.done) continue;
      const ei = a.path[a.pi];
      const e = g.edges[ei];
      const key = ei * 8 + (a.id % Math.max(1, Math.min(8, e.lanes)));
      (lanes.get(key) ?? lanes.set(key, []).get(key)!).push(a);
      tail.set(ei, Math.min(tail.get(ei) ?? Infinity, a.s - a.len));
    }
    for (const list of lanes.values()) list.sort((x, y) => y.s - x.s);

    for (const list of lanes.values()) {
      for (let k = 0; k < list.length; k++) {
        const a = list[k];
        let leaderGap = Infinity;
        for (let j = k - 1; j >= 0; j--) {
          const l = list[j];
          if (a.kind === 'motorcycle' && this.region.motorcycleFiltering && l.kind !== 'motorcycle') continue;
          leaderGap = l.s - l.len - a.s;
          break;
        }
        this.moveVehicle(a, leaderGap, tail, dt);
      }
    }

    for (const a of this.agents) {
      if (a.done || isVehicle(a.kind)) continue;
      const e = g.edges[a.path[a.pi]];
      // Pedestrians cross with the parallel traffic phase: wait at the corner on red.
      if (a.kind === 'pedestrian' && a.pi < a.path.length - 1 && a.s >= e.len - 0.5 && this.signalState(e) !== 'green') {
        a.s = e.len - 0.5;
        a.v = 0;
        continue;
      }
      a.v = a.vmax;
      a.s += a.v * dt;
      while (!a.done && a.s >= g.edges[a.path[a.pi]].len) {
        a.s -= g.edges[a.path[a.pi]].len;
        if (++a.pi >= a.path.length) this.arrive(a);
      }
    }

    for (const t of this.trains) this.moveTrain(t, dt);
    for (const t of this.metros) this.moveMetro(t, dt);

    if (this.agents.some((a) => a.done)) this.agents = this.agents.filter((a) => !a.done);
  }

  private moveVehicle(a: Agent, leaderGap: number, tail: Map<number, number>, dt: number) {
    const g = this.graph;
    if (a.dwell > 0) {
      a.dwell -= dt;
      a.v = 0;
      return;
    }
    const e = g.edges[a.path[a.pi]];
    let gap = leaderGap;
    const toEnd = e.len - a.s;
    // Red (or late yellow) light: the stop line acts as a stationary leader.
    const sig = this.signalState(e);
    if (sig === 'red' || (sig === 'yellow' && toEnd > a.v * 1.5)) gap = Math.min(gap, toEnd - 1);
    // Spill-back: respect the queue on the next edge.
    const next = a.path[a.pi + 1];
    if (next !== undefined && gap === Infinity) {
      const t = tail.get(next);
      if (t !== undefined) gap = toEnd + t;
    }
    // Bus stop: pull in at the end of a stop edge.
    const stopHere = a.bus && a.bus.lastStop !== a.pi ? this.transit[a.bus.line].stopAtPath![a.bus.dir].get(a.pi) : undefined;
    if (stopHere !== undefined) gap = Math.min(gap, toEnd + 1.5);

    const spec = VEHICLE[a.kind as keyof typeof VEHICLE];
    const vDesired = e.speed * a.vmax;
    const vSafe = gap === Infinity ? Infinity : Math.max(0, (gap - 1.5) / 1.1);
    const vTarget = Math.min(vDesired, vSafe);
    a.v = Math.max(0, Math.min(vTarget, a.v + spec.acc * dt));
    a.s += a.v * dt;
    a.stopped = a.v < 0.1 ? a.stopped + dt : 0;
    if (a.stopped > 150 && !a.bus) {
      // Gridlock recovery: give up rather than freeze the network forever.
      this.rerouted++;
      a.done = true;
      return;
    }

    if (a.bus && stopHere !== undefined && a.s >= e.len - 0.3) {
      a.bus.lastStop = a.pi;
      a.dwell = this.serveStop(a.bus.riders, a.bus.cap, a.bus.line, a.bus.dir, stopHere);
      a.s = Math.min(a.s, e.len);
      return;
    }

    while (!a.done && a.s >= g.edges[a.path[a.pi]].len) {
      a.s -= g.edges[a.path[a.pi]].len;
      a.pi++;
      if (a.pi >= a.path.length) {
        if (a.bus) {
          const line = this.transit[a.bus.line];
          a.bus.dir = a.bus.dir === 0 ? 1 : 0;
          a.path = line.paths![a.bus.dir];
          a.pi = 0;
          a.s = 0;
          a.bus.lastStop = -1;
          const first = line.stopAtPath![a.bus.dir].get(-1);
          a.dwell = first !== undefined ? this.serveStop(a.bus.riders, a.bus.cap, a.bus.line, a.bus.dir, first) + 10 : 20;
        } else this.arrive(a);
      }
    }
  }

  private arrive(a: Agent) {
    a.done = true;
    if (a.rider && a.stopId !== undefined) this.stops[a.stopId].waiting.push(a.rider);
    else this.tripsCompleted++;
  }

  /** Alight riders for this stop (they walk on), board waiting riders for this line and direction. Returns dwell seconds. */
  private serveStop(riders: Rider[], cap: number, line: number, dir: 0 | 1, stopId: number): number {
    const stop = this.stops[stopId];
    let alight = 0;
    for (let i = riders.length - 1; i >= 0; i--) {
      if (riders[i].to !== stopId) continue;
      this.egress(riders[i], stop);
      riders.splice(i, 1);
      alight++;
    }
    let board = 0;
    for (let i = 0; i < stop.waiting.length && riders.length < cap; ) {
      const r = stop.waiting[i];
      if (r.line === line && r.dir === dir) {
        riders.push(r);
        stop.waiting.splice(i, 1);
        board++;
      } else i++;
    }
    this.busRiders += board;
    this.transit[line].boardings += board;
    return 6 + (alight + board) * 1.2;
  }

  private egress(r: Rider, stop: Stop) {
    const path = this.graph.route(stop.walkNode, r.destWalk, 'walk');
    if (!path || !path.length) {
      this.tripsCompleted++;
      return;
    }
    const a = this.newAgent('pedestrian', 'from transit stop', path);
    a.from = 'transit stop';
    a.to = r.destLabel;
    this.agents.push(a);
  }

  private moveMetro(t: MetroTrain, dt: number) {
    const line = this.transit[t.line];
    const st = line.stationS!;
    if (t.dwell > 0) {
      t.dwell -= dt;
      return;
    }
    const target = st[t.next];
    const remaining = Math.abs(target - t.s);
    t.v = Math.min(22, t.v + 1 * dt, Math.sqrt(2 * 1 * Math.max(0, remaining - 0.3)) + 0.3);
    t.s += t.dir * Math.min(remaining, t.v * dt);
    if (Math.abs(target - t.s) < 0.05) {
      t.s = target;
      t.v = 0;
      const seqDir: 0 | 1 = t.dir > 0 ? 0 : 1;
      const stopId = line.stopSeq[0][t.next];
      t.dwell = Math.max(18, this.serveStop(t.riders, 600, t.line, seqDir, stopId));
      if (t.next + t.dir < 0 || t.next + t.dir >= st.length) {
        t.dir = t.dir > 0 ? -1 : 1;
        // terminal: everyone else gets off, then the train turns back
        for (const r of t.riders.splice(0)) this.egress(r, this.stops[stopId]);
        t.dwell = Math.max(t.dwell, 30);
        // board riders for the new direction
        this.serveStop(t.riders, 600, t.line, t.dir > 0 ? 0 : 1, stopId);
      }
      t.next += t.dir;
    }
  }

  private moveTrain(t: Train, dt: number) {
    const line = this.lines[t.line];
    if (t.dwell > 0) {
      t.dwell -= dt;
      return;
    }
    const vmax = line.kind === 'tram' ? 10 : 17;
    const remaining = t.dir > 0 ? line.len - t.s : t.s;
    const brake = Math.sqrt(2 * 0.8 * Math.max(0, remaining - 2));
    t.v = Math.min(vmax, t.v + 0.8 * dt, brake);
    t.s += t.dir * Math.max(0.3, t.v) * dt;
    if (t.s >= line.len || t.s <= 0) {
      t.s = Math.min(line.len, Math.max(0, t.s));
      t.dir = t.dir > 0 ? -1 : 1;
      t.v = 0;
      t.dwell = 25;
    }
  }

  // ---------- outputs ----------

  private updatePositions() {
    const g = this.graph;
    const sideSign = this.region.driveSide === 'right' ? 1 : -1;
    for (const a of this.agents) {
      const e = g.edges[a.path[Math.min(a.pi, a.path.length - 1)]];
      if (!e) continue;
      const p = g.nodes[e.from].p;
      const s = Math.min(a.s, e.len);
      let off: number;
      if (a.kind === 'pedestrian') off = e.kind === 'footway' || e.kind === 'cycleway' ? a.side * 0.6 : a.side * (e.halfWidth + 1.4);
      else if (a.kind === 'bicycle') off = e.kind === 'footway' || e.kind === 'cycleway' ? 0.4 * sideSign : sideSign * Math.max(0.6, e.halfWidth - 0.7);
      else {
        const lane = a.id % Math.max(1, Math.min(8, e.lanes));
        off = e.oneway ? e.halfWidth - (lane + 0.5) * LANE_WIDTH : (lane + 0.5) * LANE_WIDTH;
        if (a.kind === 'motorcycle') off += ((a.id % 5) - 2) * 0.45;
        off = sideSign * Math.min(off, e.halfWidth);
      }
      // right-hand normal of (dx, dy) is (dy, -dx)
      a.x = p[0] + e.dir[0] * s + e.dir[1] * off;
      a.y = p[1] + e.dir[1] * s - e.dir[0] * off;
      a.hx = e.dir[0];
      a.hy = e.dir[1];
    }
  }

  private along(poly: Poly, s: number, dir: number) {
    let k = 1;
    while (k < poly.cum.length - 1 && poly.cum[k] < s) k++;
    const a = poly.pts[k - 1];
    const b = poly.pts[k];
    const segLen = poly.cum[k] - poly.cum[k - 1] || 1;
    const f = (s - poly.cum[k - 1]) / segLen;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, hx: ((b[0] - a[0]) / segLen) * dir, hy: ((b[1] - a[1]) / segLen) * dir };
  }

  trainCars(): TrainCar[] {
    const out: TrainCar[] = [];
    for (const t of this.metros) {
      const line = this.transit[t.line];
      const poly = line.poly!;
      for (let i = 0; i < 3; i++) {
        const s = Math.min(poly.len, Math.max(0, t.s - t.dir * (i * 17 + 8)));
        out.push({ ...this.along(poly, s, t.dir), elevated: true, carLen: 16, color: line.color });
      }
    }
    for (const t of this.trains) {
      const line = this.lines[t.line];
      for (let i = 0; i < t.cars; i++) {
        const s = Math.min(line.len, Math.max(0, t.s - t.dir * (i * (t.carLen + 1) + t.carLen / 2)));
        let k = 1;
        while (k < line.cum.length - 1 && line.cum[k] < s) k++;
        const a = line.pts[k - 1];
        const b = line.pts[k];
        const segLen = line.cum[k] - line.cum[k - 1] || 1;
        const f = (s - line.cum[k - 1]) / segLen;
        out.push({
          x: a[0] + (b[0] - a[0]) * f,
          y: a[1] + (b[1] - a[1]) * f,
          hx: ((b[0] - a[0]) / segLen) * t.dir,
          hy: ((b[1] - a[1]) / segLen) * t.dir,
          elevated: line.elevated,
          carLen: t.carLen,
        });
      }
    }
    return out;
  }

  stats(): SimStats {
    const active = Object.fromEntries(AGENT_KINDS.map((k) => [k, 0])) as Record<AgentKind, number>;
    let vSum = 0;
    let vN = 0;
    let slow = 0;
    for (const a of this.agents) {
      active[a.kind]++;
      if (isVehicle(a.kind) && a.dwell <= 0) {
        const e = this.graph.edges[a.path[a.pi]];
        vSum += a.v;
        vN++;
        if (e && a.v < e.speed * 0.3) slow++;
      }
    }
    let waiting = 0;
    for (const s of this.stops) waiting += s.waiting.length;
    return {
      time: this.time,
      active,
      trains: this.trains.length,
      tripsCompleted: this.tripsCompleted,
      avgVehicleSpeedKmh: vN ? (vSum / vN) * 3.6 : 0,
      congestion: vN ? slow / vN : 0,
      busRiders: this.busRiders,
      waitingAtStops: waiting,
      lines: this.lineStats(),
      residents: Math.round(this.totals.residents),
      jobs: Math.round(this.totals.jobs),
      signals: this.signals.size,
      busRoutes: this.transit.length,
      rerouted: this.rerouted,
    };
  }

  describe(id: number): AgentInfo | null {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return null;
    return {
      id: a.id, kind: a.kind, purpose: a.purpose, from: a.from, to: a.to,
      speedKmh: (a.kind === 'pedestrian' || a.kind === 'bicycle' ? a.vmax : a.v) * 3.6,
      load: a.bus?.riders.length, cap: a.bus?.cap,
    };
  }

  lineStats(): LineStats[] {
    return this.transit.map((l, li) => {
      let onboard = 0;
      let vehicles = 0;
      for (const a of this.agents) if (a.bus?.line === li) {
        onboard += a.bus.riders.length;
        vehicles++;
      }
      for (const t of this.metros) if (t.line === li) {
        onboard += t.riders.length;
        vehicles++;
      }
      let waiting = 0;
      for (const s of this.stops) for (const r of s.waiting) if (r.line === li) waiting++;
      return { id: l.id, name: l.name, mode: l.mode, color: l.color, generated: l.generated, boardings: l.boardings, onboard, waiting, vehicles };
    });
  }

  /** Transit lines for rendering. */
  transitLines(): TransitLineView[] {
    const g = this.graph;
    return this.transit.map((l) => ({
      id: l.id, name: l.name, mode: l.mode, color: l.color, generated: l.generated,
      pts: l.poly ? l.poly.pts : [g.nodes[g.edges[l.paths![0][0]].from].p, ...l.paths![0].map((e) => g.nodes[g.edges[e].to].p)],
      stops: l.stopSeq[0].map((id) => this.stops[id].p),
    }));
  }

  stopPositions(): Vec2[] {
    return this.stops.map((s) => s.p);
  }
}
