import type { SimStats } from '../sim/simulation';
import type { CityMetrics } from './metrics';

export interface Goal {
  label: string;
  /** Current value, target and whether it's met. */
  check: (p: CityMetrics, o: CityMetrics, s: SimStats | null) => { value: string; met: boolean };
}

export interface Challenge {
  id: string;
  title: string;
  brief: string;
  goals: Goal[];
  /** Countries (ISO codes) or place-name fragments this is suggested for; empty = anywhere. */
  suggestFor?: string[];
}

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '…');

export const CHALLENGES: Challenge[] = [
  {
    id: 'housing',
    title: 'Housing boom',
    brief: 'Grow housing capacity by 20% without losing green space.',
    goals: [
      { label: 'Housing +20%', check: (p, o) => ({ value: `${pct(p.residents / Math.max(1, o.residents) - 1)}`, met: p.residents >= o.residents * 1.2 }) },
      { label: 'Green space ≥ today', check: (p, o) => ({ value: `${p.greenHa.toFixed(1)} ha`, met: p.greenHa >= o.greenHa - 0.05 }) },
    ],
    suggestFor: ['Manhattan', 'London'],
  },
  {
    id: 'transit',
    title: 'Transit for all',
    brief: 'Put 70% of residents within 400 m of a transit stop. Draw bus or metro lines where people live.',
    goals: [
      { label: 'Near transit ≥ 70%', check: (p) => ({ value: pct(p.transitAccess), met: p.transitAccess >= 0.7 }) },
      { label: 'Riders boarding', check: (_p, _o, s) => ({ value: `${s?.busRiders ?? 0}`, met: (s?.busRiders ?? 0) >= 50 }) },
    ],
    suggestFor: ['vn', 'Saigon', 'id', 'th'],
  },
  {
    id: 'green',
    title: 'Green neighbourhoods',
    brief: 'Put 60% of residents within 300 m of a park. Zone new parks where they’re missing.',
    goals: [{ label: 'Near a park ≥ 60%', check: (p) => ({ value: pct(p.parkAccess), met: p.parkAccess >= 0.6 }) }],
  },
  {
    id: 'unjam',
    title: 'Unjam the streets',
    brief: 'Get congested vehicles below 20% during the morning rush (set the clock to 08:00). Try transit, new links or pedestrian streets.',
    goals: [
      {
        label: 'Congestion < 20% at rush hour',
        check: (_p, _o, s) => {
          const rush = s ? s.time >= 7 * 3600 && s.time <= 9.5 * 3600 : false;
          return { value: s ? `${pct(s.congestion)}${rush ? '' : ' (not rush hour)'}` : '–', met: !!s && rush && s.congestion < 0.2 };
        },
      },
    ],
    suggestFor: ['Chicago', 'us'],
  },
  {
    id: 'jobs-homes',
    title: 'Live near work',
    brief: 'Balance the district: at least one home per two jobs, with more housing than today.',
    goals: [
      { label: 'Homes ≥ 0.5 × jobs', check: (p) => ({ value: (p.residents / Math.max(1, p.jobs)).toFixed(2), met: p.residents >= p.jobs * 0.5 }) },
      { label: 'Housing above today', check: (p, o) => ({ value: `${pct(p.residents / Math.max(1, o.residents) - 1)}`, met: p.residents > o.residents }) },
    ],
  },
];

export function evaluate(c: Challenge, p: CityMetrics, o: CityMetrics, s: SimStats | null) {
  const results = c.goals.map((g) => ({ label: g.label, ...g.check(p, o, s) }));
  return { results, done: results.every((r) => r.met) };
}

export function suggested(placeName: string, countryCode: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.suggestFor?.some((k) => k === countryCode || placeName.includes(k)));
}
