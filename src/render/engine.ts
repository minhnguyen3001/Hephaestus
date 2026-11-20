import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Area, Building, Road, Vec2, WorldData } from '../geo/types';
import { sampleTerrain } from '../geo/terrain';
import { treePoints } from '../geo/trees';
import { centroid, dist, hash01, pointInPolygon, signedArea } from '../geo/util';
import type { Edit } from '../project/edits';
import type { SavedView } from '../project/store';
import { CONTEXT_RADIUS, type ContextTile } from '../geo/vectortiles';
import { TILE } from '../geo/osm';
import { roadWidth } from '../sim/graph';
import type { RegionProfile } from '../sim/region';
import { SimClient } from '../sim/client';
import type { AgentView } from '../sim/protocol';
import { AGENT_KINDS, signalPhase, type AgentInfo, type AgentKind, type CityEvent, type SimParams, type SimStats, type Weather } from '../sim/simulation';

export type { AgentInfo };
import { agentGeometry, buildingColor, buildingGeometry, offsetLine, PickMesh, pitchedRoof, polygonGeometry, ribbonGeometry, trimLine, v3, type BuildingStyle } from './geometry';
import { PRESETS, resolveQuality, type Quality, type QualitySetting } from './quality';
import { pickMode, ToolController, type Tool, type ZoneOptions } from './tools';
import { ZONE_COLORS } from './palette';
import { ROAD_COLORS } from './palette';

export type { Tool };
export type CameraMode = 'city' | 'aerial' | 'neighborhood' | 'street' | 'inspect';


export type Selection =
  | { type: 'building'; building: Building; overview?: boolean } // overview = city-ring data, view-only
  | { type: 'road'; road: Road }
  | { type: 'agent'; agent: AgentInfo };

export interface Perf {
  fps: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  quality: Quality;
  /** Average main-thread milliseconds per frame spent in our loop (simulation sync + scene update + render submit). */
  frameMs: number;
  /** Scene pieces still queued for building (0 = fully loaded). */
  pending: number;
}

/** What the UI needs from any world view (3D engine or 2D plan). */
export interface WorldRenderer {
  running: boolean;
  speed: number;
  setWorld(world: WorldData, region: RegionProfile): void;
  setTool(t: Tool): void;
  setLayers(l: Layers): void;
  setTime(seconds: number): void;
  resetSim(): void;
  select(sel: { type: 'building' | 'road' | 'agent'; id: string | number } | null): void;
  follow(agentId: number | null): void;
  setCameraMode(mode: CameraMode): void;
  focusSelected(): void;
  orbitStep(radians: number): void;
  finishDraft(): void;
  setZoneOptions(o: ZoneOptions): void;
  setLineMode(m: 'bus' | 'metro'): void;
  getView(): SavedView;
  setView(v: SavedView): void;
  setContext(tiles: ContextTile[], detail: DetailZone): void;
  setSimParams(p: SimParams): void;
  lookAt(p: Vec2): void;
  roadSpeeds(): Map<string, number>;
  dispose(): void;
}

/** Where full-detail data exists (the city ring is hidden there): the initial circle plus loaded 1 km tiles. */
export interface DetailZone {
  radius: number;
  tiles: string[];
}

/** Split a city-ring tile into four quarter tiles (by feature position) with their own keys. */
function splitTile(t: ContextTile): ContextTile[] {
  const q = (p: Vec2) => (p[0] >= t.center[0] ? 1 : 0) + (p[1] >= t.center[1] ? 2 : 0);
  const parts = [0, 1, 2, 3].map((i) => ({
    key: `${t.key}#${i}`, center: [t.center[0] + (i & 1 ? 450 : -450), t.center[1] + (i & 2 ? 450 : -450)] as Vec2,
    buildings: [] as ContextTile['buildings'], roads: [] as ContextTile['roads'], water: [] as Vec2[][], green: [] as Vec2[][],
  }));
  for (const b of t.buildings) parts[q(b.ring[0])].buildings.push(b);
  for (const r of t.roads) parts[q(r.points[0])].roads.push(r);
  for (const w of t.water) parts[q(w[0])].water.push(w);
  for (const g of t.green) parts[q(g[0])].green.push(g);
  return parts;
}

export function inDetail(z: DetailZone, p: Vec2): boolean {
  if (p[0] * p[0] + p[1] * p[1] < z.radius * z.radius) return true;
  return z.tiles.includes(`${Math.round(p[0] / TILE)},${Math.round(p[1] / TILE)}`);
}

/** Detail tiles that overlap a city-ring tile (so a ring tile only rebuilds when its own overlap changes). */
export function overlapSig(z: DetailZone, c: Vec2): string {
  const near = z.tiles.filter((k) => {
    const [i, j] = k.split(',').map(Number);
    return Math.abs(i * TILE - c[0]) < 1600 && Math.abs(j * TILE - c[1]) < 1600;
  });
  return `${z.radius}|${near.sort().join(';')}`;
}

export interface EngineCallbacks {
  onSelect(sel: Selection | null): void;
  onEdit(e: Edit): void;
  onStats(s: SimStats): void;
  onPerf(p: Perf): void;
  onHint(msg: string | null): void;
  onPlaceEvent?(p: Vec2): void;
  /** The GPU dropped our WebGL context (memory pressure, driver reset). The UI should rebuild, lighter. */
  onContextLost?(): void;
}

export interface Layers {
  agents: boolean;
  transit: boolean;
  estimated: boolean;
  traffic: boolean;
  trees: boolean;
  underground: boolean;
}

const FREE = new THREE.Color(0x3cb371);
const SLOW = new THREE.Color(0xf2c230);
const JAM = new THREE.Color(0xe5484d);
/** Speed ratio (1 = free flow) to a green → yellow → red ramp. */
export function trafficColor(r: number, out = new THREE.Color()) {
  return r > 0.6 ? out.copy(SLOW).lerp(FREE, Math.min(1, (r - 0.6) / 0.3)) : out.copy(JAM).lerp(SLOW, Math.max(0, (r - 0.15) / 0.45));
}

const ROAD_Y: Record<string, number> = {
  highway: 0.14, primary: 0.13, secondary: 0.12, tertiary: 0.115, residential: 0.11, service: 0.1, footway: 0.07, cycleway: 0.08,
};
const PALETTES: Record<string, number[]> = {
  car: [0xeeeeee, 0x2a2a2a, 0x9aa3ad, 0xb33a3a, 0x2f5d9e, 0x6b7d5a, 0xd9d4c5, 0x4a4f57],
  motorcycle: [0x333333, 0xc0392b, 0x2c3e50, 0xf1c40f, 0x7f8c8d, 0x1f6fb2],
  truck: [0xf2f2f2, 0x8c6e4a, 0x3d6e9e, 0xd35400],
  bicycle: [0x1abc9c, 0xe67e22, 0x34495e, 0xe74c3c],
  pedestrian: [0x34495e, 0xc0392b, 0x2980b9, 0x27ae60, 0x8e44ad, 0xf39c12, 0x7f8c8d, 0xecf0f1, 0x16a085],
  emergency: [0xf4f4f4, 0xf4f4f4, 0xd8342c],
};
const MAX_INSTANCES = 4000; // per agent kind: High runs up to 3000 agents × 1.8 projected demand
/** Chunk size (m): big enough to keep draw calls low, small enough that an edit rebuilds quickly. */
const CHUNK = 300;

// Shared street furniture (instanced per chunk; geometry/materials are shared, never disposed per chunk).
const POLE_GEO = new THREE.CylinderGeometry(0.07, 0.1, 6.5, 5).translate(0, 3.25, 0);
const LAMP_GEO = new THREE.BoxGeometry(0.5, 0.18, 1.1).translate(0, 6.4, 0.55);
const UNIT_GEO = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const STRIPE_GEO = new THREE.BoxGeometry(0.55, 0.05, 3);
const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.6 });
const LAMP_MAT = new THREE.MeshBasicMaterial({ color: 0x55585e });
const UNIT_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.8 });
const STRIPE_MAT = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });

/** A pinned note: a stalk from the ground and a label that stays readable at any distance. */
function noteMarker(text: string, at: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '600 28px Inter, system-ui, sans-serif';
  ctx.font = font;
  const label = text.length > 48 ? `${text.slice(0, 47)}…` : text;
  const w = Math.min(900, ctx.measureText(label).width + 40);
  canvas.width = w;
  canvas.height = 56;
  ctx.font = font;
  ctx.fillStyle = 'rgba(17,23,31,0.9)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 56, 14);
  ctx.fill();
  ctx.fillStyle = '#ffd166';
  ctx.fillRect(0, 0, 8, 56);
  ctx.fillStyle = '#eef2f6';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 22, 29);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
  sprite.scale.set((0.045 * w) / 56, 0.045, 1);
  sprite.center.set(0, 0);
  sprite.position.set(at.x, at.y + 22, at.z);
  sprite.renderOrder = 20;
  const stalk = new THREE.Line(new THREE.BufferGeometry().setFromPoints([at, at.clone().setY(at.y + 22)]), new THREE.LineBasicMaterial({ color: 0xffd166 }));
  g.add(stalk, sprite);
  return g;
}
const UNDER = 14; // rail tunnel depth below ground, meters
const ROAD_TUNNEL = 8; // road tunnel depth
const SKY_DAY = new THREE.Color(0xa8cbe8);
const LAMP_ON = new THREE.Color(0xffd28a);
const SIDEWALK = new Set(['primary', 'secondary', 'tertiary', 'residential']);
const SIDEWALK_COLOR = new THREE.Color(0xc9c3b8);
const SKY_DUSK = new THREE.Color(0xf0a878);
const SKY_NIGHT = new THREE.Color(0x1a2740);
const SUN_DAY = new THREE.Color(0xfff1dc);
const HEMI_DAY = new THREE.Color(0xdfeeff);

