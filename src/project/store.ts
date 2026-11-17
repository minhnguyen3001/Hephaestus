import type { Place } from '../geo/types';
import type { Edit } from './edits';

export interface Project {
  id: string;
  name: string;
  place: Place;
  radius: number;
  edits: Edit[];
  createdAt: string;
  updatedAt: string;
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

export function newProject(place: Place, radius: number): Project {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name: place.name, place, radius, edits: [], createdAt: now, updatedAt: now };
}
