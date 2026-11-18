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
  // facade style: 1 punched windows, 2 glass curtain wall (towers), 3 blank (industrial, parking)
  const style = b.height > 40 && (b.use === 'office' || b.height > 70) ? 2
    : b.use === 'industrial' || b.use === 'parking' ? 3
    : b.use === 'commercial' || (b.height > 9 && b.use !== 'residential' && hash01(b.id + 's') < 0.4) ? 4 // shops on the ground floor
    : 1;
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
      wall.push(style);
      fac.push(...f);
    }
    u += len;
  }
  // Small rectangular houses get a pitched (gable) roof along their long axis.
  const gable = pitchedRoof(b, pts);
  if (gable) {
    const rc = new THREE.Color(hash01(b.id + 'r') < 0.5 ? 0x9c5a44 : 0x6b6f78).offsetHSL(0, 0, hash01(b.id) * 0.08 - 0.04);
    const ridge = h + gable.rise;
    const [a, bb, c, d] = gable.quad; // a-b and c-d are the long sides
    const mid1: Vec2 = [(bb[0] + c[0]) / 2, (bb[1] + c[1]) / 2];
    const mid2: Vec2 = [(d[0] + a[0]) / 2, (d[1] + a[1]) / 2];
    const tri = (p1: [number, number, number], p2: [number, number, number], p3: [number, number, number], col: THREE.Color) => {
      const n = new THREE.Vector3(...p2).sub(new THREE.Vector3(...p1)).cross(new THREE.Vector3(...p3).sub(new THREE.Vector3(...p1))).normalize();
      if (n.y < -1e-6) [p2, p3] = [p3, p2];
      const nn = new THREE.Vector3(...p2).sub(new THREE.Vector3(...p1)).cross(new THREE.Vector3(...p3).sub(new THREE.Vector3(...p1))).normalize();
      for (const q of [p1, p2, p3]) {
        pos.push(...q);
        nrm.push(nn.x, nn.y, nn.z);
        col3(col);
        wall.push(0);
        fac.push(0, 0);
      }
    };
    const col3 = (c3: THREE.Color) => col.push(c3.r, c3.g, c3.b);
    const P = (p: Vec2, y: number): [number, number, number] => [p[0], y, -p[1]];
    // two slopes
    tri(P(a, h), P(bb, h), P(mid1, ridge), rc);
    tri(P(a, h), P(mid1, ridge), P(mid2, ridge), rc);
    tri(P(c, h), P(d, h), P(mid2, ridge), rc);
    tri(P(c, h), P(mid2, ridge), P(mid1, ridge), rc);
    // gable ends (wall colour)
    tri(P(bb, h), P(c, h), P(mid1, ridge), color);
    tri(P(d, h), P(a, h), P(mid2, ridge), color);
    return finish();
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
  return finish();

  function finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 1));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(fac, 2));
    return g;
  }
}

/** Gable roof for low, small, near-rectangular residential/unknown buildings. Returns quad ordered long-side first. */
export function pitchedRoof(b: Building, pts: Vec2[]): { quad: [Vec2, Vec2, Vec2, Vec2]; rise: number } | null {
  if (pts.length !== 4 || b.height > 14 || b.origin === 'proposed') return null;
  if (b.use !== 'residential' && b.use !== 'unknown' && b.use !== 'religious') return null;
  const L = (i: number) => Math.hypot(pts[(i + 1) % 4][0] - pts[i][0], pts[(i + 1) % 4][1] - pts[i][1]);
  const area = Math.abs(signedArea(pts));
  if (area > 450 || area < 25) return null;
  // near-rectangular: area close to product of adjacent sides
  if (Math.abs(area - L(0) * L(1)) / area > 0.15) return null;
  const q = L(0) >= L(1) ? pts : [pts[1], pts[2], pts[3], pts[0]];
  const short = Math.min(L(0), L(1));
  return { quad: q as [Vec2, Vec2, Vec2, Vec2], rise: Math.min(4, short * 0.35) };
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

/** A polyline shifted sideways by d meters (positive = left of travel direction). */
export function offsetLine(points: Vec2[], d: number): Vec2[] {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / l) * d, p[1] + (dx / l) * d] as Vec2;
  });
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

/** Paint a geometry one colour (white parts take the instance colour; dark parts stay dark). */
function paint(g: THREE.BufferGeometry, hexc: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hexc);
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (ng.attributes.uv) ng.deleteAttribute('uv');
  return ng;
}

