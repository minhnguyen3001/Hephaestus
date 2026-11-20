import type { ContextTile } from './vectortiles';
import type { LatLon, WorldData } from './types';
import type { parseOverpass } from './osm';

export type OffThreadJob =
  | { kind: 'overpass'; buf: ArrayBuffer; center: LatLon; radius: number; bounds?: Parameters<typeof parseOverpass>[3]; tag?: string }
  | { kind: 'mvt'; buf: ArrayBuffer; center: LatLon; x: number; y: number };

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, { ok: (r: unknown) => void; fail: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; r?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (e.data.error) p?.fail(new Error(e.data.error));
      else p?.ok(e.data.r);
    };
    worker.onerror = () => {
      // worker unavailable: fail what's in flight (callers retry) and parse inline from now on
      worker = null;
      for (const p of pending.values()) p.fail(new Error('parse worker failed'));
      pending.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Run a parse in the background worker (the buffer is transferred), or inline where workers aren't available. */
export function offThread(job: Extract<OffThreadJob, { kind: 'overpass' }>, inline: () => WorldData): Promise<WorldData>;
export function offThread(job: Extract<OffThreadJob, { kind: 'mvt' }>, inline: () => ContextTile): Promise<ContextTile>;
export function offThread(job: OffThreadJob, inline: () => unknown): Promise<unknown> {
  const w = getWorker();
  if (!w) return Promise.resolve().then(inline);
  return new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    w.postMessage({ id, job }, [job.buf]);
  });
}
