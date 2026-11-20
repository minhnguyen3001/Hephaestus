export type Quality = 'low' | 'medium' | 'high';
export type QualitySetting = Quality | 'auto';

export interface Preset {
  pixelRatio: number;
  shadows: boolean;
  shadowSize: number;
  maxAgents: number;
  radius: number; // meters of map data loaded around the location at first
  tiles: number; // max extra 1 km² tiles streamed in as the user explores
  ring: number; // city-ring radius in metres (lightweight context buildings)
}

export const PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 0.85, shadows: false, shadowSize: 0, maxAgents: 450, radius: 450, tiles: 12, ring: 3000 },
  medium: { pixelRatio: 1.25, shadows: true, shadowSize: 1024, maxAgents: 1300, radius: 650, tiles: 30, ring: 4000 },
  high: { pixelRatio: 2, shadows: true, shadowSize: 2048, maxAgents: 3000, radius: 850, tiles: 60, ring: 5000 },
};

/** Initial guess from device hints; the engine then adapts to measured frame rate. */
export function detectQuality(): Quality {
  if (typeof navigator === 'undefined') return 'medium';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (nav.maxTouchPoints > 1 && /Mac/.test(nav.userAgent));
  const cores = nav.hardwareConcurrency ?? 4;
  const mem = nav.deviceMemory ?? 8;
  if (cores <= 4 || mem <= 4) return 'low';
  if (mobile) return 'medium';
  return cores >= 8 && mem >= 8 ? 'high' : 'medium';
}

export function resolveQuality(q: QualitySetting): Quality {
  return q === 'auto' ? detectQuality() : q;
}
