import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contextTileKeys, decodeContextTile } from './vectortiles';

const C = { lat: 41.8826, lon: -87.6278 };

describe('city ring (vector tiles)', () => {
  it('covers a 10 km diameter with z14 tiles, nearest first', () => {
    const keys = contextTileKeys(C);
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.length).toBeLessThan(60);
    expect(keys[0].d).toBeLessThan(keys[keys.length - 1].d);
  });

  it('decodes buildings, roads, water and parks into local metres', () => {
    const t = decodeContextTile(new Uint8Array(readFileSync('src/geo/fixtures/chicago-loop-z14.pbf')), C, 4203, 6089);
    expect(t.buildings.length).toBeGreaterThan(500);
    expect(t.roads.length).toBeGreaterThan(200);
    expect(t.water.length).toBeGreaterThan(0);
    // the tile is near the origin: geometry within a few km
    for (const b of t.buildings.slice(0, 50)) expect(Math.hypot(b.ring[0][0], b.ring[0][1])).toBeLessThan(4000);
    expect(Math.max(...t.buildings.map((b) => b.height))).toBeGreaterThan(150); // Loop skyscrapers
  });
});
