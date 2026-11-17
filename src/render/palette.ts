import type { BuildingUse } from '../geo/types';

/** Shared colour language for the 3D and 2D views. */
export const USE_COLORS: Record<BuildingUse, number> = {
  residential: 0xead9c3,
  commercial: 0xf1b98f,
  office: 0xb8c8d9,
  industrial: 0xcac3b3,
  education: 0xe8cc76,
  health: 0xf0a6a6,
  civic: 0xc9b6e2,
  religious: 0xe2cfaa,
  parking: 0xaeb0b2,
  unknown: 0xdfd8cd,
};
export const PROPOSED_COLOR = 0x3fd3c3;
export const ESTIMATED_TINT = 0xff9a3c;
export const ROAD_COLORS: Record<string, number> = {
  highway: 0x58616d, primary: 0x646d79, secondary: 0x6d7682, tertiary: 0x737c87,
  residential: 0x7d858f, service: 0x8a919a, footway: 0xd3cab8, cycleway: 0xcf9474,
};
export const AREA_COLORS = { water: 0x6fa6d0, park: 0xa6c98c, land: 0xe0dacc };
export const AGENT_COLORS: Record<string, number> = {
  pedestrian: 0x2c3e50, bicycle: 0x16a085, motorcycle: 0xc0392b, car: 0x3d4a5c, taxi: 0xf2c230, truck: 0x8c6e4a, bus: 0x2f6fd6,
};
export const ZONE_COLORS: Record<string, number> = {
  residential: 0xe8b04b, commercial: 0x4a90d9, office: 0x7b6fd6, mixed: 0xd9668f, industrial: 0x9b8b6e, park: 0x5fa35a,
};
export const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
