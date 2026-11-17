import type { Place } from '../geo/types';
import type { Edit } from './edits';

export interface Scenario {
  id: string;
  name: string;
  edits: Edit[];
}

/** Saved camera: 3D = orbit target + camera position (three.js coords); 2D = centre + scale. */
export interface SavedView {
  target?: [number, number, number];
  position?: [number, number, number];
  center?: [number, number];
  scale?: number;
}

export interface Project {
  id: string;
  name: string;
  place: Place;
  radius: number;
  /** Edits of the active scenario (kept for older saves and the project list). */
  edits: Edit[];
  scenarios?: Scenario[];
  active?: string;
  view3d?: SavedView;
  view2d?: SavedView;
  challenge?: string;
  createdAt: string;
  updatedAt: string;
}

/** Older projects had a single edit list; give every project at least one named scenario. */
export function withScenarios(p: Project): Project & { scenarios: Scenario[]; active: string } {
  const scenarios = p.scenarios?.length ? p.scenarios : [{ id: 's1', name: 'Proposal A', edits: p.edits ?? [] }];
  const active = scenarios.some((s) => s.id === p.active) ? p.active! : scenarios[0].id;
  return { ...p, scenarios, active };
}

/**
 * Local persistence. shortcut: localStorage (~5 MB) holds edits only, base map data lives in the
 * Cache API; move to the backend project service once accounts exist (Phase 5).
 */
const KEY = 'gcs.projects.v1';

export function listProjects(): Project[] {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Project[];
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function saveProject(p: Project): boolean {
  try {
    const rows = listProjects().filter((r) => r.id !== p.id);
    localStorage.setItem(KEY, JSON.stringify([{ ...p, updatedAt: new Date().toISOString() }, ...rows]));
    return true;
  } catch {
    return false;
  }
}

export function deleteProject(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listProjects().filter((r) => r.id !== id)));
  } catch {
    /* storage unavailable */
  }
}

export function newProject(place: Place, radius: number, edits: Edit[] = []): Project {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name: place.name, place, radius, edits, scenarios: [{ id: 's1', name: 'Proposal A', edits }], active: 's1', createdAt: now, updatedAt: now };
}
