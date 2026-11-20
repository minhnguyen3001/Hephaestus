import type { Vec2, WorldData } from '../geo/types';
import { dist } from '../geo/util';
import type { Edit } from '../project/edits';
import type { Density, ZoneUse } from '../project/zoning';

export type Tool = 'select' | 'build' | 'road' | 'bulldoze' | 'transit' | 'zone' | 'note' | 'event';

export interface Hit {
  kind: 'agent' | 'building' | 'road' | 'ground';
  id: string | number;
  p: Vec2;
}

export const TOOL_HINTS: Record<Tool, string | null> = {
  select: null,
  build: 'Click on open ground to place a new building.',
  road: 'Click a start point, then an end point. Ends snap to nearby intersections.',
  bulldoze: 'Click a building or road to remove it from the proposal.',
  transit: 'Click to place stops in order, then press Finish (or Enter). Bus stops snap to streets.',
  zone: 'Click the corners of an area, then Finish (or Enter). It fills with buildings of the chosen use.',
  note: 'Click anywhere to pin a note to the plan. Notes travel with share links.',
  event: 'Click where a concert or game happens. Crowds arrive over the next 90 minutes and leave afterwards.',
};

export interface ZoneOptions {
  use: ZoneUse;
  density: Density;
  replace: boolean;
}

/** What a click should be able to hit for each tool (only Select can pick people and vehicles). */
export const pickMode = (t: Tool): 'all' | 'static' | 'ground' => (t === 'road' || t === 'transit' || t === 'zone' || t === 'note' || t === 'event' ? 'ground' : t === 'select' ? 'all' : 'static');

export function snapNode(world: WorldData | undefined, p: Vec2, radius = 25): { p: Vec2; node?: string } {
  let best: { p: Vec2; node?: string } = { p };
  let bd = radius;
  for (const r of world?.roads ?? []) {
    if (r.kind === 'footway' || r.kind === 'cycleway') continue;
    r.points.forEach((q, i) => {
      const d = dist(q, p);
      if (d < bd) {
        bd = d;
        best = { p: q, node: r.nodes[i] };
      }
    });
  }
  return best;
}

export interface ToolHost {
  onEdit(e: Edit): void;
  onHint(msg: string | null): void;
  select(sel: { type: 'building' | 'road' | 'agent'; id: string | number } | null): void;
  follow(id: number): void;
  /** The tool just created something the host should select once the world updates. */
  preselect(sel: { type: 'building'; id: string }): void;
  clearPreview(): void;
  drawDraft(): void;
  placeEvent(p: Vec2): void;
}

const LINE_COLORS = [0xe5484d, 0x8e44ad, 0x16a085, 0xf39c12, 0x2980b9, 0xd35400, 0x27ae60];

/** Planning-tool behaviour shared by the 3D engine and the 2D plan view. */
export class ToolController {
  tool: Tool = 'select';
  roadStart?: { p: Vec2; node?: string };
  lineMode: 'bus' | 'metro' = 'bus';
  zone: ZoneOptions = { use: 'mixed', density: 'medium', replace: false };
  draft: Vec2[] = [];

  constructor(private host: ToolHost) {}

  set(t: Tool) {
    this.tool = t;
    this.cancel();
    this.host.onHint(TOOL_HINTS[t]);
  }

  cancel() {
    this.roadStart = undefined;
    this.host.clearPreview();
    if (this.draft.length) {
      this.draft = [];
      this.host.drawDraft();
    }
  }

  /** Complete the current multi-click drawing (transit line or zone). */
  finish(world: WorldData | undefined) {
    if (this.tool === 'zone') return this.finishZone();
    if (this.tool === 'transit') return this.finishLine(world);
  }

  private finishZone() {
    if (this.draft.length < 3) return this.host.onHint('A zone needs at least three corners.');
    const z = this.zone;
    this.host.onEdit({ kind: 'zone', zone: { id: `u-z-${Date.now().toString(36)}`, polygon: this.draft, use: z.use, density: z.density, replace: z.use === 'park' || z.replace } });
    this.draft = [];
    this.host.drawDraft();
    this.host.onHint(z.use === 'park' ? 'Park created. Check green space in the dashboard.' : `Zoned for ${z.use} at ${z.density} density — see housing and jobs change.`);
  }

