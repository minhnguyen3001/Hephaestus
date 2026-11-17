import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Building, BuildingUse, Vec2 } from '../geo/types';
import { hash01, signedArea } from '../geo/util';

/** Local (x east, y north) → three.js (x, up, -north). */
export const v3 = (p: Vec2, h = 0) => new THREE.Vector3(p[0], h, -p[1]);

export const USE_COLORS: Record<BuildingUse, number> = {
  residential: 0xead9c3,
  commercial: 0xf1b98f,
  office: 0xb8c8d9,
  industrial: 0xcac3b3,
  education: 0xe8cc76,
  health: 0xf0a6a6,
  civic: 0xc9b6e2,
  religious: 0xe2cfaa,
  parking: 0xaeb0b2,
  unknown: 0xdfd8cd,
};
export const PROPOSED_COLOR = 0x3fd3c3;
export const ESTIMATED_TINT = 0xff9a3c;

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
export function buildingGeometry(b: Building, color: THREE.Color): THREE.BufferGeometry {
  let pts = b.footprint;
  if (signedArea(pts) < 0) pts = [...pts].reverse();
  const h = b.height;
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
    const A = [x1, 0, -y1], B = [x2, 0, -y2], C = [x2, h, -y2], D = [x1, h, -y1];
    const fa = [u, 0], fb = [u + len, 0], fc = [u + len, h], fd = [u, h];
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

/** Flat ribbon along a polyline with mitered joints (roads, rails, routes). */
export function ribbonGeometry(points: Vec2[], width: number, y: number, color: THREE.Color): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
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
    for (const q of [L[i - 1], R[i - 1], R[i], L[i - 1], R[i], L[i]]) pos.push(q[0], y, -q[1]);
  }
  return flatGeometry(pos, color);
}

function normal(a: Vec2, b: Vec2): Vec2 | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  return l < 1e-6 ? null : [-dy / l, dx / l];
}

export function polygonGeometry(poly: Vec2[], y: number, color: THREE.Color): THREE.BufferGeometry | null {
  if (poly.length < 3) return null;
  const tris = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []);
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(poly[i][0], y, -poly[i][1]);
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
    default: // car, taxi
      return mergeGeometries([box(1.85, 0.75, 4.5, 0.3), box(1.65, 0.6, 2.4, 1.05, -0.2)])!;
  }
}
