import type { Building, TransitLineSpec, Vec2, WorldData } from '../geo/types';
import { centroid, dist, hash01, makeSampler, polylineLength, rng, signedArea } from '../geo/util';
import { LANE_WIDTH, RoadGraph, type GEdge } from './graph';
import type { RegionProfile, TravelMode } from './region';

const CYCLE = 64;

export type AgentKind = 'pedestrian' | 'bicycle' | 'motorcycle' | 'car' | 'taxi' | 'truck' | 'bus' | 'emergency';
export const AGENT_KINDS: AgentKind[] = ['pedestrian', 'bicycle', 'motorcycle', 'car', 'taxi', 'truck', 'bus', 'emergency'];
export type Purpose = 'commute' | 'return home' | 'school' | 'shopping' | 'leisure' | 'delivery' | 'to transit stop' | 'from transit stop' | 'transit service' | 'emergency call' | 'event' | 'to pickup' | 'looking for parking' | 'to parking garage';

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
  under: boolean; // inside a road tunnel
  pickupAt?: number; // taxi: path index where the passenger is picked up
  realPurpose?: Purpose;
  parked?: boolean; // parking search already done
}

interface Site {
  label: string;
  station?: boolean; // hospital / civic building that dispatches emergency vehicles
  parking?: boolean; // parking garage / lot
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
  /** Second leg after a transfer. */
  next?: { line: number; dir: 0 | 1; from: number; to: number };
}

type Leg = { line: number; dir: 0 | 1; from: number; to: number };

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
  poly?: Poly; // metro guideway (user) or mapped rail line (real)
  stationS?: number[]; // metro: distance along poly of each stop in stopSeq[0]
  boardings: number;
  level: TrainLevel;
  real?: boolean; // runs on mapped OSM rail with mapped stations
  cars: number;
  carLen: number;
}

export type TrainLevel = 'ground' | 'elevated' | 'deck' | 'under';

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
  real?: boolean;
  level?: TrainLevel;
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
  underground: boolean;
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
  underground?: boolean;
  level: TrainLevel;
}

