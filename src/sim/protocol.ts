import type { Vec2 } from '../geo/types';
import { AGENT_KINDS, type AgentInfo, type AgentKind, type SimParams, type SignalHead, type SimStats, type Simulation, type TrainCar, type TransitLineView } from './simulation';

export type ToWorker =
  | { t: 'init'; world: unknown; region: unknown; maxAgents: number; seed: number; time: number }
  | { t: 'step'; dt: number }
  | { t: 'time'; time: number }
  | { t: 'watch'; id: number | null }
  | { t: 'params'; params: SimParams };

export interface Frame {
  t: 'frame';
  time: number;
  buf: Float32Array; // per agent: id, kind index, x, y, hx, hy
  trains: TrainCar[];
  stats: SimStats;
  watched: AgentInfo | null;
  speeds?: { ids: string[]; ratio: number[] };
}

export interface Info {
  t: 'info';
  lines: TransitLineView[];
  stops: Vec2[];
  signals: SignalHead[];
}

export const infoOf = (sim: Simulation): Info => ({ t: 'info', lines: sim.transitLines(), stops: sim.stopPositions(), signals: sim.signalApproaches() });

export interface AgentView {
  id: number;
  kind: AgentKind;
  x: number;
  y: number;
  hx: number;
  hy: number;
}

export const STRIDE = 6;

export function encodeFrame(sim: Simulation, watched: number | null, withSpeeds = false): Frame {
  const buf = new Float32Array(sim.agents.length * STRIDE);
  sim.agents.forEach((a, i) => {
    const o = i * STRIDE;
    buf[o] = a.id;
    buf[o + 1] = AGENT_KINDS.indexOf(a.kind);
    buf[o + 2] = a.x;
    buf[o + 3] = a.y;
    buf[o + 4] = a.hx;
    buf[o + 5] = a.hy;
  });
  return { t: 'frame', time: sim.time, buf, trains: sim.trainCars(), stats: sim.stats(), watched: watched === null ? null : sim.describe(watched), speeds: withSpeeds ? sim.roadSpeeds() : undefined };
}

export function decodeAgents(buf: Float32Array): AgentView[] {
  const out: AgentView[] = [];
  for (let o = 0; o < buf.length; o += STRIDE) {
    out.push({ id: buf[o], kind: AGENT_KINDS[buf[o + 1]], x: buf[o + 2], y: buf[o + 3], hx: buf[o + 4], hy: buf[o + 5] });
  }
  return out;
}
