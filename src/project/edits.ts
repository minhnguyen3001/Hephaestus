import type { Building, BuildingUse, Road, WorldData } from '../geo/types';

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
        roads.set(e.road.id, e.road);
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
