import type { Area, Building, Vec2, BuildingUse, LatLon, Rail, RailKind, Road, RoadKind, WorldData } from './types';
import { clipPolygon, coastlineWater, isClosed, joinWays } from './polygons';
import { hash01, makeProjection, pointInPolygon, signedArea } from './util';

/**
 * OpenStreetMap provider (via Overpass API). Data © OpenStreetMap contributors, ODbL.
 * shortcut: uses the public Overpass endpoint, which is fine for development but not production
 * traffic; swap for a self-hosted Overpass or a preprocessed tile pipeline before launch (see docs/decisions.md).
 */
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** 'core' = what the city needs to be playable; 'extras' = water/parks/coastline, loaded afterwards. */
export type QueryPart = 'core' | 'extras' | 'stations';

export function buildOverpassQuery(c: LatLon, radius: number, part: QueryPart = 'core'): string {
  const ll = `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
  const a = `(around:${Math.round(radius)},${ll})`;
  if (part === 'stations') {
    return `[out:json][timeout:25];
(
  node["railway"~"^(station|halt)$"]${a};
  node["public_transport"="station"]["station"]${a};
);
out;`;
  }
  if (part === 'core') {
    return `[out:json][timeout:30];
(
  way["building"]${a};
  way["highway"]${a};
  way["railway"~"^(rail|subway|tram|light_rail)$"]${a};
  relation["type"="multipolygon"]["building"]${a}(if:count_members() < 200);
  node["highway"="traffic_signals"]${a};
);
out geom;`;
  }
  return `[out:json][timeout:30];
(
  way["natural"="water"]${a};
  way["waterway"="riverbank"]${a};
  way["landuse"~"^(reservoir|basin|grass|forest|recreation_ground|meadow|village_green)$"]${a};
  way["leisure"~"^(park|garden|pitch|playground)$"]${a};
  way["natural"="wood"]${a};
  way["natural"="coastline"](around:${Math.round(radius * 2)},${ll});
  node["natural"="tree"]${a};
  relation["type"="multipolygon"]["natural"~"^(water|wood)$"]${a}(if:count_members() < 500);
  relation["type"="multipolygon"]["waterway"="riverbank"]${a}(if:count_members() < 500);
  relation["type"="multipolygon"]["leisure"~"^(park|garden)$"]${a}(if:count_members() < 500);
  relation["type"="multipolygon"]["landuse"~"^(grass|forest|recreation_ground|reservoir|basin)$"]${a}(if:count_members() < 500);
);
out geom;`;
}

interface OsmElement {
  type: 'way' | 'node' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
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
  const trees: Vec2[] = [];
  const stations: { p: Vec2; name?: string }[] = [];
  const coast: Vec2[][] = [];
  const E = radius * 1.3; // everything area-like is clipped to this square (matches the terrain extent)

  const pushArea = (id: string, kind: 'water' | 'park', outer: Vec2[], holes: Vec2[][] = []) => {
    const polygon = clipPolygon(outer, E);
    if (polygon.length < 3 || Math.abs(signedArea(polygon)) < 20) return;
    const hs = holes.map((h) => clipPolygon(h, E)).filter((h) => h.length >= 3);
    areas.push({ id, kind, polygon, holes: hs.length ? hs : undefined });
  };
  const areaKind = (tags: Record<string, string>): 'water' | 'park' | null => {
    if (tags.natural === 'water' || tags.waterway === 'riverbank' || ['reservoir', 'basin'].includes(tags.landuse)) return 'water';
    if (['park', 'garden', 'pitch', 'playground'].includes(tags.leisure) || ['grass', 'forest', 'recreation_ground', 'meadow', 'village_green'].includes(tags.landuse) || tags.natural === 'wood') return 'park';
    return null;
  };

  for (const el of json.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node') {
      if (tags.highway === 'traffic_signals') signalNodes.push(`n${el.id}`);
      else if (tags.natural === 'tree' && el.lat !== undefined && el.lon !== undefined) trees.push(proj.toLocal(el.lat, el.lon));
      else if ((tags.railway === 'station' || tags.railway === 'halt' || tags.public_transport === 'station') && el.lat !== undefined && el.lon !== undefined && tags.station !== 'bus') stations.push({ p: proj.toLocal(el.lat, el.lon), name: tags.name });
      continue;
    }
    if (el.type === 'relation') {
      const rings = (role: string) =>
        joinWays((el.members ?? []).filter((m) => m.type === 'way' && m.role === role && m.geometry?.length).map((m) => m.geometry!.map((g) => proj.toLocal(g.lat, g.lon))))
          .filter(isClosed)
          .map((r) => r.slice(0, -1));
      const outers = rings('outer');
      const inners = rings('inner');
      const rid = `r${el.id}`;
      if (tags.building) {
        const { use, source } = classifyUse(tags);
        outers.forEach((footprint, k) => {
          if (Math.abs(signedArea(footprint)) < 6) return;
          const { height, source: heightSource } = parseHeight(tags, use, rid);
          buildings.push({ id: `${rid}-${k}`, footprint, height, heightSource, use, useSource: source, name: tags.name, origin: 'real' });
        });
        continue;
      }
      const kind = areaKind(tags);
      if (kind) outers.forEach((o, k) => pushArea(`${rid}-${k}`, kind, o, inners.filter((h) => pointInPolygon(h[0], o))));
      continue;
    }
    if (el.type !== 'way' || !el.geometry || !el.nodes || el.geometry.length < 2) continue;
    const pts = el.geometry.map((g) => proj.toLocal(g.lat, g.lon));
    // Packs may cover more than requested: keep only features reaching into the requested circle.
    const near = pts.some((p) => p[0] * p[0] + p[1] * p[1] < (radius * 1.08) ** 2);
    if (!near && (tags.building || tags.highway || tags.railway)) continue;
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
        bikeLane: ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both'].some((k) => ['lane', 'track', 'opposite_lane', 'opposite_track'].includes(tags[k])) || undefined,
        origin: 'real',
      });
      continue;
    }

    if (tags.natural === 'coastline') {
      coast.push(pts);
      continue;
    }
    const aKind = areaKind(tags);
    if (aKind && closed) {
      pushArea(id, aKind, pts.slice(0, -1));
      continue;
    }

    if (tags.railway && ['rail', 'subway', 'tram', 'light_rail'].includes(tags.railway)) {
      const layer = parseInt(tags.layer ?? '0', 10) || 0;
      const elevated = (tags.bridge !== undefined && tags.bridge !== 'no') || layer > 0;
      const tunnel = (tags.tunnel !== undefined && tags.tunnel !== 'no') || layer < 0 || (tags.railway === 'subway' && !elevated);
      rails.push({ id, nodes: nodeIds, points: pts, kind: tags.railway as RailKind, elevated, tunnel });
    }
  }

  if (coast.length) {
    const { water, islands } = coastlineWater(coast, E);
    // Sea first so lakes/parks/islands draw on top of it.
    areas.unshift(
      ...water.map((polygon, k) => ({ id: `sea-${k}`, kind: 'water' as const, polygon, sea: true })),
      ...islands.map((polygon, k) => ({ id: `island-${k}`, kind: 'land' as const, polygon })),
    );
  }

  return {
    center, radius, buildings, roads, areas, rails, signalNodes, trees, stations,
    fetchedAt: new Date().toISOString(),
    source: 'OpenStreetMap (Overpass API)',
  };
}

const MIRROR_TIMEOUT_MS = 60_000;

// ---------- static city packs (pre-built by scripts/build-city-packs.ts) ----------

export const PACK_RADIUS = 850;
export interface PackIndexEntry {
  name: string;
  lat: number;
  lon: number;
  radius: number;
  file: string;
  builtAt: string;
}
interface Pack {
  center: LatLon;
  radius: number;
  core: OsmElement[];
  extras: OsmElement[];
  stations?: OsmElement[];
}

export const packFile = (c: LatLon) => `${c.lat.toFixed(4)}_${c.lon.toFixed(4)}.json`;

const KEEP_TAGS = new Set([
  'building', 'building:levels', 'height', 'amenity', 'shop', 'office', 'name', 'highway', 'oneway', 'junction', 'lanes',
  'maxspeed', 'bridge', 'tunnel', 'layer', 'area', 'railway', 'natural', 'waterway', 'landuse', 'leisure', 'type',
  'public_transport', 'station', 'cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both',
]);
const r6 = (g: { lat: number; lon: number }) => ({ lat: Math.round(g.lat * 1e6) / 1e6, lon: Math.round(g.lon * 1e6) / 1e6 });

/** Drop unused tags and round coordinates to ~10 cm so packs stay small. */
export function slimElements(elements: unknown[]): OsmElement[] {
  return (elements as OsmElement[]).map((e) => ({
    type: e.type,
    id: e.id,
    ...(e.nodes ? { nodes: e.nodes } : {}),
    ...(e.geometry ? { geometry: e.geometry.map(r6) } : {}),
    ...(e.lat !== undefined && e.lon !== undefined ? r6({ lat: e.lat, lon: e.lon }) : {}),
    ...(e.members ? { members: e.members.filter((m) => m.type === 'way').map((m) => ({ type: m.type, role: m.role, geometry: m.geometry?.map(r6) })) } : {}),
    ...(e.tags ? { tags: Object.fromEntries(Object.entries(e.tags).filter(([k]) => KEEP_TAGS.has(k))) } : {}),
  }));
}

const baseUrl = () => ((import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/');
let packIndex: Promise<PackIndexEntry[]> | null = null;
const packs = new Map<string, Promise<Pack | null>>();

async function loadPack(c: LatLon, radius: number): Promise<Pack | null> {
  if (typeof fetch === 'undefined') return null;
  packIndex ??= fetch(`${baseUrl()}packs/index.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const entry = (await packIndex).find((e) => Math.abs(e.lat - c.lat) < 1e-4 && Math.abs(e.lon - c.lon) < 1e-4 && e.radius >= radius);
  if (!entry) return null;
  if (!packs.has(entry.file)) {
    packs.set(entry.file, fetch(`${baseUrl()}packs/${entry.file}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return packs.get(entry.file)!;
}


async function overpass(query: string, signal?: AbortSignal): Promise<{ elements: OsmElement[] }> {
  const q = encodeURIComponent(query);
  const key = `${OVERPASS_MIRRORS[0]}?data=${q}`; // cache key independent of which mirror answered
  const cache = typeof caches !== 'undefined' ? await caches.open('gcs-osm-v2').catch(() => null) : null;
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit.json();
  let lastError = '';
  for (const mirror of OVERPASS_MIRRORS) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
    try {
      const r = await fetch(`${mirror}?data=${q}`, { signal: ctrl.signal });
      if (r.ok) {
        const body = await r.text(); // read fully inside the timeout window
        const json = JSON.parse(body);
        await cache?.put(key, new Response(body, { headers: { 'Content-Type': 'application/json' } })).catch(() => undefined);
        return json;
      }
      lastError = `Map data servers are busy (${r.status}).`;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = 'Map data servers are slow or unreachable.';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(`${lastError} Try again in a moment.`);
}

/** Load the playable city: buildings, roads, rail, signals. Cached with the Cache API; tries several free mirrors. */
export async function fetchWorld(center: LatLon, radius: number, signal?: AbortSignal): Promise<WorldData> {
  const pack = await loadPack(center, radius);
  if (pack) return { ...parseOverpass({ elements: pack.core }, center, radius), source: 'OpenStreetMap (pre-built city pack)' };
  return parseOverpass(await overpass(buildOverpassQuery(center, radius, 'core'), signal), center, radius);
}

/** Load water, parks and coastline-derived sea. Optional: callers should keep going if this fails. */
export async function fetchAreas(center: LatLon, radius: number, signal?: AbortSignal): Promise<Pick<WorldData, 'areas' | 'trees'>> {
  const pack = await loadPack(center, radius);
  if (pack) {
    const w = parseOverpass({ elements: pack.extras }, center, radius);
    return { areas: w.areas, trees: w.trees };
  }
  const w = parseOverpass(await overpass(buildOverpassQuery(center, radius, 'extras'), signal), center, radius);
  return { areas: w.areas, trees: w.trees };
}

/** Rail/subway stations (small, fast query). Packs built after stations support carry them too. */
export async function fetchStations(center: LatLon, radius: number, signal?: AbortSignal): Promise<WorldData['stations']> {
  const pack = await loadPack(center, radius);
  if (pack?.stations) return parseOverpass({ elements: pack.stations }, center, radius).stations;
  return parseOverpass(await overpass(buildOverpassQuery(center, radius, 'stations'), signal), center, radius).stations;
}