export interface SimStats {
  time: number;
  active: Record<AgentKind, number>;
  trains: number;
  tripsCompleted: number;
  avgVehicleSpeedKmh: number;
  congestion: number;
  busRiders: number; // transit boardings
  transfers: number;
  cruising: number; // cars searching for parking right now
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
  cx: number; // intersection node
  cy: number;
  hw: number; // half width of the approach road
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

const VEHICLE: Record<'car' | 'taxi' | 'motorcycle' | 'truck' | 'bus' | 'emergency', { len: number; vmax: number; acc: number }> = {
  emergency: { len: 6, vmax: 1.35, acc: 3.2 },
  car: { len: 4.6, vmax: 1, acc: 2.5 },
  taxi: { len: 4.8, vmax: 1.05, acc: 2.6 },
  motorcycle: { len: 2.1, vmax: 1.05, acc: 3.5 },
  truck: { len: 9, vmax: 0.85, acc: 1.2 },
  bus: { len: 12.5, vmax: 0.8, acc: 1.2 },
};
const isVehicle = (k: AgentKind) => k !== 'pedestrian' && k !== 'bicycle';

export type DayType = 'weekday' | 'weekend' | 'holiday';
export type Weather = 'clear' | 'rain' | 'snow' | 'fog';

/** A one-off crowd: attendees arrive over the 90 minutes before `start` and leave 2–3 hours after it. */
export interface CityEvent {
  id: string;
  p: Vec2;
  start: number; // seconds of day
  attendance: number;
  name: string;
}

export interface SimParams {
  day: DayType;
  demandScale: number;
  weather: Weather;
  events: CityEvent[];
}
const WEATHER_SPEED: Record<Weather, number> = { clear: 1, rain: 0.85, snow: 0.65, fog: 0.85 };

/** Daily travel-demand curve in [0,1]. Weekdays: AM/PM commute peaks; weekends: one broad leisure peak. */
export function demandAt(hour: number, day: DayType = 'weekday'): number {
  const g = (mu: number, w: number) => Math.exp(-((hour - mu) ** 2) / (2 * w * w));
  if (day === 'weekend') return Math.min(1, (hour < 6 ? 0.07 : 0.1) + 0.68 * g(14.5, 3.2) + 0.15 * g(21, 1.5));
  if (day === 'holiday') return Math.min(1, (hour < 7 ? 0.05 : 0.08) + 0.5 * g(15, 3.5) + 0.2 * g(20.5, 1.5));
  const night = hour < 5 ? 0.09 : 0.16; // real streets are never empty, even at 03:00
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
  private transfers = 0;
  private rerouted = 0;
  private filled = false;
  private samplers!: Record<'residents' | 'jobs' | 'attract' | 'school' | 'freight' | 'any', ReturnType<typeof makeSampler<Site>>>;
  totals = { residents: 0, jobs: 0 };
  /** Share of street length with bike lanes or cycleways (0..1). */
  bikeShare = 0;
  day: DayType = 'weekday';
  /** Multiplier on travel demand (timeline projections). Capped to protect frame rate. */
  demandScale = 1;
  weather: Weather = 'clear';
  private events: { ev: CityEvent; site: Site }[] = [];

  setParams(p: SimParams) {
    this.day = p.day;
    this.demandScale = p.demandScale;
    this.weather = p.weather;
    this.events = p.events.map((ev) => ({
      ev,
      site: { label: ev.name, c: ev.p, residents: 0, jobs: 0, attract: 0, school: 0, freight: 0, carNode: this.graph.nearestNode(ev.p, 'car'), walkNode: this.graph.nearestNode(ev.p, 'walk') },
    }));
  }

  /** Extra demand from events right now, as a fraction of normal demand, and the trip to make if chosen. */
  private eventPull(): { boost: number; pick?: () => { purpose: Purpose; o?: Site; d?: Site } } {
    const t = this.time;
    let boost = 0;
    let pick: (() => { purpose: Purpose; o?: Site; d?: Site }) | undefined;
    for (const { ev, site } of this.events) {
      const share = Math.min(0.8, (ev.attendance / Math.max(1000, this.totals.residents)) * 4);
      const arriving = t >= ev.start - 5400 && t < ev.start;
      const leaving = t >= ev.start + 7200 && t < ev.start + 10800;
      if (!arriving && !leaving) continue;
      boost += share;
      pick = () => (arriving ? { purpose: 'event', o: this.samplers.residents.sample(this.rand()), d: site } : { purpose: 'event', o: site, d: this.samplers.residents.sample(this.rand()) });
    }
    return { boost, pick };
  }

  constructor(world: WorldData, readonly region: RegionProfile, public maxAgents = 400, seed = 1) {
    this.rand = rng(seed);
    this.graph = RoadGraph.build(world.roads);
    let bike = 0;
    let street = 0;
    for (const r of world.roads) {
      if (r.kind === 'footway' || r.tunnel) continue;
      let l = 0;
      for (let i = 1; i < r.points.length; i++) l += dist(r.points[i - 1], r.points[i]);
      street += l;
      if (r.kind === 'cycleway' || r.bikeLane) bike += l;
    }
    this.bikeShare = street ? bike / street : 0;
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
      this.sites.push({ label: b.name ?? `${b.use} building`, c, ...cap, carNode: -1, walkNode: -1, station: b.use === 'health' || b.use === 'civic', parking: b.use === 'parking' });
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
        cx: p[0],
        cy: p[1],
        hw: e.halfWidth,
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
    this.transit.push({ ...meta, mode: 'bus', paths, stopAtPath, stopSeq: [order(0), order(1)], boardings: 0, level: 'ground', cars: 1, carLen: 12 });
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
          stopSeq: [ids, [...ids].reverse()], poly, stationS: cum, boardings: 0, level: 'deck', cars: 3, carLen: 16,
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
    const segs = world.rails;
    const byEnd = new Map<string, number[]>();
    segs.forEach((r, i) => {
      for (const n of [r.nodes[0], r.nodes[r.nodes.length - 1]]) byEnd.set(n, [...(byEnd.get(n) ?? []), i]);
    });
    const used = new Set<number>();
    const chains: { pts: Vec2[]; elevated: boolean; kind: string; underground: boolean }[] = [];
    segs.forEach((seg, i) => {
      if (used.has(i)) return;
      used.add(i);
      let nodes = [...seg.nodes];
      let pts = [...seg.points];
      let elevated = seg.elevated;
      for (const atEnd of [true, false]) {
        for (;;) {
          const end = atEnd ? nodes[nodes.length - 1] : nodes[0];
          const next = (byEnd.get(end) ?? []).find((j) => !used.has(j) && segs[j].kind === seg.kind && segs[j].tunnel === seg.tunnel);
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
      chains.push({ pts, elevated, kind: seg.kind, underground: seg.tunnel });
    });
    const longest = (under: boolean) =>
      chains
        .filter((c) => c.underground === under)
        .map((c) => ({ ...c, len: polylineLength(c.pts) }))
        .filter((c) => c.len > 400)
        .sort((a, b) => b.len - a.len)
        .slice(0, 8);
    const lines = [...longest(false), ...longest(true)];
    let realN = 0;
    for (const l of lines) {
      const cum = [0];
      for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + dist(l.pts[i - 1], l.pts[i]));
      // Mapped stations along this line turn it into a working transit line riders can use.
      if (this.addRealLine({ pts: l.pts, cum, len: l.len }, l, world.stations ?? [], realN)) {
        realN++;
        continue;
      }
      this.lines.push({ pts: l.pts, cum, len: l.len, elevated: l.elevated, underground: l.underground, kind: l.kind });
      const tram = l.kind === 'tram';
      this.trains.push({
        line: this.lines.length - 1, s: this.rand() * l.len, dir: this.rand() < 0.5 ? 1 : -1, v: 0, dwell: 0,
        cars: tram ? 2 : 4, carLen: tram ? 14 : 18,
      });
    }
  }

  private addRealLine(poly: Poly, l: { kind: string; elevated: boolean; underground: boolean }, stations: { p: Vec2; name?: string }[], n: number): boolean {
    const onLine: { s: number; p: Vec2; name?: string }[] = [];
    for (const st of stations) {
      let best = { s: 0, d: Infinity, p: st.p as Vec2 };
      for (let i = 1; i < poly.pts.length; i++) {
        const a = poly.pts[i - 1];
        const b = poly.pts[i];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((st.p[0] - a[0]) * dx + (st.p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const q: Vec2 = [a[0] + dx * t, a[1] + dy * t];
        const d = dist(q, st.p);
        if (d < best.d) best = { s: poly.cum[i - 1] + t * (poly.cum[i] - poly.cum[i - 1]), d, p: q };
      }
      if (best.d < 90) onLine.push({ s: best.s, p: best.p, name: st.name });
    }
    onLine.sort((a, b) => a.s - b.s);
    const kept = onLine.filter((x, i) => i === 0 || x.s - onLine[i - 1].s > 150);
    if (kept.length < 2) return false;
    const li = this.transit.length;
    const ids = kept.map((k) => {
      const id = this.stops.length;
      this.stops.push({ id, p: k.p, walkNode: this.graph.nearestNode(k.p, 'walk'), waiting: [], lines: new Set([li]) });
      return id;
    });
    const tram = l.kind === 'tram';
    const label = l.kind === 'subway' ? 'Subway' : tram ? 'Tram' : l.kind === 'light_rail' ? 'Light rail' : 'Rail';
    const ends = [kept[0].name, kept[kept.length - 1].name];
    this.transit.push({
      id: `osm-rail-${n}`, name: ends[0] && ends[1] ? `${label}: ${ends[0]} – ${ends[1]}` : `${label} line ${n + 1}`,
      mode: 'metro', color: l.kind === 'subway' ? 0x9b59b6 : tram ? 0x16a085 : 0x7f8c8d, generated: true, real: true,
      stopSeq: [ids, [...ids].reverse()], poly: { ...poly, len: poly.len }, stationS: kept.map((k) => k.s), boardings: 0,
      level: l.underground ? 'under' : l.elevated ? 'elevated' : 'ground', cars: tram ? 2 : 4, carLen: tram ? 14 : 18,
    });
    const span = kept[kept.length - 1].s - kept[0].s;
    const trains = Math.max(2, Math.ceil(span / 1200));
    for (let k = 0; k < trains; k++) {
      const dir: 1 | -1 = k % 2 ? -1 : 1;
      const idx = Math.min(kept.length - 1, Math.floor((k / trains) * kept.length));
      this.metros.push({ line: li, s: kept[idx].s, dir, next: Math.max(0, Math.min(kept.length - 1, idx + dir)), v: 0, dwell: 5 + k * 7, riders: [] });
    }
    return true;
  }

  // ---------- trips ----------

  private newAgent(kind: AgentKind, purpose: Purpose, path: number[]): Agent {
    const veh = isVehicle(kind) ? VEHICLE[kind as keyof typeof VEHICLE] : null;
    const vmax = kind === 'pedestrian' ? 1.15 + this.rand() * 0.4 : kind === 'bicycle' ? 4 + this.rand() * 1.5 : veh!.vmax * (0.9 + this.rand() * 0.2);
    return {
      id: this.nextId++, kind, purpose, path, pi: 0, s: 0, v: 0, vmax,
      len: veh?.len ?? (kind === 'bicycle' ? 1.8 : 0.5),
      side: this.rand() < 0.5 ? 1 : -1, dwell: 0, stopped: 0, done: false, x: 0, y: 0, hx: 1, hy: 0, under: false,
    };
  }

  private pickPurpose(): { purpose: Purpose; o?: Site; d?: Site } {
    const h = this.time / 3600;
    const pull = this.eventPull();
    if (pull.pick && this.rand() < pull.boost / (1 + pull.boost)) return pull.pick();
    const r = this.rand();
    const s = this.samplers;
    const pick = (k: keyof typeof s) => s[k].sample(this.rand());
    if (h >= 9 && h < 18 && r < (this.day === 'weekend' ? 0.03 : 0.07)) return { purpose: 'delivery', o: pick('freight'), d: pick('attract') };
    if (this.day !== 'weekday') {
      if (r < (this.day === 'holiday' ? 0.04 : 0.12)) return { purpose: 'commute', o: pick('residents'), d: pick('jobs') };
    } else if (h >= 5 && h < 10.5) {
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
    if (this.weather === 'rain' || this.weather === 'snow') {
      // bad weather pushes trips from walking/cycling to transit and cars
      const f = this.weather === 'snow' ? 0.35 : 0.55;
      const moved = (w.walk + w.bicycle + w.motorcycle) * (1 - f);
      w.walk *= f;
      w.bicycle *= f;
      w.motorcycle *= f;
      w.bus += moved * 0.5;
      w.car += moved * 0.35;
      w.taxi += moved * 0.15;
    }
    w.walk *= d < 400 ? 8 : d < 1000 ? 2 : d > 2500 ? 0.1 : 1;
    // more protected bike network → more people choose to cycle (capped)
    w.bicycle *= (d < 300 ? 0.3 : 1) * (1 + Math.min(1.5, this.bikeShare * 3));
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
  /** All downstream stops reachable from a stop: [line, dir, stop index in sequence, later stop id]. */
  private *ridesFrom(stopId: number): Generator<{ line: number; dir: 0 | 1; to: number }> {
    for (const li of this.stops[stopId].lines) {
      for (const dir of [0, 1] as const) {
        const seq = this.transit[li].stopSeq[dir];
        const i = seq.indexOf(stopId);
        if (i < 0) continue;
        for (let j = i + 1; j < seq.length; j++) yield { line: li, dir, to: seq[j] };
      }
    }
  }

  /** Best ride from each stop to every reachable stop (direct, or with one transfer within 150 m). Built once. */
  private reach?: Map<number, Map<number, { first: Leg; next?: Leg }>>;

  private buildReach() {
    const TRANSFER = 150;
    const near = new Map<number, number[]>();
    for (const a of this.stops) near.set(a.id, this.stops.filter((b) => dist(a.p, b.p) <= TRANSFER).map((b) => b.id));
    const reach = new Map<number, Map<number, { first: Leg; next?: Leg }>>();
    for (const a of this.stops) {
      const m = new Map<number, { first: Leg; next?: Leg }>();
      const direct: Leg[] = [];
      for (const r of this.ridesFrom(a.id)) {
        if (!m.has(r.to)) {
          const leg = { line: r.line, dir: r.dir, from: a.id, to: r.to };
          m.set(r.to, { first: leg });
          direct.push(leg);
        }
      }
      for (const leg of direct) {
        for (const t2 of near.get(leg.to) ?? []) {
          for (const r2 of this.ridesFrom(t2)) {
            if (r2.line === leg.line || m.has(r2.to)) continue;
            m.set(r2.to, { first: leg, next: { line: r2.line, dir: r2.dir, from: t2, to: r2.to } });
          }
        }
      }
      reach.set(a.id, m);
    }
    this.reach = reach;
  }

  private planTransit(o: Site, d: Site): { first: Leg; next?: Leg } | null {
    const MAX = 700;
    this.reach ??= (this.buildReach(), this.reach);
    const origins = this.stops.filter((s) => dist(o.c, s.p) <= MAX);
    if (!origins.length) return null;
    const dests = this.stops.filter((s) => dist(s.p, d.c) <= MAX);
    let best: { first: Leg; next?: Leg } | null = null;
    let bestCost = dist(o.c, d.c) * 0.8; // must beat walking most of the way
    for (const a of origins) {
      const m = this.reach!.get(a.id)!;
      const wa = dist(o.c, a.p);
      for (const b of dests) {
        const plan = m.get(b.id);
        if (!plan) continue;
        const cost = wa + dist(b.p, d.c) + (plan.next ? 300 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = plan;
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
    let pickup: number | undefined;
    let stopId: number | undefined;
    if (mode === 'bus') {
      const plan = this.planTransit(o, d);
      if (plan) {
        const { first, next } = plan;
        rider = { line: first.line, dir: first.dir, to: first.to, destWalk: d.walkNode, destLabel: d.label, next };
        stopId = first.from;
        const stop = this.stops[first.from];
        path = g.route(o.walkNode, stop.walkNode, 'walk');
        if (path && path.length === 0) {
          stop.waiting.push(rider); // already at the stop
          return true;
        }
        p = 'to transit stop';
        to = `${this.transit[first.line].name} stop${next ? ` (then ${this.transit[next.line].name})` : ''}`;
      } else mode = D < 1500 ? 'walk' : 'car';
    }
    if (mode === 'walk' || (mode === 'bus' && !path)) {
      kind = 'pedestrian';
      path ??= g.route(o.walkNode, d.walkNode, 'walk');
    } else if (mode === 'bus') {
      kind = 'pedestrian';
    } else if (mode === 'bicycle') {
      kind = 'bicycle';
      path = g.route(o.walkNode, d.walkNode, 'bike');
    } else {
      kind = mode;
      if (o.carNode < 0 || d.carNode < 0) return false;
      path = g.route(o.carNode, d.carNode, 'car');
      // Taxis and ride-hail cars first drive empty to the passenger.
      if (kind === 'taxi' && path?.length && this.filled) {
        const start = this.nodeNear(g.nodes[o.carNode].p, 300, 900);
        const pre = start >= 0 ? g.route(start, o.carNode, 'car') : null;
        if (pre?.length) {
          const a0 = path;
          path = [...pre, ...a0];
          pickup = pre.length;
        }
      }
    }
    if (!path || path.length === 0) return false;
    const a = this.newAgent(kind, p, path);
    a.from = o.label;
    a.to = to;
    a.rider = rider;
    a.stopId = stopId;
    if (pickup !== undefined) {
      a.pickupAt = pickup;
      a.realPurpose = p;
      a.purpose = 'to pickup';
    }
    if (!this.filled) {
      a.pi = Math.floor(this.rand() * path.length);
      a.s = this.rand() * g.edges[path[a.pi]].len;
      a.v = isVehicle(kind) ? g.edges[path[a.pi]].speed * 0.6 : a.vmax;
    }
    this.agents.push(a);
    return true;
  }

  /** Set the clock. A jump of more than 30 min re-seeds traffic for the new hour, so 08:00 looks like rush hour at once. */
  jumpTo(t: number) {
    const gap = Math.abs(((t - this.time + 129600) % 86400) - 43200);
    this.time = ((t % 86400) + 86400) % 86400;
    if (gap <= 1800) return;
    const target = Math.round(this.maxAgents * Math.min(1.8, this.demandScale) * demandAt(this.time / 3600, this.day));
    // drop surplus ordinary trips (never buses, riders or emergency calls); the next ticks spawn mid-trip up to demand
    let movers = this.agents.filter((a) => !a.bus).length;
    for (const a of this.agents) {
      if (movers <= target) break;
      if (a.bus || a.rider || a.kind === 'emergency') continue;
      a.done = true;
      movers--;
    }
    this.agents = this.agents.filter((a) => !a.done);
    this.filled = false;
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
    const pull = this.eventPull();
    const target = Math.round(this.maxAgents * Math.min(1.8, this.demandScale * (1 + pull.boost)) * demandAt(this.time / 3600, this.day));
    let movers = 0;
    for (const a of this.agents) if (!a.bus) movers++;
    // While warming up, spawn in bounded batches (placed mid-trip) so no single tick stalls.
    for (let tries = 0; movers < target && tries < (this.filled ? 6 : 60); tries++) if (this.spawnTrip()) movers++;
    if (movers >= target * 0.9) this.filled = true;
    this.dispatchEmergency(dt);

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
    if (a.kind === 'emergency') {
      // Emergency vehicles proceed through red with caution instead of stopping.
      if (sig !== 'green' && toEnd < 25) gap = Math.min(gap, toEnd + 6);
    } else if (sig === 'red' || (sig === 'yellow' && toEnd > a.v * 1.5)) gap = Math.min(gap, toEnd - 1);
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
    const vDesired = e.speed * a.vmax * WEATHER_SPEED[this.weather];
    const vSafe = gap === Infinity ? Infinity : Math.max(0, (gap - 1.5) / 1.1);
    const vTarget = Math.min(vDesired, vSafe);
    a.v = Math.max(0, Math.min(vTarget, a.v + spec.acc * dt));
    a.s += a.v * dt;
    a.stopped = a.v < 0.1 ? a.stopped + dt : 0;
    if (a.stopped > (a.kind === 'emergency' ? 60 : 150) && !a.bus) {
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
      if (a.pickupAt === a.pi) {
        a.dwell = 12; // passenger gets in
        a.s = 0;
        a.purpose = a.realPurpose ?? a.purpose;
        a.pickupAt = undefined;
        break;
      }
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

  private emergencyT = 5;
  /** Occasionally send an emergency vehicle from a hospital or civic station to a random call. */
  private dispatchEmergency(dt: number) {
    this.emergencyT -= dt;
    if (this.emergencyT > 0) return;
    this.emergencyT = 60 + this.rand() * 120;
    const active = this.agents.filter((a) => a.kind === 'emergency').length;
    if (active >= Math.max(1, Math.round(this.maxAgents / 250))) return;
    const stations = this.sites.filter((s) => s.station && s.carNode >= 0);
    const o = stations[Math.floor(this.rand() * stations.length)];
    const d = this.samplers.any.sample(this.rand());
    if (!o || !d || d.carNode < 0) return;
    const path = this.graph.route(o.carNode, d.carNode, 'car');
    if (!path?.length) return;
    const a = this.newAgent('emergency', 'emergency call', path);
    a.from = o.label;
    a.to = d.label;
    this.agents.push(a);
  }

  /** A random car-network node between rmin and rmax meters from p (or -1). */
  private nodeNear(p: Vec2, rmin: number, rmax: number): number {
    const g = this.graph;
    for (let k = 0; k < 12; k++) {
      const ang = this.rand() * Math.PI * 2;
      const r = rmin + this.rand() * (rmax - rmin);
      const n = g.nearestNode([p[0] + Math.cos(ang) * r, p[1] + Math.sin(ang) * r], 'car', 3);
      if (n >= 0 && dist(g.nodes[n].p, p) >= rmin * 0.6) return n;
    }
    return -1;
  }

  private jobsNear(p: Vec2): number {
    let j = 0;
    for (const s of this.sites) if (Math.abs(s.c[0] - p[0]) < 250 && Math.abs(s.c[1] - p[1]) < 250) j += s.jobs;
    return j;
  }

  /** Private cars arriving where jobs are dense either head for a nearby garage or cruise for a space. */
  private parkOrArrive(a: Agent): boolean {
    if (a.kind !== 'car' || a.parked || a.purpose === 'delivery') return false;
    a.parked = true;
    const g = this.graph;
    const end = g.edges[a.path[a.path.length - 1]].to;
    const p = g.nodes[end].p;
    const garage = this.sites.find((s) => s.parking && s.carNode >= 0 && dist(s.c, p) < 250);
    let ext: number[] | null = null;
    if (garage) {
      ext = g.route(end, garage.carNode, 'car');
      a.purpose = 'to parking garage';
    } else if (this.rand() < Math.min(0.7, this.jobsNear(p) / 3000)) {
      const n = this.nodeNear(p, 150, 400);
      ext = n >= 0 ? g.route(end, n, 'car') : null;
      a.purpose = 'looking for parking';
    }
    if (!ext?.length) return false;
    a.path = ext;
    a.pi = 0;
    a.s = 0;
    return true;
  }

  private arrive(a: Agent) {
    if (this.parkOrArrive(a)) return;
    a.done = true;
    if (a.rider && a.stopId !== undefined) this.stops[a.stopId].waiting.push(a.rider);
    else this.tripsCompleted++;
  }

  /** Alight riders for this stop (they walk on), board waiting riders for this line and direction. Returns dwell seconds. */
  private serveStop(riders: Rider[], cap: number, line: number, dir: 0 | 1, stopId: number): number {
    const stop = this.stops[stopId];
    let alight = 0;
    for (let i = riders.length - 1; i >= 0; i--) {
      const r = riders[i];
      if (r.to !== stopId) continue;
      if (r.next) {
        // transfer: wait for the second line at the (nearby) transfer stop
        this.stops[r.next.from].waiting.push({ ...r, line: r.next.line, dir: r.next.dir, to: r.next.to, next: undefined });
        this.transfers++;
      } else this.egress(r, stop);
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
      a.under = e.tunnel;
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
      for (let i = 0; i < line.cars; i++) {
        const s = Math.min(poly.len, Math.max(0, t.s - t.dir * (i * (line.carLen + 1) + line.carLen / 2)));
        out.push({ ...this.along(poly, s, t.dir), elevated: line.level !== 'ground', carLen: line.carLen, color: line.color, level: line.level, underground: line.level === 'under' || undefined });
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
          underground: line.underground || undefined,
          level: line.underground ? 'under' : line.elevated ? 'elevated' : 'ground',
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
      transfers: this.transfers,
      cruising: this.agents.filter((a) => a.purpose === 'looking for parking').length,
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
      id: l.id, name: l.name, mode: l.mode, color: l.color, generated: l.generated, real: l.real, level: l.level,
      pts: l.poly ? l.poly.pts : [g.nodes[g.edges[l.paths![0][0]].from].p, ...l.paths![0].map((e) => g.nodes[g.edges[e].to].p)],
      stops: l.stopSeq[0].map((id) => this.stops[id].p),
    }));
  }

  stopPositions(): Vec2[] {
    return this.stops.map((s) => s.p);
  }
}
