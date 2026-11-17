import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Building, Vec2 } from '../geo/types';
import { hash01, signedArea } from '../geo/util';

/** Local (x east, y north) → three.js (x, up, -north). */
export const v3 = (p: Vec2, h = 0) => new THREE.Vector3(p[0], h, -p[1]);

import { ESTIMATED_TINT, PROPOSED_COLOR, USE_COLORS } from './palette';
export { ESTIMATED_TINT, PROPOSED_COLOR, USE_COLORS };

export interface BuildingStyle {
  highlightEstimated: boolean;
}

export function buildingColor(b: Building, style: BuildingStyle): THREE.Color {
  const c = new THREE.Color(b.origin === 'proposed' ? PROPOSED_COLOR : USE_COLORS[b.use]);
  const j = hash01(b.id) * 0.12 - 0.06;
  c.offsetHSL(0, 0, j);
  if (style.highlightEstimated && b.heightSource === 'estimated') c.lerp(new THREE.Color(ESTIMATED_TINT), 0.55);
  return c;
}

/**
 * Extruded building: walls + flat roof, non-indexed so many can be merged into one draw call.
 * Attributes: aWall (1 = facade) and aFacade (meters along perimeter, meters up) drive the window shader.
 */
export function buildingGeometry(b: Building, color: THREE.Color, base = 0): THREE.BufferGeometry {
  let pts = b.footprint;
  if (signedArea(pts) < 0) pts = [...pts].reverse();
  const h = base + b.height;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const wall: number[] = [];
  const fac: number[] = [];
  const roof = color.clone().multiplyScalar(0.82);
  let u = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-3) continue;
    const nx = (y2 - y1) / len;
    const nz = (x2 - x1) / len;
    const A = [x1, base, -y1], B = [x2, base, -y2], C = [x2, h, -y2], D = [x1, h, -y1];
    const fa = [u, 0], fb = [u + len, 0], fc = [u + len, b.height], fd = [u, b.height];
    for (const [p, f] of [[A, fa], [B, fb], [C, fc], [A, fa], [C, fc], [D, fd]] as const) {
      pos.push(...p);
      nrm.push(nx, 0, nz);
      col.push(color.r, color.g, color.b);
      wall.push(1);
      fac.push(...f);
    }
    u += len;
  }
  const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
  for (const t of tris) {
    let [a, b2, c] = t.map((i) => pts[i]);
    if ((b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]) < 0) [b2, c] = [c, b2];
    for (const p of [a, b2, c]) {
      pos.push(p[0], h, -p[1]);
      nrm.push(0, 1, 0);
      col.push(roof.r, roof.g, roof.b);
      wall.push(0);
      fac.push(0, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 1));
  g.setAttribute('aFacade', new THREE.Float32BufferAttribute(fac, 2));
  return g;
}

export type Height = number | ((p: Vec2) => number);
const atH = (y: Height, p: Vec2) => (typeof y === 'number' ? y : y(p));

/** Split long segments so draped geometry follows the terrain. */
export function densify(points: Vec2[], maxSeg: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const k = Math.ceil(Math.hypot(bx - ax, by - ay) / maxSeg);
    for (let j = 1; j <= k; j++) out.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
  }
  return out;
}

/** Ribbon along a polyline with mitered joints (roads, rails, routes), draped on a height function. */
export function ribbonGeometry(rawPoints: Vec2[], width: number, y: Height, color: THREE.Color): THREE.BufferGeometry | null {
  if (rawPoints.length < 2) return null;
  const points = typeof y === 'number' ? rawPoints : densify(rawPoints, 12);
  const hw = width / 2;
  const L: Vec2[] = [];
  const R: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const n1 = normal(prev, p) ?? normal(p, next);
    const n2 = normal(p, next) ?? n1;
    if (!n1 || !n2) continue;
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const scale = Math.min(3, 1 / Math.max(0.3, mx * n1[0] + my * n1[1]));
    L.push([p[0] + mx * hw * scale, p[1] + my * hw * scale]);
    R.push([p[0] - mx * hw * scale, p[1] - my * hw * scale]);
  }
  if (L.length < 2) return null;
  const pos: number[] = [];
  for (let i = 1; i < L.length; i++) {
    for (const q of [L[i - 1], R[i - 1], R[i], L[i - 1], R[i], L[i]]) pos.push(q[0], atH(y, q), -q[1]);
  }
  return flatGeometry(pos, color);
}

function normal(a: Vec2, b: Vec2): Vec2 | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  return l < 1e-6 ? null : [-dy / l, dx / l];
}

