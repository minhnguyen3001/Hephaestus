import type { Building, BuildingUse, Road, Vec2, WorldData } from '../geo/types';

/**
 * A scenario is the immutable real-world base plus an ordered list of edits.
 * The base data is never mutated, so "original vs proposed" is always one toggle away.
 */
export type Edit =
  | { kind: 'setHeight'; id: string; height: number }
  | { kind: 'setUse'; id: string; use: BuildingUse }
  | { kind: 'demolish'; id: string }
  | { kind: 'addBuilding'; building: Building }
  | { kind: 'addRoad'; road: Road }
  | { kind: 'removeRoad'; id: string };

export function applyEdits(base: WorldData, edits: Edit[]): WorldData {
  if (edits.length === 0) return base;
  const buildings = new Map(base.buildings.map((b) => [b.id, b]));
  const roads = new Map(base.roads.map((r) => [r.id, r]));
  for (const e of edits) {
    switch (e.kind) {
      case 'setHeight': {
        const b = buildings.get(e.id);
        if (b) buildings.set(e.id, { ...b, height: e.height, heightSource: 'user' });
        break;
      }
      case 'setUse': {
        const b = buildings.get(e.id);
        if (b) buildings.set(e.id, { ...b, use: e.use, useSource: 'user' });
        break;
      }
      case 'demolish':
        buildings.delete(e.id);
        break;
      case 'addBuilding':
        buildings.set(e.building.id, e.building);
        break;
      case 'addRoad':
        roads.set(e.road.id, connectRoad(roads, e.road));
        break;
      case 'removeRoad':
        roads.delete(e.id);
        break;
    }
  }
  return { ...base, buildings: [...buildings.values()], roads: [...roads.values()] };
}

export interface History {
  edits: Edit[];
  redo: Edit[];
}

export const pushEdit = (h: History, e: Edit): History => ({ edits: [...h.edits, e], redo: [] });

export const undo = (h: History): History =>
  h.edits.length ? { edits: h.edits.slice(0, -1), redo: [...h.redo, h.edits[h.edits.length - 1]] } : h;

export const redo = (h: History): History =>
  h.redo.length ? { edits: [...h.edits, h.redo[h.redo.length - 1]], redo: h.redo.slice(0, -1) } : h;

export function describeEdit(e: Edit): string {
  switch (e.kind) {
    case 'setHeight': return `Height → ${Math.round(e.height)} m`;
    case 'setUse': return `Use → ${e.use}`;
    case 'demolish': return 'Demolish building';
    case 'addBuilding': return 'New building';
    case 'addRoad': return 'New road';
    case 'removeRoad': return 'Remove road';
  }
}

const CONNECTABLE = new Set(['highway', 'primary', 'secondary', 'tertiary', 'residential', 'service']);

function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const r = [b[0] - a[0], b[1] - a[1]];
  const q = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? { t, u } : null;
}

function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): { u: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return { u, d: Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy) };
}

/**
 * Make a proposed road part of the network: wherever it crosses an existing street, both roads get a shared
 * node (a real intersection); an endpoint that lands on a street forms a T-junction. Mutates `roads` copies only.
 */
export function connectRoad(roads: Map<string, Road>, road: Road): Road {
  if (!CONNECTABLE.has(road.kind) || road.bridge || road.tunnel) return road;
  const cuts: { t: number; p: Vec2; node: string }[] = [];
  const endNodes = [...road.nodes];
  for (const other of [...roads.values()]) {
    if (other.id === road.id || !CONNECTABLE.has(other.kind) || other.bridge || other.tunnel) continue;
    const pts = [...other.points];
    const nodes = [...other.nodes];
    let changed = false;
    for (let i = 1; i < pts.length; i++) {
      for (let k = 1; k < road.points.length; k++) {
        const a = road.points[k - 1];
        const b = road.points[k];
        const hit = segIntersect(a, b, pts[i - 1], pts[i]);
        if (!hit) continue;
        const p: Vec2 = [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t];
        const node = `x-${road.id}-${other.id}-${i}`;
        cuts.push({ t: k - 1 + hit.t, p, node });
        pts.splice(i, 0, p);
        nodes.splice(i, 0, node);
        changed = true;
        i++; // skip the half we just created
        break;
      }
    }
    // T-junctions: a free endpoint lying on this street.
    for (const end of [0, road.points.length - 1]) {
      if (!endNodes[end].startsWith('u-n-')) continue;
      const p = road.points[end];
      for (let i = 1; i < pts.length; i++) {
        const { u, d } = nearestOnSegment(p, pts[i - 1], pts[i]);
        if (d > 4 || u <= 0.01 || u >= 0.99) continue;
        const node = `t-${road.id}-${end}`;
        pts.splice(i, 0, p);
        nodes.splice(i, 0, node);
        endNodes[end] = node;
        changed = true;
        break;
      }
    }
    if (changed) roads.set(other.id, { ...other, points: pts, nodes });
  }
  if (!cuts.length && endNodes.every((n, i) => n === road.nodes[i])) return road;
  cuts.sort((x, y) => x.t - y.t);
  const points: Vec2[] = [];
  const nodes: string[] = [];
  road.points.forEach((p, k) => {
    points.push(p);
    nodes.push(endNodes[k] ?? road.nodes[k]);
    for (const c of cuts) {
      if (c.t > k && c.t < k + 1) {
        points.push(c.p);
        nodes.push(c.node);
      }
    }
  });
  return { ...road, points, nodes };
}