/** Low-poly agent models: origin at ground, facing +z. Parts are vertex-coloured; instances tint the white parts. */
export function agentGeometry(kind: string): THREE.BufferGeometry {
  const box = (w: number, h: number, l: number, y: number, z = 0, x = 0) => new THREE.BoxGeometry(w, h, l).translate(x, y + h / 2, z);
  const BODY = 0xffffff;
  const GLASS = 0x2b3440;
  const TYRE = 0x1b1b1b;
  const wheel = (x: number, z: number, r: number, w: number) => paint(new THREE.CylinderGeometry(r, r, w, 8).rotateZ(Math.PI / 2).translate(x, r, z), TYRE);
  const wheels = (halfTrack: number, zs: number[], r: number, w = 0.26) => zs.flatMap((z) => [wheel(halfTrack, z, r, w), wheel(-halfTrack, z, r, w)]);
  const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts)!;
  switch (kind) {
    case 'pedestrian':
      return merge([
        paint(box(0.14, 0.78, 0.18, 0, 0, 0.1), 0x2f3640), // legs
        paint(box(0.14, 0.78, 0.18, 0, 0, -0.1), 0x2f3640),
        paint(new THREE.CylinderGeometry(0.19, 0.22, 0.62, 6).translate(0, 1.1, 0), BODY), // torso (clothes colour)
        paint(new THREE.SphereGeometry(0.15, 6, 4).translate(0, 1.58, 0), 0xe2b48c), // head
      ]);
    case 'bicycle':
      return merge([
        wheel(0, 0.6, 0.34, 0.06), wheel(0, -0.6, 0.34, 0.06),
        paint(box(0.08, 0.08, 1.1, 0.55), BODY),
        paint(new THREE.CylinderGeometry(0.18, 0.2, 0.6, 6).translate(0, 1.15, -0.1), BODY),
        paint(new THREE.SphereGeometry(0.14, 6, 4).translate(0, 1.6, -0.05), 0xe2b48c),
      ]);
    case 'motorcycle':
      return merge([
        wheel(0, 0.7, 0.3, 0.12), wheel(0, -0.7, 0.3, 0.12),
        paint(box(0.4, 0.45, 1.5, 0.35), BODY),
        paint(new THREE.CylinderGeometry(0.2, 0.22, 0.6, 6).translate(0, 1.15, -0.15), 0x3a3f47),
        paint(new THREE.SphereGeometry(0.17, 6, 4).translate(0, 1.6, -0.1), 0x222222), // helmet
      ]);
    case 'truck':
      return merge([
        paint(box(2.4, 2.2, 2.1, 0.55, 3.2), BODY),
        paint(box(2.3, 0.8, 0.12, 1.75, 4.25), GLASS),
        paint(box(2.5, 3.0, 6.4, 0.6, -1.0), 0xe8e8e8),
        ...wheels(1.05, [3.4, -0.4, -3.2], 0.5, 0.4),
      ]);
    case 'bus':
      return merge([
        paint(box(2.55, 2.75, 12, 0.35), BODY),
        paint(box(2.6, 0.95, 10.6, 1.65, -0.3), GLASS), // window band
        paint(box(2.3, 1.2, 0.1, 1.5, 6.0), GLASS), // windscreen
        ...wheels(1.1, [4.2, -3.8], 0.5, 0.35),
      ]);
    case 'train':
      return merge([paint(box(3, 3.4, 1, 0.5), BODY), paint(box(3.05, 0.9, 0.9, 2.2), GLASS), paint(box(2.6, 0.3, 0.8, 3.9), 0x8a8f96)]);
    case 'emergency':
      return merge([
        paint(box(2.1, 1.9, 5.6, 0.45), BODY),
        paint(box(2.15, 0.7, 1.2, 1.35, 2.2), GLASS),
        paint(box(2.16, 0.3, 5.0, 0.95, -0.2), 0xd8342c), // stripe
        ...wheels(0.92, [1.9, -1.9], 0.42),
      ]);
    case 'lightbar':
      return paint(box(1.4, 0.25, 0.45, 2.35, 0.4), BODY);
    case 'pillar':
      return box(1.2, 1, 1.2, 0);
    case 'tree':
      return merge([
        paint(new THREE.CylinderGeometry(0.16, 0.24, 2.6, 5).translate(0, 1.3, 0), 0x8a6a4c),
        paint(new THREE.IcosahedronGeometry(2.3, 0).translate(0, 4, 0), 0xffffff),
        paint(new THREE.IcosahedronGeometry(1.6, 0).translate(0.6, 5.4, 0.3), 0xf0f0f0),
      ]);
    case 'conifer':
      return merge([
        paint(new THREE.CylinderGeometry(0.15, 0.2, 1.6, 5).translate(0, 0.8, 0), 0x7a5a3c),
        paint(new THREE.ConeGeometry(1.8, 3.6, 7).translate(0, 3.0, 0), 0xd8e8d8),
        paint(new THREE.ConeGeometry(1.3, 2.8, 7).translate(0, 4.8, 0), 0xd8e8d8),
      ]);
    default: // car, taxi
      return merge([
        paint(box(1.85, 0.7, 4.5, 0.32), BODY),
        paint(box(1.62, 0.58, 2.3, 1.02, -0.25), BODY),
        paint(box(1.66, 0.42, 2.0, 1.08, -0.25), GLASS), // side windows
        paint(box(1.5, 0.4, 0.1, 1.07, 0.92), GLASS), // windscreen
        ...wheels(0.86, [1.45, -1.45], 0.34),
      ]);
  }
}
