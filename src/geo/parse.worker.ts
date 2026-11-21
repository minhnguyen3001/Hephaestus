/// <reference lib="webworker" />
// Parses streamed map data off the main thread, so a tile arriving never stutters the camera.
import { parseOverpass } from './osm';
import { decodeContextTile } from './vectortiles';
import { computeAccess } from '../ui/metrics';
import type { OffThreadJob } from './offthread';

self.onmessage = (e: MessageEvent<{ id: number; job: OffThreadJob }>) => {
  const { id, job } = e.data;
  try {
    const r =
      job.kind === 'overpass'
        ? parseOverpass({ elements: JSON.parse(new TextDecoder().decode(job.buf)) }, job.center, job.radius, job.bounds, job.tag)
        : job.kind === 'access'
          ? computeAccess(job.job)
          : decodeContextTile(new Uint8Array(job.buf), job.center, job.x, job.y);
    self.postMessage({ id, r });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
