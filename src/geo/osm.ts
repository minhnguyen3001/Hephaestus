import type { Area, Building, BuildingUse, LatLon, Rail, RailKind, Road, RoadKind, WorldData } from './types';
import { hash01, makeProjection, signedArea } from './util';

/**
 * OpenStreetMap provider (via Overpass API). Data © OpenStreetMap contributors, ODbL.
 * shortcut: uses the public Overpass endpoint, which is fine for development but not production
 * traffic; swap for a self-hosted Overpass or a preprocessed tile pipeline before launch (see docs/decisions.md).
 */
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export function buildOverpassQuery(c: LatLon, radius: number): string {
  const a = `(around:${Math.round(radius)},${c.lat.toFixed(6)},${c.lon.toFixed(6)})`;
  return `[out:json][timeout:40];
(
  way["building"]${a};
  way["highway"]${a};
  way["natural"="water"]${a};
  way["waterway"="riverbank"]${a};
  way["landuse"~"^(reservoir|basin|grass|forest|recreation_ground|meadow|village_green)$"]${a};
  way["leisure"~"^(park|garden|pitch|playground)$"]${a};
  way["natural"="wood"]${a};
  way["railway"~"^(rail|subway|tram|light_rail)$"]${a};
  node["highway"="traffic_signals"]${a};
);
out geom;`;
}

interface OsmElement {
  type: 'way' | 'node' | 'relation';
  id: number;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

const ROAD_KINDS: Record<string, RoadKind> = {
  motorway: 'highway',
  motorway_link: 'highway',
  trunk: 'highway',
  trunk_link: 'highway',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'residential',
  unclassified: 'residential',
  living_street: 'residential',
  service: 'service',
  pedestrian: 'footway',
  footway: 'footway',
  path: 'footway',
  steps: 'footway',
  cycleway: 'cycleway',
};

const DEFAULT_LANES: Record<RoadKind, number> = {
  highway: 4,
  primary: 4,
  secondary: 2,
  tertiary: 2,
  residential: 2,
  service: 1,
  footway: 1,
  cycleway: 1,
};

const DEFAULT_SPEED: Record<RoadKind, number> = {
  highway: 90,
  primary: 50,
  secondary: 50,
  tertiary: 40,
  residential: 30,
  service: 15,
  footway: 5,
  cycleway: 18,
};

export function classifyUse(tags: Record<string, string>): { use: BuildingUse; source: 'osm' | 'estimated' } {
  const b = tags.building;
  const amenity = tags.amenity ?? '';
  const map: Record<string, BuildingUse> = {
    apartments: 'residential', house: 'residential', residential: 'residential', detached: 'residential',
    semidetached_house: 'residential', terrace: 'residential', dormitory: 'residential', bungalow: 'residential',
    commercial: 'commercial', retail: 'commercial', supermarket: 'commercial', kiosk: 'commercial', hotel: 'commercial',
    office: 'office',
    industrial: 'industrial', warehouse: 'industrial', factory: 'industrial', manufacture: 'industrial',
    school: 'education', university: 'education', college: 'education', kindergarten: 'education',
    hospital: 'health', clinic: 'health',
    civic: 'civic', public: 'civic', government: 'civic', train_station: 'civic', transportation: 'civic', fire_station: 'civic',
    church: 'religious', cathedral: 'religious', mosque: 'religious', temple: 'religious', synagogue: 'religious', chapel: 'religious',
    parking: 'parking', garage: 'parking', garages: 'parking',
  };
  if (map[b]) return { use: map[b], source: 'osm' };
  if (['school', 'university', 'college', 'kindergarten'].includes(amenity)) return { use: 'education', source: 'osm' };
  if (['hospital', 'clinic'].includes(amenity)) return { use: 'health', source: 'osm' };
  if (amenity === 'place_of_worship') return { use: 'religious', source: 'osm' };
  if (amenity === 'parking') return { use: 'parking', source: 'osm' };
  if (tags.shop || ['restaurant', 'cafe', 'bar', 'fast_food', 'bank'].includes(amenity)) return { use: 'commercial', source: 'osm' };
  if (tags.office) return { use: 'office', source: 'osm' };
  return { use: 'unknown', source: 'estimated' };
}

const BASE_HEIGHT: Record<BuildingUse, number> = {
  residential: 11, commercial: 13, office: 28, industrial: 9, education: 13, health: 18,
  civic: 14, religious: 16, parking: 10, unknown: 10,
};

export function parseHeight(tags: Record<string, string>, use: BuildingUse, id: string) {
  const h = parseFloat(tags.height ?? '');
  if (Number.isFinite(h) && h > 0) return { height: h, source: 'osm-height' as const };
  const lv = parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(lv) && lv > 0) return { height: lv * 3.2 + 1, source: 'osm-levels' as const };
  const smallHouse = ['house', 'detached', 'bungalow', 'garage', 'shed', 'hut'].includes(tags.building);
  const base = smallHouse ? 7 : BASE_HEIGHT[use];
  return { height: base * (0.75 + hash01(id) * 0.6), source: 'estimated' as const };
}

