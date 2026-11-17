import type { Place } from './types';

/**
 * Geocoding via Nominatim (OpenStreetMap). Usage policy: max 1 request/second, no autocomplete.
 * We only search on submit. shortcut: public endpoint; move to self-hosted Nominatim/Photon before launch.
 */
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/;

export function parseCoordinates(q: string): Place | null {
  const m = COORD_RE.exec(q);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, displayName: 'Coordinates', lat, lon, countryCode: '' };
}

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const coord = parseCoordinates(q);
  if (coord) return [coord];
  const url = `${NOMINATIM}?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const rows: { name?: string; display_name: string; lat: string; lon: string; address?: { country_code?: string } }[] = await res.json();
  return rows.map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    countryCode: r.address?.country_code ?? '',
  }));
}

/** Curated starting points. Coordinates are real; everything rendered is loaded live from OSM. */
export const FEATURED: (Place & { tagline: string })[] = [
  { name: 'Chicago Loop', displayName: 'Chicago, Illinois, USA', lat: 41.8826, lon: -87.6278, countryCode: 'us', tagline: 'Elevated L trains over the grid' },
  { name: 'Midtown Manhattan', displayName: 'New York, USA', lat: 40.7549, lon: -73.984, countryCode: 'us', tagline: 'Towers, taxis and crowds' },
  { name: 'District 1, Saigon', displayName: 'Ho Chi Minh City, Vietnam', lat: 10.7769, lon: 106.7009, countryCode: 'vn', tagline: 'A river of motorbikes' },
  { name: 'Amsterdam Centrum', displayName: 'Amsterdam, Netherlands', lat: 52.3731, lon: 4.8926, countryCode: 'nl', tagline: 'Canals, trams, bicycles' },
  { name: 'Shibuya', displayName: 'Tokyo, Japan', lat: 35.6595, lon: 139.7005, countryCode: 'jp', tagline: 'The world’s busiest crossing' },
  { name: 'City of London', displayName: 'London, United Kingdom', lat: 51.5138, lon: -0.0984, countryCode: 'gb', tagline: 'Medieval streets, glass towers' },
];
