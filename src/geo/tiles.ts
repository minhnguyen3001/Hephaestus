import { fetchTile, TILE } from './osm';
import type { LatLon, WorldData } from './types';

/** Merge newly loaded map data into the world. Features crossing tile edges arrive twice: keep one. */
export function mergeWorld(a: WorldData, b: WorldData): WorldData {
  const byId = <T extends { id: string }>(x: T[], y: T[]) => {
    const seen = new Set(x.map((v) => v.id));
    return [...x, ...y.filter((v) => !seen.has(v.id))];
  };
  const signals = new Set(a.signalNodes);
  return {
    ...a,
    buildings: byId(a.buildings, b.buildings),
    roads: byId(a.roads, b.roads),
    rails: byId(a.rails, b.rails),
    areas: byId(a.areas, b.areas),
    signalNodes: [...a.signalNodes, ...b.signalNodes.filter((n) => !signals.has(n))],
    trees: [...(a.trees ?? []), ...(b.trees ?? [])],
    stations: [...(a.stations ?? []), ...(b.stations ?? []).filter((s) => !(a.stations ?? []).some((t) => s.name && t.name === s.name && Math.hypot(s.p[0] - t.p[0], s.p[1] - t.p[1]) < 50))],
  };
}

/** Half-size of the square covering all loaded tiles (the world "radius"). */
export function loadedRadius(keys: Iterable<string>, base: number): number {
  let r = base;
  for (const k of keys) {
    const [i, j] = k.split(',').map(Number);
    r = Math.max(r, (Math.max(Math.abs(i), Math.abs(j)) + 0.5) * TILE);
  }
  return r;
}

/**
 * Streams 1 km map tiles around wherever the user is looking, nearest first, within a tile budget.
 * The city grows as you explore; loaded tiles are cached by the browser for instant revisits.
 */
export class TileStream {
  readonly loaded = new Set<string>();
  private pending = new Set<string>();
  private failed = new Map<string, number>();
  private queue: [number, number][] = [];
  private active = 0;
  private ctrl = new AbortController();

  constructor(
    private center: LatLon,
    private budget: number,
    private onTile: (w: WorldData, key: string) => void,
    private onProgress: (loaded: number, pending: number, budget: number) => void,
    private concurrency = 2,
  ) {}

  /** Mark tiles already covered by the initial load (pack or radius query). */
  seed(keys: string[]) {
    for (const k of keys) this.loaded.add(k);
  }

  /** Ask for the tiles within `reach` tiles of the local point, nearest first. */
  want(x: number, y: number, reach = 1) {
    const ci = Math.round(x / TILE);
    const cj = Math.round(y / TILE);
    const cands: [number, number, number][] = [];
    for (let di = -reach; di <= reach; di++)
      for (let dj = -reach; dj <= reach; dj++) {
        const k = `${ci + di},${cj + dj}`;
        if (this.loaded.has(k) || this.pending.has(k) || (this.failed.get(k) ?? 0) >= 2) continue;
        cands.push([ci + di, cj + dj, Math.hypot((ci + di) * TILE - x, (cj + dj) * TILE - y)]);
      }
    cands.sort((a, b) => a[2] - b[2]);
    for (const [i, j] of cands) {
      if (this.loaded.size + this.pending.size >= this.budget) break;
      this.pending.add(`${i},${j}`);
      if (reach === 0) this.queue.unshift([i, j]); // an explicit request ("Load detail here") jumps the queue
      else this.queue.push([i, j]);
    }
    this.pump();
  }

  get atBudget() {
    return this.loaded.size >= this.budget;
  }

  private pump() {
    this.onProgress(this.loaded.size, this.pending.size, this.budget);
    while (this.active < this.concurrency && this.queue.length) {
      const [i, j] = this.queue.shift()!;
      const k = `${i},${j}`;
      this.active++;
      fetchTile(this.center, i, j, this.ctrl.signal)
        .then((w) => {
          this.loaded.add(k);
          this.onTile(w, k);
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') this.failed.set(k, (this.failed.get(k) ?? 0) + 1);
        })
        .finally(() => {
          this.pending.delete(k);
          this.active--;
          this.pump();
        });
    }
  }

  dispose() {
    this.ctrl.abort();
  }
}
