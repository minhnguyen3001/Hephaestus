/// <reference lib="webworker" />
import type { WorldData } from '../geo/types';
import type { RegionProfile } from './region';
import { Simulation } from './simulation';
import { encodeFrame, infoOf, type ToWorker } from './protocol';

let sim: Simulation | null = null;
let watched: number | null = null;
let frames = 0;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    handle(e.data);
  } catch (err) {
    self.postMessage({ t: 'error', message: (err as Error)?.stack ?? String(err) });
  }
};

function handle(m: ToWorker) {
  if (m.t === 'init') {
    sim = new Simulation(m.world as WorldData, m.region as RegionProfile, m.maxAgents, m.seed);
    sim.time = m.time;
    sim.step(0);
    self.postMessage(infoOf(sim));
  } else if (!sim) return;
  else if (m.t === 'step') sim.step(m.dt);
  else if (m.t === 'time') sim.time = m.time;
  else if (m.t === 'watch') watched = m.id;
  else if (m.t === 'params') {
    sim.day = m.day;
    sim.demandScale = m.demandScale;
  }
  const frame = encodeFrame(sim, watched, frames++ % 15 === 0);
  self.postMessage(frame, [frame.buf.buffer]);
}