export function polygonGeometry(poly: Vec2[], y: Height, color: THREE.Color, holes: Vec2[][] = []): THREE.BufferGeometry | null {
  if (poly.length < 3) return null;
  const all = [poly, ...holes].flat();
  const v2 = (r: Vec2[]) => r.map((p) => new THREE.Vector2(p[0], p[1]));
  const tris = THREE.ShapeUtils.triangulateShape(v2(poly), holes.map(v2));
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(all[i][0], atH(y, all[i]), -all[i][1]);
  return pos.length ? flatGeometry(pos, color) : null;
}

function flatGeometry(pos: number[], color: THREE.Color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const n = pos.length / 3;
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [0, 1, 0]), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [color.r, color.g, color.b]), 3));
  return g;
}

/** Many geometries merged into one mesh, while remembering which source object each triangle belongs to. */
export class PickMesh {
  readonly mesh: THREE.Mesh;
  private starts: number[] = [];
  private ids: string[] = [];
  private base?: Float32Array;

  constructor(items: { id: string; geom: THREE.BufferGeometry }[], material: THREE.Material) {
    let tri = 0;
    for (const it of items) {
      this.starts.push(tri);
      this.ids.push(it.id);
      tri += it.geom.attributes.position.count / 3;
    }
    const merged = items.length ? mergeGeometries(items.map((i) => i.geom)) : null;
    items.forEach((i) => i.geom.dispose());
    this.mesh = new THREE.Mesh(merged ?? new THREE.BufferGeometry(), material);
  }

  idAt(face: number): string | undefined {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= face) lo = mid;
      else hi = mid - 1;
    }
    return this.ids[lo];
  }

  /** Recolour items by id (null = original colour). Ids ending in '#m' (decorations) are left alone. */
  paint(colorFor: (id: string) => THREE.Color | null) {
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    this.base ??= arr.slice();
    const total = attr.count / 3;
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i];
      if (id.endsWith('#m')) continue;
      const c = colorFor(id);
      const end = (i + 1 < this.starts.length ? this.starts[i + 1] : total) * 9;
      for (let k = this.starts[i] * 9; k < end; k += 3) {
        arr[k] = c ? c.r : this.base[k];
        arr[k + 1] = c ? c.g : this.base[k + 1];
        arr[k + 2] = c ? c.b : this.base[k + 2];
      }
    }
    attr.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
  }
}

/** Low-poly agent models: origin at ground, facing +z. */
export function agentGeometry(kind: string): THREE.BufferGeometry {
  const box = (w: number, h: number, l: number, y: number, z = 0) => new THREE.BoxGeometry(w, h, l).translate(0, y + h / 2, z);
  switch (kind) {
    case 'pedestrian':
      return mergeGeometries([
        new THREE.CylinderGeometry(0.2, 0.24, 1.35, 6).translate(0, 0.68, 0),
        new THREE.SphereGeometry(0.17, 6, 4).translate(0, 1.55, 0),
      ])!;
    case 'bicycle':
      return mergeGeometries([box(0.12, 0.7, 1.7, 0.15), box(0.45, 0.9, 0.5, 0.8, -0.1)])!;
    case 'motorcycle':
      return mergeGeometries([box(0.45, 0.6, 1.9, 0.25), box(0.55, 0.75, 0.55, 0.85, -0.15)])!;
    case 'truck':
      return mergeGeometries([box(2.4, 2.6, 2.2, 0.4, 3.2), box(2.5, 3.1, 6.6, 0.45, -1.1)])!;
    case 'bus':
      return mergeGeometries([box(2.55, 2.7, 12, 0.35), box(2.3, 0.25, 9, 3.05)])!;
    case 'train':
      return mergeGeometries([box(3, 3.4, 1, 0.5), box(2.6, 0.3, 0.8, 3.9)])!;
    case 'pillar':
      return box(1.2, 1, 1.2, 0);
    case 'tree': {
      // trunk + two-lobe canopy, coloured per vertex (instance colour tints it)
      const paint = (g: THREE.BufferGeometry, hexc: number) => {
        const ng = g.toNonIndexed();
        const c = new THREE.Color(hexc);
        ng.setAttribute('color', new THREE.Float32BufferAttribute(new Array(ng.attributes.position.count).fill(0).flatMap(() => [c.r, c.g, c.b]), 3));
        ng.deleteAttribute('uv');
        return ng;
      };
      return mergeGeometries([
        paint(new THREE.CylinderGeometry(0.16, 0.24, 2.6, 5).translate(0, 1.3, 0), 0x8a6a4c),
        paint(new THREE.IcosahedronGeometry(2.3, 0).translate(0, 4, 0), 0xffffff),
        paint(new THREE.IcosahedronGeometry(1.6, 0).translate(0.6, 5.4, 0.3), 0xf0f0f0),
      ])!;
    }
    default: // car, taxi
      return mergeGeometries([box(1.85, 0.75, 4.5, 0.3), box(1.65, 0.6, 2.4, 1.05, -0.2)])!;
  }
}
