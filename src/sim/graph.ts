import type { Road, RoadKind, Vec2 } from '../geo/types';
import { dist } from '../geo/util';

export type Mode = 'car' | 'walk';

export interface GNode {
  id: string;
  p: Vec2;
  out: number[]; // outgoing edge indices
}

export interface GEdge {
  from: number;
  to: number;
  len: number;
  speed: number; // m/s
  car: boolean;
  walk: boolean;
  lanes: number; // lanes in this direction
  roadId: string;
  kind: RoadKind;
  dir: Vec2; // unit direction
  halfWidth: number; // half of total carriageway width
  oneway: boolean;
}

const CAR_KINDS = new Set<RoadKind>(['highway', 'primary', 'secondary', 'tertiary', 'residential', 'service']);
export const LANE_WIDTH = 3.2;

export function roadWidth(r: Pick<Road, 'kind' | 'lanes'>): number {
  if (r.kind === 'footway') return 2.5;
  if (r.kind === 'cycleway') return 2;
  return Math.max(1, r.lanes) * LANE_WIDTH;
}

class Heap {
  private a: [number, number][] = [];
  get size() {
    return this.a.length;
  }
  push(k: number, v: number) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export class RoadGraph {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  index = new Map<string, number>();
  private grids: Record<Mode, Map<string, number[]>> = { car: new Map(), walk: new Map() };
  private static CELL = 60;

  static build(roads: Road[]): RoadGraph {
    const g = new RoadGraph();
    for (const r of roads) {
      if (r.tunnel) continue; // tunnels aren't rendered yet, so keep agents off them too
      const car = CAR_KINDS.has(r.kind);
      const walk = r.kind !== 'highway';
      const speed = r.maxspeedKmh / 3.6;
      const dirLanes = r.oneway ? r.lanes : Math.max(1, Math.floor(r.lanes / 2));
      const halfWidth = roadWidth(r) / 2;
      for (let i = 0; i < r.points.length; i++) {
        if (!g.index.has(r.nodes[i])) {
          g.index.set(r.nodes[i], g.nodes.length);
          g.nodes.push({ id: r.nodes[i], p: r.points[i], out: [] });
        }
      }
      for (let i = 1; i < r.points.length; i++) {
        const a = g.index.get(r.nodes[i - 1])!;
        const b = g.index.get(r.nodes[i])!;
        const len = dist(g.nodes[a].p, g.nodes[b].p);
        if (len < 0.01) continue;
        g.addEdge({ from: a, to: b, len, speed, car, walk, lanes: dirLanes, roadId: r.id, kind: r.kind, halfWidth, oneway: r.oneway });
        g.addEdge({ from: b, to: a, len, speed, car: car && !r.oneway, walk, lanes: dirLanes, roadId: r.id, kind: r.kind, halfWidth, oneway: r.oneway });
      }
    }
    for (const mode of ['car', 'walk'] as Mode[]) {
      // Only snap to the largest connected network, so trips never start on an isolated fragment
      // (which would make every route from it fail after an expensive search).
      const main = g.largestComponent(mode);
      g.nodes.forEach((n, i) => {
        if (!main.has(i) || !n.out.some((e) => g.edges[e][mode])) return;
        const key = g.cellKey(n.p);
        const arr = g.grids[mode].get(key) ?? [];
        arr.push(i);
        g.grids[mode].set(key, arr);
      });
    }
    return g;
  }

  /** Largest weakly connected set of nodes usable by a mode. */
  largestComponent(mode: Mode): Set<number> {
    const adj = new Map<number, number[]>();
    for (const e of this.edges) {
      if (!e[mode]) continue;
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
      (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
    }
    const seen = new Set<number>();
    let best = new Set<number>();
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const comp = new Set<number>([start]);
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        for (const nb of adj.get(stack.pop()!) ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          comp.add(nb);
          stack.push(nb);
        }
      }
      if (comp.size > best.size) best = comp;
    }
    return best;
  }

  private addEdge(e: Omit<GEdge, 'dir'>) {
    if (!e.car && !e.walk) return;
    const pa = this.nodes[e.from].p;
    const pb = this.nodes[e.to].p;
    const edge: GEdge = { ...e, dir: [(pb[0] - pa[0]) / e.len, (pb[1] - pa[1]) / e.len] };
    this.nodes[e.from].out.push(this.edges.length);
    this.edges.push(edge);
  }

  private cellKey(p: Vec2, dx = 0, dy = 0) {
    return `${Math.floor(p[0] / RoadGraph.CELL) + dx},${Math.floor(p[1] / RoadGraph.CELL) + dy}`;
  }

  nearestNode(p: Vec2, mode: Mode, maxRings = 6): number {
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const i of this.grids[mode].get(this.cellKey(p, dx, dy)) ?? []) {
            const d = dist(p, this.nodes[i].p);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      if (best >= 0 && bestD < ring * RoadGraph.CELL) break;
    }
    return best;
  }

  /** A* shortest path. Cars minimize travel time, pedestrians distance. Returns edge indices or null. */
  route(from: number, to: number, mode: Mode, maxExpanded = 12000): number[] | null {
    if (from < 0 || to < 0) return null;
    if (from === to) return [];
    const target = this.nodes[to].p;
    const vmax = mode === 'car' ? 35 : 1;
    const cost = new Map<number, number>([[from, 0]]);
    const via = new Map<number, number>();
    const heap = new Heap();
    heap.push(dist(this.nodes[from].p, target) / vmax, from);
    let expanded = 0;
    while (heap.size) {
      const [, n] = heap.pop();
      if (n === to) {
        const path: number[] = [];
        let cur = to;
        while (cur !== from) {
          const e = via.get(cur)!;
          path.push(e);
          cur = this.edges[e].from;
        }
        return path.reverse();
      }
      if (++expanded > maxExpanded) return null;
      const c = cost.get(n)!;
      for (const ei of this.nodes[n].out) {
        const e = this.edges[ei];
        if (!e[mode]) continue;
        const nc = c + (mode === 'car' ? e.len / e.speed : e.len);
        if (nc < (cost.get(e.to) ?? Infinity)) {
          cost.set(e.to, nc);
          via.set(e.to, ei);
          heap.push(nc + dist(this.nodes[e.to].p, target) / vmax, e.to);
        }
      }
    }
    return null;
  }
}
