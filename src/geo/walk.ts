import type { Road, Vec2 } from './types';

/**
 * Walking distance along the street network (sidewalks, footpaths, ordinary streets; not motorways or tunnels).
 * Points join the network at the nearest street segment, so a building 20 m off a long block isn't penalised
 * for the distance to the next intersection.
 */
interface WalkGraph {
  pos: Vec2[];
  adj: { to: number; len: number }[][];
  segs: [number, number][];
  grid: Map<number, number[]>; // cell -> segment indices
  stamp: Int32Array; // per-segment visit mark, so a lookup never allocates
  query: number;
}

const CELL = 40;
const key = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
const SNAP = 120; // farther than this from any street: fall back to straight-line distance
const graphs = new WeakMap<Road[], WalkGraph>();

function build(roads: Road[]): WalkGraph {
  const index = new Map<string, number>();
  const pos: Vec2[] = [];
  const adj: { to: number; len: number }[][] = [];
  const segs: [number, number][] = [];
  const grid = new Map<number, number[]>();
  const vertex = (id: string, p: Vec2) => {
    let i = index.get(id);
    if (i === undefined) {
      i = pos.length;
      index.set(id, i);
      pos.push(p);
      adj.push([]);
    }
    return i;
  };
  for (const r of roads) {
    if (r.kind === 'highway' || r.tunnel) continue;
    for (let k = 1; k < r.points.length; k++) {
      const a = vertex(r.nodes[k - 1] ?? `${r.id}:${k - 1}`, r.points[k - 1]);
      const b = vertex(r.nodes[k] ?? `${r.id}:${k}`, r.points[k]);
      const len = Math.hypot(pos[b][0] - pos[a][0], pos[b][1] - pos[a][1]);
      adj[a].push({ to: b, len });
      adj[b].push({ to: a, len });
      const s = segs.push([a, b]) - 1;
      const [x0, x1] = [Math.min(pos[a][0], pos[b][0]), Math.max(pos[a][0], pos[b][0])];
      const [y0, y1] = [Math.min(pos[a][1], pos[b][1]), Math.max(pos[a][1], pos[b][1])];
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const k = key(cx, cy);
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(s);
        }
    }
  }
  return { pos, adj, segs, grid, stamp: new Int32Array(segs.length), query: 0 };
}

/** The nearest street segment to p: its ends, how far along it (metres from each end), and the distance off it. */
function snap(g: WalkGraph, p: Vec2): { s: number; a: number; b: number; da: number; db: number; off: number } | null {
  let best: { s: number; a: number; b: number; da: number; db: number; off: number } | null = null;
  const cx = Math.floor(p[0] / CELL);
  const cy = Math.floor(p[1] / CELL);
  const q = ++g.query;
  const scan = (dx: number, dy: number) => {
    for (const s of g.grid.get(key(cx + dx, cy + dy)) ?? []) {
      if (g.stamp[s] === q) continue;
      g.stamp[s] = q;
      const [a, b] = g.segs[s];
      const A = g.pos[a];
      const B = g.pos[b];
      const vx = B[0] - A[0];
      const vy = B[1] - A[1];
      const L2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * vx + (p[1] - A[1]) * vy) / L2));
      const off = Math.hypot(A[0] + vx * t - p[0], A[1] + vy * t - p[1]);
      if (off <= SNAP && (!best || off < best.off)) {
        const L = Math.sqrt(L2);
        best = { s, a, b, da: t * L, db: (1 - t) * L, off };
      }
    }
  };
  // the 3×3 block always covers CELL metres all round; widen to the full snap radius only if nothing is that close
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) scan(dx, dy);
  if (best && (best as { off: number }).off <= CELL) return best;
  const R = Math.ceil(SNAP / CELL);
  for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) if (Math.abs(dx) > 1 || Math.abs(dy) > 1) scan(dx, dy);
  return best;
}

/** Returns a test "is p within maxM walking metres of any source?" (multi-source Dijkstra, cut off at maxM). */
export function walkReach(roads: Road[], sources: Vec2[], maxM: number): (p: Vec2) => boolean {
  let g = graphs.get(roads);
  if (!g) graphs.set(roads, (g = build(roads)));
  const graph = g;
  const dist = new Float64Array(graph.pos.length).fill(Infinity);
  const heap: [number, number][] = [];
  const push = (v: number, d: number) => {
    if (d >= dist[v] || d > maxM) return;
    dist[v] = d;
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heap[up][0] <= heap[i][0]) break;
      [heap[up], heap[i]] = [heap[i], heap[up]];
      i = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const offNet: Vec2[] = [];
  const onSeg = new Map<number, { along: number; off: number }[]>(); // sources by segment, for direct walks along it
  for (const s of sources) {
    const sn = snap(graph, s);
    if (!sn) {
      offNet.push(s);
      continue;
    }
    (onSeg.get(sn.s) ?? onSeg.set(sn.s, []).get(sn.s)!).push({ along: sn.da, off: sn.off });
    push(sn.a, sn.off + sn.da);
    push(sn.b, sn.off + sn.db);
  }
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    for (const e of graph.adj[v]) push(e.to, d + e.len);
  }
  return (p: Vec2) => {
    const sn = snap(graph, p);
    if (sn) {
      // via either end of the nearest segment, or straight along it to a source on the same segment
      if (Math.min(dist[sn.a] + sn.da, dist[sn.b] + sn.db) + sn.off <= maxM) return true;
      for (const q of onSeg.get(sn.s) ?? []) if (Math.abs(q.along - sn.da) + q.off + sn.off <= maxM) return true;
    }
    // off-network points (plazas, parks without paths) use straight-line distance with a typical detour factor
    const straight = maxM / 1.3;
    if (!sn) for (const s of sources) if (Math.hypot(s[0] - p[0], s[1] - p[1]) < straight) return true;
    for (const s of offNet) if (Math.hypot(s[0] - p[0], s[1] - p[1]) < straight) return true;
    return false;
  };
}