function parseSpeed(v: string | undefined, kind: RoadKind): number {
  const n = parseFloat(v ?? '');
  if (!Number.isFinite(n)) return DEFAULT_SPEED[kind];
  return v!.includes('mph') ? n * 1.609 : n;
}

export function parseOverpass(json: { elements: OsmElement[] }, center: LatLon, radius: number): WorldData {
  const proj = makeProjection(center);
  const buildings: Building[] = [];
  const roads: Road[] = [];
  const areas: Area[] = [];
  const rails: Rail[] = [];
  const signalNodes: string[] = [];

  for (const el of json.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node') {
      if (tags.highway === 'traffic_signals') signalNodes.push(`n${el.id}`);
      continue;
    }
    if (el.type !== 'way' || !el.geometry || !el.nodes || el.geometry.length < 2) continue;
    const pts = el.geometry.map((g) => proj.toLocal(g.lat, g.lon));
    const nodeIds = el.nodes.map((n) => `n${n}`);
    const closed = el.nodes.length >= 4 && el.nodes[0] === el.nodes[el.nodes.length - 1];
    const id = `w${el.id}`;

    if (tags.building && tags.building !== 'no') {
      if (!closed) continue;
      const footprint = pts.slice(0, -1);
      if (Math.abs(signedArea(footprint)) < 6) continue;
      const { use, source } = classifyUse(tags);
      const { height, source: heightSource } = parseHeight(tags, use, id);
      buildings.push({ id, footprint, height, heightSource, use, useSource: source, name: tags.name, origin: 'real' });
      continue;
    }

    const kind = tags.highway ? ROAD_KINDS[tags.highway] : undefined;
    if (kind) {
      if (tags.area === 'yes') continue;
      let points = pts;
      let nodes = nodeIds;
      const ow = tags.oneway;
      if (ow === '-1') {
        points = [...pts].reverse();
        nodes = [...nodeIds].reverse();
      }
      const oneway = ow === 'yes' || ow === '1' || ow === 'true' || ow === '-1' || tags.junction === 'roundabout' || tags.highway === 'motorway';
      const lanes = Math.max(1, parseInt(tags.lanes ?? '', 10) || DEFAULT_LANES[kind] / (oneway && DEFAULT_LANES[kind] > 1 ? 2 : 1));
      roads.push({
        id, nodes, points, kind, lanes, oneway,
        maxspeedKmh: parseSpeed(tags.maxspeed, kind),
        name: tags.name,
        bridge: tags.bridge !== undefined && tags.bridge !== 'no',
        tunnel: tags.tunnel !== undefined && tags.tunnel !== 'no',
        origin: 'real',
      });
      continue;
    }

    const isWater = tags.natural === 'water' || tags.waterway === 'riverbank' || ['reservoir', 'basin'].includes(tags.landuse);
    const isPark = !!tags.leisure || ['grass', 'forest', 'recreation_ground', 'meadow', 'village_green'].includes(tags.landuse) || tags.natural === 'wood';
    if ((isWater || isPark) && closed) {
      areas.push({ id, kind: isWater ? 'water' : 'park', polygon: pts.slice(0, -1) });
      continue;
    }

    if (tags.railway && ['rail', 'subway', 'tram', 'light_rail'].includes(tags.railway)) {
      const layer = parseInt(tags.layer ?? '0', 10) || 0;
      const elevated = (tags.bridge !== undefined && tags.bridge !== 'no') || layer > 0;
      const tunnel = (tags.tunnel !== undefined && tags.tunnel !== 'no') || layer < 0 || (tags.railway === 'subway' && !elevated);
      rails.push({ id, nodes: nodeIds, points: pts, kind: tags.railway as RailKind, elevated, tunnel });
    }
  }

  return {
    center, radius, buildings, roads, areas, rails, signalNodes,
    fetchedAt: new Date().toISOString(),
    source: 'OpenStreetMap (Overpass API)',
  };
}

/** Fetch the world for a location. Responses are cached with the Cache API so revisits are instant and offline-friendly. */
export async function fetchWorld(center: LatLon, radius: number, signal?: AbortSignal): Promise<WorldData> {
  const query = encodeURIComponent(buildOverpassQuery(center, radius));
  const key = `${OVERPASS_MIRRORS[0]}?data=${query}`; // cache key independent of which mirror answered
  const cache = typeof caches !== 'undefined' ? await caches.open('gcs-osm-v1').catch(() => null) : null;
  let res = cache ? await cache.match(key) : undefined;
  let lastError = '';
  for (const mirror of OVERPASS_MIRRORS) {
    if (res) break;
    try {
      const r = await fetch(`${mirror}?data=${query}`, { signal });
      if (r.ok) {
        res = r;
        await cache?.put(key, r.clone()).catch(() => undefined);
      } else lastError = `Map data servers are busy (${r.status}).`;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      lastError = 'Could not reach the map data servers.';
    }
  }
  if (!res) throw new Error(`${lastError} Try again in a moment.`);
  return parseOverpass(await res.json(), center, radius);
}
