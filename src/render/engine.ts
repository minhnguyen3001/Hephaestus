import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Area, Building, Road, Vec2, WorldData } from '../geo/types';
import { sampleTerrain } from '../geo/terrain';
import { treePoints } from '../geo/trees';
import { centroid, dist, hash01 } from '../geo/util';
import type { Edit } from '../project/edits';
import type { SavedView } from '../project/store';
import { roadWidth } from '../sim/graph';
import type { RegionProfile } from '../sim/region';
import { SimClient } from '../sim/client';
import type { AgentView } from '../sim/protocol';
import { AGENT_KINDS, signalPhase, type AgentInfo, type AgentKind, type DayType, type SimStats } from '../sim/simulation';

export type { AgentInfo };
import { agentGeometry, buildingColor, buildingGeometry, PickMesh, polygonGeometry, ribbonGeometry, v3, type BuildingStyle } from './geometry';
import { PRESETS, resolveQuality, type Quality, type QualitySetting } from './quality';
import { pickMode, ToolController, type Tool, type ZoneOptions } from './tools';
import { ZONE_COLORS } from './palette';
import { ROAD_COLORS } from './palette';

export type { Tool };
export type CameraMode = 'aerial' | 'neighborhood' | 'street' | 'inspect';


export type Selection =
  | { type: 'building'; building: Building }
  | { type: 'road'; road: Road }
  | { type: 'agent'; agent: AgentInfo };

export interface Perf {
  fps: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  quality: Quality;
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
  setSimParams(day: DayType, demandScale: number): void;
  dispose(): void;
}

export interface EngineCallbacks {
  onSelect(sel: Selection | null): void;
  onEdit(e: Edit): void;
  onStats(s: SimStats): void;
  onPerf(p: Perf): void;
  onHint(msg: string | null): void;
}

export interface Layers {
  agents: boolean;
  transit: boolean;
  estimated: boolean;
  traffic: boolean;
  trees: boolean;
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
};
const MAX_INSTANCES = 1100;
const SKY_DAY = new THREE.Color(0xa8cbe8);
const SKY_DUSK = new THREE.Color(0xf0a878);
const SKY_NIGHT = new THREE.Color(0x0b1322);

