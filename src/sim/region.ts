/**
 * Regional transport profiles. Mode shares are illustrative assumptions informed by published
 * modal-split figures, not calibrated data. They are shown to the user as assumptions.
 */
export type TravelMode = 'car' | 'taxi' | 'motorcycle' | 'bicycle' | 'bus' | 'walk';

export interface RegionProfile {
  id: string;
  label: string;
  driveSide: 'right' | 'left';
  modeShare: Record<TravelMode, number>;
  /** Motorcycles squeeze past cars in queues (lane filtering), common in Southeast Asia. */
  motorcycleFiltering: boolean;
  taxiColor: number;
  busColor: number;
  /** Assumed annual growth in travel demand (population + activity), for timeline projections. */
  growth: number;
}

const p = (id: string, label: string, driveSide: 'right' | 'left', s: Record<TravelMode, number>, extra: Partial<RegionProfile> = {}): RegionProfile => ({
  id, label, driveSide, modeShare: s, motorcycleFiltering: false, taxiColor: 0xf2c230, busColor: 0x2f6fd6, growth: 0.01, ...extra,
});

export const PROFILES: Record<string, RegionProfile> = {
  default: p('default', 'Generic city', 'right', { car: 0.4, taxi: 0.04, motorcycle: 0.04, bicycle: 0.06, bus: 0.16, walk: 0.3 }),
  us: p('us', 'United States', 'right', { car: 0.62, taxi: 0.06, motorcycle: 0.02, bicycle: 0.04, bus: 0.1, walk: 0.16 }, { busColor: 0x3b7dd8, growth: 0.007 }),
  vn: p('vn', 'Vietnam', 'right', { car: 0.08, taxi: 0.04, motorcycle: 0.7, bicycle: 0.03, bus: 0.05, walk: 0.1 }, { motorcycleFiltering: true, taxiColor: 0x2bb673, busColor: 0x2e9e4f, growth: 0.022 }),
  nl: p('nl', 'Netherlands', 'right', { car: 0.22, taxi: 0.02, motorcycle: 0.02, bicycle: 0.38, bus: 0.12, walk: 0.24 }, { taxiColor: 0x222222, busColor: 0xe0e0e0, growth: 0.005 }),
  jp: p('jp', 'Japan', 'left', { car: 0.14, taxi: 0.04, motorcycle: 0.03, bicycle: 0.14, bus: 0.15, walk: 0.5 }, { taxiColor: 0x2a3f8f, busColor: 0x2fa37a, growth: -0.002 }),
  gb: p('gb', 'United Kingdom', 'left', { car: 0.3, taxi: 0.06, motorcycle: 0.02, bicycle: 0.06, bus: 0.24, walk: 0.32 }, { taxiColor: 0x1c1c1c, busColor: 0xd7261e, growth: 0.006 }),
  th: p('th', 'Thailand', 'left', { car: 0.25, taxi: 0.07, motorcycle: 0.4, bicycle: 0.02, bus: 0.11, walk: 0.15 }, { motorcycleFiltering: true, taxiColor: 0xe0457b, growth: 0.012 }),
  id: p('id', 'Indonesia', 'left', { car: 0.18, taxi: 0.05, motorcycle: 0.58, bicycle: 0.02, bus: 0.07, walk: 0.1 }, { motorcycleFiltering: true, growth: 0.018 }),
  in: p('in', 'India', 'left', { car: 0.15, taxi: 0.08, motorcycle: 0.35, bicycle: 0.06, bus: 0.18, walk: 0.18 }, { motorcycleFiltering: true, growth: 0.02 }),
};

const LEFT_DRIVE = new Set(['gb', 'ie', 'jp', 'au', 'nz', 'in', 'th', 'my', 'sg', 'hk', 'id', 'za', 'ke', 'pk', 'bd', 'lk', 'mo', 'cy', 'mt', 'jm']);
const ALIASES: Record<string, string> = { ca: 'us', ph: 'th', my: 'th', kh: 'vn', la: 'vn', dk: 'nl', au: 'gb', nz: 'gb', ie: 'gb', sg: 'gb', hk: 'gb' };

export function profileFor(countryCode: string): RegionProfile {
  const cc = countryCode.toLowerCase();
  const base = PROFILES[cc] ?? PROFILES[ALIASES[cc]] ?? PROFILES.default;
  const driveSide = cc ? (LEFT_DRIVE.has(cc) ? 'left' : 'right') : base.driveSide;
  return { ...base, driveSide };
}
