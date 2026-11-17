import type { Vec2, WorldData } from '../geo/types';
import { dist } from '../geo/util';
import type { Edit } from '../project/edits';

export type Tool = 'select' | 'build' | 'road' | 'bulldoze';

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
};

/** What a click should be able to hit for each tool (only Select can pick people and vehicles). */
export const pickMode = (t: Tool): 'all' | 'static' | 'ground' => (t === 'road' ? 'ground' : t === 'select' ? 'all' : 'static');

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
}

/** Planning-tool behaviour shared by the 3D engine and the 2D plan view. */
export class ToolController {
  tool: Tool = 'select';
  roadStart?: { p: Vec2; node?: string };

  constructor(private host: ToolHost) {}

  set(t: Tool) {
    this.tool = t;
    this.cancel();
    this.host.onHint(TOOL_HINTS[t]);
  }

  cancel() {
    this.roadStart = undefined;
    this.host.clearPreview();
  }

  click(hit: Hit, world: WorldData | undefined) {
    const h = this.host;
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