  private finishLine(world: WorldData | undefined) {
    if (this.draft.length < 2) return this.host.onHint('A line needs at least two stops.');
    const n = world?.transitLines?.length ?? 0;
    const label = this.lineMode === 'bus' ? 'Bus' : 'Metro';
    this.host.onEdit({
      kind: 'addLine',
      line: {
        id: `u-l-${Date.now().toString(36)}`, name: `${label} ${String.fromCharCode(65 + (n % 26))}`, mode: this.lineMode,
        stops: this.draft, color: LINE_COLORS[n % LINE_COLORS.length],
      },
    });
    this.draft = [];
    this.host.drawDraft();
    this.host.onHint(`${label} line added — watch its riders in the dashboard. Click to start another.`);
  }

  click(hit: Hit, world: WorldData | undefined) {
    const h = this.host;
    if (this.tool !== 'select' && typeof hit.id === 'string' && hit.id.startsWith('ring:')) {
      return h.onHint('That area shows overview data. Select a building there and choose “Load detail here” to edit it.');
    }
    if (this.tool === 'select') {
      if (hit.kind === 'ground') return h.select(null);
      h.select({ type: hit.kind, id: hit.id });
      if (hit.kind === 'agent') h.follow(hit.id as number);
    } else if (this.tool === 'bulldoze') {
      if (hit.kind === 'building') h.onEdit({ kind: 'demolish', id: hit.id as string });
      else if (hit.kind === 'road') h.onEdit({ kind: 'removeRoad', id: hit.id as string });
    } else if (this.tool === 'build') {
      if (hit.kind !== 'ground' && hit.kind !== 'road') return h.onHint('That spot is occupied — click open ground.');
      const s = 12;
      const [x, y] = hit.p;
      const id = `u-b-${Date.now().toString(36)}`;
      h.preselect({ type: 'building', id });
      h.onEdit({
        kind: 'addBuilding',
        building: {
          id, footprint: [[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]], height: 36,
          heightSource: 'user', use: 'residential', useSource: 'user', origin: 'proposed', name: 'Proposed building',
        },
      });
    } else if (this.tool === 'event') {
      h.placeEvent(hit.p);
    } else if (this.tool === 'note') {
      const text = typeof window !== 'undefined' ? window.prompt('Note for this spot:')?.trim() : '';
      if (text) h.onEdit({ kind: 'addNote', note: { id: `u-n-${Date.now().toString(36)}`, p: hit.p, text: text.slice(0, 280) } });
    } else if (this.tool === 'zone') {
      this.draft = [...this.draft, hit.p];
      h.drawDraft();
      h.onHint(`${this.draft.length} corner${this.draft.length === 1 ? '' : 's'} — keep clicking, then Finish (Enter).`);
    } else if (this.tool === 'transit') {
      let p = hit.p;
      if (this.lineMode === 'bus') {
        const snap = snapNode(world, p, 40);
        if (!snap.node) return h.onHint('Bus stops must be on or next to a street.');
        p = snap.p;
      }
      this.draft = [...this.draft, p];
      h.drawDraft();
      h.onHint(`${this.draft.length} stop${this.draft.length === 1 ? '' : 's'} — keep clicking, then Finish (Enter).`);
    } else if (this.tool === 'road') {
      const snap = snapNode(world, hit.p);
      if (!this.roadStart) {
        this.roadStart = snap;
        return h.onHint('Now click the end point (Esc to cancel).');
      }
      const start = this.roadStart;
      this.cancel();
      if (dist(start.p, snap.p) < 5) return h.onHint('Road too short — try again.');
      const stamp = Date.now().toString(36);
      h.onEdit({
        kind: 'addRoad',
        road: {
          id: `u-r-${stamp}`, nodes: [start.node ?? `u-n-${stamp}-a`, snap.node ?? `u-n-${stamp}-b`], points: [start.p, snap.p],
          kind: 'tertiary', lanes: 2, oneway: false, maxspeedKmh: 40, name: 'Proposed street', origin: 'proposed',
        },
      });
      h.onHint('Road added. Click to start another, or switch tools.');
    }
  }
}
