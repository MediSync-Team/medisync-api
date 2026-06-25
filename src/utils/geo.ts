/**
 * Pure geo helpers for distance filtering. No dependencies, unit-testable.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEG_LAT = 111.32;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in kilometres (haversine). */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Square-ish lat/lng box around a point that fully contains the given radius.
 * Used as a cheap Prisma `where` prefilter before the exact haversine pass.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  const latDelta = radiusKm / KM_PER_DEG_LAT;
  // Guard the cosine near the poles so the longitude delta never blows up.
  const lngDelta = radiusKm / (KM_PER_DEG_LAT * Math.max(0.01, Math.cos(toRad(lat))));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/** True when lat/lng are present, finite and in range. */
export function isValidCoord(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}
