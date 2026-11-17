import type { Building, Road, Vec2, WorldData } from '../geo/types';
import type { SavedView } from '../project/store';
import { treePoints } from '../geo/trees';
import { hash01, pointInPolygon } from '../geo/util';
import { SimClient } from '../sim/client';
import { roadWidth } from '../sim/graph';
import type { RegionProfile } from '../sim/region';
import { signalPhase, type DayType } from '../sim/simulation';
import { trafficColor, type CameraMode, type EngineCallbacks, type Layers, type WorldRenderer } from './engine';
import { AGENT_COLORS, AREA_COLORS, ESTIMATED_TINT, hex, PROPOSED_COLOR, ROAD_COLORS, USE_COLORS, ZONE_COLORS } from './palette';
import { PRESETS } from './quality';
import { pickMode, ToolController, type Hit, type Tool, type ZoneOptions } from './tools';

const AGENT_SIZE: Record<string, [number, number]> = {
  pedestrian: [0.7, 0.7], bicycle: [0.6, 1.8], motorcycle: [0.8, 2.1], car: [1.9, 4.6], taxi: [1.9, 4.8], truck: [2.5, 9], bus: [2.6, 12], emergency: [2.1, 5.6],
};

function shade(n: number, f: number) {
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}
function mix(a: number, b: number, t: number) {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * 2D plan view: Canvas2D, no WebGL needed. Same data, tools and simulation as the 3D engine —
 * for very low-powered devices, browsers without WebGL, and precise top-down planning.
 */
export class Plan2D implements WorldRenderer {
  running = true;
  speed = 1;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private world?: WorldData;
  private region?: RegionProfile;
  private sim?: SimClient;
  private roadSig = '';
  private cx = 0;
  private cy = 0;
  private scale = 1; // px per meter
  private layers: Layers = { agents: true, transit: true, estimated: false, traffic: false, trees: true, underground: false };
  private subwayPath = new Path2D();
  private treePath = new Path2D();
  private roadById = new Map<string, { path: Path2D; width: number }>();
  private fills: { color: string; path: Path2D }[] = [];
  private roadPaths: { width: number; color: string; path: Path2D }[] = [];
  private areaPaths: { color: string; path: Path2D }[] = [];
  private railPath = new Path2D();
  private bbox = new Map<string, [number, number, number, number]>();
  private selected: { type: 'building' | 'road' | 'agent'; id: string | number } | null = null;
  private followId: number | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private down?: { x: number; y: number; t: number };
  private lastPinch = 0;
  private hover?: Vec2;
  private keys = new Set<string>();
  private raf = 0;
  private last = performance.now();
  private statsT = 0;
  private perfT = 0;
  private frames = 0;
  private ro: ResizeObserver;
  private tools = new ToolController({
    onEdit: (e) => this.cb.onEdit(e),
    onHint: (m) => this.cb.onHint(m),
    select: (sel) => this.select(sel),
    follow: (id) => this.follow(id),
    preselect: (sel) => (this.selected = sel),
    clearPreview: () => (this.hover = undefined),
    drawDraft: () => undefined, // drawn every frame
  });

  constructor(private container: HTMLElement, private cb: EngineCallbacks) {
    this.canvas.style.touchAction = 'none';
    this.canvas.style.display = 'block';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    this.loop();
  }

  // ---------- WorldRenderer ----------

  setWorld(world: WorldData, region: RegionProfile) {
    const first = !this.world;
    this.world = world;
    const sig = world.roads.map((r) => `${r.id}:${r.kind}:${r.lanes}:${+r.oneway}:${r.maxspeedKmh}`).join('|') + region.id + JSON.stringify(world.transitLines ?? []);
    if (!this.sim || sig !== this.roadSig || region !== this.region) this.startSim(world, region, 1);
    this.roadSig = sig;
    this.region = region;
    this.buildPaths();
    if (first) this.setCameraMode('neighborhood');
    this.refreshSelection();
  }

  setTool(t: Tool) {
    this.tools.set(t);
  }

  setLayers(l: Layers) {
    const restyle = l.estimated !== this.layers.estimated;
    this.layers = l;
    this.version++;
    if (restyle) this.buildPaths();
  }

  setTime(seconds: number) {
    this.sim?.setTime(((seconds % 86400) + 86400) % 86400);
  }

  resetSim() {
    if (this.world && this.region) this.startSim(this.world, this.region, Math.floor(Math.random() * 1e9));
  }

  select(sel: { type: 'building' | 'road' | 'agent'; id: string | number } | null) {
    this.selected = sel;
    if (!sel || sel.type !== 'agent') this.followId = null;
    this.refreshSelection();
  }

  follow(id: number | null) {
    this.followId = id;
  }

  setCameraMode(mode: CameraMode) {
    const r = this.world?.radius ?? 600;
    const span = mode === 'aerial' ? r * 2.3 : mode === 'neighborhood' ? 700 : mode === 'street' ? 90 : 0;
    if (mode === 'aerial') {
      this.cx = 0;
      this.cy = 0;
    }
    if (span) this.scale = Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / span;
    else this.focusSelected();
  }

  focusSelected() {
    const s = this.selected;
    if (!s || s.type === 'agent') return;
    const bb = s.type === 'building' ? this.bbox.get(s.id as string) : undefined;
    if (bb) {
      this.cx = (bb[0] + bb[2]) / 2;
      this.cy = (bb[1] + bb[3]) / 2;
      this.scale = Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / Math.max(80, (bb[2] - bb[0]) * 4, (bb[3] - bb[1]) * 4);
    } else if (s.type === 'road') {
      const r = this.world?.roads.find((x) => x.id === s.id);
      if (r) [this.cx, this.cy] = r.points[Math.floor(r.points.length / 2)];
    }
  }

  orbitStep() {
    /* north-up plan view */
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
  }

  getView(): SavedView {
    return { center: [Math.round(this.cx * 10) / 10, Math.round(this.cy * 10) / 10], scale: Math.round(this.scale * 1000) / 1000 };
  }

  setView(v: SavedView) {
    if (!v.center || !v.scale) return;
    [this.cx, this.cy] = v.center;
    this.scale = v.scale;
  }

  setLineMode(m: 'bus' | 'metro') {
    this.tools.lineMode = m;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.sim?.dispose();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.remove();
  }

  // ---------- internals ----------

  private startSim(world: WorldData, region: RegionProfile, seed: number) {
    const time = this.sim?.time ?? 7.5 * 3600;
    this.sim?.dispose();
    // The plan view is the low-end path, so it uses the low agent budget.
    this.sim = new SimClient(world, region, PRESETS.low.maxAgents, seed, time);
    this.sim.setParams(...this.simParams);
  }

  private buildPaths() {
    const w = this.world!;
    this.version++;
    const groups = new Map<string, Path2D>();
    this.bbox.clear();
    for (const b of w.buildings) {
      let c = b.origin === 'proposed' ? PROPOSED_COLOR : USE_COLORS[b.use];
      if (this.layers.estimated && b.heightSource === 'estimated') c = mix(c, ESTIMATED_TINT, 0.55);
      // taller buildings read darker, a cheap depth cue in plan view
      const color = shade(c, Math.max(0.62, 1 - b.height / 400) * (0.96 + hash01(b.id) * 0.06));
      const p = groups.get(color) ?? new Path2D();
      groups.set(color, p);
      p.addPath(this.polyPath(b.footprint));
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of b.footprint) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      this.bbox.set(b.id, [x0, y0, x1, y1]);
    }
    this.fills = [...groups].map(([color, path]) => ({ color, path }));

    const roads = new Map<string, { width: number; color: string; path: Path2D }>();
    this.roadById.clear();
    for (const r of w.roads) {
      if (r.tunnel) continue;
      const color = hex(r.origin === 'proposed' ? mix(ROAD_COLORS[r.kind], PROPOSED_COLOR, 0.45) : ROAD_COLORS[r.kind]);
      const width = roadWidth(r);
      const k = `${color}|${width}`;
      const g = roads.get(k) ?? { width, color, path: new Path2D() };
      roads.set(k, g);
      const path = this.linePath(r.points);
      g.path.addPath(path);
      this.roadById.set(r.id, { path, width });
    }
    // wide roads first so narrow ones draw on top
    this.roadPaths = [...roads.values()].sort((a, b) => b.width - a.width);

    this.areaPaths = w.areas.map((a) => {
      const path = this.polyPath(a.polygon);
      for (const h of a.holes ?? []) path.addPath(this.polyPath(h));
      return { color: hex(AREA_COLORS[a.kind]), path };
    });
    this.treePath = new Path2D();
    for (const t of treePoints(w, 4000)) {
      this.treePath.moveTo(t.p[0] + 2.4 * t.scale, t.p[1]);
      this.treePath.arc(t.p[0], t.p[1], 2.4 * t.scale, 0, Math.PI * 2);
    }
    this.railPath = new Path2D();
    this.subwayPath = new Path2D();
    for (const r of w.rails) (r.tunnel ? this.subwayPath : this.railPath).addPath(this.linePath(r.points));
  }

  private polyPath(pts: Vec2[]) {
    const p = new Path2D();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    return p;
  }

  private linePath(pts: Vec2[]) {
    const p = new Path2D();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    return p;
  }

  private refreshSelection() {
    const s = this.selected;
    const w = this.world;
    if (!s || !w) return this.cb.onSelect(null);
    if (s.type === 'building') {
      const b = w.buildings.find((x) => x.id === s.id);
      return b ? this.cb.onSelect({ type: 'building', building: b }) : this.select(null);
    }
    if (s.type === 'road') {
      const r = w.roads.find((x) => x.id === s.id);
      return r ? this.cb.onSelect({ type: 'road', road: r }) : this.select(null);
    }
    const id = s.id as number;
    const a = this.sim?.agents.find((x) => x.id === id);
    if (!a || !this.sim) {
      this.selected = null;
      this.followId = null;
      return this.cb.onSelect(null);
    }
    this.sim.watch(id);
    this.cb.onSelect({ type: 'agent', agent: this.sim.describe(id) ?? { id, kind: a.kind, purpose: '…', speedKmh: 0 } });
  }

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, this.container.clientWidth * dpr);
    this.canvas.height = Math.max(1, this.container.clientHeight * dpr);
    this.canvas.style.width = `${this.container.clientWidth}px`;
    this.canvas.style.height = `${this.container.clientHeight}px`;
  }

  private toWorld(sx: number, sy: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return [this.cx + (sx - rect.left - rect.width / 2) / this.scale, this.cy - (sy - rect.top - rect.height / 2) / this.scale];
  }

  private busy = 0;
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.1, raw);
    this.last = now;
    if (this.sim && this.running) this.sim.step(Math.min(1, raw) * this.speed);
    this.moveKeys(dt);
    if (this.followId !== null && this.sim) {
      const a = this.sim.agents.find((x) => x.id === this.followId);
      if (a) [this.cx, this.cy] = [a.x, a.y];
    }
    this.draw();
    this.busy += performance.now() - now;
    this.statsT += dt;
    this.perfT += dt;
    this.frames++;
    if (this.statsT > 0.5 && this.sim?.stats) {
      this.statsT = 0;
      this.cb.onStats({ ...this.sim.stats, time: this.sim.time });
      if (this.selected?.type === 'agent') this.refreshSelection();
    }
    if (this.perfT >= 1) {
      this.cb.onPerf({ fps: this.frames / this.perfT, pixelRatio: 1, drawCalls: 0, triangles: 0, quality: 'low', frameMs: this.busy / Math.max(1, this.frames) });
      this.busy = 0;
      this.perfT = 0;
      this.frames = 0;
    }
  };

  private staticCanvas = document.createElement('canvas');
  private staticKey = '';
  private version = 0;

  private draw() {
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const hour = (this.sim?.time ?? 43200) / 3600;
    const night = hour < 6 || hour > 19.5 ? 1 : hour < 7 ? 7 - hour : hour > 18.5 ? hour - 18.5 : 0;
    const s = this.scale * dpr;
    const px = 1 / this.scale; // one CSS pixel in meters
    // The map itself only changes when the view, data or layers change: cache it and just blit it.
    const key = [this.cx, this.cy, this.scale, W, H, this.version, this.sim?.infoVersion, this.layers.traffic ? this.sim?.speedVersion : 0].join('|');
    if (key !== this.staticKey) {
      this.staticKey = key;
      if (this.staticCanvas.width !== W || this.staticCanvas.height !== H) {
        this.staticCanvas.width = W;
        this.staticCanvas.height = H;
      }
      this.drawStatic(this.staticCanvas.getContext('2d')!, W, H, s, px);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(s, 0, 0, -s, W / 2 - this.cx * s, H / 2 + this.cy * s);
    if (this.world) {
      if (this.sim && this.scale > 0.7) {
        for (const h of this.sim.info.signals) {
          const st = signalPhase(this.sim.time, h.offset, h.group);
          ctx.fillStyle = st === 'green' ? '#22dd66' : st === 'yellow' ? '#ffc21a' : '#ff3b30';
          ctx.beginPath();
          ctx.arc(h.x, h.y, Math.max(0.9, 2.5 * px), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      this.drawSelection(px);
      if (this.layers.agents && this.sim) this.drawAgents(px);
      const d = this.tools.draft;
      if (d.length) {
        const zone = this.tools.tool === 'zone';
        ctx.strokeStyle = zone ? hex(ZONE_COLORS[this.tools.zone.use]) : this.tools.lineMode === 'metro' ? '#8e44ad' : hex(PROPOSED_COLOR);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = Math.max(3, 2 * px);
        if (zone && d.length > 2) {
          ctx.globalAlpha = 0.25;
          ctx.fill(this.polyPath(d));
          ctx.globalAlpha = 1;
          ctx.stroke(this.polyPath(d));
        } else ctx.stroke(this.linePath(d));
        for (const [x, y] of d) {
          ctx.beginPath();
          ctx.arc(x, y, Math.max(3, 5 * px), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (this.tools.roadStart && this.hover) {
        ctx.strokeStyle = hex(PROPOSED_COLOR);
        ctx.lineWidth = Math.max(6.4, 2 * px);
        ctx.beginPath();
        ctx.moveTo(...this.tools.roadStart.p);
        ctx.lineTo(...this.hover);
        ctx.stroke();
      }
    }
    if (night > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(11,19,34,${0.45 * Math.min(1, night)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private drawStatic(ctx: CanvasRenderingContext2D, W: number, H: number, s: number, px: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#cdc6b6';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, -s, W / 2 - this.cx * s, H / 2 + this.cy * s);
    const w = this.world;
    if (!w) return;
    ctx.fillStyle = '#e6e0d3';
    ctx.beginPath();
    ctx.arc(0, 0, w.radius, 0, Math.PI * 2);
    ctx.fill();
    for (const a of this.areaPaths) {
      ctx.fillStyle = a.color;
      ctx.fill(a.path, 'evenodd');
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of this.roadPaths) {
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(r.width, px);
      ctx.stroke(r.path);
    }
    if (this.layers.traffic && this.sim) {
      for (const [id, r] of this.sim.roadSpeed) {
        const road = this.roadById.get(id);
        if (!road) continue;
        ctx.strokeStyle = `#${trafficColor(r).getHexString()}`;
        ctx.lineWidth = Math.max(road.width * 0.8, 2 * px);
        ctx.stroke(road.path);
      }
    }
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeStyle = '#5b5450';
    ctx.lineWidth = Math.max(2.4, 1.5 * px);
    ctx.stroke(this.railPath);
    ctx.strokeStyle = this.layers.underground ? 'rgba(155,89,182,0.9)' : 'rgba(155,89,182,0.45)';
    ctx.lineWidth = Math.max(2.4, (this.layers.underground ? 2.5 : 1.2) * px);
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.stroke(this.subwayPath);
    ctx.setLineDash([]);
    for (const f of this.fills) {
      ctx.fillStyle = f.color;
      ctx.fill(f.path);
    }
    if (this.layers.trees && this.scale > 0.35) {
      ctx.fillStyle = 'rgba(79,122,69,0.85)';
      ctx.fill(this.treePath);
    }
    if (this.scale > 0.6) {
      ctx.strokeStyle = 'rgba(60,50,40,0.35)';
      ctx.lineWidth = px;
      for (const f of this.fills) ctx.stroke(f.path);
    }
    if (this.layers.transit && this.sim && this.region) {
      ctx.globalAlpha = 0.6;
      for (const l of this.sim.info.lines) {
        ctx.strokeStyle = hex(l.color);
        ctx.lineWidth = l.mode === 'metro' ? Math.max(4, 3 * px) : Math.max(l.generated ? 1.2 : 2, 2 * px);
        ctx.stroke(this.linePath(l.pts));
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = hex(this.region.busColor);
      for (const [x, y] of this.sim.info.stops) ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
  }

  private drawSelection(px: number) {
    const s = this.selected;
    const w = this.world!;
    const ctx = this.ctx;
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 3 * px;
    if (s?.type === 'building') {
      const b = w.buildings.find((x) => x.id === s.id);
      if (b) ctx.stroke(this.polyPath(b.footprint));
    } else if (s?.type === 'road') {
      const r = w.roads.find((x) => x.id === s.id);
      if (r) {
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = roadWidth(r) + 3;
        ctx.stroke(this.linePath(r.points));
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawAgents(px: number) {
    const ctx = this.ctx;
    const sim = this.sim!;
    for (const a of sim.agents) {
      const [wd, ln] = AGENT_SIZE[a.kind];
      const color = a.id === this.followId ? 0x00e5ff : a.kind === 'emergency' ? (Math.floor(performance.now() / 250) % 2 ? 0xff2020 : 0x2060ff) : a.kind === 'taxi' ? this.region!.taxiColor : a.kind === 'bus' ? this.region!.busColor : AGENT_COLORS[a.kind];
      ctx.fillStyle = hex(color);
      if (a.kind === 'pedestrian') {
        const r = Math.max(0.5, 1.6 * px);
        ctx.fillRect(a.x - r, a.y - r, 2 * r, 2 * r);
        continue;
      }
      const W = Math.max(wd, 2 * px);
      const L = Math.max(ln, 3 * px);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(Math.atan2(a.hy, a.hx) - Math.PI / 2);
      ctx.fillRect(-W / 2, -L / 2, W, L);
      ctx.restore();
    }
    ctx.fillStyle = '#c9ced6';
    for (const c of sim.trains) {
      if (c.underground && !this.layers.underground) continue;
      ctx.fillStyle = c.underground ? '#9b59b6' : '#c9ced6';
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(Math.atan2(c.hy, c.hx) - Math.PI / 2);
      ctx.fillRect(-1.5, -c.carLen / 2, 3, c.carLen);
      ctx.restore();
    }
  }

  private pick(p: Vec2, mode: 'all' | 'static' | 'ground'): Hit {
    const tol = 8 / this.scale;
    if (mode === 'ground') return { kind: 'ground', id: '', p };
    if (mode === 'all' && this.layers.agents && this.sim) {
      let best: number | null = null;
      let bd = tol;
      for (const a of this.sim.agents) {
        const d = Math.hypot(a.x - p[0], a.y - p[1]);
        if (d < bd) {
          bd = d;
          best = a.id;
        }
      }
      if (best !== null) return { kind: 'agent', id: best, p };
    }
    const w = this.world;
    if (w) {
      for (let i = w.buildings.length - 1; i >= 0; i--) {
        const b: Building = w.buildings[i];
        const bb = this.bbox.get(b.id);
        if (bb && p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3] && pointInPolygon(p, b.footprint)) return { kind: 'building', id: b.id, p };
      }
      let road: Road | null = null;
      let rd = Infinity;
      for (const r of w.roads) {
        if (r.tunnel) continue;
        for (let i = 1; i < r.points.length; i++) {
          const d = segDist(p, r.points[i - 1], r.points[i]);
          if (d < rd) {
            rd = d;
            road = r;
          }
        }
      }
      if (road && rd < Math.max(roadWidth(road) / 2, tol)) return { kind: 'road', id: road.id, p };
    }
    return { kind: 'ground', id: '', p };
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.down = this.pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : undefined;
    this.lastPinch = 0;
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    this.hover = this.toWorld(e.clientX, e.clientY);
    if (!prev) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.lastPinch) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.lastPinch);
      this.lastPinch = d;
      return;
    }
    if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 6) return;
    this.followId = null;
    this.cx -= (e.clientX - prev.x) / this.scale;
    this.cy += (e.clientY - prev.y) / this.scale;
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const d = this.down;
    this.down = undefined;
    if (!d || e.type === 'pointercancel' || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 500) return;
    const p = this.toWorld(e.clientX, e.clientY);
    this.tools.click(this.pick(p, pickMode(this.tools.tool)), this.world);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  };

  private zoomAt(sx: number, sy: number, f: number) {
    const before = this.toWorld(sx, sy);
    this.scale = Math.min(40, Math.max(0.05, this.scale * f));
    const after = this.toWorld(sx, sy);
    this.cx += before[0] - after[0];
    this.cy += before[1] - after[1];
  }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'enter' && (this.tools.tool === 'transit' || this.tools.tool === 'zone')) return this.finishDraft();
    if (k === 'escape') {
      this.tools.cancel();
      this.select(null);
    } else if (['w', 'a', 's', 'd', '=', '+', '-', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k);
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());

  private moveKeys(dt: number) {
    const k = this.keys;
    if (!k.size) return;
    const v = (400 / this.scale) * dt;
    if (k.has('w') || k.has('arrowup')) this.cy += v;
    if (k.has('s') || k.has('arrowdown')) this.cy -= v;
    if (k.has('a') || k.has('arrowleft')) this.cx -= v;
    if (k.has('d') || k.has('arrowright')) this.cx += v;
    if (k.has('=') || k.has('+')) this.scale *= 1 + dt;
    if (k.has('-')) this.scale /= 1 + dt;
  }
}

function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
