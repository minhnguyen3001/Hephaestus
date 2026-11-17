import type { Vec2, WorldData } from '../geo/types';
import { decodeAgents, encodeFrame, infoOf, type AgentView, type Frame, type Info, type ToWorker } from './protocol';
import type { RegionProfile } from './region';
import { Simulation, type AgentInfo, type DayType, type SignalHead, type SimStats, type TrainCar, type TransitLineView } from './simulation';

/**
 * Runs the simulation off the main thread (Web Worker) when possible, inline otherwise.
 * The renderer only ever reads the latest frame, so a slow simulation can't stall rendering.
 */
export class SimClient {
  time: number;
  agents: AgentView[] = [];
  trains: TrainCar[] = [];
  stats: SimStats | null = null;
  info: { lines: TransitLineView[]; stops: Vec2[]; signals: SignalHead[] } = { lines: [], stops: [], signals: [] };
  /** Smoothed speed ratio per road id (1 = free flow), for the traffic layer. */
  roadSpeed = new Map<string, number>();
  private frameNo = 0;
  onInfo?: () => void;
  private worker: Worker | null = null;
  private inline: Simulation | null = null;
  private inflight = false;
  private pendingDt = 0;
  private watched: number | null = null;
  private watchedInfo: AgentInfo | null = null;

  constructor(world: WorldData, region: RegionProfile, maxAgents: number, seed = 1, time = 7.5 * 3600) {
    this.time = time;
    const plain = { ...world, terrain: undefined }; // terrain isn't needed by the simulation
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<Frame | Info | { t: 'error'; message: string }>) => {
          const m = e.data;
          if (m.t !== 'error') return this.receive(m);
          // Never leave the city frozen: report, then continue on the main thread.
          console.error('Simulation worker failed, continuing on the main thread:', m.message);
          this.dispose();
          this.startInline(plain, region, maxAgents, seed, this.time);
        };
        this.worker.onerror = (e) => {
          console.error('Simulation worker could not start:', e.message);
          this.dispose();
          this.startInline(plain, region, maxAgents, seed, this.time);
        };
        this.post({ t: 'init', world: plain, region, maxAgents, seed, time });
        this.inflight = true;
        return;
      } catch {
        this.worker = null;
      }
    }
    this.startInline(plain, region, maxAgents, seed, time);
  }

  private startInline(world: WorldData, region: RegionProfile, maxAgents: number, seed: number, time: number) {
    this.inline = new Simulation(world, region, maxAgents, seed);
    this.inline.time = time;
    this.inline.step(0);
    this.receive(infoOf(this.inline));
    this.receive(encodeFrame(this.inline, this.watched));
  }

  private post(m: ToWorker) {
    this.worker?.postMessage(m);
  }

  private receive(m: Frame | Info) {
    if (m.t === 'info') {
      this.info = { lines: m.lines, stops: m.stops, signals: m.signals };
      this.onInfo?.();
      return;
    }
    this.inflight = false;
    this.time = m.time;
    this.agents = decodeAgents(m.buf);
    this.trains = m.trains;
    this.stats = m.stats;
    this.watchedInfo = m.watched;
    if (m.speeds) {
      const seen = new Set(m.speeds.ids);
      m.speeds.ids.forEach((id, i) => this.roadSpeed.set(id, 0.6 * (this.roadSpeed.get(id) ?? m.speeds!.ratio[i]) + 0.4 * m.speeds!.ratio[i]));
      // roads that emptied drift back toward free flow
      for (const [id, v] of this.roadSpeed) if (!seen.has(id)) this.roadSpeed.set(id, v + (1 - v) * 0.2);
    }
  }

  /** Advance by dt simulated seconds. In worker mode, time accumulates while the previous step is in flight. */
  step(dt: number) {
    if (this.inline) {
      this.inline.step(dt);
      this.receive(encodeFrame(this.inline, this.watched, this.frameNo++ % 15 === 0));
      return;
    }
    this.pendingDt += dt;
    if (this.inflight || !this.worker) return;
    this.inflight = true;
    this.post({ t: 'step', dt: this.pendingDt });
    this.pendingDt = 0;
  }

  setTime(t: number) {
    this.time = t;
    if (this.inline) {
      this.inline.time = t;
      this.receive(encodeFrame(this.inline, this.watched));
    } else this.post({ t: 'time', time: t });
  }

  setParams(day: DayType, demandScale: number) {
    if (this.inline) {
      this.inline.day = day;
      this.inline.demandScale = demandScale;
    } else this.post({ t: 'params', day, demandScale });
  }

  watch(id: number | null) {
    this.watched = id;
    this.watchedInfo = null;
    this.post({ t: 'watch', id });
  }

  describe(id: number): AgentInfo | null {
    if (this.inline) return this.inline.describe(id);
    return this.watchedInfo?.id === id ? this.watchedInfo : null;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}
