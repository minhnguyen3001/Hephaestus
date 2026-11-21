import { describe, expect, it } from 'vitest';
import { clipPolygon, clipPolyline, coastlineWater, joinWays } from './polygons';
import { pointInPolygon, signedArea } from './util';
import type { Vec2 } from './types';

describe('polygons', () => {
  it('joins fragments into a closed ring regardless of direction', () => {
    const rings = joinWays([[[0, 0], [10, 0]], [[10, 10], [10, 0]], [[10, 10], [0, 10], [0, 0]]]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
  });

  it('clips polygons and polylines to a square', () => {
    const big: Vec2[] = [[-50, -50], [50, -50], [50, 50], [-50, 50]];
    expect(Math.abs(signedArea(clipPolygon(big, 10)))).toBeCloseTo(400);
    const pieces = clipPolyline([[-20, 0], [20, 0], [20, 5], [-20, 5]], 10);
    expect(pieces).toHaveLength(2);
    expect(pieces[0][0]).toEqual([-10, 0]);
  });

  it('closes a coastline into sea on the right-hand side', () => {
    // Coast runs west→east along y=0: land on the left (north), sea on the right (south).
    const { water } = coastlineWater([[[-30, 0], [30, 0]]], 10);
    expect(water).toHaveLength(1);
    expect(Math.abs(signedArea(water[0]))).toBeCloseTo(200);
    expect(pointInPolygon([0, -5], water[0])).toBe(true);
    expect(pointInPolygon([0, 5], water[0])).toBe(false);
    // Reversed direction puts the sea in the north.
    const flipped = coastlineWater([[[30, 0], [-30, 0]]], 10).water[0];
    expect(pointInPolygon([0, 5], flipped)).toBe(true);
  });

  it('handles a bay crossing a corner and islands', () => {
    // Coastline enters on the west edge and leaves on the south edge; sea is the south-west corner.
    const { water } = coastlineWater([[[-20, 2], [2, 2], [2, -20]]], 10);
    expect(pointInPolygon([-8, -8], water[0])).toBe(true);
    expect(pointInPolygon([8, 8], water[0])).toBe(false);
    const island: Vec2[] = [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]];
    const r = coastlineWater([island], 10);
    expect(r.islands).toHaveLength(1);
    expect(r.water).toHaveLength(1); // whole box is sea around the island
  });

  it('trims polylines from both ends', async () => {
    const { trimLine } = await import('../render/geometry');
    expect(trimLine([[0, 0], [10, 0], [10, 10]], 2, 3)).toEqual([[2, 0], [10, 0], [10, 7]]);
    expect(trimLine([[0, 0], [5, 0]], 3, 3)).toBeNull();
  });

  it('reads event venues from OSM tags, estimating seats when unmapped', async () => {
    const { venueOf } = await import('./osm');
    const sq: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    expect(venueOf({ building: 'yes' }, sq)).toBeUndefined();
    expect(venueOf({ amenity: 'theatre', capacity: '1,450' }, sq)).toEqual({ kind: 'theatre', capacity: 1450, estimated: false });
    const st = venueOf({ building: 'stadium' }, sq)!;
    expect(st.kind).toBe('stadium');
    expect(st.estimated).toBe(true);
    expect(st.capacity).toBe(16000);
  });
});
