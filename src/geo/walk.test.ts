import { describe, expect, it } from 'vitest';
import type { Road } from './types';
import { walkReach } from './walk';

const road = (id: string, nodes: string[], points: [number, number][]): Road =>
  ({ id, nodes, points, kind: 'residential', lanes: 2, oneway: false, maxspeedKmh: 30, bridge: false, tunnel: false }) as unknown as Road;

describe('walkReach', () => {
  // two streets 150 m apart (a river between them), joined only by a bridge 1 km east
  const roads = [
    road('north', ['n0', 'n1'], [[0, 150], [1000, 150]]),
    road('south', ['s0', 's1'], [[0, 0], [1000, 0]]),
    road('bridge', ['n1', 's1'], [[1000, 150], [1000, 0]]),
  ];
  it('walks along streets, not across the river', () => {
    const near = walkReach(roads, [[100, 150]], 400);
    expect(near([300, 160])).toBe(true); // same street, 200 m along
    expect(near([100, 10])).toBe(false); // 150 m straight across, but ~2 km to walk via the bridge
  });
  it('counts the walk to the street', () => {
    const near = walkReach(roads, [[0, 0]], 400);
    expect(near([300, 40])).toBe(true); // 300 m along + 40 m off
    expect(near([380, 60])).toBe(false); // 380 + 60 > 400
  });
});
