import { describe, expect, it } from 'vitest';
import { decodePlan, encodePlan, type SharedPlan } from './share';
import { withScenarios, type Project } from './store';

describe('share links', () => {
  it('round-trips a plan through a compact URL-safe code', async () => {
    const plan: SharedPlan = {
      v: 1, name: 'Test', radius: 650,
      place: { name: 'Chicago', displayName: 'Chicago', lat: 41.8826, lon: -87.6278, countryCode: 'us' },
      edits: [{ kind: 'setHeight', id: 'w1', height: 123.456 }, { kind: 'demolish', id: 'w2' }],
      view: { center: [10.123, -5.987], scale: 1.5 },
    };
    const code = await encodePlan(plan);
    expect(code).toMatch(/^[zj][A-Za-z0-9_-]+$/);
    const back = await decodePlan(code);
    expect(back?.place.lat).toBe(41.8826); // place keeps full precision
    expect(back?.edits[0]).toEqual({ kind: 'setHeight', id: 'w1', height: 123.5 });
    expect(back?.view?.center).toEqual([10.1, -6]);
  });

  it('rejects garbage', async () => {
    expect(await decodePlan('zNOTVALID')).toBeNull();
    expect(await decodePlan('')).toBeNull();
  });

  it('migrates old projects to named scenarios', () => {
    const old = { id: 'p', name: 'x', place: {} as never, radius: 1, edits: [{ kind: 'demolish', id: 'a' }], createdAt: '', updatedAt: '' } as Project;
    const p = withScenarios(old);
    expect(p.scenarios).toHaveLength(1);
    expect(p.scenarios[0].edits).toHaveLength(1);
    expect(p.active).toBe('s1');
  });
});