export class Engine implements WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private hemi = new THREE.HemisphereLight(0xdfeeff, 0x8a7f6a, 0.9);
  private worldGroup = new THREE.Group();
  private buildings?: PickMesh;
  private roads?: PickMesh;
  private ground?: THREE.Mesh;
  private transitGroup = new THREE.Group();
  private metroGroup = new THREE.Group();
  private draftGroup = new THREE.Group();
  private agentMeshes = {} as Record<AgentKind, THREE.InstancedMesh>;
  private agentSlots = {} as Record<AgentKind, AgentView[]>;
  private trainMesh: THREE.InstancedMesh;
  private highlight?: THREE.Object3D;
  private roadPreview?: THREE.Line;
  private night = { value: 0 };
  private buildingMat: THREE.MeshStandardMaterial;
  private flatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  private world?: WorldData;
  private region?: RegionProfile;
  sim?: SimClient;
  private roadSignature = '';
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
  private layers: Layers = { agents: true, transit: true, estimated: false, traffic: false, trees: true };
  private treeMesh?: THREE.InstancedMesh;
  private trafficT = 0;
  private signalPoles?: THREE.InstancedMesh;
  private signalLights?: THREE.InstancedMesh;
  private raycaster = new THREE.Raycaster();
  private down?: { x: number; y: number; t: number };
  private ro: ResizeObserver;
  private disposed = false;
  private tmpM = new THREE.Matrix4();
  private tmpC = new THREE.Color();
  /** Ground height (m) at local x, y. */
  private h = (x: number, y: number) => sampleTerrain(this.world?.terrain, x, y);
  private hp = (p: Vec2) => this.h(p[0], p[1]);
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
      enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI * 0.495, minDistance: 3, maxDistance: 7000,
      screenSpacePanning: false, zoomToCursor: true, rotateSpeed: 0.6, zoomSpeed: 1.2,
    });
    this.controls.addEventListener('start', () => {
      this.tween = undefined;
    });

    this.buildingMat = this.makeBuildingMaterial();
    this.scene.add(this.hemi, this.sun, this.sun.target, this.worldGroup, this.transitGroup, this.metroGroup, this.draftGroup);
    this.sun.castShadow = preset.shadows;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.fog = new THREE.Fog(SKY_DAY, 2000, 9000);

    const agentMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 });
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
    this.trainMesh = new THREE.InstancedMesh(agentGeometry('train'), new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 }), 200);
    this.trainMesh.setColorAt(0, new THREE.Color());
    this.trainMesh.count = 0;
    this.trainMesh.frustumCulled = false;
    this.trainMesh.castShadow = preset.shadows;
    this.scene.add(this.trainMesh);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
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
    const sig = world.roads.map((r) => `${r.id}:${r.kind}:${r.lanes}:${+r.oneway}:${r.maxspeedKmh}`).join('|') + region.id + JSON.stringify(world.transitLines ?? []);
    if (!this.sim || sig !== this.roadSignature || region !== this.region) {
      this.startSim(world, region, 1);
      this.roadSignature = sig;
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
    if (trafficOff) this.roads?.paint(() => null);
    if (this.treeMesh) this.treeMesh.visible = l.trees;
    this.trafficT = 99;
    if (restyle && this.world) this.buildStatic();
  }

  setTime(seconds: number) {
    this.sim?.setTime(((seconds % 86400) + 86400) % 86400);
  }

  resetSim() {
    if (this.world && this.region) this.startSim(this.world, this.region, Math.floor(Math.random() * 1e9));
  }

  private startSim(world: WorldData, region: RegionProfile, seed: number) {
    const time = this.sim?.time ?? 7.5 * 3600;
    this.sim?.dispose();
    this.sim = new SimClient(world, region, PRESETS[this.quality].maxAgents, seed, time);
    this.sim.setParams(...this.simParams);
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
    if (mode === 'aerial') this.flyTo(new THREE.Vector3(0, this.h(0, 0), 0), r * 2.1, 0.55, instant);
    else if (mode === 'neighborhood') this.flyTo(new THREE.Vector3(t.x, g, t.z), Math.min(420, r), 0.95, instant);
    else if (mode === 'street') this.flyTo(new THREE.Vector3(t.x, g + 1.7, t.z), 14, 1.48, instant);
    else this.focusSelected();
  }

  /** Orbit-focus the selected object so the user can circle it 360°. */
  focusSelected() {
    const s = this.selected;
    if (!s || !this.world) return;
    if (s.type === 'building') {
      const b = this.world.buildings.find((x) => x.id === s.id);
      if (!b) return;
      const size = Math.max(...b.footprint.map((p) => dist(p, centroid(b.footprint))));
      this.flyTo(v3(centroid(b.footprint), this.base(b) + b.height * 0.45), Math.max(40, size * 2.6, b.height * 1.8), 1.15);
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
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const c = this.renderer.domElement;
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
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWall;\nattribute vec2 aFacade;\nvarying float vWall;\nvarying vec2 vFacade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = aWall;\nvFacade = aFacade;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vWall;\nvarying vec2 vFacade;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float gLit = 0.0;
          if (vWall > 0.5 && vFacade.y > 2.8) {
            vec2 cell = vec2(vFacade.x / 3.4, (vFacade.y - 0.8) / 3.2);
            vec2 f = fract(cell);
            float rawWin = step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.85);
            // fade the daytime window grid where it would alias into noise; lit windows stay as city lights
            float fade = 1.0 - smoothstep(0.2, 0.55, max(fwidth(cell.x), fwidth(cell.y)));
            float win = rawWin * fade;
            float r = fract(sin(dot(floor(cell) + vColor.rg * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
            gLit = rawWin * step(0.5, r) * mix(0.55, 1.0, fade);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.21, 0.28), win * 0.45);
          }`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.8, 0.48) * gLit * uNight * 1.3;');
    };
    return mat;
  }

  private clearGroup(g: THREE.Group) {
    g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    g.clear();
  }

  private buildStatic() {
    const w = this.world!;
    this.clearGroup(this.worldGroup);
    this.buildings?.dispose();
    this.roads?.dispose();
    const shadows = PRESETS[this.quality].shadows;
    const r = w.radius;

    const t = w.terrain;
    const lift = this.lift;
    if (t) {
      // Terrain mesh from the DEM grid, lighter inside the loaded data radius.
      const g = new THREE.PlaneGeometry(2 * t.extent, 2 * t.extent, t.n - 1, t.n - 1).rotateX(-Math.PI / 2);
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
      this.worldGroup.add(this.ground, skirt);
    } else {
      this.ground = new THREE.Mesh(new THREE.PlaneGeometry(r * 14, r * 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xcdc6b6, roughness: 1 }));
      this.ground.receiveShadow = shadows;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 96).rotateX(-Math.PI / 2).translate(0, 0.02, 0), new THREE.MeshStandardMaterial({ color: 0xe6e0d3, roughness: 1 }));
      disc.receiveShadow = shadows;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 2, r, 128).rotateX(-Math.PI / 2).translate(0, 0.05, 0), new THREE.MeshBasicMaterial({ color: 0x3a7bd5, transparent: true, opacity: 0.35 }));
      this.worldGroup.add(this.ground, disc, ring);
    }
    this.ground.userData.ground = true;

    const E = r * 1.3;
    const areaColor = { water: 0x6fa6d0, park: 0xa6c98c, land: 0xe0dacc };
    const areaGeoms = w.areas
      .map((a) => polygonGeometry(a.polygon, this.areaHeight(a, E, lift), new THREE.Color(areaColor[a.kind]), a.holes))
      .filter((g): g is THREE.BufferGeometry => !!g);
    if (areaGeoms.length) {
      const m = new THREE.Mesh(mergeGeometries(areaGeoms)!, this.flatMat);
      m.receiveShadow = shadows;
      m.userData.ground = true;
      this.worldGroup.add(m);
    }

    const roadItems: { id: string; geom: THREE.BufferGeometry }[] = [];
    const mark = new THREE.Color(0xeae3c9);
    for (const road of w.roads) {
      if (road.tunnel) continue;
      const color = new THREE.Color(ROAD_COLORS[road.kind]);
      if (road.origin === 'proposed') color.lerp(new THREE.Color(0x3fd3c3), 0.45);
      const g = ribbonGeometry(road.points, roadWidth(road), (p) => this.hp(p) + lift + ROAD_Y[road.kind], color);
      if (g) roadItems.push({ id: road.id, geom: g });
      if (!road.oneway && road.lanes >= 2 && road.kind !== 'service' && road.kind !== 'footway' && road.kind !== 'cycleway') {
        const c = ribbonGeometry(road.points, 0.18, (p) => this.hp(p) + lift + ROAD_Y[road.kind] + 0.01, mark);
        if (c) roadItems.push({ id: `${road.id}#m`, geom: c });
      }
    }
    this.roads = new PickMesh(roadItems, this.flatMat);
    this.roads.mesh.receiveShadow = shadows;
    this.roads.mesh.userData.pick = 'road';
    this.worldGroup.add(this.roads.mesh);

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
      this.worldGroup.add(m);
    }
    if (pillars.length) {
      const pm = new THREE.InstancedMesh(agentGeometry('pillar'), new THREE.MeshStandardMaterial({ color: 0x8b857d }), pillars.length);
      pillars.forEach((p, i) => pm.setMatrixAt(i, this.tmpM.makeScale(1, 7, 1).setPosition(p.setY(this.h(p.x, -p.z)))));
      pm.castShadow = shadows;
      this.worldGroup.add(pm);
    }

    const trees = treePoints(w, { low: 1500, medium: 3500, high: 7000 }[this.quality]);
    if (trees.length) {
      const tm = new THREE.InstancedMesh(agentGeometry('tree'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), trees.length);
      const greens = [0x5f8f4e, 0x6f9a52, 0x55804a, 0x7da35a, 0x4f7a45];
      trees.forEach((t, i) => {
        const [x, y] = t.p;
        this.tmpM.makeRotationY(hash01(`${x}`) * 6.28).scale(new THREE.Vector3(t.scale, t.scale * (0.9 + hash01(`${y}`) * 0.3), t.scale)).setPosition(x, this.h(x, y) + lift, -y);
        tm.setMatrixAt(i, this.tmpM);
        tm.setColorAt(i, this.tmpC.setHex(greens[i % greens.length]));
      });
      tm.castShadow = shadows;
      tm.visible = this.layers.trees;
      this.treeMesh = tm;
      this.worldGroup.add(tm);
    } else this.treeMesh = undefined;

    const style: BuildingStyle = { highlightEstimated: this.layers.estimated };
    this.buildings = new PickMesh(
      w.buildings.map((b) => ({ id: b.id, geom: buildingGeometry(b, buildingColor(b, style), this.base(b)) })),
      this.buildingMat,
    );
    this.buildings.mesh.castShadow = shadows;
    this.buildings.mesh.receiveShadow = shadows;
    this.buildings.mesh.userData.pick = 'building';
    this.worldGroup.add(this.buildings.mesh);

    const sc = this.sun.shadow.camera;
    sc.left = -r * 1.1;
    sc.right = r * 1.1;
    sc.top = r * 1.1;
    sc.bottom = -r * 1.1;
    sc.near = 1;
    sc.far = r * 6;
    sc.updateProjectionMatrix();
    const size = PRESETS[this.quality].shadowSize;
    if (size && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.scene.fog = new THREE.Fog(SKY_DAY, r * 2.5, r * 9);
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

  private simParams: [DayType, number] = ['weekday', 1];
  setSimParams(day: DayType, demandScale: number) {
    this.simParams = [day, demandScale];
    this.sim?.setParams(day, demandScale);
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
    this.signalPoles = this.signalLights = undefined;
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

  private updateTraffic(dt: number) {
    this.trafficT += dt;
    if (!this.layers.traffic || this.trafficT < 1 || !this.roads || !this.sim) return;
    this.trafficT = 0;
    const speeds = this.sim.roadSpeed;
    const c = new THREE.Color();
    this.roads.paint((id) => {
      const r = speeds.get(id);
      return r === undefined ? null : trafficColor(r, c);
    });
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
      const b = w.buildings.find((x) => x.id === s.id);
      if (!b) return this.select(null);
      const g = buildingGeometry({ ...b, height: b.height + 0.05 }, new THREE.Color(), this.base(b));
      this.highlight = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true }));
      g.dispose();
      this.highlight.renderOrder = 10;
      this.scene.add(this.highlight);
      this.cb.onSelect({ type: 'building', building: b });
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

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const raw = this.clock.getDelta();
    const dt = Math.min(0.1, raw);
    // Simulation runs on wall-clock time so a slow GPU never slows the city down (capped after tab switches).
    if (this.sim && this.running) this.sim.step(Math.min(1, raw) * this.speed);
    this.updateAgents();
    this.updateSignals();
    this.updateTraffic(dt);
    this.updateCamera(dt);
    this.controls.update();
    const floor = this.h(this.camera.position.x, -this.camera.position.z) + 1.5;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
    this.updateSky();
    this.renderer.render(this.scene, this.camera);
    this.trackPerf(dt);
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
        this.tmpM.makeRotationY(Math.atan2(a.hx, -a.hy)).setPosition(a.x, this.h(a.x, a.y) + lift, -a.y);
        mesh.setMatrixAt(i, this.tmpM);
        mesh.setColorAt(i, this.tmpC.setHex(a.id === this.followId ? 0x00e5ff : palette[a.id % palette.length]));
      }
      mesh.count = slots.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const cars = sim.trains;
    const s = new THREE.Vector3();
    cars.forEach((c, i) => {
      if (i >= 200) return;
      s.set(1, 1, c.carLen);
      this.tmpM.makeRotationY(Math.atan2(c.hx, -c.hy)).scale(s).setPosition(c.x, this.h(c.x, c.y) + (c.color !== undefined ? 8.15 : c.elevated ? 7.2 : 0.15 + this.lift), -c.y);
      this.trainMesh.setMatrixAt(i, this.tmpM);
      this.trainMesh.setColorAt(i, this.tmpC.setHex(c.color ?? 0xc9ced6));
    });
    if (this.trainMesh.instanceColor) this.trainMesh.instanceColor.needsUpdate = true;
    this.trainMesh.count = Math.min(200, cars.length);
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
    const r = (this.world?.radius ?? 600) * 2;
    const t = this.controls.target;
    this.sun.position.set(t.x + Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, t.z + Math.sin(az) * Math.cos(el) * r);
    this.sun.target.position.set(t.x, 0, t.z);
    this.sun.intensity = 0.08 + 2.4 * day;
    this.sun.color.setHex(0xfff1dc).lerp(SKY_DUSK, dusk * 0.6);
    this.hemi.intensity = 0.25 + 0.75 * day;
    this.night.value = 1 - day;
    const bg = SKY_NIGHT.clone().lerp(SKY_DAY, day).lerp(SKY_DUSK, dusk * 0.55);
    this.scene.background = bg;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(bg);
    // Haze starts beyond what the camera is looking at, so aerial views stay crisp.
    const d = this.camera.position.distanceTo(this.controls.target);
    fog.near = d + (this.world?.radius ?? 600) * 1.2;
    fog.far = fog.near + (this.world?.radius ?? 600) * 6;
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
    this.cb.onPerf({ fps, pixelRatio: this.pixelRatio, drawCalls: info.calls, triangles: info.triangles, quality: this.quality });
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- input ----------

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
    const targets: THREE.Object3D[] = [];
    if (what !== 'ground') {
      if (what === 'all' && this.layers.agents) for (const k of AGENT_KINDS) if (this.agentMeshes[k].count) {
        this.agentMeshes[k].computeBoundingSphere();
        targets.push(this.agentMeshes[k]);
      }
      if (this.buildings) targets.push(this.buildings.mesh);
      if (this.roads) targets.push(this.roads.mesh);
    }
    if (this.ground) targets.push(this.ground);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const p: Vec2 = [hit.point.x, -hit.point.z];
    const o = hit.object;
    if (o instanceof THREE.InstancedMesh && hit.instanceId !== undefined) {
      const a = this.agentSlots[o.userData.kind as AgentKind][hit.instanceId];
      if (a) return { kind: 'agent' as const, id: a.id, p };
    }
    if (o === this.buildings?.mesh && hit.faceIndex != null) return { kind: 'building' as const, id: this.buildings.idAt(hit.faceIndex)!, p };
    if (o === this.roads?.mesh && hit.faceIndex != null) return { kind: 'road' as const, id: this.roads.idAt(hit.faceIndex)!.replace(/#m$/, ''), p };
    return { kind: 'ground' as const, id: '', p };
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