export class Engine implements WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private hemi = new THREE.HemisphereLight(0xdfeeff, 0x8a7f6a, 0.9);
  private worldGroup = new THREE.Group();
  private ground?: THREE.Mesh;
  private transitGroup = new THREE.Group();
  private metroGroup = new THREE.Group();
  private draftGroup = new THREE.Group();
  private agentMeshes = {} as Record<AgentKind, THREE.InstancedMesh>;
  private agentSlots = {} as Record<AgentKind, AgentView[]>;
  private trainMesh: THREE.InstancedMesh;
  private lightbars: THREE.InstancedMesh;
  private highlight?: THREE.Object3D;
  private roadPreview?: THREE.Line;
  private night = { value: 0 };
  /** Share of windows lit: follows when people are home and awake, not just darkness. */
  private lit = { value: 0.5 };
  private buildingMat: THREE.MeshStandardMaterial;
  private flatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  private world?: WorldData;
  private region?: RegionProfile;
  sim?: SimClient;
  private roadSignature = '';
  private simRestart?: ReturnType<typeof setTimeout>;
  running = true;
  speed = 1;
  private tools = new ToolController({
    onEdit: (e) => this.cb.onEdit(e),
    onHint: (m) => this.cb.onHint(m),
    select: (sel) => this.select(sel),
    follow: (id) => this.follow(id),
    preselect: (sel) => (this.selected = sel),
    clearPreview: () => this.clearRoadPreview(),
    drawDraft: () => this.drawDraft(),
    placeEvent: (p) => this.cb.onPlaceEvent?.(p),
  });
  private selected: { type: 'building' | 'road' | 'agent'; id: string | number } | null = null;
  private followId: number | null = null;
  private keys = new Set<string>();
  private tween?: { fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3; t: number; dur: number };
  private raf = 0;
  private clock = new THREE.Clock();
  private frames = 0;
  private perfT = 0;
  private statsT = 0;
  private slowSeconds = 0;
  private fastSeconds = 0;
  private quality: Quality;
  private pixelRatio: number;
  private layers: Layers = { agents: true, transit: true, estimated: false, traffic: false, trees: true, underground: false };
  private undergroundGroup = new THREE.Group();
  private groundMats: THREE.Material[] = [];
  private treeMesh?: THREE.Object3D;
  private trafficT = 0;
  private signalPoles?: THREE.InstancedMesh;
  private signalLights?: THREE.InstancedMesh;
  private crosswalks?: THREE.InstancedMesh;
  private raycaster = new THREE.Raycaster();
  private down?: { x: number; y: number; t: number };
  private ro: ResizeObserver;
  private disposed = false;
  private tmpM = new THREE.Matrix4();
  private tmpC = new THREE.Color();
  /** Ground height (m) at local x, y. */
  private h = (x: number, y: number) => sampleTerrain(this.world?.terrain, x, y);
  private hp = (p: Vec2) => this.h(p[0], p[1]);
  /** Bridge decks: straight between abutments. Grid of segments so agents can sit on decks too. */
  private decks = new Map<string, { a: Vec2; b: Vec2; ha: number; hb: number; hw: number }[]>();
  private deckH = (x: number, y: number): number => {
    const ground = this.h(x, y);
    const list = this.decks.get(`${Math.floor(x / 50)},${Math.floor(y / 50)}`);
    if (!list) return ground;
    for (const d of list) {
      const dx = d.b[0] - d.a[0];
      const dy = d.b[1] - d.a[1];
      const t = Math.max(0, Math.min(1, ((x - d.a[0]) * dx + (y - d.a[1]) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x - d.a[0] - t * dx, y - d.a[1] - t * dy) < d.hw) return Math.max(ground, d.ha + (d.hb - d.ha) * t);
    }
    return ground;
  };

  private buildDecks(w: WorldData) {
    this.decks.clear();
    if (!w.terrain) return;
    for (const r of w.roads) {
      if (!r.bridge || r.tunnel) continue;
      // straight deck between the first and last point, measured along the road
      const ha = this.hp(r.points[0]);
      const hb = this.hp(r.points[r.points.length - 1]);
      let total = 0;
      const cum = [0];
      for (let i = 1; i < r.points.length; i++) cum.push((total += dist(r.points[i - 1], r.points[i])));
      for (let i = 1; i < r.points.length; i++) {
        const seg = { a: r.points[i - 1], b: r.points[i], ha: ha + ((hb - ha) * cum[i - 1]) / (total || 1), hb: ha + ((hb - ha) * cum[i]) / (total || 1), hw: roadWidth(r) / 2 + 1.5 };
        const [x0, x1] = [Math.min(seg.a[0], seg.b[0]) - seg.hw, Math.max(seg.a[0], seg.b[0]) + seg.hw];
        const [y0, y1] = [Math.min(seg.a[1], seg.b[1]) - seg.hw, Math.max(seg.a[1], seg.b[1]) + seg.hw];
        for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++)
          for (let cy = Math.floor(y0 / 50); cy <= Math.floor(y1 / 50); cy++) {
            const k = `${cx},${cy}`;
            (this.decks.get(k) ?? this.decks.set(k, []).get(k)!).push(seg);
          }
      }
    }
  }
  /** Extra clearance for draped layers when the ground is not flat (terrain mesh is coarser than the sampler). */
  private get lift() {
    return this.world?.terrain ? 0.3 : 0;
  }

  constructor(private container: HTMLElement, private cb: EngineCallbacks, private qualitySetting: QualitySetting = 'auto') {
    this.quality = resolveQuality(qualitySetting);
    const preset = PRESETS[this.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: this.quality !== 'low', powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, preset.pixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0;
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 30000);
    this.camera.position.set(-500, 600, 700);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI * 0.495, minDistance: 3, maxDistance: 16000,
      screenSpacePanning: false, zoomToCursor: true, rotateSpeed: 0.6, zoomSpeed: 1.2,
    });
    this.controls.addEventListener('start', () => {
      this.tween = undefined;
    });

    this.buildingMat = this.makeBuildingMaterial();
    this.scene.add(this.hemi, this.sun, this.sun.target, this.worldGroup, this.transitGroup, this.metroGroup, this.draftGroup, this.undergroundGroup);
    this.sun.castShadow = preset.shadows;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.fog = new THREE.Fog(SKY_DAY, 2000, 9000);

    const agentMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
    for (const k of AGENT_KINDS) {
      const m = new THREE.InstancedMesh(agentGeometry(k), agentMat, MAX_INSTANCES);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = preset.shadows && k !== 'pedestrian';
      m.userData.kind = k;
      this.agentMeshes[k] = m;
      this.agentSlots[k] = [];
      this.scene.add(m);
    }
    this.lightbars = new THREE.InstancedMesh(agentGeometry('lightbar'), new THREE.MeshBasicMaterial({ vertexColors: true }), 64);
    this.lightbars.setColorAt(0, new THREE.Color());
    this.lightbars.count = 0;
    this.lightbars.frustumCulled = false;
    this.scene.add(this.lightbars);
    this.trainMesh = new THREE.InstancedMesh(agentGeometry('train'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.5 }), 200);
    this.trainMesh.setColorAt(0, new THREE.Color());
    this.trainMesh.count = 0;
    this.trainMesh.frustumCulled = false;
    this.trainMesh.castShadow = preset.shadows;
    this.scene.add(this.trainMesh);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.loop();
  }

  // ---------- public API ----------

  setWorld(world: WorldData, region: RegionProfile) {
    const first = !this.world;
    this.world = world;
    const sig = world.roads.map((r) => `${r.id}:${r.kind}:${r.lanes}:${+r.oneway}:${r.maxspeedKmh}:${+!!r.bikeLane}`).join('|') + region.id + JSON.stringify(world.transitLines ?? []) + (world.stations?.length ?? 0);
    if (!this.sim || region !== this.region) {
      this.startSim(world, region, 1);
      this.roadSignature = sig;
    } else if (sig !== this.roadSignature) {
      // Network changed (edit or streamed tiles): restart once things settle; the current city keeps moving.
      this.roadSignature = sig;
      clearTimeout(this.simRestart);
      this.simRestart = setTimeout(() => this.world && this.region && !this.disposed && this.startSim(this.world, this.region, 1), 2000);
    }
    this.region = region;
    this.buildStatic();
    this.buildTransit();
    if (first) this.flyTo(new THREE.Vector3(0, this.h(0, 0), 0), world.radius * 1.15, 0.9, true);
    this.refreshSelection();
  }

  setTool(t: Tool) {
    this.tools.set(t);
  }

  setLayers(l: Layers) {
    const restyle = l.estimated !== this.layers.estimated;
    const trafficOff = this.layers.traffic && !l.traffic;
    this.layers = l;
    this.transitGroup.visible = l.transit;
    if (trafficOff) for (const c of this.roadChunks.values()) c.pick.paint(() => null);
    if (this.treeMesh) this.treeMesh.visible = l.trees;
    this.applyXray();
    this.trafficT = 99;
    if (restyle && this.world) this.buildStatic();
  }

  private startTime = 7.5 * 3600;
  setTime(seconds: number) {
    this.startTime = ((seconds % 86400) + 86400) % 86400; // kept for a simulation that hasn't started yet
    this.sim?.setTime(this.startTime);
  }

  resetSim() {
    if (this.world && this.region) this.startSim(this.world, this.region, Math.floor(Math.random() * 1e9));
  }

  private startSim(world: WorldData, region: RegionProfile, seed: number) {
    const time = this.sim?.time ?? this.startTime;
    this.sim?.dispose();
    this.sim = new SimClient(world, region, PRESETS[this.quality].maxAgents, seed, time);
    this.sim.setParams(this.simParams);
    this.sim.onInfo = () => this.buildTransit();
    this.buildTransit();
  }

  select(sel: { type: 'building' | 'road' | 'agent'; id: string | number } | null) {
    this.selected = sel;
    if (!sel || sel.type !== 'agent') this.followId = null;
    this.refreshSelection();
  }

  follow(agentId: number | null) {
    this.followId = agentId;
    if (agentId !== null) {
      const a = this.sim?.agents.find((x) => x.id === agentId);
      if (a) this.flyTo(v3([a.x, a.y], this.h(a.x, a.y) + 1), 45, 1.05);
    }
  }

  setCameraMode(mode: CameraMode, instant = false) {
    const t = this.controls.target.clone();
    const r = this.world?.radius ?? 600;
    const g = this.h(t.x, -t.z);
    if (mode === 'city') this.flyTo(new THREE.Vector3(0, this.h(0, 0), 0), CONTEXT_RADIUS * 2.2, 0.75, instant);
    else if (mode === 'aerial') this.flyTo(new THREE.Vector3(0, this.h(0, 0), 0), r * 2.1, 0.55, instant);
    else if (mode === 'neighborhood') this.flyTo(new THREE.Vector3(t.x, g, t.z), Math.min(420, r), 0.95, instant);
    else if (mode === 'street') this.flyTo(new THREE.Vector3(t.x, g + 1.7, t.z), 14, 1.48, instant);
    else this.focusSelected();
  }

  /** Orbit-focus the selected object so the user can circle it 360°. */
  focusSelected() {
    const s = this.selected;
    if (!s || !this.world) return;
    if (s.type === 'building') {
      const found = this.findBuilding(s.id);
      if (!found) return;
      const { b, base } = found;
      const size = Math.max(...b.footprint.map((p) => dist(p, centroid(b.footprint))));
      this.flyTo(v3(centroid(b.footprint), base + b.height * 0.45), Math.max(40, size * 2.6, b.height * 1.8), 1.15);
    } else if (s.type === 'road') {
      const r = this.world.roads.find((x) => x.id === s.id);
      if (r) {
        const mid = r.points[Math.floor(r.points.length / 2)];
        this.flyTo(v3(mid, this.hp(mid)), 90, 1.0);
      }
    } else this.follow(s.id as number);
  }

  orbitStep(radians: number) {
    const off = this.camera.position.clone().sub(this.controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
    this.flyToPose(this.controls.target.clone(), this.controls.target.clone().add(off));
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.simRestart);
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const c = this.renderer.domElement;
    c.removeEventListener('webglcontextlost', this.onContextLost);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.controls.dispose();
    this.sim?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
    this.renderer.dispose();
    c.remove();
  }

  // ---------- scene construction ----------

  private makeBuildingMaterial() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.04 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.night;
      shader.uniforms.uLit = this.lit;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWall;\nattribute vec2 aFacade;\nvarying float vWall;\nvarying vec2 vFacade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = aWall;\nvFacade = aFacade;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uLit;\nvarying float vWall;\nvarying vec2 vFacade;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float gLit = 0.0;
          if (vWall > 1.5 && vWall < 2.5) {
            // glass curtain wall: tinted glass, thin mullions, floor bands
            vec2 cell = vec2(vFacade.x / 1.6, vFacade.y / 3.6);
            vec2 f = fract(cell);
            float fade = 1.0 - smoothstep(0.25, 0.7, max(fwidth(cell.x), fwidth(cell.y)));
            float mull = max(step(0.92, f.x), step(0.9, f.y)) * fade;
            vec3 glass = mix(vec3(0.32, 0.44, 0.56), vec3(0.62, 0.74, 0.84), smoothstep(0.0, 140.0, vFacade.y));
            diffuseColor.rgb = mix(mix(diffuseColor.rgb, glass, 0.72), vec3(0.82, 0.85, 0.88), mull * 0.6);
            float r = fract(sin(dot(floor(cell * vec2(0.5, 1.0)) + vColor.rg * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
            // far away, single windows alias into static; blend to their average glow instead
            gLit = mix(uLit * 0.3, (1.0 - mull) * step(1.0 - uLit, r) * 0.8, fade);
          } else if (vWall > 3.5 && vFacade.y < 4.2) {
            // ground-floor shopfront: tall glass bays with thin frames, warm light after dark
            vec2 cell = vec2(vFacade.x / 4.0, 0.0);
            float fx = fract(cell.x);
            float frame = step(0.94, fx) * (1.0 - smoothstep(0.3, 0.7, fwidth(cell.x)));
            float glassBand = step(0.35, vFacade.y) * step(vFacade.y, 3.6);
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.22, 0.28, 0.33), vec3(0.15), frame), glassBand * 0.85);
            gLit = glassBand * (1.0 - frame) * 0.9;
          } else if (vWall > 0.5 && vWall != 2.0 && vWall != 3.0 && vFacade.y > 2.8) {
            vec2 cell = vec2(vFacade.x / 3.4, (vFacade.y - 0.8) / 3.2);
            vec2 f = fract(cell);
            float rawWin = step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.85);
            // fade the daytime window grid where it would alias into noise; lit windows stay as city lights
            float fade = 1.0 - smoothstep(0.2, 0.55, max(fwidth(cell.x), fwidth(cell.y)));
            float win = rawWin * fade;
            float r = fract(sin(dot(floor(cell) + vColor.rg * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
            gLit = mix(uLit * 0.25, rawWin * step(1.0 - uLit, r), fade);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.21, 0.28), win * 0.45);
          }`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.8, 0.48) * gLit * uNight * 1.1;');
    };
    return mat;
  }

  private clearGroup(g: THREE.Group) {
    g.traverse((o) => {
      (o as THREE.Mesh).geometry?.dispose();
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    g.clear();
  }

  // ---------- incremental static scene ----------
  // Each layer remembers the inputs it was built from and only rebuilds when they change. Buildings
  // and roads live in ~300 m chunks, so an edit rebuilds one chunk instead of the whole city.
  /** Deferred scene-building work, run a few ms per frame (nearest first) so big loads never freeze the UI. */
  private work = new Map<string, { at: Vec2; run: () => void }>();
  private runWork(budgetMs: number) {
    if (!this.work.size) return;
    const t0 = performance.now();
    const cam: Vec2 = [this.controls.target.x, -this.controls.target.z];
    const jobs = [...this.work.entries()].sort((a, b) => dist(a[1].at, cam) - dist(b[1].at, cam));
    for (const [k, job] of jobs) {
      this.work.delete(k);
      job.run();
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  private layerDeps = new Map<string, unknown[]>();
  private layers3d = new Map<string, THREE.Group>();
  private buildingChunks = new Map<string, { deps: unknown[]; pick: PickMesh }>();
  private roadChunks = new Map<string, { deps: unknown[]; pick: PickMesh }>();

  private same(a: unknown[] | undefined, b: unknown[]) {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Returns a fresh group for `name` if its deps changed, or null if the cached one is still valid. */
  private layer(name: string, deps: unknown[]): THREE.Group | null {
    if (this.same(this.layerDeps.get(name), deps) && this.layers3d.has(name)) return null;
    this.layerDeps.set(name, deps);
    const old = this.layers3d.get(name);
    if (old) {
      this.clearGroup(old);
      this.worldGroup.remove(old);
    }
    const g = new THREE.Group();
    this.layers3d.set(name, g);
    this.worldGroup.add(g);
    return g;
  }

  private chunkKey(p: Vec2) {
    return `${Math.floor(p[0] / CHUNK)},${Math.floor(p[1] / CHUNK)}`;
  }

  private syncChunks<T>(
    store: Map<string, { deps: unknown[]; pick: PickMesh }>, items: T[], keyOf: (t: T) => string, extra: unknown[],
    build: (list: T[]) => PickMesh,
  ) {
    const groups = new Map<string, T[]>();
    for (const it of items) {
      const k = keyOf(it);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(it);
    }
    const drop = (pm: PickMesh) => {
      for (const ch of pm.mesh.children) (ch as THREE.InstancedMesh).dispose?.();
      this.worldGroup.remove(pm.mesh);
      pm.dispose();
    };
    const tag = store === this.buildingChunks ? 'b' : 'r';
    for (const key of [...this.work.keys()]) if (key.startsWith(`${tag}:`) && !groups.has(key.slice(2))) this.work.delete(key);
    for (const [k, c] of store) {
      if (groups.has(k)) continue;
      drop(c.pick);
      store.delete(k);
    }
    const changed: [string, T[], unknown[]][] = [];
    for (const [k, list] of groups) {
      const deps = [...extra, ...list];
      const cur = store.get(k);
      if (cur && this.same(cur.deps, deps)) continue;
      changed.push([k, list, deps]);
    }
    // An edit touches a chunk or two: apply now. Big loads (new tiles, quality change) are time-sliced.
    const now = changed.length <= 3;
    for (const [k, list, deps] of changed) {
      const job = () => {
        const cur = store.get(k);
        if (cur) drop(cur.pick);
        const pick = build(list);
        store.set(k, { deps, pick });
        this.worldGroup.add(pick.mesh);
        pick.mesh.visible = true;
      };
      const [cx, cy] = k.split(',').map((v) => (Number(v) + 0.5) * CHUNK);
      if (now) {
        this.work.delete(`${store === this.buildingChunks ? 'b' : 'r'}:${k}`);
        job();
      } else this.work.set(`${store === this.buildingChunks ? 'b' : 'r'}:${k}`, { at: [cx, cy], run: job });
    }
  }

  private buildStatic() {
    const w = this.world!;
    const shadows = PRESETS[this.quality].shadows;
    const r = w.radius;
    const t = w.terrain;
    const lift = this.lift;
    const q = this.quality;
    this.buildDecks(w);

    const ground = this.layer('ground', [t, r, q]);
    if (ground) {
      if (t) {
        // Terrain mesh from the DEM grid, lighter inside the loaded data radius.
        // ground resolution follows quality (the heightfield itself is finer; vertices sample it)
        const seg = Math.min(t.n - 1, { low: 110, medium: 180, high: 300 }[q]);
        const g = new THREE.PlaneGeometry(2 * t.extent, 2 * t.extent, seg, seg).rotateX(-Math.PI / 2);
        const pos = g.attributes.position;
        const cols: number[] = [];
        const inner = new THREE.Color(0xe6e0d3);
        const outer = new THREE.Color(0xc9c2b1);
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = -pos.getZ(i);
          pos.setY(i, this.h(x, y));
          const c = outer.clone().lerp(inner, THREE.MathUtils.smoothstep(r + 20 - Math.hypot(x, y), 0, 30));
          cols.push(c.r, c.g, c.b);
        }
        g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        g.computeVertexNormals();
        this.ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
        this.ground.receiveShadow = shadows;
        const skirt = new THREE.Mesh(new THREE.PlaneGeometry(r * 14, r * 14).rotateX(-Math.PI / 2).translate(0, t.min - 2, 0), new THREE.MeshStandardMaterial({ color: 0xc9c2b1, roughness: 1 }));
        skirt.userData.ground = true;
        ground.add(this.ground, skirt);
      } else {
        this.ground = new THREE.Mesh(new THREE.PlaneGeometry(r * 14, r * 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xcdc6b6, roughness: 1 }));
        this.ground.receiveShadow = shadows;
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 96).rotateX(-Math.PI / 2).translate(0, 0.02, 0), new THREE.MeshStandardMaterial({ color: 0xe6e0d3, roughness: 1 }));
        disc.receiveShadow = shadows;
        disc.userData.ground = true;
        const ring = new THREE.Mesh(new THREE.RingGeometry(r - 2, r, 128).rotateX(-Math.PI / 2).translate(0, 0.05, 0), new THREE.MeshBasicMaterial({ color: 0x3a7bd5, transparent: true, opacity: 0.35 }));
        ground.add(this.ground, disc, ring);
      }
      this.ground.userData.ground = true;
      // shadows cover the area around the camera (the sun follows the target), not the whole city
      const sr = Math.min(r * 1.1, 950);
      const sc = this.sun.shadow.camera;
      sc.left = -sr;
      sc.right = sr;
      sc.top = sr;
      sc.bottom = -sr;
      sc.near = 1;
      sc.far = sr * 8;
      sc.updateProjectionMatrix();
      const size = PRESETS[q].shadowSize;
      if (size && this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
      this.scene.fog = new THREE.Fog(SKY_DAY, r * 2.5, r * 9);
    }

    const areas = this.layer('areas', [t, r, ...w.areas]);
    if (areas) {
      const E = r * 1.3;
      const areaColor = { water: 0x6fa6d0, park: 0xa6c98c, land: 0xe0dacc };
      const geoms = w.areas
        .map((a) => polygonGeometry(a.polygon, this.areaHeight(a, E, lift), new THREE.Color(areaColor[a.kind]), a.holes))
        .filter((g): g is THREE.BufferGeometry => !!g);
      if (geoms.length) {
        const m = new THREE.Mesh(mergeGeometries(geoms)!, this.flatMat);
        m.receiveShadow = shadows;
        m.userData.ground = true;
        areas.add(m);
      }
    }

    const mark = new THREE.Color(0xeae3c9);
    // junction node → how far sidewalks stop short of it (widest street meeting there + corner)
    const seen = new Map<string, { n: number; hw: number }>();
    for (const rd of w.roads) {
      if (rd.kind === 'footway' || rd.kind === 'cycleway' || rd.tunnel) continue;
      const hw = roadWidth(rd) / 2;
      for (const n of rd.nodes) {
        const e = seen.get(n) ?? { n: 0, hw: 0 };
        e.n++;
        e.hw = Math.max(e.hw, hw);
        seen.set(n, e);
      }
    }
    const junctions = new Map<string, number>();
    for (const [n, e] of seen) if (e.n > 1) junctions.set(n, e.hw + 3.5);
    this.syncChunks(this.roadChunks, w.roads.filter((rd) => !rd.tunnel), (rd) => this.chunkKey(rd.points[0]), [t, q], (list) => {
      const items: { id: string; geom: THREE.BufferGeometry }[] = [];
      const lights: [number, number, number][] = [];
      for (const road of list) {
        const color = new THREE.Color(ROAD_COLORS[road.kind]);
        if (road.origin === 'proposed') color.lerp(new THREE.Color(0x3fd3c3), 0.45);
        const gh = road.bridge ? (p: Vec2) => this.deckH(p[0], p[1]) : this.hp;
        const g = ribbonGeometry(road.points, roadWidth(road), (p) => gh(p) + lift + ROAD_Y[road.kind], color);
        if (g) items.push({ id: road.id, geom: g });
        if (road.bikeLane && road.kind !== 'footway' && road.kind !== 'cycleway') {
          const hw = roadWidth(road) / 2 - 0.8;
          for (const side of [-1, 1]) {
            const b = ribbonGeometry(offsetLine(road.points, side * hw), 1.3, (p) => gh(p) + lift + ROAD_Y[road.kind] + 0.012, new THREE.Color(0x3fae6a));
            if (b) items.push({ id: `${road.id}#m`, geom: b });
          }
        }
        if (!road.oneway && road.lanes >= 2 && road.kind !== 'service' && road.kind !== 'footway' && road.kind !== 'cycleway') {
          const c = ribbonGeometry(road.points, 0.18, (p) => gh(p) + lift + ROAD_Y[road.kind] + 0.01, mark);
          if (c) items.push({ id: `${road.id}#m`, geom: c });
        }
        // raised sidewalks along city streets
        if (SIDEWALK.has(road.kind) && !road.bridge) {
          const off = roadWidth(road) / 2 + 1.15;
          // split at every junction and stop short of it, so sidewalks meet at the corner instead of crossing the street
          const cuts = [0];
          road.nodes.forEach((n, i) => i > 0 && i < road.nodes.length - 1 && junctions.has(n) && cuts.push(i));
          cuts.push(road.points.length - 1);
          for (let c = 1; c < cuts.length; c++) {
            const [i0, i1] = [cuts[c - 1], cuts[c]];
            const gapA = junctions.get(road.nodes[i0]) ?? 0;
            const gapB = junctions.get(road.nodes[i1]) ?? 0;
            for (const side of [-1, 1]) {
              const line = trimLine(offsetLine(road.points.slice(i0, i1 + 1), side * off), gapA, gapB);
              const sw = line && ribbonGeometry(line, 2.3, (p) => gh(p) + lift + ROAD_Y[road.kind] + 0.14, SIDEWALK_COLOR);
              if (sw) items.push({ id: `${road.id}#m`, geom: sw });
            }
          }
          // street lights every ~38 m, alternating sides
          let acc = 19;
          for (let i = 1; i < road.points.length; i++) {
            const [a, b] = [road.points[i - 1], road.points[i]];
            const len = dist(a, b);
            const dir: Vec2 = [(b[0] - a[0]) / (len || 1), (b[1] - a[1]) / (len || 1)];
            while (acc < len) {
              const side = lights.length % 2 ? 1 : -1;
              const px = a[0] + dir[0] * acc + dir[1] * side * (off + 0.6);
              const py = a[1] + dir[1] * acc - dir[0] * side * (off + 0.6);
              lights.push([px, py, Math.atan2(-dir[1] * side, -dir[0] * side)]);
              acc += 38;
            }
            acc -= len;
          }
        }
      }
      const pick = new PickMesh(items, this.flatMat);
      if (lights.length) {
        const poles = new THREE.InstancedMesh(POLE_GEO, POLE_MAT, lights.length);
        const lamps = new THREE.InstancedMesh(LAMP_GEO, LAMP_MAT, lights.length);
        lights.forEach(([x, y, ang], k) => {
          this.tmpM.makeRotationY(ang).setPosition(x, this.hp([x, y]) + lift, -y);
          poles.setMatrixAt(k, this.tmpM);
          lamps.setMatrixAt(k, this.tmpM);
        });
        poles.userData.detail = lamps.userData.detail = true;
        pick.mesh.add(poles, lamps);
      }
      pick.mesh.receiveShadow = shadows;
      pick.mesh.userData.pick = 'road';
      pick.mesh.userData.chunk = pick;
      return pick;
    });

    const rails = this.layer('rails', [t, q, w.rails]);
    if (rails) {
      const railGeoms: THREE.BufferGeometry[] = [];
      const pillars: THREE.Vector3[] = [];
      for (const rail of w.rails) {
        if (rail.tunnel) continue;
        const y = (p: Vec2) => this.hp(p) + (rail.elevated ? 7 : 0.15 + lift);
        const g = ribbonGeometry(rail.points, rail.kind === 'tram' ? 1.8 : 2.8, y, new THREE.Color(rail.elevated ? 0x5b5450 : 0x6f625a));
        if (g) railGeoms.push(g);
        if (rail.elevated) {
          for (let i = 1; i < rail.points.length; i++) {
            const a = rail.points[i - 1];
            const b = rail.points[i];
            const n = Math.floor(dist(a, b) / 25);
            for (let k = 0; k <= n; k++) pillars.push(v3([a[0] + ((b[0] - a[0]) * k) / Math.max(1, n), a[1] + ((b[1] - a[1]) * k) / Math.max(1, n)]));
          }
        }
      }
      if (railGeoms.length) {
        const m = new THREE.Mesh(mergeGeometries(railGeoms)!, this.flatMat);
        m.castShadow = shadows;
        rails.add(m);
      }
      if (pillars.length) {
        const pm = new THREE.InstancedMesh(agentGeometry('pillar'), new THREE.MeshStandardMaterial({ color: 0x8b857d }), pillars.length);
        pillars.forEach((p, i) => pm.setMatrixAt(i, this.tmpM.makeScale(1, 7, 1).setPosition(p.setY(this.h(p.x, -p.z)))));
        pm.castShadow = shadows;
        rails.add(pm);
      }
    }

    const treesG = this.layer('trees', [t, q, w.trees, ...w.areas]);
    if (treesG) {
      const trees = treePoints(w, { low: 1500, medium: 3500, high: 7000 }[q]);
      if (trees.length) {
        // ~30% conifers for variety; both species instanced
        const jit = (x: number, y: number) => ((x * 73.1 + y * 37.7) % 1 + 1) % 1; // cheap stable jitter
        const conifer = trees.filter((tr) => jit(tr.p[1], tr.p[0]) < 0.3);
        const leafy = trees.filter((tr) => jit(tr.p[1], tr.p[0]) >= 0.3);
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
        const greens = [0x5f8f4e, 0x6f9a52, 0x55804a, 0x7da35a, 0x4f7a45];
        const sc = new THREE.Vector3();
        const group = new THREE.Group();
        for (const [list, geo, cols] of [[leafy, 'tree', greens], [conifer, 'conifer', [0x3f6b45, 0x4a7a4f, 0x355e3d]]] as const) {
          if (!list.length) continue;
          const tm = new THREE.InstancedMesh(agentGeometry(geo), mat, list.length);
          list.forEach((tr, i) => {
            const [x, y] = tr.p;
            const k = jit(x, y);
            this.tmpM.makeRotationY(k * 6.28).scale(sc.set(tr.scale, tr.scale * (0.9 + k * 0.3), tr.scale)).setPosition(x, this.h(x, y) + lift, -y);
            tm.setMatrixAt(i, this.tmpM);
            tm.setColorAt(i, this.tmpC.setHex(cols[i % cols.length]));
          });
          tm.castShadow = shadows;
          group.add(tm);
        }
        this.treeMesh = group;
        treesG.add(group);
      } else this.treeMesh = undefined;
    }
    if (this.treeMesh) this.treeMesh.visible = this.layers.trees;

    const notes = this.layer('notes', [t, ...(w.notes ?? [])]);
    if (notes) for (const n of w.notes ?? []) notes.add(noteMarker(n.text, v3(n.p, this.hp(n.p))));

    const style: BuildingStyle = { highlightEstimated: this.layers.estimated };
    this.syncChunks(this.buildingChunks, w.buildings, (b) => this.chunkKey(b.footprint[0]), [t, q, this.layers.estimated], (list) => {
      const pick = new PickMesh(list.map((b) => ({ id: b.id, geom: buildingGeometry(b, buildingColor(b, style), this.base(b)) })), this.buildingMat);
      // rooftop plant on large flat roofs (cheap instanced boxes, deterministic placement)
      const units: THREE.Matrix4[] = [];
      for (const b of list) {
        const area = Math.abs(signedArea(b.footprint));
        if (area < 350 || b.height < 10 || pitchedRoof(b, b.footprint)) continue;
        const c = centroid(b.footprint);
        const n = Math.min(3, Math.floor(area / 400) + 1);
        for (let k = 0; k < n; k++) {
          const ang = hash01(`${b.id}${k}`) * Math.PI * 2;
          const r = Math.sqrt(area) * 0.18 * hash01(`${b.id}r${k}`);
          const p: Vec2 = [c[0] + Math.cos(ang) * r, c[1] + Math.sin(ang) * r];
          if (!pointInPolygon(p, b.footprint)) continue;
          const sz = 1.5 + hash01(`${b.id}s${k}`) * 2.5;
          units.push(new THREE.Matrix4().makeRotationY(ang).scale(new THREE.Vector3(sz, 1 + sz * 0.4, sz * 1.4)).setPosition(p[0], this.base(b) + b.height, -p[1]));
        }
      }
      if (units.length) {
        const um = new THREE.InstancedMesh(UNIT_GEO, UNIT_MAT, units.length);
        units.forEach((m, k) => um.setMatrixAt(k, m));
        um.userData.detail = true;
        pick.mesh.add(um);
      }
      pick.mesh.castShadow = shadows;
      pick.mesh.receiveShadow = shadows;
      pick.mesh.userData.pick = 'building';
      pick.mesh.userData.chunk = pick;
      return pick;
    });

    const tunnelRoads = w.roads.filter((rd) => rd.tunnel && rd.kind !== 'footway' && rd.kind !== 'cycleway');
    if (this.layer('underground', [t, w.rails, ...tunnelRoads])) {
      this.clearGroup(this.undergroundGroup);
      const tunnels = w.rails.filter((rl) => rl.tunnel).map((rl) => ribbonGeometry(rl.points, 3.2, (p) => this.hp(p) - UNDER, new THREE.Color(0x9b59b6))).filter((g): g is THREE.BufferGeometry => !!g);
      for (const rd of tunnelRoads) {
        const g = ribbonGeometry(rd.points, roadWidth(rd), (p) => this.hp(p) - ROAD_TUNNEL, new THREE.Color(0x5a6270));
        if (g) tunnels.push(g);
      }
      if (tunnels.length) this.undergroundGroup.add(new THREE.Mesh(mergeGeometries(tunnels)!, new THREE.MeshBasicMaterial({ vertexColors: true })));
    }

    // Ground materials go translucent in x-ray mode so tunnels show through.
    this.groundMats = [];
    this.worldGroup.traverse((o) => {
      if (o.userData.ground) this.groundMats.push((o as THREE.Mesh).material as THREE.Material);
    });
    this.applyXray();
  }

  private applyXray() {
    const x = this.layers.underground;
    this.undergroundGroup.visible = x;
    for (const m of this.groundMats) {
      m.transparent = x;
      m.opacity = x ? 0.35 : 1;
      m.depthWrite = !x;
      m.needsUpdate = true;
    }
    if (this.ground?.parent) {
      // the big flat skirt/disc meshes share userData.ground
      this.worldGroup.traverse((o) => {
        if (o.userData.ground) (o as THREE.Mesh).renderOrder = x ? 1 : 0;
      });
    }
  }

  /** Water is flat: the sea at the median coast height, lakes and rivers at their lowest shore. Parks drape. */
  private areaHeight(a: Area, E: number, lift: number): number | ((p: Vec2) => number) {
    if (!this.world?.terrain) return a.kind === 'water' ? 0.04 : a.kind === 'land' ? 0.06 : 0.05;
    if (a.kind === 'park' || a.kind === 'land') return (p: Vec2) => this.hp(p) + lift + 0.05;
    const shore = a.polygon.filter((p) => !a.sea || (Math.abs(Math.abs(p[0]) - E) > 1 && Math.abs(Math.abs(p[1]) - E) > 1)).map(this.hp).sort((x, y) => x - y);
    if (!shore.length) return 0;
    return (a.sea ? shore[Math.floor(shore.length / 2)] : shore[0]) + 0.3;
  }

  /** Buildings sit on the lowest ground under their footprint so no wall floats. */
  private base(b: Building) {
    if (!this.world?.terrain) return 0;
    let m = Infinity;
    for (const p of b.footprint) m = Math.min(m, this.hp(p));
    return m;
  }

  private buildTransit() {
    this.clearGroup(this.transitGroup);
    this.clearGroup(this.metroGroup);
    this.buildSignals();
    if (!this.sim || !this.region) return;
    const routes: THREE.BufferGeometry[] = [];
    const decks: THREE.BufferGeometry[] = [];
    const pillars: THREE.Vector3[] = [];
    const platforms: THREE.Matrix4[] = [];
    const DECK = 8;
    for (const l of this.sim.info.lines) {
      const color = new THREE.Color(l.color);
      if (l.mode === 'bus') {
        const g = ribbonGeometry(l.pts, l.generated ? 1.1 : 1.8, (p) => this.hp(p) + this.lift + 0.16, color);
        if (g) routes.push(g);
        continue;
      }
      if (l.real) {
        // mapped rail: tracks are already drawn; mark stations with platforms at the line's level
        const y = l.level === 'under' ? -UNDER : l.level === 'elevated' ? 6.4 : this.lift;
        l.stops.forEach((p, i) => {
          const q = l.stops[i + 1] ?? l.stops[i - 1];
          platforms.push(new THREE.Matrix4().makeRotationY(Math.atan2(q[0] - p[0], -(q[1] - p[1]))).setPosition(p[0], this.hp(p) + y, -p[1]));
        });
        continue;
      }
      // Proposed metro: an elevated guideway with a coloured stripe, pillars and station platforms.
      const deck = ribbonGeometry(l.pts, 4.2, (p) => this.hp(p) + DECK, new THREE.Color(0xa3a8b0));
      const stripe = ribbonGeometry(l.pts, 1.2, (p) => this.hp(p) + DECK + 0.06, color);
      if (deck) decks.push(deck);
      if (stripe) decks.push(stripe);
      for (let i = 1; i < l.pts.length; i++) {
        const [a, b] = [l.pts[i - 1], l.pts[i]];
        const n = Math.max(1, Math.floor(dist(a, b) / 30));
        for (let k = 0; k <= n; k++) pillars.push(v3([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]));
      }
      l.stops.forEach((p, i) => {
        const q = l.stops[i + 1] ?? l.stops[i - 1];
        const ang = Math.atan2(q[0] - p[0], -(q[1] - p[1]));
        platforms.push(new THREE.Matrix4().makeRotationY(ang).setPosition(p[0], this.hp(p) + DECK - 0.6, -p[1]));
      });
    }
    if (routes.length) {
      this.transitGroup.add(new THREE.Mesh(mergeGeometries(routes)!, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false })));
    }
    const shadows = PRESETS[this.quality].shadows;
    if (decks.length) {
      const m = new THREE.Mesh(mergeGeometries(decks)!, this.flatMat);
      m.castShadow = shadows;
      this.metroGroup.add(m);
    }
    if (pillars.length) {
      const pm = new THREE.InstancedMesh(agentGeometry('pillar'), new THREE.MeshStandardMaterial({ color: 0x9a958d }), pillars.length);
      pillars.forEach((p, i) => pm.setMatrixAt(i, this.tmpM.makeScale(1.4, DECK, 1.4).setPosition(p.setY(this.h(p.x, -p.z)))));
      pm.castShadow = shadows;
      this.metroGroup.add(pm);
    }
    if (platforms.length) {
      const pl = new THREE.InstancedMesh(new THREE.BoxGeometry(9, 1.2, 40), new THREE.MeshStandardMaterial({ color: 0xd8dde3 }), platforms.length);
      platforms.forEach((m, i) => pl.setMatrixAt(i, m));
      this.metroGroup.add(pl);
    }
    const stops = this.sim.info.stops;
    if (stops.length) {
      const m = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.6, 0.6, 3.2, 8).translate(0, 1.6, 0), new THREE.MeshStandardMaterial({ color: this.region.busColor, emissive: this.region.busColor, emissiveIntensity: 0.25 }), stops.length);
      stops.forEach((p, i) => m.setMatrixAt(i, this.tmpM.makeTranslation(p[0] + 3, this.h(p[0] + 3, p[1] + 3), -p[1] - 3)));
      this.transitGroup.add(m);
    }
  }

  private drawDraft() {
    this.clearGroup(this.draftGroup);
    const d = this.tools.draft;
    if (!d.length) return;
    const zone = this.tools.tool === 'zone';
    const y = (p: Vec2) => this.hp(p) + (!zone && this.tools.lineMode === 'metro' ? 8.2 : 1.2);
    const color = zone ? ZONE_COLORS[this.tools.zone.use] : this.tools.lineMode === 'metro' ? 0x8e44ad : 0x3fd3c3;
    const ring = zone && d.length > 2 ? [...d, d[0]] : d;
    if (ring.length > 1) this.draftGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring.map((p) => v3(p, y(p)))), new THREE.LineBasicMaterial({ color, depthTest: false })));
    if (zone && d.length > 2) {
      const g = polygonGeometry(d, (p) => this.hp(p) + 0.6, new THREE.Color(color));
      if (g) this.draftGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide })));
    }
    for (const p of d) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      m.position.copy(v3(p, y(p)));
      this.draftGroup.add(m);
    }
  }

  finishDraft() {
    this.tools.finish(this.world);
  }

  lookAt(p: Vec2) {
    this.followId = null;
    this.flyTo(v3(p, this.hp(p)), 260, 0.95);
  }

  roadSpeeds() {
    return this.sim?.roadSpeed ?? new Map<string, number>();
  }

  private simParams: SimParams = { day: 'weekday', demandScale: 1, weather: 'clear', events: [] };
  private weather: Weather = 'clear';
  private eventGroup = new THREE.Group();
  private showEvents(events: CityEvent[]) {
    this.clearGroup(this.eventGroup);
    if (!this.eventGroup.parent) this.scene.add(this.eventGroup);
    for (const e of events) {
      const hh = String(Math.floor(e.start / 3600)).padStart(2, '0');
      const mm = String(Math.floor((e.start % 3600) / 60)).padStart(2, '0');
      this.eventGroup.add(noteMarker(`★ ${e.name} · ${hh}:${mm} · ${e.attendance.toLocaleString()} people`, v3(e.p, this.hp(e.p))));
    }
  }
  private precip?: THREE.LineSegments | THREE.Points;
  private setWeather(w: Weather) {
    this.weather = w;
    if (this.precip) {
      this.scene.remove(this.precip);
      this.precip.geometry.dispose();
      this.precip = undefined;
    }
    if (w !== 'rain' && w !== 'snow') return;
    const n = { low: 1200, medium: 3000, high: 6000 }[this.quality];
    const pos = new Float32Array(n * (w === 'rain' ? 6 : 3));
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * 400;
      const y = Math.random() * 160;
      const z = (Math.random() - 0.5) * 400;
      if (w === 'rain') pos.set([x, y, z, x + 0.3, y - 2.2, z], i * 6);
      else pos.set([x, y, z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.precip = w === 'rain'
      ? new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.45 }))
      : new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, transparent: true, opacity: 0.85 }));
    this.precip.frustumCulled = false;
    this.scene.add(this.precip);
  }

  private updateWeather(dt: number) {
    const p = this.precip;
    if (!p) return;
    // particles live in a box around the camera target; the box scrolls down and wraps
    const t = this.controls.target;
    const fall = (this.weather === 'rain' ? 60 : 4) * dt;
    p.position.x = t.x;
    p.position.z = t.z;
    p.position.y = ((p.position.y - fall) % 160 + 160) % 160 + t.y - 160;
    if (this.weather === 'snow') p.rotation.y += dt * 0.05;
  }
  setSimParams(p: SimParams) {
    const weatherChanged = p.weather !== this.simParams.weather || (p.weather !== 'clear' && !this.precip);
    this.simParams = p;
    this.sim?.setParams(p);
    if (weatherChanged) this.setWeather(p.weather);
    this.showEvents(p.events);
  }

  setZoneOptions(o: ZoneOptions) {
    this.tools.zone = o;
    this.drawDraft();
  }

  getView(): SavedView {
    const r = (v: THREE.Vector3) => v.toArray().map((x) => Math.round(x * 10) / 10) as [number, number, number];
    return { target: r(this.controls.target), position: r(this.camera.position) };
  }

  setView(v: SavedView) {
    if (!v.target || !v.position) return;
    this.tween = undefined;
    this.controls.target.fromArray(v.target);
    this.camera.position.fromArray(v.position);
  }

  setLineMode(m: 'bus' | 'metro') {
    this.tools.lineMode = m;
    this.drawDraft();
  }

  private buildSignals() {
    for (const m of [this.signalPoles, this.signalLights]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
    }
    if (this.crosswalks) {
      this.scene.remove(this.crosswalks);
      this.crosswalks.dispose();
    }
    this.signalPoles = this.signalLights = this.crosswalks = undefined;
    const heads = this.sim?.info.signals ?? [];
    if (!heads.length) return;
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.12, 4.6, 6).translate(0, 2.3, 0), new THREE.MeshStandardMaterial({ color: 0x3a3f46 }), heads.length);
    const lights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 1.1, 0.35).translate(0, 4.9, 0), new THREE.MeshBasicMaterial(), heads.length);
    heads.forEach((h, i) => {
      this.tmpM.makeRotationY(Math.atan2(h.hx, -h.hy)).setPosition(h.x, this.h(h.x, h.y) + this.lift, -h.y);
      poles.setMatrixAt(i, this.tmpM);
      lights.setMatrixAt(i, this.tmpM);
      lights.setColorAt(i, this.tmpC.setHex(0x22dd66));
    });
    this.signalPoles = poles;
    this.signalLights = lights;
    this.scene.add(poles, lights);
    // zebra crossings across each signalled approach, a few metres before the junction
    const stripes: THREE.Matrix4[] = [];
    const seen = new Set<string>();
    for (const h of heads) {
      const k = `${Math.round(h.cx)},${Math.round(h.cy)},${Math.round(Math.atan2(h.hy, h.hx) * 4)}`;
      if (seen.has(k) || h.hw < 2) continue;
      seen.add(k);
      const cx = h.cx - h.hx * (h.hw + 3);
      const cy = h.cy - h.hy * (h.hw + 3);
      const rot = Math.atan2(h.hx, -h.hy);
      for (let o = -h.hw + 0.5; o <= h.hw - 0.4; o += 1.1) {
        const x = cx + h.hy * o;
        const y = cy - h.hx * o;
        stripes.push(new THREE.Matrix4().makeRotationY(rot).setPosition(x, this.h(x, y) + this.lift + 0.16, -y));
      }
    }
    if (stripes.length) {
      this.crosswalks = new THREE.InstancedMesh(STRIPE_GEO, STRIPE_MAT, stripes.length);
      stripes.forEach((m, i) => this.crosswalks!.setMatrixAt(i, m));
      this.scene.add(this.crosswalks);
    }
  }

  private updateSignals() {
    const heads = this.sim?.info.signals;
    const m = this.signalLights;
    if (!heads || !m || !this.sim) return;
    const t = this.sim.time;
    heads.forEach((h, i) => {
      const st = signalPhase(t, h.offset, h.group);
      m.setColorAt(i, this.tmpC.setHex(st === 'green' ? 0x22dd66 : st === 'yellow' ? 0xffc21a : 0xff3b30));
    });
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  // ---------- city ring (context tiles) ----------
  private ctxTiles = new Map<string, { sig: string; group: THREE.Group }>();
  private ctxBuildingMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  /** City-ring buildings by pick id, so they can be inspected (read-only). */
  private ringInfo = new Map<string, { b: Building; base: number }>();
  /** A building by id: detailed data first, then the city ring. */
  private findBuilding(id: string | number): { b: Building; base: number; overview: boolean } | null {
    const b = this.world?.buildings.find((x) => x.id === id);
    if (b) return { b, base: this.base(b), overview: false };
    const r = this.ringInfo.get(String(id));
    return r ? { ...r, overview: true } : null;
  }
  private ctxMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });

  setContext(tiles: ContextTile[], detail: DetailZone) {
    const keep = new Set(tiles.map((t) => t.key));
    for (const key of [...this.work.keys()]) if (key.startsWith('c:') && !keep.has(key.slice(2).split('#')[0])) this.work.delete(key);
    for (const [k, c] of this.ctxTiles) {
      if (keep.has(k.split('#')[0])) continue;
      this.clearGroup(c.group);
      this.scene.remove(c.group);
      this.ctxTiles.delete(k);
    }
    const lift = this.lift;
    const terrainSig = this.world?.terrain ? 't' : 'f';
    for (const t of tiles) {
      const sig = overlapSig(detail, t.center) + terrainSig;
      // dense tiles hold tens of thousands of buildings: build in four quarters so no frame stalls.
      // A quarter is current if it is built or queued with this signature; only stale quarters are (re)queued.
      const parts = splitTile(t);
      parts.forEach((part) => {
        if (this.ctxTiles.get(part.key)?.sig === sig || this.work.get(`c:${part.key}`)?.run.name === sig) return;
        const run = () => this.buildContextTile(part, detail, sig, lift);
        Object.defineProperty(run, 'name', { value: sig });
        this.work.set(`c:${part.key}`, { at: part.center, run });
      });
    }
  }

  private buildContextTile(t: ContextTile, detail: DetailZone, sig: string, lift: number) {
    {
      const cur = this.ctxTiles.get(t.key);
      if (cur) {
        this.clearGroup(cur.group);
        this.scene.remove(cur.group);
      }
      const g = new THREE.Group();
      const outside = (p: Vec2) => !inDetail(detail, p);
      // buildings: same facade shader as detailed ones, neutral palette, no shadows (cheap)
      const items: { id: string; geom: THREE.BufferGeometry }[] = [];
      for (const id of this.ringInfo.keys()) if (id.startsWith(`ring:${t.key}:`)) this.ringInfo.delete(id);
      const ringR = PRESETS[this.quality].ring;
      for (const b of t.buildings) {
        const c = centroid(b.ring);
        if (!outside(c) || c[0] * c[0] + c[1] * c[1] > ringR * ringR) continue;
        if (b.height < 6 && Math.abs(signedArea(b.ring)) < 60) continue; // sheds and garages add triangles, not information
        const fake: Building = { id: `ring:${t.key}:${c[0] | 0}:${c[1] | 0}`, footprint: b.ring, height: b.height, heightSource: 'osm-height', use: b.height > 40 ? 'office' : 'unknown', useSource: 'osm', origin: 'real', name: 'Building (overview data)' };
        let base = Infinity;
        for (const p of b.ring) base = Math.min(base, this.hp(p));
        this.ringInfo.set(fake.id, { b: fake, base });
        items.push({ id: fake.id, geom: buildingGeometry(fake, buildingColor(fake, { highlightEstimated: false }), base) });
      }
      // High uses the lit-window facade shader; Low/Medium a flat material (far cheaper per pixel)
      if (items.length) {
        const pick = new PickMesh(items, this.quality === 'high' ? this.buildingMat : this.ctxBuildingMat);
        pick.mesh.userData.pick = 'building';
        pick.mesh.userData.chunk = pick;
        g.add(pick.mesh);
      }
      const flat: THREE.BufferGeometry[] = [];
      for (const w of t.water) {
        if (!outside(centroid(w))) continue;
        const pg = polygonGeometry(w, (p) => this.hp(p) + lift + 0.04, new THREE.Color(0x6fa6d0));
        if (pg) flat.push(pg);
      }
      for (const gr of t.green) {
        if (!outside(centroid(gr))) continue;
        const pg = polygonGeometry(gr, (p) => this.hp(p) + lift + 0.05, new THREE.Color(0xa6c98c));
        if (pg) flat.push(pg);
      }
      for (const r of t.roads) {
        if (!outside(r.points[0]) && !outside(r.points[r.points.length - 1])) continue;
        const rg = ribbonGeometry(r.points, roadWidth({ kind: r.kind, lanes: r.kind === 'highway' ? 4 : r.kind === 'service' ? 1 : 2 }), (p) => this.hp(p) + lift + ROAD_Y[r.kind], new THREE.Color(ROAD_COLORS[r.kind]));
        if (rg) flat.push(rg);
      }
      if (flat.length) g.add(new THREE.Mesh(mergeGeometries(flat)!, this.ctxMat));
      flat.forEach((x) => x.dispose());
      g.userData.ctx = true;
      this.scene.add(g);
      this.ctxTiles.set(t.key, { sig, group: g });
    }
  }

  private cullT = 0;
  /** Hide building and road chunks far from the camera, so big cities stay light on low-end GPUs. */
  private cullChunks(dt: number) {
    this.cullT += dt;
    if (this.cullT < 0.4) return;
    this.cullT = 0;
    // the detailed zone is small, so it stays visible as far as the city ring (no hole when zoomed out)
    // Visible range grows with zoom: when you pull back to see the city, you see all of it.
    const zoom = this.camera.position.distanceTo(this.controls.target) + PRESETS[this.quality].ring;
    const farCtx = Math.max({ low: 4500, medium: 7000, high: 11000 }[this.quality], zoom);
    const far = farCtx;
    const nearDetail = { low: 500, medium: 900, high: 1400 }[this.quality];
    const cam = this.camera.position;
    for (const c of this.ctxTiles.values()) {
      for (const m of c.group.children as THREE.Mesh[]) {
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const bs = m.geometry.boundingSphere!;
        m.visible = cam.distanceTo(bs.center) - bs.radius < farCtx;
      }
    }
    for (const store of [this.buildingChunks, this.roadChunks]) {
      for (const c of store.values()) {
        const g = c.pick.mesh.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const bs = g.boundingSphere!;
        const d = cam.distanceTo(bs.center) - bs.radius;
        c.pick.mesh.visible = d < far;
        for (const ch of c.pick.mesh.children) if (ch.userData.detail) ch.visible = d < nearDetail;
      }
    }
  }

  private updateTraffic(dt: number) {
    this.trafficT += dt;
    if (!this.layers.traffic || this.trafficT < 1 || !this.sim) return;
    this.trafficT = 0;
    const speeds = this.sim.roadSpeed;
    const c = new THREE.Color();
    for (const ch of this.roadChunks.values()) {
      ch.pick.paint((id) => {
        const r = speeds.get(id);
        return r === undefined ? null : trafficColor(r, c);
      });
    }
  }

  private refreshSelection() {
    if (this.highlight) {
      this.scene.remove(this.highlight);
      (this.highlight as THREE.Mesh).geometry?.dispose();
      this.highlight = undefined;
    }
    const s = this.selected;
    const w = this.world;
    if (!s || !w) return this.cb.onSelect(null);
    if (s.type === 'building') {
      const found = this.findBuilding(s.id);
      if (!found) return this.select(null);
      const { b, base, overview } = found;
      const g = buildingGeometry({ ...b, height: b.height + 0.05 }, new THREE.Color(), base);
      this.highlight = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true }));
      g.dispose();
      this.highlight.renderOrder = 10;
      this.scene.add(this.highlight);
      this.cb.onSelect({ type: 'building', building: b, overview });
    } else if (s.type === 'road') {
      const r = w.roads.find((x) => x.id === s.id);
      if (!r) return this.select(null);
      const g = ribbonGeometry(r.points, roadWidth(r) + 1.5, (p) => this.hp(p) + this.lift + 0.2, new THREE.Color(0x00e5ff));
      if (g) {
        this.highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false }));
        this.scene.add(this.highlight);
      }
      this.cb.onSelect({ type: 'road', road: r });
    } else {
      const id = s.id as number;
      const a = this.sim?.agents.find((x) => x.id === id);
      if (!a || !this.sim) {
        this.selected = null;
        this.followId = null;
        this.sim?.watch(null);
        return this.cb.onSelect(null);
      }
      this.sim.watch(id);
      this.cb.onSelect({ type: 'agent', agent: this.sim.describe(id) ?? { id, kind: a.kind, purpose: '…', speedKmh: 0 } });
    }
  }


  // ---------- per frame ----------

  private busy = 0;
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const start = performance.now();
    const raw = this.clock.getDelta();
    const dt = Math.min(0.1, raw);
    // Simulation runs on wall-clock time so a slow GPU never slows the city down (capped after tab switches).
    if (this.sim && this.running) this.sim.step(Math.min(1, raw) * this.speed);
    this.updateAgents();
    this.updateSignals();
    this.updateTraffic(dt);
    this.runWork(this.quality === 'low' ? 6 : 10);
    this.cullChunks(dt);
    this.updateWeather(dt);
    this.updateCamera(dt);
    this.controls.update();
    const floor = this.h(this.camera.position.x, -this.camera.position.z) + 1.5;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
    this.updateSky();
    this.renderer.render(this.scene, this.camera);
    this.busy += performance.now() - start;
    this.trackPerf(Math.min(raw, 5)); // real elapsed time: the 0.1 s animation cap made slow frames report inflated fps
  };

  private updateAgents() {
    const sim = this.sim;
    for (const k of AGENT_KINDS) this.agentSlots[k].length = 0;
    if (!sim || !this.layers.agents) {
      for (const k of AGENT_KINDS) this.agentMeshes[k].count = 0;
      this.trainMesh.count = 0;
      return;
    }
    for (const a of sim.agents) {
      if (a.under && !this.layers.underground) continue;
      const slots = this.agentSlots[a.kind];
      if (slots.length < MAX_INSTANCES) slots.push(a);
    }
    const lift = this.lift + 0.12;
    for (const k of AGENT_KINDS) {
      const mesh = this.agentMeshes[k];
      const slots = this.agentSlots[k];
      const palette = k === 'taxi' ? [this.region!.taxiColor] : k === 'bus' ? [this.region!.busColor] : PALETTES[k];
      for (let i = 0; i < slots.length; i++) {
        const a = slots[i];
        this.tmpM.makeRotationY(Math.atan2(a.hx, -a.hy)).setPosition(a.x, a.under ? this.h(a.x, a.y) - ROAD_TUNNEL + 0.1 : this.deckH(a.x, a.y) + lift, -a.y);
        mesh.setMatrixAt(i, this.tmpM);
        mesh.setColorAt(i, this.tmpC.setHex(a.id === this.followId ? 0x00e5ff : palette[a.id % palette.length]));
      }
      mesh.count = slots.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // flashing light bars on emergency vehicles
    const em = this.agentSlots.emergency;
    const flash = Math.floor(performance.now() / 250) % 2;
    em.slice(0, 64).forEach((a, i) => {
      this.tmpM.makeRotationY(Math.atan2(a.hx, -a.hy)).setPosition(a.x, this.deckH(a.x, a.y) + lift, -a.y);
      this.lightbars.setMatrixAt(i, this.tmpM);
      this.lightbars.setColorAt(i, this.tmpC.setHex((i + flash) % 2 ? 0xff2020 : 0x2060ff));
    });
    this.lightbars.count = Math.min(64, em.length);
    this.lightbars.instanceMatrix.needsUpdate = true;
    if (this.lightbars.instanceColor) this.lightbars.instanceColor.needsUpdate = true;

    const cars = sim.trains;
    const s = new THREE.Vector3();
    let ti = 0;
    cars.forEach((c) => {
      if (ti >= 200 || (c.level === 'under' && !this.layers.underground)) return;
      const i = ti++;
      s.set(1, 1, c.carLen);
      this.tmpM.makeRotationY(Math.atan2(c.hx, -c.hy)).scale(s).setPosition(c.x, this.h(c.x, c.y) + (c.level === 'under' ? -UNDER + 0.2 : c.level === 'deck' ? 8.15 : c.level === 'elevated' ? 7.2 : 0.15 + this.lift), -c.y);
      this.trainMesh.setMatrixAt(i, this.tmpM);
      this.trainMesh.setColorAt(i, this.tmpC.setHex(c.color ?? 0xc9ced6));
    });
    if (this.trainMesh.instanceColor) this.trainMesh.instanceColor.needsUpdate = true;
    this.trainMesh.count = ti;
    this.trainMesh.instanceMatrix.needsUpdate = true;

    if (this.followId !== null) {
      const a = sim.agents.find((x) => x.id === this.followId);
      if (!a) {
        this.followId = null;
        this.selected = null;
        this.cb.onSelect(null);
      } else if (!this.tween) {
        const p = v3([a.x, a.y], this.h(a.x, a.y) + 1);
        const delta = p.sub(this.controls.target);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
  }

  private updateCamera(dt: number) {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      if (tw.t >= 1) this.tween = undefined;
      return;
    }
    if (!this.keys.size) return;
    const target = this.controls.target;
    const off = this.camera.position.clone().sub(target);
    const fwd = off.clone().setY(0).normalize().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    const speed = Math.max(15, off.length()) * 1.1 * dt;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) move.add(fwd);
    if (k.has('s') || k.has('arrowdown')) move.sub(fwd);
    if (k.has('d') || k.has('arrowright')) move.add(right);
    if (k.has('a') || k.has('arrowleft')) move.sub(right);
    if (move.lengthSq()) {
      this.followId = null;
      move.normalize().multiplyScalar(speed);
      target.add(move);
      this.camera.position.add(move);
    }
    const sph = new THREE.Spherical().setFromVector3(off);
    if (k.has('q')) sph.theta += 1.4 * dt;
    if (k.has('e')) sph.theta -= 1.4 * dt;
    if (k.has('r')) sph.phi = Math.max(0.05, sph.phi - 0.9 * dt);
    if (k.has('f')) sph.phi = Math.min(this.controls.maxPolarAngle, sph.phi + 0.9 * dt);
    if (k.has('=') || k.has('+')) sph.radius = Math.max(this.controls.minDistance, sph.radius * (1 - 1.5 * dt));
    if (k.has('-')) sph.radius = Math.min(this.controls.maxDistance, sph.radius * (1 + 1.5 * dt));
    this.camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(sph));
  }

  private flyTo(target: THREE.Vector3, distance: number, polar: number, instant = false) {
    const cur = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const pos = target.clone().add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(distance, polar, cur.theta)));
    this.flyToPose(target, pos, instant);
  }

  private flyToPose(target: THREE.Vector3, pos: THREE.Vector3, instant = false) {
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      return;
    }
    this.tween = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), toPos: pos, toTarget: target, t: 0, dur: 0.9 };
  }

  private updateSky() {
    const h = (this.sim?.time ?? 12 * 3600) / 3600;
    const elev = Math.sin(((h - 6) / 12) * Math.PI);
    const day = THREE.MathUtils.smoothstep(elev, -0.12, 0.3);
    const dusk = Math.max(0, 1 - Math.abs(elev) / 0.25) * 0.8;
    const az = (h / 24) * Math.PI * 2;
    const el = Math.max(0.12, elev);
    const r = Math.min(this.world?.radius ?? 600, 950) * 2;
    const t = this.controls.target;
    this.sun.position.set(t.x + Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, t.z + Math.sin(az) * Math.cos(el) * r);
    this.sun.target.position.set(t.x, 0, t.z);
    // after dark a cool moonlight and brighter sky fill keep streets and blocks readable
    this.sun.intensity = 0.45 * (1 - day) + 2.4 * day;
    this.sun.color.setHex(0x9fb4e0).lerp(SUN_DAY, day).lerp(SKY_DUSK, dusk * 0.6);
    this.hemi.intensity = 0.85 + 0.15 * day;
    this.hemi.color.setHex(0x8fa6d6).lerp(HEMI_DAY, day);
    this.night.value = 1 - day;
    const g = (mu: number, w: number) => Math.exp(-(((h - mu + 36) % 24 - 12) ** 2) / (2 * w * w));
    this.lit.value = Math.min(0.6, 0.1 + 0.42 * g(20.5, 2.6) + 0.18 * g(7, 1.2));
    LAMP_MAT.color.setHex(0x55585e).lerp(LAMP_ON, Math.min(1, (1 - day) * 1.4));
    const bg = SKY_NIGHT.clone().lerp(SKY_DAY, day).lerp(SKY_DUSK, dusk * 0.55);
    if (this.weather !== 'clear') bg.lerp(new THREE.Color(this.weather === 'snow' ? 0xdfe5ea : 0x8d97a3), 0.6 * day + 0.2);
    this.scene.background = bg;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(bg);
    // Haze starts beyond what the camera is looking at, so aerial views stay crisp.
    const d = this.camera.position.distanceTo(this.controls.target);
    const haze = this.weather === 'fog' ? 0.12 : this.weather === 'clear' ? 1 : 0.45;
    const span = Math.max(this.world?.radius ?? 600, CONTEXT_RADIUS * 0.6);
    fog.near = (d + span * 1.2) * haze;
    fog.far = fog.near + span * 4 * haze;
    this.sun.intensity *= this.weather === 'clear' ? 1 : 0.55;
  }

  private trackPerf(dt: number) {
    this.frames++;
    this.perfT += dt;
    this.statsT += dt;
    if (this.statsT > 0.5 && this.sim) {
      this.statsT = 0;
      if (this.sim.stats) this.cb.onStats({ ...this.sim.stats, time: this.sim.time });
      if (this.selected?.type === 'agent') this.refreshSelection();
    }
    if (this.perfT < 1) return;
    const fps = this.frames / this.perfT;
    const frameMs = this.busy / Math.max(1, this.frames);
    this.busy = 0;
    this.frames = 0;
    this.perfT = 0;
    if (this.qualitySetting === 'auto' && !document.hidden) {
      // Adaptive resolution: trade sharpness for frame rate before anything else.
      this.slowSeconds = fps < 28 ? this.slowSeconds + 1 : 0;
      this.fastSeconds = fps > 55 ? this.fastSeconds + 1 : 0;
      const maxPr = Math.min(window.devicePixelRatio || 1, PRESETS[this.quality].pixelRatio);
      if (this.slowSeconds >= 3 && this.pixelRatio > 0.6) {
        this.pixelRatio = Math.max(0.6, this.pixelRatio - 0.2);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.slowSeconds = 0;
        if (this.pixelRatio <= 0.8 && this.renderer.shadowMap.enabled) {
          this.renderer.shadowMap.enabled = false;
          this.sun.castShadow = false;
        }
      } else if (this.fastSeconds >= 5 && this.pixelRatio < maxPr) {
        this.pixelRatio = Math.min(maxPr, this.pixelRatio + 0.1);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.fastSeconds = 0;
      }
    }
    const info = this.renderer.info.render;
    this.cb.onPerf({ fps, pixelRatio: this.pixelRatio, drawCalls: info.calls, triangles: info.triangles, quality: this.quality, frameMs, pending: this.work.size });
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- input ----------

  private onContextLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.disposed = true;
    this.cb.onContextLost?.();
  };

  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = undefined;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 500) return;
    this.handleClick(e);
  };

  private onDoubleClick = () => {
    if (this.selected) this.focusSelected();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.tools.tool !== 'road' || !this.tools.roadStart) return;
    const hit = this.pick(e, 'ground');
    if (!hit) return;
    this.clearRoadPreview();
    const geom = new THREE.BufferGeometry().setFromPoints([v3(this.tools.roadStart.p, this.hp(this.tools.roadStart.p) + 0.8), v3(hit.p, this.hp(hit.p) + 0.8)]);
    this.roadPreview = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x3fd3c3 }));
    this.scene.add(this.roadPreview);
  };

  private clearRoadPreview() {
    if (this.roadPreview) {
      this.scene.remove(this.roadPreview);
      this.roadPreview.geometry.dispose();
      this.roadPreview = undefined;
    }
  }

  private pick(e: PointerEvent | MouseEvent, what: 'all' | 'static' | 'ground' = 'all') {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    const groundT = this.groundT(ray);
    const targets: THREE.Object3D[] = [];
    if (what !== 'ground') {
      if (what === 'all' && this.layers.agents) for (const k of AGENT_KINDS) if (this.agentMeshes[k].count) {
        this.agentMeshes[k].computeBoundingSphere();
        targets.push(this.agentMeshes[k]);
      }
      // only chunks whose bounds the ray passes near (and in front of the ground hit) are tested
      for (const store of [this.buildingChunks, this.roadChunks]) {
        for (const c of store.values()) {
          const g = c.pick.mesh.geometry;
          if (!g.boundingSphere) g.computeBoundingSphere();
          const bs = g.boundingSphere!;
          if (ray.distanceSqToPoint(bs.center) <= bs.radius * bs.radius && ray.origin.distanceTo(bs.center) - bs.radius <= groundT) targets.push(c.pick.mesh);
        }
      }
      for (const c of this.ctxTiles.values()) {
        for (const m of c.group.children as THREE.Mesh[]) {
          if (!m.userData.chunk || !m.visible) continue;
          if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
          const bs = m.geometry.boundingSphere!;
          if (ray.distanceSqToPoint(bs.center) <= bs.radius * bs.radius && ray.origin.distanceTo(bs.center) - bs.radius <= groundT) targets.push(m);
        }
      }
    }
    const hit = targets.length ? this.raycaster.intersectObjects(targets, false)[0] : undefined;
    if (!hit || hit.distance > groundT) {
      if (!Number.isFinite(groundT)) return null;
      const gp = ray.at(groundT, new THREE.Vector3());
      return { kind: 'ground' as const, id: '', p: [gp.x, -gp.z] as Vec2 };
    }
    const p: Vec2 = [hit.point.x, -hit.point.z];
    const o = hit.object;
    if (o instanceof THREE.InstancedMesh && hit.instanceId !== undefined) {
      const a = this.agentSlots[o.userData.kind as AgentKind][hit.instanceId];
      if (a) return { kind: 'agent' as const, id: a.id, p };
    }
    const chunk = o.userData.chunk as PickMesh | undefined;
    if (chunk && hit.faceIndex != null) {
      const id = chunk.idAt(hit.faceIndex)!;
      return o.userData.pick === 'building' ? { kind: 'building' as const, id, p } : { kind: 'road' as const, id: id.replace(/#m$/, ''), p };
    }
    return { kind: 'ground' as const, id: '', p };
  }

  /** Distance along the ray to the terrain, by stepping through the heightfield (no triangle tests). */
  private groundT(ray: THREE.Ray): number {
    const o = ray.origin;
    const d = ray.direction;
    if (!this.world?.terrain) return d.y < -1e-6 ? -o.y / d.y : Infinity;
    let prev = 0;
    for (let t = 0; t < 20000; ) {
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      const above = o.y + d.y * t - this.h(x, -z);
      if (above <= 0) {
        let lo = prev;
        let hi = t;
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2;
          if (o.y + d.y * m - this.h(o.x + d.x * m, -(o.z + d.z * m)) > 0) lo = m;
          else hi = m;
        }
        return hi;
      }
      prev = t;
      t += Math.max(1, above * 0.5);
    }
    return Infinity;
  }

  private handleClick(e: PointerEvent) {
    const hit = this.pick(e, pickMode(this.tools.tool));
    if (hit) this.tools.click(hit, this.world);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      this.tools.cancel();
      this.select(null);
      return;
    }
    if (k === 'f' && e.shiftKey) return this.focusSelected();
    if (k === 'enter' && (this.tools.tool === 'transit' || this.tools.tool === 'zone')) return this.finishDraft();
    if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', '=', '+', '-', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k);
      this.tween = undefined;
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onBlur = () => this.keys.clear();
}
