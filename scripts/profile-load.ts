/** Dev tool: time each stage of loading a city pack. Usage: npx tsx scripts/profile-load.ts [pack.json] */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseOverpass } from '../src/geo/osm.ts';
import { buildingGeometry, buildingColor, PickMesh, ribbonGeometry } from '../src/render/geometry.ts';
import { cityMetrics } from '../src/ui/metrics.ts';
import { treePoints } from '../src/geo/trees.ts';
import { roadWidth } from '../src/sim/graph.ts';
const T = (label: string, f: () => unknown) => { const t = performance.now(); const r = f(); console.log(label.padEnd(22), (performance.now() - t).toFixed(1), 'ms'); return r as any; };
const raw = readFileSync(process.argv[2] ?? 'public/packs/40.7549_-73.9840.json', 'utf8');
const pack = T('JSON.parse', () => JSON.parse(raw));
const w = T('parseOverpass core', () => parseOverpass({ elements: pack.core }, pack.center, 850));
const ex = T('parseOverpass extras', () => parseOverpass({ elements: pack.extras }, pack.center, 850));
w.areas = ex.areas;
T('cityMetrics', () => cityMetrics(w));
T('building geoms+merge', () => new PickMesh(w.buildings.map((b: any) => ({ id: b.id, geom: buildingGeometry(b, buildingColor(b, { highlightEstimated: false })) })), new THREE.MeshBasicMaterial()));
T('road ribbons+merge', () => new PickMesh(w.roads.map((r: any) => ({ id: r.id, geom: ribbonGeometry(r.points, roadWidth(r), 0.1, new THREE.Color())! })).filter((x: any) => x.geom), new THREE.MeshBasicMaterial()));
T('treePoints', () => treePoints(w, 7000));
