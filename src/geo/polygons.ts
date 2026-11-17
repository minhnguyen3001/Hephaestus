import type { Vec2 } from './types';

const key = (p: Vec2) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;

/** Join way fragments that share endpoints into the longest possible polylines (closed rings when they close). */
export function joinWays(ways: Vec2[][]): Vec2[][] {
  const left = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const out: Vec2[][] = [];
  while (left.length) {
    let line = left.pop()!;
    let grown = true;
    while (grown && key(line[0]) !== key(line[line.length - 1])) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const w = left[i];
        const s = key(line[0]);
        const e = key(line[line.length - 1]);
        const ws = key(w[0]);
        const we = key(w[w.length - 1]);
        if (e === ws) line = [...line, ...w.slice(1)];
        else if (e === we) line = [...line, ...[...w].reverse().slice(1)];
        else if (s === we) line = [...w, ...line.slice(1)];
        else if (s === ws) line = [...[...w].reverse(), ...line.slice(1)];
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(line);
  }
  return out;
}

export const isClosed = (l: Vec2[]) => l.length >= 4 && key(l[0]) === key(l[l.length - 1]);

/** Sutherland–Hodgman clip of a polygon (open ring) to the square [-E, E]². */
export function clipPolygon(poly: Vec2[], E: number): Vec2[] {
  let pts = poly;
  const edges: [(p: Vec2) => boolean, (a: Vec2, b: Vec2) => Vec2][] = [
    [(p) => p[0] >= -E, (a, b) => lerpAt(a, b, 0, -E)],
    [(p) => p[0] <= E, (a, b) => lerpAt(a, b, 0, E)],
    [(p) => p[1] >= -E, (a, b) => lerpAt(a, b, 1, -E)],
    [(p) => p[1] <= E, (a, b) => lerpAt(a, b, 1, E)],
  ];
  for (const [inside, cut] of edges) {
    if (!pts.length) break;
    const next: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      if (inside(cur)) {
        if (!inside(prev)) next.push(cut(prev, cur));
        next.push(cur);
      } else if (inside(prev)) next.push(cut(prev, cur));
    }
    pts = next;
  }
  return pts;
}

function lerpAt(a: Vec2, b: Vec2, axis: 0 | 1, v: number): Vec2 {
  const t = (v - a[axis]) / (b[axis] - a[axis]);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Cut a polyline into the pieces that lie inside the square. Piece ends are on the boundary when the line crosses it. */
export function clipPolyline(line: Vec2[], E: number): Vec2[][] {
  const pieces: Vec2[][] = [];
  let cur: Vec2[] | null = null;
  const inside = (p: Vec2) => Math.abs(p[0]) <= E && Math.abs(p[1]) <= E;
  for (let i = 1; i < line.length; i++) {
    const seg = clipSegment(line[i - 1], line[i], E);
    if (!seg) {
      cur = null;
      continue;
    }
    const [a, b] = seg;
    if (!cur) {
      cur = [a];
      pieces.push(cur);
    }
    cur.push(b);
    if (!inside(line[i]) || b !== line[i]) cur = null;
  }
  return pieces.filter((p) => p.length >= 2);
}

/** Liang–Barsky. Returns the clipped segment, reusing the original point objects when they're inside. */
function clipSegment(a: Vec2, b: Vec2, E: number): [Vec2, Vec2] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a[0] + E], [dx, E - a[0]], [-dy, a[1] + E], [dy, E - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  if (t0 > t1) return null;
  return [t0 === 0 ? a : [a[0] + dx * t0, a[1] + dy * t0], t1 === 1 ? b : [a[0] + dx * t1, a[1] + dy * t1]];
}

/** Position along the square's perimeter, counter-clockwise from (-E, -E). */
function perimeterParam(p: Vec2, E: number): number {
  const [x, y] = p;
  const d = [Math.abs(y + E), Math.abs(x - E), Math.abs(y - E), Math.abs(x + E)];
  const side = d.indexOf(Math.min(...d));
  if (side === 0) return x + E;
  if (side === 1) return 2 * E + (y + E);
  if (side === 2) return 4 * E + (E - x);
  return 6 * E + (E - y);
}

/**
 * Build sea polygons from OSM coastline lines (land on the left, water on the right) inside the square [-E, E]².
 * Returns water rings plus islands (closed coastline rings fully inside), which are land drawn over water.
 */
export function coastlineWater(lines: Vec2[][], E: number): { water: Vec2[][]; islands: Vec2[][] } {
  const P = 8 * E;
  const corners: [number, Vec2][] = [[2 * E, [E, -E]], [4 * E, [E, E]], [6 * E, [-E, E]], [8 * E, [-E, -E]]];
  const islands: Vec2[][] = [];
  const pieces: { pts: Vec2[]; ts: number; te: number }[] = [];
  const onEdge = (p: Vec2) => Math.abs(Math.abs(p[0]) - E) < 0.01 || Math.abs(Math.abs(p[1]) - E) < 0.01;
  for (const line of joinWays(lines)) {
    if (isClosed(line)) {
      const ring = line.slice(0, -1);
      if (ring.every((p) => Math.abs(p[0]) <= E && Math.abs(p[1]) <= E)) {
        islands.push(ring);
        continue;
      }
    }
    for (const piece of clipPolyline(line, E)) {
      const pts = [...piece].reverse(); // water now on the left
      if (!onEdge(pts[0]) || !onEdge(pts[pts.length - 1])) continue; // dangling data, can't close safely
      pieces.push({ pts, ts: perimeterParam(pts[0], E), te: perimeterParam(pts[pts.length - 1], E) });
    }
  }
  const water: Vec2[][] = [];
  if (!pieces.length) {
    if (islands.length) water.push([[-E, -E], [E, -E], [E, E], [-E, E]]);
    return { water, islands };
  }
  const used = new Set<number>();
  for (let i = 0; i < pieces.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const ring: Vec2[] = [...pieces[i].pts];
    let cur = i;
    for (let guard = 0; guard <= pieces.length; guard++) {
      const te = pieces[cur].te;
      let best = -1;
      let bestD = Infinity;
      pieces.forEach((pc, j) => {
        if (used.has(j) && j !== i) return;
        let d = (((pc.ts - te) % P) + P) % P;
        if (j === cur && d < 1e-6) d = P; // don't immediately re-enter the same piece
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      corners
        .map(([cp, c]) => [(((cp - te) % P) + P) % P, c] as const)
        .filter(([d]) => d > 1e-6 && d < bestD)
        .sort((a, b) => a[0] - b[0])
        .forEach(([, c]) => ring.push(c));
      if (best === i || best < 0) break;
      used.add(best);
      ring.push(...pieces[best].pts);
      cur = best;
    }
    water.push(ring);
  }
  return { water, islands };
}
