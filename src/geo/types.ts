/** Local planar coordinates in meters: x = east, y = north, relative to the world origin. */
export type Vec2 = [number, number];

export interface LatLon {
  lat: number;
  lon: number;
}

export type BuildingUse =
  | 'residential'
  | 'commercial'
  | 'office'
  | 'industrial'
  | 'education'
  | 'health'
  | 'civic'
  | 'religious'
  | 'parking'
  | 'unknown';

/** Where a value came from. Never present 'estimated' as observed data. */
export type HeightSource = 'osm-height' | 'osm-levels' | 'estimated' | 'user';

/** 'real' = from a geographic dataset; 'proposed' = created by the user in a scenario. */
export type Origin = 'real' | 'proposed';

export interface Building {
  id: string;
  footprint: Vec2[]; // open ring, no repeated closing point
  height: number;
  heightSource: HeightSource;
  use: BuildingUse;
  useSource: 'osm' | 'estimated' | 'user';
  name?: string;
  origin: Origin;
}

export type RoadKind =
  | 'highway'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'footway'
  | 'cycleway';

export interface Road {
  id: string;
  nodes: string[]; // node ids shared between roads form the network topology
  points: Vec2[];
  kind: RoadKind;
  lanes: number; // total lanes, both directions
  oneway: boolean;
  maxspeedKmh: number;
  name?: string;
  bridge?: boolean;
  tunnel?: boolean;
  origin: Origin;
}

export type AreaKind = 'water' | 'park';

export interface Area {
  id: string;
  kind: AreaKind;
  polygon: Vec2[];
}

export type RailKind = 'rail' | 'subway' | 'tram' | 'light_rail';

export interface Rail {
  id: string;
  nodes: string[];
  points: Vec2[];
  kind: RailKind;
  elevated: boolean;
  tunnel: boolean;
}

export interface WorldData {
  center: LatLon;
  radius: number; // meters
  buildings: Building[];
  roads: Road[];
  areas: Area[];
  rails: Rail[];
  signalNodes: string[]; // OSM nodes tagged highway=traffic_signals
  fetchedAt: string;
  source: string;
}

export interface Place {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  countryCode: string;
}
