import type { Terrain } from './terrain';

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
  bikeLane?: boolean;
  origin: Origin;
}

export type AreaKind = 'water' | 'park' | 'land';

export interface Area {
  id: string;
  kind: AreaKind;
  polygon: Vec2[];
  holes?: Vec2[][];
  /** Sea built from coastlines: rendered flat at sea level instead of draped on the (bathymetric) DEM. */
  sea?: boolean;
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

/** A pinned comment on the plan. */
export interface Note {
  id: string;
  p: Vec2;
  text: string;
}

/** A user-designed transit line. Bus lines run on streets; metro lines are new elevated guideways. */
export interface TransitLineSpec {
  id: string;
  name: string;
  mode: 'bus' | 'metro';
  stops: Vec2[];
  color: number;
  /** Minutes between vehicles in each direction; unset = automatic (one vehicle per ~900 m). */
  headwayMin?: number;
}

export interface WorldData {
  center: LatLon;
  radius: number; // meters
  buildings: Building[];
  roads: Road[];
  areas: Area[];
  rails: Rail[];
  signalNodes: string[]; // OSM nodes tagged highway=traffic_signals
  trees?: Vec2[]; // OSM natural=tree nodes (mapped individual trees)
  stations?: { p: Vec2; name?: string }[]; // OSM railway stations/halts (rail, subway, light rail)
  fetchedAt: string;
  source: string;
  terrain?: Terrain; // undefined = flat (no DEM or loading failed)
  notes?: Note[]; // planner annotations
  transitLines?: TransitLineSpec[]; // proposed lines (real-world transit comes from rails / generated routes)
}

export interface Place {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  countryCode: string;
}
